import {
  Big,
  P2P_ASSETS,
  P2P_RULES,
  adPrice,
  effectiveLimits,
  fiatForQty,
  fmtVnd,
  isP2POrderOpen,
  priceInBand,
  qtyForFiat,
  refPriceVnd,
  roundDp,
  roundP2PQty,
  validateP2POrderAmount,
  type AppealReason,
  type CreateAdInput,
  type Dec,
  type MerchantRequirement,
  type MerchantStats,
  type MerchantStatus,
  type MyMerchantDTO,
  type P2PAdDTO,
  type P2PAdSide,
  type P2PAsset,
  type P2PCancelBy,
  type P2PMessageDTO,
  type P2POrderDTO,
  type P2POrderStatus,
  type P2PPriceType,
  type P2PTraderDTO,
  type PaymentMethodDTO,
  type PlaceP2POrderInput,
  type UpdateAdInput,
} from '@vss/shared';
import type { Database, Queryable } from '../db';
import { AppError, badRequest, notFound } from '../lib/errors';
import { log } from '../lib/logger';
import { publicName } from '../portfolio/nav';
import { balanceOf, credit, debitFree, debitLocked, ledger, lockFunds, unlockFunds } from '../trading/wallet';
import { assertP2PLimit } from '../kyc/service';
import { bankAccountOf, holderNameOf } from './bank';

/*
 * Chợ P2P (theo Binance P2P): thương nhân đăng quảng cáo, khách đặt đơn, coin của bên bán nằm trong ký quỹ,
 * tiền VNĐ đi qua ngân hàng giả lập ngoài sàn, bên bán xác nhận đã nhận tiền thì nhả coin.
 *
 * Khoá số dư (balances.locked) do P2P gồm:
 *   - tiền cọc thương nhân (USDT)                               → p2p_merchants.deposit_usdt
 *   - phần chưa bán của quảng cáo bán (kèm phí)                 → p2p_ads.locked_amount
 *   - coin của bên bán trong đơn đang chạy (kèm phí nếu là thương nhân) → p2p_orders.escrow_amount
 * Đối soát (admin/reconcile.ts) cộng cả 3 nguồn này với lệnh Spot; thêm chỗ khoá mới phải cập nhật ở đó.
 */

const forbidden = (msg: string) => new AppError(403, 'FORBIDDEN', msg);
const FEE_DP = 8;

export interface P2PMarket {
  priceUsdt(asset: string): Dec | null;
}

export interface P2PNotifier {
  /** Đơn / quảng cáo / trạng thái thương nhân của người này thay đổi */
  user(userId: string, payload: { orderId?: number; kind: string }): void;
  /** Có khiếu nại mới / khiếu nại thay đổi (khu CSKH) */
  staff(payload: { orderId: number; kind: string }): void;
  /** Số dư ví thay đổi */
  account(userId: string): void;
}

export interface StaffActor {
  id: string;
  email: string;
}

interface AdRow {
  id: string | number;
  merchant_id: string;
  side: P2PAdSide;
  asset: P2PAsset;
  price_type: P2PPriceType;
  fixed_price: string | null;
  float_ratio: string | null;
  total_qty: string;
  available_qty: string;
  locked_amount: string;
  min_fiat: string;
  max_fiat: string;
  pay_minutes: number;
  payment_method_ids: (string | number)[];
  terms: string;
  min_account_days: number;
  maker_fee: string;
  status: 'ONLINE' | 'OFFLINE' | 'CLOSED';
  created_at: Date;
}

export interface P2POrderRow {
  id: string | number;
  ad_id: string | number;
  maker_id: string;
  taker_id: string;
  buyer_id: string;
  seller_id: string;
  asset: P2PAsset;
  price: string;
  qty: string;
  fiat_amount: string;
  fee: string;
  escrow_amount: string;
  status: P2POrderStatus;
  pay_minutes: number;
  pay_deadline: Date;
  paid_at: Date | null;
  released_at: Date | null;
  cancelled_at: Date | null;
  cancelled_by: P2PCancelBy | null;
  cancel_reason: string | null;
  pay_bank_name: string;
  pay_account_no: string;
  pay_holder_name: string;
  terms: string;
  appeal_by: 'BUYER' | 'SELLER' | null;
  appeal_reason: AppealReason | null;
  appeal_desc: string | null;
  appeal_at: Date | null;
  resolution: 'RELEASED' | 'RETURNED' | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution_note: string | null;
  created_at: Date;
  updated_at: Date;
}

interface MerchantRow {
  user_id: string;
  status: MerchantStatus;
  deposit_usdt: string;
  applied_at: Date;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  note: string | null;
}

interface UserGate {
  id: string;
  role: string;
  status: string;
  created_at: Date;
  email_verified_at: Date | null;
  totp_enabled_at: Date | null;
  full_name: string;
  display_name: string | null;
  kyc_level: number;
  kyc_name: string | null;
  aml_restricted_at: Date | null;
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const idNum = (v: string | number) => Number(v);
const startOfUtcDay = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export const EMPTY_STATS: MerchantStats = { orders30d: 0, completionRate30d: null, avgReleaseSec: null, avgPaySec: null, totalCompleted: 0 };

/** Thống kê giao dịch P2P (30 ngày) của nhiều người cùng lúc */
export async function statsFor(q: Queryable, userIds: string[]): Promise<Map<string, MerchantStats>> {
  const out = new Map<string, MerchantStats>();
  if (!userIds.length) return out;
  const rows = await q.many<{
    uid: string;
    done30: number;
    fault30: number;
    total_done: number;
    release_sec: string | null;
    pay_sec: string | null;
  }>(
    `WITH parts AS (
       SELECT o.*, x.uid FROM p2p_orders o
       CROSS JOIN LATERAL (VALUES (o.buyer_id), (o.seller_id)) AS x(uid)
       WHERE x.uid = ANY($1::uuid[])
     )
     SELECT uid::text AS uid,
            count(*) FILTER (WHERE status = 'COMPLETED' AND released_at > now() - interval '30 days')::int AS done30,
            -- Lỗi thuộc về người mua: tự huỷ, để hết hạn, hoặc bị trả coin về bên bán khi khiếu nại
            count(*) FILTER (WHERE status = 'CANCELLED' AND uid = buyer_id AND cancelled_at > now() - interval '30 days')::int AS fault30,
            count(*) FILTER (WHERE status = 'COMPLETED')::int AS total_done,
            avg(extract(epoch FROM released_at - paid_at)) FILTER (WHERE status = 'COMPLETED' AND uid = seller_id AND paid_at IS NOT NULL)::text AS release_sec,
            avg(extract(epoch FROM paid_at - created_at)) FILTER (WHERE uid = buyer_id AND paid_at IS NOT NULL)::text AS pay_sec
     FROM parts GROUP BY uid`,
    [userIds],
  );
  for (const r of rows) {
    const denom = r.done30 + r.fault30;
    out.set(r.uid, {
      orders30d: r.done30,
      completionRate30d: denom > 0 ? r.done30 / denom : null,
      avgReleaseSec: r.release_sec == null ? null : Math.round(Number(r.release_sec)),
      avgPaySec: r.pay_sec == null ? null : Math.round(Number(r.pay_sec)),
      totalCompleted: r.total_done,
    });
  }
  return out;
}

export class P2PService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: Database,
    private market: P2PMarket,
    public notify: P2PNotifier = { user: () => undefined, staff: () => undefined, account: () => undefined },
  ) {}

  /** Huỷ đơn quá hạn thanh toán mỗi 15 giây */
  start(intervalMs = 15_000) {
    this.stop();
    this.timer = setInterval(() => {
      this.expireDue().catch((err) => log.error('[p2p] lỗi huỷ đơn quá hạn', { err }));
    }, intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* ================================ tiện ích ================================ */

  refPrice(asset: string): Dec | null {
    return refPriceVnd(asset, asset === 'USDT' ? null : this.market.priceUsdt(asset));
  }

  refPrices(): Record<string, Dec | null> {
    return Object.fromEntries(P2P_ASSETS.map((a) => [a, this.refPrice(a)]));
  }

  private priceOf(ad: Pick<AdRow, 'price_type' | 'fixed_price' | 'float_ratio' | 'asset'>): Dec | null {
    return adPrice({ priceType: ad.price_type, fixedPrice: ad.fixed_price, floatRatio: ad.float_ratio }, this.refPrice(ad.asset));
  }

  /** Kiểm tra người dùng được thao tác P2P. view = chỉ xem (tài khoản bị Tuân thủ hạn chế vẫn xem được) */
  private async gate(q: Queryable, userId: string, view = false): Promise<UserGate> {
    const u = await q.one<UserGate>(
      `SELECT id, role, status, created_at, email_verified_at, totp_enabled_at, full_name, display_name, kyc_level, kyc_name, aml_restricted_at
       FROM users WHERE id = $1`,
      [userId],
    );
    if (!u) throw notFound('Không tìm thấy tài khoản');
    if (u.role !== 'USER') throw forbidden('Tài khoản nhân viên không được giao dịch P2P (tránh xung đột lợi ích khi xử lý khiếu nại)');
    if (u.status !== 'ACTIVE') throw forbidden('Tài khoản đang bị khoá');
    // Không nói lý do (nguyên tắc không tiết lộ của AML)
    if (!view && u.aml_restricted_at) throw forbidden('Tài khoản đang bị hạn chế giao dịch. Vui lòng liên hệ CSKH.');
    return u;
  }

  private async merchantOf(q: Queryable, userId: string, forUpdate = false): Promise<MerchantRow | undefined> {
    return q.one<MerchantRow>(`SELECT * FROM p2p_merchants WHERE user_id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [userId]);
  }

  private async requireActiveMerchant(q: Queryable, userId: string, forUpdate = false): Promise<MerchantRow> {
    const m = await this.merchantOf(q, userId, forUpdate);
    if (!m || m.status !== 'ACTIVE') {
      throw forbidden(m?.status === 'SUSPENDED' ? 'Tư cách thương nhân đang bị tạm ngừng' : 'Chỉ thương nhân đã được duyệt mới được đăng quảng cáo');
    }
    return m;
  }

  /** Số lần huỷ / để hết hạn khi là khách mua trong ngày UTC */
  private async cancelsToday(q: Queryable, userId: string): Promise<number> {
    const r = await q.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM p2p_orders
       WHERE taker_id = $1 AND buyer_id = $1 AND status = 'CANCELLED' AND cancelled_by IN ('BUYER', 'SYSTEM') AND cancelled_at >= $2`,
      [userId, startOfUtcDay()],
    );
    return r?.n ?? 0;
  }

  private blockedUntil(cancels: number): Date | null {
    if (cancels < P2P_RULES.takerCancelLimit) return null;
    return new Date(startOfUtcDay().getTime() + 86_400_000);
  }

  private async message(q: Queryable, orderId: number, body: string, senderId: string | null = null, staffEmail: string | null = null) {
    await q.many('INSERT INTO p2p_messages (order_id, sender_id, staff_email, body) VALUES ($1, $2, $3, $4)', [orderId, senderId, staffEmail, body]);
  }

  private async traders(q: Queryable, ids: string[]): Promise<Map<string, P2PTraderDTO>> {
    const uniq = [...new Set(ids)];
    const out = new Map<string, P2PTraderDTO>();
    if (!uniq.length) return out;
    const rows = await q.many<{ id: string; full_name: string; display_name: string | null; mstatus: MerchantStatus | null }>(
      `SELECT u.id, u.full_name, u.display_name, m.status AS mstatus FROM users u LEFT JOIN p2p_merchants m ON m.user_id = u.id WHERE u.id = ANY($1::uuid[])`,
      [uniq],
    );
    const stats = await statsFor(q, uniq);
    for (const r of rows) {
      out.set(r.id, { userId: r.id, name: publicName(r.full_name, r.display_name), verified: r.mstatus === 'ACTIVE', ...(stats.get(r.id) ?? EMPTY_STATS) });
    }
    return out;
  }

  /* ================================ thương nhân ================================ */

  async requirements(userId: string): Promise<{ list: MerchantRequirement[]; eligible: boolean; stats: MerchantStats }> {
    const u = await this.gate(this.db, userId, true);
    const stats = (await statsFor(this.db, [userId])).get(userId) ?? EMPTY_STATS;
    const usdt = await balanceOf(this.db, userId, 'USDT');
    const ageDays = (Date.now() - new Date(u.created_at).getTime()) / 86_400_000;
    const R = P2P_RULES;
    const rate = stats.completionRate30d;
    const list: MerchantRequirement[] = [
      {
        key: 'kyc',
        label: `Xác minh danh tính cấp ${R.merchantMinKyc}`,
        ok: Number(u.kyc_level) >= R.merchantMinKyc,
        detail: `Hiện tại: cấp ${Number(u.kyc_level)}`,
      },
      { key: 'email', label: 'Đã xác thực email', ok: !R.requireEmailVerified || !!u.email_verified_at, detail: u.email_verified_at ? 'Đã xác thực' : 'Chưa xác thực' },
      { key: '2fa', label: 'Đã bật xác thực 2 lớp', ok: !R.require2fa || !!u.totp_enabled_at, detail: u.totp_enabled_at ? 'Đã bật' : 'Chưa bật' },
      {
        key: 'age',
        label: `Tài khoản mở từ ${R.minAccountDays} ngày trở lên`,
        ok: ageDays >= R.minAccountDays,
        detail: `${Math.floor(ageDays)} ngày`,
      },
      {
        key: 'orders',
        label: `Hoàn tất ít nhất ${R.minCompletedOrders} đơn P2P`,
        ok: stats.totalCompleted >= R.minCompletedOrders,
        detail: `${stats.totalCompleted} đơn`,
      },
      {
        key: 'rate',
        label: `Tỷ lệ hoàn tất 30 ngày từ ${Math.round(R.minCompletionRate * 100)}%`,
        ok: rate == null ? R.minCompletedOrders === 0 : rate >= R.minCompletionRate,
        detail: rate == null ? 'Chưa có đơn' : `${(rate * 100).toFixed(1)}%`,
      },
      {
        key: 'deposit',
        label: `Đủ ${Number(R.merchantDepositUsdt).toLocaleString('vi-VN')} USDT khả dụng để đặt cọc`,
        ok: new Big(usdt.free).gte(R.merchantDepositUsdt),
        detail: `Khả dụng ${new Big(usdt.free).round(2, Big.roundDown).toFixed()} USDT`,
      },
    ];
    return { list, eligible: list.every((x) => x.ok), stats };
  }

  async myMerchant(userId: string): Promise<MyMerchantDTO> {
    const m = await this.merchantOf(this.db, userId);
    const req = await this.requirements(userId);
    const cancels = await this.cancelsToday(this.db, userId);
    return {
      status: m?.status ?? null,
      depositUsdt: m ? new Big(m.deposit_usdt).toFixed() : '0',
      appliedAt: iso(m?.applied_at),
      reviewedAt: iso(m?.reviewed_at),
      note: m?.note ?? null,
      stats: req.stats,
      requirements: req.list,
      eligible: req.eligible,
      blockedUntil: iso(this.blockedUntil(cancels)),
      cancelsToday: cancels,
    };
  }

  /** Nộp đơn làm thương nhân: đủ điều kiện thì khoá tiền cọc ngay, chờ nhân viên Rủi ro duyệt */
  async apply(userId: string): Promise<void> {
    const req = await this.requirements(userId);
    if (!req.eligible) {
      const miss = req.list.filter((x) => !x.ok).map((x) => x.label);
      throw badRequest('NOT_ELIGIBLE', `Chưa đủ điều kiện: ${miss.join('; ')}`);
    }
    await this.db.tx(async (tx) => {
      await this.gate(tx, userId);
      const m = await this.merchantOf(tx, userId, true);
      if (m && (m.status === 'PENDING' || m.status === 'ACTIVE' || m.status === 'SUSPENDED')) {
        throw badRequest('ALREADY', m.status === 'PENDING' ? 'Đơn của bạn đang chờ duyệt' : 'Bạn đã là thương nhân');
      }
      const deposit = P2P_RULES.merchantDepositUsdt;
      await lockFunds(tx, userId, 'USDT', deposit);
      await tx.many(
        `INSERT INTO p2p_merchants (user_id, status, deposit_usdt, applied_at) VALUES ($1, 'PENDING', $2, now())
         ON CONFLICT (user_id) DO UPDATE SET status = 'PENDING', deposit_usdt = $2, applied_at = now(), reviewed_at = NULL,
           reviewed_by = NULL, note = NULL, updated_at = now()`,
        [userId, deposit],
      );
    });
    this.notify.account(userId);
    this.notify.user(userId, { kind: 'merchant' });
  }

  /** Rút đơn đang chờ duyệt, hoặc nghỉ làm thương nhân (phải đóng hết quảng cáo, không còn đơn dở dang) → trả cọc */
  async resign(userId: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const m = await this.merchantOf(tx, userId, true);
      if (!m || !(m.status === 'PENDING' || m.status === 'ACTIVE')) throw badRequest('NOT_MERCHANT', 'Bạn không phải thương nhân đang hoạt động');
      const open = await tx.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM p2p_orders WHERE maker_id = $1 AND status IN ('PENDING_PAYMENT', 'PAID', 'APPEAL')`,
        [userId],
      );
      if (open!.n > 0) throw badRequest('OPEN_ORDERS', `Còn ${open!.n} đơn P2P đang xử lý — hoàn tất các đơn trước khi nghỉ`);
      await this.closeAllAdsTx(tx, userId);
      await unlockFunds(tx, userId, 'USDT', m.deposit_usdt);
      await tx.many(`UPDATE p2p_merchants SET status = 'RESIGNED', deposit_usdt = 0, updated_at = now() WHERE user_id = $1`, [userId]);
    });
    this.notify.account(userId);
    this.notify.user(userId, { kind: 'merchant' });
  }

  async approve(staff: StaffActor, userId: string, note: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const m = await this.merchantOf(tx, userId, true);
      if (!m || m.status !== 'PENDING') throw badRequest('NOT_PENDING', 'Đơn không ở trạng thái chờ duyệt');
      await tx.many(
        `UPDATE p2p_merchants SET status = 'ACTIVE', reviewed_at = now(), reviewed_by = $2, note = $3, updated_at = now() WHERE user_id = $1`,
        [userId, staff.email, note || null],
      );
    });
    this.notify.user(userId, { kind: 'merchant' });
  }

  async reject(staff: StaffActor, userId: string, note: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const m = await this.merchantOf(tx, userId, true);
      if (!m || m.status !== 'PENDING') throw badRequest('NOT_PENDING', 'Đơn không ở trạng thái chờ duyệt');
      await unlockFunds(tx, userId, 'USDT', m.deposit_usdt);
      await tx.many(
        `UPDATE p2p_merchants SET status = 'REJECTED', deposit_usdt = 0, reviewed_at = now(), reviewed_by = $2, note = $3, updated_at = now() WHERE user_id = $1`,
        [userId, staff.email, note || null],
      );
    });
    this.notify.account(userId);
    this.notify.user(userId, { kind: 'merchant' });
  }

  /** Tạm ngừng: quảng cáo chuyển offline (vẫn giữ coin đã khoá), đơn đang chạy vẫn xử lý tiếp */
  async suspend(staff: StaffActor, userId: string, reason: string): Promise<number> {
    const n = await this.db.tx(async (tx) => {
      const m = await this.merchantOf(tx, userId, true);
      if (!m || m.status !== 'ACTIVE') throw badRequest('NOT_ACTIVE', 'Thương nhân không ở trạng thái hoạt động');
      await tx.many(`UPDATE p2p_merchants SET status = 'SUSPENDED', note = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now() WHERE user_id = $1`, [
        userId,
        reason,
        staff.email,
      ]);
      const ads = await tx.many(`UPDATE p2p_ads SET status = 'OFFLINE', updated_at = now() WHERE merchant_id = $1 AND status = 'ONLINE' RETURNING id`, [userId]);
      return ads.length;
    });
    this.notify.user(userId, { kind: 'merchant' });
    return n;
  }

  async restore(staff: StaffActor, userId: string, note: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const m = await this.merchantOf(tx, userId, true);
      if (!m || m.status !== 'SUSPENDED') throw badRequest('NOT_SUSPENDED', 'Thương nhân không bị tạm ngừng');
      await tx.many(`UPDATE p2p_merchants SET status = 'ACTIVE', note = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now() WHERE user_id = $1`, [
        userId,
        note || null,
        staff.email,
      ]);
    });
    this.notify.user(userId, { kind: 'merchant' });
  }

  /** Trừ tiền cọc của thương nhân (vi phạm, bồi thường khiếu nại). Có người nhận thì cộng sang người đó */
  async deductDeposit(tx: Queryable, merchantId: string, amount: Dec, reason: string, compensateUserId: string | null, orderId: number | null): Promise<Dec> {
    const m = await this.merchantOf(tx, merchantId, true);
    if (!m) throw badRequest('NOT_MERCHANT', 'Người này không phải thương nhân');
    const amt = new Big(amount);
    if (amt.lte(0)) throw badRequest('AMOUNT', 'Số tiền phải lớn hơn 0');
    if (amt.gt(m.deposit_usdt)) throw badRequest('DEPOSIT', `Tiền cọc còn ${new Big(m.deposit_usdt).toFixed()} USDT, không đủ để trừ`);
    if (compensateUserId === merchantId) throw badRequest('SELF', 'Không thể bồi thường cho chính thương nhân bị trừ cọc');
    const { total } = await debitLocked(tx, merchantId, 'USDT', amt.toFixed());
    await ledger(tx, merchantId, 'USDT', 'P2P', amt.neg().toFixed(), total, null, `Trừ tiền cọc thương nhân: ${reason}`, orderId);
    await tx.many('UPDATE p2p_merchants SET deposit_usdt = deposit_usdt - $2, updated_at = now() WHERE user_id = $1', [merchantId, amt.toFixed()]);
    if (compensateUserId) {
      const after = await credit(tx, compensateUserId, 'USDT', amt.toFixed());
      await ledger(tx, compensateUserId, 'USDT', 'P2P', amt.toFixed(), after, null, `Bồi thường từ tiền cọc thương nhân: ${reason}`, orderId);
    }
    return new Big(m.deposit_usdt).minus(amt).toFixed();
  }

  /* ================================ phương thức thanh toán ================================ */

  async paymentMethods(userId: string): Promise<PaymentMethodDTO[]> {
    const rows = await this.db.many<{ id: string | number; bank_name: string; account_no: string; holder_name: string }>(
      'SELECT * FROM p2p_payment_methods WHERE user_id = $1 AND deleted_at IS NULL ORDER BY id',
      [userId],
    );
    return rows.map((r) => ({ id: idNum(r.id), bankName: r.bank_name, accountNo: r.account_no, holderName: r.holder_name }));
  }

  /** Tài khoản nhận tiền: tên chủ tài khoản luôn là họ tên KYC (chính chủ), không tự gõ */
  async addPaymentMethod(userId: string, input: { bankName: string }): Promise<PaymentMethodDTO> {
    const u = await this.gate(this.db, userId);
    if (Number(u.kyc_level) < 1) throw forbidden('Xác minh danh tính (KYC cấp 1) trước khi thêm tài khoản nhận tiền');
    const holder = holderNameOf(u.kyc_name ?? u.full_name);
    const count = await this.db.one<{ n: number }>('SELECT count(*)::int AS n FROM p2p_payment_methods WHERE user_id = $1 AND deleted_at IS NULL', [userId]);
    if (count!.n >= 10) throw badRequest('LIMIT', 'Tối đa 10 phương thức thanh toán');
    const bank = await bankAccountOf(this.db, userId);
    if (!bank) throw badRequest('NO_BANK', 'Bạn chưa có tài khoản ngân hàng giả lập');
    const r = await this.db.one<{ id: string | number }>(
      'INSERT INTO p2p_payment_methods (user_id, bank_name, account_no, holder_name) VALUES ($1, $2, $3, $4) RETURNING id',
      [userId, input.bankName, bank.account_no, holder],
    );
    return { id: idNum(r!.id), bankName: input.bankName, accountNo: bank.account_no, holderName: holder };
  }

  async removePaymentMethod(userId: string, id: number): Promise<void> {
    const used = await this.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM p2p_ads WHERE merchant_id = $1 AND status <> 'CLOSED' AND $2::bigint = ANY(payment_method_ids)`,
      [userId, id],
    );
    if (used!.n > 0) throw badRequest('IN_USE', 'Phương thức này đang dùng trong quảng cáo, hãy sửa quảng cáo trước');
    const r = await this.db.one('UPDATE p2p_payment_methods SET deleted_at = now() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id', [id, userId]);
    if (!r) throw notFound('Không tìm thấy phương thức thanh toán');
  }

  private async ownMethods(q: Queryable, userId: string, ids: number[]) {
    const rows = await q.many<{ id: string | number; bank_name: string; account_no: string; holder_name: string }>(
      'SELECT * FROM p2p_payment_methods WHERE user_id = $1 AND deleted_at IS NULL AND id = ANY($2::bigint[])',
      [userId, ids],
    );
    if (rows.length !== new Set(ids).size) throw badRequest('PAYMENT_METHOD', 'Phương thức thanh toán không hợp lệ');
    if (ids.length > P2P_RULES.maxPaymentMethods) throw badRequest('PAYMENT_METHOD', `Tối đa ${P2P_RULES.maxPaymentMethods} phương thức thanh toán`);
    return rows;
  }

  /* ================================ quảng cáo ================================ */

  private checkPricing(asset: string, priceType: P2PPriceType, fixedPrice: Dec | null, floatRatio: Dec | null): Dec {
    const ref = this.refPrice(asset);
    if (priceType === 'FLOATING') {
      if (!ref) throw badRequest('NO_REF', 'Chưa có giá tham chiếu cho coin này, hãy dùng giá cố định');
      const r = Number(floatRatio);
      if (!(r >= P2P_RULES.floatMinPct && r <= P2P_RULES.floatMaxPct)) {
        throw badRequest('FLOAT', `Tỷ lệ thả nổi từ ${P2P_RULES.floatMinPct}% đến ${P2P_RULES.floatMaxPct}%`);
      }
    }
    const price = adPrice({ priceType, fixedPrice, floatRatio }, ref);
    if (!price || new Big(price).lte(0)) throw badRequest('PRICE', 'Giá không hợp lệ');
    if (!priceInBand(price, ref)) {
      throw badRequest('PRICE_BAND', `Giá phải trong khoảng ±${P2P_RULES.priceBandPct}% giá tham chiếu (${fmtVnd(ref!)})`);
    }
    return price;
  }

  private checkLimits(minFiat: Dec, maxFiat: Dec) {
    if (new Big(minFiat).lt(P2P_RULES.minOrderVnd)) throw badRequest('LIMIT', `Hạn mức tối thiểu từ ${fmtVnd(P2P_RULES.minOrderVnd)}`);
    if (new Big(maxFiat).gt(P2P_RULES.maxOrderVnd)) throw badRequest('LIMIT', `Hạn mức tối đa không quá ${fmtVnd(P2P_RULES.maxOrderVnd)}`);
    if (new Big(maxFiat).lt(minFiat)) throw badRequest('LIMIT', 'Hạn mức tối đa phải ≥ tối thiểu');
  }

  async createAd(userId: string, input: CreateAdInput): Promise<P2PAdDTO> {
    const id = await this.db.tx(async (tx) => {
      await this.gate(tx, userId);
      await this.requireActiveMerchant(tx, userId, true);
      const open = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM p2p_ads WHERE merchant_id = $1 AND status <> 'CLOSED'`, [userId]);
      if (open!.n >= P2P_RULES.maxOpenAds) throw badRequest('AD_LIMIT', `Tối đa ${P2P_RULES.maxOpenAds} quảng cáo đang mở`);
      await this.ownMethods(tx, userId, input.paymentMethodIds);
      this.checkPricing(input.asset, input.priceType, input.fixedPrice ?? null, input.floatRatio ?? null);
      this.checkLimits(input.minFiat, input.maxFiat);
      const qty = roundP2PQty(input.totalQty, input.asset);
      if (new Big(qty).lte(0)) throw badRequest('QTY', 'Tổng số lượng quá nhỏ');
      const fee = P2P_RULES.makerFee;
      // Quảng cáo bán: khoá ngay số coin + phí (như Binance đóng băng số lượng quảng cáo)
      const lock = input.side === 'SELL' ? roundDp(new Big(qty).times(new Big(1).plus(fee)), FEE_DP, 'up') : '0';
      if (input.side === 'SELL') await lockFunds(tx, userId, input.asset, lock);
      const row = await tx.one<{ id: string | number }>(
        `INSERT INTO p2p_ads (merchant_id, side, asset, price_type, fixed_price, float_ratio, total_qty, available_qty, locked_amount,
                              min_fiat, max_fiat, pay_minutes, payment_method_ids, terms, min_account_days, maker_fee, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11, $12::bigint[], $13, $14, $15, $16) RETURNING id`,
        [
          userId,
          input.side,
          input.asset,
          input.priceType,
          input.priceType === 'FIXED' ? input.fixedPrice : null,
          input.priceType === 'FLOATING' ? input.floatRatio : null,
          qty,
          lock,
          input.minFiat,
          input.maxFiat,
          input.payMinutes,
          input.paymentMethodIds,
          input.terms,
          input.minAccountDays,
          fee,
          input.online ? 'ONLINE' : 'OFFLINE',
        ],
      );
      return idNum(row!.id);
    });
    this.notify.account(userId);
    return (await this.adById(id, userId))!;
  }

  async updateAd(userId: string, adId: number, input: UpdateAdInput): Promise<P2PAdDTO> {
    await this.db.tx(async (tx) => {
      await this.gate(tx, userId);
      const ad = await tx.one<AdRow>('SELECT * FROM p2p_ads WHERE id = $1 AND merchant_id = $2 FOR UPDATE', [adId, userId]);
      if (!ad) throw notFound('Không tìm thấy quảng cáo');
      if (ad.status === 'CLOSED') throw badRequest('CLOSED', 'Quảng cáo đã đóng');
      const priceType = input.priceType ?? ad.price_type;
      const fixed = input.fixedPrice !== undefined ? input.fixedPrice : ad.fixed_price;
      const ratio = input.floatRatio !== undefined ? input.floatRatio : ad.float_ratio;
      if (priceType === 'FIXED' && !fixed) throw badRequest('PRICE', 'Nhập giá cố định');
      if (priceType === 'FLOATING' && !ratio) throw badRequest('PRICE', 'Nhập tỷ lệ thả nổi');
      this.checkPricing(ad.asset, priceType, fixed ?? null, ratio ?? null);
      const minFiat = input.minFiat ?? ad.min_fiat;
      const maxFiat = input.maxFiat ?? ad.max_fiat;
      this.checkLimits(minFiat, maxFiat);
      const methods = input.paymentMethodIds ?? ad.payment_method_ids.map(Number);
      if (input.paymentMethodIds) await this.ownMethods(tx, userId, input.paymentMethodIds);
      await tx.many(
        `UPDATE p2p_ads SET price_type = $2, fixed_price = $3, float_ratio = $4, min_fiat = $5, max_fiat = $6, pay_minutes = $7,
                payment_method_ids = $8::bigint[], terms = $9, min_account_days = $10, updated_at = now() WHERE id = $1`,
        [
          adId,
          priceType,
          priceType === 'FIXED' ? fixed : null,
          priceType === 'FLOATING' ? ratio : null,
          minFiat,
          maxFiat,
          input.payMinutes ?? ad.pay_minutes,
          methods,
          input.terms ?? ad.terms,
          input.minAccountDays ?? ad.min_account_days,
        ],
      );
    });
    return (await this.adById(adId, userId))!;
  }

  async setAdOnline(userId: string, adId: number, online: boolean): Promise<P2PAdDTO> {
    await this.db.tx(async (tx) => {
      await this.gate(tx, userId);
      const ad = await tx.one<AdRow>('SELECT * FROM p2p_ads WHERE id = $1 AND merchant_id = $2 FOR UPDATE', [adId, userId]);
      if (!ad) throw notFound('Không tìm thấy quảng cáo');
      if (ad.status === 'CLOSED') throw badRequest('CLOSED', 'Quảng cáo đã đóng');
      if (online) await this.requireActiveMerchant(tx, userId);
      await tx.many('UPDATE p2p_ads SET status = $2, updated_at = now() WHERE id = $1', [adId, online ? 'ONLINE' : 'OFFLINE']);
    });
    return (await this.adById(adId, userId))!;
  }

  /** Đóng quảng cáo: mở khoá phần coin chưa bán; đơn đang chạy vẫn xử lý tiếp (huỷ thì coin về thẳng ví) */
  async closeAd(userId: string, adId: number): Promise<void> {
    await this.db.tx(async (tx) => {
      const ad = await tx.one<AdRow>('SELECT * FROM p2p_ads WHERE id = $1 AND merchant_id = $2 FOR UPDATE', [adId, userId]);
      if (!ad) throw notFound('Không tìm thấy quảng cáo');
      if (ad.status === 'CLOSED') return;
      await this.closeAdTx(tx, ad);
    });
    this.notify.account(userId);
  }

  private async closeAdTx(tx: Queryable, ad: AdRow) {
    if (new Big(ad.locked_amount).gt(0)) await unlockFunds(tx, ad.merchant_id, ad.asset, ad.locked_amount);
    await tx.many(`UPDATE p2p_ads SET status = 'CLOSED', locked_amount = 0, available_qty = 0, closed_at = now(), updated_at = now() WHERE id = $1`, [ad.id]);
  }

  private async closeAllAdsTx(tx: Queryable, userId: string): Promise<number> {
    const ads = await tx.many<AdRow>(`SELECT * FROM p2p_ads WHERE merchant_id = $1 AND status <> 'CLOSED' FOR UPDATE`, [userId]);
    for (const ad of ads) await this.closeAdTx(tx, ad);
    return ads.length;
  }

  private async toAdDTOs(rows: AdRow[], ownerView: boolean): Promise<P2PAdDTO[]> {
    const traders = await this.traders(this.db, rows.map((r) => r.merchant_id));
    const methodIds = [...new Set(rows.flatMap((r) => r.payment_method_ids.map(Number)))];
    const methods = methodIds.length
      ? await this.db.many<{ id: string | number; bank_name: string }>('SELECT id, bank_name FROM p2p_payment_methods WHERE id = ANY($1::bigint[])', [methodIds])
      : [];
    const bankOf = new Map(methods.map((m) => [idNum(m.id), m.bank_name]));
    return rows.map((r) => {
      const price = this.priceOf(r);
      const limits = price ? effectiveLimits({ minFiat: r.min_fiat, maxFiat: r.max_fiat, availableQty: r.available_qty }, price) : { min: r.min_fiat, max: '0' };
      const ids = r.payment_method_ids.map(Number);
      return {
        id: idNum(r.id),
        merchant: traders.get(r.merchant_id)!,
        side: r.side,
        asset: r.asset,
        fiat: 'VND' as const,
        priceType: r.price_type,
        fixedPrice: r.fixed_price == null ? null : new Big(r.fixed_price).toFixed(),
        floatRatio: r.float_ratio == null ? null : new Big(r.float_ratio).toFixed(),
        price,
        totalQty: new Big(r.total_qty).toFixed(),
        availableQty: new Big(r.available_qty).toFixed(),
        minFiat: new Big(r.min_fiat).toFixed(),
        maxFiat: new Big(r.max_fiat).toFixed(),
        limitMin: new Big(limits.min).toFixed(),
        limitMax: new Big(limits.max).toFixed(),
        payMinutes: r.pay_minutes,
        banks: [...new Set(ids.map((i) => bankOf.get(i)).filter((x): x is string => !!x))],
        ...(ownerView && { paymentMethodIds: ids }),
        terms: r.terms,
        minAccountDays: r.min_account_days,
        makerFee: new Big(r.maker_fee).toFixed(),
        status: r.status,
        createdAt: new Date(r.created_at).toISOString(),
      };
    });
  }

  async adById(adId: number, viewerId?: string): Promise<P2PAdDTO | null> {
    const r = await this.db.one<AdRow>('SELECT * FROM p2p_ads WHERE id = $1', [adId]);
    if (!r) return null;
    return (await this.toAdDTOs([r], r.merchant_id === viewerId))[0]!;
  }

  async myAds(userId: string): Promise<P2PAdDTO[]> {
    const rows = await this.db.many<AdRow>(
      `SELECT * FROM p2p_ads WHERE merchant_id = $1 AND (status <> 'CLOSED' OR closed_at > now() - interval '30 days') ORDER BY status = 'CLOSED', id DESC`,
      [userId],
    );
    return this.toAdDTOs(rows, true);
  }

  /**
   * Chợ P2P. `side` theo góc nhìn KHÁCH: BUY = khách muốn mua (quảng cáo SELL của thương nhân, giá thấp trước),
   * SELL = khách muốn bán (quảng cáo BUY, giá cao trước).
   */
  async listAds(f: { side: 'BUY' | 'SELL'; asset: P2PAsset; fiatAmount?: Dec; bank?: string; viewerId?: string }): Promise<P2PAdDTO[]> {
    const rows = await this.db.many<AdRow>(
      `SELECT a.* FROM p2p_ads a
       JOIN p2p_merchants m ON m.user_id = a.merchant_id AND m.status = 'ACTIVE'
       JOIN users u ON u.id = a.merchant_id AND u.status = 'ACTIVE'
       WHERE a.status = 'ONLINE' AND a.side = $1 AND a.asset = $2 AND a.available_qty > 0
       LIMIT 500`,
      [f.side === 'BUY' ? 'SELL' : 'BUY', f.asset],
    );
    let ads = (await this.toAdDTOs(rows, false)).filter((a) => a.price && new Big(a.limitMax).gte(a.limitMin));
    if (f.fiatAmount) ads = ads.filter((a) => new Big(f.fiatAmount!).gte(a.limitMin) && new Big(f.fiatAmount!).lte(a.limitMax));
    if (f.bank) ads = ads.filter((a) => a.banks.includes(f.bank!));
    ads.sort((a, b) => {
      const d = new Big(a.price!).cmp(b.price!);
      if (d !== 0) return f.side === 'BUY' ? d : -d;
      return b.merchant.orders30d - a.merchant.orders30d;
    });
    return ads.slice(0, 100);
  }

  /* ================================ đơn P2P ================================ */

  async placeOrder(takerId: string, input: PlaceP2POrderInput): Promise<P2POrderDTO> {
    const orderId = await this.db.tx(async (tx) => {
      const taker = await this.gate(tx, takerId);
      if (!taker.email_verified_at) throw forbidden('Xác thực email trước khi giao dịch P2P');
      const cancels = await this.cancelsToday(tx, takerId);
      const until = this.blockedUntil(cancels);
      if (until) {
        throw forbidden(`Bạn đã huỷ ${cancels} đơn hôm nay — chức năng P2P bị khoá tới ${until.toISOString().slice(0, 16).replace('T', ' ')} UTC`);
      }
      const ad = await tx.one<AdRow>('SELECT * FROM p2p_ads WHERE id = $1 FOR UPDATE', [input.adId]);
      if (!ad || ad.status !== 'ONLINE') throw badRequest('AD_OFFLINE', 'Quảng cáo không còn hoạt động');
      if (ad.merchant_id === takerId) throw badRequest('SELF', 'Không thể đặt đơn vào quảng cáo của chính mình');
      const maker = await this.merchantOf(tx, ad.merchant_id);
      const makerUser = await tx.one<{ status: string }>('SELECT status FROM users WHERE id = $1', [ad.merchant_id]);
      if (maker?.status !== 'ACTIVE' || makerUser?.status !== 'ACTIVE') throw badRequest('AD_OFFLINE', 'Thương nhân đang tạm ngừng giao dịch');
      const ageDays = (Date.now() - new Date(taker.created_at).getTime()) / 86_400_000;
      if (ageDays < ad.min_account_days) throw forbidden(`Quảng cáo chỉ nhận tài khoản đã mở từ ${ad.min_account_days} ngày`);

      const price = this.priceOf(ad);
      if (!price) throw badRequest('NO_PRICE', 'Chưa có giá tham chiếu, thử lại sau');
      const qty = input.qty ? roundP2PQty(input.qty, ad.asset) : qtyForFiat(input.fiatAmount!, price, ad.asset);
      const fiat = input.qty ? fiatForQty(qty, price) : input.fiatAmount!;
      const err = validateP2POrderAmount(fiat, qty, { minFiat: ad.min_fiat, maxFiat: ad.max_fiat, availableQty: ad.available_qty }, price);
      if (err) throw badRequest('AMOUNT', err);
      // Hạn mức P2P / ngày theo cấp KYC của cả hai bên
      if (Number(taker.kyc_level) < 1) throw forbidden('Xác minh danh tính (KYC cấp 1) để giao dịch P2P');
      const mk = await tx.one<{ kyc_level: number; aml_restricted_at: Date | null }>('SELECT kyc_level, aml_restricted_at FROM users WHERE id = $1', [ad.merchant_id]);
      if (mk?.aml_restricted_at) throw badRequest('AD_OFFLINE', 'Thương nhân đang tạm ngừng giao dịch');
      await assertP2PLimit(tx, takerId, Number(taker.kyc_level), fiat, true);
      await assertP2PLimit(tx, ad.merchant_id, Number(mk?.kyc_level ?? 0), fiat, false);

      const makerSells = ad.side === 'SELL';
      const buyerId = makerSells ? takerId : ad.merchant_id;
      const sellerId = makerSells ? ad.merchant_id : takerId;
      const fee = roundDp(new Big(qty).times(ad.maker_fee), FEE_DP, 'up');

      // Tài khoản nhận tiền của bên bán
      let pay: { bank_name: string; account_no: string; holder_name: string };
      if (makerSells) {
        const ids = ad.payment_method_ids.map(Number);
        const chosen = input.paymentMethodId ?? ids[0];
        if (!chosen || !ids.includes(chosen)) throw badRequest('PAYMENT_METHOD', 'Phương thức thanh toán không thuộc quảng cáo');
        const m = await tx.one<typeof pay>('SELECT bank_name, account_no, holder_name FROM p2p_payment_methods WHERE id = $1 AND deleted_at IS NULL', [chosen]);
        if (!m) throw badRequest('PAYMENT_METHOD', 'Phương thức thanh toán của thương nhân không còn hiệu lực');
        pay = m;
      } else {
        if (!input.paymentMethodId) throw badRequest('PAYMENT_METHOD', 'Chọn tài khoản nhận tiền của bạn');
        const m = await tx.one<typeof pay>(
          'SELECT bank_name, account_no, holder_name FROM p2p_payment_methods WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
          [input.paymentMethodId, takerId],
        );
        if (!m) throw badRequest('PAYMENT_METHOD', 'Tài khoản nhận tiền không hợp lệ');
        const adBanks = await tx.many<{ bank_name: string }>('SELECT bank_name FROM p2p_payment_methods WHERE id = ANY($1::bigint[])', [
          ad.payment_method_ids.map(Number),
        ]);
        if (!adBanks.some((b) => b.bank_name === m.bank_name)) {
          throw badRequest('PAYMENT_METHOD', `Quảng cáo chỉ thanh toán qua: ${adBanks.map((b) => b.bank_name).join(', ')}`);
        }
        pay = m;
      }

      // Ký quỹ coin của bên bán
      let escrow: Big;
      if (makerSells) {
        escrow = new Big(qty).plus(fee);
        const fromAd = new Big(ad.locked_amount).lt(escrow) ? new Big(ad.locked_amount) : escrow;
        const extra = escrow.minus(fromAd);
        if (extra.gt(0)) await lockFunds(tx, ad.merchant_id, ad.asset, extra.toFixed());
        await tx.many('UPDATE p2p_ads SET locked_amount = locked_amount - $2 WHERE id = $1', [ad.id, fromAd.toFixed()]);
      } else {
        escrow = new Big(qty);
        await lockFunds(tx, takerId, ad.asset, qty);
      }
      await tx.many('UPDATE p2p_ads SET available_qty = available_qty - $2, updated_at = now() WHERE id = $1', [ad.id, qty]);

      const row = await tx.one<{ id: string | number }>(
        `INSERT INTO p2p_orders (ad_id, maker_id, taker_id, buyer_id, seller_id, asset, price, qty, fiat_amount, fee, escrow_amount,
                                 pay_minutes, pay_deadline, pay_bank_name, pay_account_no, pay_holder_name, terms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now() + make_interval(mins => $12::int), $13, $14, $15, $16) RETURNING id`,
        [ad.id, ad.merchant_id, takerId, buyerId, sellerId, ad.asset, price, qty, fiat, fee, escrow.toFixed(), ad.pay_minutes, pay.bank_name, pay.account_no, pay.holder_name, ad.terms],
      );
      const id = idNum(row!.id);
      await this.message(
        tx,
        id,
        `Đơn #${id} đã tạo. ${qty} ${ad.asset} của bên bán đang được sàn giữ ký quỹ. Người mua chuyển ${fmtVnd(fiat)} tới tài khoản ${pay.bank_name} ${pay.account_no} (${pay.holder_name}) trong ${ad.pay_minutes} phút, nội dung "P2P ${id}", rồi bấm "Tôi đã thanh toán".`,
      );
      return id;
    });
    const o = await this.orderRow(orderId);
    this.touch(o!, 'created', takerId);
    return this.toOrderDTO(o!, takerId);
  }

  /** Báo 2 bên; người vừa tự thao tác nhận kind 'self' (giao diện chỉ làm mới, không hiện thông báo) */
  private touch(o: P2POrderRow, kind: string, actorId: string | null = null) {
    const orderId = idNum(o.id);
    for (const uid of [o.buyer_id, o.seller_id]) this.notify.user(uid, { orderId, kind: uid === actorId ? 'self' : kind });
    this.notify.account(o.buyer_id);
    this.notify.account(o.seller_id);
    if (o.status === 'APPEAL' || o.appeal_at) this.notify.staff({ orderId, kind });
  }

  async orderRow(id: number, q: Queryable = this.db, forUpdate = false): Promise<P2POrderRow | undefined> {
    return q.one<P2POrderRow>(`SELECT * FROM p2p_orders WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [id]);
  }

  private async partyOrder(tx: Queryable, userId: string, id: number): Promise<P2POrderRow> {
    const o = await this.orderRow(id, tx, true);
    if (!o || (o.buyer_id !== userId && o.seller_id !== userId)) throw notFound('Không tìm thấy đơn P2P');
    return o;
  }

  /** Người mua xác nhận đã chuyển khoản */
  async markPaid(userId: string, id: number): Promise<P2POrderDTO> {
    await this.db.tx(async (tx) => {
      const o = await this.partyOrder(tx, userId, id);
      if (o.buyer_id !== userId) throw forbidden('Chỉ người mua được xác nhận đã thanh toán');
      if (o.status !== 'PENDING_PAYMENT') throw badRequest('STATUS', 'Đơn không ở trạng thái chờ thanh toán');
      if (new Date(o.pay_deadline).getTime() < Date.now()) throw badRequest('EXPIRED', 'Đã hết thời hạn thanh toán, đơn sẽ bị huỷ');
      await tx.many(`UPDATE p2p_orders SET status = 'PAID', paid_at = now(), updated_at = now() WHERE id = $1`, [id]);
      await this.message(
        tx,
        id,
        `Người mua đã xác nhận chuyển ${fmtVnd(o.fiat_amount)}. Bên bán kiểm tra sao kê ngân hàng; đúng số tiền thì bấm "Xác nhận đã nhận tiền và nhả coin". Không nhả coin khi chưa thấy tiền về tài khoản.`,
      );
    });
    const o = (await this.orderRow(id))!;
    this.touch(o, 'paid', userId);
    return this.toOrderDTO(o, userId);
  }

  /** Bên bán nhả coin cho người mua (được cả khi đang khiếu nại — bên bán tự nguyện) */
  async release(userId: string, id: number): Promise<P2POrderDTO> {
    await this.db.tx(async (tx) => {
      const o = await this.partyOrder(tx, userId, id);
      if (o.seller_id !== userId) throw forbidden('Chỉ bên bán được nhả coin');
      if (!isP2POrderOpen(o.status)) throw badRequest('STATUS', 'Đơn đã kết thúc');
      await this.completeTx(tx, o);
      await this.message(tx, id, `Bên bán đã nhả ${new Big(o.qty).toFixed()} ${o.asset}. Đơn hoàn tất.`);
      if (o.status === 'APPEAL') {
        await tx.many(`UPDATE p2p_orders SET resolution = 'RELEASED', resolved_by = 'Bên bán tự nhả coin', resolved_at = now() WHERE id = $1`, [id]);
      }
    });
    const o = (await this.orderRow(id))!;
    this.touch(o, 'completed', userId);
    return this.toOrderDTO(o, userId);
  }

  /** Người mua huỷ đơn (trước khi coin được nhả). Huỷ sau khi đã chuyển tiền thì tự chịu rủi ro */
  async cancel(userId: string, id: number, reason: string): Promise<P2POrderDTO> {
    await this.db.tx(async (tx) => {
      const o = await this.partyOrder(tx, userId, id);
      if (o.buyer_id !== userId) throw forbidden('Chỉ người mua được huỷ đơn; bên bán muốn huỷ hãy nhắn người mua hoặc khiếu nại');
      if (o.status !== 'PENDING_PAYMENT' && o.status !== 'PAID') throw badRequest('STATUS', 'Đơn không huỷ được ở trạng thái này');
      await this.cancelTx(tx, o, 'BUYER', reason || 'Người mua huỷ đơn');
    });
    const o = (await this.orderRow(id))!;
    this.touch(o, 'cancelled', userId);
    return this.toOrderDTO(o, userId);
  }

  /** Huỷ các đơn quá hạn thanh toán (người mua chưa bấm "đã thanh toán") */
  async expireDue(): Promise<number> {
    const due = await this.db.many<{ id: string | number }>(`SELECT id FROM p2p_orders WHERE status = 'PENDING_PAYMENT' AND pay_deadline < now() ORDER BY id LIMIT 200`);
    let n = 0;
    for (const d of due) {
      const done = await this.db.tx(async (tx) => {
        const o = await this.orderRow(idNum(d.id), tx, true);
        if (!o || o.status !== 'PENDING_PAYMENT' || new Date(o.pay_deadline).getTime() >= Date.now()) return null;
        await this.cancelTx(tx, o, 'SYSTEM', 'Hết thời hạn thanh toán');
        return o;
      });
      if (done) {
        n++;
        this.touch({ ...done, status: 'CANCELLED' }, 'expired');
      }
    }
    return n;
  }

  async appeal(userId: string, id: number, input: { reason: AppealReason; description: string }): Promise<P2POrderDTO> {
    await this.db.tx(async (tx) => {
      const o = await this.partyOrder(tx, userId, id);
      if (o.status !== 'PAID') throw badRequest('STATUS', 'Chỉ khiếu nại được khi người mua đã xác nhận thanh toán và coin chưa được nhả');
      const at = new Date(o.paid_at!).getTime() + P2P_RULES.appealAfterMinutes * 60_000;
      if (Date.now() < at) {
        throw badRequest('TOO_EARLY', `Chờ tới ${new Date(at).toISOString().slice(11, 16)} UTC mới được khiếu nại (${P2P_RULES.appealAfterMinutes} phút sau khi thanh toán). Hãy nhắn bên kia trước.`);
      }
      const by = o.buyer_id === userId ? 'BUYER' : 'SELLER';
      await tx.many(
        `UPDATE p2p_orders SET status = 'APPEAL', appeal_by = $2, appeal_reason = $3, appeal_desc = $4, appeal_at = now(), updated_at = now() WHERE id = $1`,
        [id, by, input.reason, input.description],
      );
      await this.message(
        tx,
        id,
        `${by === 'BUYER' ? 'Người mua' : 'Bên bán'} đã khiếu nại. Coin tiếp tục được sàn giữ ký quỹ cho tới khi nhân viên phân xử. Hai bên gửi bằng chứng (sao kê, nội dung chuyển khoản) trong khung chat.`,
      );
    });
    const o = (await this.orderRow(id))!;
    this.touch(o, 'appeal', userId);
    return this.toOrderDTO(o, userId);
  }

  /**
   * Nhân viên phân xử khiếu nại: RELEASE (nhả coin cho người mua) hoặc RETURN (trả coin về bên bán).
   * penaltyUsdt: trừ tiền cọc của bên có lỗi (chỉ khi bên đó là thương nhân) để bồi thường bên kia.
   */
  async resolveAppeal(staff: StaffActor, id: number, input: { outcome: 'RELEASE' | 'RETURN'; note: string; penaltyUsdt?: Dec }): Promise<P2POrderRow> {
    const o0 = await this.orderRow(id);
    if (!o0) throw notFound('Không tìm thấy đơn P2P');
    if (staff.id === o0.buyer_id || staff.id === o0.seller_id) throw forbidden('Không được phân xử đơn mà mình là một bên');
    await this.db.tx(async (tx) => {
      const o = (await this.orderRow(id, tx, true))!;
      if (o.status !== 'APPEAL') throw badRequest('STATUS', 'Đơn không ở trạng thái khiếu nại');
      const release = input.outcome === 'RELEASE';
      if (release) await this.completeTx(tx, o);
      else await this.cancelTx(tx, o, 'STAFF', `Phân xử khiếu nại: ${input.note}`);
      await tx.many(
        `UPDATE p2p_orders SET resolution = $2, resolved_by = $3, resolved_at = now(), resolution_note = $4, updated_at = now() WHERE id = $1`,
        [id, release ? 'RELEASED' : 'RETURNED', staff.email, input.note],
      );
      let penaltyText = '';
      if (input.penaltyUsdt) {
        // Nhả coin = bên bán sai (đã nhận tiền mà không nhả); trả coin = người mua sai (chưa trả tiền)
        const faulty = release ? o.seller_id : o.buyer_id;
        const victim = release ? o.buyer_id : o.seller_id;
        if (faulty !== o.maker_id) throw badRequest('PENALTY', 'Bên có lỗi không phải thương nhân nên không có tiền cọc để trừ');
        await this.deductDeposit(tx, faulty, input.penaltyUsdt, `Khiếu nại đơn P2P #${id}`, victim, id);
        penaltyText = ` Thương nhân bị trừ ${input.penaltyUsdt} USDT tiền cọc để bồi thường bên kia.`;
      }
      await this.message(
        tx,
        id,
        `Nhân viên đã phân xử: ${release ? `nhả ${new Big(o.qty).toFixed()} ${o.asset} cho người mua` : 'trả coin về bên bán, đơn bị huỷ'}. Căn cứ: ${input.note}.${penaltyText}`,
        null,
        staff.email,
      );
    });
    const o = (await this.orderRow(id))!;
    this.touch(o, 'resolved');
    return o;
  }

  /** Nhả coin: ký quỹ của bên bán → người mua; phí thương nhân thu bằng coin; ghi sổ cái + vốn góp */
  private async completeTx(tx: Queryable, o: P2POrderRow) {
    const id = idNum(o.id);
    const qty = new Big(o.qty);
    const fee = new Big(o.fee);
    const sellerIsMaker = o.seller_id === o.maker_id;
    // Bên bán: trừ coin đã khoá (+ phí nếu bên bán là thương nhân)
    const sold = await debitLocked(tx, o.seller_id, o.asset, qty.toFixed());
    await ledger(tx, o.seller_id, o.asset, 'P2P', qty.neg().toFixed(), sold.total, null, `Bán P2P đơn #${id}: ${fmtVnd(o.fiat_amount)}`, id);
    if (sellerIsMaker && fee.gt(0)) {
      const f = await debitLocked(tx, o.seller_id, o.asset, fee.toFixed());
      await ledger(tx, o.seller_id, o.asset, 'FEE', fee.neg().toFixed(), f.total, null, `Phí thương nhân P2P đơn #${id}`, id);
    }
    // Ký quỹ còn dư (làm tròn phí) trả lại bên bán
    const leftover = new Big(o.escrow_amount).minus(qty).minus(sellerIsMaker ? fee : 0);
    if (leftover.gt(0)) await unlockFunds(tx, o.seller_id, o.asset, leftover.toFixed());

    // Người mua: nhận coin, giá vốn theo số tiền đã trả quy đổi USDT
    const usdtValue = new Big(o.fiat_amount).div(P2P_RULES.usdtVnd);
    const got = await credit(tx, o.buyer_id, o.asset, qty.toFixed(), usdtValue.round(18).toFixed());
    await ledger(tx, o.buyer_id, o.asset, 'P2P', qty.toFixed(), got, null, `Mua P2P đơn #${id}: ${fmtVnd(o.fiat_amount)}`, id);
    if (!sellerIsMaker && fee.gt(0)) {
      const f = await debitFree(tx, o.buyer_id, o.asset, fee.toFixed());
      if (!f) throw new Error(`Không thu được phí P2P đơn #${id}`);
      await ledger(tx, o.buyer_id, o.asset, 'FEE', fee.neg().toFixed(), f.total, null, `Phí thương nhân P2P đơn #${id}`, id);
    }
    // Tiền VNĐ đi vào / ra khỏi sàn = nạp / rút vốn → giữ ROI bảng xếp hạng đúng
    const v = usdtValue.round(8).toFixed();
    await tx.many('UPDATE accounts SET contributed_usdt = contributed_usdt + $2, updated_at = now() WHERE user_id = $1', [o.buyer_id, v]);
    await tx.many('UPDATE accounts SET contributed_usdt = contributed_usdt - $2, updated_at = now() WHERE user_id = $1', [o.seller_id, v]);
    await tx.many(`UPDATE p2p_orders SET status = 'COMPLETED', escrow_amount = 0, released_at = now(), updated_at = now() WHERE id = $1`, [id]);
  }

  /** Huỷ đơn: coin ký quỹ trả về bên bán (về lại quảng cáo nếu quảng cáo còn mở) */
  private async cancelTx(tx: Queryable, o: P2POrderRow, by: P2PCancelBy, reason: string) {
    const id = idNum(o.id);
    const ad = await tx.one<AdRow>('SELECT * FROM p2p_ads WHERE id = $1 FOR UPDATE', [o.ad_id]);
    const adOpen = !!ad && ad.status !== 'CLOSED';
    const escrow = new Big(o.escrow_amount);
    if (o.seller_id === o.maker_id && adOpen) {
      await tx.many('UPDATE p2p_ads SET locked_amount = locked_amount + $2 WHERE id = $1', [o.ad_id, escrow.toFixed()]);
    } else if (escrow.gt(0)) {
      await unlockFunds(tx, o.seller_id, o.asset, escrow.toFixed());
    }
    if (adOpen) await tx.many('UPDATE p2p_ads SET available_qty = available_qty + $2, updated_at = now() WHERE id = $1', [o.ad_id, o.qty]);
    await tx.many(
      `UPDATE p2p_orders SET status = 'CANCELLED', escrow_amount = 0, cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, updated_at = now() WHERE id = $1`,
      [id, by, reason],
    );
    const who = by === 'BUYER' ? 'Người mua đã huỷ đơn' : by === 'SYSTEM' ? 'Hệ thống huỷ đơn' : 'Nhân viên huỷ đơn';
    await this.message(tx, id, `${who}: ${reason}. Coin đã trả về bên bán.`);
  }

  /* ================================ tin nhắn ================================ */

  async postMessage(userId: string, id: number, body: string): Promise<P2PMessageDTO> {
    const o = await this.orderRow(id);
    if (!o || (o.buyer_id !== userId && o.seller_id !== userId)) throw notFound('Không tìm thấy đơn P2P');
    await this.message(this.db, id, body, userId);
    this.touch(o, 'message', userId);
    return (await this.messages(id)).at(-1)!;
  }

  async staffMessage(staff: StaffActor, id: number, body: string): Promise<P2PMessageDTO> {
    const o = await this.orderRow(id);
    if (!o) throw notFound('Không tìm thấy đơn P2P');
    await this.message(this.db, id, body, null, staff.email);
    this.touch(o, 'message');
    return (await this.messages(id)).at(-1)!;
  }

  async messages(id: number): Promise<P2PMessageDTO[]> {
    const rows = await this.db.many<{
      id: string | number;
      order_id: string | number;
      sender_id: string | null;
      staff_email: string | null;
      body: string;
      created_at: Date;
      full_name: string | null;
      display_name: string | null;
    }>(
      `SELECT m.*, u.full_name, u.display_name FROM p2p_messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.order_id = $1 ORDER BY m.id`,
      [id],
    );
    return rows.map((r) => ({
      id: idNum(r.id),
      orderId: idNum(r.order_id),
      kind: r.staff_email ? 'STAFF' : r.sender_id ? 'USER' : 'SYSTEM',
      senderId: r.sender_id,
      senderName: r.staff_email ? 'Nhân viên VNCoin' : r.sender_id ? publicName(r.full_name ?? '', r.display_name) : 'Hệ thống',
      body: r.body,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  /* ================================ danh sách đơn ================================ */

  async myOrders(userId: string, scope: 'open' | 'done' | 'all'): Promise<P2POrderDTO[]> {
    const filter = scope === 'open' ? `AND status IN ('PENDING_PAYMENT', 'PAID', 'APPEAL')` : scope === 'done' ? `AND status IN ('COMPLETED', 'CANCELLED')` : '';
    const rows = await this.db.many<P2POrderRow>(
      `SELECT * FROM p2p_orders WHERE (buyer_id = $1 OR seller_id = $1) ${filter} ORDER BY id DESC LIMIT 200`,
      [userId],
    );
    return this.toOrderDTOs(rows, userId);
  }

  async orderFor(userId: string, id: number): Promise<P2POrderDTO> {
    const o = await this.orderRow(id);
    if (!o || (o.buyer_id !== userId && o.seller_id !== userId)) throw notFound('Không tìm thấy đơn P2P');
    return this.toOrderDTO(o, userId);
  }

  async toOrderDTO(o: P2POrderRow, viewerId: string | null): Promise<P2POrderDTO> {
    return (await this.toOrderDTOs([o], viewerId))[0]!;
  }

  async toOrderDTOs(rows: P2POrderRow[], viewerId: string | null): Promise<P2POrderDTO[]> {
    const traders = await this.traders(this.db, rows.flatMap((o) => [o.buyer_id, o.seller_id, o.maker_id]));
    return rows.map((o) => {
      const viewerIsBuyer = viewerId === o.buyer_id;
      return {
        id: idNum(o.id),
        adId: idNum(o.ad_id),
        asset: o.asset,
        side: viewerId && !viewerIsBuyer && viewerId === o.seller_id ? 'SELL' : 'BUY',
        role: viewerId === o.maker_id ? 'MAKER' : viewerId === o.taker_id ? 'TAKER' : null,
        price: new Big(o.price).toFixed(),
        qty: new Big(o.qty).toFixed(),
        fiatAmount: new Big(o.fiat_amount).toFixed(),
        fee: new Big(o.fee).toFixed(),
        status: o.status,
        payMinutes: o.pay_minutes,
        payDeadline: new Date(o.pay_deadline).toISOString(),
        paidAt: iso(o.paid_at),
        releasedAt: iso(o.released_at),
        cancelledAt: iso(o.cancelled_at),
        cancelledBy: o.cancelled_by,
        cancelReason: o.cancel_reason,
        appealAvailableAt: o.paid_at ? new Date(new Date(o.paid_at).getTime() + P2P_RULES.appealAfterMinutes * 60_000).toISOString() : null,
        appeal: o.appeal_by
          ? {
              by: o.appeal_by,
              reason: o.appeal_reason!,
              description: o.appeal_desc ?? '',
              at: iso(o.appeal_at)!,
              resolution: o.resolution,
              resolvedBy: o.resolved_by,
              resolvedAt: iso(o.resolved_at),
              note: o.resolution_note,
            }
          : null,
        buyer: { id: o.buyer_id, name: traders.get(o.buyer_id)?.name ?? '' },
        seller: { id: o.seller_id, name: traders.get(o.seller_id)?.name ?? '' },
        maker: traders.get(o.maker_id)!,
        paymentMethod: { bankName: o.pay_bank_name, accountNo: o.pay_account_no, holderName: o.pay_holder_name },
        terms: o.terms,
        createdAt: new Date(o.created_at).toISOString(),
        updatedAt: new Date(o.updated_at).toISOString(),
      };
    });
  }

  /* ================================ dọn dẹp tài khoản ================================ */

  /** Đặt lại tài khoản bị chặn khi còn đơn P2P dở dang (coin đang trong ký quỹ của người khác hoặc của mình) */
  async assertCanReset(userId: string): Promise<void> {
    const r = await this.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM p2p_orders WHERE (buyer_id = $1 OR seller_id = $1) AND status IN ('PENDING_PAYMENT', 'PAID', 'APPEAL')`,
      [userId],
    );
    if (r!.n > 0) throw badRequest('P2P_OPEN_ORDERS', `Còn ${r!.n} đơn P2P đang xử lý — hoàn tất hoặc huỷ trước khi đặt lại tài khoản`);
  }

  /**
   * Tài khoản bị khoá / xoá / đặt lại: đóng mọi quảng cáo (mở khoá coin). Đặt lại thì nghỉ thương nhân và trả cọc
   * (số dư sắp bị xoá); khoá / xoá thì tạm ngừng thương nhân, tiền cọc giữ lại để xử lý khiếu nại.
   */
  async onUserCleanup(userId: string, reason: string): Promise<void> {
    const reset = reason === 'Đặt lại tài khoản';
    await this.db.tx(async (tx) => {
      await this.closeAllAdsTx(tx, userId);
      const m = await this.merchantOf(tx, userId, true);
      if (!m) return;
      if (reset) {
        if (new Big(m.deposit_usdt).gt(0)) await unlockFunds(tx, userId, 'USDT', m.deposit_usdt);
        if (m.status !== 'REJECTED') {
          await tx.many(`UPDATE p2p_merchants SET status = 'RESIGNED', deposit_usdt = 0, note = $2, updated_at = now() WHERE user_id = $1`, [userId, reason]);
        }
      } else if (m.status === 'ACTIVE') {
        await tx.many(`UPDATE p2p_merchants SET status = 'SUSPENDED', note = $2, updated_at = now() WHERE user_id = $1`, [userId, reason]);
      }
    });
  }

  /** Thời điểm khoá P2P (huỷ quá nhiều) của 1 người — dùng cho FE */
  async blockInfo(userId: string): Promise<{ cancelsToday: number; blockedUntil: string | null }> {
    const c = await this.cancelsToday(this.db, userId);
    return { cancelsToday: c, blockedUntil: iso(this.blockedUntil(c)) };
  }
}
