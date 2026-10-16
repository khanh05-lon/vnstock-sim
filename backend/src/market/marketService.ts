import { EventEmitter } from 'node:events';
import {
  priceBand,
  warrantBand,
  stepPrice,
  type Candle,
  type IndexSnapshot,
  type MarketMode,
  type SessionInfo,
  type SessionPhase,
  type StockInfo,
  type StockRow,
  type StockSnapshot,
  type TradeTick,
} from '@vss/shared';
import type { Database } from '../db';
import { currentTradeDate, phaseAt, vnTimeToMs } from '../lib/calendar';
import { INDEX_DEFS } from '../seed/stocks';
import { loadInstrumentInfo } from './instruments';
import type { MarketDataProvider, ProviderTrade, StockState } from './types';

interface IndexState {
  code: string;
  name: string;
  members: StockState[];
  prevClose: number;
  capRef: number;
  points: { ts: number; value: number }[];
}

export interface MarketHooks {
  onTick?(symbols: Set<string>, trades: Map<string, ProviderTrade>): Promise<void>;
  onAuction?(kind: 'ATO' | 'ATC', prices: Map<string, number>): Promise<void>;
  onDayEnd?(tradeDate: string): Promise<void>;
  onNewDay?(tradeDate: string): Promise<void>;
}

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '1D' | '1W' | '1M';
export const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h', '1D', '1W', '1M'];

export interface StockDbRow {
  symbol: string;
  exchange: StockInfo['exchange'];
  type: StockInfo['type'];
  status: 'ACTIVE' | 'DELISTED';
  name: string;
  industry: string;
  listed_shares: number;
  eps: number;
  bvps: number;
  is_vn30: boolean;
  liquidity: number;
  volatility: number;
  margin_ratio: number;
}

export function stockInfoOf(r: StockDbRow): StockInfo {
  return {
    symbol: r.symbol,
    exchange: r.exchange,
    type: r.type ?? 'STOCK',
    name: r.name,
    industry: r.industry,
    listedShares: Number(r.listed_shares),
    eps: r.eps,
    bvps: r.bvps,
    isVn30: r.is_vn30,
    marginRatio: Number(r.margin_ratio ?? 0),
  };
}

/** Thành phần chỉ số: chỉ cổ phiếu (không gồm ETF, chứng quyền, trái phiếu) */
function indexGroups(list: StockState[]): Record<string, StockState[]> {
  const stocks = list.filter((s) => s.info.type === 'STOCK');
  return {
    VNINDEX: stocks.filter((s) => s.info.exchange === 'HOSE'),
    VN30: stocks.filter((s) => s.info.isVn30),
    HNXINDEX: stocks.filter((s) => s.info.exchange === 'HNX'),
    UPCOMINDEX: stocks.filter((s) => s.info.exchange === 'UPCOM'),
  };
}

interface SnapshotDbRow {
  symbol: string;
  trade_date: string;
  ref: number;
  open: number;
  high: number;
  low: number;
  last: number;
  volume: number;
  value: number;
  foreign_buy: number;
  foreign_sell: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export class MarketService extends EventEmitter {
  readonly states = new Map<string, StockState>();
  private list: StockState[] = [];
  private indices: IndexState[] = [];
  tradeDate = '';
  phase: SessionPhase = 'CLOSED';
  hooks: MarketHooks = {};

  private cur1m = new Map<string, Candle>();
  private pendingCandles: [string, Candle][] = [];
  private pendingIndex: [string, number, number][] = [];
  private recent = new Map<string, TradeTick[]>();
  private dirty = new Set<string>();
  private tickBuffer: TradeTick[] = [];
  private candleDirty = new Set<string>();
  private lastIndexMinute = 0;
  private warming = false;
  private ticking = false;
  private tickCount = 0;
  private timer: NodeJS.Timeout | null = null;
  /** Nguồn thật: phiên định kỳ chờ giá khớp ATO/ATC của nguồn trong một khoảng ngắn */
  private pendingAuction: { kind: 'ATO' | 'ATC'; until: number; done: Set<string> } | null = null;
  private lastFeed: SessionInfo['feed'] = 'SIM';

  constructor(
    private db: Database,
    private provider: MarketDataProvider,
    readonly opts: { mode: MarketMode; tickIntervalMs: number },
  ) {
    super();
    this.setMaxListeners(50);
  }

  /* ============================ khởi tạo ============================ */

  private newState(r: StockDbRow, now: number): StockState {
    return {
      info: stockInfoOf(r),
      liq: r.liquidity,
      volatility: r.volatility,
      ref: 0,
      ceil: 0,
      floor: 0,
      open: 0,
      high: 0,
      low: 0,
      last: 0,
      lastVol: 0,
      lastSide: 'B',
      volume: 0,
      value: 0,
      bids: [],
      asks: [],
      foreignBuy: 0,
      foreignSell: 0,
      updatedAt: now,
      sim: { fair: 0, target: 0, bp: 0 },
    };
  }

  async init(now = Date.now()): Promise<void> {
    const rows = await this.db.many<StockDbRow>(`SELECT * FROM stocks WHERE status = 'ACTIVE' ORDER BY symbol`);
    const instruments = await loadInstrumentInfo(this.db);
    for (const r of rows) {
      const s = this.newState(r, now);
      if (r.type === 'CW') s.info.warrant = instruments.warrants.get(r.symbol);
      if (r.type === 'BOND') s.info.bond = instruments.bonds.get(r.symbol);
      this.states.set(r.symbol, s);
      this.list.push(s);
      this.recent.set(r.symbol, []);
    }
    this.sortList();
    await this.provider.start?.(this.list);

    const td = currentTradeDate(now, this.opts.mode);
    const snaps = await this.db.many<SnapshotDbRow>(
      `SELECT p.* FROM price_snapshots p JOIN stocks s ON s.symbol = p.symbol WHERE s.status = 'ACTIVE'`,
    );
    const snapMap = new Map(snaps.map((x) => [x.symbol, x]));
    const snapDate = snaps.length ? snaps[0].trade_date : null;
    const consistent = snapDate != null && snaps.every((x) => x.trade_date === snapDate) && snaps.length * 2 >= this.list.length;
    const closes = await this.db.many<{ symbol: string; close: number }>(
      `SELECT DISTINCT ON (symbol) symbol, close FROM ohlcv_daily WHERE trade_date < $1 ORDER BY symbol, trade_date DESC`,
      [td],
    );
    const closeMap = new Map(closes.map((c) => [c.symbol, c.close]));

    if (consistent && snapDate) {
      // Khôi phục trạng thái ngày đã lưu (mã mới thêm chưa có ảnh chụp → lấy giá đóng cửa gần nhất)
      for (const s of this.list) {
        const x = snapMap.get(s.info.symbol);
        if (!x) {
          const ref = closeMap.get(s.info.symbol);
          if (!ref) throw new Error(`Thiếu dữ liệu giá cho ${s.info.symbol}`);
          this.setRef(s, ref);
          s.last = ref;
          continue;
        }
        this.setRef(s, x.ref);
        Object.assign(s, {
          open: x.open,
          high: x.high,
          low: x.low,
          last: x.last,
          volume: x.volume,
          value: x.value,
          foreignBuy: x.foreign_buy,
          foreignSell: x.foreign_sell,
        });
      }
      this.tradeDate = snapDate;
      await this.buildIndices();
      if (snapDate === td) {
        this.provider.resume(this.list);
        const pts = await this.db.many<{ code: string; ts: number; value: number }>(
          'SELECT code, ts, value FROM index_intraday WHERE ts >= $1 ORDER BY ts',
          [Math.floor(vnTimeToMs(td, 0) / 1000)],
        );
        for (const p of pts) this.indices.find((i) => i.code === p.code)?.points.push({ ts: p.ts, value: p.value });
        this.phase = phaseAt(now, this.opts.mode);
        this.lastFeed = this.feed();
        return;
      }
      await this.rollover(td, now);
    } else {
      // Lần chạy đầu: giá tham chiếu = giá đóng cửa phiên gần nhất trong lịch sử
      for (const s of this.list) {
        // Mã mới niêm yết chưa có nến ngày: lấy giá tham chiếu đã lưu
        const ref = closeMap.get(s.info.symbol) ?? snapMap.get(s.info.symbol)?.ref;
        if (!ref) throw new Error(`Thiếu dữ liệu lịch sử cho ${s.info.symbol}`);
        this.setRef(s, ref);
        s.last = ref;
      }
      this.tradeDate = td;
      await this.buildIndices();
      this.provider.onNewDay(this.list);
    }
    await this.warmUp(now);
    await this.persistSnapshots();
    this.lastFeed = this.feed();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.tickIntervalMs);
  }

  async stop() {
    this.provider.stop?.();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flushPending(true);
    await this.persistSnapshots();
  }

  /* ============================ truy vấn ============================ */

  info(symbol: string): StockInfo | undefined {
    return this.states.get(symbol)?.info;
  }

  quote(symbol: string): StockState | undefined {
    return this.states.get(symbol);
  }

  snapshot(s: StockState): StockSnapshot {
    const traded = s.volume > 0;
    const change = traded ? s.last - s.ref : 0;
    return {
      symbol: s.info.symbol,
      ref: s.ref,
      ceil: s.ceil,
      floor: s.floor,
      open: s.open,
      high: s.high,
      low: s.low,
      last: traded ? s.last : 0,
      lastVol: s.lastVol,
      change,
      changePct: traded ? round2((change / s.ref) * 100) : 0,
      volume: s.volume,
      value: s.value,
      bids: s.bids.map((l) => ({ ...l })),
      asks: s.asks.map((l) => ({ ...l })),
      foreignBuy: s.foreignBuy,
      foreignSell: s.foreignSell,
      updatedAt: s.updatedAt,
    };
  }

  rows(): StockRow[] {
    return this.list.map((s) => ({ ...s.info, ...this.snapshot(s) }));
  }

  recentTrades(symbol: string): TradeTick[] {
    return this.recent.get(symbol) ?? [];
  }

  session(): SessionInfo {
    return { mode: this.opts.mode, phase: this.phase, tradeDate: this.tradeDate, serverTime: Date.now(), feed: this.feed() };
  }

  /** LIVE = đang hiển thị dữ liệu thật từ nguồn; SIM = giả lập */
  feed(): NonNullable<SessionInfo['feed']> {
    return this.provider.live ? 'LIVE' : 'SIM';
  }

  indexSnapshots(): IndexSnapshot[] {
    return this.indices.map((ix) => this.indexSnapshot(ix));
  }

  /** Giá hiện hành để định giá danh mục */
  markPrice(symbol: string): number {
    const s = this.states.get(symbol);
    if (!s) return 0;
    return s.volume > 0 ? s.last : s.ref;
  }

  /* ===================== tương tác từ bộ khớp lệnh ===================== */

  /**
   * Lệnh của người dùng "ăn" thanh khoản phía đối ứng trong sổ lệnh (tối đa 3 bước giá).
   * takerSide BUY → khớp với bên bán; limit = null nghĩa là lệnh thị trường.
   */
  consumeBook(symbol: string, takerSide: 'BUY' | 'SELL', qty: number, limit: number | null): { price: number; qty: number }[] {
    const s = this.states.get(symbol);
    if (!s || qty <= 0) return [];
    const book = takerSide === 'BUY' ? s.asks : s.bids;
    const fills: { price: number; qty: number }[] = [];
    let left = qty;
    for (const level of book) {
      if (left <= 0) break;
      if (limit != null && (takerSide === 'BUY' ? level.p > limit : level.p < limit)) break;
      const take = Math.min(left, level.v);
      if (take <= 0) continue;
      fills.push({ price: level.p, qty: take });
      level.v -= take;
      left -= take;
    }
    if (fills.length) {
      // Dịch sổ lệnh: bước giá cuối bị ăn hết thì giá đi tiếp 1 bước, còn dư thì bước đó thành giá tốt nhất
      const ex = s.info;
      const lastFill = fills[fills.length - 1];
      const lastLevelEmpty = (book.find((l) => l.p === lastFill.price)?.v ?? 0) <= 0;
      if (takerSide === 'BUY') {
        s.asks = s.asks.filter((l) => l.v > 0);
        s.sim.bp = lastLevelEmpty ? lastFill.price : stepPrice(ex, lastFill.price, -1);
      } else {
        s.bids = s.bids.filter((l) => l.v > 0);
        s.sim.bp = lastLevelEmpty ? stepPrice(ex, lastFill.price, -1) : lastFill.price;
      }
      this.provider.rebuildBook(s);
      this.dirty.add(symbol);
    }
    return fills;
  }

  /** Ghi nhận giao dịch phát sinh từ lệnh người dùng vào thị trường */
  recordTrade(symbol: string, price: number, qty: number, side: 'B' | 'S') {
    this.applyTrade(symbol, price, qty, side, Date.now(), false);
  }

  /* ============================ vòng lặp ============================ */

  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const td = currentTradeDate(now, this.opts.mode);
      if (td !== this.tradeDate) {
        await this.hooks.onDayEnd?.(this.tradeDate);
        await this.rollover(td, now);
        await this.hooks.onNewDay?.(td);
        this.emit('session', this.session());
      }
      const ph = phaseAt(now, this.opts.mode);
      if (ph !== this.phase) {
        const prev = this.phase;
        this.phase = ph;
        if (prev === 'ATO') await this.runAuction('ATO', now);
        if (prev === 'ATC') {
          // nguồn thật: onDayEnd chạy sau khi đã có giá khớp ATC (xem resolveAuction)
          const deferred = await this.runAuction('ATC', now);
          if (!deferred) await this.hooks.onDayEnd?.(this.tradeDate);
        }
        this.emit('session', this.session());
      }

      const tradesBySym = new Map<string, ProviderTrade>();
      // Nguồn thật vẫn được poll ngoài phiên liên tục để bảng giá luôn khớp với nguồn (bộ khớp lệnh tự bỏ qua)
      if (ph === 'CONTINUOUS' || this.provider.live) {
        const res = this.provider.poll(this.list, now, this.opts.tickIntervalMs);
        for (const t of res.trades) {
          this.applyTrade(t.symbol, t.price, t.vol, t.side, now, t.foreign);
          tradesBySym.set(t.symbol, t);
        }
        for (const sym of res.touched) this.dirty.add(sym);
      }
      if (this.pendingAuction) await this.resolveAuction(now);
      const feed = this.feed();
      if (feed !== this.lastFeed) {
        this.lastFeed = feed;
        this.emit('session', this.session());
      }
      this.rollMinutes(now);

      if (this.dirty.size) await this.hooks.onTick?.(new Set(this.dirty), tradesBySym);

      if (this.dirty.size) {
        const out: StockSnapshot[] = [];
        for (const sym of this.dirty) out.push(this.snapshot(this.states.get(sym)!));
        this.dirty.clear();
        this.emit('board', out);
      }
      if (this.tickBuffer.length) this.emit('trades', this.tickBuffer.splice(0));
      if (this.candleDirty.size) {
        const out: { symbol: string; candle: Candle }[] = [];
        for (const sym of this.candleDirty) {
          const c = this.cur1m.get(sym);
          if (c) out.push({ symbol: sym, candle: { ...c } });
        }
        this.candleDirty.clear();
        this.emit('candles', out);
      }
      this.emit('indices', this.indexSnapshots());
      await this.flushPending();
      if (++this.tickCount % 10 === 0) await this.persistSnapshots();
    } catch (err) {
      console.error('[market] lỗi tick', err);
    } finally {
      this.ticking = false;
    }
  }

  /* ============================ nến & lịch sử ============================ */

  async candles(symbol: string, tf: Timeframe): Promise<Candle[]> {
    const s = this.states.get(symbol);
    if (!s) return [];
    if (tf === '1m' || tf === '5m' || tf === '15m' || tf === '1h') {
      const since = Math.floor(Date.now() / 1000) - 6 * 86400;
      const rows = await this.db.many<Candle & { ts: number }>(
        'SELECT ts, open, high, low, close, volume FROM ohlcv_intraday WHERE symbol = $1 AND ts >= $2 ORDER BY ts',
        [symbol, since],
      );
      const list: Candle[] = rows.map((r) => ({ time: r.ts, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
      for (const [sym, c] of this.pendingCandles) if (sym === symbol) list.push({ ...c });
      const cur = this.cur1m.get(symbol);
      if (cur) list.push({ ...cur });
      list.sort((a, b) => a.time - b.time);
      const dedup = list.filter((c, i) => i === 0 || c.time !== list[i - 1].time);
      if (tf === '1m') return dedup;
      const period = tf === '5m' ? 300 : tf === '15m' ? 900 : 3600;
      return aggregate(dedup, (t) => Math.floor(t / period) * period);
    }
    const rows = await this.db.many<{ trade_date: string; open: number; high: number; low: number; close: number; volume: number }>(
      'SELECT trade_date, open, high, low, close, volume FROM ohlcv_daily WHERE symbol = $1 AND trade_date < $2 ORDER BY trade_date',
      [symbol, this.tradeDate],
    );
    const daily: Candle[] = rows.map((r) => ({
      time: Date.parse(`${r.trade_date}T00:00:00Z`) / 1000,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));
    if (s.volume > 0) {
      daily.push({
        time: Date.parse(`${this.tradeDate}T00:00:00Z`) / 1000,
        open: s.open,
        high: s.high,
        low: s.low,
        close: s.last,
        volume: s.volume,
      });
    }
    if (tf === '1D') return daily;
    if (tf === '1W') {
      return aggregate(daily, (t) => {
        const dow = (new Date(t * 1000).getUTCDay() + 6) % 7;
        return t - dow * 86400;
      });
    }
    return aggregate(daily, (t) => {
      const d = new Date(t * 1000);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
    });
  }

  async indexHistory(code: string, tf: '1m' | '1D'): Promise<{ time: number; value: number }[]> {
    const ix = this.indices.find((i) => i.code === code);
    if (!ix) return [];
    if (tf === '1m') return ix.points.map((p) => ({ time: p.ts, value: round2(p.value) }));
    const rows = await this.db.many<{ trade_date: string; close: number }>(
      'SELECT trade_date, close FROM index_daily WHERE code = $1 AND trade_date < $2 ORDER BY trade_date',
      [code, this.tradeDate],
    );
    const out = rows.map((r) => ({ time: Date.parse(`${r.trade_date}T00:00:00Z`) / 1000, value: round2(r.close) }));
    out.push({ time: Date.parse(`${this.tradeDate}T00:00:00Z`) / 1000, value: round2(this.indexValue(ix)) });
    return out;
  }

  /* ============================ nội bộ ============================ */

  /** Chứng quyền xếp cuối: biên độ chứng quyền tính theo giá cổ phiếu cơ sở (phải cập nhật trước) */
  private sortList() {
    const rank = (s: StockState) => (s.info.type === 'CW' ? 1 : 0);
    this.list.sort((a, b) => rank(a) - rank(b) || a.info.symbol.localeCompare(b.info.symbol));
  }

  private setRef(s: StockState, ref: number) {
    const w = s.info.warrant;
    const u = w ? this.states.get(w.underlying) : undefined;
    const band = w && u && u.ref > 0 ? warrantBand(ref, u, w.ratio) : priceBand(s.info, ref);
    s.ref = ref;
    s.ceil = band.ceil;
    s.floor = band.floor;
  }

  /* ===================== niêm yết / huỷ niêm yết lúc đang chạy ===================== */

  /**
   * Đổi thành phần rổ chỉ số mà giá trị chỉ số không nhảy: tính lại vốn hoá gốc (capRef)
   * sao cho chỉ số ngay sau thay đổi bằng chỉ số ngay trước (cách các Sở GDCK điều chỉnh hệ số chia).
   */
  private rebaseIndices(mutate: () => void) {
    const before = new Map(this.indices.map((ix) => [ix.code, this.indexValue(ix)]));
    mutate();
    const groups = indexGroups(this.list);
    for (const ix of this.indices) {
      ix.members = groups[ix.code] ?? [];
      const v = before.get(ix.code) ?? ix.prevClose;
      const cap = capOf(ix.members, false);
      ix.capRef = cap > 0 && v > 0 ? (ix.prevClose * cap) / v : capOf(ix.members, true);
    }
  }

  /** Thêm mã mới vào thị trường đang chạy (giá tham chiếu phiên đầu = ref) */
  async addStock(row: StockDbRow, ref: number): Promise<StockState> {
    if (this.states.has(row.symbol)) throw new Error(`Mã ${row.symbol} đã có trên bảng giá`);
    const s = this.newState(row, Date.now());
    this.rebaseIndices(() => {
      this.setRef(s, ref);
      s.last = ref;
      this.states.set(row.symbol, s);
      this.list.push(s);
      this.sortList();
      this.recent.set(row.symbol, []);
    });
    if (this.provider.addSymbol) this.provider.addSymbol(s);
    else this.provider.onNewDay([s]);
    this.dirty.add(row.symbol);
    await this.persistSnapshots();
    this.emit('symbols');
    return s;
  }

  /** Gỡ mã khỏi bảng giá (huỷ niêm yết) — dữ liệu lịch sử vẫn giữ trong CSDL */
  removeStock(symbol: string) {
    const s = this.states.get(symbol);
    if (!s) return;
    this.rebaseIndices(() => {
      this.states.delete(symbol);
      this.list = this.list.filter((x) => x !== s);
      this.recent.delete(symbol);
      this.cur1m.delete(symbol);
      this.dirty.delete(symbol);
      this.candleDirty.delete(symbol);
    });
    this.provider.removeSymbol?.(symbol);
    this.emit('symbols');
  }

  /**
   * Sự kiện quyền ngày GDKHQ (trước phiên): đặt giá tham chiếu điều chỉnh, KL niêm yết mới (cổ tức CP / chia tách),
   * khởi tạo lại mô phỏng quanh giá mới; biên độ chứng quyền trên mã này được tính lại.
   */
  applyCorporateAdjustment(symbol: string, newRef: number, listedShares?: number) {
    const s = this.states.get(symbol);
    if (!s) return;
    if (listedShares) s.info.listedShares = listedShares;
    this.setRef(s, newRef);
    Object.assign(s, { last: newRef, open: 0, high: 0, low: 0, volume: 0, value: 0, lastVol: 0 });
    this.provider.onNewDay([s]);
    for (const cw of this.list) if (cw.info.warrant?.underlying === symbol) this.setRef(cw, cw.ref);
    this.dirty.add(symbol);
  }

  /** Cập nhật thông tin mã (tên, ngành, rổ VN30, KL niêm yết, tỷ lệ ký quỹ, thanh khoản...) */
  updateStock(symbol: string, patch: Partial<Pick<StockState['info'], 'name' | 'industry' | 'isVn30' | 'listedShares' | 'marginRatio' | 'eps' | 'bvps'>> & { liq?: number; volatility?: number }) {
    const s = this.states.get(symbol);
    if (!s) return;
    const { liq, volatility, ...info } = patch;
    const affectsIndex = (info.isVn30 !== undefined && info.isVn30 !== s.info.isVn30) || (info.listedShares !== undefined && info.listedShares !== s.info.listedShares);
    const apply = () => {
      Object.assign(s.info, info);
      if (liq !== undefined) s.liq = liq;
      if (volatility !== undefined) s.volatility = volatility;
    };
    if (affectsIndex) this.rebaseIndices(apply);
    else apply();
    this.emit('symbols');
  }

  private applyTrade(symbol: string, price: number, vol: number, side: 'B' | 'S', timeMs: number, foreign: boolean) {
    const s = this.states.get(symbol);
    if (!s || vol <= 0) return;
    s.last = price;
    s.lastVol = vol;
    s.lastSide = side;
    if (!s.open) s.open = price;
    s.high = s.high ? Math.max(s.high, price) : price;
    s.low = s.low ? Math.min(s.low, price) : price;
    s.volume += vol;
    s.value += price * vol;
    if (foreign) {
      if (side === 'B') s.foreignBuy += vol;
      else s.foreignSell += vol;
    }
    s.updatedAt = timeMs;

    const minute = Math.floor(timeMs / 60_000) * 60;
    let c = this.cur1m.get(symbol);
    if (!c || c.time !== minute) {
      if (c) this.pendingCandles.push([symbol, c]);
      c = { time: minute, open: price, high: price, low: price, close: price, volume: 0 };
      this.cur1m.set(symbol, c);
    }
    c.high = Math.max(c.high, price);
    c.low = Math.min(c.low, price);
    c.close = price;
    c.volume += vol;

    const tick: TradeTick = { symbol, time: timeMs, price, vol, side };
    const tape = this.recent.get(symbol)!;
    tape.unshift(tick);
    if (tape.length > 60) tape.pop();
    if (!this.warming) {
      this.tickBuffer.push(tick);
      this.candleDirty.add(symbol);
    }
    this.dirty.add(symbol);
  }

  private rollMinutes(nowMs: number) {
    const minute = Math.floor(nowMs / 60_000) * 60;
    for (const [sym, c] of this.cur1m) {
      if (c.time < minute) {
        this.pendingCandles.push([sym, c]);
        this.cur1m.delete(sym);
      }
    }
    if (minute !== this.lastIndexMinute) {
      this.lastIndexMinute = minute;
      for (const ix of this.indices) {
        const value = this.indexValue(ix);
        ix.points.push({ ts: minute, value });
        this.pendingIndex.push([ix.code, minute, value]);
      }
    }
  }

  /** Trả true nếu phiên định kỳ được hoãn tới khi nguồn thật có giá khớp */
  private async runAuction(kind: 'ATO' | 'ATC', nowMs: number): Promise<boolean> {
    if (this.provider.live) {
      // Nguồn thật: KL khớp ATO/ATC đã nằm trong KL luỹ kế của nguồn — chỉ chờ giá khớp thật để khớp lệnh người dùng
      this.pendingAuction = { kind, until: nowMs + 30_000, done: new Set() };
      await this.resolveAuction(nowMs);
      return true;
    }
    const prices = new Map<string, number>();
    for (const s of this.list) {
      const price = this.provider.auctionPrice(s, kind);
      const vol = Math.max(1, Math.round((5 + s.liq * 80) * (0.5 + Math.random()))) * 100;
      this.applyTrade(s.info.symbol, price, vol, price >= (s.last || s.ref) ? 'B' : 'S', nowMs, false);
      prices.set(s.info.symbol, price);
    }
    if (!this.warming) await this.hooks.onAuction?.(kind, prices);
    return false;
  }

  private async resolveAuction(nowMs: number) {
    const pa = this.pendingAuction!;
    const prices = new Map<string, number>();
    for (const s of this.list) {
      const sym = s.info.symbol;
      if (pa.done.has(sym)) continue;
      const price = this.provider.auctionPrice(s, pa.kind);
      if (price > 0) {
        prices.set(sym, price);
        pa.done.add(sym);
      }
    }
    if (prices.size) await this.hooks.onAuction?.(pa.kind, prices);
    if (pa.done.size < this.list.length && nowMs < pa.until) return;
    this.pendingAuction = null;
    if (pa.kind === 'ATC') await this.hooks.onDayEnd?.(this.tradeDate);
  }

  /** Mô phỏng nhanh khoảng thời gian đã qua trong phiên để bảng giá/biểu đồ có dữ liệu ngay khi mở */
  private async warmUp(now: number) {
    if (this.provider.live) {
      // Nguồn thật: không mô phỏng phần phiên đã qua, chỉ đồng bộ trạng thái hiện tại của nguồn
      this.warming = true;
      const res = this.provider.poll(this.list, now, 0);
      for (const tr of res.trades) this.applyTrade(tr.symbol, tr.price, tr.vol, tr.side, now, tr.foreign);
      this.warming = false;
      this.dirty.clear();
      this.phase = phaseAt(now, this.opts.mode);
      return;
    }
    const td = this.tradeDate;
    let start: number;
    let end: number;
    if (this.opts.mode === 'SIMULATED_24_7') {
      start = Math.max(now - 4 * 3600_000, vnTimeToMs(td, 0));
      end = now;
    } else {
      start = vnTimeToMs(td, 9 * 60);
      end = Math.min(now, vnTimeToMs(td, 15 * 60));
    }
    this.warming = true;
    const step = 5000;
    let prev = phaseAt(start, this.opts.mode);
    for (let t = start; t < end; t += step) {
      const ph = phaseAt(t, this.opts.mode);
      if (prev === 'ATO' && ph !== 'ATO') await this.runAuction('ATO', t);
      if (prev === 'ATC' && ph !== 'ATC') await this.runAuction('ATC', t);
      prev = ph;
      if (ph === 'CONTINUOUS') {
        const res = this.provider.poll(this.list, t, step);
        for (const tr of res.trades) this.applyTrade(tr.symbol, tr.price, tr.vol, tr.side, t, tr.foreign);
      }
      this.rollMinutes(t);
    }
    this.warming = false;
    this.dirty.clear();
    this.phase = phaseAt(now, this.opts.mode);
    await this.flushPending(true);
  }

  private async rollover(newDate: string, now: number) {
    this.pendingAuction = null;
    await this.finalizeDay();
    for (const s of this.list) {
      this.setRef(s, s.volume > 0 ? s.last : s.ref);
      s.open = s.high = s.low = 0;
      s.last = s.ref;
      s.lastVol = 0;
      s.volume = s.value = 0;
      s.foreignBuy = s.foreignSell = 0;
      s.updatedAt = now;
      this.recent.set(s.info.symbol, []);
    }
    for (const [sym, c] of this.cur1m) this.pendingCandles.push([sym, c]);
    this.cur1m.clear();
    for (const ix of this.indices) {
      ix.prevClose = this.indexValue(ix);
      ix.points = [];
    }
    this.tradeDate = newDate;
    this.provider.onNewDay(this.list);
    for (const ix of this.indices) ix.capRef = capOf(ix.members, true);
    await this.flushPending(true);
    const cutoff = Math.floor(now / 1000) - 7 * 86400;
    await this.db.many('DELETE FROM ohlcv_intraday WHERE ts < $1', [cutoff]);
    await this.db.many('DELETE FROM index_intraday WHERE ts < $1', [cutoff]);
    await this.persistSnapshots();
    for (const s of this.list) this.dirty.add(s.info.symbol);
    console.log(`[market] sang ngày giao dịch mới ${newDate}`);
  }

  /** Chốt nến ngày và chỉ số của ngày giao dịch hiện tại */
  private async finalizeDay() {
    const date = this.tradeDate;
    const traded = this.list.filter((s) => s.volume > 0);
    for (let i = 0; i < traded.length; i += 200) {
      const chunk = traded.slice(i, i + 200);
      const params: unknown[] = [];
      const values = chunk.map((s, j) => {
        params.push(s.info.symbol, date, s.open, s.high, s.low, s.last, s.volume, s.value);
        const b = j * 8;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`;
      });
      await this.db.many(
        `INSERT INTO ohlcv_daily (symbol, trade_date, open, high, low, close, volume, value) VALUES ${values.join(',')}
         ON CONFLICT (symbol, trade_date) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
         close = EXCLUDED.close, volume = EXCLUDED.volume, value = EXCLUDED.value`,
        params,
      );
    }
    for (const ix of this.indices) {
      const close = this.indexValue(ix);
      const vals = ix.points.map((p) => p.value);
      const open = vals[0] ?? ix.prevClose;
      const high = Math.max(close, ...vals);
      const low = Math.min(close, ...vals);
      const volume = ix.members.reduce((a, s) => a + s.volume, 0);
      const value = ix.members.reduce((a, s) => a + s.value, 0);
      await this.db.many(
        `INSERT INTO index_daily (code, trade_date, open, high, low, close, volume, value) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (code, trade_date) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
         close = EXCLUDED.close, volume = EXCLUDED.volume, value = EXCLUDED.value`,
        [ix.code, date, open, high, low, close, volume, value],
      );
    }
  }

  private async buildIndices() {
    const groups = indexGroups(this.list);
    const prev = await this.db.many<{ code: string; close: number }>(
      `SELECT DISTINCT ON (code) code, close FROM index_daily WHERE trade_date < $1 ORDER BY code, trade_date DESC`,
      [this.tradeDate],
    );
    const prevMap = new Map(prev.map((p) => [p.code, p.close]));
    this.indices = INDEX_DEFS.map((d) => ({
      code: d.code,
      name: d.name,
      members: groups[d.code],
      prevClose: prevMap.get(d.code) ?? d.base,
      capRef: capOf(groups[d.code], true),
      points: [],
    }));
  }

  private indexValue(ix: IndexState): number {
    const real = this.provider.indexValue?.(ix.code, this.tradeDate);
    if (real) return real;
    if (!ix.capRef) return ix.prevClose;
    return (ix.prevClose * capOf(ix.members, false)) / ix.capRef;
  }

  private indexSnapshot(ix: IndexState): IndexSnapshot {
    const value = this.indexValue(ix);
    let advances = 0;
    let declines = 0;
    let unchanged = 0;
    let ceilings = 0;
    let floors = 0;
    let volume = 0;
    let totalValue = 0;
    for (const s of ix.members) {
      volume += s.volume;
      totalValue += s.value;
      if (s.volume === 0 || s.last === s.ref) unchanged++;
      else if (s.last > s.ref) {
        advances++;
        if (s.last >= s.ceil) ceilings++;
      } else {
        declines++;
        if (s.last <= s.floor) floors++;
      }
    }
    const pts = ix.points;
    const stepN = Math.max(1, Math.ceil(pts.length / 120));
    const spark: number[] = [];
    for (let i = 0; i < pts.length; i += stepN) spark.push(round2(pts[i].value));
    spark.push(round2(value));
    return {
      code: ix.code,
      name: ix.name,
      value: round2(value),
      prevClose: round2(ix.prevClose),
      change: round2(value - ix.prevClose),
      changePct: round2(((value - ix.prevClose) / ix.prevClose) * 100),
      volume,
      totalValue,
      advances,
      declines,
      unchanged,
      ceilings,
      floors,
      spark,
    };
  }

  private async flushPending(all = false) {
    if (!all && this.pendingCandles.length < 1 && this.pendingIndex.length < 1) return;
    const candles = this.pendingCandles.splice(0);
    for (let i = 0; i < candles.length; i += 500) {
      const chunk = candles.slice(i, i + 500);
      const params: unknown[] = [];
      const values = chunk.map(([sym, c], j) => {
        params.push(sym, c.time, c.open, c.high, c.low, c.close, c.volume);
        const b = j * 7;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
      });
      await this.db.many(
        `INSERT INTO ohlcv_intraday (symbol, ts, open, high, low, close, volume) VALUES ${values.join(',')}
         ON CONFLICT (symbol, ts) DO UPDATE SET high = GREATEST(ohlcv_intraday.high, EXCLUDED.high),
         low = LEAST(ohlcv_intraday.low, EXCLUDED.low), close = EXCLUDED.close, volume = ohlcv_intraday.volume + EXCLUDED.volume`,
        params,
      );
    }
    const pts = this.pendingIndex.splice(0);
    for (let i = 0; i < pts.length; i += 1000) {
      const chunk = pts.slice(i, i + 1000);
      const params: unknown[] = [];
      const values = chunk.map(([code, ts, v], j) => {
        params.push(code, ts, v);
        return `($${j * 3 + 1},$${j * 3 + 2},$${j * 3 + 3})`;
      });
      await this.db.many(
        `INSERT INTO index_intraday (code, ts, value) VALUES ${values.join(',')} ON CONFLICT (code, ts) DO UPDATE SET value = EXCLUDED.value`,
        params,
      );
    }
  }

  async persistSnapshots() {
    const params: unknown[] = [];
    const values = this.list.map((s, j) => {
      params.push(s.info.symbol, this.tradeDate, s.ref, s.open, s.high, s.low, s.last, s.volume, s.value, s.foreignBuy, s.foreignSell);
      const b = j * 11;
      return `(${Array.from({ length: 11 }, (_, k) => `$${b + k + 1}`).join(',')}, now())`;
    });
    await this.db.many(
      `INSERT INTO price_snapshots (symbol, trade_date, ref, open, high, low, last, volume, value, foreign_buy, foreign_sell, updated_at)
       VALUES ${values.join(',')}
       ON CONFLICT (symbol) DO UPDATE SET trade_date = EXCLUDED.trade_date, ref = EXCLUDED.ref, open = EXCLUDED.open,
       high = EXCLUDED.high, low = EXCLUDED.low, last = EXCLUDED.last, volume = EXCLUDED.volume, value = EXCLUDED.value,
       foreign_buy = EXCLUDED.foreign_buy, foreign_sell = EXCLUDED.foreign_sell, updated_at = now()`,
      params,
    );
  }
}

function capOf(members: StockState[], atRef: boolean): number {
  let cap = 0;
  for (const s of members) {
    const p = atRef || s.volume === 0 ? s.ref : s.last;
    cap += p * s.info.listedShares;
  }
  return cap;
}

function aggregate(candles: Candle[], keyOf: (t: number) => number): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const k = keyOf(c.time);
    const last = out[out.length - 1];
    if (last && last.time === k) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else {
      out.push({ ...c, time: k });
    }
  }
  return out;
}
