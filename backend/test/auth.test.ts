import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/db';
import { initSessionCheck } from '../src/lib/auth';
import { errorHandler } from '../src/lib/errors';
import type { MailMessage, Mailer } from '../src/lib/mailer';
import { authRoutes } from '../src/routes/auth';
import { closeTestDb, openTestDb } from './helpers/db';

let db: Database;
let server: http.Server;
let base: string;
const sent: MailMessage[] = [];
const mailer: Mailer = { kind: 'smtp', send: async (m) => void sent.push(m) };

async function call(path: string, body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const tokenFromMail = (m: MailMessage) => new URL(/https?:\/\/\S+/.exec(m.text)![0]).searchParams.get('token')!;
const nextMail = async (n: number) => {
  for (let i = 0; i < 50 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 10));
  return sent[n - 1];
};

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

describe('Quên / đặt lại mật khẩu', () => {
  const email = 'lan@example.test';
  let oldToken: string;

  it('đăng ký tài khoản', async () => {
    const r = await call('/register', { fullName: 'Nguyễn Lan', email, password: 'matkhau123' });
    expect(r.status).toBe(201);
    oldToken = r.body.token;
    expect((await call('/me', undefined, oldToken)).status).toBe(200);
  });

  it('email chưa đăng ký: trả lời giống hệt, không gửi email', async () => {
    const r = await call('/forgot-password', { email: 'khongco@example.test' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 30));
    expect(sent).toHaveLength(0);
  });

  it('email đã đăng ký: gửi link có token, CSDL chỉ lưu hash, hết hạn sau 30 phút', async () => {
    const r = await call('/forgot-password', { email: 'LAN@example.test ' });
    expect(r.status).toBe(200);
    const mail = await nextMail(1);
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

  it('token sai → 400; token đúng → đổi mật khẩu, đăng nhập luôn, phiên cũ bị đăng xuất', async () => {
    const token = tokenFromMail(sent[0]);
    expect((await call('/reset-password', { token: 'x'.repeat(43), password: 'moi123456' })).status).toBe(400);

    const r = await call('/reset-password', { token, password: 'moi123456' });
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe(email);
    expect((await call('/me', undefined, r.body.token)).status).toBe(200);
    expect((await call('/me', undefined, oldToken)).status).toBe(401);

    expect((await call('/login', { email, password: 'matkhau123' })).status).toBe(401);
    expect((await call('/login', { email, password: 'moi123456' })).status).toBe(200);
  });

  it('link chỉ dùng được 1 lần', async () => {
    const r = await call('/reset-password', { token: tokenFromMail(sent[0]), password: 'khac12345' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('RESET_TOKEN_INVALID');
  });

  it('link quá 30 phút → 400', async () => {
    await call('/forgot-password', { email });
    const token = tokenFromMail(await nextMail(2));
    await db.many(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`);
    const r = await call('/reset-password', { token, password: 'khac12345' });
    expect(r.status).toBe(400);
  });

  it('yêu cầu link mới làm link cũ hết hiệu lực', async () => {
    await call('/forgot-password', { email });
    const first = tokenFromMail(await nextMail(3));
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
