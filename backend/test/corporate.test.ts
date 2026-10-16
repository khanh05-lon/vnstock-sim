import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RULES, roundToTick } from '@vss/shared';
import { CorporateService, adjustedRef, entitledShares } from '../src/corporate/service';
import type { Database } from '../src/db';
import { setHolidays } from '../src/lib/calendar';
import { mulberry32 } from '../src/lib/prng';
import { bondYield, couponDates, warrantFair } from '../src/market/instruments';
import { MarketService } from '../src/market/marketService';
import { MockProvider } from '../src/market/mockProvider';
import { createUserAccount } from '../src/seed/seed';
import { noopNotifier, TradingEngine } from '../src/trading/engine';
import { closeTestDb, openTestDb } from './helpers/db';

const DAY1 = Date.parse('2026-10-15T03:00:00Z'); // 10:00 giờ VN
const day = (n: number) => DAY1 + n * 86400_000;

let db: Database;
let market: MarketService;
let engine: TradingEngine;
let corp: CorporateService;
let userId: string;

const cash = async () => (await db.one<{ cash_balance: number }>('SELECT cash_balance FROM accounts WHERE user_id = $1', [userId]))!.cash_balance;
const holding = (symbol: string) => db.one<{ qty_total: number; qty_available: number; total_cost: number }>('SELECT * FROM holdings WHERE user_id = $1 AND symbol = $2', [userId, symbol]);
const ledger = () => db.many<{ type: string; amount: number }>('SELECT type, amount FROM transactions_ledger WHERE user_id = $1 ORDER BY id', [userId]);

async function nextDay(n: number) {
  await market.tick(day(n));
  await corp.processDay();
}

beforeEach(async () => {
  setHolidays([]);
  db = await openTestDb();
  await db.exec(`INSERT INTO stocks (symbol, exchange, name, industry, listed_shares, eps, bvps, is_vn30) VALUES
    ('FPT','HOSE','FPT','Công nghệ',1000000000,5000,20000,true), ('VNM','HOSE','VNM','Thực phẩm',2000000000,4000,15000,true)`);
  await db.exec(`INSERT INTO ohlcv_daily (symbol, trade_date, open, high, low, close, volume, value) VALUES
    ('FPT','2026-10-13',99000,99000,99000,99000,1,1), ('FPT','2026-10-14',100000,100000,100000,100000,1,1),
    ('VNM','2026-10-14',60000,60000,60000,60000,1,1)`);
  market = new MarketService(db, new MockProvider(mulberry32(3)), { mode: 'SIMULATED_24_7', tickIntervalMs: 1000 });
  await market.init(DAY1);
  engine = new TradingEngine(db, market, noopNotifier, { settlementDays: 0 });
  await engine.load();
  corp = new CorporateService(db, market, engine, null);
  userId = (await db.tx((tx) => createUserAccount(tx, 'ndt@example.test', 'x', 'Nhà đầu tư'))).id;
  await db.many(`INSERT INTO holdings (user_id, symbol, qty_total, qty_available, total_cost) VALUES ($1,'FPT',1000,1000,100000000)`, [userId]);
});
afterEach(() => closeTestDb(db));

describe('Công thức sự kiện quyền', () => {
  it('giá tham chiếu điều chỉnh và số cổ phiếu được nhận', () => {
    expect(adjustedRef({ type: 'CASH_DIVIDEND', cash_per_share: 2_000, ratio_from: null, ratio_to: null, issue_price: null }, 100_000)).toBe(98_000);
    expect(adjustedRef({ type: 'STOCK_DIVIDEND', cash_per_share: null, ratio_from: 10, ratio_to: 2, issue_price: null }, 60_000)).toBe(50_000);
    expect(adjustedRef({ type: 'SPLIT', cash_per_share: null, ratio_from: 1, ratio_to: 2, issue_price: null }, 100_000)).toBe(50_000);
    expect(adjustedRef({ type: 'RIGHTS', cash_per_share: null, ratio_from: 4, ratio_to: 1, issue_price: 10_000 }, 60_000)).toBe(50_000);
    expect(entitledShares({ type: 'STOCK_DIVIDEND', ratio_from: 10, ratio_to: 2 }, 1_005)).toBe(201);
    expect(entitledShares({ type: 'SPLIT', ratio_from: 1, ratio_to: 2 }, 1_000)).toBe(1_000);
    expect(entitledShares({ type: 'RIGHTS', ratio_from: 4, ratio_to: 1 }, 1_003)).toBe(250);
  });

  it('chứng quyền theo Black–Scholes; lợi suất trái phiếu; lịch trả lãi', () => {
    const w = { exercisePrice: 80_000, ratio: 2, maturityDate: '2026-10-25' };
    // sâu trong tiền, sắp đáo hạn → ≈ giá trị nội tại (100.000 − 80.000) / 2
    expect(warrantFair(100_000, w, '2026-10-15', 0.02)).toBeGreaterThan(9_900);
    expect(warrantFair(100_000, w, '2026-10-15', 0.02)).toBeLessThan(10_300);
    expect(warrantFair(50_000, w, '2026-10-15', 0.02)).toBeLessThan(50);
    const b = { parValue: 100_000, couponRate: 0.08, couponFreq: 2, maturityDate: '2029-10-15' };
    expect(bondYield(100_000, b, '2026-10-15')).toBeCloseTo(0.08, 2);
    expect(bondYield(95_000, b, '2026-10-15')).toBeGreaterThan(0.09);
    expect(couponDates({ issueDate: '2024-03-15', maturityDate: '2025-09-15', couponFreq: 2 })).toEqual(['2024-09-15', '2025-03-15', '2025-09-15']);
  });
});

describe('Xử lý sự kiện quyền', () => {
  it('cổ tức tiền: chỉ tạo được cho ngày tương lai; GDKHQ điều chỉnh giá + lịch sử; thanh toán trừ 5% thuế', async () => {
    await expect(corp.create({ symbol: 'FPT', type: 'CASH_DIVIDEND', exDate: '2026-10-15', payDate: '2026-10-20', cashPerShare: 2_000 }, 'qtv')).rejects.toThrow(/sau ngày giao dịch/);
    const a = await corp.create({ symbol: 'FPT', type: 'CASH_DIVIDEND', exDate: '2026-10-16', payDate: '2026-10-17', cashPerShare: 2_000 }, 'qtv');
    expect(a.status).toBe('ANNOUNCED');
    const resting = await engine.placeOrder(userId, { symbol: 'FPT', side: 'SELL', orderType: 'LO', price: market.quote('FPT')!.ceil, qty: 100, validUntil: '2026-10-20' });

    await nextDay(1);
    const refBefore = (await db.one<{ ref_before: number; ref_after: number; status: string }>('SELECT * FROM corporate_actions WHERE id = $1', [a.id]))!;
    expect(refBefore.status).toBe('EX_DONE');
    expect(refBefore.ref_after).toBe(roundToTick('HOSE', refBefore.ref_before - 2_000));
    expect(market.quote('FPT')!.ref).toBe(refBefore.ref_after);
    // lịch sử giá điều chỉnh theo hệ số (P − D) / P
    const old = await db.one<{ close: number }>(`SELECT close FROM ohlcv_daily WHERE symbol = 'FPT' AND trade_date = '2026-10-14'`);
    expect(old!.close).toBe(Math.round((100_000 * refBefore.ref_after) / refBefore.ref_before));
    // lệnh nhiều ngày của mã bị huỷ trong ngày GDKHQ
    expect((await engine.getOrder(userId, resting.id)).status).toBe('CANCELLED');
    const [ent] = await corp.entitlements(userId);
    expect(ent).toMatchObject({ qtyHeld: 1_000, cashAmount: 2_000_000, taxAmount: 2_000_000 * RULES.dividendTaxRate, status: 'PENDING' });
    expect((await corp.rightsValue([userId])).get(userId)).toBe(1_900_000);

    const before = await cash();
    await nextDay(2);
    expect((await cash()) - before).toBe(1_900_000);
    expect((await ledger()).slice(-2)).toEqual([
      { type: 'DIVIDEND', amount: 2_000_000 },
      { type: 'TAX', amount: -100_000 },
    ]);
    expect((await corp.entitlements(userId))[0].status).toBe('PAID');
  });

  it('chia tách 1:2: giá tham chiếu giảm một nửa, KL niêm yết gấp đôi, cổ phiếu về tài khoản ngày thanh toán, giá vốn giữ nguyên', async () => {
    const a = await corp.create({ symbol: 'FPT', type: 'SPLIT', exDate: '2026-10-16', payDate: '2026-10-16', ratioFrom: 1, ratioTo: 2 }, 'qtv');
    await nextDay(1);
    const row = (await db.one<{ ref_before: number; ref_after: number }>('SELECT ref_before, ref_after FROM corporate_actions WHERE id = $1', [a.id]))!;
    expect(row.ref_after).toBe(roundToTick('HOSE', row.ref_before / 2));
    expect(market.quote('FPT')!.ref).toBe(row.ref_after);
    expect(market.info('FPT')!.listedShares).toBe(2_000_000_000);
    expect(await holding('FPT')).toMatchObject({ qty_total: 2_000, qty_available: 2_000, total_cost: 100_000_000 });
  });

  it('quyền mua: đăng ký trong hạn trừ tiền ngay, cổ phiếu về ngày phát hành cộng giá vốn; vượt quyền bị từ chối', async () => {
    const a = await corp.create(
      { symbol: 'FPT', type: 'RIGHTS', exDate: '2026-10-16', payDate: '2026-10-19', ratioFrom: 4, ratioTo: 1, issuePrice: 10_000, subscribeUntil: '2026-10-18' },
      'qtv',
    );
    await nextDay(1);
    await expect(corp.subscribe(userId, a.id, 300)).rejects.toThrow(/tối đa 250/);
    const before = await cash();
    await corp.subscribe(userId, a.id, 200);
    expect(before - (await cash())).toBe(2_000_000);
    await nextDay(4);
    expect(await holding('FPT')).toMatchObject({ qty_total: 1_200, total_cost: 102_000_000 });
  });

  it('chứng quyền đáo hạn: trả tiền theo giá cơ sở bình quân 5 phiên, rút mã khỏi bảng giá', async () => {
    await db.exec(`INSERT INTO stocks (symbol, exchange, type, name, industry, listed_shares, eps, bvps) VALUES ('CFPT2601','HOSE','CW','CW FPT','Chứng quyền',10000000,0,0)`);
    await db.exec(`INSERT INTO warrants (symbol, underlying, issuer, ratio, exercise_price, maturity_date, last_trading_date) VALUES ('CFPT2601','FPT','CTCK',2,90000,'2026-10-16','2026-10-14')`);
    await db.exec(`INSERT INTO ohlcv_daily (symbol, trade_date, open, high, low, close, volume, value) VALUES ('CFPT2601','2026-10-14',5000,5000,5000,5000,1,1)`);
    await db.many(`INSERT INTO holdings (user_id, symbol, qty_total, qty_available, total_cost) VALUES ($1,'CFPT2601',1000,1000,5000000)`, [userId]);
    // khởi động lại thị trường để nạp mã chứng quyền
    market = new MarketService(db, new MockProvider(mulberry32(4)), { mode: 'SIMULATED_24_7', tickIntervalMs: 1000 });
    await market.init(DAY1);
    engine = new TradingEngine(db, market, noopNotifier, { settlementDays: 0 });
    corp = new CorporateService(db, market, engine, null);
    expect(market.info('CFPT2601')!.warrant?.underlying).toBe('FPT');
    await expect(engine.placeOrder(userId, { symbol: 'CFPT2601', side: 'SELL', orderType: 'LO', price: 5_000, qty: 100 })).rejects.toThrow(/ngày giao dịch cuối cùng/);

    await nextDay(1);
    // giá cơ sở bình quân các phiên trước đáo hạn: 99.000, 100.000 và phiên 15/10 vừa chốt
    const avgRows = await db.many<{ close: number }>(`SELECT close FROM ohlcv_daily WHERE symbol = 'FPT' AND trade_date < '2026-10-16' ORDER BY trade_date DESC LIMIT 5`);
    const avg = avgRows.reduce((s, r) => s + Number(r.close), 0) / avgRows.length;
    const payout = Math.floor((avg - 90_000) / 2);
    expect(await holding('CFPT2601')).toBeUndefined();
    const l = (await ledger()).filter((x) => x.type === 'CW_SETTLE');
    expect(l).toEqual([{ type: 'CW_SETTLE', amount: 1_000 * payout }]);
    expect(market.quote('CFPT2601')).toBeUndefined();
  });

  it('trái phiếu: trả lãi coupon (trừ thuế) khi tới kỳ, đáo hạn trả mệnh giá', async () => {
    await db.exec(`INSERT INTO stocks (symbol, exchange, type, name, industry, listed_shares, eps, bvps) VALUES ('TPTEST01','HNX','BOND','TP thử','Trái phiếu',1000000,0,100000)`);
    await db.exec(`INSERT INTO bonds (symbol, issuer, par_value, coupon_rate, coupon_freq, issue_date, maturity_date, last_coupon_date)
                   VALUES ('TPTEST01','Thử',100000,0.08,2,'2025-10-16','2026-10-16','2026-04-16')`);
    await db.exec(`INSERT INTO ohlcv_daily (symbol, trade_date, open, high, low, close, volume, value) VALUES ('TPTEST01','2026-10-14',100000,100000,100000,100000,1,1)`);
    await db.many(`INSERT INTO holdings (user_id, symbol, qty_total, qty_available, total_cost) VALUES ($1,'TPTEST01',500,500,50000000)`, [userId]);
    market = new MarketService(db, new MockProvider(mulberry32(5)), { mode: 'SIMULATED_24_7', tickIntervalMs: 1000 });
    await market.init(DAY1);
    engine = new TradingEngine(db, market, noopNotifier, { settlementDays: 0 });
    corp = new CorporateService(db, market, engine, null);
    expect(market.info('TPTEST01')!.bond?.couponRate).toBeCloseTo(0.08);

    await nextDay(1);
    const l = await ledger();
    expect(l.filter((x) => x.type === 'COUPON')).toEqual([{ type: 'COUPON', amount: 500 * 4_000 }]);
    expect(l.filter((x) => x.type === 'BOND_REDEEM')).toEqual([{ type: 'BOND_REDEEM', amount: 500 * 100_000 }]);
    expect(await holding('TPTEST01')).toBeUndefined();
  });
});
