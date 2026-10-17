import type { NextFunction, Request, Response } from 'express';
import { Big, PERMISSION_DENIED, can, type AdjustRequestDTO, type Permission, type UserRole } from '@vss/shared';
import { config } from '../config';
import type { Database, Queryable } from '../db';
import { requireAuth, type AuthedRequest } from '../lib/auth';
import { accountLockedEmail, approvalRequestEmail } from '../lib/emails';
import type { Mailer } from '../lib/mailer';
import { badRequest, notFound } from '../lib/errors';
import { sendLater } from '../routes/auth';
import type { BalanceRow } from '../trading/dto';
import { credit, ledger as writeLedger } from '../trading/wallet';
import { audit, forbidden, type AdminCtx, type AdminDeps, type AdminRequest } from './common';
import { notifyStaff } from './notify';

/**
 * Chỉ cho nhân viên có quyền `perm` (theo vai trò), đang hoạt động; vai trò đọc lại từ CSDL ở mỗi request
 * (thu quyền có hiệu lực ngay). REQUIRE_STAFF_2FA: nhân viên phải bật xác thực 2 lớp.
 */
export function staffGuard(db: Database, perm: Permission) {
  const check = (req: Request, _res: Response, next: NextFunction) => {
    const { user } = req as AuthedRequest;
    db.one<{ role: UserRole; status: string; totp_enabled_at: Date | null }>('SELECT role, status, totp_enabled_at FROM users WHERE id = $1', [user.id]).then(
      (row) => {
        if (!row || !can(row.role, perm)) return next(forbidden(PERMISSION_DENIED[perm]));
        if (row.status !== 'ACTIVE') return next(forbidden('Tài khoản nhân viên đang bị khoá'));
        if (config.requireStaff2fa && !row.totp_enabled_at) {
          return next(forbidden('Nhân viên phải bật xác thực 2 lớp (Cài đặt tài khoản → Bảo mật) trước khi dùng khu vực này'));
        }
        (req as AdminRequest).admin = { id: user.id, email: user.email, role: row.role };
        next();
      },
      next,
    );
  };
  return [requireAuth, check];
}

/** Ghi "đã xem hồ sơ khách" — tối đa 1 dòng / nhân viên / khách / 30 phút để nhật ký không bị ngập */
const lastView = new Map<string, number>();
export async function auditView(q: Queryable, staff: AdminCtx, userId: string, email: string, via: string) {
  const key = `${staff.id}:${userId}`;
  const now = Date.now();
  if ((lastView.get(key) ?? 0) > now - 30 * 60_000) return;
  lastView.set(key, now);
  if (lastView.size > 50_000) lastView.clear();
  await audit(q, staff, 'USER_VIEW', 'user', userId, { email, via });
}

/** Khoá tài khoản (quản trị viên hoặc CSKH khoá khẩn khi nghi bị truy cập trái phép) */
export async function lockUser(deps: Pick<AdminDeps, 'db' | 'io' | 'engine' | 'store' | 'mailer'>, staff: AdminCtx, id: string, reason: string) {
  const { db, io, engine, store, mailer } = deps;
  if (id === staff.id) throw badRequest('SELF', 'Không thể tự khoá tài khoản của mình');
  const u = await db.one<{ email: string; full_name: string; role: string; status: string }>('SELECT email, full_name, role, status FROM users WHERE id = $1', [id]);
  if (!u) throw notFound('Không tìm thấy người dùng');
  if (u.status === 'DELETED') throw badRequest('DELETED', 'Tài khoản đã bị xoá (ẩn danh) — không thao tác được');
  if (u.role !== 'USER') throw badRequest('IS_STAFF', 'Hãy thu quyền nhân viên trước khi khoá tài khoản này');
  if (u.status === 'LOCKED') throw badRequest('ALREADY_LOCKED', 'Tài khoản đã bị khoá');
  await db.many(`UPDATE users SET status = 'LOCKED', locked_reason = $2 WHERE id = $1`, [id, reason]);
  store.locked.add(id);
  const cancelled = await engine.cancelAllForUser(id, `Tài khoản bị khoá: ${reason}`, { actor: staff.email });
  io.in(`user:${id}`).disconnectSockets(true);
  await audit(db, staff, 'USER_LOCK', 'user', id, { email: u.email, reason, cancelledOrders: cancelled });
  sendLater(mailer, u.email, accountLockedEmail(u.full_name, true, reason), { userId: id });
  return { cancelledOrders: cancelled, email: u.email };
}

/**
 * Cộng / trừ số dư 1 tài sản (trong transaction có sẵn) + sổ cái + nhật ký quản trị.
 * Dùng chung cho điều chỉnh trực tiếp (dưới ngưỡng) và duyệt yêu cầu điều chỉnh.
 */
export async function applyBalanceAdjust(
  tx: Queryable,
  staff: AdminCtx,
  a: { userId: string; email: string; asset: string; amount: string; usdtValue: string; reason: string; requestId?: number; requestedBy?: string; ticketId?: number | null },
): Promise<string> {
  let total: string;
  if (new Big(a.amount).gt(0)) {
    total = await credit(tx, a.userId, a.asset, a.amount, new Big(a.usdtValue).abs().toFixed());
  } else {
    const take = new Big(a.amount).abs().toFixed();
    const row = await tx.one<BalanceRow>(
      `UPDATE balances SET free = free - $3,
              cost_usdt = GREATEST(cost_usdt - cost_usdt * $3 / NULLIF(free + locked, 0), 0), updated_at = now()
       WHERE user_id = $1 AND asset = $2 AND free >= $3 RETURNING *`,
      [a.userId, a.asset, take],
    );
    if (!row) throw badRequest('INSUFFICIENT_BALANCE', `Số dư ${a.asset} khả dụng không đủ để trừ ${take}`);
    total = new Big(row.free).plus(row.locked).toFixed();
  }
  await tx.many('UPDATE accounts SET contributed_usdt = contributed_usdt + $2, updated_at = now() WHERE user_id = $1', [a.userId, a.usdtValue]);
  const by = a.requestId ? ` (yêu cầu #${a.requestId} của ${a.requestedBy}, duyệt bởi ${staff.email})` : '';
  const ticket = a.ticketId ? ` [hỗ trợ #${a.ticketId}]` : '';
  await writeLedger(tx, a.userId, a.asset, 'ADJUST', a.amount, total, null, `Điều chỉnh: ${a.reason}${ticket}${by}`);
  await audit(tx, staff, 'BALANCE_ADJUST', 'user', a.userId, {
    email: a.email,
    asset: a.asset,
    amount: a.amount,
    usdtValue: new Big(a.usdtValue).toFixed(2),
    reason: a.reason,
    balanceAfter: total,
    ...(a.requestId ? { requestId: a.requestId, requestedBy: a.requestedBy } : {}),
  });
  return total;
}

export interface AdjustRequestRow {
  id: number;
  user_id: string;
  asset: string;
  amount: string;
  usdt_value: string;
  reason: string;
  ticket_id: number | null;
  requested_by: string;
  requested_by_email: string;
  status: AdjustRequestDTO['status'];
  decided_by: string | null;
  decided_by_email: string | null;
  decision_note: string | null;
  decided_at: Date | null;
  created_at: Date;
  email?: string;
  full_name?: string;
}

const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());

export function toAdjustRequestDTO(r: AdjustRequestRow): AdjustRequestDTO {
  return {
    id: Number(r.id),
    user: { id: r.user_id, email: r.email ?? '', fullName: r.full_name ?? '' },
    asset: r.asset,
    amount: new Big(r.amount).toFixed(),
    usdtValue: new Big(r.usdt_value).toFixed(2),
    reason: r.reason,
    ticketId: r.ticket_id == null ? null : Number(r.ticket_id),
    requestedByEmail: r.requested_by_email,
    status: r.status,
    decidedByEmail: r.decided_by_email,
    decisionNote: r.decision_note,
    decidedAt: iso(r.decided_at),
    createdAt: iso(r.created_at)!,
  };
}

/** Tạo yêu cầu điều chỉnh số dư chờ quản trị viên khác duyệt */
export async function createAdjustRequest(
  q: Queryable,
  staff: AdminCtx,
  a: { userId: string; email: string; asset: string; amount: string; usdtValue: string; reason: string; ticketId?: number | null },
  mailer?: Mailer,
): Promise<AdjustRequestDTO> {
  const row = await q.one<AdjustRequestRow>(
    `INSERT INTO balance_adjust_requests (user_id, asset, amount, usdt_value, reason, ticket_id, requested_by, requested_by_email)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [a.userId, a.asset, a.amount, a.usdtValue, a.reason, a.ticketId ?? null, staff.id, staff.email],
  );
  await audit(q, staff, 'BALANCE_ADJUST_REQUEST', 'user', a.userId, {
    requestId: Number(row!.id),
    email: a.email,
    asset: a.asset,
    amount: a.amount,
    usdtValue: new Big(a.usdtValue).toFixed(2),
    reason: a.reason,
    ticketId: a.ticketId ?? null,
  });
  // Báo người Tài chính có thể duyệt (trừ người đề xuất và chính chủ tài khoản được điều chỉnh)
  await notifyStaff(
    q,
    mailer,
    'finance.approve',
    [staff.id, a.userId],
    (name) =>
      approvalRequestEmail(name, {
        id: Number(row!.id),
        kindLabel: 'Điều chỉnh số dư',
        summary: `${Number(a.amount) > 0 ? 'Cộng' : 'Trừ'} ${a.amount.replace('-', '')} ${a.asset} (≈ ${new Big(a.usdtValue).abs().toFixed(2)} USDT) cho ${a.email}${a.ticketId ? ` — yêu cầu hỗ trợ #${a.ticketId}` : ''}`,
        reason: a.reason,
        requestedBy: staff.email,
      }),
    { adjustRequestId: Number(row!.id) },
  ).catch(() => undefined);
  return toAdjustRequestDTO({ ...row!, email: a.email });
}
