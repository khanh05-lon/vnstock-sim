import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { unauthorized } from './errors';

export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthedRequest extends Request {
  user: AuthUser;
}

export function signToken(user: AuthUser): string {
  return jwt.sign({ sub: user.id, email: user.email }, config.jwtSecret, { expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'] });
}

export function verifyToken(token: string): AuthUser | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    if (typeof payload.sub !== 'string') return null;
    return { id: payload.sub, email: String(payload.email ?? '') };
  } catch {
    return null;
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const user = token ? verifyToken(token) : null;
  if (!user) return next(unauthorized('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại'));
  (req as AuthedRequest).user = user;
  next();
}
