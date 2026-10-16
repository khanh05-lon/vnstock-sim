import { Big, RULES, str, type AccountDTO, type BalanceDTO, type Dec } from '@vss/shared';
import type { Queryable } from '../db';
import type { AccountRow, BalanceRow } from './dto';

/** Giá quy đổi USDT của tài sản (USDT = 1) */
export interface UsdtPricer {
  priceUsdt(asset: string): Dec | null;
}

/** Tổng tài sản (USDT) từ danh sách số dư */
export function navOf(balances: Pick<BalanceRow, 'asset' | 'free' | 'locked'>[], pricer: UsdtPricer): Big {
  let total = new Big(0);
  for (const b of balances) {
    const qty = new Big(b.free).plus(b.locked);
    if (qty.eq(0)) continue;
    const p = pricer.priceUsdt(b.asset);
    if (p) total = total.plus(qty.times(p));
  }
  return total;
}

export function toBalanceDTO(b: BalanceRow, pricer: UsdtPricer): BalanceDTO {
  const free = new Big(b.free);
  const locked = new Big(b.locked);
  const total = free.plus(locked);
  const p = pricer.priceUsdt(b.asset);
  const value = p ? total.times(p) : new Big(0);
  const isQuote = b.asset === RULES.quoteAsset;
  const cost = new Big(b.cost_usdt);
  const hasCost = !isQuote && total.gt(0) && cost.gt(0);
  return {
    asset: b.asset,
    free: free.toFixed(),
    locked: locked.toFixed(),
    total: total.toFixed(),
    usdtValue: value.round(8).toFixed(),
    avgCost: hasCost ? cost.div(total).round(12).toFixed() : null,
    unrealizedPnl: hasCost && p ? value.minus(cost).round(8).toFixed() : null,
  };
}

/** Ví của 1 người dùng: số dư từng tài sản (sắp theo giá trị), tổng ước tính USDT / BTC */
export async function accountView(db: Queryable, pricer: UsdtPricer, userId: string): Promise<AccountDTO> {
  const acct = await db.one<AccountRow>('SELECT * FROM accounts WHERE user_id = $1', [userId]);
  const rows = await db.many<BalanceRow>('SELECT * FROM balances WHERE user_id = $1', [userId]);
  const balances = rows
    .map((r) => toBalanceDTO(r, pricer))
    .filter((b) => new Big(b.total).gt(0) || b.asset === RULES.quoteAsset)
    .sort((a, b) => new Big(b.usdtValue).cmp(a.usdtValue) || a.asset.localeCompare(b.asset));
  const totalUsdt = navOf(rows, pricer);
  const btc = pricer.priceUsdt('BTC');
  return {
    balances,
    totalUsdt: totalUsdt.round(8).toFixed(),
    totalBtc: btc ? totalUsdt.div(btc).round(8).toFixed() : '0',
    initialUsdt: str(acct?.initial_usdt ?? RULES.initialUsdt),
    contributedUsdt: str(acct?.contributed_usdt ?? RULES.initialUsdt),
    payFeeWithBnb: !!acct?.pay_fee_with_bnb,
    makerFee: RULES.makerFee,
    takerFee: RULES.takerFee,
  };
}
