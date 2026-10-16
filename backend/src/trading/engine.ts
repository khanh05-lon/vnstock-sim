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
  type OrderSource,
  type OrderType,
  type PlaceOrderInput,
  type SessionPhase,
  type Side,
  type StockInfo,
  type TradeDTO,
} from '@vss/shared';
import type { Database, Queryable } from '../db';
import { GTD_MAX_DAYS } from '@vss/shared';
import { addDays, addTradingDays, skipWeekendsFor } from '../lib/calendar';
import { badRequest, notFound } from '../lib/errors';
import { advanceCash, planBuy, previewAdvance, repayDebt, type MoneyRow } from './cash';
import { dateOnly, toOrderDTO, toTradeDTO, type AccountRow, type HoldingRow, type OrderRow, type TradeRow } from './dto';

/** Những gì bộ khớp lệnh cần từ thị trường */
export interface MarketAccess {
  readonly opts: { mode: MarketMode };
  tradeDate: string;
  phase: SessionPhase;
  info(symbol: string): StockInfo | undefined;
  quote(symbol: string): { ref: number; ceil: number; floor: number; bids: BookLevel[]; asks: BookLevel[] } | undefined;
  consumeBook(symbol: string, takerSide: Side, qty: number, limit: number | null): { price: number; qty: number }[];
  recordTrade(symbol: string, price: number, qty: number, side: 'B' | 'S'): void;
  /** Giá định giá danh mục (khớp gần nhất, chưa khớp thì tham chiếu) — dùng kiểm tra tỷ lệ ký quỹ */
  markPrice?(symbol: string): number;
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
  /** Lô lẻ (1–99 CP): khớp riêng, không ăn sổ lệnh lô chẵn và không làm thay đổi giá thị trường */
  odd: boolean;
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

  /** Dọn dữ liệu của tính năng khác khi tài khoản bị đặt lại / khoá / xoá (vd. huỷ lệnh điều kiện) */
  readonly userCleanup: ((userId: string, reason: string) => Promise<unknown>)[] = [];

  /** Cờ vận hành do quản trị viên đặt: ngừng nhận lệnh + ngừng khớp lệnh (toàn hệ thống hoặc theo mã) */
  readonly control = { haltAll: false, haltReason: '', haltedSymbols: new Set<string>() };

  constructor(
    private db: Database,
    private market: MarketAccess,
    private notify: Notifier,
    private opts: { settlementDays: number },
  ) {}

  /* ============================ khởi động ============================ */

  async load(): Promise<void> {
    // Lệnh của phiên trước: lệnh nhiều ngày còn hiệu lực được chuyển sang phiên này, còn lại hết hiệu lực
    await this.carryOver();
    const rows = await this.db.many<OrderRow>(`SELECT * FROM orders WHERE status IN ('PENDING','PARTIAL')`);
    for (const r of rows) this.track(r);
    await this.settle();
  }

  /** Nạp lại toàn bộ lệnh đang chờ từ CSDL (sau khi khôi phục dữ liệu) */
  async reload(): Promise<void> {
    this.open.clear();
    await this.load();
  }

  openOrderCount(): number {
    let n = 0;
    for (const m of this.open.values()) n += m.size;
    return n;
  }

  /* ============================ đặt / huỷ / sửa ============================ */

  async placeOrder(userId: string, input: PlaceOrderInput, opts: { source?: OrderSource; conditionalId?: number } = {}): Promise<OrderDTO> {
    const info = this.market.info(input.symbol);
    const q = this.market.quote(input.symbol);
    if (!info || !q) throw badRequest('SYMBOL', `Mã ${input.symbol} không tồn tại`);
    this.assertNotHalted(input.symbol);
    const { side, orderType: type, qty } = input;
    const ex = info.exchange;

    if (!RULES.orderTypes[ex].includes(type)) throw badRequest('ORDER_TYPE', `Sàn ${ex} không hỗ trợ lệnh ${type}`);
    if (info.warrant && this.market.tradeDate > info.warrant.lastTradingDate) {
      throw badRequest('CW_EXPIRED', `Chứng quyền ${info.symbol} đã qua ngày giao dịch cuối cùng (${info.warrant.lastTradingDate}), chờ thanh toán khi đáo hạn`);
    }
    this.assertCanPlace(type);
    const odd = qty < RULES.lotSize;
    if (odd) this.assertOddLot(info, type);
    else if (qty % RULES.lotSize !== 0) {
      throw badRequest('LOT', `Lô chẵn phải là bội số của ${RULES.lotSize}; phần dưới ${RULES.lotSize} CP đặt riêng thành lệnh lô lẻ`);
    }
    if (qty > RULES.maxOrderQty[ex]) throw badRequest('MAX_QTY', `Khối lượng tối đa mỗi lệnh trên ${ex} là ${fmt(RULES.maxOrderQty[ex])}`);
    const validUntil = this.validUntilOf(input.validUntil);
    const source = opts.source ?? 'USER';

    let price: number | null = null;
    if (type === 'LO') {
      price = input.price!;
      this.assertPrice(info, price, q);
    }
    const holdPrice = price ?? (side === 'BUY' ? q.ceil : q.floor);
    const tradeDate = this.market.tradeDate;
    // Chốt biểu phí / thuế tại thời điểm đặt lệnh: quản trị viên đổi biểu phí không ảnh hưởng lệnh đã đặt
    const feeRate = RULES.feeRate;
    const taxRate = RULES.sellTaxRate;

    const row = await this.db.tx(async (tx) => {
      if (side === 'BUY') {
        const hold = buyHoldAmount(holdPrice, qty, feeRate);
        const plan = await this.planBuyTx(tx, userId, info, hold, qty * holdPrice);
        await tx.many('UPDATE accounts SET cash_hold = cash_hold + $2, loan_hold = loan_hold + $3, updated_at = now() WHERE user_id = $1', [
          userId,
          plan.cashPart,
          plan.loanPart,
        ]);
        return tx.one<OrderRow>(
          `INSERT INTO orders (user_id, symbol, side, order_type, price, hold_price, qty, status, hold_amount, trade_date, fee_rate, tax_rate,
                               valid_until, source, conditional_id, loan_hold)
           VALUES ($1,$2,'BUY',$3,$4,$5,$6,'PENDING',$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
          [userId, input.symbol, type, price, holdPrice, qty, hold, tradeDate, feeRate, taxRate, validUntil, source, opts.conditionalId ?? null, plan.loanPart],
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
        `INSERT INTO orders (user_id, symbol, side, order_type, price, hold_price, qty, status, trade_date, fee_rate, tax_rate,
                             valid_until, source, conditional_id)
         VALUES ($1,$2,'SELL',$3,$4,$5,$6,'PENDING',$7,$8,$9,$10,$11,$12) RETURNING *`,
        [userId, input.symbol, type, price, holdPrice, qty, tradeDate, feeRate, taxRate, validUntil, source, opts.conditionalId ?? null],
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
      this.assertNotHalted(o.symbol);
      const info = this.market.info(o.symbol)!;
      const q = this.market.quote(o.symbol)!;
      const newPrice = input.price ?? o.price!;
      const newQty = input.qty ?? o.qty;
      if (newPrice === o.price && newQty === o.qty) throw badRequest('NO_CHANGE', 'Không có thay đổi');
      this.assertPrice(info, newPrice, q);
      if (o.qty < RULES.lotSize) {
        if (newQty >= RULES.lotSize) throw badRequest('ODD_LOT', `Lệnh lô lẻ chỉ sửa được khối lượng dưới ${RULES.lotSize} CP`);
      } else if (newQty % RULES.lotSize !== 0) throw badRequest('LOT', `Khối lượng phải là bội số của ${RULES.lotSize}`);
      if (newQty <= o.filled_qty) throw badRequest('QTY', `Khối lượng mới phải lớn hơn khối lượng đã khớp (${fmt(o.filled_qty)})`);
      if (newQty > RULES.maxOrderQty[info.exchange]) throw badRequest('MAX_QTY', 'Vượt khối lượng tối đa mỗi lệnh');
      const rem = newQty - o.filled_qty;

      if (o.side === 'BUY') {
        const newHold = buyHoldAmount(newPrice, rem, o.fee_rate ?? RULES.feeRate);
        // Phần vay giữ nguyên tối đa như cũ; phần chênh lệch lấy từ tiền mặt khả dụng
        const newLoan = Math.min(o.loan_hold, newHold);
        const cashDiff = newHold - newLoan - (o.hold_amount - o.loan_hold);
        const acct = await tx.one<AccountRow>('SELECT * FROM accounts WHERE user_id = $1 FOR UPDATE', [userId]);
        const avail = acct!.cash_balance - acct!.cash_hold;
        if (cashDiff > 0 && avail < cashDiff) throw badRequest('INSUFFICIENT_CASH', `Sức mua không đủ để sửa lệnh: cần thêm ${fmt(cashDiff)}đ`);
        await tx.many('UPDATE accounts SET cash_hold = cash_hold + $2, loan_hold = loan_hold + $3, updated_at = now() WHERE user_id = $1', [
          userId,
          cashDiff,
          newLoan - o.loan_hold,
        ]);
        return tx.one<OrderRow>(
          'UPDATE orders SET price = $2, hold_price = $2, qty = $3, hold_amount = $4, loan_hold = $5, updated_at = now() WHERE id = $1 RETURNING *',
          [id, newPrice, newQty, newHold, newLoan],
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

  /** Quản trị viên huỷ hộ 1 lệnh (kèm lý do hiển thị cho nhà đầu tư) */
  async adminCancel(id: number, reason: string): Promise<OrderDTO> {
    const row = await this.closeOrder(id, null, 'CANCELLED', reason);
    if (!row) throw badRequest('NOT_CANCELLABLE', 'Lệnh đã khớp hết hoặc đã bị huỷ');
    return toOrderDTO(row);
  }

  /** Huỷ mọi lệnh đang chờ của 1 mã (huỷ niêm yết, sự kiện quyền) */
  async cancelAllForSymbol(symbol: string, reason: string): Promise<number> {
    const rows = await this.db.many<{ id: number }>(`SELECT id FROM orders WHERE symbol = $1 AND status IN ('PENDING','PARTIAL')`, [symbol]);
    let n = 0;
    for (const { id } of rows) if (await this.closeOrder(id, null, 'CANCELLED', reason)) n++;
    return n;
  }

  /** Huỷ mọi lệnh đang chờ của 1 người dùng (dùng khi khoá tài khoản) */
  async cancelAllForUser(userId: string, reason: string): Promise<number> {
    for (const fn of this.userCleanup) await fn(userId, reason);
    const rows = await this.db.many<{ id: number }>(`SELECT id FROM orders WHERE user_id = $1 AND status IN ('PENDING','PARTIAL')`, [userId]);
    let n = 0;
    for (const { id } of rows) if (await this.closeOrder(id, null, 'CANCELLED', reason)) n++;
    return n;
  }

  async getOrder(userId: string, id: number): Promise<OrderDTO> {
    const row = await this.db.one<OrderRow>('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!row) throw notFound('Không tìm thấy lệnh');
    return toOrderDTO(row);
  }

  /** Đặt lại tài khoản ảo về vốn ban đầu */
  async resetAccount(userId: string): Promise<void> {
    for (const fn of this.userCleanup) await fn(userId, 'Đặt lại tài khoản');
    for (const m of this.open.values()) for (const [id, r] of m) if (r.userId === userId) m.delete(id);
    await this.db.tx(async (tx) => {
      await tx.many('DELETE FROM trades WHERE user_id = $1', [userId]);
      await tx.many('DELETE FROM transactions_ledger WHERE user_id = $1', [userId]);
      await tx.many('DELETE FROM orders WHERE user_id = $1', [userId]);
      await tx.many('DELETE FROM holdings WHERE user_id = $1', [userId]);
      await tx.many('DELETE FROM settlement_lots WHERE user_id = $1', [userId]);
      await tx.many('DELETE FROM nav_daily WHERE user_id = $1', [userId]);
      await tx.many('DELETE FROM conditional_orders WHERE user_id = $1', [userId]);
      await tx.many('DELETE FROM cash_settlements WHERE user_id = $1', [userId]);
      await tx.many('DELETE FROM ca_entitlements WHERE user_id = $1', [userId]);
      const acct = await tx.one<AccountRow>(
        `UPDATE accounts SET cash_balance = initial_capital, cash_hold = 0, contributed = initial_capital, cash_pending = 0, loan_balance = 0,
           loan_interest = 0, loan_hold = 0, margin_status = 'NORMAL', margin_call_at = NULL, deposit_interest_accrued = 0, updated_at = now()
         WHERE user_id = $1 RETURNING *`,
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
    if (this.market.phase !== 'CONTINUOUS' || this.control.haltAll) return;
    for (const sym of symbols) {
      if (this.control.haltedSymbols.has(sym)) continue;
      const book = this.open.get(sym);
      if (!book || book.size === 0) continue;
      const q = this.market.quote(sym);
      if (!q) continue;
      const t = trades.get(sym);
      for (const r of [...book.values()]) {
        if (r.price == null || (r.type !== 'LO' && r.type !== 'MP')) continue;
        if (r.odd) {
          await this.matchOdd(r, q, trades.get(sym));
          continue;
        }
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
        // lô lẻ không tham gia phiên định kỳ
        if (r.odd) continue;
        const crosses =
          r.type === kind ||
          (r.type === 'LO' && r.price != null && (r.side === 'BUY' ? r.price >= price : r.price <= price));
        if (crosses) await this.execute(r.id, [{ price, qty: r.remaining }], false);
      }
    }
  }

  /** Cuối phiên: huỷ lệnh trong ngày chưa khớp (giải phóng tiền/cổ phiếu phong toả); lệnh nhiều ngày còn hạn được giữ lại */
  async expireAll(): Promise<void> {
    const rows = await this.db.many<{ id: number }>(
      `SELECT id FROM orders WHERE status IN ('PENDING','PARTIAL') AND (valid_until IS NULL OR valid_until <= $1)`,
      [this.market.tradeDate],
    );
    for (const { id } of rows) await this.closeOrder(id, null, 'EXPIRED', 'Hết hiệu lực cuối phiên');
  }

  /**
   * Đầu phiên mới: lệnh nhiều ngày còn hiệu lực được chuyển sang phiên mới (giữ nguyên phong toả) nếu giá đặt
   * vẫn nằm trong biên độ của phiên mới; lệnh trong ngày hoặc giá ngoài biên độ thì hết hiệu lực.
   */
  async carryOver(): Promise<number> {
    const td = this.market.tradeDate;
    const rows = await this.db.many<OrderRow>(`SELECT * FROM orders WHERE status IN ('PENDING','PARTIAL') AND trade_date < $1 ORDER BY id`, [td]);
    let carried = 0;
    for (const o of rows) {
      const q = this.market.quote(o.symbol);
      let reason: string | null = 'Hết hiệu lực cuối phiên';
      if (o.valid_until && dateOnly(o.valid_until) >= td && o.order_type === 'LO' && o.price != null) {
        if (!q) reason = `Mã ${o.symbol} không còn giao dịch`;
        else if (o.price > q.ceil || o.price < q.floor) reason = `Giá đặt ${fmt(o.price)} ngoài biên độ phiên ${td} (${fmt(q.floor)} – ${fmt(q.ceil)})`;
        else reason = null;
      }
      if (reason) {
        this.untrack(o.symbol, o.id);
        await this.closeOrder(o.id, null, 'EXPIRED', reason);
        continue;
      }
      const row = await this.db.one<OrderRow>('UPDATE orders SET trade_date = $2, updated_at = now() WHERE id = $1 RETURNING *', [o.id, td]);
      if (row) {
        this.track(row);
        this.notify.order(row.user_id, toOrderDTO(row));
        carried++;
      }
    }
    return carried;
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
      // Tiền bán chứng khoán về tài khoản (phần chưa ứng trước), sau đó tự động trả nợ ký quỹ
      const cash = await tx.many<{ id: number; user_id: string; symbol: string; amount: number; advanced: number; trade_date: string | Date }>(
        'SELECT * FROM cash_settlements WHERE settled = false AND settle_date <= $1 ORDER BY id FOR UPDATE',
        [this.market.tradeDate],
      );
      const paidUsers = new Set<string>();
      for (const c of cash) {
        const rest = Number(c.amount) - Number(c.advanced);
        if (rest > 0) {
          const a = (await tx.one<{ cash_balance: number }>('SELECT cash_balance FROM accounts WHERE user_id = $1 FOR UPDATE', [c.user_id]))!;
          const bal = a.cash_balance + rest;
          await tx.many('UPDATE accounts SET cash_balance = $2, cash_pending = cash_pending - $3, updated_at = now() WHERE user_id = $1', [c.user_id, bal, rest]);
          await tx.many(`INSERT INTO transactions_ledger (user_id, type, amount, balance_after, note) VALUES ($1,'SELL',$2,$3,$4)`, [
            c.user_id,
            rest,
            bal,
            `Tiền bán ${c.symbol} ngày ${dateOnly(c.trade_date)} về tài khoản (đã trừ phí, thuế${Number(c.advanced) ? ', phần đã ứng trước' : ''})`,
          ]);
        }
        await tx.many('UPDATE cash_settlements SET settled = true WHERE id = $1', [c.id]);
        paidUsers.add(c.user_id);
      }
      for (const u of paidUsers) await repayDebt(tx, u);
      return new Set([...lots.map((l) => l.user_id), ...paidUsers]);
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

  /**
   * Nguồn tiền cho lệnh mua (trong transaction đã khoá tài khoản): tiền mặt → ứng trước tiền bán chờ về
   * (thực hiện ngay, có phí) → vay ký quỹ. Kiểm tra tỷ lệ ký quỹ sau mua ≥ tỷ lệ ban đầu.
   */
  private async planBuyTx(tx: Queryable, userId: string, info: StockInfo, hold: number, value: number) {
    const acct = await tx.one<MoneyRow>('SELECT * FROM accounts WHERE user_id = $1 FOR UPDATE', [userId]);
    if (!acct) throw notFound('Không tìm thấy tài khoản');
    const td = this.market.tradeDate;
    const avail = acct.cash_balance - acct.cash_hold;
    const adv = acct.auto_advance && avail < hold ? await previewAdvance(tx, userId, td) : { maxNet: 0 };
    let stock: number | null = null;
    const plan = planBuy({
      hold,
      avail,
      advanceableNet: adv.maxNet,
      autoAdvance: acct.auto_advance,
      marginEnabled: acct.margin_enabled,
      symbolRatio: info.marginRatio ?? 0,
      creditAvail: Number(acct.credit_limit) - Number(acct.loan_balance) - Number(acct.loan_hold),
      ratioOk: () => true,
    });
    if ('error' in plan) throw badRequest(plan.error, plan.message);
    if (plan.loanPart > 0) {
      // Tỷ lệ ký quỹ dự kiến sau khi lệnh khớp hết (tiền đang giữ cho lệnh khác coi như đã chi)
      const holds = await tx.many<{ symbol: string; qty_total: number }>('SELECT symbol, qty_total FROM holdings WHERE user_id = $1', [userId]);
      stock = holds.reduce((s, h) => s + h.qty_total * (this.market.markPrice?.(h.symbol) ?? this.market.quote(h.symbol)?.ref ?? 0), 0) + value;
      const cashLeft = acct.cash_balance - acct.cash_hold - plan.cashPart + plan.advanceNet;
      const debt = Number(acct.loan_balance) + Number(acct.loan_interest) + Number(acct.loan_hold) + plan.loanPart;
      const netDebt = Math.max(0, debt - cashLeft - Number(acct.cash_pending));
      const ratio = stock > 0 ? (stock - netDebt) / stock : 0;
      if (ratio < RULES.margin.initialRatio) {
        throw badRequest('MARGIN_RATIO', `Lệnh làm tỷ lệ ký quỹ còn ${(ratio * 100).toFixed(1)}%, dưới mức ban đầu ${Math.round(RULES.margin.initialRatio * 100)}% — giảm khối lượng hoặc nộp thêm tiền`);
      }
    }
    if (plan.advanceNet > 0) await advanceCash(tx, userId, plan.advanceNet, td);
    return plan;
  }

  /** Lô lẻ: chỉ lệnh LO, không áp dụng trái phiếu; ở chế độ giờ thật chỉ nhận trong phiên liên tục */
  private assertOddLot(info: StockInfo, type: OrderType) {
    if (info.type === 'BOND') throw badRequest('LOT', `Trái phiếu giao dịch theo lô ${RULES.lotSize}`);
    if (type !== 'LO') throw badRequest('ODD_LOT', `Lô lẻ (1–${RULES.lotSize - 1} CP) chỉ đặt được lệnh LO`);
    if (this.market.opts.mode === 'REAL_HOURS' && !['CONTINUOUS', 'LUNCH'].includes(this.market.phase)) {
      throw badRequest('SESSION', 'Lô lẻ chỉ giao dịch trong phiên khớp lệnh liên tục (9:15–11:30, 13:00–14:30)');
    }
  }

  /** Ngày hiệu lực của lệnh nhiều ngày (null = lệnh trong ngày) */
  private validUntilOf(v: string | null | undefined): string | null {
    if (!v) return null;
    const td = this.market.tradeDate;
    if (v < td) throw badRequest('VALID_UNTIL', 'Ngày hiệu lực đã qua');
    if (v > addDays(td, GTD_MAX_DAYS)) throw badRequest('VALID_UNTIL', `Lệnh nhiều ngày có hiệu lực tối đa ${GTD_MAX_DAYS} ngày`);
    return v === td ? null : v;
  }

  /**
   * Lô lẻ khớp trên bảng lô lẻ riêng (mô phỏng): lệnh có giá tốt hơn giá chào tốt nhất khớp ngay ở giá chào đó,
   * hoặc khớp ở giá đặt khi thị trường giao dịch chạm giá. Không ăn sổ lệnh lô chẵn, không ghi vào bảng giá.
   */
  private async matchOdd(r: Resting, q: { bids: BookLevel[]; asks: BookLevel[] }, t?: { price: number; vol: number }) {
    if (r.price == null) return;
    if (r.side === 'BUY') {
      const ask1 = q.asks[0]?.p;
      if (ask1 && ask1 <= r.price) await this.execute(r.id, [{ price: ask1, qty: r.remaining }], false);
      else if (t && t.price <= r.price) await this.execute(r.id, [{ price: r.price, qty: r.remaining }], false);
    } else {
      const bid1 = q.bids[0]?.p;
      if (bid1 && bid1 >= r.price) await this.execute(r.id, [{ price: bid1, qty: r.remaining }], false);
      else if (t && t.price >= r.price) await this.execute(r.id, [{ price: r.price, qty: r.remaining }], false);
    }
  }

  private assertNotHalted(symbol: string) {
    if (this.control.haltAll) {
      throw badRequest('HALTED', `Hệ thống đang tạm ngừng nhận lệnh${this.control.haltReason ? `: ${this.control.haltReason}` : ''}`);
    }
    if (this.control.haltedSymbols.has(symbol)) throw badRequest('SYMBOL_HALTED', `Mã ${symbol} đang bị tạm ngừng giao dịch`);
  }

  private assertCanAmend() {
    if (this.market.opts.mode === 'REAL_HOURS' && (this.market.phase === 'ATO' || this.market.phase === 'ATC')) {
      throw badRequest('SESSION', 'Không được huỷ/sửa lệnh trong phiên ATO/ATC');
    }
  }

  private assertPrice(info: StockInfo, price: number, q: { ceil: number; floor: number }) {
    if (!isValidTick(info, price)) throw badRequest('TICK', `Giá ${fmt(price)} không đúng bước giá ${fmt(tickSize(info, price))}đ`);
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
      odd: r.qty < RULES.lotSize,
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
    if (r.odd) {
      const q = this.market.quote(r.symbol);
      if (q) await this.matchOdd(r, q);
      return;
    }
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
    const ex = this.market.info(r.symbol)!;
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
    let loanHoldLeft = o.loan_hold ?? 0;
    let filled = o.filled_qty;
    let notional = o.avg_fill_price * o.filled_qty;
    let balance = acct.cash_balance;
    let cashHold = acct.cash_hold;
    let loanHold = acct.loan_hold ?? 0;
    let loanBalance = acct.loan_balance ?? 0;
    let cashPending = acct.cash_pending ?? 0;
    const trades: TradeRow[] = [];
    const settleNow = this.opts.settlementDays <= 0;
    const settleDate = addTradingDays(this.market.tradeDate, this.opts.settlementDays, skipWeekendsFor(this.market.opts.mode));

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
      const fee = calcFee(value, o.fee_rate ?? RULES.feeRate);
      const desc = `${q.toLocaleString('en-US')} ${o.symbol} giá ${f.price.toLocaleString('en-US')}`;

      if (o.side === 'BUY') {
        const release = q === remaining ? holdLeft : Math.min(holdLeft, buyHoldAmount(o.hold_price, q, o.fee_rate ?? RULES.feeRate));
        // Phần giải phóng chia theo tỷ lệ tiền mặt / tiền vay đã giữ cho lệnh
        const loanRel = q === remaining ? loanHoldLeft : holdLeft > 0 ? Math.min(loanHoldLeft, Math.round((release * loanHoldLeft) / holdLeft)) : 0;
        const cashRel = release - loanRel;
        holdLeft -= release;
        loanHoldLeft -= loanRel;
        cashHold -= cashRel;
        loanHold -= loanRel;
        // Trả bằng tiền mặt trước, phần còn lại giải ngân vay ký quỹ
        const cost = value + fee;
        const loanUse = Math.max(0, cost - cashRel);
        if (loanUse > 0) {
          loanBalance += loanUse;
          await ledger('LOAN', loanUse, `Giải ngân vay ký quỹ mua ${desc}`);
        }
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
          await tx.many('INSERT INTO settlement_lots (user_id, symbol, qty, settle_date) VALUES ($1,$2,$3,$4)', [o.user_id, o.symbol, q, settleDate]);
        }
        const t = await tx.one<TradeRow>(
          `INSERT INTO trades (order_id, user_id, symbol, side, price, qty, value, fee) VALUES ($1,$2,$3,'BUY',$4,$5,$6,$7) RETURNING *`,
          [o.id, o.user_id, o.symbol, f.price, q, value, fee],
        );
        trades.push(t!);
      } else {
        if (!h || h.qty_hold < q) throw new Error(`Dữ liệu danh mục không nhất quán cho lệnh #${o.id}`);
        const taxRate = o.tax_rate ?? RULES.sellTaxRate;
        const tax = calcSellTax(value, taxRate);
        const costPortion = Math.round((h.total_cost * q) / h.qty_total);
        h.qty_total -= q;
        h.qty_hold -= q;
        h.total_cost -= costPortion;
        if (settleNow) {
          await ledger('SELL', value, `Bán ${desc}`);
          await ledger('FEE', -fee, `Phí bán lệnh #${o.id}`);
          await ledger('TAX', -tax, `Thuế TNCN ${(taxRate * 100).toLocaleString('vi-VN')}% lệnh #${o.id}`);
        } else {
          // Tiền bán (đã trừ phí, thuế) chờ về tài khoản sau T+N — có thể ứng trước
          const net = value - fee - tax;
          cashPending += net;
          await tx.many(
            'INSERT INTO cash_settlements (user_id, order_id, symbol, amount, trade_date, settle_date) VALUES ($1,$2,$3,$4,$5,$6)',
            [o.user_id, o.id, o.symbol, net, this.market.tradeDate, settleDate],
          );
        }
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

    await tx.many(
      'UPDATE accounts SET cash_balance = $2, cash_hold = $3, loan_hold = $4, loan_balance = $5, cash_pending = $6, updated_at = now() WHERE user_id = $1',
      [o.user_id, balance, cashHold, loanHold, loanBalance, cashPending],
    );
    // Bán khi SETTLEMENT_DAYS=0: tiền về ngay → tự trả nợ ký quỹ
    if (o.side === 'SELL' && settleNow && (loanBalance > 0 || (acct.loan_interest ?? 0) > 0)) await repayDebt(tx, o.user_id);
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
      `UPDATE orders SET filled_qty = $2, avg_fill_price = $3, status = $4, hold_amount = $5, loan_hold = $6, updated_at = now() WHERE id = $1 RETURNING *`,
      [o.id, filled, Math.round(notional / filled), remaining === 0 ? 'FILLED' : 'PARTIAL', holdLeft, loanHoldLeft],
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
        const loan = o.loan_hold ?? 0;
        await tx.many('UPDATE accounts SET cash_hold = cash_hold - $2, loan_hold = loan_hold - $3, updated_at = now() WHERE user_id = $1', [
          o.user_id,
          o.hold_amount - loan,
          loan,
        ]);
      } else {
        const rem = o.qty - o.filled_qty;
        await tx.many('UPDATE holdings SET qty_hold = qty_hold - $3, qty_available = qty_available + $3 WHERE user_id = $1 AND symbol = $2', [
          o.user_id,
          o.symbol,
          rem,
        ]);
      }
      return tx.one<OrderRow>(
        'UPDATE orders SET status = $2, hold_amount = 0, loan_hold = 0, reject_reason = COALESCE($3, reject_reason), updated_at = now() WHERE id = $1 RETURNING *',
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
