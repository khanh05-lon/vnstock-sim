import { PRIVACY_EXPORTS_PER_DAY, type PrivacyCheck, type PrivacyRequestDTO, type PrivacyRequestStatus } from '@vss/shared';
import type { Database, Queryable } from '../db';
import { AppError, badRequest, notFound } from '../lib/errors';
import { openSecret } from '../lib/secretBox';
import { statementOf } from '../p2p/bank';

/*
 * Quyền của chủ thể dữ liệu: khách tự tải dữ liệu cá nhân (JSON) và gửi yêu cầu xoá tài khoản.
 * Xoá = ẩn danh (anonymizeUser), dữ liệu giao dịch giữ lại theo nghĩa vụ lưu trữ. DPO xử lý ở admin/privacy.ts.
 */

const forbidden = (msg: string) => new AppError(403, 'FORBIDDEN', msg);

interface RequestRow {
  id: string | number;
  user_id: string;
  type: 'DELETE';
  reason: string;
  status: PrivacyRequestStatus;
  decided_by: string | null;
  decision_note: string | null;
  decided_at: Date | null;
  created_at: Date;
  email?: string;
  full_name?: string;
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export const toPrivacyDTO = (r: RequestRow, checks?: PrivacyCheck[]): PrivacyRequestDTO => ({
  id: Number(r.id),
  userId: r.user_id,
  email: r.email ?? '',
  accountName: r.full_name ?? '',
  type: r.type,
  reason: r.reason,
  status: r.status,
  decisionNote: r.decision_note,
  decidedBy: r.decided_by,
  createdAt: iso(r.created_at)!,
  decidedAt: iso(r.decided_at),
  ...(checks && { checks }),
});

/**
 * Điều kiện trước khi xoá. Không nêu chi tiết AML (nguyên tắc không tiết lộ): chỉ ghi "nghĩa vụ giữ tài khoản".
 */
export async function privacyChecks(q: Queryable, userId: string): Promise<PrivacyCheck[]> {
  const u = await q.one<{ aml_restricted_at: Date | null; status: string }>('SELECT aml_restricted_at, status FROM users WHERE id = $1', [userId]);
  const p2p = await q.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM p2p_orders WHERE (buyer_id = $1 OR seller_id = $1) AND status IN ('PENDING_PAYMENT', 'PAID', 'APPEAL')`,
    [userId],
  );
  const m = await q.one<{ status: string }>('SELECT status FROM p2p_merchants WHERE user_id = $1', [userId]);
  const merchantActive = !!m && ['PENDING', 'ACTIVE', 'SUSPENDED'].includes(m.status);
  return [
    { key: 'p2p', label: 'Không còn đơn P2P đang xử lý', ok: p2p!.n === 0, detail: p2p!.n ? `${p2p!.n} đơn đang xử lý` : 'Không có' },
    { key: 'merchant', label: 'Không còn là thương nhân P2P (đã nghỉ, đã trả cọc)', ok: !merchantActive, detail: merchantActive ? 'Còn tư cách thương nhân' : 'Không' },
    {
      key: 'hold',
      label: 'Không có nghĩa vụ giữ tài khoản',
      ok: !u?.aml_restricted_at,
      detail: u?.aml_restricted_at ? 'Đang có nghĩa vụ giữ tài khoản — chuyển bộ phận Tuân thủ' : 'Không',
    },
  ];
}

export class PrivacyService {
  private exports = new Map<string, { day: string; n: number }>();

  constructor(private db: Database) {}

  private async customer(userId: string) {
    const u = await this.db.one<{ role: string; status: string }>('SELECT role, status FROM users WHERE id = $1', [userId]);
    if (!u) throw notFound('Không tìm thấy tài khoản');
    if (u.role !== 'USER') throw forbidden('Tài khoản nhân viên xử lý dữ liệu qua Quản trị hệ thống');
    return u;
  }

  async myRequests(userId: string): Promise<PrivacyRequestDTO[]> {
    const rows = await this.db.many<RequestRow>('SELECT * FROM privacy_requests WHERE user_id = $1 ORDER BY id DESC LIMIT 20', [userId]);
    return rows.map((r) => toPrivacyDTO(r));
  }

  async requestDelete(userId: string, reason: string): Promise<PrivacyRequestDTO> {
    await this.customer(userId);
    const pending = await this.db.one(`SELECT 1 FROM privacy_requests WHERE user_id = $1 AND status = 'PENDING'`, [userId]);
    if (pending) throw badRequest('PENDING', 'Bạn đã có yêu cầu xoá đang chờ xử lý');
    const r = await this.db.one<RequestRow>(`INSERT INTO privacy_requests (user_id, reason) VALUES ($1, $2) RETURNING *`, [userId, reason]);
    return toPrivacyDTO(r!);
  }

  async cancel(userId: string, id: number): Promise<void> {
    const r = await this.db.one(
      `UPDATE privacy_requests SET status = 'CANCELLED', decided_at = now(), decided_by = 'Khách rút yêu cầu' WHERE id = $1 AND user_id = $2 AND status = 'PENDING' RETURNING id`,
      [id, userId],
    );
    if (!r) throw notFound('Không có yêu cầu đang chờ để rút');
  }

  /**
   * Toàn bộ dữ liệu cá nhân của chính khách (quyền truy cập dữ liệu). Hồ sơ KYC được giải mã nhưng số giấy tờ chỉ 4 số cuối
   * (đề phòng file bị lộ). Giới hạn PRIVACY_EXPORTS_PER_DAY lần / ngày UTC.
   */
  async exportData(userId: string): Promise<Record<string, unknown>> {
    await this.customer(userId);
    const day = new Date().toISOString().slice(0, 10);
    const cnt = this.exports.get(userId);
    const n = cnt?.day === day ? cnt.n : 0;
    if (n >= PRIVACY_EXPORTS_PER_DAY) throw new AppError(429, 'TOO_MANY', `Mỗi ngày tải tối đa ${PRIVACY_EXPORTS_PER_DAY} lần`);
    this.exports.set(userId, { day, n: n + 1 });
    if (this.exports.size > 50_000) this.exports.clear();

    const q = this.db;
    const profile = await q.one(
      `SELECT id, email, full_name, display_name, created_at, last_seen_at, email_verified_at, totp_enabled_at IS NOT NULL AS two_factor_enabled,
              notify_fills, show_on_leaderboard, kyc_level, kyc_name, vip_level
       FROM users WHERE id = $1`,
      [userId],
    );
    const kycRows = await q.many<{ id: string | number; level: number; status: string; data_enc: string; reject_reason: string | null; created_at: Date; reviewed_at: Date | null }>(
      'SELECT id, level, status, data_enc, reject_reason, created_at, reviewed_at FROM kyc_applications WHERE user_id = $1 ORDER BY id',
      [userId],
    );
    const kyc = kycRows.map((k) => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(openSecret(k.data_enc)) as Record<string, unknown>;
      } catch {
        data = { error: 'Không giải mã được' };
      }
      if (typeof data.idNumber === 'string') data.idNumber = `•••••${data.idNumber.slice(-4)}`;
      return { id: Number(k.id), level: k.level, status: k.status, rejectReason: k.reject_reason, createdAt: iso(k.created_at), reviewedAt: iso(k.reviewed_at), data };
    });
    const tickets = await q.many<{ id: string | number }>('SELECT id, subject, category, status, created_at, resolved_at FROM support_tickets WHERE user_id = $1 ORDER BY id', [userId]);
    const messages = await q.many(
      `SELECT m.ticket_id, m.author_kind, m.body, m.created_at FROM support_messages m JOIN support_tickets t ON t.id = m.ticket_id
       WHERE t.user_id = $1 AND NOT m.internal ORDER BY m.id`,
      [userId],
    );
    return {
      exportedAt: new Date().toISOString(),
      note: 'Dữ liệu cá nhân của bạn tại VNCoin (sàn mô phỏng). Số giấy tờ chỉ hiện 4 số cuối.',
      profile,
      kyc,
      balances: await q.many('SELECT asset, free, locked, cost_usdt, updated_at FROM balances WHERE user_id = $1 ORDER BY asset', [userId]),
      orders: await q.many('SELECT * FROM orders WHERE user_id = $1 ORDER BY id', [userId]),
      fills: await q.many('SELECT * FROM fills WHERE user_id = $1 ORDER BY id', [userId]),
      ledger: await q.many('SELECT asset, type, amount, balance_after, note, created_at FROM ledger WHERE user_id = $1 ORDER BY id', [userId]),
      p2pOrders: await q.many('SELECT * FROM p2p_orders WHERE buyer_id = $1 OR seller_id = $1 ORDER BY id', [userId]),
      p2pPaymentMethods: await q.many('SELECT bank_name, account_no, holder_name, created_at, deleted_at FROM p2p_payment_methods WHERE user_id = $1', [userId]),
      bankAccount: await q.one('SELECT account_no, holder_name, balance_vnd, created_at FROM bank_accounts WHERE user_id = $1', [userId]),
      bankStatement: await statementOf(q, userId, 10_000),
      watchlists: await q.many('SELECT l.name, w.symbol FROM watchlist_lists l LEFT JOIN watchlists w ON w.list_id = l.id WHERE l.user_id = $1', [userId]),
      priceAlerts: await q.many('SELECT * FROM price_alerts WHERE user_id = $1 ORDER BY id', [userId]),
      supportTickets: tickets,
      supportMessages: messages,
      loginHistory: await q.many('SELECT event, ip, user_agent, created_at FROM auth_events WHERE user_id = $1 ORDER BY id DESC LIMIT 1000', [userId]),
      privacyRequests: await this.myRequests(userId),
    };
  }
}
