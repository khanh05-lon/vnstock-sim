import type { MarketMode } from '@vss/shared';
import type { Database } from '../../db';
import { addDays, currentTradeDate, isWeekend } from '../../lib/calendar';
import { insertBatched } from '../../seed/seed';
import type { DailyBar, VnstockClient } from './client';
import { INDEX_CODES } from './realProvider';

const META_KEY = 'history_source';
/** Số mã mỗi lần gọi /history (data-service giới hạn 20) */
const CHUNK = 10;
const COLS = ['open', 'high', 'low', 'close', 'volume', 'value'];
const UPSERT = COLS.map((c) => `${c} = EXCLUDED.${c}`).join(', ');

interface HistoryMeta {
  provider: 'vnstock';
  /** ngày giao dịch lúc đồng bộ — đã có đủ nến của các phiên trước ngày này */
  syncedAt: string;
}

/** Nến ngày của nguồn → dòng ohlcv_daily / index_daily. Bỏ phiên hiện tại (MarketService tự chốt khi hết ngày). */
export function barsToRows(key: string, bars: DailyBar[], beforeDate: string, isIndex: boolean): unknown[][] {
  const px = (v: number) => (isIndex ? v : Math.round(v));
  return bars
    .filter((b) => b.date < beforeDate)
    .map((b) => [key, b.date, px(b.open), px(b.high), px(b.low), px(b.close), Math.round(b.volume), Math.round(b.value)]);
}

function weekdaysBetween(from: string, to: string): number {
  let n = 0;
  for (let d = from; d < to; d = addDays(d, 1)) if (!isWeekend(d)) n++;
  return n;
}

const placeholders = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `$${i + from}`).join(',');

/**
 * Nạp nến ngày thật (cổ phiếu + 4 chỉ số) từ data-service vào CSDL.
 * - Lần đầu (hoặc CSDL đang chứa lịch sử giả lập): thay toàn bộ lịch sử của các mã nguồn có dữ liệu.
 * - Các lần sau: chỉ tải bù vài phiên gần nhất.
 * Đồng thời cập nhật KL niêm yết thật của từng mã (dùng cho vốn hoá / chỉ số).
 */
export async function syncRealHistory(
  db: Database,
  client: Pick<VnstockClient, 'history' | 'board'>,
  opts: { mode: MarketMode; days: number; now?: number },
) {
  const td = currentTradeDate(opts.now ?? Date.now(), opts.mode);
  const symbols = (await db.many<{ symbol: string }>('SELECT symbol FROM stocks ORDER BY symbol')).map((r) => r.symbol);
  const meta = (await db.one<{ value: HistoryMeta }>('SELECT value FROM market_meta WHERE key = $1', [META_KEY]))?.value;
  const full = meta?.provider !== 'vnstock';
  if (!full && meta.syncedAt >= td) return { full, days: 0, stocks: 0, indices: 0, bars: 0, missing: [] as string[] };
  const days = full ? opts.days : Math.min(opts.days, weekdaysBetween(meta.syncedAt, td) + 5);

  const keys = [...symbols, ...INDEX_CODES];
  const bars: Record<string, DailyBar[]> = {};
  for (let i = 0; i < keys.length; i += CHUNK) {
    const res = await client.history(keys.slice(i, i + CHUNK), days);
    Object.assign(bars, res.bars);
  }

  const stockRows: unknown[][] = [];
  const indexRows: unknown[][] = [];
  const gotStocks: string[] = [];
  const gotIndices: string[] = [];
  for (const sym of symbols) {
    const rows = barsToRows(sym, bars[sym] ?? [], td, false);
    if (rows.length) gotStocks.push(sym);
    stockRows.push(...rows);
  }
  for (const code of INDEX_CODES) {
    const rows = barsToRows(code, bars[code] ?? [], td, true);
    if (rows.length) gotIndices.push(code);
    indexRows.push(...rows);
  }
  if (!gotStocks.length) throw new Error('nguồn không trả về lịch sử giá nào');

  let listed: { symbol: string; listedShares: number }[] = [];
  try {
    listed = (await client.board(symbols)).items.filter((x) => x.listedShares > 0);
  } catch {
    // không bắt buộc — giữ KL niêm yết đang có
  }

  await db.tx(async (tx) => {
    if (full) {
      // Xoá lịch sử giả lập trong khoảng nguồn có dữ liệu (kể cả phiên nghỉ lễ mà bộ sinh giả lập không biết)
      await tx.many(`DELETE FROM ohlcv_daily WHERE trade_date < $1 AND symbol IN (${placeholders(gotStocks.length, 2)})`, [td, ...gotStocks]);
      if (gotIndices.length) {
        await tx.many(`DELETE FROM index_daily WHERE trade_date < $1 AND code IN (${placeholders(gotIndices.length, 2)})`, [td, ...gotIndices]);
      }
    }
    await insertBatched(tx, 'ohlcv_daily', ['symbol', 'trade_date', ...COLS], stockRows, `ON CONFLICT (symbol, trade_date) DO UPDATE SET ${UPSERT}`);
    if (indexRows.length) {
      await insertBatched(tx, 'index_daily', ['code', 'trade_date', ...COLS], indexRows, `ON CONFLICT (code, trade_date) DO UPDATE SET ${UPSERT}`);
    }
    if (listed.length) {
      const values = listed.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}::bigint)`).join(',');
      await tx.many(
        `UPDATE stocks SET listed_shares = v.shares FROM (VALUES ${values}) AS v(symbol, shares) WHERE stocks.symbol = v.symbol`,
        listed.flatMap((x) => [x.symbol, x.listedShares]),
      );
    }
    const value: HistoryMeta = { provider: 'vnstock', syncedAt: td };
    await tx.many(
      'INSERT INTO market_meta (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [META_KEY, JSON.stringify(value)],
    );
  });

  return {
    full,
    days,
    stocks: gotStocks.length,
    indices: gotIndices.length,
    bars: stockRows.length + indexRows.length,
    missing: symbols.filter((s) => !gotStocks.includes(s)),
  };
}
