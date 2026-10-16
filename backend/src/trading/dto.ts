import {
  Big,
  str,
  type FillDTO,
  type LedgerDTO,
  type LedgerType,
  type OrderDTO,
  type OrderListDTO,
  type OrderListStatus,
  type OrderStatus,
  type OrderType,
  type Side,
  type TimeInForce,
} from '@vss/shared';

/* Bản ghi CSDL (NUMERIC → chuỗi, TIMESTAMPTZ → Date) và chuyển đổi sang DTO trả cho client */

export interface OrderRow {
  id: number;
  client_order_id: string;
  user_id: string;
  symbol: string;
  side: Side;
  type: OrderType;
  time_in_force: TimeInForce | null;
  price: string | null;
  stop_price: string | null;
  orig_qty: string;
  executed_qty: string;
  cumm_quote_qty: string;
  quote_order_qty: string | null;
  status: OrderStatus;
  is_working: boolean;
  order_list_id: number | null;
  maker_fee: string;
  taker_fee: string;
  locked_asset: string;
  locked_amount: string;
  reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface FillRow {
  id: number;
  order_id: number;
  user_id: string;
  symbol: string;
  side: Side;
  price: string;
  qty: string;
  quote_qty: string;
  commission: string;
  commission_asset: string;
  commission_usdt: string;
  is_maker: boolean;
  realized_pnl: string | null;
  executed_at: Date | string;
}

export interface OrderListRow {
  id: number;
  user_id: string;
  symbol: string;
  side: Side;
  status: OrderListStatus;
  created_at: Date | string;
}

export interface BalanceRow {
  user_id: string;
  asset: string;
  free: string;
  locked: string;
  cost_usdt: string;
}

export interface AccountRow {
  user_id: string;
  initial_usdt: string;
  contributed_usdt: string;
  pay_fee_with_bnb: boolean;
}

export interface LedgerRow {
  id: number;
  user_id: string;
  asset: string;
  type: LedgerType;
  amount: string;
  balance_after: string;
  order_id: number | null;
  note: string | null;
  created_at: Date | string;
}

export const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const s = (v: string | null): string | null => (v == null ? null : str(v));

export function toOrderDTO(r: OrderRow): OrderDTO {
  const executed = new Big(r.executed_qty);
  const quote = new Big(r.cumm_quote_qty);
  return {
    id: Number(r.id),
    clientOrderId: r.client_order_id,
    symbol: r.symbol,
    side: r.side,
    type: r.type,
    timeInForce: r.time_in_force,
    price: s(r.price),
    stopPrice: s(r.stop_price),
    origQty: str(r.orig_qty),
    executedQty: executed.toFixed(),
    cummulativeQuoteQty: quote.toFixed(),
    origQuoteOrderQty: s(r.quote_order_qty),
    avgPrice: executed.gt(0) ? quote.div(executed).round(12).toFixed() : '0',
    status: r.status,
    isWorking: r.is_working,
    orderListId: r.order_list_id == null ? null : Number(r.order_list_id),
    reason: r.reason,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export function toFillDTO(r: FillRow): FillDTO {
  return {
    id: Number(r.id),
    orderId: Number(r.order_id),
    symbol: r.symbol,
    side: r.side,
    price: str(r.price),
    qty: str(r.qty),
    quoteQty: str(r.quote_qty),
    commission: str(r.commission),
    commissionAsset: r.commission_asset,
    isMaker: r.is_maker,
    realizedPnl: s(r.realized_pnl),
    time: iso(r.executed_at),
  };
}

export function toOrderListDTO(r: OrderListRow, orders: OrderRow[]): OrderListDTO {
  return {
    id: Number(r.id),
    symbol: r.symbol,
    side: r.side,
    status: r.status,
    orders: orders.map(toOrderDTO),
    createdAt: iso(r.created_at),
  };
}

export function toLedgerDTO(r: LedgerRow): LedgerDTO {
  return {
    id: Number(r.id),
    asset: r.asset,
    type: r.type,
    amount: str(r.amount),
    balanceAfter: str(r.balance_after),
    orderId: r.order_id == null ? null : Number(r.order_id),
    note: r.note,
    createdAt: iso(r.created_at),
  };
}
