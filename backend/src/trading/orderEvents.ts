import { ORDER_EVENT_LABEL, type OrderEventDTO } from '@vss/shared';
import type { Queryable } from '../db';
import type { OrderRow } from './dto';

/** Ai thao tác trên lệnh: khách hàng (kèm IP), hệ thống, hoặc nhân viên (email) */
export interface OrderActor {
  /** 'USER' | 'SYSTEM' | email nhân viên */
  actor: string;
  ip?: string | null;
}

export const SYSTEM_ACTOR: OrderActor = { actor: 'SYSTEM' };
export const userActor = (ip?: string | null): OrderActor => ({ actor: 'USER', ip: ip ?? null });

interface OrderEventRow {
  id: number;
  order_id: number;
  user_id: string;
  event: string;
  actor: string;
  ip: string | null;
  detail: Record<string, unknown> | string;
  created_at: Date;
}

/** Ảnh chụp các trường chính của lệnh tại thời điểm sự kiện */
export const orderSnapshot = (o: OrderRow) => ({
  symbol: o.symbol,
  side: o.side,
  type: o.type,
  price: o.price,
  stopPrice: o.stop_price,
  quantity: o.orig_qty,
  quoteOrderQty: o.quote_order_qty,
  status: o.status,
  executedQty: o.executed_qty,
  ...(o.order_list_id ? { orderListId: Number(o.order_list_id) } : {}),
  ...(o.reason ? { reason: o.reason } : {}),
});

/** Ghi sự kiện cho nhiều lệnh (trong cùng transaction với thay đổi lệnh) */
export async function recordOrderEvents(q: Queryable, rows: OrderRow[], event: string, by: OrderActor, extra: Record<string, unknown> = {}) {
  for (const o of rows) {
    await q.many('INSERT INTO order_events (order_id, user_id, event, actor, ip, detail) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [
      o.id,
      o.user_id,
      event,
      by.actor,
      by.ip ?? null,
      JSON.stringify({ ...orderSnapshot(o), ...extra }),
    ]);
  }
}

const actorName = (a: string) => (a === 'USER' ? 'Khách hàng' : a === 'SYSTEM' ? 'Hệ thống' : a);

export async function listOrderEvents(q: Queryable, orderId: number, userId?: string): Promise<OrderEventDTO[]> {
  const rows = await q.many<OrderEventRow>(
    `SELECT * FROM order_events WHERE order_id = $1 ${userId ? 'AND user_id = $2' : ''} ORDER BY id`,
    userId ? [orderId, userId] : [orderId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    orderId: Number(r.order_id),
    event: r.event,
    label: ORDER_EVENT_LABEL[r.event] ?? r.event,
    actor: actorName(r.actor),
    ip: r.ip,
    detail: typeof r.detail === 'string' ? (JSON.parse(r.detail) as Record<string, unknown>) : (r.detail ?? {}),
    createdAt: new Date(r.created_at).toISOString(),
  }));
}
