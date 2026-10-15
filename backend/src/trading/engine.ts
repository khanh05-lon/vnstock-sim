import {
  PHASE_LABEL,
  RULES,
  buyHoldAmount,
  calcFee,
  calcSellTax,
  isValidTick,
  stepPrice,
  tickSize,
  type BookLevel,
  type MarketMode,
  type ModifyOrderInput,
  type OrderDTO,
  type OrderType,
  type PlaceOrderInput,
  type SessionPhase,
  type Side,
  type StockInfo,
  type TradeDTO,
} from '@vss/shared';
import type { Database, Queryable } from '../db';
import { addTradingDays, skipWeekendsFor } from '../lib/calendar';
import { badRequest, notFound } from '../lib/errors';
import { toOrderDTO, toTradeDTO, type AccountRow, type HoldingRow, type OrderRow, type TradeRow } from './dto';

/** Những gì bộ khớp lệnh cần từ thị trường */
export interface MarketAccess {
  readonly opts: { mode: MarketMode };
  tradeDate: string;
  phase: SessionPhase;
  info(symbol: string): StockInfo | undefined;
  quote(symbol: string): { ref: number; ceil: number; floor: number; bids: BookLevel[]; asks: BookLevel[] } | undefined;
  consumeBook(symbol: string, takerSide: Side, qty: number, limit: number | null): { price: number; qty: number }[];
  recordTrade(symbol: string, price: number, qty: number, side: 'B' | 'S'): void;
}

export interface Notifier {
  order(userId: string, order: OrderDTO): void;
  trade(userId: string, trade: TradeDTO): void;
  account(userId: string): void;
}

export const noopNotifier: Notifier = { order() {}, trade() {}, account() {} };

interface Resting {
  id: number;
  userId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  price: number | null;
  remaining: number;
}

const OPEN = ['PENDING', 'PARTIAL'];
const fmt = (n: number) => n.toLocaleString('en-US');

const PLACE_PHASES: Record<OrderType, SessionPhase[]> = {
  LO: ['PRE_OPEN', 'ATO', 'CONTINUOUS', 'LUNCH', 'ATC'],
  MP: ['CONTINUOUS'],
  ATO: ['PRE_OPEN', 'ATO'],
  ATC: ['ATC'],
};

export class TradingEngine {
  /** Lệnh đang chờ khớp theo mã — cache để kiểm tra điều kiện khớp mà không phải truy vấn DB mỗi tick */
  private open = new Map<string, Map<number, Resting>>();

  constructor(
    private db: Database,
    private market: MarketAccess,
    private notify: Notifier,
    private opts: { settlementDays: number },
  ) {}

  /* ============================ khởi động ============================ */

  async load(): Promise<void> {
    const stale = await this.db.many<{ id: number }>(
      `SELECT id FROM orders WHERE status IN ('PENDING','PARTIAL') AND trade_date < $1`,
      [this.market.tradeDate],
    );
    for (const { id } of stale) await this.closeOrder(id, null, 'EXPIRED', 'Hết hiệu lực cuối phiên');
    const rows = await this.db.many<OrderRow>(`SELECT * FROM orders WHERE status IN ('PENDING','PARTIAL')`);
    for (const r of rows) this.track(r);
    await this.settle();
  }

  openOrderCount(): number {
    let n = 0;
    for (const m of this.open.values()) n += m.size;
    return n;
  }

  /* ============================ đặt / huỷ / sửa ============================ */

  async placeOrder(userId: string, input: PlaceOrderInput): Promise<OrderDTO> {
    const info = this.market.info(input.symbol);
    const q = this.market.quote(input.symbol);
    if (!info || !q) throw badRequest('SYMBOL', `Mã ${input.symbol} không tồn tại`);
    const { side, orderType: type, qty } = input;
    const ex = info.exchange;

    if (!RULES.orderTypes[ex].includes(type)) throw badRequest('ORDER_TYPE', `Sàn ${ex} không hỗ trợ lệnh ${type}`);
    this.assertCanPlace(type);
    if (qty % RULES.lotSize !== 0) throw badRequest('LOT', `Khối lượng phải là bội số của ${RULES.lotSize} (lô chẵn)`);
    if (qty > RULES.maxOrderQty[ex]) throw badRequest('MAX_QTY', `Khối lượng tối đa mỗi lệnh trên ${ex} là ${fmt(RULES.maxOrderQty[ex])}`);

    let price: number | null = null;
    if (type === 'LO') {
      price = input.price!;
      this.assertPrice(ex, price, q);
    }
    const holdPrice = price ?? (side === 'BUY' ? q.ceil : q.floor);
    const tradeDate = this.market.tradeDate;

    const row = await this.db.tx(async (tx) => {
      if (side === 'BUY') {
        const hold = buyHoldAmount(holdPrice, qty);
        const acct = await tx.one<AccountRow>('SELECT * FROM accounts WHERE user_id = $1 FOR UPDATE', [userId]);
        if (!acct) throw notFound('Không tìm thấy tài khoản');
        const avail = acct.cash_balance - acct.cash_hold;
        if (avail < hold) {
          throw badRequest('INSUFFICIENT_CASH', `Sức mua không đủ: cần ${fmt(hold)}đ, khả dụng ${fmt(avail)}đ`);
        }
        await tx.many('UPDATE accounts SET cash_hold = cash_hold + $2, updated_at = now() WHERE user_id = $1', [userId, hold]);
        return tx.one<OrderRow>(
          `INSERT INTO orders (user_id, symbol, side, order_type, price, hold_price, qty, status, hold_amount, trade_date)
           VALUES ($1,$2,'BUY',$3,$4,$5,$6,'PENDING',$7,$8) RETURNING *`,
          [userId, input.symbol, type, price, holdPrice, qty, hold, tradeDate],
        );
      }
      const h = await tx.one<HoldingRow>('SELECT * FROM holdings WHERE user_id = $1 AND symbol = $2 FOR UPDATE', [userId, input.symbol]);
      const avail = h?.qty_available ?? 0;
      if (avail < qty) {
        const pending = h?.qty_pending ?? 0;
        throw badRequest(
          'INSUFFICIENT_SHARES',
          pending > 0
            ? `Không đủ cổ phiếu khả dụng: khả dụng ${fmt(avail)} CP, ${fmt(pending)} CP đang chờ về (T+${this.opts.settlementDays})`
            : `Không đủ cổ phiếu khả dụng (đang có ${fmt(avail)} CP)`,
        );
      }
      await tx.many('UPDATE holdings SET qty_available = qty_available - $3, qty_hold = qty_hold + $3 WHERE user_id = $1 AND symbol = $2', [
        userId,
        input.symbol,
        qty,
      ]);
      return tx.one<OrderRow>(
        `INSERT INTO orders (user_id, symbol, side, order_type, price, hold_price, qty, status, trade_date)
         VALUES ($1,$2,'SELL',$3,$4,$5,$6,'PENDING',$7) RETURNING *`,
        [userId, input.symbol, type, price, holdPrice, qty, tradeDate],
      );
    });

    this.track(row!);
    this.notify.order(userId, toOrderDTO(row!));
    this.notify.account(userId);
    if (this.market.phase === 'CONTINUOUS' && (type === 'LO' || type === 'MP')) await this.matchBook(row!.id);
    return this.getOrder(userId, row!.id);
  }

  async cancelOrder(userId: string, id: number): Promise<OrderDTO> {
    this.assertCanAmend();
    const row = await this.closeOrder(id, userId, 'CANCELLED', null);
    if (!row) throw badRequest('NOT_CANCELLABLE', 'Lệnh đã khớp hết hoặc đã bị huỷ');
    return toOrderDTO(row);
  }

  async modifyOrder(userId: string, id: number, input: ModifyOrderInput): Promise<OrderDTO> {
    this.assertCanAmend();
    const row = await this.db.tx(async (tx) => {
      const o = await tx.one<OrderRow>('SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, userId]);
      if (!o) throw notFound('Không tìm thấy lệnh');
      if (!OPEN.includes(o.status)) throw badRequest('NOT_MODIFIABLE', 'Lệnh đã khớp hết hoặc đã bị huỷ');
      if (o.order_type !== 'LO') throw badRequest('NOT_MODIFIABLE', 'Chỉ sửa được lệnh LO');
      const info = this.market.info(o.symbol)!;
      const q = this.market.quote(o.symbol)!;
      const newPrice = input.price ?? o.price!;
      const newQty = input.qty ?? o.qty;
      if (newPrice === o.price && newQty === o.qty) throw badRequest('NO_CHANGE', 'Không có thay đổi');
      this.assertPrice(info.exchange, newPrice, q);
      if (newQty % RULES.lotSize !== 0) throw badRequest('LOT', `Khối lượng phải là bội số của ${RULES.lotSize}`);
      if (newQty <= o.filled_qty) throw badRequest('QTY', `Khối lượng mới phải lớn hơn khối lượng đã khớp (${fmt(o.filled_qty)})`);
      if (newQty > RULES.maxOrderQty[info.exchange]) throw badRequest('MAX_QTY', 'Vượt khối lượng tối đa mỗi lệnh');
      const rem = newQty - o.filled_qty;

      if (o.side === 'BUY') {
        const newHold = buyHoldAmount(newPrice, rem);
        const diff = newHold - o.hold_amount;
        const acct = await tx.one<AccountRow>('SELECT * FROM accounts WHERE user_id = $1 FOR UPDATE', [userId]);
        const avail = acct!.cash_balance - acct!.cash_hold;
        if (diff > 0 && avail < diff) throw badRequest('INSUFFICIENT_CASH', `Sức mua không đủ để sửa lệnh: cần thêm ${fmt(diff)}đ`);
        await tx.many('UPDATE accounts SET cash_hold = cash_hold + $2, updated_at = now() WHERE user_id = $1', [userId, diff]);
        return tx.one<OrderRow>(
          'UPDATE orders SET price = $2, hold_price = $2, qty = $3, hold_amount = $4, updated_at = now() WHERE id = $1 RETURNING *',
          [id, newPrice, newQty, newHold],
        );
      }
      const diffQty = newQty - o.qty;
      const h = await tx.one<HoldingRow>('SELECT * FROM holdings WHERE user_id = $1 AND symbol = $2 FOR UPDATE', [userId, o.symbol]);
      if (diffQty > 0 && (h?.qty_available ?? 0) < diffQty) throw badRequest('INSUFFICIENT_SHARES', 'Không đủ cổ phiếu khả dụng để tăng khối lượng');
      await tx.many('UPDATE holdings SET qty_available = qty_available - $3, qty_hold = qty_hold + $3 WHERE user_id = $1 AND symbol = $2', [
        userId,
        o.symbol,
        diffQty,
      ]);
      return tx.one<OrderRow>('UPDATE orders SET price = $2, hold_price = $2, qty = $3, updated_at = now() WHERE id = $1 RETURNING *', [
        id,
        newPrice,
        newQty,
      ]);
    });
    this.track(row!);
    this.notify.order(userId, toOrderDTO(row!));
    this.notify.account(userId);
    if (this.market.phase === 'CONTINUOUS') await this.matchBook(id);
    return this.getOrder(userId, id);
  }

  async getOrder(userId: string, id: number): Promise<OrderDTO> {
    const row = await this.db.one<OrderRow>('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!row) throw notFound('Không tìm thấy lệnh');
    return toOrderDTO(row);
  }

  /** Đặt lại tài khoản ảo về vốn ban đầu */
  async resetAccount(userId: string): Promise<void> {
    for (const m of this.open.values()) for (const [id, r] of m) if (r.userId === userId) m.delete(id);
    await this.db.tx(async (tx) => {
      await tx.many('DELETE FROM trades WHERE user_id = $1', [userId]);
      await tx.many('DELETE FROM transactions_ledger WHERE user_id = $1', [userId]);
      await tx.many('DELETE FROM orders WHERE user_id = $1', [userId]);
      await tx.many('DELETE FROM holdings WHERE user_id = $1', [userId]);
      await tx.many('DELETE FROM settlement_lots WHERE user_id = $1', [userId]);
      const acct = await tx.one<AccountRow>(
        'UPDATE accounts SET cash_balance = initial_capital, cash_hold = 0, updated_at = now() WHERE user_id = $1 RETURNING *',
        [userId],
      );
      await tx.many(`INSERT INTO transactions_ledger (user_id, type, amount, balance_after, note) VALUES ($1,'RESET',$2,$2,$3)`, [
        userId,
        acct!.initial_capital,
        'Đặt lại tài khoản ảo',
      ]);
    });
    this.notify.account(userId);
  }

  /* ============================ sự kiện thị trường ============================ */

  async onTick(symbols: Set<string>, trades: Map<string, { price: number; vol: number }>): Promise<void> {
    if (this.market.phase !== 'CONTINUOUS') return;
    for (const sym of symbols) {
      const book = this.open.get(sym);
      if (!book || book.size === 0) continue;
      const q = this.market.quote(sym);
      if (!q) continue;
      const t = trades.get(sym);
      for (const r of [...book.values()]) {
        if (r.price == null || (r.type !== 'LO' && r.type !== 'MP')) continue;
        if (r.side === 'BUY') {
          const ask1 = q.asks[0]?.p;
          if (ask1 && ask1 <= r.price) {
            const fills = this.market.consumeBook(sym, 'BUY', r.remaining, r.price);
            if (fills.length) await this.execute(r.id, fills, true);
          } else if (t && t.price <= r.price) {
            await this.execute(r.id, [{ price: r.price, qty: Math.min(r.remaining, t.vol) }], false);
          }
        } else {
          const bid1 = q.bids[0]?.p;
          if (bid1 && bid1 >= r.price) {
            const fills = this.market.consumeBook(sym, 'SELL', r.remaining, r.price);
            if (fills.length) await this.execute(r.id, fills, true);
          } else if (t && t.price >= r.price) {
            await this.execute(r.id, [{ price: r.price, qty: Math.min(r.remaining, t.vol) }], false);
          }
        }
      }
    }
  }

  /** Khớp lệnh phiên định kỳ: lệnh ATO/ATC và lệnh LO có giá tốt hơn giá khớp */
  async onAuction(kind: 'ATO' | 'ATC', prices: Map<string, number>): Promise<void> {
    for (const [sym, book] of this.open) {
      const price = prices.get(sym);
      if (!price) continue;
      for (const r of [...book.values()]) {
        const crosses =
          r.type === kind ||
          (r.type === 'LO' && r.price != null && (r.side === 'BUY' ? r.price >= price : r.price <= price));
        if (crosses) await this.execute(r.id, [{ price, qty: r.remaining }], false);
      }
    }
  }

  /** Cuối phiên: huỷ toàn bộ lệnh chưa khớp, giải phóng tiền/cổ phiếu phong toả */
  async expireAll(): Promise<void> {
    const rows = await this.db.many<{ id: number }>(`SELECT id FROM orders WHERE status IN ('PENDING','PARTIAL')`);
    for (const { id } of rows) await this.closeOrder(id, null, 'EXPIRED', 'Hết hiệu lực cuối phiên');
  }

  /** Thanh toán bù trừ: chuyển cổ phiếu chờ về (T+N) sang khả dụng */
  async settle(): Promise<number> {
    const users = await this.db.tx(async (tx) => {
      const lots = await tx.many<{ id: number; user_id: string; symbol: string; qty: number }>(
        'SELECT id, user_id, symbol, qty FROM settlement_lots WHERE settled = false AND settle_date <= $1 FOR UPDATE',
        [this.market.tradeDate],
      );
      for (const lot of lots) {
        await tx.many(
          'UPDATE holdings SET qty_pending = qty_pending - $3, qty_available = qty_available + $3 WHERE user_id = $1 AND symbol = $2',
          [lot.user_id, lot.symbol, lot.qty],
        );
        await tx.many('UPDATE settlement_lots SET settled = true WHERE id = $1', [lot.id]);
      }
      return new Set(lots.map((l) => l.user_id));
    });
    for (const u of users) this.notify.account(u);
    return users.size;
  }

  /* ============================ nội bộ ============================ */

  private assertCanPlace(type: OrderType) {
    if (this.market.opts.mode === 'SIMULATED_24_7') {
      if (type === 'ATO' || type === 'ATC') {
        throw badRequest('SESSION', 'Chế độ mô phỏng 24/7 chỉ có phiên khớp lệnh liên tục — hãy dùng lệnh LO hoặc MP');
      }
      return;
    }
    const ph = this.market.phase;
    if (!PLACE_PHASES[type].includes(ph)) throw badRequest('SESSION', `Không thể đặt lệnh ${type} khi thị trường đang ở trạng thái: ${PHASE_LABEL[ph]}`);
  }

  private assertCanAmend() {
    if (this.market.opts.mode === 'REAL_HOURS' && (this.market.phase === 'ATO' || this.market.phase === 'ATC')) {
      throw badRequest('SESSION', 'Không được huỷ/sửa lệnh trong phiên ATO/ATC');
    }
  }

  private assertPrice(ex: StockInfo['exchange'], price: number, q: { ceil: number; floor: number }) {
    if (!isValidTick(ex, price)) throw badRequest('TICK', `Giá ${fmt(price)} không đúng bước giá ${fmt(tickSize(ex, price))}đ`);
    if (price > q.ceil || price < q.floor) {
      throw badRequest('BAND', `Giá phải nằm trong khoảng sàn ${fmt(q.floor)} – trần ${fmt(q.ceil)}`);
    }
  }

  private track(r: OrderRow) {
    if (!OPEN.includes(r.status)) {
      this.untrack(r.symbol, r.id);
      return;
    }
    let m = this.open.get(r.symbol);
    if (!m) this.open.set(r.symbol, (m = new Map()));
    m.set(r.id, {
      id: r.id,
      userId: r.user_id,
      symbol: r.symbol,
      side: r.side,
      type: r.order_type,
      price: r.price,
      remaining: r.qty - r.filled_qty,
    });
  }

  private untrack(symbol: string, id: number) {
    this.open.get(symbol)?.delete(id);
  }

  private findResting(id: number): Resting | undefined {
    for (const m of this.open.values()) {
      const r = m.get(id);
      if (r) return r;
    }
    return undefined;
  }

  /** Khớp ngay với sổ lệnh hiện tại (khi đặt/sửa lệnh trong phiên liên tục) */
  private async matchBook(id: number) {
    const r = this.findResting(id);
    if (!r) return;
    const isMarket = r.type === 'MP' && r.price == null;
    const fills = this.market.consumeBook(r.symbol, r.side, r.remaining, isMarket ? null : r.price);
    if (fills.length) await this.execute(r.id, fills, true);
    if (!isMarket) return;
    const still = this.findResting(id);
    if (!still) return;
    if (!fills.length) {
      await this.closeOrder(id, null, 'CANCELLED', 'Lệnh MP không có khối lượng đối ứng');
      return;
    }
    // Phần còn lại của lệnh MP chuyển thành LO cao/thấp hơn 1 bước giá so với giá khớp cuối
    const q = this.market.quote(r.symbol)!;
    const ex = this.market.info(r.symbol)!.exchange;
    const lastPrice = fills[fills.length - 1].price;
    const conv = r.side === 'BUY' ? Math.min(q.ceil, stepPrice(ex, lastPrice, 1)) : Math.max(q.floor, stepPrice(ex, lastPrice, -1));
    const row = await this.db.one<OrderRow>('UPDATE orders SET price = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, conv]);
    if (row) {
      this.track(row);
      this.notify.order(row.user_id, toOrderDTO(row));
    }
  }

  /** Thực hiện các lần khớp cho 1 lệnh; record = true nếu giao dịch làm thay đổi giá thị trường */
  private async execute(id: number, fills: { price: number; qty: number }[], record: boolean) {
    const res = await this.db.tx((tx) => this.applyFills(tx, id, fills));
    if (!res) return;
    const { order, trades } = res;
    if (record) for (const t of trades) this.market.recordTrade(t.symbol, t.price, t.qty, t.side === 'BUY' ? 'B' : 'S');
    this.track(order);
    this.notify.order(order.user_id, toOrderDTO(order));
    for (const t of trades) this.notify.trade(order.user_id, toTradeDTO(t));
    this.notify.account(order.user_id);
  }

  private async applyFills(tx: Queryable, id: number, fills: { price: number; qty: number }[]) {
    const o = await tx.one<OrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
    if (!o || !OPEN.includes(o.status)) return null;
    const acct = (await tx.one<AccountRow>('SELECT * FROM accounts WHERE user_id = $1 FOR UPDATE', [o.user_id]))!;
    let h = await tx.one<HoldingRow>('SELECT * FROM holdings WHERE user_id = $1 AND symbol = $2 FOR UPDATE', [o.user_id, o.symbol]);

    let remaining = o.qty - o.filled_qty;
    let holdLeft = o.hold_amount;
    let filled = o.filled_qty;
    let notional = o.avg_fill_price * o.filled_qty;
    let balance = acct.cash_balance;
    let cashHold = acct.cash_hold;
    const trades: TradeRow[] = [];
    const settleNow = this.opts.settlementDays <= 0;

    const ledger = async (type: string, amount: number, note: string) => {
      balance += amount;
      await tx.many(
        'INSERT INTO transactions_ledger (user_id, type, amount, balance_after, order_id, note) VALUES ($1,$2,$3,$4,$5,$6)',
        [o.user_id, type, amount, balance, o.id, note],
      );
    };

    for (const f of fills) {
      const q = Math.min(f.qty, remaining);
      if (q <= 0) break;
      const value = f.price * q;
      const fee = calcFee(value);
      const desc = `${q.toLocaleString('en-US')} ${o.symbol} giá ${f.price.toLocaleString('en-US')}`;

      if (o.side === 'BUY') {
        const release = q === remaining ? holdLeft : Math.min(holdLeft, buyHoldAmount(o.hold_price, q));
        holdLeft -= release;
        cashHold -= release;
        await ledger('BUY', -value, `Mua ${desc}`);
        await ledger('FEE', -fee, `Phí mua lệnh #${o.id}`);
        if (!h) {
          h = (await tx.one<HoldingRow>('INSERT INTO holdings (user_id, symbol) VALUES ($1, $2) RETURNING *', [o.user_id, o.symbol]))!;
        }
        h.qty_total += q;
        h.total_cost += value + fee;
        if (settleNow) h.qty_available += q;
        else {
          h.qty_pending += q;
          const settleDate = addTradingDays(this.market.tradeDate, this.opts.settlementDays, skipWeekendsFor(this.market.opts.mode));
          await tx.many('INSERT INTO settlement_lots (user_id, symbol, qty, settle_date) VALUES ($1,$2,$3,$4)', [o.user_id, o.symbol, q, settleDate]);
        }
        const t = await tx.one<TradeRow>(
          `INSERT INTO trades (order_id, user_id, symbol, side, price, qty, value, fee) VALUES ($1,$2,$3,'BUY',$4,$5,$6,$7) RETURNING *`,
          [o.id, o.user_id, o.symbol, f.price, q, value, fee],
        );
        trades.push(t!);
      } else {
        if (!h || h.qty_hold < q) throw new Error(`Dữ liệu danh mục không nhất quán cho lệnh #${o.id}`);
        const tax = calcSellTax(value);
        const costPortion = Math.round((h.total_cost * q) / h.qty_total);
        h.qty_total -= q;
        h.qty_hold -= q;
        h.total_cost -= costPortion;
        await ledger('SELL', value, `Bán ${desc}`);
        await ledger('FEE', -fee, `Phí bán lệnh #${o.id}`);
        await ledger('TAX', -tax, `Thuế TNCN 0,1% lệnh #${o.id}`);
        const pnl = value - fee - tax - costPortion;
        const t = await tx.one<TradeRow>(
          `INSERT INTO trades (order_id, user_id, symbol, side, price, qty, value, fee, tax, realized_pnl)
           VALUES ($1,$2,$3,'SELL',$4,$5,$6,$7,$8,$9) RETURNING *`,
          [o.id, o.user_id, o.symbol, f.price, q, value, fee, tax, pnl],
        );
        trades.push(t!);
      }
      remaining -= q;
      filled += q;
      notional += f.price * q;
    }
    if (!trades.length) return null;

    await tx.many('UPDATE accounts SET cash_balance = $2, cash_hold = $3, updated_at = now() WHERE user_id = $1', [o.user_id, balance, cashHold]);
    if (h) {
      if (h.qty_total === 0) {
        await tx.many('DELETE FROM holdings WHERE user_id = $1 AND symbol = $2', [o.user_id, o.symbol]);
      } else {
        await tx.many(
          `UPDATE holdings SET qty_total = $3, qty_available = $4, qty_hold = $5, qty_pending = $6, total_cost = $7
           WHERE user_id = $1 AND symbol = $2`,
          [o.user_id, o.symbol, h.qty_total, h.qty_available, h.qty_hold, h.qty_pending, h.total_cost],
        );
      }
    }
    const order = await tx.one<OrderRow>(
      `UPDATE orders SET filled_qty = $2, avg_fill_price = $3, status = $4, hold_amount = $5, updated_at = now() WHERE id = $1 RETURNING *`,
      [o.id, filled, Math.round(notional / filled), remaining === 0 ? 'FILLED' : 'PARTIAL', holdLeft],
    );
    return { order: order!, trades };
  }

  /** Đóng lệnh (huỷ / hết hiệu lực) và giải phóng phong toả. userId = null cho thao tác hệ thống. */
  private async closeOrder(id: number, userId: string | null, status: 'CANCELLED' | 'EXPIRED', reason: string | null) {
    const row = await this.db.tx(async (tx) => {
      const o = userId
        ? await tx.one<OrderRow>('SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, userId])
        : await tx.one<OrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
      if (!o) {
        if (userId) throw notFound('Không tìm thấy lệnh');
        return null;
      }
      if (!OPEN.includes(o.status)) return null;
      if (o.side === 'BUY') {
        await tx.many('UPDATE accounts SET cash_hold = cash_hold - $2, updated_at = now() WHERE user_id = $1', [o.user_id, o.hold_amount]);
      } else {
        const rem = o.qty - o.filled_qty;
        await tx.many('UPDATE holdings SET qty_hold = qty_hold - $3, qty_available = qty_available + $3 WHERE user_id = $1 AND symbol = $2', [
          o.user_id,
          o.symbol,
          rem,
        ]);
      }
      return tx.one<OrderRow>(
        'UPDATE orders SET status = $2, hold_amount = 0, reject_reason = COALESCE($3, reject_reason), updated_at = now() WHERE id = $1 RETURNING *',
        [id, status, reason],
      );
    });
    if (row) {
      this.untrack(row.symbol, row.id);
      this.notify.order(row.user_id, toOrderDTO(row));
      this.notify.account(row.user_id);
    }
    return row ?? null;
  }
}
