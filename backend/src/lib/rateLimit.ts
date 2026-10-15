import type { Request } from 'express';
import rateLimit from 'express-rate-limit';
import { verifyToken, type AuthedRequest } from './auth';

/**
 * Giới hạn tần suất. Bộ đếm lưu trong bộ nhớ tiến trình → đúng khi chạy 1 instance
 * (app hiện chỉ hỗ trợ 1 instance vì thị trường mô phỏng nằm trong bộ nhớ).
 */

/** Theo người dùng: id trong JWT nếu có token hợp lệ, ngược lại theo IP */
export function userKey(req: Request): string {
  const authed = (req as Partial<AuthedRequest>).user;
  if (authed) return `u:${authed.id}`;
  const header = req.headers.authorization ?? '';
  const user = header.startsWith('Bearer ') ? verifyToken(header.slice(7)) : null;
  return user ? `u:${user.id}` : `ip:${req.ip}`;
}

export const ipKey = (req: Request) => `ip:${req.ip}`;

export function limiter(opts: { windowMs: number; limit: number; message: string; key?: (req: Request) => string }) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: opts.key ?? userKey,
    message: { error: { code: 'RATE_LIMIT', message: opts.message } },
  });
}
