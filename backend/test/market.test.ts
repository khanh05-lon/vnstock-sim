import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Big, DEFAULT_SYMBOLS, isMultiple, type Kline } from '@vss/shared';
import type { Database } from '../src/db';
import { parseFilters } from '../src/market/binance/rest';
import { aggregateBars, bucketOf, MarketService } from '../src/market/marketService';
import { SimFeed } from '../src/market/simFeed';
import { fallbackSymbols, seedSymbols } from '../src/market/symbols';
import { closeTestDb, openTestDb } from './helpers/db';
import { TEST_FILTERS } from './helpers/fakeMarket';

describe('Nến', () => {
  it('mốc mở nến theo khung: tuần bắt đầu thứ Hai, tháng bắt đầu ngày 1 (UTC)', () => {
    const t = Date.UTC(2026, 9, 16, 13, 47, 12) / 1000; // thứ Sáu 16/10/2026
    expect(bucketOf(t, '1m')).toBe(Date.UTC(2026, 9, 16, 13, 47) / 1000);
    expect(bucketOf(t, '4h')).toBe(Date.UTC(2026, 9, 16, 12) / 1000);
    expect(bucketOf(t, '1d')).toBe(Date.UTC(2026, 9, 16) / 1000);
    expect(bucketOf(t, '1w')).toBe(Date.UTC(2026, 9, 12) / 1000);
    expect(bucketOf(t, '1M')).toBe(Date.UTC(2026, 9, 1) / 1000);
  });

  it('gộp nến 1 phút thành nến 5 phút', () => {
    const bars: Kline[] = [0, 1, 2, 5].map((m, i) => ({ time: m * 60, open: 10 + i, high: 20 + i, low: 5 - i, close: 11 + i, volume: 1 }));
    expect(aggregateBars(bars, '5m')).toEqual([
      { time: 0, open: 10, high: 22, low: 3, close: 13, volume: 3 },
      { time: 300, open: 13, high: 23, low: 2, close: 14, volume: 1 },
    ]);
  });
});

describe('Bộ lọc Binance và giả lập', () => {
  it('đọc bộ lọc exchangeInfo (kể cả cặp cũ dùng MIN_NOTIONAL / PERCENT_PRICE)', () => {
    const f = parseFilters([
      { filterType: 'PRICE_FILTER', minPrice: '0.00000100', maxPrice: '1000.00000000', tickSize: '0.00000100' },
      { filterType: 'LOT_SIZE', minQty: '0.10000000', maxQty: '9000000.00000000', stepSize: '0.10000000' },
      { filterType: 'MIN_NOTIONAL', minNotional: '10.00000000', applyToMarket: true, avgPriceMins: 5 },
      { filterType: 'PERCENT_PRICE', multiplierUp: '5', multiplierDown: '0.2', avgPriceMins: 5 },
    ]);
    expect(f).toMatchObject({ tickSize: '0.000001', stepSize: '0.1', minNotional: '10', applyMinToMarket: true, bidMultiplierUp: '5', askMultiplierDown: '0.2' });
    expect(f.maxNumOrders).toBe(200);
  });

  it('file dự phòng có đủ các cặp mặc định với bộ lọc hợp lệ', () => {
    const list = fallbackSymbols();
    expect(list.map((s) => s.symbol)).toEqual(DEFAULT_SYMBOLS);
    for (const s of list) {
      expect(Number(s.filters.tickSize)).toBeGreaterThan(0);
      expect(Number(s.filters.stepSize)).toBeGreaterThan(0);
      expect(Number(s.lastPrice)).toBeGreaterThan(0);
    }
  });

  it('giả lập sinh giá, sổ lệnh, giao dịch đúng bước giá / bước khối lượng và không chéo giá', () => {
    const sim = new SimFeed(42);
    const pepe = fallbackSymbols().find((s) => s.symbol === 'PEPEUSDT')!;
    let last = pepe.lastPrice!;
    for (let i = 0; i < 50; i++) {
      const r = sim.step({ symbol: 'PEPEUSDT', filters: pepe.filters, last }, 1000);
      last = r.last;
      expect(isMultiple(r.last, pepe.filters.tickSize)).toBe(true);
      for (const [p, q] of [...r.bids, ...r.asks]) {
        expect(isMultiple(p, pepe.filters.tickSize)).toBe(true);
        expect(isMultiple(q, pepe.filters.stepSize)).toBe(true);
      }
      expect(new Big(r.bids[0]![0]).lt(r.asks[0]![0])).toBe(true);
      for (const t of r.trades) expect(new Big(t.qty).gte(pepe.filters.minQty)).toBe(true);
    }
  });
});

describe('seedSymbols trên sàn đang chạy', () => {
  it('thêm cặp mặc định còn thiếu, không bật lại cặp đã huỷ niêm yết', async () => {
    const db = await openTestDb();
    await seedSymbols(db, null);
    await db.many("DELETE FROM symbols WHERE symbol = 'TRBUSDT'");
    await db.many("UPDATE symbols SET enabled = false WHERE symbol = 'ETCUSDT'");
    await seedSymbols(db, null);
    const rows = await db.many<{ symbol: string; enabled: boolean }>('SELECT symbol, enabled FROM symbols');
    expect(rows).toHaveLength(DEFAULT_SYMBOLS.length);
    expect(rows.find((r) => r.symbol === 'TRBUSDT')?.enabled).toBe(true);
    expect(rows.find((r) => r.symbol === 'ETCUSDT')?.enabled).toBe(false);
    await closeTestDb(db);
  });
});

describe('MarketService', () => {
  let db: Database;
  beforeAll(async () => {
    db = await openTestDb();
  });
  afterAll(() => closeTestDb(db));

  it('tạo các cặp mặc định từ file dự phòng khi không có mạng; mất nguồn Binance thì chạy giả lập; ăn sổ lệnh được ghi nhớ', async () => {
    await seedSymbols(db, null);
    expect((await db.one<{ n: number }>('SELECT count(*)::int AS n FROM symbols'))!.n).toBe(DEFAULT_SYMBOLS.length);

    // Nguồn binance nhưng không có kết nối (không gọi start) → sau simAfterMs chuyển sang giả lập
    const m = new MarketService(db, null, { feed: 'binance', simAfterMs: 0 });
    await m.init();
    expect(m.feed()).toBe('SIM');
    const ticks: string[] = [];
    m.on('trades', (l: { symbol: string }[]) => ticks.push(...l.map((t) => t.symbol)));
    m.hooks.onTick = async () => undefined;
    for (let i = 0; i < 5; i++) await m.flushNow();
    expect(m.rows()).toHaveLength(DEFAULT_SYMBOLS.length);
    expect(Number(m.lastPrice('BTCUSDT'))).toBeGreaterThan(1000);

    const before = m.depth('BTCUSDT')!.asks[0]!;
    const fills = m.consumeBook('BTCUSDT', 'BUY', { qty: before[1] }, null);
    expect(fills).toEqual([{ price: before[0], qty: before[1] }]);
    // mức giá vừa bị ăn hết không còn trong sổ (tới khi có bản sổ lệnh mới)
    expect(m.depth('BTCUSDT')!.asks[0]![0]).not.toBe(before[0]);
    expect(m.best('BTCUSDT', 'BUY')).toBe(m.depth('BTCUSDT')!.asks[0]![0]);

    // ép giá (giả lập) → bước kế tiếp nhảy tới giá đó
    m.forcePrice('ETHUSDT', '1234.56');
    await m.flushNow();
    expect(m.lastPrice('ETHUSDT')).toBe('1234.56');

    // nến trong bộ nhớ khi không có REST
    const bars = await m.candles('BTCUSDT', '1m', 10);
    expect(bars.length).toBeGreaterThan(0);
    await m.stop();
    const saved = await db.one<{ last_price: string }>(`SELECT last_price::text FROM symbols WHERE symbol = 'ETHUSDT'`);
    expect(Number(saved!.last_price)).toBe(Number(m.lastPrice('ETHUSDT')));
  });

  it('giá trung bình 5 phút dùng cho bộ lọc PERCENT_PRICE', async () => {
    const m = new MarketService(db, null, { feed: 'sim' });
    await m.init();
    await m.flushNow();
    await m.flushNow();
    const avg = m.avgPrice('BTCUSDT')!;
    expect(isMultiple(avg, m.info('BTCUSDT')!.filters.tickSize)).toBe(true);
    expect(Math.abs(Number(avg) / Number(m.lastPrice('BTCUSDT')) - 1)).toBeLessThan(0.01);
    expect(TEST_FILTERS.minNotional).toBe('5');
  });
});
