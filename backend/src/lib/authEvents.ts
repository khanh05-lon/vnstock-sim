import type { Request } from 'express';
import { AUTH_EVENT_LABEL, type AuthEventDTO } from '@vss/shared';
import type { Queryable } from '../db';
import { log } from './logger';

/** Sai mật khẩu quá số lần này trong cửa sổ thời gian → tạm chặn đăng nhập tài khoản đó */
export const LOGIN_FAIL_LIMIT = 5;
export const LOGIN_FAIL_WINDOW_MIN = 15;

export interface AuthEventRow {
  id: number;
  user_id: string | null;
  email: string | null;
  event: string;
  ip: string | null;
  user_agent: string | null;
  detail: Record<string, unknown> | string;
  created_at: Date;
}

export const clientIp = (req?: Request) => (req ? (req.ip ?? null) : null);
export const clientUa = (req?: Request) => (req ? String(req.headers['user-agent'] ?? '').slice(0, 300) || null : null);

/**
 * Ghi 1 sự kiện đăng nhập / bảo mật (chỉ được ghi thêm — có trigger chặn sửa xoá).
 * Lỗi ghi nhật ký không được làm hỏng thao tác chính → chỉ ghi log.
 */
export async function recordAuthEvent(
  q: Queryable,
  e: { userId?: string | null; email?: string | null; event: string; req?: Request; detail?: Record<string, unknown> },
): Promise<void> {
  try {
    await q.many('INSERT INTO auth_events (user_id, email, event, ip, user_agent, detail) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [
      e.userId ?? null,
      e.email ? e.email.toLowerCase() : null,
      e.event,
      clientIp(e.req),
      clientUa(e.req),
      JSON.stringify(e.detail ?? {}),
    ]);
  } catch (err) {
    log.error('[auth] không ghi được nhật ký đăng nhập', { err, event: e.event });
  }
}

/** Số lần sai mật khẩu / mã 2FA gần đây của 1 email (kể từ lần đăng nhập thành công gần nhất) */
export async function recentLoginFailures(q: Queryable, email: string): Promise<number> {
  const row = await q.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM auth_events
     WHERE email = $1 AND event IN ('LOGIN_FAIL', 'LOGIN_2FA_FAIL') AND created_at > now() - make_interval(mins => $2)
       AND created_at > COALESCE((SELECT max(created_at) FROM auth_events WHERE email = $1 AND event = 'LOGIN_OK'), 'epoch'::timestamptz)`,
    [email.toLowerCase(), LOGIN_FAIL_WINDOW_MIN],
  );
  return row?.n ?? 0;
}

export function toAuthEventDTO(r: AuthEventRow): AuthEventDTO {
  return {
    id: Number(r.id),
    event: r.event,
    label: AUTH_EVENT_LABEL[r.event] ?? r.event,
    ip: r.ip,
    userAgent: r.user_agent,
    detail: typeof r.detail === 'string' ? (JSON.parse(r.detail) as Record<string, unknown>) : (r.detail ?? {}),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export async function listAuthEvents(q: Queryable, userId: string, limit = 50): Promise<AuthEventDTO[]> {
  const rows = await q.many<AuthEventRow>('SELECT * FROM auth_events WHERE user_id = $1 ORDER BY id DESC LIMIT $2', [userId, limit]);
  return rows.map(toAuthEventDTO);
}
