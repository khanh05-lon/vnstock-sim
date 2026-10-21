import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_NAMES, DEFAULT_SYMBOLS, str, type PriceControl, type PriceMode, type SymbolFilters, type SymbolInfo, type SymbolStatus } from '@vss/shared';
import type { Database } from '../db';
import { log } from '../lib/logger';
import { parseFilters, type BinanceRest } from './binance/rest';

export interface SymbolRowDb {
  symbol: string;
  base_asset: string;
  quote_asset: string;
  name: string;
  status: SymbolStatus;
  enabled: boolean;
  sort_order: number;
  filters: SymbolFilters;
  last_price: string | null;
  price_mode?: PriceMode;
  /** Kịch bản giá điều chỉnh (chỉ khi price_mode = MANUAL) */
  price_control?: StoredPriceControl | null;
}

/** Kịch bản lưu trong CSDL: thêm lý do và người đặt để hiện trên trang quản trị */
export type StoredPriceControl = PriceControl & { reason: string; by: string };

export interface FallbackSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  name: string;
  filters: SymbolFilters;
  lastPrice: string | null;
}

/** Bộ lọc + giá đóng gói sẵn (scripts/update-symbols.ts) — dùng khi không kết nối được Binance */
export function fallbackSymbols(): FallbackSymbol[] {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fallbackSymbols.json');
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { symbols: FallbackSymbol[] }).symbols;
}

export const toSymbolInfo = (r: SymbolRowDb): SymbolInfo => ({
  symbol: r.symbol,
  baseAsset: r.base_asset,
  quoteAsset: r.quote_asset,
  name: r.name,
  status: r.status,
  filters: r.filters,
  sortOrder: r.sort_order,
  priceMode: r.price_mode === 'MANUAL' && r.price_control ? 'MANUAL' : 'LIVE',
  priceSince: r.price_mode === 'MANUAL' && r.price_control ? r.price_control.since : null,
});

async function insertSymbol(db: Database, s: FallbackSymbol, sort: number) {
  await db.many(
    `INSERT INTO symbols (symbol, base_asset, quote_asset, name, filters, last_price, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (symbol) DO NOTHING`,
    [s.symbol, s.baseAsset, s.quoteAsset, s.name, JSON.stringify(s.filters), s.lastPrice, sort],
  );
}

/** Lấy cặp từ Binance exchangeInfo (null khi lỗi mạng) */
export async function fetchSymbols(rest: BinanceRest, symbols: string[]): Promise<FallbackSymbol[] | null> {
  try {
    const info = await rest.exchangeInfo(symbols);
    return info.map((s) => ({
      symbol: s.symbol,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      name: ASSET_NAMES[s.baseAsset] ?? s.baseAsset,
      filters: parseFilters(s.filters),
      lastPrice: null,
    }));
  } catch (err) {
    log.warn('[symbols] không lấy được exchangeInfo từ Binance', { err });
    return null;
  }
}

/**
 * Tạo các cặp mặc định chưa có trong CSDL (lần đầu: tất cả; sàn đã chạy: cặp mới thêm vào DEFAULT_SYMBOLS),
 * bộ lọc thật từ Binance, mất mạng thì dùng file dự phòng. Cặp quản trị viên đã huỷ niêm yết vẫn còn dòng nên không bị thêm lại.
 * Sau đó cập nhật lại bộ lọc của các cặp đang bật (Binance thỉnh thoảng đổi tickSize / minNotional).
 */
export async function seedSymbols(db: Database, rest: BinanceRest | null): Promise<void> {
  const have = new Set((await db.many<{ symbol: string }>('SELECT symbol FROM symbols')).map((r) => r.symbol));
  const missing = DEFAULT_SYMBOLS.filter((s) => !have.has(s));
  if (missing.length) {
    const fallback = new Map(fallbackSymbols().map((s) => [s.symbol, s]));
    const live = rest ? await fetchSymbols(rest, missing) : null;
    const byLive = new Map((live ?? []).map((s) => [s.symbol, s]));
    let sort = (await db.one<{ n: number }>('SELECT COALESCE(max(sort_order), -1)::int + 1 AS n FROM symbols'))!.n;
    let added = 0;
    for (const symbol of missing) {
      const fb = fallback.get(symbol);
      const s = byLive.get(symbol) ?? fb;
      if (!s) continue;
      await insertSymbol(db, { ...s, lastPrice: fb?.lastPrice ?? null }, sort++);
      added++;
    }
    log.info(`[symbols] đã tạo ${added} cặp giao dịch (bộ lọc ${live ? 'lấy từ Binance' : 'từ file dự phòng'})`);
    if (!have.size) return;
  }
  if (!rest) return;
  const enabled = await db.many<{ symbol: string }>('SELECT symbol FROM symbols WHERE enabled');
  if (!enabled.length) return;
  const live = await fetchSymbols(rest, enabled.map((r) => r.symbol));
  if (!live) return;
  for (const s of live) {
    await db.many('UPDATE symbols SET filters = $2, updated_at = now() WHERE symbol = $1', [s.symbol, JSON.stringify(s.filters)]);
  }
}

/** Thêm 1 cặp mới (quản trị viên): lấy bộ lọc thật từ Binance */
export async function addSymbol(db: Database, rest: BinanceRest | null, symbol: string): Promise<SymbolRowDb> {
  const fb = fallbackSymbols().find((s) => s.symbol === symbol);
  const live = rest ? await fetchSymbols(rest, [symbol]) : null;
  const s = live?.[0] ?? fb;
  if (!s) throw new Error(`Không tìm thấy cặp ${symbol} trên Binance`);
  const sort = (await db.one<{ n: number }>('SELECT COALESCE(max(sort_order), -1)::int + 1 AS n FROM symbols'))!.n;
  await insertSymbol(db, s, sort);
  // Thêm lại cặp đã gỡ: bắt đầu lại từ giá thực tế
  await db.many("UPDATE symbols SET enabled = true, status = $2, price_mode = 'LIVE', price_control = NULL, updated_at = now() WHERE symbol = $1", [symbol, 'TRADING']);
  return (await db.one<SymbolRowDb>('SELECT * FROM symbols WHERE symbol = $1', [symbol]))!;
}

export async function loadSymbols(db: Database, onlyEnabled = true): Promise<SymbolRowDb[]> {
  const rows = await db.many<SymbolRowDb>(`SELECT * FROM symbols ${onlyEnabled ? 'WHERE enabled' : ''} ORDER BY sort_order, symbol`);
  return rows.map((r) => ({ ...r, last_price: r.last_price == null ? null : str(r.last_price) }));
}
