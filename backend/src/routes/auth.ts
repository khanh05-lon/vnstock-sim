import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router, type Request } from 'express';
import {
  PASSWORD_RESET_TTL_MIN,
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from '@vss/shared';
import type { Database } from '../db';
import { markPasswordChanged, requireAuth, signToken, type AuthedRequest } from '../lib/auth';
import { AppError, ah, badRequest, notFound } from '../lib/errors';
import { log } from '../lib/logger';
import type { Mailer } from '../lib/mailer';
import { ipKey, limiter } from '../lib/rateLimit';
import { config } from '../config';
import { createUserAccount } from '../seed/seed';

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
  created_at: Date | string;
}

const toUser = (u: Pick<UserRow, 'id' | 'email' | 'full_name' | 'created_at'>) => ({
  id: u.id,
  email: u.email,
  fullName: u.full_name,
  createdAt: new Date(u.created_at).toISOString(),
});

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Số link đặt lại tối đa cho 1 tài khoản mỗi giờ (chặn spam hộp thư người khác) */
const RESET_PER_HOUR = 5;

function resetEmail(name: string, link: string) {
  const text = [
    `Chào ${name},`,
    '',
    'Bạn (hoặc ai đó) vừa yêu cầu đặt lại mật khẩu tài khoản VNStock Sim — sàn giao dịch chứng khoán mô phỏng.',
    `Mở link sau trong ${PASSWORD_RESET_TTL_MIN} phút để đặt mật khẩu mới (link chỉ dùng được 1 lần):`,
    '',
    link,
    '',
    'Nếu bạn không yêu cầu, hãy bỏ qua email này — mật khẩu của bạn không thay đổi.',
  ].join('\n');
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#111">
<p>Chào ${esc(name)},</p>
<p>Bạn (hoặc ai đó) vừa yêu cầu đặt lại mật khẩu tài khoản <b>VNStock Sim</b> — sàn giao dịch chứng khoán mô phỏng.</p>
<p><a href="${esc(link)}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none">Đặt mật khẩu mới</a></p>
<p>Link có hiệu lực trong ${PASSWORD_RESET_TTL_MIN} phút và chỉ dùng được 1 lần.<br>Nếu nút không bấm được, mở link: <br><span style="word-break:break-all">${esc(link)}</span></p>
<p style="color:#666">Nếu bạn không yêu cầu, hãy bỏ qua email này — mật khẩu của bạn không thay đổi.</p>
</div>`;
  return { text, html };
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

  r.post(
    '/register',
    authLimiter,
    ah(async (req, res) => {
      const input = registerSchema.parse(req.body);
      const exists = await db.one('SELECT 1 FROM users WHERE email = $1', [input.email]);
      if (exists) throw new AppError(409, 'EMAIL_TAKEN', 'Email đã được sử dụng');
      const hash = await bcrypt.hash(input.password, 10);
      const user = await db.tx((tx) => createUserAccount(tx, input.email, hash, input.fullName)).catch((err: { code?: string }) => {
        // 2 request đăng ký cùng email chạy song song: ràng buộc UNIQUE chặn request sau
        if (err.code === '23505') throw new AppError(409, 'EMAIL_TAKEN', 'Email đã được sử dụng');
        throw err;
      });
      res.status(201).json({ token: signToken({ id: user.id, email: user.email }), user: toUser(user) });
    }),
  );

  r.post(
    '/login',
    authLimiter,
    ah(async (req, res) => {
      const input = loginSchema.parse(req.body);
      const user = await db.one<UserRow>('SELECT * FROM users WHERE email = $1', [input.email]);
      const ok = user ? await bcrypt.compare(input.password, user.password_hash) : false;
      if (!user || !ok) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email hoặc mật khẩu không đúng');
      res.json({ token: signToken({ id: user.id, email: user.email }), user: toUser(user) });
    }),
  );

  // Đăng nhập nhanh bằng tài khoản demo (chỉ khi DEMO_EMAIL được cấu hình)
  r.post(
    '/demo',
    authLimiter,
    ah(async (_req, res) => {
      if (!config.demoEmail) throw notFound('Tài khoản demo chưa được bật');
      const user = await db.one<UserRow>('SELECT * FROM users WHERE email = $1', [config.demoEmail]);
      if (!user) throw notFound('Tài khoản demo chưa được tạo');
      res.json({ token: signToken({ id: user.id, email: user.email }), user: toUser(user) });
    }),
  );

  r.get(
    '/me',
    requireAuth,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const row = await db.one<UserRow>('SELECT id, email, full_name, created_at FROM users WHERE id = $1', [user.id]);
      if (!row) throw notFound('Tài khoản không tồn tại');
      res.json({ user: toUser(row) });
    }),
  );

  r.post(
    '/change-password',
    requireAuth,
    authLimiter,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const input = changePasswordSchema.parse(req.body);
      const row = await db.one<UserRow>('SELECT * FROM users WHERE id = $1', [user.id]);
      if (!row) throw notFound('Tài khoản không tồn tại');
      if (!(await bcrypt.compare(input.currentPassword, row.password_hash))) throw badRequest('WRONG_PASSWORD', 'Mật khẩu hiện tại không đúng');
      const now = new Date();
      await db.many('UPDATE users SET password_hash = $2, password_changed_at = $3 WHERE id = $1', [
        user.id,
        await bcrypt.hash(input.newPassword, 10),
        now,
      ]);
      markPasswordChanged(user.id, now);
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
          const { text, html } = resetEmail(user.full_name, link);
          // Không chờ SMTP: trả lời ngay, thời gian phản hồi không phụ thuộc email có tồn tại hay không
          void mailer
            .send({ to: user.email, subject: 'Đặt lại mật khẩu VNStock Sim', text, html })
            .catch((err) => log.error('[mail] gửi email đặt lại mật khẩu thất bại', { err, userId: user.id }));
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
        return tx.one<UserRow>(
          'UPDATE users SET password_hash = $2, password_changed_at = $3 WHERE id = $1 RETURNING id, email, full_name, created_at',
          [t.user_id, hash, now],
        );
      });
      if (!user) throw notFound('Tài khoản không tồn tại');
      markPasswordChanged(user.id, now);
      log.info('[auth] đã đặt lại mật khẩu', { userId: user.id });
      res.json({ token: signToken({ id: user.id, email: user.email }), user: toUser(user) });
    }),
  );

  return r;
}
