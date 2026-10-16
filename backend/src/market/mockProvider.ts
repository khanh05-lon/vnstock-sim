import { RULES, roundToTick, stepPrice, tickSize, type BookLevel } from '@vss/shared';
import { vnParts } from '../lib/calendar';
import { gaussian } from '../lib/prng';
import { warrantFair } from './instruments';
import type { MarketDataProvider, ProviderPoll, ProviderTrade, StockState } from './types';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Bộ sinh dữ liệu giả lập:
 * - Mỗi mã có "giá hợp lý" (fair) dao động quanh mục tiêu trong ngày (target) theo quá trình Ornstein–Uhlenbeck.
 * - Sổ lệnh 3 bước giá xoay quanh giá mua tốt nhất (bp), tôn trọng trần/sàn và bước giá.
 * - Giao dịch xảy ra ngẫu nhiên theo thanh khoản; hướng mua/bán chủ động phụ thuộc chênh lệch fair - mid.
 */
export class MockProvider implements MarketDataProvider {
  readonly name = 'mock';
  /** Mọi mã đã thấy — để chứng quyền tra giá cổ phiếu cơ sở */
  private known = new Map<string, StockState>();

  constructor(private rand: () => number = Math.random) {}

  private remember(states: StockState[]) {
    for (const s of states) this.known.set(s.info.symbol, s);
  }

  /** Giá hợp lý của chứng quyền theo giá hợp lý hiện tại của cổ phiếu cơ sở */
  private warrantValue(s: StockState, nowMs = Date.now()): number | null {
    const w = s.info.warrant;
    const u = w ? this.known.get(w.underlying) : undefined;
    if (!w || !u) return null;
    const base = u.sim.fair || (u.volume > 0 ? u.last : u.ref);
    return clamp(warrantFair(base, w, vnParts(nowMs).date, u.volatility), s.floor, s.ceil);
  }

  onNewDay(states: StockState[]): void {
    this.remember(states);
    for (const s of states) {
      const ex = s.info;
      const lim = (s.info.type === 'BOND' ? RULES.bondLimitPct : RULES.priceLimitPct[s.info.exchange]) / 100;
      let bias = gaussian(this.rand) * s.volatility * 0.8;
      const r = this.rand();
      if (r < 0.02) bias = lim;
      else if (r < 0.035) bias = -lim;
      s.sim.target = clamp(s.ref * (1 + bias), s.floor, s.ceil);
      s.sim.fair = s.ref;
      const cw = this.warrantValue(s);
      if (cw) s.sim.target = cw;
      s.sim.bp = stepPrice(ex, s.ref, -1);
      s.bids = [];
      s.asks = [];
      this.rebuildBook(s);
    }
  }

  resume(states: StockState[]): void {
    this.remember(states);
    for (const s of states) {
      const ex = s.info;
      const base = s.volume > 0 ? s.last : s.ref;
      const drift = gaussian(this.rand) * s.volatility * 0.5;
      s.sim.target = clamp(base * (1 + drift), s.floor, s.ceil);
      s.sim.fair = base;
      s.sim.bp = base >= s.ceil ? s.ceil : stepPrice(ex, base, -1);
      s.bids = [];
      s.asks = [];
      this.rebuildBook(s);
    }
  }

  auctionPrice(s: StockState): number {
    return clamp(roundToTick(s.info, s.sim.fair), s.floor, s.ceil);
  }

  poll(states: StockState[], nowMs: number, dtMs: number): ProviderPoll {
    const sec = dtMs / 1000;
    const trades: ProviderTrade[] = [];
    const touched: string[] = [];
    for (const s of states) {
      this.evolve(s, sec, nowMs);
      const pTrade = 1 - Math.exp(-s.liq * 0.7 * sec);
      if (this.rand() < pTrade) {
        const t = this.trade(s);
        if (t) {
          trades.push(t);
          touched.push(s.info.symbol);
          continue;
        }
      }
      if (this.rand() < 1 - Math.exp(-0.35 * sec)) {
        this.jitter(s);
        touched.push(s.info.symbol);
      }
    }
    return { trades, touched };
  }

  rebuildBook(s: StockState): void {
    const ex = s.info;
    const oldBid = new Map(s.bids.map((l) => [l.p, l.v]));
    const oldAsk = new Map(s.asks.map((l) => [l.p, l.v]));
    const bids: BookLevel[] = [];
    let p = s.sim.bp;
    for (let i = 0; i < 3 && p >= s.floor && p > 0; i++) {
      const big = p === s.ceil ? 4 + this.rand() * 6 : 1;
      bids.push({ p, v: oldBid.get(p) ?? this.levelVol(s, big) });
      p = stepPrice(ex, p, -1);
    }
    const asks: BookLevel[] = [];
    let q = s.sim.bp + tickSize(ex, s.sim.bp);
    for (let i = 0; i < 3 && q <= s.ceil; i++) {
      const big = q === s.floor ? 4 + this.rand() * 6 : 1;
      asks.push({ p: q, v: oldAsk.get(q) ?? this.levelVol(s, big) });
      q = q + tickSize(ex, q);
    }
    s.bids = bids;
    s.asks = asks;
  }

  /* -------------------- nội bộ -------------------- */

  private evolve(s: StockState, sec: number, nowMs: number) {
    // Chứng quyền: giá hợp lý bám theo cổ phiếu cơ sở (Black–Scholes), cộng chút nhiễu cung cầu
    const cw = this.warrantValue(s, nowMs);
    if (cw != null) {
      s.sim.target = cw;
      s.sim.fair = clamp(cw * (1 + gaussian(this.rand) * 0.004), s.floor * 0.97, s.ceil * 1.03);
      return;
    }
    const v = s.volatility;
    // mục tiêu trong ngày trôi chậm
    s.sim.target = clamp(s.sim.target * (1 + gaussian(this.rand) * v * 0.25 * Math.sqrt(sec / 3600)), s.floor, s.ceil);
    // giá hợp lý hồi quy về mục tiêu + nhiễu
    const theta = 1 / 1500;
    const noise = s.sim.fair * v * Math.sqrt(sec / 16_200) * gaussian(this.rand);
    s.sim.fair = clamp(s.sim.fair + theta * sec * (s.sim.target - s.sim.fair) + noise, s.floor * 0.97, s.ceil * 1.03);
  }

  private lots(s: StockState): number {
    const base = 3 + s.liq * 25;
    return Math.max(1, Math.round(Math.exp(gaussian(this.rand) * 0.9) * base));
  }

  private levelVol(s: StockState, mult = 1): number {
    const base = 30 + s.liq * 1500;
    const lots = Math.max(1, Math.round(Math.exp(gaussian(this.rand) * 0.7) * base * mult));
    return lots * 100;
  }

  private trade(s: StockState): ProviderTrade | null {
    const ex = s.info;
    const ask1 = s.asks[0]?.p ?? 0;
    const bid1 = s.bids[0]?.p ?? 0;
    if (!ask1 && !bid1) return null;
    let side: 'B' | 'S';
    if (!ask1) side = 'S';
    else if (!bid1) side = 'B';
    else {
      const mid = (ask1 + bid1) / 2;
      const t = tickSize(ex, mid);
      const pBuy = 1 / (1 + Math.exp((-(s.sim.fair - mid) / t) * 1.2));
      side = this.rand() < pBuy ? 'B' : 'S';
    }
    const price = side === 'B' ? ask1 : bid1;
    const vol = this.lots(s) * 100;

    if (side === 'B') {
      if (s.sim.fair > ask1 && this.rand() < 0.55) {
        s.sim.bp = ask1; // giá đi lên 1 bước
      } else if (s.asks[0]) {
        s.asks[0] = { p: ask1, v: Math.max(100, s.asks[0].v - vol) };
      }
    } else if (s.sim.fair < bid1 && this.rand() < 0.55) {
      s.sim.bp = stepPrice(ex, bid1, -1); // giá đi xuống 1 bước
    } else if (s.bids[0]) {
      s.bids[0] = { p: bid1, v: Math.max(100, s.bids[0].v - vol) };
    }
    this.rebuildBook(s);
    return { symbol: s.info.symbol, price, vol, side, foreign: this.rand() < 0.18 };
  }

  private jitter(s: StockState) {
    const side = this.rand() < 0.5 ? s.bids : s.asks;
    if (!side.length) return;
    const i = Math.floor(this.rand() * side.length);
    const delta = (this.rand() < 0.55 ? 1 : -1) * this.lots(s) * 100;
    side[i] = { p: side[i].p, v: Math.max(100, side[i].v + delta) };
  }
}
