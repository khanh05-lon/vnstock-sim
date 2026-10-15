import { priceBand, type BookLevel, type MarketMode } from '@vss/shared';
import { currentTradeDate, phaseAt, SESSION, vnParts } from '../../lib/calendar';
import { MockProvider } from '../mockProvider';
import type { MarketDataProvider, ProviderPoll, ProviderTrade, StockState } from '../types';
import type { BoardItem, IndexQuote, VnstockSource } from './client';

export const INDEX_CODES = ['VNINDEX', 'VN30', 'HNXINDEX', 'UPCOMINDEX'];

/** Theo dõi từng mã giữa các lần lấy dữ liệu */
export interface Track {
  /** KL / GT luỹ kế theo nguồn đã ghi nhận (không gồm giao dịch của người dùng) */
  vol: number;
  value: number;
  last: number;
  /** giá mua/bán tốt nhất ở lần lấy trước — để đoán chiều chủ động */
  bid1: number;
  ask1: number;
  side: 'B' | 'S';
  /** KL lệnh người dùng đã "ăn" ở từng mức giá (`B:58000` = bên mua), trừ dần khỏi sổ lệnh của nguồn */
  consumed: Map<string, number>;
  /** sổ lệnh đã công bố gần nhất */
  shown: { bids: BookLevel[]; asks: BookLevel[] };
}

export interface ApplyResult {
  track: Track | undefined;
  trade: ProviderTrade | null;
  changed: boolean;
}

const vnDate = (ms: number) => vnParts(ms).date;
const cloneLevels = (l: BookLevel[]) => l.map((x) => ({ ...x }));
const sameLevels = (a: BookLevel[], b: BookLevel[]) => a.length === b.length && a.every((x, i) => x.p === b[i].p && x.v === b[i].v);

export function inferSide(price: number, prev: Pick<Track, 'bid1' | 'ask1' | 'last' | 'side'>): 'B' | 'S' {
  if (prev.ask1 && price >= prev.ask1) return 'B';
  if (prev.bid1 && price <= prev.bid1) return 'S';
  if (prev.last && price > prev.last) return 'B';
  if (prev.last && price < prev.last) return 'S';
  return prev.side;
}

/** Sổ lệnh của nguồn trừ đi phần lệnh người dùng đã ăn; mức giá không còn trên sổ thì quên phần đã ăn */
export function netOfConsumed(levels: BookLevel[], consumed: Map<string, number>, side: 'B' | 'S'): BookLevel[] {
  const out: BookLevel[] = [];
  const seen = new Set<string>();
  for (const l of levels) {
    const key = `${side}:${l.p}`;
    seen.add(key);
    const v = l.v - (consumed.get(key) ?? 0);
    if (v > 0) out.push({ p: l.p, v });
  }
  for (const key of [...consumed.keys()]) if (key.startsWith(`${side}:`) && !seen.has(key)) consumed.delete(key);
  return out;
}

/** Ghi nhận phần sổ lệnh vừa bị lệnh người dùng ăn (so với sổ đã công bố) */
export function recordConsumption(s: StockState, t: Track): void {
  const sides: [string, BookLevel[], BookLevel[]][] = [
    ['B', t.shown.bids, s.bids],
    ['S', t.shown.asks, s.asks],
  ];
  for (const [side, shown, now] of sides) {
    for (const l of shown) {
      const cur = now.find((x) => x.p === l.p)?.v ?? 0;
      if (cur < l.v) {
        const key = `${side}:${l.p}`;
        t.consumed.set(key, (t.consumed.get(key) ?? 0) + l.v - cur);
      }
    }
  }
  t.shown = { bids: cloneLevels(s.bids), asks: cloneLevels(s.asks) };
}

/**
 * Áp 1 dòng bảng giá thật vào trạng thái của mã.
 * - Lần đầu trong ngày (chưa có track) hoặc KL nguồn giảm: đồng bộ thẳng, không phát giao dịch.
 * - Các lần sau: KL luỹ kế tăng Δ → 1 giao dịch Δ tại giá khớp cuối; MarketService.applyTrade sẽ cộng KL/GT,
 *   nên ở đây chỉ bù phần chênh GT để tổng khớp với nguồn.
 * - Dữ liệu của phiên khác ngày giao dịch hiện tại bị bỏ qua.
 */
export function applyBoardItem(s: StockState, item: BoardItem, prev: Track | undefined, tradeDate: string, nowMs: number): ApplyResult {
  if (item.tradingDate && item.tradingDate !== tradeDate) return { track: prev, trade: null, changed: false };
  let changed = false;

  if (item.ref > 0) {
    const band = item.ceil > 0 && item.floor > 0 ? { ceil: item.ceil, floor: item.floor } : priceBand(s.info.exchange, item.ref);
    if (s.ref !== item.ref || s.ceil !== band.ceil || s.floor !== band.floor) {
      s.ref = item.ref;
      s.ceil = band.ceil;
      s.floor = band.floor;
      changed = true;
    }
  }

  const matched = item.matchTime != null && vnDate(item.matchTime) === tradeDate && item.volume > 0;
  const vol = matched ? item.volume : 0;
  const value = matched ? item.value : 0;
  const lastPx = matched && item.last > 0 ? item.last : 0;

  let track: Track;
  let trade: ProviderTrade | null = null;
  if (!prev || vol < prev.vol) {
    s.open = matched ? item.open : 0;
    s.high = matched ? item.high : 0;
    s.low = matched ? item.low : 0;
    s.last = lastPx || s.ref;
    s.lastVol = matched ? item.lastVol : 0;
    s.volume = vol;
    s.value = value;
    track = { vol, value, last: lastPx, bid1: 0, ask1: 0, side: 'B', consumed: new Map(), shown: { bids: [], asks: [] } };
    changed = true;
  } else {
    track = prev;
    const dv = vol - prev.vol;
    if (dv > 0) {
      const price = lastPx || s.last;
      const side = inferSide(price, prev);
      s.value += value - prev.value - price * dv;
      if (!s.open && item.open > 0) s.open = item.open;
      if (item.high > 0) s.high = Math.max(s.high, item.high);
      if (item.low > 0) s.low = s.low ? Math.min(s.low, item.low) : item.low;
      trade = { symbol: s.info.symbol, price, vol: dv, side, foreign: false };
      Object.assign(track, { vol, value, last: price, side });
    } else if (lastPx && lastPx !== prev.last) {
      s.last = lastPx;
      track.last = lastPx;
      changed = true;
    }
  }

  const fb = matched ? item.foreignBuy : 0;
  const fs = matched ? item.foreignSell : 0;
  if (s.foreignBuy !== fb || s.foreignSell !== fs) {
    s.foreignBuy = fb;
    s.foreignSell = fs;
    changed = true;
  }

  const bookFresh = item.bookTime != null && vnDate(item.bookTime) === tradeDate;
  const srcBids = bookFresh ? item.bids : [];
  const srcAsks = bookFresh ? item.asks : [];
  track.bid1 = srcBids[0]?.p ?? 0;
  track.ask1 = srcAsks[0]?.p ?? 0;
  const bids = netOfConsumed(srcBids, track.consumed, 'B');
  const asks = netOfConsumed(srcAsks, track.consumed, 'S');
  if (!sameLevels(s.bids, bids) || !sameLevels(s.asks, asks)) {
    s.bids = bids;
    s.asks = asks;
    changed = true;
  }
  track.shown = { bids: cloneLevels(bids), asks: cloneLevels(asks) };
  if (changed) s.updatedAt = nowMs;
  return { track, trade, changed };
}

export interface RealProviderOptions {
  mode: MarketMode;
  /** chu kỳ lấy bảng giá trong giờ giao dịch */
  pollMs: number;
  /** quá thời gian này không lấy được dữ liệu → chuyển giả lập */
  staleMs: number;
  /** chu kỳ lấy dữ liệu ngoài giờ giao dịch (mặc định 60s) */
  idleMs?: number;
  /** chu kỳ lấy giá trị chỉ số (mặc định 10s) */
  indexMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * Dữ liệu thị trường thật (bảng giá + chỉ số) lấy định kỳ từ data-service.
 * Khi nguồn lỗi/quá cũ — hoặc ngoài giờ giao dịch ở chế độ SIMULATED_24_7 — tự chuyển sang MockProvider,
 * tiếp tục mô phỏng từ giá hiện tại; khi nguồn có lại thì đồng bộ về dữ liệu thật.
 */
export class RealProvider implements MarketDataProvider {
  readonly name = 'vnstock';
  private items = new Map<string, BoardItem>();
  private indexQuotes = new Map<string, IndexQuote>();
  private tracks = new Map<string, Track>();
  private seq = 0;
  private appliedSeq = -1;
  private lastOkAt = 0;
  private lastIndexAt = 0;
  private failures = 0;
  private active: 'real' | 'mock' | null = null;
  private symbols: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private clock: () => number;
  private log: (msg: string) => void;
  private idleMs: number;
  private indexMs: number;

  constructor(
    private source: VnstockSource,
    private opts: RealProviderOptions,
    private mock: MarketDataProvider = new MockProvider(),
  ) {
    this.clock = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(m));
    this.idleMs = opts.idleMs ?? 60_000;
    this.indexMs = opts.indexMs ?? 10_000;
  }

  get live(): boolean {
    return this.desired() === 'real';
  }

  status() {
    return { live: this.live, lastOkAt: this.lastOkAt || null, failures: this.failures, symbols: this.items.size };
  }

  async start(states: StockState[]): Promise<void> {
    this.symbols = states.map((s) => s.info.symbol);
    this.stopped = false;
    try {
      await this.refresh();
      this.log(`[vnstock] đã kết nối data-service: ${this.items.size}/${this.symbols.length} mã`);
    } catch (err) {
      this.failures = 1;
      this.log(`[vnstock] chưa lấy được dữ liệu thật (${errMsg(err)}) — tạm dùng giả lập, sẽ thử lại`);
    }
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Nạp dữ liệu mới vào bộ đệm (vòng lấy dữ liệu và test dùng chung) */
  ingest(items: BoardItem[], indices?: IndexQuote[]): void {
    for (const it of items) this.items.set(it.symbol, it);
    for (const q of indices ?? []) this.indexQuotes.set(q.code, q);
    this.seq++;
    this.lastOkAt = this.clock();
  }

  onNewDay(states: StockState[]): void {
    this.reset(states, 'day');
  }

  resume(states: StockState[]): void {
    this.reset(states, 'resume');
  }

  poll(states: StockState[], nowMs: number, dtMs: number): ProviderPoll {
    const want = this.desired();
    if (want !== this.active) this.switchTo(want, states);
    if (want === 'mock') return this.mock.poll(states, nowMs, dtMs);
    if (this.appliedSeq === this.seq) return { trades: [], touched: [] };
    this.appliedSeq = this.seq;

    const tradeDate = currentTradeDate(nowMs, this.opts.mode);
    const trades: ProviderTrade[] = [];
    const touched: string[] = [];
    for (const s of states) {
      const sym = s.info.symbol;
      const item = this.items.get(sym);
      if (!item) continue;
      const r = applyBoardItem(s, item, this.tracks.get(sym), tradeDate, nowMs);
      if (r.track) this.tracks.set(sym, r.track);
      if (r.trade) trades.push(r.trade);
      if (r.changed) touched.push(sym);
    }
    return { trades, touched };
  }

  /** Giá khớp ATO/ATC thật của phiên hôm nay; 0 nếu nguồn chưa có (MarketService sẽ hỏi lại ở các tick sau) */
  auctionPrice(s: StockState, kind?: 'ATO' | 'ATC'): number {
    if (!this.live) return this.active === 'mock' ? this.mock.auctionPrice(s, kind) : s.volume > 0 ? s.last : s.ref;
    const item = this.items.get(s.info.symbol);
    if (!item || item.matchTime == null) return 0;
    if (vnDate(item.matchTime) !== currentTradeDate(this.clock(), this.opts.mode)) return 0;
    if (kind === 'ATC') return item.atcVol > 0 ? item.atcPrice : 0;
    return item.atoVol > 0 ? item.atoPrice : 0;
  }

  rebuildBook(s: StockState): void {
    if (this.active !== 'real') return this.mock.rebuildBook(s);
    // Giữ nguyên sổ lệnh đã bị ăn, nhớ phần đã ăn để trừ khỏi các bản cập nhật sau của nguồn
    const t = this.tracks.get(s.info.symbol);
    if (t) recordConsumption(s, t);
  }

  indexValue(code: string, tradeDate?: string): number | null {
    if (!this.live) return null;
    const q = this.indexQuotes.get(code);
    const date = tradeDate ?? currentTradeDate(this.clock(), this.opts.mode);
    return q && q.date === date ? q.value : null;
  }

  /* -------------------- nội bộ -------------------- */

  private desired(now = this.clock()): 'real' | 'mock' {
    if (!this.lastOkAt) return 'mock';
    const maxAge = Math.max(this.opts.staleMs, this.intervalAt(now) * 3);
    if (now - this.lastOkAt > maxAge) return 'mock';
    if (this.opts.mode === 'SIMULATED_24_7') {
      const ph = phaseAt(now, 'REAL_HOURS');
      if (ph !== 'ATO' && ph !== 'CONTINUOUS' && ph !== 'ATC') return 'mock';
    }
    return 'real';
  }

  private reset(states: StockState[], kind: 'day' | 'resume') {
    this.tracks.clear();
    this.appliedSeq = -1;
    if (this.live) {
      for (const s of states) {
        s.bids = [];
        s.asks = [];
      }
      this.active = 'real';
    } else {
      if (kind === 'day') this.mock.onNewDay(states);
      else this.mock.resume(states);
      this.active = 'mock';
    }
  }

  private switchTo(mode: 'real' | 'mock', states: StockState[]) {
    const first = this.active == null;
    if (mode === 'mock') {
      this.mock.resume(states);
      if (!first) this.log('[vnstock] mất dữ liệu thật hoặc ngoài giờ giao dịch → chạy giả lập từ giá hiện tại');
    } else {
      this.tracks.clear();
      this.appliedSeq = -1;
      for (const s of states) {
        s.bids = [];
        s.asks = [];
      }
      if (!first) this.log('[vnstock] có dữ liệu thật → đồng bộ bảng giá theo nguồn');
    }
    this.active = mode;
  }

  /** Trong khung 8:30–15:05 ngày thường lấy dữ liệu dày, ngoài giờ thưa hơn */
  private intervalAt(now: number): number {
    const { minutes, weekday } = vnParts(now);
    const busy = weekday >= 1 && weekday <= 5 && minutes >= SESSION.preOpen && minutes < SESSION.close + 5;
    return busy ? this.opts.pollMs : this.idleMs;
  }

  private schedule() {
    if (this.stopped) return;
    const base = this.intervalAt(this.clock());
    const delay = this.failures ? Math.min(60_000, Math.max(base, this.opts.pollMs * 2 ** Math.min(this.failures, 5))) : base;
    this.timer = setTimeout(() => void this.loop(), delay);
    this.timer.unref?.();
  }

  private async loop() {
    try {
      await this.refresh();
      if (this.failures) this.log('[vnstock] đã kết nối lại data-service');
      this.failures = 0;
    } catch (err) {
      if (this.failures++ === 0) this.log(`[vnstock] lỗi lấy dữ liệu: ${errMsg(err)}`);
    } finally {
      this.schedule();
    }
  }

  private async refresh() {
    const snap = await this.source.board(this.symbols);
    if (!snap.items.length) throw new Error('data-service trả về bảng giá rỗng');
    let quotes: IndexQuote[] | undefined;
    const now = this.clock();
    if (now - this.lastIndexAt >= this.indexMs) {
      quotes = await this.source.indices(INDEX_CODES).catch(() => undefined);
      if (quotes) this.lastIndexAt = now;
    }
    this.ingest(snap.items, quotes);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
