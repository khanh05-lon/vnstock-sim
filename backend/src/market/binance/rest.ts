import { str, type BookLevel, type Kline, type KlineInterval, type SymbolFilters, type Ticker24h, type TradeTick } from '@vss/shared';

/*
 * Client REST công khai của Binance Spot (không cần API key).
 * - Ưu tiên data-api.binance.vision (chỉ dữ liệu thị trường), dự phòng api.binance.com.
 * - Theo dõi trọng số đã dùng qua header x-mbx-used-weight-1m, tự giãn nhịp trước khi chạm giới hạn
 *   (6000/phút); gặp 429/418 thì chờ theo Retry-After.
 */

export interface RawSymbol {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  filters: Record<string, unknown>[];
}

export interface RawTicker {
  symbol: string;
  lastPrice: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  priceChange: string;
  priceChangePercent: string;
  volume: string;
  quoteVolume: string;
  bidPrice: string;
  askPrice: string;
  closeTime: number;
}

export interface RestDepth {
  lastUpdateId: number;
  bids: BookLevel[];
  asks: BookLevel[];
}

type Kraw = [number, string, string, string, string, string, ...unknown[]];

export class BinanceRestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BinanceRest {
  /** Trọng số đã dùng trong phút hiện tại (theo header của Binance) */
  usedWeight = 0;
  private bannedUntil = 0;
  private preferred = 0;

  constructor(
    private opts: { baseUrls: string[]; timeoutMs?: number; weightLimit?: number } = {
      baseUrls: ['https://data-api.binance.vision', 'https://api.binance.com'],
    },
  ) {}

  private async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const wait = this.bannedUntil - Date.now();
    if (wait > 0) throw new BinanceRestError(`Binance đang giới hạn tần suất, thử lại sau ${Math.ceil(wait / 1000)}s`, 429);
    // Còn dưới 10% hạn mức → chờ sang phút mới
    const limit = this.opts.weightLimit ?? 6000;
    if (this.usedWeight > limit * 0.9) await sleep(60_000 - (Date.now() % 60_000));

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const query = qs.toString();
    const urls = this.opts.baseUrls;
    let lastErr: unknown;
    for (let i = 0; i < urls.length; i++) {
      const idx = (this.preferred + i) % urls.length;
      const url = `${urls[idx]}${path}${query ? `?${query}` : ''}`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8000) });
        const w = Number(res.headers.get('x-mbx-used-weight-1m'));
        if (Number.isFinite(w) && w > 0) this.usedWeight = w;
        if (res.status === 429 || res.status === 418) {
          const retry = Number(res.headers.get('retry-after')) || 60;
          this.bannedUntil = Date.now() + retry * 1000;
          throw new BinanceRestError(`Binance từ chối do vượt tần suất (HTTP ${res.status})`, res.status);
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new BinanceRestError(`Binance HTTP ${res.status}: ${body.slice(0, 200)}`, res.status);
        }
        this.preferred = idx;
        return (await res.json()) as T;
      } catch (err) {
        lastErr = err;
        // 4xx do tham số sai: không thử máy chủ khác
        if (err instanceof BinanceRestError && err.status >= 400 && err.status < 500) throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async ping(): Promise<boolean> {
    try {
      await this.get('/api/v3/ping');
      return true;
    } catch {
      return false;
    }
  }

  async exchangeInfo(symbols: string[]): Promise<RawSymbol[]> {
    const r = await this.get<{ symbols: RawSymbol[] }>('/api/v3/exchangeInfo', { symbols: JSON.stringify(symbols), showPermissionSets: 'false' });
    return r.symbols;
  }

  async tickers(symbols: string[]): Promise<Ticker24h[]> {
    const out: Ticker24h[] = [];
    // tối đa 100 cặp / lần để giữ trọng số 40
    for (let i = 0; i < symbols.length; i += 100) {
      const part = symbols.slice(i, i + 100);
      const raw = await this.get<RawTicker[]>('/api/v3/ticker/24hr', { symbols: JSON.stringify(part) });
      out.push(...raw.map(parseTicker));
    }
    return out;
  }

  async depth(symbol: string, limit = 20): Promise<RestDepth> {
    return this.get<RestDepth>('/api/v3/depth', { symbol, limit });
  }

  async klines(symbol: string, interval: KlineInterval, limit = 500, endTime?: number): Promise<Kline[]> {
    const raw = await this.get<Kraw[]>('/api/v3/klines', { symbol, interval, limit, endTime });
    return raw.map((k) => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
  }

  async aggTrades(symbol: string, limit = 60): Promise<TradeTick[]> {
    const raw = await this.get<{ a: number; p: string; q: string; T: number; m: boolean }[]>('/api/v3/aggTrades', { symbol, limit });
    return raw.map((t) => ({ id: t.a, symbol, price: str(t.p), qty: str(t.q), time: t.T, buyerMaker: t.m }));
  }

  async avgPrice(symbol: string): Promise<string> {
    const r = await this.get<{ price: string }>('/api/v3/avgPrice', { symbol });
    return str(r.price);
  }
}

export function parseTicker(t: RawTicker): Ticker24h {
  return {
    symbol: t.symbol,
    last: str(t.lastPrice),
    open: str(t.openPrice),
    high: str(t.highPrice),
    low: str(t.lowPrice),
    change: str(t.priceChange),
    changePct: Number(t.priceChangePercent),
    volume: str(t.volume),
    quoteVolume: str(t.quoteVolume),
    bid: str(t.bidPrice),
    ask: str(t.askPrice),
    updatedAt: t.closeTime,
  };
}

/** Bộ lọc exchangeInfo của Binance → SymbolFilters */
export function parseFilters(raw: Record<string, unknown>[]): SymbolFilters {
  const by = new Map(raw.map((f) => [String(f.filterType), f]));
  const s = (type: string, key: string, dflt = '0') => {
    const v = by.get(type)?.[key];
    return v == null ? dflt : str(String(v));
  };
  const b = (type: string, key: string, dflt: boolean) => {
    const v = by.get(type)?.[key];
    return typeof v === 'boolean' ? v : dflt;
  };
  const n = (type: string, key: string, dflt: number) => {
    const v = Number(by.get(type)?.[key]);
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  // Một số cặp cũ dùng MIN_NOTIONAL / PERCENT_PRICE thay cho NOTIONAL / PERCENT_PRICE_BY_SIDE
  const hasNotional = by.has('NOTIONAL');
  const hasBySide = by.has('PERCENT_PRICE_BY_SIDE');
  return {
    tickSize: s('PRICE_FILTER', 'tickSize'),
    minPrice: s('PRICE_FILTER', 'minPrice'),
    maxPrice: s('PRICE_FILTER', 'maxPrice'),
    stepSize: s('LOT_SIZE', 'stepSize'),
    minQty: s('LOT_SIZE', 'minQty'),
    maxQty: s('LOT_SIZE', 'maxQty'),
    marketMaxQty: s('MARKET_LOT_SIZE', 'maxQty'),
    minNotional: hasNotional ? s('NOTIONAL', 'minNotional') : s('MIN_NOTIONAL', 'minNotional'),
    maxNotional: hasNotional ? s('NOTIONAL', 'maxNotional') : '0',
    applyMinToMarket: hasNotional ? b('NOTIONAL', 'applyMinToMarket', true) : b('MIN_NOTIONAL', 'applyToMarket', true),
    applyMaxToMarket: b('NOTIONAL', 'applyMaxToMarket', false),
    bidMultiplierUp: hasBySide ? s('PERCENT_PRICE_BY_SIDE', 'bidMultiplierUp') : s('PERCENT_PRICE', 'multiplierUp'),
    bidMultiplierDown: hasBySide ? s('PERCENT_PRICE_BY_SIDE', 'bidMultiplierDown') : s('PERCENT_PRICE', 'multiplierDown'),
    askMultiplierUp: hasBySide ? s('PERCENT_PRICE_BY_SIDE', 'askMultiplierUp') : s('PERCENT_PRICE', 'multiplierUp'),
    askMultiplierDown: hasBySide ? s('PERCENT_PRICE_BY_SIDE', 'askMultiplierDown') : s('PERCENT_PRICE', 'multiplierDown'),
    maxNumOrders: n('MAX_NUM_ORDERS', 'maxNumOrders', 200),
    maxNumAlgoOrders: n('MAX_NUM_ALGO_ORDERS', 'maxNumAlgoOrders', 5),
  };
}
