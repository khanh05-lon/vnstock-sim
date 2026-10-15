import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { changePasswordSchema, loginSchema, registerSchema } from '@vss/shared';
import type { Database } from '../db';
import { requireAuth, signToken, type AuthedRequest } from '../lib/auth';
import { AppError, ah, badRequest, notFound } from '../lib/errors';
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

export function authRoutes(db: Database) {
  const r = Router();
  const limiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMIT', message: 'Thao tác quá nhiều lần, vui lòng thử lại sau ít phút' } },
  });

  r.post(
    '/register',
    limiter,
    ah(async (req, res) => {
      const input = registerSchema.parse(req.body);
      const exists = await db.one('SELECT 1 FROM users WHERE email = $1', [input.email]);
      if (exists) throw new AppError(409, 'EMAIL_TAKEN', 'Email đã được sử dụng');
      const hash = await bcrypt.hash(input.password, 10);
      const user = await db.tx((tx) => createUserAccount(tx, input.email, hash, input.fullName));
      res.status(201).json({ token: signToken({ id: user.id, email: user.email }), user: toUser(user) });
    }),
  );

  r.post(
    '/login',
    limiter,
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
    limiter,
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
    limiter,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const input = changePasswordSchema.parse(req.body);
      const row = await db.one<UserRow>('SELECT * FROM users WHERE id = $1', [user.id]);
      if (!row) throw notFound('Tài khoản không tồn tại');
      if (!(await bcrypt.compare(input.currentPassword, row.password_hash))) throw badRequest('WRONG_PASSWORD', 'Mật khẩu hiện tại không đúng');
      await db.many('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await bcrypt.hash(input.newPassword, 10)]);
      res.json({ ok: true });
    }),
  );

  return r;
}
