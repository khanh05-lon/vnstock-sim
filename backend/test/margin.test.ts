import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RULES, buyHoldAmount, calcFee, calcSellTax } from '@vss/shared';
import { CorporateService } from '../src/corporate/service';
import type { Database } from '../src/db';
import type { MarketService } from '../src/market/marketService';
import { createUserAccount } from '../src/seed/seed';
import { advanceCash, marginMetrics, previewAdvance } from '../src/trading/cash';
import { noopNotifier, TradingEngine } from '../src/trading/engine';
import { MarginService } from '../src/trading/margin';
import { closeTestDb, openTestDb } from './helpers/db';
import { FakeMarket } from './helpers/fakeMarket';

let db: Database;
let market: FakeMarket;
let engine: TradingEngine;
let margin: MarginService;
let userId: string;
const events: { status: string }[] = [];

type Acct = { cash_balance: number; cash_hold: number; cash_pending: number; loan_balance: number; loan_interest: number; loan_hold: number; margin_status: string };
const acct = async () => (await db.one<Acct>('SELECT * FROM accounts WHERE user_id = $1', [userId]))!;
const ledgerTypes = async () => (await db.many<{ type: string; amount: number }>('SELECT type, amount FROM transactions_ledger WHERE user_id = $1 ORDER BY id', [userId])).map((x) => x.type);

beforeEach(async () => {
  db = await openTestDb();
  await db.exec(`INSERT INTO stocks (symbol, exchange, name, industry, listed_shares, eps, bvps, margin_ratio) VALUES
    ('FPT','HOSE','FPT','Test',1000000000,1,1,0.5), ('ACV','UPCOM','ACV','Test',1000000000,1,1,0)`);
  userId = (await db.tx((tx) => createUserAccount(tx, 'ndt@example.test', 'x', 'Nhà đầu tư'))).id;
  market = new FakeMarket();
  market.add('FPT', 'HOSE', 100_000, [{ p: 99_900, v: 1_000_000 }], [{ p: 100_000, v: 1_000_000 }], { marginRatio: 0.5 });
  market.add('ACV', 'UPCOM', 50_000, [{ p: 49_900, v: 1_000_000 }], [{ p: 50_000, v: 1_000_000 }]);
  engine = new TradingEngine(db, market, noopNotifier, { settlementDays: 2 });
  await engine.load();
  margin = new MarginService(db, market, engine);
  events.length = 0;
  margin.notify = (_u, e) => void events.push(e);
});
afterEach(() => closeTestDb(db));

/** Mua 1.000 FPT giá 100.000 rồi cho cổ phiếu về (T+2) */
async function ownFpt() {
  await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 100_000, qty: 1_000 });
  market.tradeDate = '2026-10-17';
  await engine.settle();
}

describe('Tiền bán chờ về & ứng trước', () => {
  it('bán xong tiền chờ về; ứng trước có phí theo số ngày; phần còn lại về tài khoản ngày T+2', async () => {
    await ownFpt();
    const before = (await acct()).cash_balance;
    await engine.placeOrder(userId, { symbol: 'FPT', side: 'SELL', orderType: 'LO', price: 99_900, qty: 1_000 });
    const net = 99_900_000 - calcFee(99_900_000) - calcSellTax(99_900_000);
    expect(await acct()).toMatchObject({ cash_balance: before, cash_pending: net });

    const p = await previewAdvance(db, userId, market.tradeDate);
    expect(p.items[0].days).toBe(2);
    expect(p.fee).toBe(Math.round(net * RULES.advanceFeeRateDaily * 2));
    const r = await db.tx((tx) => advanceCash(tx, userId, 50_000_000, market.tradeDate));
    expect(r.net).toBeGreaterThanOrEqual(50_000_000);
    expect(r.fee).toBe(Math.round(r.gross * RULES.advanceFeeRateDaily * 2));
    expect(await acct()).toMatchObject({ cash_balance: before + r.net, cash_pending: net - r.gross });
    expect((await ledgerTypes()).slice(-2)).toEqual(['ADVANCE', 'ADVANCE_FEE']);

    market.tradeDate = '2026-10-19';
    await engine.settle();
    expect(await acct()).toMatchObject({ cash_balance: before + r.net + (net - r.gross), cash_pending: 0 });
  });

  it('mua vượt tiền mặt: tự ứng trước tiền bán chờ về; tắt tự ứng thì báo không đủ sức mua', async () => {
    await ownFpt();
    await engine.placeOrder(userId, { symbol: 'FPT', side: 'SELL', orderType: 'LO', price: 99_900, qty: 1_000 });
    const a = await acct();
    const avail = a.cash_balance - a.cash_hold;
    // mua lượng cần nhiều hơn tiền mặt khoảng 50 triệu
    const qty = Math.ceil((avail + 50_000_000) / 100_000 / 100) * 100;
    await db.many('UPDATE accounts SET auto_advance = false WHERE user_id = $1', [userId]);
    await expect(engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 99_000, qty })).rejects.toThrow(/Sức mua không đủ/);
    await db.many('UPDATE accounts SET auto_advance = true WHERE user_id = $1', [userId]);
    const o = await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 99_000, qty });
    expect(o.status).toBe('PENDING');
    expect(await ledgerTypes()).toContain('ADVANCE');
    const after = await acct();
    expect(after.cash_hold).toBe(buyHoldAmount(99_000, qty));
    expect(after.cash_hold).toBeLessThanOrEqual(after.cash_balance);
  });
});

describe('Giao dịch ký quỹ', () => {
  beforeEach(async () => {
    // tài khoản 100 triệu, kích hoạt ký quỹ hạn mức mặc định
    await db.many('UPDATE accounts SET cash_balance = 100000000 WHERE user_id = $1', [userId]);
    await margin.setEnabled(userId, true);
  });

  it('mua bằng tiền vay trong tỷ lệ cho vay của mã; vượt tỷ lệ / mã không cho vay bị từ chối', async () => {
    await expect(engine.placeOrder(userId, { symbol: 'ACV', side: 'BUY', orderType: 'LO', price: 50_000, qty: 3_000 })).rejects.toThrow(/không cho vay/);
    await expect(engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 100_000, qty: 2_100 })).rejects.toThrow(/Sức mua không đủ|tỷ lệ ký quỹ/);
    const o = await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 100_000, qty: 1_800 });
    expect(o.status).toBe('FILLED');
    const cost = 180_000_000 + calcFee(180_000_000);
    const a = await acct();
    expect(a).toMatchObject({ cash_balance: 0, loan_balance: cost - 100_000_000, loan_hold: 0, cash_hold: 0 });
    expect(await ledgerTypes()).toContain('LOAN');
    const bp = await margin.buyingPower(userId, 'FPT', 100_000);
    expect(bp.maxQty).toBeGreaterThanOrEqual(0);
  });

  it('lãi vay cộng dồn theo ngày; tỷ lệ ký quỹ giảm → cảnh báo; dưới ngưỡng xử lý → bán giải chấp', async () => {
    await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 100_000, qty: 1_800 });
    market.tradeDate = '2026-10-17';
    await engine.settle();
    const loan = (await acct()).loan_balance;
    await db.many(`UPDATE accounts SET last_interest_date = '2026-10-16' WHERE user_id = $1`, [userId]);
    await margin.accrueInterest('2026-10-17');
    expect((await acct()).loan_interest).toBe(Math.round((loan * RULES.margin.interestRateYear) / 365));

    // giá giảm 20% → tỷ lệ ≈ (144 − 80,3) / 144 ≈ 44%? chưa tới call; giảm 25% → ≈ 40,4%; giảm 30% → dưới 40% (call)
    market.trade('FPT', 70_000);
    await margin.check();
    expect((await acct()).margin_status).toBe('CALL');
    expect(events.at(-1)!.status).toBe('CALL');
    const m = marginMetrics(await acct(), 1_800 * 70_000);
    expect(m.ratio).toBeLessThan(RULES.margin.callRatio);

    market.trade('FPT', 62_000);
    const r = await margin.check();
    expect(r.forced).toBe(1);
    const forced = await db.many<{ side: string; source: string; qty: number }>(`SELECT side, source, qty FROM orders WHERE source = 'FORCE_SELL'`);
    expect(forced.length).toBeGreaterThan(0);
    expect(forced[0].side).toBe('SELL');
  });

  it('tiền bán về tự trả nợ (lãi trước, gốc sau); trả nợ chủ động; tắt ký quỹ khi còn nợ bị từ chối', async () => {
    await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 100_000, qty: 1_500 });
    market.tradeDate = '2026-10-17';
    await engine.settle();
    await expect(margin.setEnabled(userId, false)).rejects.toThrow(/trả hết nợ/);
    await engine.placeOrder(userId, { symbol: 'FPT', side: 'SELL', orderType: 'LO', price: 99_900, qty: 1_000 });
    market.tradeDate = '2026-10-19';
    await engine.settle();
    const a = await acct();
    expect(a.loan_balance).toBe(0);
    expect(await ledgerTypes()).toContain('LOAN_REPAY');
    await margin.setEnabled(userId, false);
  });

  it('cổ tức tiền và lãi tiền gửi về tài khoản cũng tự trả nợ ký quỹ', async () => {
    await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 100_000, qty: 1_500 });
    const loan = (await acct()).loan_balance;
    expect(loan).toBeGreaterThan(0);
    // sự kiện cổ tức 2.000đ/CP đã qua GDKHQ, tới ngày thanh toán
    const [ca] = await db.many<{ id: number }>(
      `INSERT INTO corporate_actions (symbol, type, ex_date, record_date, pay_date, cash_per_share, status)
       VALUES ('FPT','CASH_DIVIDEND','2026-10-16','2026-10-17','2026-10-20',2000,'EX_DONE') RETURNING id`,
    );
    await db.many('INSERT INTO ca_entitlements (action_id, user_id, qty_held, cash_amount, tax_amount) VALUES ($1,$2,1500,3000000,150000)', [ca.id, userId]);
    const corp = new CorporateService(db, market as unknown as MarketService, engine, null);
    await corp.processPayDates('2026-10-20');
    const a = await acct();
    expect(a.cash_balance).toBe(0);
    expect(a.loan_balance).toBe(loan - 2_850_000);
    expect((await ledgerTypes()).slice(-3)).toEqual(['DIVIDEND', 'TAX', 'LOAN_REPAY']);

    // lãi tiền gửi trả đầu tháng cũng trả nợ: hết lãi vay (gồm lãi 2 ngày vừa cộng) rồi tới gốc
    await db.many(`UPDATE accounts SET deposit_interest_accrued = 50000, loan_interest = 3000, last_interest_date = '2026-10-31' WHERE user_id = $1`, [userId]);
    await margin.accrueInterest('2026-11-02');
    const accrued = Math.round((a.loan_balance * RULES.margin.interestRateYear * 2) / 365);
    const b = await acct();
    expect(b.cash_balance).toBe(0);
    expect(b.loan_interest).toBe(0);
    expect(b.loan_balance).toBe(a.loan_balance - (50_000 - 3_000 - accrued));
  });
});

describe('Lãi tiền gửi', () => {
  it('cộng dồn hằng ngày trên tiền nhàn rỗi, trả vào đầu tháng mới', async () => {
    await db.many(`UPDATE accounts SET last_interest_date = '2026-10-30' WHERE user_id = $1`, [userId]);
    await margin.accrueInterest('2026-10-31');
    const daily = Math.round((1_000_000_000 * RULES.depositRateYear) / 365);
    expect((await db.one<{ deposit_interest_accrued: number }>('SELECT deposit_interest_accrued FROM accounts WHERE user_id = $1', [userId]))!.deposit_interest_accrued).toBe(daily);
    await margin.accrueInterest('2026-11-02');
    expect(await ledgerTypes()).toContain('INTEREST');
    expect((await acct()).cash_balance).toBe(1_000_000_000 + daily);
  });
});
