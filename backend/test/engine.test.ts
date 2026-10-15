import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buyHoldAmount,
  calcFee,
  calcSellTax,
  priceBand,
  type BookLevel,
  type Exchange,
  type MarketMode,
  type SessionPhase,
  type StockInfo,
} from '@vss/shared';
import type { Database } from '../src/db';
import { createUserAccount } from '../src/seed/seed';
import { noopNotifier, TradingEngine, type MarketAccess } from '../src/trading/engine';
import { closeTestDb, openTestDb } from './helpers/db';

interface FakeQuote {
  info: StockInfo;
  ref: number;
  ceil: number;
  floor: number;
  bids: BookLevel[];
  asks: BookLevel[];
}

class FakeMarket implements MarketAccess {
  opts: { mode: MarketMode } = { mode: 'SIMULATED_24_7' };
  tradeDate = '2026-10-15';
  phase: SessionPhase = 'CONTINUOUS';
  stocks = new Map<string, FakeQuote>();
  recorded: { symbol: string; price: number; qty: number }[] = [];

  add(symbol: string, exchange: Exchange, ref: number, bids: BookLevel[], asks: BookLevel[]) {
    const band = priceBand(exchange, ref);
    this.stocks.set(symbol, {
      info: { symbol, exchange, name: symbol, industry: 'Test', listedShares: 1e9, eps: 1000, bvps: 10000, isVn30: false },
      ref,
      ...band,
      bids,
      asks,
    });
  }
  info(s: string) {
    return this.stocks.get(s)?.info;
  }
  quote(s: string) {
    return this.stocks.get(s);
  }
  consumeBook(symbol: string, side: 'BUY' | 'SELL', qty: number, limit: number | null) {
    const q = this.stocks.get(symbol)!;
    const book = side === 'BUY' ? q.asks : q.bids;
    const fills: { price: number; qty: number }[] = [];
    let left = qty;
    for (const l of book) {
      if (left <= 0) break;
      if (limit != null && (side === 'BUY' ? l.p > limit : l.p < limit)) break;
      const take = Math.min(left, l.v);
      fills.push({ price: l.p, qty: take });
      l.v -= take;
      left -= take;
    }
    if (side === 'BUY') q.asks = q.asks.filter((l) => l.v > 0);
    else q.bids = q.bids.filter((l) => l.v > 0);
    return fills;
  }
  recordTrade(symbol: string, price: number, qty: number) {
    this.recorded.push({ symbol, price, qty });
  }
}

const CAPITAL = 1_000_000_000;

let db: Database;
let market: FakeMarket;
let engine: TradingEngine;
let userId: string;

async function account() {
  return (await db.one<{ cash_balance: number; cash_hold: number }>('SELECT cash_balance, cash_hold FROM accounts WHERE user_id = $1', [userId]))!;
}
async function holding(symbol: string) {
  return db.one<{ qty_total: number; qty_available: number; qty_hold: number; qty_pending: number; total_cost: number }>(
    'SELECT * FROM holdings WHERE user_id = $1 AND symbol = $2',
    [userId, symbol],
  );
}

async function setup(settlementDays = 2) {
  db = await openTestDb();
  await db.exec(`INSERT INTO stocks (symbol, exchange, name, industry, listed_shares, eps, bvps) VALUES
    ('FPT','HOSE','FPT','Test',1000000000,1000,10000), ('SHS','HNX','SHS','Test',1000000000,1000,10000), ('ABB','UPCOM','ABB','Test',1000000000,1000,10000)`);
  const user = await db.tx((tx) => createUserAccount(tx, 'test@example.test', 'x', 'Tester'));
  userId = user.id;
  market = new FakeMarket();
  market.add(
    'FPT',
    'HOSE',
    100_000,
    [
      { p: 99_900, v: 1_000 },
      { p: 99_800, v: 2_000 },
      { p: 99_700, v: 5_000 },
    ],
    [
      { p: 100_000, v: 1_000 },
      { p: 100_100, v: 2_000 },
      { p: 100_200, v: 5_000 },
    ],
  );
  market.add('SHS', 'HNX', 13_400, [{ p: 13_300, v: 10_000 }], [{ p: 13_400, v: 10_000 }]);
  market.add('ABB', 'UPCOM', 8_900, [{ p: 8_800, v: 10_000 }], []);
  engine = new TradingEngine(db, market, noopNotifier, { settlementDays });
  await engine.load();
}

describe('TradingEngine', () => {
  beforeEach(() => setup());
  afterEach(() => closeTestDb(db));

  it('lệnh mua LO khớp ngay qua nhiều bước giá, trừ tiền + phí đúng, giải phóng phong toả', async () => {
    const o = await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 100_100, qty: 2_500 });
    expect(o.status).toBe('FILLED');
    expect(o.filledQty).toBe(2_500);
    // 1.000 @ 100.000 + 1.500 @ 100.100
    const v1 = 1_000 * 100_000;
    const v2 = 1_500 * 100_100;
    const cost = v1 + calcFee(v1) + v2 + calcFee(v2);
    expect(o.avgFillPrice).toBe(Math.round((v1 + v2) / 2_500));
    const acct = await account();
    expect(acct.cash_hold).toBe(0);
    expect(acct.cash_balance).toBe(CAPITAL - cost);
    const h = await holding('FPT');
    expect(h).toMatchObject({ qty_total: 2_500, qty_pending: 2_500, qty_available: 0, total_cost: cost });
    expect(market.recorded).toHaveLength(2);
  });

  it('lệnh chờ khớp một phần khi thị trường chạm giá, huỷ phần còn lại trả đủ tiền phong toả', async () => {
    const o = await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 99_500, qty: 3_000 });
    expect(o.status).toBe('PENDING');
    expect((await account()).cash_hold).toBe(buyHoldAmount(99_500, 3_000));

    await engine.onTick(new Set(['FPT']), new Map([['FPT', { price: 99_400, vol: 1_200 }]]));
    const partial = await engine.getOrder(userId, o.id);
    expect(partial.status).toBe('PARTIAL');
    expect(partial.filledQty).toBe(1_200);
    expect(partial.avgFillPrice).toBe(99_500);

    const cancelled = await engine.cancelOrder(userId, o.id);
    expect(cancelled.status).toBe('CANCELLED');
    const acct = await account();
    expect(acct.cash_hold).toBe(0);
    const value = 1_200 * 99_500;
    expect(acct.cash_balance).toBe(CAPITAL - value - calcFee(value));
  });

  it('từ chối khi sức mua không đủ', async () => {
    await expect(engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 99_000, qty: 10_100 })).rejects.toThrow(
      /Sức mua không đủ/,
    );
    expect((await account()).cash_hold).toBe(0);
  });

  it('kiểm tra bước giá, biên độ trần/sàn, lô chẵn và loại lệnh theo sàn', async () => {
    await expect(engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 99_950, qty: 100 })).rejects.toThrow(/bước giá/);
    await expect(engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 107_100, qty: 100 })).rejects.toThrow(/trần/);
    await expect(engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 99_000, qty: 150 })).rejects.toThrow(/lô chẵn/);
    await expect(engine.placeOrder(userId, { symbol: 'ABB', side: 'BUY', orderType: 'MP', qty: 100 })).rejects.toThrow(/không hỗ trợ lệnh MP/);
    await expect(engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'ATO', qty: 100 })).rejects.toThrow(/24\/7/);
  });

  it('T+2: chưa bán được cổ phiếu chờ về; sau thanh toán bán được, tính thuế và lãi/lỗ', async () => {
    await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 100_000, qty: 1_000 });
    await expect(engine.placeOrder(userId, { symbol: 'FPT', side: 'SELL', orderType: 'LO', price: 99_900, qty: 1_000 })).rejects.toThrow(
      /chờ về/,
    );

    market.tradeDate = '2026-10-17';
    await engine.settle();
    expect(await holding('FPT')).toMatchObject({ qty_available: 1_000, qty_pending: 0 });

    const sell = await engine.placeOrder(userId, { symbol: 'FPT', side: 'SELL', orderType: 'LO', price: 99_900, qty: 1_000 });
    expect(sell.status).toBe('FILLED');
    expect(await holding('FPT')).toBeUndefined();

    const buyValue = 100_000_000;
    const sellValue = 99_900_000;
    const trade = await db.one<{ realized_pnl: number; tax: number }>(`SELECT realized_pnl, tax FROM trades WHERE side = 'SELL'`);
    expect(trade!.tax).toBe(calcSellTax(sellValue));
    expect(trade!.realized_pnl).toBe(sellValue - calcFee(sellValue) - calcSellTax(sellValue) - (buyValue + calcFee(buyValue)));
    const acct = await account();
    expect(acct.cash_balance).toBe(CAPITAL + trade!.realized_pnl);
  });

  it('hai lệnh đồng thời vượt sức mua: chỉ một lệnh được chấp nhận', async () => {
    const big = { symbol: 'FPT', side: 'BUY' as const, orderType: 'LO' as const, price: 95_000, qty: 6_000 };
    const results = await Promise.allSettled([engine.placeOrder(userId, big), engine.placeOrder(userId, big)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const acct = await account();
    expect(acct.cash_hold).toBe(buyHoldAmount(95_000, 6_000));
    expect(acct.cash_hold).toBeLessThanOrEqual(acct.cash_balance);
  });

  it('10 lệnh mua song song, mỗi lệnh ~30% sức mua: đúng 3 lệnh được nhận, phong toả khớp tổng', async () => {
    const o = { symbol: 'FPT', side: 'BUY' as const, orderType: 'LO' as const, price: 99_000, qty: 3_000 };
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => engine.placeOrder(userId, o)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    for (const r of results) if (r.status === 'rejected') expect((r.reason as { code?: string }).code).toBe('INSUFFICIENT_CASH');
    expect((await account()).cash_hold).toBe(3 * buyHoldAmount(99_000, 3_000));
  });

  it('lệnh MP quét sổ lệnh, phần dư chuyển thành LO; không có đối ứng thì bị huỷ', async () => {
    const o = await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'MP', qty: 9_000 });
    expect(o.filledQty).toBe(8_000);
    expect(o.status).toBe('PARTIAL');
    expect(o.price).toBe(100_300);

    market.stocks.get('SHS')!.asks = [];
    const holdBefore = (await account()).cash_hold;
    const none = await engine.placeOrder(userId, { symbol: 'SHS', side: 'BUY', orderType: 'MP', qty: 100 });
    expect(none.status).toBe('CANCELLED');
    expect(none.rejectReason).toMatch(/không có khối lượng đối ứng/);
    expect((await account()).cash_hold).toBe(holdBefore);
  });

  it('sửa lệnh mua điều chỉnh tiền phong toả; cuối phiên lệnh hết hiệu lực', async () => {
    const o = await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 99_000, qty: 1_000 });
    const m = await engine.modifyOrder(userId, o.id, { price: 98_500, qty: 2_000 });
    expect(m.price).toBe(98_500);
    expect((await account()).cash_hold).toBe(buyHoldAmount(98_500, 2_000));
    await engine.expireAll();
    expect((await engine.getOrder(userId, o.id)).status).toBe('EXPIRED');
    expect((await account()).cash_hold).toBe(0);
    expect(engine.openOrderCount()).toBe(0);
  });

  it('đặt lại tài khoản xoá lịch sử và trả về vốn ban đầu', async () => {
    await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 100_000, qty: 500 });
    await engine.resetAccount(userId);
    const acct = await account();
    expect(acct).toMatchObject({ cash_balance: CAPITAL, cash_hold: 0 });
    expect(await holding('FPT')).toBeUndefined();
  });
});

describe('Bán ngay khi SETTLEMENT_DAYS=0', () => {
  beforeEach(() => setup(0));
  afterEach(() => closeTestDb(db));

  it('cổ phiếu về ngay, bán được trong cùng phiên', async () => {
    await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 100_000, qty: 1_000 });
    expect(await holding('FPT')).toMatchObject({ qty_available: 1_000, qty_pending: 0 });
    const sell = await engine.placeOrder(userId, { symbol: 'FPT', side: 'SELL', orderType: 'LO', price: 99_900, qty: 1_000 });
    expect(sell.status).toBe('FILLED');
  });
});
