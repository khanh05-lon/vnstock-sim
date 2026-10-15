import { z } from 'zod';

/* ======================= schema dữ liệu từ data-service ======================= */

const int = z.number().int();
const level = z.object({ p: int.positive(), v: int.positive() });

export const boardItemSchema = z.object({
  symbol: z.string(),
  exchange: z.string().nullish(),
  tradingDate: z.string().nullish(),
  session: z.string().default(''),
  ref: int,
  ceil: int,
  floor: int,
  open: int,
  high: int,
  low: int,
  last: int,
  lastVol: int,
  volume: int,
  value: z.number(),
  atoPrice: int,
  atoVol: int,
  atcPrice: int,
  atcVol: int,
  foreignBuy: int,
  foreignSell: int,
  listedShares: int,
  matchTime: z.number().nullish(),
  bookTime: z.number().nullish(),
  bids: z.array(level),
  asks: z.array(level),
});
export type BoardItem = z.infer<typeof boardItemSchema>;

export interface BoardSnapshot {
  fetchedAt: number;
  items: BoardItem[];
  /** số phần tử bị loại vì sai định dạng */
  rejected: number;
}

const dailyBarSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  open: z.number().positive(),
  high: z.number().positive(),
  low: z.number().positive(),
  close: z.number().positive(),
  volume: z.number().nonnegative(),
  value: z.number().nonnegative(),
});
export type DailyBar = z.infer<typeof dailyBarSchema>;

const historySchema = z.object({
  bars: z.record(z.array(dailyBarSchema)),
  errors: z.record(z.string()).default({}),
});

const indexQuoteSchema = z.object({
  code: z.string(),
  date: z.string(),
  value: z.number().positive(),
  prevClose: z.number().positive(),
});
export type IndexQuote = z.infer<typeof indexQuoteSchema>;

/** Phân tích phản hồi /board — phần tử sai định dạng bị bỏ qua thay vì làm hỏng cả bảng giá */
export function parseBoard(raw: unknown): BoardSnapshot {
  const obj = z.object({ fetchedAt: z.number(), items: z.array(z.unknown()) }).parse(raw);
  const items: BoardItem[] = [];
  let rejected = 0;
  for (const x of obj.items) {
    const r = boardItemSchema.safeParse(x);
    if (r.success) items.push(r.data);
    else rejected++;
  }
  return { fetchedAt: obj.fetchedAt, items, rejected };
}

export function parseHistory(raw: unknown): { bars: Record<string, DailyBar[]>; errors: Record<string, string> } {
  return historySchema.parse(raw);
}

export function parseIndices(raw: unknown): IndexQuote[] {
  const obj = z.object({ items: z.array(z.unknown()) }).parse(raw);
  return obj.items.flatMap((x) => {
    const r = indexQuoteSchema.safeParse(x);
    return r.success ? [r.data] : [];
  });
}

/* ================================ client HTTP ================================ */

export interface VnstockSource {
  board(symbols: string[]): Promise<BoardSnapshot>;
  indices(codes: string[]): Promise<IndexQuote[]>;
}

export interface VnstockClientOptions {
  /** Giới hạn số request tới data-service mỗi phút */
  maxPerMinute?: number;
  timeoutMs?: number;
}

/**
 * Gọi data-service (vnstock-sim/data-service). Có cache ngắn hạn theo URL để các lời gọi trùng
 * không sinh request mới, và giới hạn số request/phút để không dội tải lên nguồn.
 */
export class VnstockClient implements VnstockSource {
  private sent: number[] = [];
  private cache = new Map<string, { at: number; data: unknown }>();
  private maxPerMinute: number;
  private timeoutMs: number;

  constructor(
    readonly baseUrl: string,
    opts: VnstockClientOptions = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.maxPerMinute = opts.maxPerMinute ?? 120;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  async board(symbols: string[]): Promise<BoardSnapshot> {
    return parseBoard(await this.get(`/board?symbols=${symbols.join(',')}`, 1000));
  }

  async indices(codes: string[]): Promise<IndexQuote[]> {
    return parseIndices(await this.get(`/indices?codes=${codes.join(',')}`, 5000));
  }

  async history(symbols: string[], days: number) {
    return parseHistory(await this.get(`/history?symbols=${symbols.join(',')}&days=${days}`, 600_000, 120_000));
  }

  /** Chờ data-service sẵn sàng (khi chạy song song với backend bằng `npm run dev:vnstock`) */
  async waitReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return true;
      } catch {
        // chưa chạy
      }
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private async get(path: string, ttlMs: number, timeoutMs = this.timeoutMs): Promise<unknown> {
    const now = Date.now();
    const hit = this.cache.get(path);
    if (hit && now - hit.at < ttlMs) return hit.data;

    this.sent = this.sent.filter((t) => now - t < 60_000);
    if (this.sent.length >= this.maxPerMinute) throw new Error(`vượt giới hạn ${this.maxPerMinute} request/phút tới data-service`);
    this.sent.push(now);

    const res = await fetch(this.baseUrl + path, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`data-service ${res.status}: ${body.slice(0, 200)}`);
    }
    const data: unknown = await res.json();
    this.cache.set(path, { at: Date.now(), data });
    if (this.cache.size > 200) this.cache.clear();
    return data;
  }
}
