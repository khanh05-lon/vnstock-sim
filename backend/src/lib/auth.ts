import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import type { Queryable } from '../db';
import { unauthorized } from './errors';

export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthedRequest extends Request {
  user: AuthUser;
}

/** `ms` = thời điểm cấp token theo mili-giây (iat chuẩn của JWT chỉ có độ chính xác tới giây) */
export function signToken(user: AuthUser): string {
  return jwt.sign({ sub: user.id, email: user.email, ms: Date.now() }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });
}

/** Kiểm tra chữ ký + hạn của JWT; `issuedMs` dùng để so với thời điểm đổi mật khẩu */
export function verifyToken(token: string): (AuthUser & { iat: number; issuedMs: number }) | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    if (typeof payload.sub !== 'string') return null;
    // Vé tạm (vd. vé chờ nhập mã 2FA) không phải phiên đăng nhập
    if (payload.purpose != null) return null;
    const iat = payload.iat ?? 0;
    return { id: payload.sub, email: String(payload.email ?? ''), iat, issuedMs: typeof payload.ms === 'number' ? payload.ms : iat * 1000 };
  } catch {
    return null;
  }
}

/** Thời hạn vé chờ nhập mã 2FA sau khi nhập đúng mật khẩu */
export const MFA_TICKET_TTL_SEC = 5 * 60;

/** Vé tạm sau bước mật khẩu: chỉ dùng được cho POST /auth/login/2fa, không truy cập được API khác */
export function signMfaTicket(user: AuthUser): string {
  return jwt.sign({ sub: user.id, email: user.email, purpose: 'mfa', ms: Date.now() }, config.jwtSecret, { expiresIn: MFA_TICKET_TTL_SEC });
}

export function verifyMfaTicket(token: string): (AuthUser & { issuedMs: number }) | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    if (payload.purpose !== 'mfa' || typeof payload.sub !== 'string') return null;
    return { id: payload.sub, email: String(payload.email ?? ''), issuedMs: typeof payload.ms === 'number' ? payload.ms : (payload.iat ?? 0) * 1000 };
  } catch {
    return null;
  }
}

/* ---------------- thu hồi phiên khi đổi / đặt lại mật khẩu ---------------- */

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 50_000;
let sessionDb: Queryable | null = null;
/** userId → thời điểm đổi mật khẩu gần nhất (ms, null = chưa đổi) */
const changedAt = new Map<string, { at: number | null; loaded: number }>();

/** Bật kiểm tra token cũ (phát hành trước lần đổi mật khẩu gần nhất) — gọi 1 lần khi khởi động */
export function initSessionCheck(db: Queryable | null) {
  sessionDb = db;
  changedAt.clear();
  verifiedUsers.clear();
}

/** Ghi nhận vừa đổi mật khẩu: mọi token phát hành trước `at` hết hiệu lực */
export function markPasswordChanged(userId: string, at: Date) {
  changedAt.set(userId, { at: at.getTime(), loaded: Date.now() });
}

/**
 * Token còn hiệu lực theo thời điểm đổi mật khẩu? So theo mili-giây (`issuedMs`) để token cũ cấp
 * cùng giây với lần đổi mật khẩu cũng bị thu hồi; token cũ không có `ms` thì so theo giây (`iat`).
 */
export async function isTokenCurrent(user: { id: string; iat: number; issuedMs?: number }): Promise<boolean> {
  if (!sessionDb) return true;
  let entry = changedAt.get(user.id);
  if (!entry || Date.now() - entry.loaded > CACHE_TTL_MS) {
    const row = await sessionDb.one<{ password_changed_at: Date | null }>('SELECT password_changed_at FROM users WHERE id = $1', [user.id]);
    if (!row) return false;
    if (changedAt.size >= CACHE_MAX) changedAt.clear();
    entry = { at: row.password_changed_at ? new Date(row.password_changed_at).getTime() : null, loaded: Date.now() };
    changedAt.set(user.id, entry);
  }
  if (entry.at == null) return true;
  return user.issuedMs != null && user.issuedMs !== user.iat * 1000 ? user.issuedMs >= entry.at : user.iat >= Math.floor(entry.at / 1000);
}

/* ---------------- xác thực email ---------------- */

/** Người dùng đã xác thực email (đã xác thực thì không bao giờ quay lại chưa xác thực) */
const verifiedUsers = new Set<string>();

export function markEmailVerified(userId: string) {
  if (verifiedUsers.size >= CACHE_MAX) verifiedUsers.clear();
  verifiedUsers.add(userId);
}

export async function isEmailVerified(userId: string): Promise<boolean> {
  if (verifiedUsers.has(userId) || !sessionDb) return true;
  const row = await sessionDb.one<{ v: boolean }>('SELECT email_verified_at IS NOT NULL AS v FROM users WHERE id = $1', [userId]);
  if (row?.v) markEmailVerified(userId);
  return !!row?.v;
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const user = token ? verifyToken(token) : null;
  const expired = () => next(unauthorized('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại'));
  if (!user) return expired();
  isTokenCurrent(user).then((ok) => {
    if (!ok) return expired();
    (req as AuthedRequest).user = { id: user.id, email: user.email };
    next();
  }, next);
}
