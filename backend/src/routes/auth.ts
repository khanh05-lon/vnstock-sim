import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { Router, type Request } from 'express';
import {
  EMAIL_VERIFY_TTL_HOURS,
  PASSWORD_RESET_TTL_MIN,
  changePasswordSchema,
  forgotPasswordSchema,
  loginMfaSchema,
  loginSchema,
  preferencesSchema,
  registerSchema,
  resetPasswordSchema,
  twoFactorConfirmSchema,
  twoFactorEnableSchema,
  twoFactorSetupSchema,
  USER_ROLES,
  verifyEmailSchema,
  type UserDTO,
  type UserRole,
} from '@vss/shared';
import type { Database, Queryable } from '../db';
import {
  markEmailVerified,
  markPasswordChanged,
  requireAuth,
  signMfaTicket,
  signSupportTicket,
  signToken,
  verifyMfaTicket,
  type AuthedRequest,
} from '../lib/auth';
import {
  loginBlockedEmail,
  passwordChangedEmail,
  recoveryCodeUsedEmail,
  resetPasswordEmail,
  twoFactorChangedEmail,
  verifyEmailEmail,
  type EmailContent,
} from '../lib/emails';
import { LOGIN_FAIL_LIMIT, LOGIN_FAIL_WINDOW_MIN, listAuthEvents, recentLoginFailures, recordAuthEvent } from '../lib/authEvents';
import { AppError, ah, badRequest, notFound } from '../lib/errors';
import { log } from '../lib/logger';
import type { Mailer } from '../lib/mailer';
import { ipKey, limiter } from '../lib/rateLimit';
import { openSecret, sealSecret } from '../lib/secretBox';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from '../lib/totp';
import { config } from '../config';
import { createUserAccount } from '../seed/seed';

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
  created_at: Date | string;
  role: UserRole;
  status: string;
  email_verified_at: Date | null;
  totp_enabled_at: Date | null;
  totp_secret: string | null;
  totp_pending_secret: string | null;
  totp_pending_at: Date | null;
  totp_last_step: number | null;
  notify_fills: boolean;
  display_name: string | null;
  show_on_leaderboard: boolean;
  password_changed_at: Date | null;
}

/** Cột cần để dựng UserDTO */
export const USER_COLS =
  'id, email, full_name, created_at, role, email_verified_at, totp_enabled_at, notify_fills, display_name, show_on_leaderboard';

type UserDtoRow = Pick<
  UserRow,
  'id' | 'email' | 'full_name' | 'created_at' | 'role' | 'email_verified_at' | 'totp_enabled_at' | 'notify_fills' | 'display_name' | 'show_on_leaderboard'
>;

export const toUser = (u: UserDtoRow): UserDTO => ({
  id: u.id,
  email: u.email,
  fullName: u.full_name,
  createdAt: new Date(u.created_at).toISOString(),
  role: (USER_ROLES as readonly string[]).includes(u.role) ? u.role : 'USER',
  emailVerified: u.email_verified_at != null,
  twoFactorEnabled: u.totp_enabled_at != null,
  notifyFills: !!u.notify_fills,
  displayName: u.display_name ?? null,
  showOnLeaderboard: u.show_on_leaderboard ?? true,
});

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Số link đặt lại tối đa cho 1 tài khoản mỗi giờ (chặn spam hộp thư người khác) */
const RESET_PER_HOUR = 5;
/** Bí mật 2FA đang thiết lập hết hạn sau 15 phút nếu người dùng không nhập mã xác nhận */
const TOTP_PENDING_TTL_MS = 15 * 60_000;

/** Gửi email không chờ (không để SMTP chậm làm chậm phản hồi); lỗi chỉ ghi log */
export function sendLater(mailer: Mailer, to: string, mail: EmailContent, ctx: Record<string, unknown> = {}) {
  void mailer.send({ to, ...mail }).catch((err) => log.error('[mail] gửi email thất bại', { err, subject: mail.subject, ...ctx }));
}

/** Tạo link xác thực email mới (link cũ hết hiệu lực) và gửi cho người dùng */
export async function issueEmailVerification(q: Queryable, mailer: Mailer, user: { id: string; email: string; full_name: string }) {
  const token = crypto.randomBytes(32).toString('base64url');
  await q.many('UPDATE email_verification_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
  await q.many(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`,
    [user.id, sha256(token), EMAIL_VERIFY_TTL_HOURS],
  );
  const link = `${config.publicUrl}/verify-email?token=${encodeURIComponent(token)}`;
  sendLater(mailer, user.email, verifyEmailEmail(user.full_name, link, EMAIL_VERIFY_TTL_HOURS), { userId: user.id });
}

export function authRoutes(db: Database, mailer: Mailer) {
  const r = Router();
  const authLimiter = limiter({
    windowMs: 15 * 60_000,
    limit: 30,
    key: ipKey,
    message: 'Thao tác quá nhiều lần, vui lòng thử lại sau ít phút',
  });
  const forgotIpLimiter = limiter({
    windowMs: 15 * 60_000,
    limit: 10,
    key: ipKey,
    message: 'Bạn yêu cầu quá nhiều lần, vui lòng thử lại sau 15 phút',
  });
  const forgotEmailLimiter = limiter({
    windowMs: 60 * 60_000,
    limit: 3,
    key: (req: Request) => `email:${String(req.body?.email ?? '').trim().toLowerCase()}`,
    message: 'Email này vừa được yêu cầu nhiều lần, vui lòng kiểm tra hộp thư hoặc thử lại sau',
  });
  const resendLimiter = limiter({
    windowMs: 60 * 60_000,
    limit: 3,
    message: 'Bạn đã yêu cầu gửi lại nhiều lần, vui lòng kiểm tra hộp thư (kể cả thư rác) hoặc thử lại sau',
  });
  // Đoán mã 2FA: giới hạn theo IP và theo tài khoản trong vé
  const mfaIpLimiter = limiter({ windowMs: 15 * 60_000, limit: 20, key: ipKey, message: 'Nhập sai mã quá nhiều lần, vui lòng thử lại sau 15 phút' });
  const mfaUserLimiter = limiter({
    windowMs: 15 * 60_000,
    limit: 10,
    key: (req: Request) => `mfa:${verifyMfaTicket(String(req.body?.mfaToken ?? ''))?.id ?? req.ip}`,
    message: 'Nhập sai mã quá nhiều lần, vui lòng thử lại sau 15 phút',
  });

  const loadUser = (id: string) => db.one<UserRow>('SELECT * FROM users WHERE id = $1', [id]);

  /** Mật khẩu đúng → nếu bật 2FA trả vé chờ nhập mã, ngược lại trả phiên đăng nhập */
  const loginResult = (user: UserRow) =>
    user.totp_enabled_at
      ? { mfaRequired: true as const, mfaToken: signMfaTicket({ id: user.id, email: user.email }) }
      : { token: signToken({ id: user.id, email: user.email }), user: toUser(user) };

  /**
   * Tài khoản không hoạt động. Bị khoá (đã qua mật khẩu + 2FA) → kèm vé hỗ trợ để vẫn nhắn được CSKH;
   * đã xoá → không cấp gì.
   */
  const inactiveError = (user: UserRow, message = 'Tài khoản đang bị khoá. Bạn vẫn có thể nhắn bộ phận chăm sóc khách hàng để được hỗ trợ.') =>
    user.status === 'LOCKED'
      ? new AppError(403, 'ACCOUNT_LOCKED', message, { supportToken: signSupportTicket({ id: user.id, email: user.email }) })
      : new AppError(403, 'ACCOUNT_LOCKED', 'Tài khoản không còn hoạt động');

  /**
   * Kiểm tra mã 2FA: mã TOTP 6 số (chống dùng lại mã cũ) hoặc mã khôi phục (đánh dấu đã dùng).
   * Trả về cách đã xác thực, hoặc null nếu sai.
   */
  const checkSecondFactor = async (user: UserRow, code: string): Promise<'totp' | 'recovery' | null> => {
    if (!user.totp_secret) return null;
    if (/^\d{6}$/.test(code.trim())) {
      const step = verifyTotp(openSecret(user.totp_secret), code);
      if (step == null || (user.totp_last_step != null && step <= user.totp_last_step)) return null;
      // Điều kiện trên cột đảm bảo 2 request song song không dùng được cùng 1 mã
      const ok = await db.one(
        'UPDATE users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id',
        [user.id, step],
      );
      return ok ? 'totp' : null;
    }
    if (!looksLikeRecoveryCode(code)) return null;
    const used = await db.one<{ id: number }>(
      `UPDATE recovery_codes SET used_at = now()
       WHERE id = (SELECT id FROM recovery_codes WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL LIMIT 1)
       RETURNING id`,
      [user.id, hashRecoveryCode(code)],
    );
    if (!used) return null;
    const left = await db.one<{ n: number }>('SELECT count(*)::int AS n FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL', [user.id]);
    sendLater(mailer, user.email, recoveryCodeUsedEmail(user.full_name, left?.n ?? 0), { userId: user.id });
    return 'recovery';
  };

  /* ------------------------------ đăng ký / đăng nhập ------------------------------ */

  r.post(
    '/register',
    authLimiter,
    ah(async (req, res) => {
      const input = registerSchema.parse(req.body);
      const exists = await db.one('SELECT 1 FROM users WHERE email = $1', [input.email]);
      if (exists) throw new AppError(409, 'EMAIL_TAKEN', 'Email đã được sử dụng');
      const hash = await bcrypt.hash(input.password, 10);
      const user = await db
        .tx(async (tx) => {
          const u = await createUserAccount(tx, input.email, hash, input.fullName);
          await issueEmailVerification(tx, mailer, u);
          return u;
        })
        .catch((err: { code?: string }) => {
          // 2 request đăng ký cùng email chạy song song: ràng buộc UNIQUE chặn request sau
          if (err.code === '23505') throw new AppError(409, 'EMAIL_TAKEN', 'Email đã được sử dụng');
          throw err;
        });
      const row = await loadUser(user.id);
      await recordAuthEvent(db, { userId: user.id, email: user.email, event: 'REGISTER', req });
      res.status(201).json({ token: signToken({ id: user.id, email: user.email }), user: toUser(row!) });
    }),
  );

  r.post(
    '/login',
    authLimiter,
    ah(async (req, res) => {
      const input = loginSchema.parse(req.body);
      // Chặn dò mật khẩu theo từng tài khoản (giới hạn theo IP không đủ khi kẻ xấu đổi IP liên tục)
      if ((await recentLoginFailures(db, input.email)) >= LOGIN_FAIL_LIMIT) {
        const owner = await db.one<{ id: string }>('SELECT id FROM users WHERE email = $1', [input.email]);
        await recordAuthEvent(db, { userId: owner?.id, email: input.email, event: 'LOGIN_BLOCKED', req });
        throw new AppError(429, 'LOGIN_BLOCKED', `Đăng nhập sai quá ${LOGIN_FAIL_LIMIT} lần — tài khoản tạm khoá đăng nhập ${LOGIN_FAIL_WINDOW_MIN} phút. Quên mật khẩu? Dùng "Quên mật khẩu" để đặt lại.`);
      }
      const user = await db.one<UserRow>('SELECT * FROM users WHERE email = $1', [input.email]);
      const ok = user ? await bcrypt.compare(input.password, user.password_hash) : false;
      if (!user || !ok) {
        await recordAuthEvent(db, { userId: user?.id, email: input.email, event: 'LOGIN_FAIL', req });
        // Lần sai thứ N: báo chủ tài khoản qua email (có thể ai đó đang dò mật khẩu)
        if (user && (await recentLoginFailures(db, input.email)) === LOGIN_FAIL_LIMIT) {
          sendLater(mailer, user.email, loginBlockedEmail(user.full_name, LOGIN_FAIL_LIMIT, LOGIN_FAIL_WINDOW_MIN, req.ip ?? ''), { userId: user.id });
        }
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Email hoặc mật khẩu không đúng');
      }
      // Bị khoá + bật 2FA: vẫn phải qua bước mã (kẻ chiếm mật khẩu không nhắn CSKH mạo danh được); /login/2fa xử lý tiếp
      if (user.status !== 'ACTIVE' && !(user.status === 'LOCKED' && user.totp_enabled_at)) {
        await recordAuthEvent(db, { userId: user.id, email: user.email, event: 'LOGIN_LOCKED_ACCOUNT', req });
        throw inactiveError(user);
      }
      if (!user.totp_enabled_at) await recordAuthEvent(db, { userId: user.id, email: user.email, event: 'LOGIN_OK', req, detail: { mfa: false } });
      res.json(loginResult(user));
    }),
  );

  /** Bước 2 khi tài khoản bật 2FA: vé từ /login + mã 6 số (hoặc mã khôi phục) */
  r.post(
    '/login/2fa',
    mfaIpLimiter,
    mfaUserLimiter,
    ah(async (req, res) => {
      const input = loginMfaSchema.parse(req.body);
      const ticket = verifyMfaTicket(input.mfaToken);
      if (!ticket) throw new AppError(401, 'MFA_EXPIRED', 'Phiên xác thực đã hết hạn, vui lòng đăng nhập lại');
      const user = await loadUser(ticket.id);
      if (!user || !user.totp_enabled_at) throw new AppError(401, 'MFA_EXPIRED', 'Phiên xác thực đã hết hạn, vui lòng đăng nhập lại');
      // Vé phát hành trước lần đổi mật khẩu gần nhất không còn hiệu lực
      if (user.password_changed_at && ticket.issuedMs < new Date(user.password_changed_at).getTime()) {
        throw new AppError(401, 'MFA_EXPIRED', 'Phiên xác thực đã hết hạn, vui lòng đăng nhập lại');
      }
      if ((await recentLoginFailures(db, user.email)) >= LOGIN_FAIL_LIMIT) {
        await recordAuthEvent(db, { userId: user.id, email: user.email, event: 'LOGIN_BLOCKED', req, detail: { step: '2fa' } });
        throw new AppError(429, 'LOGIN_BLOCKED', `Nhập sai quá ${LOGIN_FAIL_LIMIT} lần — tạm khoá đăng nhập ${LOGIN_FAIL_WINDOW_MIN} phút`);
      }
      const how = await checkSecondFactor(user, input.code);
      if (!how) {
        await recordAuthEvent(db, { userId: user.id, email: user.email, event: 'LOGIN_2FA_FAIL', req });
        throw badRequest('MFA_INVALID', 'Mã xác thực không đúng hoặc đã được dùng');
      }
      // Bị khoá trước hoặc trong lúc nhập mã → không cấp phiên
      if (user.status !== 'ACTIVE') {
        await recordAuthEvent(db, { userId: user.id, email: user.email, event: 'LOGIN_LOCKED_ACCOUNT', req, detail: { mfa: how } });
        throw inactiveError(user);
      }
      await recordAuthEvent(db, { userId: user.id, email: user.email, event: 'LOGIN_OK', req, detail: { mfa: how } });
      res.json({ token: signToken({ id: user.id, email: user.email }), user: toUser(user) });
    }),
  );

  // Đăng nhập nhanh bằng tài khoản demo (chỉ khi DEMO_EMAIL được cấu hình)
  r.post(
    '/demo',
    authLimiter,
    ah(async (req, res) => {
      if (!config.demoEmail) throw notFound('Tài khoản demo chưa được bật');
      const user = await db.one<UserRow>('SELECT * FROM users WHERE email = $1', [config.demoEmail]);
      if (!user) throw notFound('Tài khoản demo chưa được tạo');
      await recordAuthEvent(db, { userId: user.id, email: user.email, event: 'DEMO_LOGIN', req });
      res.json({ token: signToken({ id: user.id, email: user.email }), user: toUser(user) });
    }),
  );

  r.get(
    '/me',
    requireAuth,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const row = await db.one<UserDtoRow>(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [user.id]);
      if (!row) throw notFound('Tài khoản không tồn tại');
      res.json({ user: toUser(row) });
    }),
  );

  r.put(
    '/preferences',
    requireAuth,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const input = preferencesSchema.parse(req.body);
      const sets: string[] = [];
      const params: unknown[] = [user.id];
      const set = (col: string, v: unknown) => {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      };
      if (input.notifyFills !== undefined) set('notify_fills', input.notifyFills);
      if (input.showOnLeaderboard !== undefined) set('show_on_leaderboard', input.showOnLeaderboard);
      if (input.displayName !== undefined) set('display_name', input.displayName);
      const row = sets.length
        ? await db.one<UserDtoRow>(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING ${USER_COLS}`, params)
        : await db.one<UserDtoRow>(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [user.id]);
      if (!row) throw notFound('Tài khoản không tồn tại');
      res.json({ user: toUser(row) });
    }),
  );

  /* ------------------------------ mật khẩu ------------------------------ */

  r.post(
    '/change-password',
    requireAuth,
    authLimiter,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const input = changePasswordSchema.parse(req.body);
      const row = await loadUser(user.id);
      if (!row) throw notFound('Tài khoản không tồn tại');
      if (!(await bcrypt.compare(input.currentPassword, row.password_hash))) throw badRequest('WRONG_PASSWORD', 'Mật khẩu hiện tại không đúng');
      const now = new Date();
      await db.many('UPDATE users SET password_hash = $2, password_changed_at = $3 WHERE id = $1', [
        user.id,
        await bcrypt.hash(input.newPassword, 10),
        now,
      ]);
      markPasswordChanged(user.id, now);
      await recordAuthEvent(db, { userId: row.id, email: row.email, event: 'PASSWORD_CHANGE', req });
      sendLater(mailer, row.email, passwordChangedEmail(row.full_name, 'change'), { userId: row.id });
      // Các phiên cũ bị đăng xuất; trả token mới cho phiên hiện tại
      res.json({ ok: true, token: signToken({ id: row.id, email: row.email }) });
    }),
  );

  /**
   * Quên mật khẩu: luôn trả cùng một câu trả lời (không lộ email nào đã đăng ký).
   * Có tài khoản → tạo token ngẫu nhiên (chỉ lưu SHA-256), gửi link hết hạn sau 30 phút.
   */
  r.post(
    '/forgot-password',
    forgotIpLimiter,
    forgotEmailLimiter,
    ah(async (req, res) => {
      const { email } = forgotPasswordSchema.parse(req.body);
      const user = await db.one<UserRow>('SELECT id, email, full_name FROM users WHERE email = $1', [email]);
      if (user) {
        const token = crypto.randomBytes(32).toString('base64url');
        const created = await db.tx(async (tx) => {
          // Khoá dòng user để các yêu cầu song song đếm đúng
          await tx.one('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);
          const recent = await tx.one<{ n: number }>(
            `SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = $1 AND created_at > now() - interval '1 hour'`,
            [user.id],
          );
          if ((recent?.n ?? 0) >= RESET_PER_HOUR) return false;
          // Chỉ link mới nhất còn hiệu lực
          await tx.many('UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
          await tx.many(
            `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, request_ip)
             VALUES ($1, $2, now() + make_interval(mins => $3), $4)`,
            [user.id, sha256(token), PASSWORD_RESET_TTL_MIN, req.ip ?? null],
          );
          return true;
        });
        if (created) {
          const link = `${config.publicUrl}/reset-password?token=${encodeURIComponent(token)}`;
          // Không chờ SMTP: trả lời ngay, thời gian phản hồi không phụ thuộc email có tồn tại hay không
          sendLater(mailer, user.email, resetPasswordEmail(user.full_name, link), { userId: user.id });
        } else {
          log.warn('[auth] bỏ qua yêu cầu đặt lại mật khẩu: vượt giới hạn mỗi giờ', { userId: user.id });
        }
      }
      res.json({ ok: true, message: `Nếu email đã đăng ký, chúng tôi đã gửi link đặt lại mật khẩu (hiệu lực ${PASSWORD_RESET_TTL_MIN} phút).` });
    }),
  );

  r.post(
    '/reset-password',
    authLimiter,
    ah(async (req, res) => {
      const input = resetPasswordSchema.parse(req.body);
      const hash = await bcrypt.hash(input.password, 10);
      const now = new Date();
      const user = await db.tx(async (tx) => {
        const t = await tx.one<{ id: number; user_id: string }>(
          `SELECT id, user_id FROM password_reset_tokens
           WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
          [sha256(input.token)],
        );
        if (!t) throw badRequest('RESET_TOKEN_INVALID', 'Link đặt lại mật khẩu không hợp lệ hoặc đã hết hạn — hãy yêu cầu link mới');
        await tx.many('UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [t.user_id]);
        // Mở được link trong email cũng chứng minh sở hữu email
        return tx.one<UserRow>(
          `UPDATE users SET password_hash = $2, password_changed_at = $3, email_verified_at = COALESCE(email_verified_at, $3)
           WHERE id = $1 RETURNING *`,
          [t.user_id, hash, now],
        );
      });
      if (!user) throw notFound('Tài khoản không tồn tại');
      markPasswordChanged(user.id, now);
      markEmailVerified(user.id);
      log.info('[auth] đã đặt lại mật khẩu', { userId: user.id });
      await recordAuthEvent(db, { userId: user.id, email: user.email, event: 'PASSWORD_RESET', req });
      sendLater(mailer, user.email, passwordChangedEmail(user.full_name, 'reset'), { userId: user.id });
      // Bị khoá, không bật 2FA: mật khẩu đã đổi nhưng không cấp phiên — chỉ vé hỗ trợ
      if (user.status !== 'ACTIVE' && !(user.status === 'LOCKED' && user.totp_enabled_at)) {
        throw inactiveError(user, 'Đã đặt lại mật khẩu. Tài khoản đang bị khoá — hãy nhắn bộ phận chăm sóc khách hàng để được mở khoá.');
      }
      // Bật 2FA thì vẫn phải nhập mã: chiếm được hộp thư không đủ để vào tài khoản
      res.json(loginResult(user));
    }),
  );

  /* ------------------------------ xác thực email ------------------------------ */

  r.post(
    '/verify-email',
    authLimiter,
    ah(async (req, res) => {
      const { token } = verifyEmailSchema.parse(req.body);
      const user = await db.tx(async (tx) => {
        const t = await tx.one<{ id: number; user_id: string }>(
          'SELECT id, user_id FROM email_verification_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE',
          [sha256(token)],
        );
        if (!t) throw badRequest('VERIFY_TOKEN_INVALID', 'Link xác thực không hợp lệ hoặc đã hết hạn — hãy đăng nhập và gửi lại email xác thực');
        await tx.many('UPDATE email_verification_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [t.user_id]);
        return tx.one<UserDtoRow>(
          `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1 RETURNING ${USER_COLS}`,
          [t.user_id],
        );
      });
      if (!user) throw notFound('Tài khoản không tồn tại');
      markEmailVerified(user.id);
      await recordAuthEvent(db, { userId: user.id, email: user.email, event: 'EMAIL_VERIFIED', req });
      res.json({ ok: true, user: toUser(user) });
    }),
  );

  r.post(
    '/resend-verification',
    requireAuth,
    resendLimiter,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const row = await loadUser(user.id);
      if (!row) throw notFound('Tài khoản không tồn tại');
      if (row.email_verified_at) return void res.json({ ok: true, alreadyVerified: true });
      await db.tx((tx) => issueEmailVerification(tx, mailer, row));
      res.json({ ok: true, message: `Đã gửi link xác thực tới ${row.email} (hiệu lực ${EMAIL_VERIFY_TTL_HOURS} giờ)` });
    }),
  );

  /* ------------------------------ xác thực 2 lớp ------------------------------ */

  const assertPassword = async (row: UserRow, password: string) => {
    if (!(await bcrypt.compare(password, row.password_hash))) throw badRequest('WRONG_PASSWORD', 'Mật khẩu hiện tại không đúng');
  };

  const newRecoveryCodes = async (q: Queryable, userId: string) => {
    const codes = generateRecoveryCodes();
    await q.many('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
    for (const c of codes) await q.many('INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)', [userId, hashRecoveryCode(c)]);
    return codes;
  };

  r.get(
    '/2fa',
    requireAuth,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const row = await db.one<{ totp_enabled_at: Date | null; left: number }>(
        `SELECT totp_enabled_at, (SELECT count(*)::int FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL) AS left FROM users WHERE id = $1`,
        [user.id],
      );
      if (!row) throw notFound('Tài khoản không tồn tại');
      res.json({ enabled: row.totp_enabled_at != null, enabledAt: row.totp_enabled_at ? new Date(row.totp_enabled_at).toISOString() : null, recoveryCodesLeft: row.left });
    }),
  );

  /** Bước 1: tạo bí mật mới (chưa bật) → trả mã QR để quét bằng ứng dụng xác thực */
  r.post(
    '/2fa/setup',
    requireAuth,
    authLimiter,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const { password } = twoFactorSetupSchema.parse(req.body);
      const row = await loadUser(user.id);
      if (!row) throw notFound('Tài khoản không tồn tại');
      await assertPassword(row, password);
      if (row.totp_enabled_at) throw badRequest('MFA_ALREADY', 'Xác thực 2 lớp đang bật');
      if (config.demoEmail && row.email === config.demoEmail) throw badRequest('DEMO', 'Tài khoản demo dùng chung nên không bật được xác thực 2 lớp');
      const secret = generateTotpSecret();
      await db.many('UPDATE users SET totp_pending_secret = $2, totp_pending_at = now() WHERE id = $1', [user.id, sealSecret(secret)]);
      const url = otpauthUrl(secret, row.email);
      const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      res.json({ secret, otpauthUrl: url, qrSvg });
    }),
  );

  /** Bước 2: nhập mã đầu tiên để chứng minh đã lưu bí mật → bật 2FA, trả 10 mã khôi phục (chỉ hiện 1 lần) */
  r.post(
    '/2fa/enable',
    requireAuth,
    authLimiter,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const { code } = twoFactorEnableSchema.parse(req.body);
      const row = await loadUser(user.id);
      if (!row) throw notFound('Tài khoản không tồn tại');
      if (row.totp_enabled_at) throw badRequest('MFA_ALREADY', 'Xác thực 2 lớp đang bật');
      if (!row.totp_pending_secret || !row.totp_pending_at || Date.now() - new Date(row.totp_pending_at).getTime() > TOTP_PENDING_TTL_MS) {
        throw badRequest('MFA_SETUP_EXPIRED', 'Phiên thiết lập đã hết hạn, hãy bắt đầu lại');
      }
      const step = verifyTotp(openSecret(row.totp_pending_secret), code);
      if (step == null) throw badRequest('MFA_INVALID', 'Mã không đúng — kiểm tra lại giờ trên điện thoại và nhập mã mới nhất');
      const codes = await db.tx(async (tx) => {
        await tx.many(
          `UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_pending_at = NULL,
                            totp_enabled_at = now(), totp_last_step = $2 WHERE id = $1`,
          [user.id, step],
        );
        return newRecoveryCodes(tx, user.id);
      });
      await recordAuthEvent(db, { userId: row.id, email: row.email, event: 'TWO_FA_ENABLE', req });
      sendLater(mailer, row.email, twoFactorChangedEmail(row.full_name, true, 'user'), { userId: row.id });
      res.json({ ok: true, recoveryCodes: codes });
    }),
  );

  r.post(
    '/2fa/disable',
    requireAuth,
    authLimiter,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const input = twoFactorConfirmSchema.parse(req.body);
      const row = await loadUser(user.id);
      if (!row) throw notFound('Tài khoản không tồn tại');
      if (!row.totp_enabled_at) throw badRequest('MFA_NOT_ENABLED', 'Xác thực 2 lớp chưa bật');
      await assertPassword(row, input.password);
      const how = await checkSecondFactor(row, input.code);
      if (!how) throw badRequest('MFA_INVALID', 'Mã xác thực không đúng hoặc đã được dùng');
      await db.tx(async (tx) => {
        await tx.many(
          `UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_pending_at = NULL, totp_enabled_at = NULL, totp_last_step = NULL
           WHERE id = $1`,
          [user.id],
        );
        await tx.many('DELETE FROM recovery_codes WHERE user_id = $1', [user.id]);
      });
      await recordAuthEvent(db, { userId: row.id, email: row.email, event: 'TWO_FA_DISABLE', req, detail: { how } });
      sendLater(mailer, row.email, twoFactorChangedEmail(row.full_name, false, how === 'recovery' ? 'recovery' : 'user'), { userId: row.id });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/2fa/recovery-codes',
    requireAuth,
    authLimiter,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const input = twoFactorConfirmSchema.parse(req.body);
      const row = await loadUser(user.id);
      if (!row) throw notFound('Tài khoản không tồn tại');
      if (!row.totp_enabled_at) throw badRequest('MFA_NOT_ENABLED', 'Xác thực 2 lớp chưa bật');
      await assertPassword(row, input.password);
      if (!(await checkSecondFactor(row, input.code))) throw badRequest('MFA_INVALID', 'Mã xác thực không đúng hoặc đã được dùng');
      const codes = await db.tx((tx) => newRecoveryCodes(tx, user.id));
      await recordAuthEvent(db, { userId: row.id, email: row.email, event: 'RECOVERY_CODES_REGENERATE', req });
      res.json({ ok: true, recoveryCodes: codes });
    }),
  );

  /** Nhật ký đăng nhập & bảo mật của chính người dùng (50 sự kiện gần nhất) */
  r.get(
    '/activity',
    requireAuth,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      res.json(await listAuthEvents(db, user.id, 50));
    }),
  );

  return r;
}
