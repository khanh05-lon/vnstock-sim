import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { priceBand, type Exchange, type TradeTick } from '@vss/shared';
import { Database } from '../src/db';
import { mulberry32 } from '../src/lib/prng';
import { MarketService } from '../src/market/marketService';
import { MockProvider } from '../src/market/mockProvider';
import type { StockState } from '../src/market/types';
import { parseBoard, parseHistory, type BoardItem, type BoardSnapshot, type IndexQuote, type VnstockSource } from '../src/market/vnstock/client';
import { barsToRows, syncRealHistory } from '../src/market/vnstock/history';
import { applyBoardItem, inferSide, RealProvider, recordConsumption } from '../src/market/vnstock/realProvider';
import { migrate } from '../src/migrate';

/* Fixture = phản hồi thật của data-service (phiên 15/10/2026), không gọi mạng */
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const BOARD = parseBoard(fixture('vnstock-board.json'));
const HISTORY = parseHistory(fixture('vnstock-history.json'));
const item = (sym: string): BoardItem => structuredClone(BOARD.items.find((x) => x.symbol === sym)!);

const TD = '2026-10-15';
const AFTER_CLOSE = Date.parse('2026-10-15T08:30:00Z'); // 15:30 giờ VN, thứ Năm
const silent = () => {};

function makeState(symbol: string, exchange: Exchange, ref: number): StockState {
  return {
    info: { symbol, exchange, type: 'STOCK', name: symbol, industry: 'Test', listedShares: 1e9, eps: 1000, bvps: 10000, isVn30: false, marginRatio: 0 },
    liq: 0.5,
    volatility: 0.02,
    ref,
    ...priceBand(exchange, ref),
    open: 0,
    high: 0,
    low: 0,
    last: ref,
    lastVol: 0,
    lastSide: 'B',
    volume: 0,
    value: 0,
    bids: [],
    asks: [],
    foreignBuy: 0,
    foreignSell: 0,
    updatedAt: 0,
    sim: { fair: 0, target: 0, bp: 0 },
  };
}

/** Phần cộng dồn của MarketService.applyTrade */
function applyTrade(s: StockState, price: number, vol: number) {
  s.last = price;
  s.volume += vol;
  s.value += price * vol;
  s.high = Math.max(s.high, price);
  s.low = s.low ? Math.min(s.low, price) : price;
}

class FakeSource implements VnstockSource {
  items = BOARD.items.map((x) => structuredClone(x));
  quotes: IndexQuote[] = [{ code: 'VNINDEX', date: TD, value: 1698.35, prevClose: 1704.87 }];
  fail = false;
  async board(): Promise<BoardSnapshot> {
    if (this.fail) throw new Error('data-service down');
    return { fetchedAt: 0, items: this.items.map((x) => structuredClone(x)), rejected: 0 };
  }
  async indices() {
    return this.quotes;
  }
  get(sym: string) {
    return this.items.find((x) => x.symbol === sym)!;
  }
}

describe('vnstock: phân tích phản hồi data-service', () => {
  it('đọc bảng giá, bỏ phần tử sai định dạng thay vì làm hỏng cả bảng', () => {
    expect(BOARD.items.map((x) => x.symbol)).toEqual(['ACV', 'FPT', 'SHS']);
    expect(BOARD.rejected).toBe(0);
    const raw = fixture('vnstock-board.json') as { fetchedAt: number; items: unknown[] };
    const broken = parseBoard({ ...raw, items: [...raw.items, { symbol: 'XXX', ref: 'abc' }, null] });
    expect(broken.items).toHaveLength(3);
    expect(broken.rejected).toBe(2);
    expect(() => parseBoard({ items: 'nope' })).toThrow();
  });

  it('nến ngày → dòng CSDL, bỏ phiên hiện tại; chỉ số giữ số thập phân', () => {
    const fpt = barsToRows('FPT', HISTORY.bars.FPT, TD, false);
    expect(fpt).toHaveLength(3);
    expect(fpt[2]).toEqual(['FPT', '2026-10-14', 56300, 57700, 55800, 57100, 7095300, 402874510000]);
    const vni = barsToRows('VNINDEX', HISTORY.bars.VNINDEX, TD, true);
    expect(vni.map((r) => r[5])).toEqual([1720.98, 1719.42, 1704.87]);
  });
});

describe('vnstock: áp dữ liệu thật vào trạng thái mã', () => {
  it('lần đầu: đồng bộ thẳng giá/KL/GT/khối ngoại/sổ lệnh và TC-trần-sàn theo nguồn, không phát giao dịch', () => {
    const s = makeState('FPT', 'HOSE', 98_500); // giá giả lập cũ
    const r = applyBoardItem(s, item('FPT'), undefined, TD, 1);
    expect(r.trade).toBeNull();
    expect(r.changed).toBe(true);
    expect(s).toMatchObject({
      ref: 57_100,
      ceil: 61_000,
      floor: 53_200,
      open: 57_500,
      high: 58_200,
      low: 57_300,
      last: 58_000,
      lastVol: 152_500,
      volume: 4_964_400,
      value: 287_054_530_000,
      foreignBuy: 868_221,
      foreignSell: 605_912,
    });
    expect(s.bids).toEqual([
      { p: 58_000, v: 1_300 },
      { p: 57_900, v: 3_900 },
      { p: 57_800, v: 1_400 },
    ]);
    expect(s.asks[0]).toEqual({ p: 58_100, v: 82_600 });
    expect(r.track).toMatchObject({ vol: 4_964_400, bid1: 58_000, ask1: 58_100 });
  });

  it('KL luỹ kế tăng → 1 giao dịch Δ; sau applyTrade tổng KL/GT khớp nguồn', () => {
    const s = makeState('FPT', 'HOSE', 57_100);
    const first = applyBoardItem(s, item('FPT'), undefined, TD, 1);
    const next = item('FPT');
    next.volume += 3_000;
    next.value += 58_100 * 2_000 + 58_200 * 1_000; // 2 lệnh khớp ở 2 mức giá giữa 2 lần lấy
    next.last = 58_200;
    next.high = 58_300; // có lúc chạm 58.300 giữa 2 lần lấy dữ liệu
    const r = applyBoardItem(s, next, first.track, TD, 2);
    expect(r.trade).toEqual({ symbol: 'FPT', price: 58_200, vol: 3_000, side: 'B', foreign: false });
    applyTrade(s, r.trade!.price, r.trade!.vol);
    expect(s.volume).toBe(next.volume);
    expect(s.value).toBe(next.value);
    expect(s.high).toBe(58_300);
    expect(s.last).toBe(58_200);
    // không có dữ liệu mới → không phát lại
    expect(applyBoardItem(s, next, r.track, TD, 3).trade).toBeNull();
  });

  it('đoán chiều chủ động theo giá mua/bán tốt nhất trước đó', () => {
    const prev = { bid1: 58_000, ask1: 58_100, last: 58_000, side: 'B' as const };
    expect(inferSide(58_100, prev)).toBe('B');
    expect(inferSide(58_000, prev)).toBe('S');
    expect(inferSide(58_050, { ...prev, bid1: 0, ask1: 0 })).toBe('B');
    expect(inferSide(58_000, { ...prev, bid1: 0, ask1: 0, side: 'S' })).toBe('S');
  });

  it('bỏ qua dữ liệu của ngày giao dịch khác; khớp lệnh/sổ lệnh cũ thì coi như chưa có', () => {
    const s = makeState('FPT', 'HOSE', 57_100);
    const stale = item('FPT');
    stale.tradingDate = '2026-10-14';
    expect(applyBoardItem(s, stale, undefined, TD, 1)).toEqual({ track: undefined, trade: null, changed: false });
    expect(s.volume).toBe(0);

    // 8:45 sáng hôm sau: nguồn đã sang ngày mới (TC mới) nhưng khớp lệnh/sổ lệnh vẫn của hôm trước
    const morning = item('FPT');
    morning.tradingDate = '2026-10-16';
    morning.ref = 58_000;
    morning.ceil = 62_000;
    morning.floor = 54_000;
    const r = applyBoardItem(s, morning, undefined, '2026-10-16', 1);
    expect(r.trade).toBeNull();
    expect(s).toMatchObject({ ref: 58_000, ceil: 62_000, floor: 54_000, last: 58_000, volume: 0, value: 0, open: 0, foreignBuy: 0 });
    expect(s.bids).toEqual([]);
    expect(s.asks).toEqual([]);
  });

  it('lệnh người dùng ăn sổ lệnh thật → trừ khỏi các bản cập nhật sau cho tới khi mức giá rời sổ', () => {
    const s = makeState('FPT', 'HOSE', 57_100);
    const { track } = applyBoardItem(s, item('FPT'), undefined, TD, 1);
    // lệnh mua 90.000 CP ăn hết 82.600 ở 58.100 và 7.400 ở 58.200 (như MarketService.consumeBook)
    s.asks = [
      { p: 58_200, v: 161_400 - 7_400 },
      { p: 58_300, v: 42_300 },
    ];
    recordConsumption(s, track!);
    expect(track!.consumed).toEqual(
      new Map([
        ['S:58100', 82_600],
        ['S:58200', 7_400],
      ]),
    );
    // nguồn gửi lại đúng sổ lệnh cũ (chưa biết lệnh ảo) → vẫn hiển thị sổ đã bị ăn
    applyBoardItem(s, item('FPT'), track, TD, 2);
    expect(s.asks).toEqual([
      { p: 58_200, v: 154_000 },
      { p: 58_300, v: 42_300 },
    ]);
    // giá 58.100 rời sổ lệnh của nguồn → quên phần đã ăn ở mức đó
    const moved = item('FPT');
    moved.asks = [
      { p: 58_200, v: 160_000 },
      { p: 58_300, v: 42_300 },
      { p: 58_400, v: 10_000 },
    ];
    applyBoardItem(s, moved, track, TD, 3);
    expect(s.asks[0]).toEqual({ p: 58_200, v: 152_600 });
    expect(track!.consumed.has('S:58100')).toBe(false);
  });
});

describe('vnstock: RealProvider', () => {
  let now = AFTER_CLOSE;
  const states = () => [makeState('ACV', 'UPCOM', 108_900), makeState('FPT', 'HOSE', 98_500), makeState('SHS', 'HNX', 13_400)];
  const create = (src: VnstockSource, mode: 'REAL_HOURS' | 'SIMULATED_24_7' = 'REAL_HOURS') =>
    new RealProvider(src, { mode, pollMs: 3_000, staleMs: 20_000, now: () => now, log: silent }, new MockProvider(mulberry32(3)));

  beforeEach(() => {
    now = AFTER_CLOSE;
  });

  it('poll đồng bộ bảng giá thật, giá ATO/ATC và chỉ số lấy từ nguồn', async () => {
    const p = create(new FakeSource());
    const list = states();
    await p.start(list);
    p.stop();
    expect(p.live).toBe(true);
    p.resume(list);
    const r = p.poll(list, now, 1000);
    expect(r.trades).toEqual([]);
    expect(r.touched.sort()).toEqual(['ACV', 'FPT', 'SHS']);
    expect(list[1]).toMatchObject({ ref: 57_100, last: 58_000, volume: 4_964_400 });
    expect(p.poll(list, now + 1000, 1000)).toEqual({ trades: [], touched: [] });
    expect(p.auctionPrice(list[1], 'ATO')).toBe(57_500);
    expect(p.auctionPrice(list[1], 'ATC')).toBe(58_000);
    expect(p.auctionPrice(list[0], 'ATO')).toBe(0); // ACV (UPCOM) không có phiên định kỳ
    expect(p.indexValue('VNINDEX', TD)).toBe(1698.35);
    expect(p.indexValue('VNINDEX', '2026-10-16')).toBeNull();
    expect(p.indexValue('VN30', TD)).toBeNull();
  });

  it('nguồn lỗi/quá cũ → chạy giả lập từ giá hiện tại; nguồn có lại → đồng bộ về dữ liệu thật', async () => {
    const src = new FakeSource();
    src.fail = true;
    const p = create(src);
    const list = states();
    await p.start(list);
    p.stop();
    expect(p.live).toBe(false);

    p.ingest((await new FakeSource().board()).items);
    p.resume(list);
    p.poll(list, now, 1000);
    const fpt = list[1];
    expect(fpt.volume).toBe(4_964_400);

    now += 10 * 60_000; // 10 phút không lấy được dữ liệu
    expect(p.live).toBe(false);
    let mockTrades = 0;
    for (let i = 0; i < 300; i++) mockTrades += p.poll(list, now + i * 1000, 1000).trades.length;
    expect(mockTrades).toBeGreaterThan(0);
    expect(fpt.sim.fair).toBeGreaterThan(53_200); // giả lập tiếp từ giá thật, không từ giá seed
    expect(fpt.sim.fair).toBeLessThan(61_000);
    expect(fpt.bids.length).toBeGreaterThan(0);

    p.ingest(src.items);
    expect(p.live).toBe(true);
    p.poll(list, now, 1000);
    expect(fpt).toMatchObject({ volume: 4_964_400, last: 58_000, value: 287_054_530_000 });
    expect(fpt.bids[0]).toEqual({ p: 58_000, v: 1_300 });
  });

  it('SIMULATED_24_7: ngoài giờ giao dịch thật thì dùng giả lập dù nguồn vẫn chạy', async () => {
    const p = create(new FakeSource(), 'SIMULATED_24_7');
    await p.start(states());
    p.stop();
    expect(p.live).toBe(false); // 15:30
    now = Date.parse('2026-10-15T03:00:00Z'); // 10:00 giờ VN
    p.ingest(new FakeSource().items);
    expect(p.live).toBe(true);
    now = Date.parse('2026-10-15T05:00:00Z'); // 12:00 nghỉ trưa
    p.ingest(new FakeSource().items);
    expect(p.live).toBe(false);
  });
});

describe('vnstock: MarketService chạy với dữ liệu thật', () => {
  let db: Database;
  let src: FakeSource;
  let provider: RealProvider;
  let market: MarketService | undefined;
  let now: number;

  beforeEach(async () => {
    market = undefined;
    db = await Database.open();
    await migrate(db);
    await db.exec(`INSERT INTO stocks (symbol, exchange, name, industry, listed_shares, eps, bvps) VALUES
      ('ACV','UPCOM','ACV','Test',3582324023,4100,26000), ('FPT','HOSE','FPT','Test',1714326422,5900,22000), ('SHS','HNX','SHS','Test',813000000,900,12500)`);
    await db.exec(`INSERT INTO ohlcv_daily (symbol, trade_date, open, high, low, close, volume, value) VALUES
      ('ACV','2026-10-14',41000,41500,40900,41300,1,1), ('FPT','2026-10-14',56300,57700,55800,57100,1,1), ('SHS','2026-10-14',12000,12100,11900,12000,1,1)`);
    src = new FakeSource();
  });

  afterEach(async () => {
    await market?.stop();
    await db.close();
  });

  async function boot(at: number) {
    now = at;
    provider = new RealProvider(src, { mode: 'REAL_HOURS', pollMs: 3_000, staleMs: 20_000, now: () => now, log: silent });
    const m = new MarketService(db, provider, { mode: 'REAL_HOURS', tickIntervalMs: 1000 });
    market = m;
    await m.init(now);
    provider.stop();
    return m;
  }

  it('khởi động: bảng giá lấy ngay từ nguồn, không mô phỏng phần phiên đã qua; KL tăng → giao dịch', async () => {
    const market = await boot(AFTER_CLOSE);
    expect(market.session().feed).toBe('LIVE');
    const fpt = market.rows().find((r) => r.symbol === 'FPT')!;
    expect(fpt).toMatchObject({ ref: 57_100, ceil: 61_000, floor: 53_200, last: 58_000, change: 900, volume: 4_964_400, value: 287_054_530_000 });
    expect(fpt.bids[0]).toEqual({ p: 58_000, v: 1_300 });
    expect(await market.candles('FPT', '1m')).toEqual([]);
    expect(market.indexSnapshots().find((i) => i.code === 'VNINDEX')!.value).toBe(1698.35);

    const ticks: TradeTick[] = [];
    market.on('trades', (t: TradeTick[]) => ticks.push(...t));
    const f = src.get('FPT');
    f.volume += 2_000;
    f.value += 58_100 * 2_000;
    f.last = 58_100;
    provider.ingest(src.items);
    now += 3_000;
    await market.tick(now);
    expect(ticks).toEqual([expect.objectContaining({ symbol: 'FPT', price: 58_100, vol: 2_000, side: 'B' })]);
    expect(market.quote('FPT')).toMatchObject({ last: 58_100, volume: 4_966_400, value: 287_054_530_000 + 58_100 * 2_000 });
  });

  it('ATO/ATC: khớp lệnh người dùng theo giá khớp thật khi nguồn có, không cộng KL giả; hết phiên sau khi có giá ATC', async () => {
    const market = await boot(Date.parse('2026-10-15T02:14:58Z')); // 9:14:58 — đang ATO
    const auctions: [string, Record<string, number>][] = [];
    let dayEnds = 0;
    market.hooks = {
      onAuction: async (kind, prices) => {
        auctions.push([kind, Object.fromEntries(prices)]);
      },
      onDayEnd: async () => {
        dayEnds++;
      },
    };
    const volBefore = market.quote('FPT')!.volume;
    now = Date.parse('2026-10-15T02:15:01Z');
    await market.tick(now);
    expect(market.phase).toBe('CONTINUOUS');
    expect(auctions).toEqual([['ATO', { FPT: 57_500 }]]);
    expect(market.quote('FPT')!.volume).toBe(volBefore);

    src.get('SHS').atoPrice = 12_100;
    src.get('SHS').atoVol = 5_000;
    provider.ingest(src.items);
    now += 3_000;
    await market.tick(now);
    expect(auctions[1]).toEqual(['ATO', { SHS: 12_100 }]);

    // ATC: ACV (UPCOM) không có giá khớp ATC → chờ tối đa 30s rồi mới hết phiên
    now = Date.parse('2026-10-15T07:44:59Z');
    provider.ingest(src.items);
    await market.tick(now);
    expect(market.phase).toBe('ATC');
    now = Date.parse('2026-10-15T07:45:01Z');
    provider.ingest(src.items);
    await market.tick(now);
    expect(auctions[2]).toEqual(['ATC', { FPT: 58_000, SHS: 12_200 }]);
    expect(dayEnds).toBe(0);
    now += 31_000;
    provider.ingest(src.items);
    await market.tick(now);
    expect(dayEnds).toBe(1);
  });

  it('nạp lịch sử thật: thay toàn bộ lịch sử giả lập (kể cả phiên không có ở nguồn), lần sau chỉ tải bù', async () => {
    await db.exec(`INSERT INTO ohlcv_daily (symbol, trade_date, open, high, low, close, volume, value) VALUES
      ('FPT','2026-10-09',90000,91000,89000,90500,1,1), ('FPT','2026-10-13',91000,92000,90000,91500,1,1)`);
    const calls: number[] = [];
    const client = {
      history: async (keys: string[], days: number) => {
        calls.push(days);
        return { bars: Object.fromEntries(keys.filter((k) => HISTORY.bars[k]).map((k) => [k, HISTORY.bars[k]])), errors: {} };
      },
      board: async () => src.board(),
    };
    const r = await syncRealHistory(db, client as never, { mode: 'REAL_HOURS', days: 500, now: AFTER_CLOSE });
    expect(r).toMatchObject({ full: true, stocks: 1, indices: 1, missing: ['ACV', 'SHS'] });
    const fpt = await db.many<{ trade_date: string; close: number }>("SELECT trade_date::text AS trade_date, close FROM ohlcv_daily WHERE symbol = 'FPT' ORDER BY trade_date");
    expect(fpt).toEqual([
      { trade_date: '2026-10-12', close: 57_100 },
      { trade_date: '2026-10-13', close: 56_300 },
      { trade_date: '2026-10-14', close: 57_100 },
    ]);
    expect((await db.one<{ n: number }>("SELECT count(*)::int AS n FROM ohlcv_daily WHERE symbol = 'SHS'"))!.n).toBe(1);
    expect((await db.one<{ close: number }>("SELECT close FROM index_daily WHERE code = 'VNINDEX' AND trade_date = '2026-10-14'"))!.close).toBe(1704.87);
    expect((await db.one<{ listed_shares: number }>("SELECT listed_shares FROM stocks WHERE symbol = 'SHS'"))!.listed_shares).toBe(
      src.get('SHS').listedShares,
    );

    // cùng ngày: không gọi lại nguồn; sang ngày sau: chỉ tải bù vài phiên
    await syncRealHistory(db, client as never, { mode: 'REAL_HOURS', days: 500, now: AFTER_CLOSE });
    const next = await syncRealHistory(db, client as never, { mode: 'REAL_HOURS', days: 500, now: AFTER_CLOSE + 86_400_000 });
    expect(next.full).toBe(false);
    expect(calls).toEqual([500, 6]);
  });
});

describe('MockProvider vẫn chạy như cũ', () => {
  it('MarketService + MockProvider: mô phỏng phần phiên đã qua, nguồn SIM', async () => {
    const db = await Database.open();
    await migrate(db);
    await db.exec(`INSERT INTO stocks (symbol, exchange, name, industry, listed_shares, eps, bvps) VALUES ('FPT','HOSE','FPT','Test',1000000000,1000,10000)`);
    await db.exec(`INSERT INTO ohlcv_daily (symbol, trade_date, open, high, low, close, volume, value) VALUES ('FPT','2026-10-14',98000,99000,97000,98500,1,1)`);
    const market = new MarketService(db, new MockProvider(mulberry32(11)), { mode: 'SIMULATED_24_7', tickIntervalMs: 1000 });
    await market.init(Date.parse('2026-10-15T06:00:00Z'));
    const fpt = market.quote('FPT')!;
    expect(market.session().feed).toBe('SIM');
    expect(fpt.ref).toBe(98_500);
    expect(fpt.volume).toBeGreaterThan(0);
    expect(fpt.bids.length).toBe(3);
    await market.stop();
    await db.close();
  });
});
