import { Big, floorStep, type BookLevel, type Dec, type Side, type SymbolFilters, type SymbolInfo } from '@vss/shared';
import type { BookFill } from '../../src/market/marketService';
import type { MarketAccess } from '../../src/trading/engine';

export const TEST_FILTERS: SymbolFilters = {
  tickSize: '0.01',
  minPrice: '0.01',
  maxPrice: '1000000',
  stepSize: '0.0001',
  minQty: '0.0001',
  maxQty: '9000',
  marketMaxQty: '0',
  minNotional: '5',
  maxNotional: '9000000',
  applyMinToMarket: true,
  applyMaxToMarket: false,
  bidMultiplierUp: '5',
  bidMultiplierDown: '0.2',
  askMultiplierUp: '5',
  askMultiplierDown: '0.2',
  maxNumOrders: 200,
  maxNumAlgoOrders: 5,
};

interface FakeSymbol {
  info: SymbolInfo;
  bids: BookLevel[];
  asks: BookLevel[];
  last: Dec;
  changePct: number;
}

/** Thị trường giả cho test engine: sổ lệnh đặt bằng tay, ăn sổ lệnh thật (khối lượng bị trừ) */
export class FakeMarket implements MarketAccess {
  readonly symbols = new Map<string, FakeSymbol>();

  add(symbol: string, base: string, last: Dec, bids: BookLevel[] = [], asks: BookLevel[] = [], filters: Partial<SymbolFilters> = {}) {
    const info: SymbolInfo = { symbol, baseAsset: base, quoteAsset: 'USDT', name: base, status: 'TRADING', sortOrder: 0, filters: { ...TEST_FILTERS, ...filters } };
    this.symbols.set(symbol, { info, bids, asks, last, changePct: 0 });
  }

  setBook(symbol: string, bids: BookLevel[], asks: BookLevel[]) {
    const s = this.symbols.get(symbol)!;
    s.bids = bids;
    s.asks = asks;
  }

  /** Giá khớp gần nhất (và % thay đổi 24h cho cảnh báo giá) */
  trade(symbol: string, price: Dec, changePct = 0) {
    const s = this.symbols.get(symbol)!;
    s.last = price;
    s.changePct = changePct;
  }

  info(symbol: string) {
    return this.symbols.get(symbol)?.info;
  }

  lastPrice(symbol: string) {
    return this.symbols.get(symbol)?.last ?? null;
  }

  avgPrice(symbol: string) {
    return this.lastPrice(symbol);
  }

  best(symbol: string, takerSide: Side) {
    const s = this.symbols.get(symbol);
    return (takerSide === 'BUY' ? s?.asks[0]?.[0] : s?.bids[0]?.[0]) ?? null;
  }

  priceUsdt(asset: string) {
    if (asset === 'USDT') return '1';
    return this.lastPrice(`${asset}USDT`);
  }

  quoteOf(symbol: string) {
    const s = this.symbols.get(symbol);
    return s ? { last: s.last, changePct: s.changePct } : null;
  }

  consumeBook(symbol: string, takerSide: Side, want: { qty?: Dec; quote?: Dec }, limit: Dec | null, dryRun = false): BookFill[] {
    const s = this.symbols.get(symbol)!;
    const levels = takerSide === 'BUY' ? s.asks : s.bids;
    let leftQty = want.qty ? new Big(want.qty) : null;
    let leftQuote = want.quote ? new Big(want.quote) : null;
    const fills: BookFill[] = [];
    for (const lvl of levels) {
      const [p, q] = lvl;
      if (limit && (takerSide === 'BUY' ? new Big(p).gt(limit) : new Big(p).lt(limit))) break;
      let take = new Big(q);
      if (leftQty && leftQty.lt(take)) take = leftQty;
      if (leftQuote) {
        const byQuote = new Big(floorStep(leftQuote.div(p), s.info.filters.stepSize));
        if (byQuote.lt(take)) take = byQuote;
      }
      if (take.lte(0)) break;
      fills.push({ price: p, qty: take.toFixed() });
      if (!dryRun) lvl[1] = new Big(q).minus(take).toFixed();
      if (leftQty) {
        leftQty = leftQty.minus(take);
        if (leftQty.lte(0)) break;
      }
      if (leftQuote) {
        leftQuote = leftQuote.minus(take.times(p));
        if (leftQuote.lte(0)) break;
      }
    }
    if (!dryRun) {
      if (takerSide === 'BUY') s.asks = s.asks.filter((l) => new Big(l[1]).gt(0));
      else s.bids = s.bids.filter((l) => new Big(l[1]).gt(0));
    }
    return fills;
  }
}
