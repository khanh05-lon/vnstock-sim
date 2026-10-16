import { str, type BookLevel, type Kline, type TradeTick } from '@vss/shared';
import { log } from '../../lib/logger';

/*
 * Luồng WebSocket công khai của Binance Spot (dùng WebSocket có sẵn của Node ≥ 22).
 * Ghép nhiều luồng trên 1 kết nối (combined stream):
 *   !miniTicker@arr          thống kê 24h của các cặp thay đổi, mỗi giây
 *   <sym>@depth20@100ms      20 mức giá tốt nhất mỗi bên, 100ms
 *   <sym>@aggTrade           giao dịch (gộp theo lệnh taker), realtime
 *   <sym>@kline_1m           nến 1 phút đang chạy, 2 giây
 * Tự kết nối lại với backoff; Binance ngắt mọi kết nối sau 24h nên chủ động nối lại sau ~23h50.
 * Không có dữ liệu quá staleMs → coi như mất kết nối.
 */

export interface MiniTicker {
  symbol: string;
  close: string;
  open: string;
  high: string;
  low: string;
  volume: string;
  quoteVolume: string;
  time: number;
}

export interface StreamHandlers {
  miniTickers(list: MiniTicker[]): void;
  depth(symbol: string, bids: BookLevel[], asks: BookLevel[]): void;
  trade(t: TradeTick): void;
  kline(symbol: string, k: Kline, closed: boolean): void;
  /** true khi đang nhận dữ liệu, false khi mất kết nối */
  status(live: boolean): void;
}

const BACKOFF = [1_000, 2_000, 5_000, 10_000, 30_000];
const MAX_LIFETIME_MS = (23 * 60 + 50) * 60_000;

export class BinanceStream {
  private ws: WebSocket | null = null;
  private symbols: string[] = [];
  private attempt = 0;
  private lastMsg = 0;
  private live = false;
  private stopped = true;
  private watchdog: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private openedAt = 0;

  constructor(
    private handlers: StreamHandlers,
    private opts: { url: string; staleMs?: number } = { url: 'wss://data-stream.binance.vision' },
  ) {}

  get isLive() {
    return this.live;
  }

  start(symbols: string[]) {
    this.symbols = symbols;
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => this.check(), 2_000);
    this.watchdog.unref?.();
  }

  /** Đổi danh sách cặp (thêm / gỡ cặp) → kết nối lại với bộ luồng mới */
  setSymbols(symbols: string[]) {
    this.symbols = symbols;
    if (!this.stopped) this.restart();
  }

  stop() {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.setLive(false);
  }

  private url(): string {
    const streams = ['!miniTicker@arr'];
    for (const s of this.symbols) {
      const l = s.toLowerCase();
      streams.push(`${l}@depth20@100ms`, `${l}@aggTrade`, `${l}@kline_1m`);
    }
    return `${this.opts.url.replace(/\/+$/, '')}/stream?streams=${streams.join('/')}`;
  }

  private connect() {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url());
    } catch (err) {
      log.warn('[binance] không tạo được kết nối WebSocket', { err });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.openedAt = Date.now();
    ws.onopen = () => {
      this.attempt = 0;
      log.info(`[binance] đã kết nối luồng dữ liệu (${this.symbols.length} cặp)`);
    };
    ws.onmessage = (ev) => {
      this.lastMsg = Date.now();
      this.setLive(true);
      try {
        this.dispatch(JSON.parse(String(ev.data)) as { stream: string; data: unknown });
      } catch (err) {
        log.warn('[binance] lỗi xử lý dữ liệu luồng', { err });
      }
    };
    ws.onerror = () => {
      /* onclose sẽ xử lý kết nối lại */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setLive(false);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)]!;
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private restart() {
    const old = this.ws;
    this.ws = null;
    old?.close();
    this.connect();
  }

  private check() {
    if (this.stopped) return;
    const stale = this.opts.staleMs ?? 15_000;
    if (this.ws && this.lastMsg && Date.now() - this.lastMsg > stale) {
      log.warn(`[binance] không có dữ liệu ${Math.round((Date.now() - this.lastMsg) / 1000)}s, kết nối lại`);
      this.lastMsg = 0;
      this.setLive(false);
      this.restart();
    } else if (this.ws && Date.now() - this.openedAt > MAX_LIFETIME_MS) {
      this.restart();
    }
  }

  private setLive(v: boolean) {
    if (this.live === v) return;
    this.live = v;
    this.handlers.status(v);
  }

  private dispatch(msg: { stream: string; data: unknown }) {
    const { stream, data } = msg;
    if (stream === '!miniTicker@arr') {
      const arr = data as { s: string; c: string; o: string; h: string; l: string; v: string; q: string; E: number }[];
      this.handlers.miniTickers(
        arr.map((t) => ({ symbol: t.s, close: t.c, open: t.o, high: t.h, low: t.l, volume: t.v, quoteVolume: t.q, time: t.E })),
      );
      return;
    }
    const at = stream.indexOf('@');
    const symbol = stream.slice(0, at).toUpperCase();
    const kind = stream.slice(at + 1);
    if (kind.startsWith('depth')) {
      const d = data as { bids: [string, string][]; asks: [string, string][] };
      this.handlers.depth(
        symbol,
        d.bids.map(([p, q]) => [str(p), str(q)]),
        d.asks.map(([p, q]) => [str(p), str(q)]),
      );
    } else if (kind === 'aggTrade') {
      const t = data as { a: number; p: string; q: string; T: number; m: boolean };
      this.handlers.trade({ id: t.a, symbol, price: str(t.p), qty: str(t.q), time: t.T, buyerMaker: t.m });
    } else if (kind.startsWith('kline')) {
      const k = (data as { k: { t: number; o: string; h: string; l: string; c: string; v: string; x: boolean } }).k;
      this.handlers.kline(symbol, { time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v }, k.x);
    }
  }
}
