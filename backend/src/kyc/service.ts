import {
  Big,
  P2P_RULES,
  fmtVnd,
  type KycApplicationDTO,
  type KycApplicationStatus,
  type KycFlag,
  type KycLevel,
  type KycLevel1Input,
  type KycLevel2Input,
  type MyKycDTO,
} from '@vss/shared';
import { audit, type AdminCtx } from '../admin/common';
import type { Database, Queryable } from '../db';
import { kycResultEmail } from '../lib/emails';
import { AppError, badRequest, notFound } from '../lib/errors';
import type { Mailer } from '../lib/mailer';
import { hashIdentifier, openSecret, sealSecret } from '../lib/secretBox';
import { holderNameOf } from '../p2p/bank';
import { sendLater } from '../routes/auth';
import { raiseAlert } from './aml';

/*
 * Xác minh danh tính (KYC) theo cấp. Hồ sơ là khai báo giả lập, lưu mã hoá (sealSecret);
 * số giấy tờ chỉ giữ mã băm HMAC (dò trùng giữa các tài khoản) + 4 số cuối.
 * Duyệt cấp 1 → users.kyc_name = họ tên theo giấy tờ; tên chủ tài khoản ngân hàng giả lập và phương thức thanh toán P2P
 * đổi theo (chính chủ). Mỗi lần nhân viên xem hồ sơ đầy đủ ghi KYC_VIEW.
 */

const forbidden = (msg: string) => new AppError(403, 'FORBIDDEN', msg);
const startOfUtcDay = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** Hạn mức P2P / ngày UTC theo cấp KYC (VNĐ); cấp 0 không được dùng P2P */
export function p2pDailyLimit(level: number): string {
  return level >= 2 ? String(P2P_RULES.kycLevel2DailyVnd) : level >= 1 ? String(P2P_RULES.kycLevel1DailyVnd) : '0';
}

/** Tổng tiền các đơn P2P chưa huỷ (người này là một bên) trong ngày UTC */
export async function p2pUsedToday(q: Queryable, userId: string): Promise<string> {
  const r = await q.one<{ s: string }>(
    `SELECT COALESCE(sum(fiat_amount), 0)::text AS s FROM p2p_orders
     WHERE (buyer_id = $1 OR seller_id = $1) AND status <> 'CANCELLED' AND created_at >= $2`,
    [userId, startOfUtcDay()],
  );
  return new Big(r?.s ?? 0).toFixed();
}

/**
 * Kiểm tra 1 đơn P2P mới có làm vượt hạn mức ngày theo KYC của người này không (gọi cho cả 2 bên).
 * `self` = người đang đặt đơn (thông báo lỗi nói với họ), còn lại là đối tác.
 */
export async function assertP2PLimit(q: Queryable, userId: string, level: number, fiat: string, self: boolean): Promise<void> {
  const limit = p2pDailyLimit(level);
  const used = await p2pUsedToday(q, userId);
  if (new Big(used).plus(fiat).gt(limit)) {
    if (!self) throw badRequest('COUNTERPARTY_LIMIT', 'Thương nhân đã hết hạn mức P2P hôm nay, hãy chọn quảng cáo khác');
    const left = new Big(limit).minus(used);
    throw badRequest(
      'KYC_LIMIT',
      `Vượt hạn mức P2P hôm nay theo cấp xác minh (${fmtVnd(limit)} / ngày, còn ${fmtVnd(left.lt(0) ? 0 : left.toFixed())}). ${level < 2 ? 'Xác minh nâng cao để tăng hạn mức.' : ''}`.trim(),
    );
  }
}

interface AppRow {
  id: string | number;
  user_id: string;
  level: 1 | 2;
  status: KycApplicationStatus;
  data_enc: string;
  id_hash: string | null;
  id_last4: string | null;
  flags: KycFlag[];
  reject_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  email?: string;
  full_name?: string;
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export class KycService {
  /** Báo cho khách (realtime) khi hồ sơ được duyệt / từ chối */
  notify: (userId: string) => void = () => undefined;

  constructor(
    private db: Database,
    private mailer?: Mailer,
  ) {}

  private async user(q: Queryable, userId: string) {
    const u = await q.one<{ id: string; role: string; status: string; kyc_level: number; kyc_name: string | null; aml_restricted_at: Date | null; email: string; full_name: string }>(
      'SELECT id, role, status, kyc_level, kyc_name, aml_restricted_at, email, full_name FROM users WHERE id = $1',
      [userId],
    );
    if (!u) throw notFound('Không tìm thấy tài khoản');
    return u;
  }

  async status(userId: string): Promise<MyKycDTO> {
    const u = await this.user(this.db, userId);
    const apps = await this.db.many<AppRow>(
      `SELECT DISTINCT ON (level) * FROM kyc_applications WHERE user_id = $1 ORDER BY level, id DESC`,
      [userId],
    );
    return {
      level: Number(u.kyc_level) as KycLevel,
      name: u.kyc_name,
      restricted: !!u.aml_restricted_at,
      applications: apps.map((a) => ({
        id: Number(a.id),
        level: Number(a.level) as 1 | 2,
        status: a.status,
        rejectReason: a.reject_reason,
        createdAt: iso(a.created_at)!,
        reviewedAt: iso(a.reviewed_at),
      })),
      p2pDailyLimit: p2pDailyLimit(Number(u.kyc_level)),
      p2pUsedToday: await p2pUsedToday(this.db, userId),
    };
  }

  /** Nộp hồ sơ cấp 1 (danh tính) hoặc cấp 2 (nâng cao) */
  async submit(userId: string, level: 1 | 2, input: KycLevel1Input | KycLevel2Input): Promise<MyKycDTO> {
    await this.db.tx(async (tx) => {
      const u = await this.user(tx, userId);
      if (u.role !== 'USER') throw forbidden('Tài khoản nhân viên không cần xác minh KYC khách hàng');
      if (u.status !== 'ACTIVE') throw forbidden('Tài khoản đang bị khoá');
      const cur = Number(u.kyc_level);
      if (cur >= level) throw badRequest('ALREADY', `Bạn đã đạt cấp ${cur}`);
      if (level === 2 && cur < 1) throw badRequest('NEED_LEVEL1', 'Hoàn tất xác minh danh tính (cấp 1) trước');
      const pending = await tx.one(`SELECT 1 FROM kyc_applications WHERE user_id = $1 AND level = $2 AND status = 'PENDING'`, [userId, level]);
      if (pending) throw badRequest('PENDING', 'Hồ sơ đang chờ duyệt');

      const flags: KycFlag[] = [];
      let idHash: string | null = null;
      let last4: string | null = null;
      if (level === 1) {
        const d = input as KycLevel1Input;
        idHash = hashIdentifier(`${d.idType}:${d.idNumber}`);
        last4 = d.idNumber.slice(-4);
        // Cùng số giấy tờ ở tài khoản khác (đang chờ hoặc đã duyệt) → nghi 1 người nhiều tài khoản
        const dup = await tx.many<{ user_id: string }>(
          `SELECT DISTINCT user_id FROM kyc_applications WHERE id_hash = $1 AND user_id <> $2 AND status <> 'REJECTED'`,
          [idHash, userId],
        );
        if (dup.length) {
          flags.push('DUPLICATE_ID');
          await raiseAlert(tx, userId, 'DUPLICATE_ID', { otherUserIds: dup.map((x) => x.user_id), idLast4: last4 });
        }
        if (d.isPep) {
          flags.push('PEP');
          await raiseAlert(tx, userId, 'PEP', { declared: true });
        }
      }
      await tx.many(
        `INSERT INTO kyc_applications (user_id, level, data_enc, id_hash, id_last4, flags) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [userId, level, sealSecret(JSON.stringify(input)), idHash, last4, JSON.stringify(flags)],
      );
    });
    return this.status(userId);
  }

  private toDTO(a: AppRow, data?: Record<string, unknown>): KycApplicationDTO {
    return {
      id: Number(a.id),
      userId: a.user_id,
      email: a.email ?? '',
      accountName: a.full_name ?? '',
      level: Number(a.level) as 1 | 2,
      status: a.status,
      idLast4: a.id_last4,
      flags: a.flags ?? [],
      rejectReason: a.reject_reason,
      reviewedBy: a.reviewed_by,
      reviewedAt: iso(a.reviewed_at),
      createdAt: iso(a.created_at)!,
      ...(data && { data: data as KycApplicationDTO['data'] }),
    };
  }

  async list(status: KycApplicationStatus | 'ALL'): Promise<KycApplicationDTO[]> {
    const rows = await this.db.many<AppRow>(
      `SELECT a.*, u.email, u.full_name FROM kyc_applications a JOIN users u ON u.id = a.user_id
       WHERE ($1 = 'ALL' OR a.status = $1) ORDER BY (a.status = 'PENDING') DESC, a.created_at ${status === 'PENDING' ? 'ASC' : 'DESC'} LIMIT 300`,
      [status],
    );
    return rows.map((r) => this.toDTO(r));
  }

  /** Xem hồ sơ đầy đủ (giải mã) — ghi KYC_VIEW vào nhật ký quản trị mỗi lần xem */
  async detail(staff: AdminCtx, id: number): Promise<KycApplicationDTO> {
    const a = await this.db.one<AppRow>(`SELECT a.*, u.email, u.full_name FROM kyc_applications a JOIN users u ON u.id = a.user_id WHERE a.id = $1`, [id]);
    if (!a) throw notFound('Không tìm thấy hồ sơ');
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(openSecret(a.data_enc)) as Record<string, unknown>;
    } catch {
      throw badRequest('DECRYPT', 'Không giải mã được hồ sơ (sai hoặc thiếu DATA_ENCRYPTION_KEY)');
    }
    // Số giấy tờ đầy đủ không hiện cho nhân viên: chỉ 4 số cuối (đủ để đối chiếu khi khách liên hệ)
    if (typeof data.idNumber === 'string') data.idNumber = `•••••${data.idNumber.slice(-4)}`;
    await audit(this.db, staff, 'KYC_VIEW', 'user', a.user_id, { email: a.email, applicationId: id, level: Number(a.level) });
    return this.toDTO(a, data);
  }

  async review(staff: AdminCtx, id: number, approve: boolean, reason: string): Promise<KycApplicationDTO> {
    const out = await this.db.tx(async (tx) => {
      const a = await tx.one<AppRow>('SELECT * FROM kyc_applications WHERE id = $1 FOR UPDATE', [id]);
      if (!a) throw notFound('Không tìm thấy hồ sơ');
      if (a.status !== 'PENDING') throw badRequest('NOT_PENDING', 'Hồ sơ đã được xử lý');
      if (a.user_id === staff.id) throw forbidden('Không được tự duyệt hồ sơ của chính mình');
      const u = await this.user(tx, a.user_id);
      const level = Number(a.level) as 1 | 2;
      if (approve) {
        if (level === 2 && Number(u.kyc_level) < 1) throw badRequest('NEED_LEVEL1', 'Khách chưa đạt cấp 1');
        if (level === 1) {
          const d = JSON.parse(openSecret(a.data_enc)) as KycLevel1Input;
          const holder = holderNameOf(d.fullName);
          await tx.many('UPDATE users SET kyc_level = GREATEST(kyc_level, 1), kyc_name = $2 WHERE id = $1', [a.user_id, d.fullName]);
          // Chính chủ: tên tài khoản ngân hàng giả lập + mọi phương thức thanh toán P2P theo họ tên KYC
          await tx.many('UPDATE bank_accounts SET holder_name = $2, updated_at = now() WHERE user_id = $1', [a.user_id, holder]);
          await tx.many('UPDATE p2p_payment_methods SET holder_name = $2 WHERE user_id = $1 AND deleted_at IS NULL', [a.user_id, holder]);
        } else {
          await tx.many('UPDATE users SET kyc_level = 2 WHERE id = $1', [a.user_id]);
        }
      }
      const row = await tx.one<AppRow>(
        `UPDATE kyc_applications SET status = $2, reject_reason = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1 RETURNING *`,
        [id, approve ? 'APPROVED' : 'REJECTED', approve ? null : reason, staff.email],
      );
      await audit(tx, staff, approve ? 'KYC_APPROVE' : 'KYC_REJECT', 'user', a.user_id, { email: u.email, applicationId: id, level, reason: reason || null });
      return { row: { ...row!, email: u.email, full_name: u.full_name }, user: u, level };
    });
    if (this.mailer) sendLater(this.mailer, out.user.email, kycResultEmail(out.user.full_name, out.level, approve, reason || undefined), { userId: out.user.id });
    this.notify(out.user.id);
    return this.toDTO(out.row);
  }
}
