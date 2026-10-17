import { EventEmitter } from 'node:events';
import {
  Big,
  floorStep,
  priceOnPath,
  str,
  type BookLevel,
  type Dec,
  type DepthSnapshot,
  type FeedKind,
  type Kline,
  type KlineInterval,
  type MarketStatus,
  type PriceControl,
  type Side,
  type SymbolInfo,
  type SymbolRow,
  type SymbolStatus,
  type Ticker24h,
  type TradeTick,
} from '@vss/shared';
import type { Database } from '../db';
import { log } from '../lib/logger';
import { gaussian, mulberry32 } from '../lib/prng';
import type { BinanceRest } from './binance/rest';
import { BinanceStream, type MiniTicker } from './binance/stream';
import { SimFeed, type SimStep } from './simFeed';
import { loadSymbols, toSymbolInfo, type SymbolRowDb } from './symbols';

/*
 * Dữ liệu thị trường Spot: nhận luồng Binance (hoặc giả lập khi mất nguồn), giữ trạng thái từng cặp,
 * và mỗi chu kỳ (flushMs) gọi hooks.onTick để engine khớp lệnh rồi phát sự kiện cho client:
 *   tickers  Ticker24h[] các cặp thay đổi (tối đa 1 lần / giây)
 *   depth    DepthSnapshot của cặp có sổ lệnh thay đổi
 *   trades   TradeTick[] giao dịch mới
 *   klines   { symbol, kline } nến 1 phút đang chạy
 *   feed     MarketStatus khi chuyển LIVE ⇄ SIM
 *   symbols  danh sách cặp thay đổi (thêm / gỡ / tạm ngừng)
 *
 * Khớp lệnh ảo: lệnh người dùng "ăn" sổ lệnh thật (consumeBook) nhưng không gửi lên Binance; phần đã ăn
 * được ghi nhớ tới khi có bản sổ lệnh mới để 2 lệnh liên tiếp không khớp trùng cùng một thanh khoản.
 *
 * Giá điều chỉnh (quản trị viên, `control`): cặp bỏ qua luồng Binance (chỉ nhớ giá tham chiếu `ref`), mỗi chu kỳ
 * sàn tự sinh giá theo kịch bản (priceOnPath + dao động), sổ lệnh và giao dịch quanh giá đó → lệnh khớp theo giá này.
 */

export interface SymbolState {
  info: SymbolInfo;
  ticker: Ticker24h;
  bids: BookLevel[];
  asks: BookLevel[];
  bookTs: number;
  /** Khối lượng đã bị lệnh người dùng ăn ở từng mức giá của bản sổ lệnh hiện tại */
  consumed: { BUY: Map<string, Big>; SELL: Map<string, Big> };
  trades: TradeTick[];
  /** Cửa sổ 5 phút để tính giá trung bình gia quyền (PERCENT_PRICE / NOTIONAL của lệnh MARKET) */
  vwap: { t: number; pq: number; q: number }[];
  /** Nến 1 phút gần nhất (tối đa 1 ngày) */
  bars: Kline[];
  /** Kịch bản giá điều chỉnh; null = giá thực tế (Binance) */
  control: PriceControl | null;
  /** Độ lệch dao động hiện tại so với đường giá kịch bản (tỉ lệ, vd. 0.001 = +0,1%) */
  dev: number;
  /** Giá Binance gần nhất — vẫn theo dõi khi cặp đang ở giá điều chỉnh để quản trị viên so sánh */
  ref: string | null;
}

export interface MarketHooks {
  onTick?(changed: Set<string>, trades: Map<string, TradeTick[]>): Promise<void>;
}

export interface MarketOptions {
  feed: 'binance' | 'sim';
  wsUrl?: string;
  flushMs?: number;
  /** Mất dữ liệu thật quá lâu → chuyển sang giả lập */
  simAfterMs?: number;
}

export interface BookFill {
  price: Dec;
  qty: Dec;
}

const MAX_TRADES = 80;
const MAX_BARS = 1440;
const VWAP_MS = 5 * 60_000;

const INTERVAL_SEC: Record<KlineInterval, number> = {
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14_400,
  '1d': 86_400,
  '1w': 604_800,
  '1M': 2_592_000,
};

/** Thời điểm mở nến chứa time (giây UTC) theo khung — tuần bắt đầu thứ Hai, tháng bắt đầu ngày 1 (như Binance) */
export function bucketOf(time: number, interval: KlineInterval): number {
  if (interval === '1M') {
    const d = new Date(time * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  }
  if (interval === '1w') {
    const day = Math.floor(time / 86_400);
    // 1970-01-01 là thứ Năm → thứ Hai gần nhất phía trước
    const monday = day - ((day + 3) % 7);
    return monday * 86_400;
  }
  const s = INTERVAL_SEC[interval];
  return Math.floor(time / s) * s;
}

export function aggregateBars(bars: Kline[], interval: KlineInterval): Kline[] {
  if (interval === '1m') return bars.slice();
  const out: Kline[] = [];
  for (const b of bars) {
    const t = bucketOf(b.time, interval);
    const cur = out[out.length - 1];
    if (cur && cur.time === t) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    } else out.push({ ...b, time: t });
  }
  return out;
}

function emptyTicker(symbol: string, last: string | null): Ticker24h {
  const p = last ?? '0';
  return { symbol, last: p, open: p, high: p, low: p, change: '0', changePct: 0, volume: '0', quoteVolume: '0', bid: p, ask: p, updatedAt: Date.now() };
}

export class MarketService extends EventEmitter {
  private states = new Map<string, SymbolState>();
  hooks: MarketHooks = {};
  private stream: BinanceStream | null = null;
  private live = false;
  private downSince = Date.now();
  private readonly sim = new SimFeed();
  private lastSimAt = Date.now();
  private lastManualAt = Date.now();
  private readonly rand = mulberry32(Date.now() ^ 0x5eed);
  private pendingTrades = new Map<string, TradeTick[]>();
  private changedBook = new Set<string>();
  private changedTicker = new Set<string>();
  private changedKline = new Set<string>();
  private lastTickerEmit = 0;
  private lastFeed: FeedKind | null = null;
  private timer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private klineCache = new Map<string, { at: number; ttl: number; data: Kline[] }>();

  constructor(
    private db: Database,
    private rest: BinanceRest | null,
    readonly opts: MarketOptions,
  ) {
    super();
    this.setMaxListeners(50);
  }

  /* ============================== vòng đời ============================== */

  async init(): Promise<void> {
    const rows = await loadSymbols(this.db);
    for (const r of rows) this.addState(r);
    if (this.opts.feed === 'binance' && this.rest && rows.length) {
      try {
        const tickers = await this.rest.tickers(rows.map((r) => r.symbol));
        for (const t of tickers) {
          const s = this.states.get(t.symbol);
          if (!s) continue;
          s.ref = t.last;
          if (!s.control) s.ticker = t;
        }
      } catch (err) {
        log.warn('[market] không tải được ticker 24h từ Binance, dùng giá lưu trong CSDL', { err });
      }
    }
    // Sổ lệnh ban đầu (giả lập quanh giá cuối) để có thể khớp ngay cả trước khi luồng thật kết nối
    for (const s of this.states.values()) this.seedBook(s);
    if (this.opts.feed === 'binance') {
      this.stream = new BinanceStream(
        {
          miniTickers: (l) => this.onMiniTickers(l),
          depth: (sym, b, a) => this.onDepth(sym, b, a),
          trade: (t) => this.onTrade(t),
          kline: (sym, k) => this.onKline(sym, k),
          status: (v) => this.onStatus(v),
        },
        { url: this.opts.wsUrl ?? 'wss://data-stream.binance.vision' },
      );
    }
  }

  start() {
    this.downSince = Date.now();
    this.stream?.start([...this.states.keys()]);
    this.timer = setInterval(() => void this.flush(), this.opts.flushMs ?? 200);
    this.persistTimer = setInterval(() => void this.persistPrices(), 60_000);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.persistTimer) clearInterval(this.persistTimer);
    this.stream?.stop();
    await this.persistPrices().catch(() => undefined);
  }

  /* ============================== trạng thái đọc ============================== */

  feed(): FeedKind {
    return this.usingSim() ? 'SIM' : 'LIVE';
  }

  status(): MarketStatus {
    return { feed: this.feed(), source: this.opts.feed, serverTime: Date.now() };
  }

  symbols(): string[] {
    return [...this.states.keys()];
  }

  info(symbol: string): SymbolInfo | undefined {
    return this.states.get(symbol)?.info;
  }

  state(symbol: string): SymbolState | undefined {
    return this.states.get(symbol);
  }

  rows(): SymbolRow[] {
    return [...this.states.values()].map((s) => ({ ...s.info, ...s.ticker }));
  }

  tickers(): Ticker24h[] {
    return [...this.states.values()].map((s) => s.ticker);
  }

  depth(symbol: string, limit = 20): DepthSnapshot | null {
    const s = this.states.get(symbol);
    if (!s) return null;
    return { symbol, bids: this.view(s, 'SELL').slice(0, limit), asks: this.view(s, 'BUY').slice(0, limit), ts: s.bookTs };
  }

  recentTrades(symbol: string): TradeTick[] {
    return this.states.get(symbol)?.trades.slice().reverse() ?? [];
  }

  lastPrice(symbol: string): Dec | null {
    const p = this.states.get(symbol)?.ticker.last;
    return p && p !== '0' ? p : null;
  }

  /** Giá trung bình gia quyền 5 phút (như avgPrice của Binance); chưa có giao dịch → giá cuối */
  avgPrice(symbol: string): Dec | null {
    const s = this.states.get(symbol);
    if (!s) return null;
    const cutoff = Date.now() - VWAP_MS;
    let pq = 0;
    let q = 0;
    for (const w of s.vwap) {
      if (w.t < cutoff) continue;
      pq += w.pq;
      q += w.q;
    }
    if (q > 0) return floorStep(new Big(pq / q).toFixed(12), s.info.filters.tickSize);
    return this.lastPrice(symbol);
  }

  /** Giá 1 đơn vị tài sản theo USDT (null khi không có cặp XXXUSDT) */
  priceUsdt(asset: string): Dec | null {
    if (asset === 'USDT') return '1';
    return this.lastPrice(`${asset}USDT`);
  }

  /** Giá tốt nhất còn lại (đã trừ phần lệnh người dùng ăn): bên bán cho lệnh mua và ngược lại */
  best(symbol: string, takerSide: Side): Dec | null {
    const s = this.states.get(symbol);
    if (!s) return null;
    return this.view(s, takerSide)[0]?.[0] ?? null;
  }

  /** Các mức giá còn lại phía đối ứng của lệnh taker */
  private view(s: SymbolState, takerSide: Side): BookLevel[] {
    const levels = takerSide === 'BUY' ? s.asks : s.bids;
    const used = s.consumed[takerSide];
    if (!used.size) return levels;
    const out: BookLevel[] = [];
    for (const [p, q] of levels) {
      const u = used.get(p);
      if (!u) out.push([p, q]);
      else {
        const left = new Big(q).minus(u);
        if (left.gt(0)) out.push([p, left.toFixed()]);
      }
    }
    return out;
  }

  /**
   * Lệnh taker ăn sổ lệnh: theo khối lượng (qty) hoặc theo số tiền (quote), dừng ở giá giới hạn (limit).
   * dryRun = true chỉ tính (dùng cho FOK / LIMIT_MAKER), không ghi nhận phần đã ăn.
   */
  consumeBook(
    symbol: string,
    takerSide: Side,
    want: { qty?: Dec; quote?: Dec },
    limit: Dec | null,
    dryRun = false,
  ): BookFill[] {
    const s = this.states.get(symbol);
    if (!s) return [];
    const step = s.info.filters.stepSize;
    let leftQty = want.qty ? new Big(want.qty) : null;
    let leftQuote = want.quote ? new Big(want.quote) : null;
    const fills: BookFill[] = [];
    for (const [p, q] of this.view(s, takerSide)) {
      if (limit && (takerSide === 'BUY' ? new Big(p).gt(limit) : new Big(p).lt(limit))) break;
      let take = new Big(q);
      if (leftQty) take = take.lt(leftQty) ? take : leftQty;
      if (leftQuote) {
        const byQuote = new Big(floorStep(leftQuote.div(p), step));
        if (byQuote.lt(take)) take = byQuote;
      }
      if (take.lte(0)) break;
      fills.push({ price: p, qty: take.toFixed() });
      if (!dryRun) {
        const used = s.consumed[takerSide];
        used.set(p, (used.get(p) ?? new Big(0)).plus(take));
      }
      if (leftQty) {
        leftQty = leftQty.minus(take);
        if (leftQty.lte(0)) break;
      }
      if (leftQuote) {
        leftQuote = leftQuote.minus(take.times(p));
        if (leftQuote.lte(0)) break;
      }
    }
    if (!dryRun && fills.length) this.changedBook.add(symbol);
    return fills;
  }

  /* ============================== nến ============================== */

  async candles(symbol: string, interval: KlineInterval, limit = 500, endTime?: number): Promise<Kline[]> {
    const s = this.states.get(symbol);
    if (!s) return [];
    if (this.rest && this.opts.feed === 'binance') {
      // Giá điều chỉnh: lịch sử thật chỉ tới lúc bắt đầu điều chỉnh, phần sau là nến của giá điều chỉnh (trong bộ nhớ)
      const since = s.control?.since ?? null;
      const restEnd = since != null ? Math.min(endTime ?? since, since) : endTime;
      const key = `${symbol}:${interval}:${limit}:${restEnd ?? ''}`;
      const hit = this.klineCache.get(key);
      let data: Kline[] | null = hit && Date.now() - hit.at < hit.ttl ? hit.data : null;
      if (!data) {
        try {
          data = await this.rest.klines(symbol, interval, limit, restEnd);
          this.klineCache.set(key, { at: Date.now(), ttl: restEnd ? 600_000 : 15_000, data });
          if (this.klineCache.size > 500) this.klineCache.delete(this.klineCache.keys().next().value!);
        } catch (err) {
          log.warn(`[market] không tải được nến ${symbol} ${interval} từ Binance, dùng nến trong bộ nhớ`, { err });
        }
      }
      if (data) return since != null ? this.withManualBars(s, since, data, interval, limit, endTime) : this.mergeLive(s, data, interval, !endTime);
    }
    const bars = aggregateBars(s.bars, interval);
    const filtered = endTime ? bars.filter((b) => b.time * 1000 <= endTime) : bars;
    return filtered.slice(-limit);
  }

  /** Nến Binance tới lúc bắt đầu giá điều chỉnh + nến giá điều chỉnh từ đó (nến 1 phút trong bộ nhớ, tối đa 1 ngày) */
  private withManualBars(s: SymbolState, since: number, data: Kline[], interval: KlineInterval, limit: number, endTime?: number): Kline[] {
    const out = data.map((k) => ({ ...k }));
    const own = aggregateBars(
      s.bars.filter((b) => b.time * 1000 >= Math.floor(since / 60_000) * 60_000),
      interval,
    );
    for (const b of own) {
      const last = out[out.length - 1];
      if (last && last.time === b.time) {
        last.high = Math.max(last.high, b.high);
        last.low = Math.min(last.low, b.low);
        last.close = b.close;
        last.volume += b.volume;
      } else if (!last || b.time > last.time) out.push({ ...b });
    }
    const filtered = endTime ? out.filter((b) => b.time * 1000 <= endTime) : out;
    return filtered.slice(-limit);
  }

  /** Nến cuối từ REST có thể cũ tới 15s: cập nhật bằng nến 1 phút trong bộ nhớ */
  private mergeLive(s: SymbolState, data: Kline[], interval: KlineInterval, latest: boolean): Kline[] {
    const out = data.map((k) => ({ ...k }));
    if (!latest || !out.length || !s.bars.length) return out;
    const lastBar = out[out.length - 1]!;
    for (const b of s.bars) {
      const t = bucketOf(b.time, interval);
      if (t < lastBar.time) continue;
      if (t === lastBar.time) {
        if (b.time >= lastBar.time) {
          lastBar.high = Math.max(lastBar.high, b.high);
          lastBar.low = Math.min(lastBar.low, b.low);
          lastBar.close = b.close;
        }
      } else out.push({ ...b, time: t });
    }
    return out;
  }

  /* ============================== quản trị ============================== */

  async addSymbolRow(row: SymbolRowDb) {
    const s = this.addState(row);
    this.seedBook(s);
    if (this.rest && this.opts.feed === 'binance') {
      try {
        const [t] = await this.rest.tickers([row.symbol]);
        if (t) {
          s.ref = t.last;
          if (!s.control) s.ticker = t;
        }
      } catch {
        /* dùng giá lưu trong CSDL */
      }
    }
    this.stream?.setSymbols([...this.states.keys()]);
    this.emit('symbols');
  }

  removeSymbol(symbol: string) {
    if (!this.states.delete(symbol)) return;
    this.stream?.setSymbols([...this.states.keys()]);
    this.emit('symbols');
  }

  setStatus(symbol: string, status: SymbolStatus) {
    const s = this.states.get(symbol);
    if (!s) return;
    s.info = { ...s.info, status };
    this.emit('symbols');
  }

  /** Kịch bản giá điều chỉnh của cặp (null = giá thực tế) và giá Binance gần nhất */
  priceControl(symbol: string): { control: PriceControl | null; ref: string | null } | null {
    const s = this.states.get(symbol);
    return s ? { control: s.control, ref: s.ref } : null;
  }

  /**
   * Bật / đổi kịch bản (control) hoặc tắt (null) giá điều chỉnh. Nơi gọi (trang quản trị) chịu trách nhiệm
   * lưu CSDL và ghi nhật ký; ở đây chỉ đổi trạng thái trong bộ nhớ.
   */
  setPriceControl(symbol: string, control: PriceControl | null) {
    const s = this.states.get(symbol);
    if (!s) return;
    const wasManual = !!s.control;
    s.control = control;
    if (!control) {
      s.dev = 0;
      // Về giá thực tế: dùng ngay giá Binance gần nhất; sổ lệnh / thống kê 24h thật tới ở bản cập nhật kế tiếp
      if (s.ref && !this.usingSim()) {
        s.ticker.last = s.ref;
        this.seedBook(s);
        this.changedTicker.add(symbol);
      }
    }
    s.info = { ...s.info, priceMode: control ? 'MANUAL' : 'LIVE', priceSince: control?.since ?? null };
    if (wasManual !== !!control) this.emit('symbols');
  }

  /** Giả lập: ép giá của cặp ở bước kế tiếp (test, minh hoạ lệnh dừng) */
  forcePrice(symbol: string, price: Dec) {
    this.sim.forced.set(symbol, price);
  }

  async persistPrices() {
    for (const s of this.states.values()) {
      if (s.ticker.last === '0') continue;
      await this.db.many('UPDATE symbols SET last_price = $2 WHERE symbol = $1', [s.info.symbol, s.ticker.last]);
    }
  }

  /** Chạy 1 chu kỳ ngay (test) */
  async flushNow() {
    await this.flush();
  }

  /* ============================== xử lý luồng ============================== */

  private addState(r: SymbolRowDb): SymbolState {
    const s: SymbolState = {
      info: toSymbolInfo(r),
      ticker: emptyTicker(r.symbol, r.last_price),
      bids: [],
      asks: [],
      bookTs: 0,
      consumed: { BUY: new Map(), SELL: new Map() },
      trades: [],
      vwap: [],
      bars: [],
      control: null,
      dev: 0,
      ref: null,
    };
    if (r.price_mode === 'MANUAL' && r.price_control) {
      const c = r.price_control;
      s.control = { since: c.since, from: c.from, to: c.to, startAt: c.startAt, endAt: c.endAt, volatilityPct: c.volatilityPct };
    }
    this.states.set(r.symbol, s);
    return s;
  }

  private seedBook(s: SymbolState) {
    const last = Number(s.ticker.last);
    if (!(last > 0)) return;
    const b = this.sim.book(s.info.filters, last);
    this.setBook(s, b.bids, b.asks);
  }

  private setBook(s: SymbolState, bids: BookLevel[], asks: BookLevel[]) {
    s.bids = bids;
    s.asks = asks;
    s.bookTs = Date.now();
    s.consumed.BUY.clear();
    s.consumed.SELL.clear();
    if (bids[0]) s.ticker.bid = bids[0][0];
    if (asks[0]) s.ticker.ask = asks[0][0];
    this.changedBook.add(s.info.symbol);
  }

  private onStatus(live: boolean) {
    this.live = live;
    if (!live) this.downSince = Date.now();
  }

  private onMiniTickers(list: MiniTicker[]) {
    for (const m of list) {
      const s = this.states.get(m.symbol);
      if (!s) continue;
      s.ref = str(m.close);
      if (s.control) continue;
      const open = new Big(m.open);
      const change = new Big(m.close).minus(open);
      s.ticker = {
        ...s.ticker,
        last: str(m.close),
        open: str(m.open),
        high: str(m.high),
        low: str(m.low),
        volume: str(m.volume),
        quoteVolume: str(m.quoteVolume),
        change: change.toFixed(),
        changePct: open.gt(0) ? Number(change.div(open).times(100).toFixed(2)) : 0,
        updatedAt: m.time,
      };
      this.changedTicker.add(m.symbol);
    }
  }

  private onDepth(symbol: string, bids: BookLevel[], asks: BookLevel[]) {
    const s = this.states.get(symbol);
    if (s && !s.control && !this.usingSim()) this.setBook(s, bids, asks);
  }

  private onTrade(t: TradeTick) {
    if (this.usingSim() || this.states.get(t.symbol)?.control) return;
    this.recordTrade(t, false);
  }

  private onKline(symbol: string, k: Kline) {
    const s = this.states.get(symbol);
    if (!s || s.control || this.usingSim()) return;
    const lastBar = s.bars[s.bars.length - 1];
    if (lastBar && lastBar.time === k.time) s.bars[s.bars.length - 1] = k;
    else {
      s.bars.push(k);
      if (s.bars.length > MAX_BARS) s.bars.shift();
    }
    this.changedKline.add(symbol);
  }

  /** Ghi nhận 1 giao dịch thị trường (thật hoặc giả lập) */
  private recordTrade(t: TradeTick, sim: boolean) {
    const s = this.states.get(t.symbol);
    if (!s) return;
    s.trades.push(t);
    if (s.trades.length > MAX_TRADES) s.trades.shift();
    const p = Number(t.price);
    const q = Number(t.qty);
    s.vwap.push({ t: t.time, pq: p * q, q });
    const cutoff = Date.now() - VWAP_MS;
    while (s.vwap.length && s.vwap[0]!.t < cutoff) s.vwap.shift();
    s.ticker.last = t.price;
    const list = this.pendingTrades.get(t.symbol);
    if (list) list.push(t);
    else this.pendingTrades.set(t.symbol, [t]);
    this.changedBook.add(t.symbol);
    if (sim) {
      this.updateBar(s, p, q, t.time);
      const tk = s.ticker;
      if (new Big(t.price).gt(tk.high)) tk.high = t.price;
      if (new Big(t.price).lt(tk.low) || tk.low === '0') tk.low = t.price;
      tk.volume = new Big(tk.volume).plus(t.qty).toFixed();
      tk.quoteVolume = new Big(tk.quoteVolume).plus(new Big(t.qty).times(t.price)).toFixed();
    }
  }

  private updateBar(s: SymbolState, price: number, qty: number, timeMs: number) {
    const t = Math.floor(timeMs / 60_000) * 60;
    const b = s.bars[s.bars.length - 1];
    if (b && b.time === t) {
      b.high = Math.max(b.high, price);
      b.low = Math.min(b.low, price);
      b.close = price;
      b.volume += qty;
    } else {
      s.bars.push({ time: t, open: b?.close ?? price, high: Math.max(price, b?.close ?? price), low: Math.min(price, b?.close ?? price), close: price, volume: qty });
      if (s.bars.length > MAX_BARS) s.bars.shift();
    }
    this.changedKline.add(s.info.symbol);
  }

  private usingSim(): boolean {
    if (this.opts.feed === 'sim') return true;
    if (this.live) return false;
    return Date.now() - this.downSince >= (this.opts.simAfterMs ?? 5_000);
  }

  private simStep(now: number) {
    const dt = Math.min(now - this.lastSimAt, 5_000);
    this.lastSimAt = now;
    for (const s of this.states.values()) {
      if (s.info.status !== 'TRADING' || s.control) continue;
      const last = s.ticker.last !== '0' ? s.ticker.last : null;
      if (!last) continue;
      this.applyStep(s, this.sim.step({ symbol: s.info.symbol, filters: s.info.filters, last }, dt, now), now);
    }
  }

  /** Giá điều chỉnh: bám đường giá kịch bản, cộng dao động ngẫu nhiên kéo dần về đường giá (không vượt biên dao động) */
  private manualStep(now: number) {
    const dt = Math.max(1, Math.min(now - this.lastManualAt, 5_000));
    this.lastManualAt = now;
    for (const s of this.states.values()) {
      const c = s.control;
      if (!c || s.info.status !== 'TRADING') continue;
      const vol = c.volatilityPct / 100;
      if (vol > 0) {
        const theta = Math.min(1, dt / 20_000);
        s.dev += -s.dev * theta + (vol / 2) * Math.sqrt(2 * theta) * gaussian(this.rand);
        s.dev = Math.max(-vol, Math.min(vol, s.dev));
      } else s.dev = 0;
      this.sim.forced.set(s.info.symbol, String(priceOnPath(c, now) * (1 + s.dev)));
      this.applyStep(s, this.sim.step({ symbol: s.info.symbol, filters: s.info.filters, last: s.ticker.last }, dt, now), now);
    }
  }

  /** Áp 1 bước giá tự sinh (giả lập hoặc điều chỉnh): sổ lệnh, giao dịch, nến, thống kê 24h */
  private applyStep(s: SymbolState, r: SimStep, now: number) {
    this.setBook(s, r.bids, r.asks);
    s.ticker.last = r.last;
    for (const t of r.trades) this.recordTrade(t, true);
    if (!r.trades.length) this.updateBar(s, Number(r.last), 0, now);
    const open = new Big(s.ticker.open);
    if (open.gt(0)) {
      const change = new Big(s.ticker.last).minus(open);
      s.ticker.change = change.toFixed();
      s.ticker.changePct = Number(change.div(open).times(100).toFixed(2));
    }
    if (new Big(r.last).gt(s.ticker.high)) s.ticker.high = r.last;
    if (new Big(r.last).lt(s.ticker.low)) s.ticker.low = r.last;
    s.ticker.updatedAt = now;
    this.changedTicker.add(s.info.symbol);
  }

  private async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const now = Date.now();
      const sim = this.usingSim();
      const feed: FeedKind = sim ? 'SIM' : 'LIVE';
      if (feed !== this.lastFeed) {
        if (this.lastFeed) log.warn(`[market] nguồn dữ liệu chuyển sang ${feed === 'LIVE' ? 'Binance (thật)' : 'giả lập'}`);
        this.lastFeed = feed;
        this.lastSimAt = now;
        this.emit('feed', this.status());
      }
      if (sim) this.simStep(now);
      this.manualStep(now);

      const trades = this.pendingTrades;
      const changed = this.changedBook;
      this.pendingTrades = new Map();
      this.changedBook = new Set();
      if (changed.size || trades.size) {
        try {
          await this.hooks.onTick?.(changed, trades);
        } catch (err) {
          log.error('[market] lỗi xử lý khớp lệnh trong chu kỳ', { err });
        }
      }
      for (const sym of changed) {
        const d = this.depth(sym);
        if (d) this.emit('depth', d);
      }
      if (trades.size) this.emit('trades', [...trades.values()].flat());
      if (this.changedKline.size) {
        const items = [...this.changedKline].flatMap((sym) => {
          const b = this.states.get(sym)?.bars.at(-1);
          return b ? [{ symbol: sym, kline: b }] : [];
        });
        this.changedKline.clear();
        this.emit('klines', items);
      }
      if (this.changedTicker.size && now - this.lastTickerEmit >= 1_000) {
        const list = [...this.changedTicker].flatMap((sym) => {
          const s = this.states.get(sym);
          return s ? [s.ticker] : [];
        });
        this.changedTicker.clear();
        this.lastTickerEmit = now;
        this.emit('tickers', list);
      }
    } finally {
      this.flushing = false;
    }
  }
}
