import { Big, RULES, bnbRate, commissionOf, roundDp, str, type Dec, type LedgerType } from '@vss/shared';
import type { Queryable } from '../db';
import { badRequest } from '../lib/errors';
import type { BalanceRow } from './dto';

/*
 * Thao tác số dư trong 1 transaction. Bất biến (CHECK trong CSDL): free ≥ 0, locked ≥ 0.
 * cost_usdt là tổng giá vốn của lượng đang nắm giữ → giá vốn bình quân = cost_usdt / (free + locked).
 */

export const fmtAmount = (v: Dec) => {
  const b = new Big(v);
  return b.gte(1) ? b.round(8, Big.roundDown).toFixed() : b.toFixed();
};

export async function balanceOf(tx: Queryable, userId: string, asset: string, forUpdate = false): Promise<BalanceRow> {
  const row = await tx.one<BalanceRow>(`SELECT * FROM balances WHERE user_id = $1 AND asset = $2 ${forUpdate ? 'FOR UPDATE' : ''}`, [userId, asset]);
  return row ?? { user_id: userId, asset, free: '0', locked: '0', cost_usdt: '0' };
}

/** Khoá số dư cho lệnh: free → locked. Không đủ → lỗi INSUFFICIENT_BALANCE */
export async function lockFunds(tx: Queryable, userId: string, asset: string, amount: Dec): Promise<void> {
  if (new Big(amount).lte(0)) return;
  const row = await tx.one(
    `UPDATE balances SET free = free - $3, locked = locked + $3, updated_at = now()
     WHERE user_id = $1 AND asset = $2 AND free >= $3 RETURNING asset`,
    [userId, asset, amount],
  );
  if (!row) {
    const b = await balanceOf(tx, userId, asset);
    throw badRequest('INSUFFICIENT_BALANCE', `Số dư ${asset} không đủ: cần ${fmtAmount(amount)}, khả dụng ${fmtAmount(str(b.free))}`);
  }
}

/** Mở khoá phần còn lại của lệnh: locked → free */
export async function unlockFunds(tx: Queryable, userId: string, asset: string, amount: Dec): Promise<void> {
  if (new Big(amount).lte(0)) return;
  await tx.many(
    `UPDATE balances SET free = free + $3, locked = GREATEST(locked - $3, 0), updated_at = now() WHERE user_id = $1 AND asset = $2`,
    [userId, asset, amount],
  );
}

/** Cộng vào số dư khả dụng (tạo dòng mới nếu chưa có tài sản này) và tăng giá vốn */
export async function credit(tx: Queryable, userId: string, asset: string, amount: Dec, costUsdt: Dec = '0'): Promise<Dec> {
  const row = await tx.one<BalanceRow>(
    `INSERT INTO balances (user_id, asset, free, cost_usdt) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, asset) DO UPDATE SET free = balances.free + $3, cost_usdt = balances.cost_usdt + $4, updated_at = now()
     RETURNING *`,
    [userId, asset, amount, asset === RULES.quoteAsset ? '0' : costUsdt],
  );
  return new Big(row!.free).plus(row!.locked).toFixed();
}

/**
 * Trừ khỏi phần đang khoá (tiền / coin đã giao khi khớp) và giảm giá vốn tương ứng tỷ lệ lượng bán ra.
 * Trả về phần giá vốn đã giảm (dùng tính lãi / lỗ đã thực hiện) và tổng còn lại.
 */
export async function debitLocked(tx: Queryable, userId: string, asset: string, amount: Dec): Promise<{ costRemoved: Dec; total: Dec }> {
  const b = await balanceOf(tx, userId, asset, true);
  const total = new Big(b.free).plus(b.locked);
  const costRemoved = total.gt(0) && asset !== RULES.quoteAsset ? new Big(b.cost_usdt).times(amount).div(total) : new Big(0);
  const row = await tx.one<BalanceRow>(
    `UPDATE balances SET locked = locked - $3, cost_usdt = GREATEST(cost_usdt - $4, 0), updated_at = now()
     WHERE user_id = $1 AND asset = $2 AND locked >= $3 RETURNING *`,
    [userId, asset, amount, costRemoved.round(18).toFixed()],
  );
  if (!row) throw new Error(`Số dư khoá ${asset} không đủ để thanh toán khớp lệnh (cần ${amount})`);
  return { costRemoved: costRemoved.toFixed(), total: new Big(row.free).plus(row.locked).toFixed() };
}

/** Trừ từ số dư khả dụng (trả phí bằng BNB). Trả về false nếu không đủ */
export async function debitFree(tx: Queryable, userId: string, asset: string, amount: Dec): Promise<{ total: Dec } | null> {
  const b = await balanceOf(tx, userId, asset, true);
  const total = new Big(b.free).plus(b.locked);
  if (new Big(b.free).lt(amount)) return null;
  const costRemoved = total.gt(0) ? new Big(b.cost_usdt).times(amount).div(total) : new Big(0);
  const row = await tx.one<BalanceRow>(
    `UPDATE balances SET free = free - $3, cost_usdt = GREATEST(cost_usdt - $4, 0), updated_at = now()
     WHERE user_id = $1 AND asset = $2 AND free >= $3 RETURNING *`,
    [userId, asset, amount, costRemoved.round(18).toFixed()],
  );
  return row ? { total: new Big(row.free).plus(row.locked).toFixed() } : null;
}

export async function ledger(
  tx: Queryable,
  userId: string,
  asset: string,
  type: LedgerType,
  amount: Dec,
  balanceAfter: Dec,
  orderId: number | null,
  note: string | null,
  /** Đơn P2P liên quan (ledger.p2p_order_id) */
  p2pOrderId: number | null = null,
) {
  if (new Big(amount).eq(0)) return;
  await tx.many('INSERT INTO ledger (user_id, asset, type, amount, balance_after, order_id, note, p2p_order_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
    userId,
    asset,
    type,
    amount,
    balanceAfter,
    orderId,
    note,
    p2pOrderId,
  ]);
}

export interface FeePlan {
  asset: string;
  amount: Dec;
  usdt: Dec;
  /** true = trừ từ số dư BNB khả dụng; false = trừ vào tài sản nhận về */
  fromBnb: boolean;
}

/**
 * Phí của 1 lần khớp. Mặc định thu bằng tài sản nhận về (mua → coin, bán → USDT).
 * Bật "trả phí bằng BNB" và đủ BNB khả dụng → thu BNB với mức giảm RULES.bnbDiscount (như Binance).
 */
export function planFee(opts: {
  received: { asset: string; amount: Dec };
  receivedUsdt: Dec;
  rate: Dec;
  payWithBnb: boolean;
  bnbPriceUsdt: Dec | null;
  bnbFree: Dec;
}): FeePlan {
  const { received, receivedUsdt, rate, payWithBnb, bnbPriceUsdt, bnbFree } = opts;
  if (payWithBnb && bnbPriceUsdt && new Big(bnbPriceUsdt).gt(0) && received.asset !== RULES.feeAsset) {
    const usdt = new Big(receivedUsdt).times(bnbRate(rate));
    const bnb = roundDp(usdt.div(bnbPriceUsdt), RULES.commissionPrecision, 'up');
    if (new Big(bnb).gt(0) && new Big(bnbFree).gte(bnb)) {
      return { asset: RULES.feeAsset, amount: bnb, usdt: usdt.toFixed(), fromBnb: true };
    }
  }
  const amount = commissionOf(received.amount, rate);
  const perUnit = new Big(received.amount).gt(0) ? new Big(receivedUsdt).div(received.amount) : new Big(0);
  return { asset: received.asset, amount, usdt: perUnit.times(amount).toFixed(), fromBnb: false };
}
