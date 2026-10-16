import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/db';
import { initSessionCheck } from '../src/lib/auth';
import { errorHandler } from '../src/lib/errors';
import type { MailMessage, Mailer } from '../src/lib/mailer';
import { base32Decode, hotp, totpCode, verifyTotp } from '../src/lib/totp';
import { authRoutes } from '../src/routes/auth';
import { closeTestDb, openTestDb } from './helpers/db';

let db: Database;
let server: http.Server;
let base: string;
const sent: MailMessage[] = [];
const mailer: Mailer = { kind: 'smtp', send: async (m) => void sent.push(m) };

async function call(path: string, body?: unknown, token?: string, method?: string) {
  const res = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const tokenFromMail = (m: MailMessage) => new URL(/https?:\/\/\S+/.exec(m.text)![0]).searchParams.get('token')!;
/** Chờ email thứ n có tiêu đề chứa `subject` (email gửi bất đồng bộ) */
const nthMail = async (subject: string, n: number) => {
  const list = () => sent.filter((m) => m.subject.includes(subject));
  for (let i = 0; i < 50 && list().length < n; i++) await new Promise((r) => setTimeout(r, 10));
  return list()[n - 1];
};
const count = (subject: string) => sent.filter((m) => m.subject.includes(subject)).length;
const RESET = 'Đặt lại mật khẩu';
const VERIFY = 'Xác thực email';

beforeAll(async () => {
  db = await openTestDb();
  initSessionCheck(db);
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes(db, mailer));
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`;
});

afterAll(async () => {
  initSessionCheck(null);
  await new Promise((r) => server.close(r));
  await closeTestDb(db);
});

describe('TOTP (RFC 6238)', () => {
  it('khớp vector chuẩn của RFC 6238 (SHA-1)', () => {
    const secret = Buffer.from('12345678901234567890');
    // T = 59s → bộ đếm 1; mã 8 số chuẩn là 94287082 → 6 số cuối 287082
    expect(hotp(secret, 1, 8)).toBe('94287082');
    expect(hotp(secret, 1)).toBe('287082');
    // T = 1111111109 → 07081804
    expect(hotp(secret, Math.floor(1111111109 / 30), 8)).toBe('07081804');
  });

  it('chấp nhận lệch ±1 bước 30 giây, từ chối mã cũ hơn', () => {
    const b32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 của "12345678901234567890"
    expect(base32Decode(b32).toString()).toBe('12345678901234567890');
    const now = 1_700_000_000_000;
    expect(verifyTotp(b32, totpCode(b32, now), now)).toBe(Math.floor(now / 30_000));
    expect(verifyTotp(b32, totpCode(b32, now - 30_000), now)).not.toBeNull();
    expect(verifyTotp(b32, totpCode(b32, now - 90_000), now)).toBeNull();
    expect(verifyTotp(b32, '12345', now)).toBeNull();
  });
});

describe('Quên / đặt lại mật khẩu', () => {
  const email = 'lan@example.test';
  let oldToken: string;

  it('đăng ký tài khoản (gửi email xác thực)', async () => {
    const r = await call('/register', { fullName: 'Nguyễn Lan', email, password: 'matkhau123' });
    expect(r.status).toBe(201);
    expect(r.body.user.emailVerified).toBe(false);
    oldToken = r.body.token;
    expect((await call('/me', undefined, oldToken)).status).toBe(200);
    expect((await nthMail(VERIFY, 1)).to).toBe(email);
  });

  it('email chưa đăng ký: trả lời giống hệt, không gửi email', async () => {
    const r = await call('/forgot-password', { email: 'khongco@example.test' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 30));
    expect(count(RESET)).toBe(0);
  });

  it('email đã đăng ký: gửi link có token, CSDL chỉ lưu hash, hết hạn sau 30 phút', async () => {
    const r = await call('/forgot-password', { email: 'LAN@example.test ' });
    expect(r.status).toBe(200);
    const mail = await nthMail(RESET, 1);
    expect(mail.to).toBe(email);
    expect(mail.text).toContain('/reset-password?token=');
    const token = tokenFromMail(mail);
    const row = await db.one<{ token_hash: string; minutes: number }>(
      `SELECT token_hash, round(extract(epoch FROM expires_at - created_at) / 60)::int AS minutes FROM password_reset_tokens`,
    );
    expect(row!.token_hash).not.toBe(token);
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.minutes).toBe(30);
  });

  it('token sai → 400; token đúng → đổi mật khẩu, đăng nhập luôn, phiên cũ bị đăng xuất, có email thông báo', async () => {
    const token = tokenFromMail(await nthMail(RESET, 1));
    expect((await call('/reset-password', { token: 'x'.repeat(43), password: 'moi123456' })).status).toBe(400);

    const r = await call('/reset-password', { token, password: 'moi123456' });
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe(email);
    // mở được link trong email = chứng minh sở hữu email
    expect(r.body.user.emailVerified).toBe(true);
    expect((await call('/me', undefined, r.body.token)).status).toBe(200);
    expect((await call('/me', undefined, oldToken)).status).toBe(401);
    expect((await nthMail('vừa được thay đổi', 1)).to).toBe(email);

    expect((await call('/login', { email, password: 'matkhau123' })).status).toBe(401);
    expect((await call('/login', { email, password: 'moi123456' })).status).toBe(200);
  });

  it('link chỉ dùng được 1 lần', async () => {
    const r = await call('/reset-password', { token: tokenFromMail(await nthMail(RESET, 1)), password: 'khac12345' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('RESET_TOKEN_INVALID');
  });

  it('link quá 30 phút → 400', async () => {
    await call('/forgot-password', { email });
    const token = tokenFromMail(await nthMail(RESET, 2));
    await db.many(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`);
    const r = await call('/reset-password', { token, password: 'khac12345' });
    expect(r.status).toBe(400);
  });

  it('yêu cầu link mới làm link cũ hết hiệu lực', async () => {
    await call('/forgot-password', { email });
    const first = tokenFromMail(await nthMail(RESET, 3));
    // giới hạn 3 yêu cầu/giờ/email ở tầng HTTP → yêu cầu thứ 4 bị chặn
    expect((await call('/forgot-password', { email })).status).toBe(429);
    await db.many(`UPDATE password_reset_tokens SET used_at = now() WHERE token_hash <> ''`);
    expect((await call('/reset-password', { token: first, password: 'khac12345' })).status).toBe(400);
  });

  it('đổi mật khẩu trả token mới, token cũ hết hiệu lực', async () => {
    const login = await call('/login', { email, password: 'moi123456' });
    // iat tính theo giây: chờ sang giây mới để token mới chắc chắn "sau" lần đặt lại trước
    await new Promise((r) => setTimeout(r, 1100));
    const r = await call('/change-password', { currentPassword: 'moi123456', newPassword: 'doi123456' }, login.body.token);
    expect(r.status).toBe(200);
    expect((await call('/me', undefined, r.body.token)).status).toBe(200);
    expect((await call('/me', undefined, login.body.token)).status).toBe(401);
  });
});

describe('Xác thực email', () => {
  const email = 'minh@example.test';
  let token: string;

  it('link trong email xác thực tài khoản, dùng 1 lần', async () => {
    const r = await call('/register', { fullName: 'Trần Minh', email, password: 'matkhau123' });
    token = r.body.token;
    const before = count(VERIFY);
    const mail = await nthMail(VERIFY, before);
    expect(mail.to).toBe(email);
    expect(mail.text).toContain('/verify-email?token=');
    const v = await call('/verify-email', { token: tokenFromMail(mail) });
    expect(v.status).toBe(200);
    expect(v.body.user.emailVerified).toBe(true);
    expect((await call('/me', undefined, token)).body.user.emailVerified).toBe(true);
    expect((await call('/verify-email', { token: tokenFromMail(mail) })).status).toBe(400);
  });

  it('gửi lại link: tài khoản đã xác thực thì không gửi; chưa xác thực thì link cũ hết hiệu lực', async () => {
    expect((await call('/resend-verification', {}, token)).body.alreadyVerified).toBe(true);

    const r = await call('/register', { fullName: 'Lê Hoa', email: 'hoa@example.test', password: 'matkhau123' });
    const n = count(VERIFY);
    const first = tokenFromMail(await nthMail(VERIFY, n));
    expect((await call('/resend-verification', {}, r.body.token)).status).toBe(200);
    const second = tokenFromMail(await nthMail(VERIFY, n + 1));
    expect((await call('/verify-email', { token: first })).status).toBe(400);
    expect((await call('/verify-email', { token: second })).status).toBe(200);
  });

  it('tuỳ chọn thông báo & tên hiển thị', async () => {
    const r = await call('/preferences', { notifyFills: true, displayName: 'Minh Trader', showOnLeaderboard: false }, token, 'PUT');
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ notifyFills: true, displayName: 'Minh Trader', showOnLeaderboard: false });
    expect((await call('/preferences', { displayName: '<script>' }, token, 'PUT')).status).toBe(400);
  });
});

describe('Xác thực 2 lớp (TOTP)', () => {
  const email = 'khoa@example.test';
  const password = 'matkhau123';
  let token: string;
  let secret: string;
  let recovery: string[];

  it('bật 2FA: cần mật khẩu, quét QR, nhập mã đầu tiên → nhận 10 mã khôi phục', async () => {
    token = (await call('/register', { fullName: 'Phạm Khoa', email, password })).body.token;
    expect((await call('/2fa/setup', { password: 'sai' }, token)).status).toBe(400);
    const s = await call('/2fa/setup', { password }, token);
    expect(s.status).toBe(200);
    expect(s.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(s.body.qrSvg).toContain('<svg');
    secret = s.body.secret;
    expect((await call('/2fa/enable', { code: '000000' }, token)).status).toBe(400);
    const e = await call('/2fa/enable', { code: totpCode(secret) }, token);
    expect(e.status).toBe(200);
    recovery = e.body.recoveryCodes;
    expect(recovery).toHaveLength(10);
    expect((await call('/me', undefined, token)).body.user.twoFactorEnabled).toBe(true);
    // CSDL chỉ lưu hash của mã khôi phục
    const rows = await db.many<{ code_hash: string }>('SELECT code_hash FROM recovery_codes');
    expect(rows.some((x) => recovery.includes(x.code_hash))).toBe(false);
  });

  it('đăng nhập phải qua bước nhập mã; vé tạm không dùng được như phiên đăng nhập', async () => {
    const l = await call('/login', { email, password });
    expect(l.status).toBe(200);
    expect(l.body.mfaRequired).toBe(true);
    expect(l.body.token).toBeUndefined();
    expect((await call('/me', undefined, l.body.mfaToken)).status).toBe(401);

    expect((await call('/login/2fa', { mfaToken: l.body.mfaToken, code: '123456' })).status).toBe(400);
    // mã của bước 30 giây kế tiếp (mã hiện tại vừa dùng để bật 2FA → bị chặn dùng lại)
    const code = totpCode(secret, Date.now() + 30_000);
    const ok = await call('/login/2fa', { mfaToken: l.body.mfaToken, code });
    expect(ok.status).toBe(200);
    expect((await call('/me', undefined, ok.body.token)).status).toBe(200);
    // dùng lại đúng mã đó → từ chối
    expect((await call('/login/2fa', { mfaToken: l.body.mfaToken, code })).status).toBe(400);
  });

  it('mã khôi phục dùng được đúng 1 lần và có email cảnh báo', async () => {
    const l = await call('/login', { email, password });
    const r1 = await call('/login/2fa', { mfaToken: l.body.mfaToken, code: recovery[0].toUpperCase() });
    expect(r1.status).toBe(200);
    expect((await call('/login/2fa', { mfaToken: l.body.mfaToken, code: recovery[0] })).status).toBe(400);
    expect((await nthMail('Mã khôi phục 2FA', 1)).text).toContain('còn 9 mã');
  });

  it('đặt lại mật khẩu qua email vẫn phải nhập mã 2FA', async () => {
    await call('/forgot-password', { email });
    let mail: MailMessage | undefined;
    for (let i = 0; i < 50 && !mail; i++) {
      mail = sent.find((m) => m.to === email && m.subject.includes(RESET));
      if (!mail) await new Promise((r) => setTimeout(r, 10));
    }
    const r = await call('/reset-password', { token: tokenFromMail(mail!), password: 'moi123456' });
    expect(r.status).toBe(200);
    expect(r.body.mfaRequired).toBe(true);
    expect(r.body.token).toBeUndefined();
  });

  it('tắt 2FA cần mật khẩu + mã', async () => {
    const l = await call('/login', { email, password: 'moi123456' });
    const s = await call('/login/2fa', { mfaToken: l.body.mfaToken, code: recovery[1] });
    token = s.body.token;
    expect((await call('/2fa/disable', { password: 'moi123456', code: '000000' }, token)).status).toBe(400);
    const d = await call('/2fa/disable', { password: 'moi123456', code: recovery[2] }, token);
    expect(d.status).toBe(200);
    expect((await call('/login', { email, password: 'moi123456' })).body.token).toBeTruthy();
    expect((await db.one<{ n: number }>('SELECT count(*)::int AS n FROM recovery_codes'))!.n).toBe(0);
  });
});
