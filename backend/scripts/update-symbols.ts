/**
 * Cập nhật file bộ lọc dự phòng (dùng khi khởi động mà không kết nối được Binance):
 *   npm run symbols:update -w backend
 * Lấy exchangeInfo + giá 24h thật của các cặp mặc định, ghi vào src/market/fallbackSymbols.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_NAMES, DEFAULT_SYMBOLS } from '@vss/shared';
import { BinanceRest, parseFilters } from '../src/market/binance/rest';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/market/fallbackSymbols.json');
const rest = new BinanceRest();
const info = await rest.exchangeInfo(DEFAULT_SYMBOLS);
const tickers = new Map((await rest.tickers(info.map((s) => s.symbol))).map((t) => [t.symbol, t]));
const rows = DEFAULT_SYMBOLS.flatMap((symbol) => {
  const s = info.find((x) => x.symbol === symbol);
  if (!s) {
    console.warn(`Bỏ qua ${symbol}: Binance không có cặp này`);
    return [];
  }
  return [
    {
      symbol,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      name: ASSET_NAMES[s.baseAsset] ?? s.baseAsset,
      filters: parseFilters(s.filters),
      lastPrice: tickers.get(symbol)?.last ?? null,
    },
  ];
});
fs.writeFileSync(out, `${JSON.stringify({ updatedAt: new Date().toISOString(), symbols: rows }, null, 2)}\n`);
console.log(`Đã ghi ${rows.length} cặp vào ${out}`);
