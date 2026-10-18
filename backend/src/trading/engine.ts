import crypto from 'node:crypto';
import {
  Big,
  RULES,
  floorStep,
  isAlgoType,
  stopTriggered,
  str,
  validateOrder,
  type Dec,
  type FillDTO,
  type OcoOrderInput,
  type OrderDTO,
  type OrderListDTO,
  type OrderStatus,
  type OrderType,
  type PlaceOrderInput,
  type ReplaceOrderInput,
  type Side,
  type SymbolInfo,
  type TimeInForce,
  type TradeTick,
} from '@vss/shared';
import type { Database, Queryable } from '../db';
import { badRequest, notFound } from '../lib/errors';
import { log } from '../lib/logger';
import type { BookFill } from '../market/marketService';
import { grantInitialCapital } from '../seed/seed';
import type { Notifier } from '../socket';
import { toFillDTO, toOrderDTO, toOrderListDTO, type AccountRow, type FillRow, type OrderListRow, type OrderRow } from './dto';
import { SYSTEM_ACTOR, recordOrderEvents, userActor, type OrderActor } from './orderEvents';
import { balanceOf, credit, debitFree, debitLocked, ledger, lockFunds, planFee, unlockFunds } from './wallet';

/*
 * Engine khớp lệnh Spot (mô phỏng trên thanh khoản thật).
 *  - Lệnh vào (taker) ăn sổ lệnh hiện tại của cặp (MarketService.consumeBook) → trượt giá như thật, phí taker.
 *  - Lệnh giới hạn đang nằm trên sổ (maker) khớp ở đúng giá đặt khi sổ lệnh / giao dịch thị trường đi qua giá đó,
 *    khối lượng tối đa bằng khối lượng thị trường thực sự giao dịch qua mức giá → phí maker.
 *  - Lệnh dừng (STOP_LOSS_LIMIT / TAKE_PROFIT_LIMIT) chờ giá khớp gần nhất chạm stopPrice rồi thành lệnh LIMIT.
 *  - OCO: chân LIMIT_MAKER + chân STOP_LOSS_LIMIT, khoá số dư 1 lần; 1 chân khớp / kích hoạt thì chân kia hết hiệu lực.
 * Mọi thay đổi số dư nằm trong db.tx; phần đang khoá của lệnh lưu ở orders.locked_amount.
 */

/** Những gì engine cần từ thị trường */
export interface MarketAccess {
  info(symbol: string): SymbolInfo | undefined;
  lastPrice(symbol: string): Dec | null;
  avgPrice(symbol: string): Dec | null;
  best(symbol: string, takerSide: Side): Dec | null;
  priceUsdt(asset: string): Dec | null;
  consumeBook(symbol: string, takerSide: Side, want: { qty?: Dec; quote?: Dec }, limit: Dec | null, dryRun?: boolean): BookFill[];
}

interface Resting {
  id: number;
  userId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  price: Dec | null;
  stopPrice: Dec | null;
  remaining: Big;
  working: boolean;
  listId: number | null;
}

interface Outcome {
  orders: OrderRow[];
  fills: FillDTO[];
}

const OPEN: OrderStatus[] = ['NEW', 'PARTIALLY_FILLED'];
const isOpen = (s: OrderStatus) => OPEN.includes(s);
const sumQty = (fills: BookFill[]) => fills.reduce((a, f) => a.plus(f.qty), new Big(0));
const sumQuote = (fills: BookFill[]) => fills.reduce((a, f) => a.plus(new Big(f.qty).times(f.price)), new Big(0));
const newClientId = () => `web_${crypto.randomBytes(12).toString('hex')}`;
const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === '23505';

export class SpotEngine {
  /** Lệnh mở theo cặp (cache để không phải truy vấn CSDL mỗi chu kỳ) */
  private open = new Map<string, Map<number, Resting>>();

  /** Dọn dữ liệu của tính năng khác khi tài khoản bị đặt lại / khoá / xoá */
  readonly userCleanup: ((userId: string, reason: string) => Promise<unknown>)[] = [];
  /** Kiểm tra trước khi đặt lại tài khoản (ném lỗi để chặn, vd. còn đơn P2P đang chạy) */
  readonly resetGuards: ((userId: string) => Promise<void>)[] = [];

  /** Cờ vận hành do quản trị viên đặt: ngừng nhận lệnh + ngừng khớp (toàn sàn hoặc theo cặp) */
  readonly control = { haltAll: false, haltReason: '', haltedSymbols: new Set<string>() };

  constructor(
    private db: Database,
    private market: MarketAccess,
    private notify: Notifier,
  ) {}

  /* ============================== khởi động ============================== */

  async load(): Promise<void> {
    this.open.clear();
    const rows = await this.db.many<OrderRow>(`SELECT * FROM orders WHERE status IN ('NEW','PARTIALLY_FILLED')`);
    for (const r of rows) this.track(r);
  }

  reload() {
    return this.load();
  }

  openOrderCount(): number {
    let n = 0;
    for (const m of this.open.values()) n += m.size;
    return n;
  }

  /* ============================== đặt lệnh ============================== */

  async placeOrder(userId: string, input: PlaceOrderInput, by: OrderActor = userActor()): Promise<OrderDTO> {
    const info = this.requireTradable(input.symbol);
    this.checkFilters(info, input);
    this.assertLimits(userId, info, isAlgoType(input.type) ? 1 : 0, 1);
    this.assertStopNotImmediate(info, input.type, input.side, input.stopPrice ?? null);
    if (input.type === 'LIMIT_MAKER') this.assertPostOnly(info.symbol, input.side, input.price!);
    let out: Outcome;
    try {
      out = await this.db.tx(async (tx) => {
        const placed = await this.placeInTx(tx, userId, info, input);
        await recordOrderEvents(tx, placed.orders.slice(0, 1), 'PLACE', by);
        return placed;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw badRequest('DUPLICATE_CLIENT_ID', 'clientOrderId đã được dùng cho lệnh khác');
      throw err;
    }
    this.publish(userId, out);
    return toOrderDTO(out.orders[0]!);
  }

  async placeOco(userId: string, input: OcoOrderInput, by: OrderActor = userActor()): Promise<OrderListDTO> {
    const info = this.requireTradable(input.symbol);
    const last = this.market.lastPrice(info.symbol);
    if (!last) throw badRequest('NO_PRICE', `Chưa có giá của ${info.symbol}`);
    const { side, quantity, price, stopPrice, stopLimitPrice } = input;
    const ok =
      side === 'SELL'
        ? new Big(price).gt(last) && new Big(stopPrice).lt(last)
        : new Big(price).lt(last) && new Big(stopPrice).gt(last);
    if (!ok) {
      throw badRequest(
        'OCO_PRICES',
        side === 'SELL'
          ? `OCO bán: giá giới hạn phải cao hơn giá hiện tại (${last}) và giá kích hoạt phải thấp hơn`
          : `OCO mua: giá giới hạn phải thấp hơn giá hiện tại (${last}) và giá kích hoạt phải cao hơn`,
      );
    }
    this.checkFilters(info, { side, type: 'LIMIT_MAKER', price, quantity });
    this.checkFilters(info, { side, type: 'STOP_LOSS_LIMIT', price: stopLimitPrice, stopPrice, quantity });
    this.assertLimits(userId, info, 1, 2);
    this.assertPostOnly(info.symbol, side, price);

    const lockAsset = side === 'BUY' ? info.quoteAsset : info.baseAsset;
    // Mua: khoá đủ cho chân đắt hơn trong 2 chân; bán: khoá khối lượng coin
    const lockAmount = side === 'BUY' ? new Big(quantity).times(new Big(price).gt(stopLimitPrice) ? price : stopLimitPrice).toFixed() : quantity;

    const out = await this.db.tx(async (tx) => {
      await lockFunds(tx, userId, lockAsset, lockAmount);
      const list = await tx.one<OrderListRow>('INSERT INTO order_lists (user_id, symbol, side) VALUES ($1,$2,$3) RETURNING *', [userId, info.symbol, side]);
      const common = [userId, info.symbol, side, quantity, RULES.makerFee, RULES.takerFee, lockAsset, list!.id] as const;
      const limitLeg = await tx.one<OrderRow>(
        `INSERT INTO orders (client_order_id, user_id, symbol, side, type, time_in_force, price, stop_price, orig_qty, status, is_working,
                             maker_fee, taker_fee, locked_asset, locked_amount, order_list_id)
         VALUES ($1,$2,$3,$4,'LIMIT_MAKER',NULL,$5,NULL,$6,'NEW',true,$7,$8,$9,$10,$11) RETURNING *`,
        [newClientId(), common[0], common[1], common[2], price, common[3], common[4], common[5], common[6], lockAmount, common[7]],
      );
      const stopLeg = await tx.one<OrderRow>(
        `INSERT INTO orders (client_order_id, user_id, symbol, side, type, time_in_force, price, stop_price, orig_qty, status, is_working,
                             maker_fee, taker_fee, locked_asset, locked_amount, order_list_id)
         VALUES ($1,$2,$3,$4,'STOP_LOSS_LIMIT','GTC',$5,$6,$7,'NEW',false,$8,$9,$10,0,$11) RETURNING *`,
        [newClientId(), common[0], common[1], common[2], stopLimitPrice, stopPrice, common[3], common[4], common[5], common[6], common[7]],
      );
      await recordOrderEvents(tx, [limitLeg!, stopLeg!], 'PLACE', by);
      return { list: list!, orders: [limitLeg!, stopLeg!] };
    });
    this.publish(userId, { orders: out.orders, fills: [] });
    return toOrderListDTO(out.list, out.orders);
  }

  /** Đặt lệnh trong transaction có sẵn (dùng chung cho đặt mới và cancel-replace) */
  private async placeInTx(tx: Queryable, userId: string, info: SymbolInfo, input: PlaceOrderInput): Promise<Outcome> {
    const { side, type } = input;
    const algo = isAlgoType(type);
    const tif: TimeInForce | null = type === 'LIMIT' || algo ? (input.timeInForce ?? 'GTC') : null;
    const lockAsset = side === 'BUY' ? info.quoteAsset : info.baseAsset;
    let lockAmount: Dec;
    let preFills: BookFill[] | null = null;

    if (type === 'MARKET') {
      // Lệnh thị trường: ăn sổ lệnh ngay (đồng bộ) rồi khoá đúng số cần dùng
      preFills = input.quoteOrderQty
        ? this.market.consumeBook(info.symbol, side, { quote: input.quoteOrderQty }, null)
        : this.market.consumeBook(info.symbol, side, { qty: input.quantity! }, null);
      if (!preFills.length) throw badRequest('NO_LIQUIDITY', `Sổ lệnh ${info.symbol} hiện không đủ thanh khoản cho lệnh thị trường`);
      if (side === 'BUY') lockAmount = input.quoteOrderQty ?? sumQuote(preFills).toFixed();
      else lockAmount = input.quoteOrderQty ? sumQty(preFills).toFixed() : input.quantity!;
    } else {
      lockAmount = side === 'BUY' ? new Big(input.price!).times(input.quantity!).toFixed() : input.quantity!;
    }

    await lockFunds(tx, userId, lockAsset, lockAmount);
    const row = (await tx.one<OrderRow>(
      `INSERT INTO orders (client_order_id, user_id, symbol, side, type, time_in_force, price, stop_price, orig_qty, quote_order_qty,
                           status, is_working, maker_fee, taker_fee, locked_asset, locked_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'NEW',$11,$12,$13,$14,$15) RETURNING *`,
      [
        input.clientOrderId ?? newClientId(),
        userId,
        info.symbol,
        side,
        type,
        tif,
        input.price ?? null,
        input.stopPrice ?? null,
        input.quantity ?? '0',
        input.quoteOrderQty ?? null,
        !algo,
        RULES.makerFee,
        RULES.takerFee,
        lockAsset,
        lockAmount,
      ],
    ))!;
    if (algo) return { orders: [row], fills: [] };
    return this.takerPhase(tx, row, preFills);
  }

  /**
   * Phần khớp ngay khi lệnh vào sổ (taker): MARKET, LIMIT (GTC/IOC/FOK), lệnh dừng vừa kích hoạt.
   * Phần còn lại: MARKET / IOC hết hiệu lực, GTC nằm chờ trên sổ.
   */
  private async takerPhase(tx: Queryable, o: OrderRow, preFills: BookFill[] | null): Promise<Outcome> {
    const remaining = new Big(o.orig_qty).minus(o.executed_qty).toFixed();
    let fills: BookFill[];
    if (preFills) fills = preFills;
    else if (o.type === 'LIMIT_MAKER') fills = [];
    else {
      if (o.time_in_force === 'FOK') {
        const dry = this.market.consumeBook(o.symbol, o.side, { qty: remaining }, o.price, true);
        if (sumQty(dry).lt(remaining)) {
          const row = await this.finish(tx, o, 'EXPIRED', 'FOK: không đủ thanh khoản để khớp toàn bộ ngay');
          return { orders: [row], fills: [] };
        }
      }
      fills = this.market.consumeBook(o.symbol, o.side, { qty: remaining }, o.price);
    }
    let row = o;
    let out: FillDTO[] = [];
    if (fills.length) ({ row, fills: out } = await this.execute(tx, o, fills, false));

    if (isOpen(row.status)) {
      if (row.type === 'MARKET') {
        row = row.quote_order_qty && out.length && this.quoteDone(row)
          ? await this.finish(tx, row, 'FILLED', null)
          : await this.finish(tx, row, 'EXPIRED', 'Sổ lệnh không đủ thanh khoản, phần còn lại của lệnh thị trường hết hiệu lực');
      } else if (row.time_in_force === 'IOC') {
        row = await this.finish(tx, row, 'EXPIRED', 'IOC: phần chưa khớp ngay bị huỷ');
      }
    }
    return { orders: [row], fills: out };
  }

  /** Lệnh MARKET theo số tiền đã dùng gần hết (phần dư không đủ mua thêm 1 bước khối lượng) */
  private quoteDone(o: OrderRow): boolean {
    const info = this.market.info(o.symbol);
    const left = new Big(o.quote_order_qty!).minus(o.cumm_quote_qty);
    const best = this.market.best(o.symbol, o.side) ?? this.market.lastPrice(o.symbol);
    if (!info || !best) return true;
    return left.lt(new Big(best).times(info.filters.stepSize).times(2));
  }

  /* ============================== thực hiện khớp ============================== */

  /** Ghi nhận các lần khớp của 1 lệnh: chuyển số dư, thu phí, sổ cái, lãi / lỗ theo giá vốn bình quân */
  private async execute(tx: Queryable, o: OrderRow, fills: BookFill[], isMaker: boolean): Promise<{ row: OrderRow; fills: FillDTO[] }> {
    const info = this.market.info(o.symbol);
    if (!info) throw new Error(`Không có thông tin cặp ${o.symbol}`);
    const base = info.baseAsset;
    const quote = info.quoteAsset;
    const acct = await tx.one<AccountRow>('SELECT * FROM accounts WHERE user_id = $1', [o.user_id]);
    const payWithBnb = !!acct?.pay_fee_with_bnb;
    const quoteUsdt = this.market.priceUsdt(quote) ?? '1';
    const rate = isMaker ? o.maker_fee : o.taker_fee;
    const out: FillDTO[] = [];
    let row = o;

    for (const f of fills) {
      const qty = new Big(f.qty);
      if (qty.lte(0)) continue;
      const quoteQty = qty.times(f.price).toFixed();
      const receivedUsdt = new Big(quoteQty).times(quoteUsdt).toFixed();
      const bnbFree = payWithBnb ? str((await balanceOf(tx, o.user_id, RULES.feeAsset)).free) : '0';
      const fee = planFee({
        received: o.side === 'BUY' ? { asset: base, amount: qty.toFixed() } : { asset: quote, amount: quoteQty },
        receivedUsdt,
        rate,
        payWithBnb,
        bnbPriceUsdt: this.market.priceUsdt(RULES.feeAsset),
        bnbFree,
      });
      const note = `${o.side === 'BUY' ? 'Mua' : 'Bán'} ${qty.toFixed()} ${base} @ ${str(f.price)}`;
      let realized: Dec | null = null;

      if (o.side === 'BUY') {
        const paid = await debitLocked(tx, o.user_id, quote, quoteQty);
        await ledger(tx, o.user_id, quote, 'TRADE', `-${quoteQty}`, paid.total, o.id, note);
        const net = fee.fromBnb ? qty : qty.minus(fee.amount);
        const cost = new Big(receivedUsdt).plus(fee.fromBnb ? fee.usdt : 0).toFixed();
        const total = await credit(tx, o.user_id, base, net.toFixed(), cost);
        if (fee.fromBnb) await ledger(tx, o.user_id, base, 'TRADE', qty.toFixed(), total, o.id, note);
        else {
          await ledger(tx, o.user_id, base, 'TRADE', qty.toFixed(), new Big(total).plus(fee.amount).toFixed(), o.id, note);
          await ledger(tx, o.user_id, base, 'FEE', `-${fee.amount}`, total, o.id, `Phí ${isMaker ? 'maker' : 'taker'}`);
        }
      } else {
        const sold = await debitLocked(tx, o.user_id, base, qty.toFixed());
        await ledger(tx, o.user_id, base, 'TRADE', `-${qty.toFixed()}`, sold.total, o.id, note);
        const net = fee.fromBnb ? new Big(quoteQty) : new Big(quoteQty).minus(fee.amount);
        const total = await credit(tx, o.user_id, quote, net.toFixed());
        if (fee.fromBnb) await ledger(tx, o.user_id, quote, 'TRADE', quoteQty, total, o.id, note);
        else {
          await ledger(tx, o.user_id, quote, 'TRADE', quoteQty, new Big(total).plus(fee.amount).toFixed(), o.id, note);
          await ledger(tx, o.user_id, quote, 'FEE', `-${fee.amount}`, total, o.id, `Phí ${isMaker ? 'maker' : 'taker'}`);
        }
        realized = net
          .times(quoteUsdt)
          .minus(fee.fromBnb ? fee.usdt : 0)
          .minus(sold.costRemoved)
          .round(8)
          .toFixed();
      }
      if (fee.fromBnb) {
        const r = await debitFree(tx, o.user_id, RULES.feeAsset, fee.amount);
        if (r) await ledger(tx, o.user_id, RULES.feeAsset, 'FEE', `-${fee.amount}`, r.total, o.id, `Phí ${isMaker ? 'maker' : 'taker'} (trả bằng BNB)`);
      }

      row = (await tx.one<OrderRow>(
        `UPDATE orders SET executed_qty = executed_qty + $2, cumm_quote_qty = cumm_quote_qty + $3,
                locked_amount = GREATEST(locked_amount - $4, 0),
                status = CASE WHEN quote_order_qty IS NULL AND executed_qty + $2 >= orig_qty THEN 'FILLED' ELSE 'PARTIALLY_FILLED' END,
                updated_at = now()
         WHERE id = $1 RETURNING *`,
        [o.id, qty.toFixed(), quoteQty, o.side === 'BUY' ? quoteQty : qty.toFixed()],
      ))!;
      const fillRow = (await tx.one<FillRow>(
        `INSERT INTO fills (order_id, user_id, symbol, side, price, qty, quote_qty, commission, commission_asset, commission_usdt, is_maker, realized_pnl)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [o.id, o.user_id, o.symbol, o.side, f.price, qty.toFixed(), quoteQty, fee.amount, fee.asset, fee.usdt, isMaker, realized],
      ))!;
      out.push(toFillDTO(fillRow));
    }
    // Khớp hết: trả lại phần khoá dư (mua được giá tốt hơn giá đặt)
    if (row.status === 'FILLED') row = await this.releaseLock(tx, row);
    return { row, fills: out };
  }

  /** Mở khoá phần còn giữ của lệnh */
  private async releaseLock(tx: Queryable, o: OrderRow): Promise<OrderRow> {
    if (new Big(o.locked_amount).gt(0)) await unlockFunds(tx, o.user_id, o.locked_asset, o.locked_amount);
    return (await tx.one<OrderRow>('UPDATE orders SET locked_amount = 0, updated_at = now() WHERE id = $1 RETURNING *', [o.id]))!;
  }

  /** Đóng lệnh (huỷ / hết hiệu lực / khớp xong) và trả lại số dư còn khoá */
  private async finish(
    tx: Queryable,
    o: OrderRow,
    status: OrderStatus,
    reason: string | null,
    by: OrderActor = SYSTEM_ACTOR,
    opts: { event?: string | null } = {},
  ): Promise<OrderRow> {
    if (new Big(o.locked_amount).gt(0)) await unlockFunds(tx, o.user_id, o.locked_asset, o.locked_amount);
    const row = (await tx.one<OrderRow>(
      `UPDATE orders SET status = $2, reason = $3, locked_amount = 0,
              orig_qty = CASE WHEN quote_order_qty IS NOT NULL THEN executed_qty ELSE orig_qty END, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [o.id, status, reason],
    ))!;
    if (row.order_list_id) await this.syncList(tx, row.order_list_id);
    // Nhật ký lệnh: huỷ / hết hiệu lực / từ chối (khớp hết đã có trong bảng fills)
    const event =
      opts.event !== undefined ? opts.event : status === 'CANCELED' ? 'CANCEL' : status === 'EXPIRED' ? 'EXPIRE' : status === 'REJECTED' ? 'REJECT' : null;
    if (event) await recordOrderEvents(tx, [row], event, by);
    return row;
  }

  /** OCO: đóng danh sách khi không còn chân nào mở */
  private async syncList(tx: Queryable, listId: number) {
    const open = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM orders WHERE order_list_id = $1 AND status IN ('NEW','PARTIALLY_FILLED')`, [listId]);
    if (!open?.n) await tx.many(`UPDATE order_lists SET status = 'ALL_DONE', updated_at = now() WHERE id = $1`, [listId]);
  }

  /* ============================== huỷ / sửa ============================== */

  async cancelOrder(userId: string, id: number, by: OrderActor = userActor()): Promise<OrderDTO> {
    const o = await this.db.one<OrderRow>('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!o) throw notFound('Không tìm thấy lệnh');
    if (!isOpen(o.status)) throw badRequest('NOT_CANCELABLE', 'Lệnh đã khớp hết hoặc đã đóng');
    // Huỷ 1 chân OCO = huỷ cả danh sách (như Binance)
    const orders = o.order_list_id
      ? await this.closeList(o.order_list_id, 'CANCELED', null, by)
      : await this.closeOrders([id], 'CANCELED', null, by);
    this.publish(userId, { orders, fills: [] });
    return toOrderDTO(orders.find((r) => Number(r.id) === id) ?? o);
  }

  async cancelOrderList(userId: string, listId: number, by: OrderActor = userActor()): Promise<OrderListDTO> {
    const list = await this.db.one<OrderListRow>('SELECT * FROM order_lists WHERE id = $1 AND user_id = $2', [listId, userId]);
    if (!list) throw notFound('Không tìm thấy lệnh OCO');
    const orders = await this.closeList(listId, 'CANCELED', null, by);
    this.publish(userId, { orders, fills: [] });
    const all = await this.db.many<OrderRow>('SELECT * FROM orders WHERE order_list_id = $1 ORDER BY id', [listId]);
    const fresh = await this.db.one<OrderListRow>('SELECT * FROM order_lists WHERE id = $1', [listId]);
    return toOrderListDTO(fresh!, all);
  }

  /** Huỷ mọi lệnh mở của người dùng (theo cặp nếu có) */
  async cancelAll(userId: string, symbol?: string, by: OrderActor = userActor()): Promise<number> {
    const rows = await this.db.many<{ id: number; order_list_id: number | null }>(
      `SELECT id, order_list_id FROM orders WHERE user_id = $1 AND status IN ('NEW','PARTIALLY_FILLED') ${symbol ? 'AND symbol = $2' : ''}`,
      symbol ? [userId, symbol] : [userId],
    );
    const lists = new Set(rows.filter((r) => r.order_list_id).map((r) => Number(r.order_list_id)));
    const singles = rows.filter((r) => !r.order_list_id).map((r) => Number(r.id));
    const closed: OrderRow[] = [];
    if (singles.length) closed.push(...(await this.closeOrders(singles, 'CANCELED', null, by)));
    for (const l of lists) closed.push(...(await this.closeList(l, 'CANCELED', null, by)));
    this.publish(userId, { orders: closed, fills: [] });
    return closed.length;
  }

  /**
   * Sửa lệnh giới hạn đang chờ = huỷ và đặt lệnh mới (cancel-replace, mất thứ tự hàng đợi).
   * Khối lượng mặc định = phần chưa khớp của lệnh cũ. Đặt lệnh mới lỗi → lệnh cũ giữ nguyên.
   */
  async replaceOrder(userId: string, id: number, input: ReplaceOrderInput, by: OrderActor = userActor()): Promise<OrderDTO> {
    const o = await this.db.one<OrderRow>('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!o) throw notFound('Không tìm thấy lệnh');
    if (!isOpen(o.status)) throw badRequest('NOT_MODIFIABLE', 'Lệnh đã khớp hết hoặc đã đóng');
    if (o.type !== 'LIMIT' || o.order_list_id) throw badRequest('NOT_MODIFIABLE', 'Chỉ sửa được lệnh giới hạn (không thuộc OCO)');
    const info = this.requireTradable(o.symbol);
    const next: PlaceOrderInput = {
      symbol: o.symbol,
      side: o.side,
      type: 'LIMIT',
      timeInForce: o.time_in_force ?? 'GTC',
      price: input.price ?? str(o.price!),
      quantity: input.quantity ?? new Big(o.orig_qty).minus(o.executed_qty).toFixed(),
    };
    if (next.price === str(o.price!) && next.quantity === new Big(o.orig_qty).minus(o.executed_qty).toFixed()) {
      throw badRequest('NO_CHANGE', 'Không có thay đổi');
    }
    this.checkFilters(info, next);
    const out = await this.db.tx(async (tx) => {
      const cur = (await tx.one<OrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]))!;
      if (!isOpen(cur.status)) throw badRequest('NOT_MODIFIABLE', 'Lệnh vừa khớp hết hoặc đã đóng');
      const closed = await this.finish(tx, cur, 'CANCELED', 'Đã sửa lệnh (huỷ và đặt lại)', by, { event: null });
      const placed = await this.placeInTx(tx, userId, info, next);
      // Nhật ký: lệnh cũ "đã sửa thành" lệnh mới, lệnh mới ghi rõ thay cho lệnh nào
      const newId = Number(placed.orders[0]!.id);
      await recordOrderEvents(tx, [closed], 'REPLACE', by, { newOrderId: newId, newPrice: next.price, newQuantity: next.quantity });
      await recordOrderEvents(tx, placed.orders.slice(0, 1), 'PLACE', by, { replacesOrderId: id });
      return { orders: [closed, ...placed.orders], fills: placed.fills };
    });
    this.publish(userId, out);
    return toOrderDTO(out.orders[1]!);
  }

  /** Quản trị viên huỷ hộ 1 lệnh (kèm lý do) */
  async adminCancel(id: number, reason: string, by: OrderActor = SYSTEM_ACTOR): Promise<OrderDTO> {
    const o = await this.db.one<OrderRow>('SELECT * FROM orders WHERE id = $1', [id]);
    if (!o) throw notFound('Không tìm thấy lệnh');
    if (!isOpen(o.status)) throw badRequest('NOT_CANCELABLE', 'Lệnh đã khớp hết hoặc đã đóng');
    const orders = o.order_list_id ? await this.closeList(o.order_list_id, 'CANCELED', reason, by) : await this.closeOrders([id], 'CANCELED', reason, by);
    this.publish(o.user_id, { orders, fills: [] });
    return toOrderDTO(orders.find((r) => Number(r.id) === id) ?? o);
  }

  async cancelAllForSymbol(symbol: string, reason: string): Promise<number> {
    const users = await this.db.many<{ user_id: string }>(`SELECT DISTINCT user_id FROM orders WHERE symbol = $1 AND status IN ('NEW','PARTIALLY_FILLED')`, [symbol]);
    let n = 0;
    for (const u of users) n += await this.cancelAllWithReason(u.user_id, reason, symbol);
    return n;
  }

  /** Huỷ lệnh đang mở của 1 người trên 1 cặp (vd. nhân viên khi cặp chuyển sang giá điều chỉnh) */
  async cancelForUserOnSymbol(userId: string, symbol: string, reason: string, by: OrderActor = SYSTEM_ACTOR): Promise<number> {
    return this.cancelAllWithReason(userId, reason, symbol, by);
  }

  async cancelAllForUser(userId: string, reason: string, by: OrderActor = SYSTEM_ACTOR): Promise<number> {
    for (const fn of this.userCleanup) await fn(userId, reason);
    return this.cancelAllWithReason(userId, reason, undefined, by);
  }

  private async cancelAllWithReason(userId: string, reason: string, symbol?: string, by: OrderActor = SYSTEM_ACTOR): Promise<number> {
    const rows = await this.db.many<{ id: number; order_list_id: number | null }>(
      `SELECT id, order_list_id FROM orders WHERE user_id = $1 AND status IN ('NEW','PARTIALLY_FILLED') ${symbol ? 'AND symbol = $2' : ''}`,
      symbol ? [userId, symbol] : [userId],
    );
    const closed: OrderRow[] = [];
    const lists = new Set(rows.filter((r) => r.order_list_id).map((r) => Number(r.order_list_id)));
    const singles = rows.filter((r) => !r.order_list_id).map((r) => Number(r.id));
    if (singles.length) closed.push(...(await this.closeOrders(singles, 'CANCELED', reason, by)));
    for (const l of lists) closed.push(...(await this.closeList(l, 'CANCELED', reason, by)));
    this.publish(userId, { orders: closed, fills: [] });
    return closed.length;
  }

  private async closeOrders(ids: number[], status: OrderStatus, reason: string | null, by: OrderActor = SYSTEM_ACTOR): Promise<OrderRow[]> {
    return this.db.tx(async (tx) => {
      const out: OrderRow[] = [];
      for (const id of ids) {
        const o = await tx.one<OrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
        if (o && isOpen(o.status)) out.push(await this.finish(tx, o, status, reason, by));
      }
      return out;
    });
  }

  private async closeList(listId: number, status: OrderStatus, reason: string | null, by: OrderActor = SYSTEM_ACTOR): Promise<OrderRow[]> {
    const ids = await this.db.many<{ id: number }>(`SELECT id FROM orders WHERE order_list_id = $1 AND status IN ('NEW','PARTIALLY_FILLED') ORDER BY id`, [listId]);
    return this.closeOrders(ids.map((r) => Number(r.id)), status, reason, by);
  }

  /** Đặt lại tài khoản ảo về vốn ban đầu */
  async resetAccount(userId: string): Promise<void> {
    for (const g of this.resetGuards) await g(userId);
    for (const fn of this.userCleanup) await fn(userId, 'Đặt lại tài khoản');
    for (const m of this.open.values()) for (const [id, r] of m) if (r.userId === userId) m.delete(id);
    await this.db.tx(async (tx) => {
      await tx.many('DELETE FROM fills WHERE user_id = $1', [userId]);
      await tx.many('DELETE FROM ledger WHERE user_id = $1', [userId]);
      await tx.many('DELETE FROM orders WHERE user_id = $1', [userId]);
      await tx.many('DELETE FROM order_lists WHERE user_id = $1', [userId]);
      await tx.many('DELETE FROM nav_daily WHERE user_id = $1', [userId]);
      await tx.many('DELETE FROM balances WHERE user_id = $1', [userId]);
      await grantInitialCapital(tx, userId, 'Đặt lại tài khoản ảo');
    });
    this.notify.account(userId);
  }

  /* ============================== chu kỳ thị trường ============================== */

  /** Gọi mỗi chu kỳ của MarketService: kích hoạt lệnh dừng, khớp lệnh giới hạn đang chờ (maker) */
  async onTick(changed: Set<string>, trades: Map<string, TradeTick[]>): Promise<void> {
    if (this.control.haltAll) return;
    const symbols = new Set([...changed, ...trades.keys()]);
    for (const sym of symbols) {
      const book = this.open.get(sym);
      if (!book?.size || this.control.haltedSymbols.has(sym)) continue;
      const info = this.market.info(sym);
      if (!info || info.status !== 'TRADING') continue;
      const last = this.market.lastPrice(sym);
      if (!last) continue;
      try {
        await this.triggerStops(book, Number(last));
        await this.matchResting(sym, book, trades.get(sym) ?? []);
      } catch (err) {
        log.error(`[engine] lỗi khớp lệnh ${sym}`, { err });
      }
    }
  }

  private async triggerStops(book: Map<number, Resting>, last: number) {
    for (const r of [...book.values()]) {
      if (r.working || !r.stopPrice) continue;
      if (!stopTriggered(r.type, r.side, Number(r.stopPrice), last)) continue;
      const out = await this.db.tx(async (tx) => {
        const o = await tx.one<OrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [r.id]);
        if (!o || !isOpen(o.status) || o.is_working) return null;
        const orders: OrderRow[] = [];
        if (o.order_list_id) {
          // OCO: chuyển phần khoá từ chân giới hạn sang chân dừng, chân giới hạn hết hiệu lực
          const other = await tx.one<OrderRow>(
            `SELECT * FROM orders WHERE order_list_id = $1 AND id <> $2 AND status IN ('NEW','PARTIALLY_FILLED') FOR UPDATE`,
            [o.order_list_id, o.id],
          );
          if (other) {
            const need = o.side === 'BUY' ? new Big(o.price!).times(o.orig_qty) : new Big(o.orig_qty);
            const move = new Big(other.locked_amount).lt(need) ? new Big(other.locked_amount) : need;
            await tx.many('UPDATE orders SET locked_amount = locked_amount - $2 WHERE id = $1', [other.id, move.toFixed()]);
            await tx.many('UPDATE orders SET locked_amount = locked_amount + $2 WHERE id = $1', [o.id, move.toFixed()]);
            const otherFresh = (await tx.one<OrderRow>('SELECT * FROM orders WHERE id = $1', [other.id]))!;
            orders.push(await this.finish(tx, otherFresh, 'EXPIRED', 'OCO: lệnh dừng đã kích hoạt'));
          }
        }
        const working = (await tx.one<OrderRow>('UPDATE orders SET is_working = true, updated_at = now() WHERE id = $1 RETURNING *', [o.id]))!;
        await recordOrderEvents(tx, [working], 'TRIGGER', SYSTEM_ACTOR, { lastPrice: String(last) });
        const res = await this.takerPhase(tx, working, null);
        return { orders: [...orders, ...res.orders], fills: res.fills };
      });
      if (out) this.publish(r.userId, out);
    }
  }

  /**
   * Lệnh giới hạn đang chờ khớp như maker ở đúng giá đặt khi:
   *  - sổ lệnh đối ứng đã đi qua giá đặt (giá bán tốt nhất ≤ giá mua / giá mua tốt nhất ≥ giá bán), hoặc
   *  - có giao dịch thị trường ở giá bằng hoặc tốt hơn giá đặt.
   * Khối lượng khớp ≤ khối lượng thị trường thực có (chia theo ưu tiên giá rồi thời gian giữa các lệnh).
   */
  private async matchResting(sym: string, book: Map<number, Resting>, ticks: TradeTick[]) {
    const working = [...book.values()].filter((r) => r.working && r.price && r.remaining.gt(0));
    if (!working.length) return;
    const budget = ticks.map((t) => ({ price: new Big(t.price), left: new Big(t.qty) }));
    const buys = working.filter((r) => r.side === 'BUY').sort((a, b) => new Big(b.price!).cmp(a.price!) || a.id - b.id);
    const sells = working.filter((r) => r.side === 'SELL').sort((a, b) => new Big(a.price!).cmp(b.price!) || a.id - b.id);
    for (const r of [...buys, ...sells]) {
      const price = new Big(r.price!);
      let qty = new Big(0);
      // 1) sổ lệnh đối ứng đã chéo giá đặt
      const crossed = this.market.consumeBook(sym, r.side, { qty: r.remaining.toFixed() }, r.price);
      qty = qty.plus(sumQty(crossed));
      // 2) giao dịch thị trường đi qua giá đặt
      for (const t of budget) {
        if (qty.gte(r.remaining)) break;
        if (t.left.lte(0)) continue;
        const through = r.side === 'BUY' ? t.price.lte(price) : t.price.gte(price);
        if (!through) continue;
        const take = r.remaining.minus(qty).lt(t.left) ? r.remaining.minus(qty) : t.left;
        t.left = t.left.minus(take);
        qty = qty.plus(take);
      }
      const info = this.market.info(sym);
      if (info) qty = new Big(floorStep(qty, info.filters.stepSize));
      if (qty.lte(0)) continue;
      const out = await this.db.tx(async (tx) => {
        const o = await tx.one<OrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [r.id]);
        if (!o || !isOpen(o.status) || !o.is_working) return null;
        const left = new Big(o.orig_qty).minus(o.executed_qty);
        const fillQty = qty.gt(left) ? left : qty;
        if (fillQty.lte(0)) return null;
        const res = await this.execute(tx, o, [{ price: str(o.price!), qty: fillQty.toFixed() }], true);
        const orders = [res.row];
        // OCO: chân giới hạn khớp → chân dừng hết hiệu lực
        if (o.order_list_id) {
          const others = await tx.many<OrderRow>(
            `SELECT * FROM orders WHERE order_list_id = $1 AND id <> $2 AND status IN ('NEW','PARTIALLY_FILLED') FOR UPDATE`,
            [o.order_list_id, o.id],
          );
          for (const x of others) orders.push(await this.finish(tx, x, 'EXPIRED', 'OCO: lệnh giới hạn đã khớp'));
          if (!isOpen(res.row.status)) await this.syncList(tx, o.order_list_id);
        }
        return { orders, fills: res.fills };
      });
      if (out) this.publish(r.userId, out);
    }
  }

  /* ============================== kiểm tra ============================== */

  private requireTradable(symbol: string): SymbolInfo {
    const info = this.market.info(symbol);
    if (!info) throw badRequest('SYMBOL', `Cặp ${symbol} không tồn tại hoặc đã gỡ khỏi sàn`);
    if (this.control.haltAll) throw badRequest('HALTED', `Sàn đang tạm ngừng nhận lệnh${this.control.haltReason ? `: ${this.control.haltReason}` : ''}`);
    if (this.control.haltedSymbols.has(symbol) || info.status !== 'TRADING') throw badRequest('HALTED', `${symbol} đang tạm ngừng giao dịch`);
    return info;
  }

  private checkFilters(info: SymbolInfo, o: { side: Side; type: OrderType; price?: Dec; stopPrice?: Dec; quantity?: Dec; quoteOrderQty?: Dec }) {
    const err = validateOrder(info, o, this.market.avgPrice(info.symbol));
    if (err) throw badRequest(err.code, err.message);
  }

  /** MAX_NUM_ORDERS / MAX_NUM_ALGO_ORDERS theo cặp */
  private assertLimits(userId: string, info: SymbolInfo, addAlgo: number, addOrders: number) {
    let orders = 0;
    let algo = 0;
    for (const r of this.open.get(info.symbol)?.values() ?? []) {
      if (r.userId !== userId) continue;
      orders++;
      if (!r.working && r.stopPrice) algo++;
    }
    if (orders + addOrders > info.filters.maxNumOrders) {
      throw badRequest('MAX_NUM_ORDERS', `Tối đa ${info.filters.maxNumOrders} lệnh mở cho mỗi cặp`);
    }
    if (addAlgo && algo + addAlgo > info.filters.maxNumAlgoOrders) {
      throw badRequest('MAX_NUM_ALGO_ORDERS', `Tối đa ${info.filters.maxNumAlgoOrders} lệnh dừng đang chờ cho mỗi cặp`);
    }
  }

  /** Binance từ chối lệnh dừng sẽ kích hoạt ngay khi đặt */
  private assertStopNotImmediate(info: SymbolInfo, type: OrderType, side: Side, stopPrice: Dec | null) {
    if (!isAlgoType(type) || !stopPrice) return;
    const last = this.market.lastPrice(info.symbol);
    if (!last) throw badRequest('NO_PRICE', `Chưa có giá của ${info.symbol}`);
    if (stopTriggered(type, side, Number(stopPrice), Number(last))) {
      throw badRequest('STOP_IMMEDIATE', `Giá kích hoạt ${stopPrice} sẽ kích hoạt ngay (giá hiện tại ${last}), hãy dùng lệnh giới hạn hoặc thị trường`);
    }
  }

  private assertPostOnly(symbol: string, side: Side, price: Dec) {
    const best = this.market.best(symbol, side);
    if (best && (side === 'BUY' ? new Big(price).gte(best) : new Big(price).lte(best))) {
      throw badRequest('POST_ONLY', `Lệnh post-only sẽ khớp ngay với giá ${side === 'BUY' ? 'bán' : 'mua'} tốt nhất (${best}) nên bị từ chối`);
    }
  }

  /* ============================== cache & thông báo ============================== */

  private track(o: OrderRow) {
    const sym = o.symbol;
    let book = this.open.get(sym);
    if (!isOpen(o.status)) {
      book?.delete(Number(o.id));
      return;
    }
    if (!book) this.open.set(sym, (book = new Map()));
    book.set(Number(o.id), {
      id: Number(o.id),
      userId: o.user_id,
      symbol: sym,
      side: o.side,
      type: o.type,
      price: o.price == null ? null : str(o.price),
      stopPrice: o.stop_price == null ? null : str(o.stop_price),
      remaining: new Big(o.orig_qty).minus(o.executed_qty),
      working: o.is_working,
      listId: o.order_list_id == null ? null : Number(o.order_list_id),
    });
  }

  private publish(userId: string, out: Outcome) {
    for (const o of out.orders) {
      this.track(o);
      this.notify.order(o.user_id, toOrderDTO(o));
    }
    for (const f of out.fills) this.notify.fill(userId, f);
    this.notify.account(userId);
  }
}
