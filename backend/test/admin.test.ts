import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { priceBand, type BookLevel, type MarketMode, type SessionPhase, type StockInfo } from '@vss/shared';
import { AdminStore } from '../src/admin/store';
import type { Database } from '../src/db';
import { addTradingDays, currentTradeDate, phaseAt, prevTradingDay, setHolidays, vnTimeToMs } from '../src/lib/calendar';
import { createUserAccount } from '../src/seed/seed';
import { noopNotifier, TradingEngine, type MarketAccess } from '../src/trading/engine';
import { closeTestDb, openTestDb } from './helpers/db';

/** Thị trường giả tối giản: 1 mã HOSE, sổ lệnh cố định */
class FakeMarket implements MarketAccess {
  opts: { mode: MarketMode } = { mode: 'SIMULATED_24_7' };
  tradeDate = '2026-10-15';
  phase: SessionPhase = 'CONTINUOUS';
  q = {
    info: { symbol: 'FPT', exchange: 'HOSE', type: 'STOCK', name: 'FPT', industry: 'Test', listedShares: 1e9, eps: 1, bvps: 1, isVn30: true, marginRatio: 0.5 } as StockInfo,
    ref: 100_000,
    ...priceBand('HOSE', 100_000),
    bids: [{ p: 99_900, v: 10_000 }] as BookLevel[],
    asks: [{ p: 100_000, v: 10_000 }] as BookLevel[],
  };
  info(s: string) {
    return s === 'FPT' ? this.q.info : undefined;
  }
  quote(s: string) {
    return s === 'FPT' ? this.q : undefined;
  }
  consumeBook(_s: string, side: 'BUY' | 'SELL', qty: number, limit: number | null) {
    const l = side === 'BUY' ? this.q.asks[0] : this.q.bids[0];
    if (!l || (limit != null && (side === 'BUY' ? l.p > limit : l.p < limit))) return [];
    const take = Math.min(qty, l.v);
    l.v -= take;
    return [{ price: l.p, qty: take }];
  }
  recordTrade() {}
}

let db: Database;
let market: FakeMarket;
let engine: TradingEngine;
let userId: string;

beforeEach(async () => {
  db = await openTestDb();
  await db.exec(`INSERT INTO stocks (symbol, exchange, name, industry, listed_shares, eps, bvps) VALUES ('FPT','HOSE','FPT','Test',1000000000,1,1)`);
  userId = (await db.tx((tx) => createUserAccount(tx, 'nhadautu@example.test', 'x', 'Nhà đầu tư'))).id;
  market = new FakeMarket();
  engine = new TradingEngine(db, market, noopNotifier, { settlementDays: 2 });
  await engine.load();
});
afterEach(() => closeTestDb(db));

describe('Vận hành: tạm ngừng giao dịch', () => {
  it('tạm ngừng toàn hệ thống chặn đặt lệnh và chặn khớp lệnh chờ; mở lại thì giao dịch bình thường', async () => {
    const store = new AdminStore(db, engine);
    const resting = await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 99_000, qty: 100 });
    await store.setHalt(true, 'Bảo trì');
    await expect(engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 100_000, qty: 100 })).rejects.toThrow(
      /tạm ngừng nhận lệnh: Bảo trì/,
    );
    // giá thị trường chạm giá đặt nhưng không được khớp khi đang tạm ngừng
    await engine.onTick(new Set(['FPT']), new Map([['FPT', { price: 98_900, vol: 500 }]]));
    expect((await engine.getOrder(userId, resting.id)).status).toBe('PENDING');
    // huỷ lệnh vẫn được phép
    await engine.cancelOrder(userId, resting.id);

    await store.setHalt(false, '');
    const ok = await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 100_000, qty: 100 });
    expect(ok.status).toBe('FILLED');
  });

  it('tạm ngừng theo mã và cấu hình được nạp lại sau khi khởi động lại', async () => {
    const store = new AdminStore(db, engine);
    await store.setSymbolHalt('FPT', true);
    await store.setAnnouncement({ text: 'Bảo trì 22:00', level: 'warning', updatedAt: '2026-10-15T15:00:00Z' });
    await expect(engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 100_000, qty: 100 })).rejects.toThrow(/FPT đang bị tạm ngừng/);

    // "khởi động lại": engine + store mới đọc lại từ CSDL
    const engine2 = new TradingEngine(db, market, noopNotifier, { settlementDays: 2 });
    const store2 = new AdminStore(db, engine2);
    await store2.load();
    expect(store2.status()).toMatchObject({ haltedSymbols: ['FPT'], tradingHalted: false, announcement: { text: 'Bảo trì 22:00', level: 'warning' } });
  });
});

describe('Quản trị: huỷ lệnh hộ và khoá tài khoản', () => {
  it('huỷ hộ ghi lý do vào lệnh và trả lại tiền phong toả', async () => {
    const o = await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 99_000, qty: 1_000 });
    const c = await engine.adminCancel(o.id, 'Quản trị viên huỷ: lệnh bất thường');
    expect(c.status).toBe('CANCELLED');
    expect(c.rejectReason).toBe('Quản trị viên huỷ: lệnh bất thường');
    const acct = await db.one<{ cash_hold: number }>('SELECT cash_hold FROM accounts WHERE user_id = $1', [userId]);
    expect(acct!.cash_hold).toBe(0);
    await expect(engine.adminCancel(o.id, 'lần 2')).rejects.toThrow(/đã khớp hết hoặc đã bị huỷ/);
  });

  it('khoá tài khoản huỷ mọi lệnh đang chờ và trạng thái khoá được nạp lại', async () => {
    await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 99_000, qty: 100 });
    await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 98_000, qty: 100 });
    expect(await engine.cancelAllForUser(userId, 'Tài khoản bị khoá')).toBe(2);
    expect(engine.openOrderCount()).toBe(0);

    await db.many(`UPDATE users SET status = 'LOCKED' WHERE id = $1`, [userId]);
    const store = new AdminStore(db, engine);
    await store.load();
    expect(store.locked.has(userId)).toBe(true);
  });
});

describe('Lịch giao dịch có ngày nghỉ lễ', () => {
  // danh sách ngày lễ là trạng thái chung của module (AdminStore.load ở test khác đã nạp ngày lễ mẫu)
  beforeEach(() => setHolidays([]));
  afterEach(() => setHolidays([]));

  it('ngày lễ đóng cửa ở chế độ giờ thật và không tính vào T+2', () => {
    // Thứ Năm 31/12/2026 → T+2 bình thường là Thứ Hai 04/01/2027; nghỉ Thứ Sáu 01/01/2027 → Thứ Ba 05/01/2027
    expect(addTradingDays('2026-12-31', 2, true)).toBe('2027-01-04');
    setHolidays(['2027-01-01']);
    expect(addTradingDays('2026-12-31', 2, true)).toBe('2027-01-05');
    expect(prevTradingDay('2027-01-04', true)).toBe('2026-12-31');

    const tenAm = vnTimeToMs('2027-01-01', 10 * 60);
    expect(phaseAt(tenAm, 'REAL_HOURS')).toBe('CLOSED');
    expect(currentTradeDate(tenAm, 'REAL_HOURS')).toBe('2026-12-31');
    // chế độ mô phỏng 24/7 bỏ qua ngày lễ
    expect(phaseAt(tenAm, 'SIMULATED_24_7')).toBe('CONTINUOUS');
    expect(addTradingDays('2026-12-31', 2, false)).toBe('2027-01-02');
  });
});
