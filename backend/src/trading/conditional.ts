import crypto from 'node:crypto';
import {
  CONDITIONAL_MAX_DAYS,
  RULES,
  conditionalLabel,
  isValidTick,
  tickSize,
  type ConditionalKind,
  type ConditionalOrderDTO,
  type ConditionalOrderInput,
  marketOrderTypeFor,
  type OrderType,
  type Side,
  type StockInfo,
} from '@vss/shared';
import type { Database } from '../db';
import { addDays } from '../lib/calendar';
import { AppError, badRequest, notFound } from '../lib/errors';
import { log } from '../lib/logger';
import { dateOnly } from './dto';
import type { TradingEngine } from './engine';

interface CondRow {
  id: number;
  user_id: string;
  symbol: string;
  side: Side;
  kind: ConditionalKind;
  trigger_price: number | null;
  trail_pct: number | null;
  peak_price: number | null;
  order_type: 'LO' | 'MARKET';
  limit_price: number | null;
  qty: number;
  valid_until: string;
  oco_group: string | null;
  status: ConditionalOrderDTO['status'];
  order_id: number | null;
  triggered_price: number | null;
  message: string | null;
  created_at: Date;
  triggered_at: Date | null;
}

const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());
const fmt = (n: number) => n.toLocaleString('en-US');

export const toConditionalDTO = (r: CondRow): ConditionalOrderDTO => ({
  id: r.id,
  symbol: r.symbol,
  side: r.side,
  kind: r.kind,
  triggerPrice: r.trigger_price,
  trailPct: r.trail_pct,
  peakPrice: r.peak_price,
  orderType: r.order_type,
  limitPrice: r.limit_price,
  qty: r.qty,
  validUntil: dateOnly(r.valid_until),
  ocoGroup: r.oco_group,
  status: r.status,
  orderId: r.order_id,
  triggeredPrice: r.triggered_price,
  message: r.message,
  createdAt: iso(r.created_at)!,
  triggeredAt: iso(r.triggered_at),
});

/** Những gì cần từ thị trường */
export interface CondMarket {
  tradeDate: string;
  phase: string;
  info(symbol: string): StockInfo | undefined;
  quote(symbol: string): { ref: number; ceil: number; floor: number; last: number; volume: number } | undefined;
}

/** Giới hạn số lệnh điều kiện đang chờ của 1 tài khoản */
export const MAX_ACTIVE_CONDITIONALS = 50;

/**
 * Lệnh điều kiện (do hệ thống "công ty chứng khoán" giữ, chưa gửi lên sàn): theo dõi giá khớp ở mỗi nhịp,
 * khi thoả điều kiện thì đặt lệnh thật qua bộ khớp lệnh (kiểm tra sức mua / cổ phiếu tại thời điểm kích hoạt).
 *  - STOP: bán khi giá ≤ kích hoạt (cắt lỗ) / mua khi giá ≥ kích hoạt (mua khi vượt đỉnh)
 *  - LIMIT_IF_TOUCHED: bán khi giá ≥ kích hoạt (chốt lời) / mua khi giá ≤ kích hoạt (mua khi giảm về)
 *  - TRAILING: bán khi giá giảm X% từ đỉnh kể từ lúc đặt / mua khi giá tăng X% từ đáy
 *  - OCO: cặp cắt lỗ + chốt lời, 1 lệnh kích hoạt thì lệnh kia tự huỷ
 */
export class ConditionalEngine {
  private active = new Map<string, Map<number, CondRow>>();
  /** Gửi sự kiện cho người dùng (socket) */
  notify: (userId: string, dto: ConditionalOrderDTO) => void = () => undefined;

  constructor(
    private db: Database,
    private market: CondMarket,
    private engine: TradingEngine,
  ) {}

  async load() {
    this.active.clear();
    const rows = await this.db.many<CondRow>(`SELECT * FROM conditional_orders WHERE status = 'ACTIVE'`);
    for (const r of rows) this.track(r);
  }

  activeCount() {
    let n = 0;
    for (const m of this.active.values()) n += m.size;
    return n;
  }

  private track(r: CondRow) {
    let m = this.active.get(r.symbol);
    if (!m) this.active.set(r.symbol, (m = new Map()));
    if (r.status === 'ACTIVE') m.set(r.id, r);
    else m.delete(r.id);
  }

  /** Giá khớp gần nhất trong phiên (chưa có giao dịch → không kích hoạt) */
  private lastPrice(symbol: string): number | null {
    const q = this.market.quote(symbol);
    return q && q.volume > 0 ? q.last : null;
  }

  async list(userId: string, scope: 'active' | 'all'): Promise<ConditionalOrderDTO[]> {
    const rows = await this.db.many<CondRow>(
      `SELECT * FROM conditional_orders WHERE user_id = $1 ${scope === 'active' ? `AND status = 'ACTIVE'` : ''} ORDER BY id DESC LIMIT 300`,
      [userId],
    );
    return rows.map(toConditionalDTO);
  }

  async create(userId: string, input: ConditionalOrderInput): Promise<ConditionalOrderDTO[]> {
    const info = this.market.info(input.symbol);
    const q = this.market.quote(input.symbol);
    if (!info || !q) throw badRequest('SYMBOL', `Mã ${input.symbol} không tồn tại`);
    const td = this.market.tradeDate;
    if (input.validUntil < td) throw badRequest('VALID_UNTIL', 'Ngày hiệu lực đã qua');
    if (input.validUntil > addDays(td, CONDITIONAL_MAX_DAYS)) throw badRequest('VALID_UNTIL', `Lệnh điều kiện có hiệu lực tối đa ${CONDITIONAL_MAX_DAYS} ngày`);
    const { qty } = input;
    if (qty < RULES.lotSize) {
      if (info.type === 'BOND') throw badRequest('LOT', `Trái phiếu giao dịch theo lô ${RULES.lotSize}`);
    } else if (qty % RULES.lotSize) throw badRequest('LOT', `Lô chẵn phải là bội số của ${RULES.lotSize}`);
    if (qty > RULES.maxOrderQty[info.exchange]) throw badRequest('MAX_QTY', `Khối lượng tối đa mỗi lệnh là ${fmt(RULES.maxOrderQty[info.exchange])}`);

    const cur = q.volume > 0 ? q.last : q.ref;
    const checkPrice = (p: number | null | undefined, label: string) => {
      if (p == null) return;
      if (!isValidTick(info, p)) throw badRequest('TICK', `${label} ${fmt(p)} không đúng bước giá ${fmt(tickSize(info, p))}đ`);
    };
    checkPrice(input.triggerPrice, 'Giá kích hoạt');
    checkPrice(input.limitPrice, 'Giá đặt');
    // Điều kiện đã thoả ngay lúc đặt → báo người dùng dùng lệnh thường
    const tp = input.triggerPrice ?? 0;
    if (input.kind === 'STOP' && (input.side === 'SELL' ? tp >= cur : tp <= cur)) {
      throw badRequest('TRIGGER', input.side === 'SELL' ? `Giá cắt lỗ phải thấp hơn giá hiện tại ${fmt(cur)}` : `Giá kích hoạt mua phải cao hơn giá hiện tại ${fmt(cur)}`);
    }
    if (input.kind === 'LIMIT_IF_TOUCHED' && (input.side === 'SELL' ? tp <= cur : tp >= cur)) {
      throw badRequest('TRIGGER', input.side === 'SELL' ? `Giá chốt lời phải cao hơn giá hiện tại ${fmt(cur)}` : `Giá mua khi giảm về phải thấp hơn giá hiện tại ${fmt(cur)}`);
    }
    if (input.takeProfit) {
      checkPrice(input.takeProfit.triggerPrice, 'Giá chốt lời');
      checkPrice(input.takeProfit.limitPrice, 'Giá đặt chốt lời');
      if (input.takeProfit.triggerPrice <= cur) throw badRequest('TRIGGER', `Giá chốt lời phải cao hơn giá hiện tại ${fmt(cur)}`);
    }

    const rows = await this.db.tx(async (tx) => {
      await tx.one('SELECT user_id FROM accounts WHERE user_id = $1 FOR UPDATE', [userId]);
      const n = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM conditional_orders WHERE user_id = $1 AND status = 'ACTIVE'`, [userId]);
      const legs = input.takeProfit ? 2 : 1;
      if ((n?.n ?? 0) + legs > MAX_ACTIVE_CONDITIONALS) throw badRequest('LIMIT', `Tối đa ${MAX_ACTIVE_CONDITIONALS} lệnh điều kiện đang chờ`);
      if (input.side === 'SELL') {
        const h = await tx.one<{ qty_total: number }>('SELECT qty_total FROM holdings WHERE user_id = $1 AND symbol = $2', [userId, input.symbol]);
        if ((h?.qty_total ?? 0) < qty) throw badRequest('INSUFFICIENT_SHARES', `Bạn đang nắm giữ ${fmt(h?.qty_total ?? 0)} ${input.symbol}, không đủ ${fmt(qty)} CP`);
      }
      const group = input.takeProfit ? crypto.randomUUID() : null;
      const insert = (kind: ConditionalKind, trigger: number | null, orderType: 'LO' | 'MARKET', limit: number | null) =>
        tx.one<CondRow>(
          `INSERT INTO conditional_orders (user_id, symbol, side, kind, trigger_price, trail_pct, peak_price, order_type, limit_price, qty, valid_until, oco_group)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [
            userId,
            input.symbol,
            input.side,
            kind,
            kind === 'TRAILING' ? null : trigger,
            kind === 'TRAILING' ? input.trailPct : null,
            kind === 'TRAILING' ? cur : null,
            orderType,
            orderType === 'LO' ? limit : null,
            qty,
            input.validUntil,
            group,
          ],
        );
      const out = [(await insert(input.kind, input.triggerPrice ?? null, input.orderType, input.limitPrice ?? null))!];
      if (input.takeProfit) out.push((await insert('LIMIT_IF_TOUCHED', input.takeProfit.triggerPrice, input.takeProfit.orderType, input.takeProfit.limitPrice ?? null))!);
      return out;
    });
    for (const r of rows) this.track(r);
    return rows.map(toConditionalDTO);
  }

  async cancel(userId: string | null, id: number, message = 'Người dùng huỷ'): Promise<ConditionalOrderDTO[]> {
    const rows = await this.db.tx(async (tx) => {
      const r = userId
        ? await tx.one<CondRow>('SELECT * FROM conditional_orders WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, userId])
        : await tx.one<CondRow>('SELECT * FROM conditional_orders WHERE id = $1 FOR UPDATE', [id]);
      if (!r) throw notFound('Không tìm thấy lệnh điều kiện');
      if (r.status !== 'ACTIVE') throw badRequest('NOT_CANCELLABLE', 'Lệnh điều kiện đã kích hoạt hoặc đã huỷ');
      // Huỷ 1 chân của cặp OCO thì huỷ cả cặp
      return r.oco_group
        ? tx.many<CondRow>(
            `UPDATE conditional_orders SET status = 'CANCELLED', message = $2, updated_at = now() WHERE oco_group = $1 AND status = 'ACTIVE' RETURNING *`,
            [r.oco_group, message],
          )
        : tx.many<CondRow>(`UPDATE conditional_orders SET status = 'CANCELLED', message = $2, updated_at = now() WHERE id = $1 RETURNING *`, [id, message]);
    });
    for (const r of rows) {
      this.track(r);
      this.notify(r.user_id, toConditionalDTO(r));
    }
    return rows.map(toConditionalDTO);
  }

  /** Huỷ mọi lệnh điều kiện của 1 mã (huỷ niêm yết, ngày giao dịch không hưởng quyền) */
  async cancelForSymbol(symbol: string, message: string): Promise<number> {
    const rows = await this.db.many<CondRow>(
      `UPDATE conditional_orders SET status = 'CANCELLED', message = $2, updated_at = now() WHERE symbol = $1 AND status = 'ACTIVE' RETURNING *`,
      [symbol, message],
    );
    for (const r of rows) {
      this.track(r);
      this.notify(r.user_id, toConditionalDTO(r));
    }
    return rows.length;
  }

  async cancelForUser(userId: string, message: string): Promise<number> {
    const rows = await this.db.many<CondRow>(
      `UPDATE conditional_orders SET status = 'CANCELLED', message = $2, updated_at = now() WHERE user_id = $1 AND status = 'ACTIVE' RETURNING *`,
      [userId, message],
    );
    for (const r of rows) this.track(r);
    return rows.length;
  }

  /** Cuối ngày: lệnh điều kiện hết hạn */
  async expire(tradeDate = this.market.tradeDate): Promise<number> {
    const rows = await this.db.many<CondRow>(
      `UPDATE conditional_orders SET status = 'EXPIRED', message = 'Hết thời hạn hiệu lực', updated_at = now()
       WHERE status = 'ACTIVE' AND valid_until <= $1 RETURNING *`,
      [tradeDate],
    );
    for (const r of rows) {
      this.track(r);
      this.notify(r.user_id, toConditionalDTO(r));
    }
    return rows.length;
  }

  /** Mỗi nhịp thị trường (phiên liên tục): cập nhật đỉnh/đáy trailing, kích hoạt lệnh thoả điều kiện */
  async onTick(symbols: Iterable<string>) {
    if (this.market.phase !== 'CONTINUOUS' || this.engine.control.haltAll) return;
    for (const sym of symbols) {
      const book = this.active.get(sym);
      if (!book?.size || this.engine.control.haltedSymbols.has(sym)) continue;
      const last = this.lastPrice(sym);
      if (last == null) continue;
      for (const r of [...book.values()]) {
        if (r.status !== 'ACTIVE') continue;
        const verdict = this.hit(r, last);
        if (verdict === 'MOVED') await this.savePeak(r, last);
        else if (verdict) await this.trigger(r, last);
      }
    }
  }

  /** Điều kiện kích hoạt; với trailing trả 'MOVED' khi giá lập đỉnh (bán) / đáy (mua) mới */
  private hit(r: CondRow, last: number): boolean | 'MOVED' {
    if (r.kind === 'STOP') return r.side === 'SELL' ? last <= r.trigger_price! : last >= r.trigger_price!;
    if (r.kind === 'LIMIT_IF_TOUCHED') return r.side === 'SELL' ? last >= r.trigger_price! : last <= r.trigger_price!;
    const pct = (r.trail_pct ?? 0) / 100;
    const peak = r.peak_price ?? last;
    if (r.side === 'SELL') return last > peak ? 'MOVED' : last <= peak * (1 - pct);
    return last < peak ? 'MOVED' : last >= peak * (1 + pct);
  }

  /**
   * Lưu đỉnh / đáy mới. Phải chờ ghi xong và chỉ cho đi một chiều (GREATEST / LEAST):
   * với PostgreSQL nhiều kết nối, các UPDATE bắn không chờ có thể về đích lệch thứ tự → đỉnh bị lùi.
   */
  private async savePeak(r: CondRow, last: number) {
    r.peak_price = last;
    const fn = r.side === 'SELL' ? 'GREATEST' : 'LEAST';
    await this.db
      .many(`UPDATE conditional_orders SET peak_price = ${fn}(COALESCE(peak_price, $2), $2), updated_at = now() WHERE id = $1 AND status = 'ACTIVE'`, [r.id, last])
      .catch((e) => console.error('[conditional] lưu đỉnh trailing lỗi', e));
  }

  private async trigger(r: CondRow, last: number) {
    // Chiếm quyền kích hoạt (an toàn khi có nhiều nhịp chạy chồng)
    const won = await this.db.one<CondRow>(
      `UPDATE conditional_orders SET status = 'TRIGGERED', triggered_price = $2, triggered_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'ACTIVE' RETURNING *`,
      [r.id, last],
    );
    this.active.get(r.symbol)?.delete(r.id);
    if (!won) return;
    // Huỷ chân còn lại của cặp OCO
    if (r.oco_group) {
      const others = await this.db.many<CondRow>(
        `UPDATE conditional_orders SET status = 'CANCELLED', message = 'Tự huỷ: lệnh cùng cặp OCO đã kích hoạt', updated_at = now()
         WHERE oco_group = $1 AND id <> $2 AND status = 'ACTIVE' RETURNING *`,
        [r.oco_group, r.id],
      );
      for (const o of others) {
        this.track(o);
        this.notify(o.user_id, toConditionalDTO(o));
      }
    }
    const info = this.market.info(r.symbol);
    const q = this.market.quote(r.symbol);
    let final: CondRow | undefined;
    try {
      if (!info || !q) throw badRequest('SYMBOL', `Mã ${r.symbol} không còn giao dịch`);
      const odd = r.qty < RULES.lotSize;
      let orderType: OrderType = 'LO';
      let price: number | null = r.limit_price;
      if (r.order_type === 'MARKET') {
        // Lệnh thị trường: MP (HOSE) / MTL (HNX); UPCOM / lô lẻ dùng LO giá trần (mua) / sàn (bán) — khớp ngay ở giá tốt nhất
        const mkt = odd ? null : marketOrderTypeFor(info.exchange);
        if (mkt) {
          orderType = mkt;
          price = null;
        } else price = r.side === 'BUY' ? q.ceil : q.floor;
      } else if (price != null) {
        price = Math.min(q.ceil, Math.max(q.floor, price));
      }
      const order = await this.engine.placeOrder(
        r.user_id,
        { symbol: r.symbol, side: r.side, orderType, price, qty: r.qty },
        { source: 'CONDITIONAL', conditionalId: r.id },
      );
      final = await this.db.one<CondRow>(
        `UPDATE conditional_orders SET order_id = $2, message = $3, updated_at = now() WHERE id = $1 RETURNING *`,
        [r.id, order.id, `${conditionalLabel(r.kind, r.side)} kích hoạt tại ${fmt(last)} → đã đặt lệnh #${order.id}`],
      );
    } catch (err) {
      const msg = err instanceof AppError ? err.message : 'Lỗi hệ thống khi đặt lệnh';
      if (!(err instanceof AppError)) log.error('[conditional] lỗi đặt lệnh khi kích hoạt', { err, id: r.id });
      final = await this.db.one<CondRow>(`UPDATE conditional_orders SET status = 'FAILED', message = $2, updated_at = now() WHERE id = $1 RETURNING *`, [
        r.id,
        `Kích hoạt tại ${fmt(last)} nhưng không đặt được lệnh: ${msg}`,
      ]);
    }
    if (final) this.notify(final.user_id, toConditionalDTO(final));
  }
}
