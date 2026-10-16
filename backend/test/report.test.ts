import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { calcFee, calcSellTax } from '@vss/shared';
import type { Database } from '../src/db';
import { monthlyReport } from '../src/portfolio/report';
import { createUserAccount } from '../src/seed/seed';
import { noopNotifier, TradingEngine } from '../src/trading/engine';
import { closeTestDb, openTestDb } from './helpers/db';
import { FakeMarket } from './helpers/fakeMarket';

let db: Database;
let userId: string;

beforeEach(async () => {
  db = await openTestDb();
  await db.exec(`INSERT INTO stocks (symbol, exchange, name, industry, listed_shares, eps, bvps) VALUES ('FPT','HOSE','FPT','Test',1000000000,1,1)`);
  userId = (await db.tx((tx) => createUserAccount(tx, 'baocao@example.test', 'x', 'Báo Cáo'))).id;
});
afterEach(() => closeTestDb(db));

describe('Báo cáo lãi lỗ theo tháng', () => {
  it('gộp lãi lỗ đã thực hiện, phí, thuế, cổ tức sau thuế, lãi tiền gửi, chi phí vốn theo tháng giờ VN', async () => {
    const market = new FakeMarket();
    market.add('FPT', 'HOSE', 100_000, [{ p: 101_000, v: 10_000 }], [{ p: 100_000, v: 10_000 }]);
    const engine = new TradingEngine(db, market, noopNotifier, { settlementDays: 0 });
    await engine.load();
    await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 100_000, qty: 1_000 });
    await engine.placeOrder(userId, { symbol: 'FPT', side: 'SELL', orderType: 'LO', price: 101_000, qty: 1_000 });
    // khớp lúc 16:30 UTC ngày 31/10 = 23:30 VN ngày 31/10 → tháng 10; lúc 17:30 UTC = 00:30 VN ngày 1/11 → tháng 11
    await db.many(`UPDATE trades SET executed_at = '2026-10-31T16:30:00Z' WHERE side = 'BUY'`);
    await db.many(`UPDATE trades SET executed_at = '2026-10-31T17:30:00Z' WHERE side = 'SELL'`);
    const ins = (type: string, amount: number, note: string, at: string) =>
      db.many(`INSERT INTO transactions_ledger (user_id, type, amount, balance_after, note, created_at) VALUES ($1,$2,$3,0,$4,$5)`, [userId, type, amount, note, at]);
    await ins('DIVIDEND', 2_000_000, 'Cổ tức FPT', '2026-11-05T03:00:00Z');
    await ins('TAX', -100_000, 'Thuế TNCN 5% cổ tức FPT', '2026-11-05T03:00:00Z');
    await ins('INTEREST', 40_000, 'Lãi tiền gửi', '2026-11-02T03:00:00Z');
    await ins('MARGIN_INTEREST', -15_000, 'Trả lãi vay ký quỹ', '2026-11-10T03:00:00Z');
    await ins('ADVANCE_FEE', -5_000, 'Phí ứng trước', '2026-11-10T03:00:00Z');

    const r = await monthlyReport(db, userId, 2026);
    expect(r.months.map((m) => m.month)).toEqual(['2026-10', '2026-11']);
    const buyFee = calcFee(100_000_000);
    const sellFee = calcFee(101_000_000);
    const tax = calcSellTax(101_000_000);
    const pnl = 101_000_000 - sellFee - tax - (100_000_000 + buyFee);
    expect(r.months[0]).toMatchObject({ tradedValue: 100_000_000, fees: buyFee, realizedPnl: 0, net: 0 });
    expect(r.months[1]).toMatchObject({
      tradedValue: 101_000_000,
      realizedPnl: pnl,
      fees: sellFee,
      sellTax: tax,
      income: 1_900_000,
      depositInterest: 40_000,
      financingCost: 20_000,
      net: pnl + 1_900_000 + 40_000 - 20_000,
    });
    expect(r.total.fees).toBe(buyFee + sellFee);
    expect(r.years).toContain(2026);
    expect((await monthlyReport(db, userId, 2025)).months).toEqual([]);
  });
});
