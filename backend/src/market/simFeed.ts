import { Big, ceilStep, floorStep, str, type BookLevel, type SymbolFilters, type TradeTick } from '@vss/shared';
import { gaussian, hashString, mulberry32 } from '../lib/prng';

/*
 * Bộ giả lập giá dự phòng: chạy khi mất kết nối Binance hoặc khi MARKET_FEED=sim (offline / test).
 * Giá đi theo random walk log-normal xuất phát từ giá thật cuối cùng; sổ lệnh 20 mức mỗi bên
 * luôn đúng tickSize / stepSize của cặp nên lệnh người dùng vẫn được kiểm tra và khớp như thật.
 */

export interface SimSymbol {
  symbol: string;
  filters: SymbolFilters;
  last: string;
}

export interface SimStep {
  trades: TradeTick[];
  bids: BookLevel[];
  asks: BookLevel[];
  last: string;
}

const LEVELS = 20;

export class SimFeed {
  private rand: () => number;
  private tradeId = 1;
  /** Ép giá (test / quản trị): cặp → giá mục tiêu, bước kế tiếp nhảy thẳng tới giá này */
  readonly forced = new Map<string, string>();

  constructor(seed = Date.now()) {
    this.rand = mulberry32(seed);
  }

  /** Độ biến động mỗi giây: BTC thấp nhất, altcoin cao hơn (ổn định theo tên cặp) */
  private sigma(symbol: string): number {
    if (symbol.startsWith('BTC')) return 0.00011;
    if (symbol.startsWith('ETH')) return 0.00015;
    return 0.00018 + (hashString(symbol) % 100) / 1e6 * 1.5;
  }

  /** Tiến 1 bước dtMs cho 1 cặp */
  step(s: SimSymbol, dtMs: number, now = Date.now()): SimStep {
    const f = s.filters;
    const prev = Number(s.last) || Number(f.tickSize) * 1000;
    let target: number;
    const forced = this.forced.get(s.symbol);
    if (forced) {
      this.forced.delete(s.symbol);
      target = Number(forced);
    } else {
      const dt = Math.max(dtMs, 1) / 1000;
      target = prev * Math.exp(this.sigma(s.symbol) * Math.sqrt(dt) * gaussian(this.rand));
    }
    const last = this.roundPrice(f, target);

    // Số giao dịch ~ Poisson(3/giây)
    const trades: TradeTick[] = [];
    const n = Math.min(12, this.poisson((3 * dtMs) / 1000));
    const lastNum = Number(last);
    for (let i = 0; i < n; i++) {
      const notional = Math.exp(Math.log(250) + gaussian(this.rand) * 1.1);
      const qty = this.roundQty(f, notional / lastNum);
      if (qty === '0') continue;
      trades.push({ id: this.tradeId++, symbol: s.symbol, price: last, qty, time: now, buyerMaker: this.rand() < 0.5 });
    }
    return { trades, ...this.book(f, lastNum), last };
  }

  /** Sổ lệnh quanh giá: chênh lệch mua bán ~0,005%, mỗi mức cách nhau ~0,01% */
  book(f: SymbolFilters, price: number): { bids: BookLevel[]; asks: BookLevel[] } {
    const tick = Number(f.tickSize) || price * 1e-6;
    const half = Math.max(tick, price * 0.000025);
    const gap = Math.max(tick, price * 0.0001);
    const bids: BookLevel[] = [];
    const asks: BookLevel[] = [];
    let lastBid = '';
    let lastAsk = '';
    for (let i = 0; i < LEVELS; i++) {
      const bp = floorStep(String(Math.max(tick, price - half - i * gap)), f.tickSize);
      const ap = ceilStep(String(price + half + i * gap), f.tickSize);
      const bq = this.roundQty(f, (800 + this.rand() * 30_000) / price);
      const aq = this.roundQty(f, (800 + this.rand() * 30_000) / price);
      if (bp !== lastBid && bq !== '0' && Number(bp) > 0) bids.push([bp, bq]);
      if (ap !== lastAsk && aq !== '0') asks.push([ap, aq]);
      lastBid = bp;
      lastAsk = ap;
    }
    // Đảm bảo không chéo giá
    if (bids[0] && asks[0] && new Big(bids[0][0]).gte(asks[0][0])) {
      asks.shift();
    }
    return { bids, asks };
  }

  private roundPrice(f: SymbolFilters, p: number): string {
    const minP = Number(f.minPrice) || Number(f.tickSize);
    const v = floorStep(new Big(Math.max(p, minP)).toFixed(18), f.tickSize);
    return str(Number(v) > 0 ? v : f.tickSize);
  }

  private roundQty(f: SymbolFilters, q: number): string {
    if (!Number.isFinite(q) || q <= 0) return '0';
    const v = floorStep(new Big(q).toFixed(18), f.stepSize);
    return new Big(v).lt(f.minQty) ? '0' : str(v);
  }

  private poisson(lambda: number): number {
    const l = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.rand();
    } while (p > l);
    return k - 1;
  }
}
