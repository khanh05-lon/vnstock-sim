import './logBuffer';
import bcrypt from 'bcryptjs';
import type { Express, NextFunction, Request, Response } from 'express';
import type { Database } from '../db';
import { verifyToken } from '../lib/auth';
import { AppError } from '../lib/errors';
import { createUserAccount } from '../seed/seed';
import type { AdminDeps } from './common';
import { adminRoutes } from './routes';
import { AdminStore } from './store';

const LOCKED_MESSAGE = 'Tài khoản của bạn đã bị khoá. Vui lòng liên hệ quản trị viên.';

/**
 * Tài khoản quản trị mặc định. Ở môi trường dev dùng giá trị mẫu trong .env.example;
 * ở production bắt buộc đặt ADMIN_EMAIL / ADMIN_PASSWORD, nếu không sẽ không tạo.
 */
async function seedAdminUser(db: Database) {
  const prod = process.env.NODE_ENV === 'production';
  const email = (process.env.ADMIN_EMAIL || (prod ? '' : 'admin@vncoin.local')).trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || (prod ? '' : 'admin12345');
  if (!email || !password) {
    console.warn('[admin] chưa đặt ADMIN_EMAIL / ADMIN_PASSWORD — không tạo tài khoản quản trị');
    return;
  }
  const existing = await db.one<{ id: string; role: string }>('SELECT id, role FROM users WHERE email = $1', [email]);
  if (existing) {
    if (existing.role !== 'ADMIN') {
      await db.many(`UPDATE users SET role = 'ADMIN', status = 'ACTIVE', email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`, [
        existing.id,
      ]);
    }
    return;
  }
  const hash = await bcrypt.hash(password, 10);
  await db.tx(async (tx) => {
    const user = await createUserAccount(tx, email, hash, 'Quản trị viên');
    await tx.many(`UPDATE users SET role = 'ADMIN', email_verified_at = now() WHERE id = $1`, [user.id]);
  });
  console.log(`[admin] đã tạo tài khoản quản trị ${email}`);
}

function bearer(req: Request): string {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

/**
 * Gắn khu vực quản trị vào ứng dụng. Phải gọi TRƯỚC khi mount các route /api khác
 * để middleware chặn tài khoản bị khoá chạy trước.
 */
export async function installAdmin(deps: Omit<AdminDeps, 'store'> & { app: Express }) {
  const { app, io, db, engine } = deps;
  const store = new AdminStore(db, engine);
  await store.load();
  await seedAdminUser(db);

  // Bảo trì (vd. đang khôi phục dữ liệu): từ chối mọi API trừ quản trị, trạng thái hệ thống và health check
  app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
    if (!store.maintenance || req.path.startsWith('/admin') || req.path === '/system' || req.path === '/health') return next();
    next(new AppError(503, 'MAINTENANCE', store.maintenance));
  });

  // Tài khoản bị khoá: chặn mọi API cần đăng nhập + ghi nhận lần hoạt động gần nhất (tối đa 1 lần / phút)
  const lastSeen = new Map<string, number>();
  app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
    const token = bearer(req);
    if (!token) return next();
    const user = verifyToken(token);
    if (!user) return next();
    if (store.locked.has(user.id)) return next(new AppError(403, 'ACCOUNT_LOCKED', LOCKED_MESSAGE));
    const now = Date.now();
    if ((lastSeen.get(user.id) ?? 0) < now - 60_000) {
      lastSeen.set(user.id, now);
      if (lastSeen.size > 100_000) lastSeen.clear();
      db.many('UPDATE users SET last_seen_at = now() WHERE id = $1', [user.id]).catch(() => undefined);
    }
    next();
  });

  // Kênh realtime: từ chối kết nối của tài khoản bị khoá
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const user = typeof token === 'string' && token ? verifyToken(token) : null;
    if (user && store.locked.has(user.id)) return next(new Error(LOCKED_MESSAGE));
    next();
  });

  // Trạng thái vận hành công khai: thông báo hệ thống, tạm ngừng giao dịch
  app.get('/api/system', (_req, res) => {
    res.json(store.status());
  });

  const { app: _app, ...rest } = deps;
  app.use('/api/admin', adminRoutes({ ...rest, store }));
  return store;
}
