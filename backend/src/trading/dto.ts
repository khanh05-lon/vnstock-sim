import type { AccountDTO, HoldingDTO, LedgerDTO, OrderDTO, TradeDTO } from '@vss/shared';

export interface OrderRow {
  id: number;
  user_id: string;
  symbol: string;
  side: OrderDTO['side'];
  order_type: OrderDTO['orderType'];
  price: number | null;
  hold_price: number;
  qty: number;
  filled_qty: number;
  avg_fill_price: number;
  status: OrderDTO['status'];
  hold_amount: number;
  reject_reason: string | null;
  trade_date: string;
  created_at: Date;
  updated_at: Date;
  fee_rate: number | null;
  tax_rate: number | null;
  valid_until: string | null;
  source: OrderDTO['source'];
  conditional_id: number | null;
  loan_hold: number;
}

export interface TradeRow {
  id: number;
  order_id: number;
  user_id: string;
  symbol: string;
  side: TradeDTO['side'];
  price: number;
  qty: number;
  value: number;
  fee: number;
  tax: number;
  realized_pnl: number | null;
  executed_at: Date;
}

export interface AccountRow {
  user_id: string;
  cash_balance: number;
  cash_hold: number;
  initial_capital: number;
  contributed?: number;
  cash_pending?: number;
  loan_balance?: number;
  loan_interest?: number;
  loan_hold?: number;
  credit_limit?: number;
  margin_enabled?: boolean;
  auto_advance?: boolean;
  margin_status?: 'NORMAL' | 'CALL' | 'FORCE';
  deposit_interest_accrued?: number;
}

export interface HoldingRow {
  user_id: string;
  symbol: string;
  qty_total: number;
  qty_available: number;
  qty_hold: number;
  qty_pending: number;
  total_cost: number;
}

export interface LedgerRow {
  id: number;
  type: LedgerDTO['type'];
  amount: number;
  balance_after: number;
  order_id: number | null;
  note: string | null;
  created_at: Date;
}

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

/** Cột DATE → 'YYYY-MM-DD' (PGlite trong bộ nhớ trả về Date, các nơi khác trả chuỗi) */
export const dateOnly = (d: Date | string): string => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

export const toOrderDTO = (r: OrderRow): OrderDTO => ({
  id: r.id,
  symbol: r.symbol,
  side: r.side,
  orderType: r.order_type,
  price: r.price,
  qty: r.qty,
  filledQty: r.filled_qty,
  avgFillPrice: r.avg_fill_price,
  status: r.status,
  holdAmount: r.hold_amount,
  rejectReason: r.reject_reason,
  tradeDate: dateOnly(r.trade_date),
  validUntil: r.valid_until ? dateOnly(r.valid_until) : null,
  source: r.source ?? 'USER',
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toTradeDTO = (r: TradeRow): TradeDTO => ({
  id: r.id,
  orderId: r.order_id,
  symbol: r.symbol,
  side: r.side,
  price: r.price,
  qty: r.qty,
  value: r.value,
  fee: r.fee,
  tax: r.tax,
  realizedPnl: r.realized_pnl,
  executedAt: iso(r.executed_at),
});

export const toAccountDTO = (r: AccountRow): AccountDTO => ({
  cashBalance: r.cash_balance,
  cashHold: r.cash_hold,
  cashAvailable: r.cash_balance - r.cash_hold,
  initialCapital: r.initial_capital,
  contributed: r.contributed ?? r.initial_capital,
  cashPending: r.cash_pending ?? 0,
  autoAdvance: r.auto_advance ?? true,
  marginEnabled: r.margin_enabled ?? false,
  creditLimit: r.credit_limit ?? 0,
  loanBalance: r.loan_balance ?? 0,
  loanInterest: r.loan_interest ?? 0,
  loanHold: r.loan_hold ?? 0,
  marginStatus: r.margin_status ?? 'NORMAL',
  depositInterestAccrued: r.deposit_interest_accrued ?? 0,
});

export const toHoldingDTO = (r: HoldingRow): HoldingDTO => ({
  symbol: r.symbol,
  qtyTotal: r.qty_total,
  qtyAvailable: r.qty_available,
  qtyHold: r.qty_hold,
  qtyPending: r.qty_pending,
  totalCost: r.total_cost,
  avgCost: r.qty_total > 0 ? Math.round(r.total_cost / r.qty_total) : 0,
});

export const toLedgerDTO = (r: LedgerRow): LedgerDTO => ({
  id: r.id,
  type: r.type,
  amount: r.amount,
  balanceAfter: r.balance_after,
  orderId: r.order_id,
  note: r.note,
  createdAt: iso(r.created_at),
});
