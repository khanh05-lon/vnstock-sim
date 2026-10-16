import { priceBand, type BookLevel, type Exchange, type MarketMode, type SessionPhase, type StockInfo } from '@vss/shared';
import type { MarketAccess } from '../../src/trading/engine';

export interface FakeQuote {
  info: StockInfo;
  ref: number;
  ceil: number;
  floor: number;
  last: number;
  volume: number;
  bids: BookLevel[];
  asks: BookLevel[];
}

/** Thị trường giả cho test bộ khớp lệnh: sổ lệnh cố định, đặt giá khớp gần nhất bằng tay */
export class FakeMarket implements MarketAccess {
  opts: { mode: MarketMode } = { mode: 'SIMULATED_24_7' };
  tradeDate = '2026-10-15';
  phase: SessionPhase = 'CONTINUOUS';
  stocks = new Map<string, FakeQuote>();
  recorded: { symbol: string; price: number; qty: number }[] = [];

  add(symbol: string, exchange: Exchange, ref: number, bids: BookLevel[], asks: BookLevel[], extra: Partial<StockInfo> = {}) {
    const info: StockInfo = { symbol, exchange, type: 'STOCK', name: symbol, industry: 'Test', listedShares: 1e9, eps: 1000, bvps: 10000, isVn30: false, marginRatio: 0, ...extra };
    this.stocks.set(symbol, { info, ref, ...priceBand(info, ref), last: ref, volume: 0, bids, asks });
  }
  /** Đổi giá tham chiếu (sang phiên mới) */
  setRef(symbol: string, ref: number) {
    const q = this.stocks.get(symbol)!;
    Object.assign(q, { ref, ...priceBand(q.info, ref), last: ref, volume: 0 });
  }
  /** Ghi nhận 1 giao dịch thị trường ở giá p */
  trade(symbol: string, p: number, vol = 1_000) {
    const q = this.stocks.get(symbol)!;
    q.last = p;
    q.volume += vol;
  }
  info(s: string) {
    return this.stocks.get(s)?.info;
  }
  quote(s: string) {
    return this.stocks.get(s);
  }
  markPrice(s: string) {
    const q = this.stocks.get(s);
    return q ? (q.volume > 0 ? q.last : q.ref) : 0;
  }
  consumeBook(symbol: string, side: 'BUY' | 'SELL', qty: number, limit: number | null) {
    const q = this.stocks.get(symbol)!;
    const book = side === 'BUY' ? q.asks : q.bids;
    const fills: { price: number; qty: number }[] = [];
    let left = qty;
    for (const l of book) {
      if (left <= 0) break;
      if (limit != null && (side === 'BUY' ? l.p > limit : l.p < limit)) break;
      const take = Math.min(left, l.v);
      fills.push({ price: l.p, qty: take });
      l.v -= take;
      left -= take;
    }
    if (side === 'BUY') q.asks = q.asks.filter((l) => l.v > 0);
    else q.bids = q.bids.filter((l) => l.v > 0);
    return fills;
  }
  recordTrade(symbol: string, price: number, qty: number) {
    this.recorded.push({ symbol, price, qty });
  }
}
