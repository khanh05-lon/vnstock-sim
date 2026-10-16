import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConditionalOrderDTO } from '@vss/shared';
import type { Database } from '../src/db';
import { createUserAccount } from '../src/seed/seed';
import { ConditionalEngine } from '../src/trading/conditional';
import { noopNotifier, TradingEngine } from '../src/trading/engine';
import { closeTestDb, openTestDb } from './helpers/db';
import { FakeMarket } from './helpers/fakeMarket';

let db: Database;
let market: FakeMarket;
let engine: TradingEngine;
let cond: ConditionalEngine;
let userId: string;
const events: ConditionalOrderDTO[] = [];

const holding = async (symbol: string) =>
  db.one<{ qty_total: number; qty_available: number; qty_hold: number }>('SELECT * FROM holdings WHERE user_id = $1 AND symbol = $2', [userId, symbol]);
const cash = async () => (await db.one<{ cash_balance: number; cash_hold: number }>('SELECT cash_balance, cash_hold FROM accounts WHERE user_id = $1', [userId]))!;

beforeEach(async () => {
  db = await openTestDb();
  await db.exec(`INSERT INTO stocks (symbol, exchange, name, industry, listed_shares, eps, bvps) VALUES
    ('FPT','HOSE','FPT','Test',1000000000,1,1), ('ACV','UPCOM','ACV','Test',1000000000,1,1)`);
  userId = (await db.tx((tx) => createUserAccount(tx, 'ndt@example.test', 'x', 'Nhà đầu tư'))).id;
  market = new FakeMarket();
  market.add('FPT', 'HOSE', 100_000, [{ p: 99_900, v: 50_000 }], [{ p: 100_000, v: 50_000 }]);
  market.add('ACV', 'UPCOM', 50_000, [{ p: 49_900, v: 50_000 }], [{ p: 50_000, v: 50_000 }]);
  engine = new TradingEngine(db, market, noopNotifier, { settlementDays: 0 });
  await engine.load();
  cond = new ConditionalEngine(db, market, engine);
  events.length = 0;
  cond.notify = (_u, d) => void events.push(d);
  await cond.load();
});
afterEach(() => closeTestDb(db));

describe('Lô lẻ', () => {
  it('đặt 1–99 CP chỉ bằng lệnh LO; khớp ở giá chào tốt nhất mà không ăn sổ lệnh lô chẵn, không đổi giá thị trường', async () => {
    await expect(engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'MP', qty: 50 })).rejects.toThrow(/chỉ đặt được lệnh LO/);
    await expect(engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 100_000, qty: 150 })).rejects.toThrow(/lô lẻ/);
    const o = await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 100_500, qty: 37 });
    expect(o).toMatchObject({ status: 'FILLED', avgFillPrice: 100_000, filledQty: 37 });
    expect(market.quote('FPT')!.asks[0].v).toBe(50_000);
    expect(market.recorded).toHaveLength(0);
    expect(await holding('FPT')).toMatchObject({ qty_total: 37, qty_available: 37 });
    // bán lẻ 37 CP
    const s = await engine.placeOrder(userId, { symbol: 'FPT', side: 'SELL', orderType: 'LO', price: 99_900, qty: 37 });
    expect(s.status).toBe('FILLED');
  });

  it('lệnh lẻ chờ khớp khi giá thị trường chạm giá đặt; không tham gia phiên định kỳ', async () => {
    const o = await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 98_000, qty: 20 });
    expect(o.status).toBe('PENDING');
    await engine.onAuction('ATC', new Map([['FPT', 97_000]]));
    expect((await engine.getOrder(userId, o.id)).status).toBe('PENDING');
    await engine.onTick(new Set(['FPT']), new Map([['FPT', { price: 98_000, vol: 500 }]]));
    expect(await engine.getOrder(userId, o.id)).toMatchObject({ status: 'FILLED', avgFillPrice: 98_000 });
  });
});

describe('Lệnh nhiều ngày (GTD)', () => {
  it('còn hạn: giữ qua phiên sau với phong toả; giá ngoài biên độ mới hoặc hết hạn thì hết hiệu lực', async () => {
    const keep = await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 95_000, qty: 1_000, validUntil: '2026-10-20' });
    const outBand = await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 93_100, qty: 100, validUntil: '2026-10-20' });
    const day = await engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 95_000, qty: 100 });
    expect(keep.validUntil).toBe('2026-10-20');
    await expect(engine.placeOrder(userId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: 95_000, qty: 100, validUntil: '2026-12-31' })).rejects.toThrow(/tối đa/);

    await engine.expireAll();
    expect((await engine.getOrder(userId, day.id)).status).toBe('EXPIRED');
    expect((await engine.getOrder(userId, keep.id)).status).toBe('PENDING');

    // phiên mới: giá tham chiếu tăng → biên độ 102.300–117.700 → lệnh 93.100 ngoài biên độ; 95.000 cũng ngoài
    market.tradeDate = '2026-10-16';
    market.setRef('FPT', 101_000); // biên độ 93.950 – 108.000
    expect(await engine.carryOver()).toBe(1);
    expect(await engine.getOrder(userId, keep.id)).toMatchObject({ status: 'PENDING', tradeDate: '2026-10-16' });
    const out = await engine.getOrder(userId, outBand.id);
    expect(out.status).toBe('EXPIRED');
    expect(out.rejectReason).toMatch(/ngoài biên độ/);
    // tiền phong toả chỉ còn của lệnh được giữ
    expect((await cash()).cash_hold).toBe(keep.holdAmount);
    // tới hạn thì hết hiệu lực
    market.tradeDate = '2026-10-20';
    await engine.expireAll();
    expect((await engine.getOrder(userId, keep.id)).status).toBe('EXPIRED');
    expect((await cash()).cash_hold).toBe(0);
  });
});

describe('Lệnh điều kiện', () => {
  const sellSetup = async () => {
    await db.many(`INSERT INTO holdings (user_id, symbol, qty_total, qty_available, total_cost) VALUES ($1,'FPT',1000,1000,100000000)`, [userId]);
  };

  it('cắt lỗ kích hoạt khi giá giảm chạm ngưỡng → đặt lệnh bán; chưa chạm thì không làm gì', async () => {
    await sellSetup();
    const [c] = await cond.create(userId, { symbol: 'FPT', side: 'SELL', qty: 1_000, kind: 'STOP', triggerPrice: 97_000, orderType: 'MARKET', validUntil: '2026-10-20' });
    market.trade('FPT', 98_000);
    await cond.onTick(['FPT']);
    expect((await cond.list(userId, 'active')).length).toBe(1);
    market.trade('FPT', 96_900);
    await cond.onTick(['FPT']);
    const done = (await cond.list(userId, 'all')).find((x) => x.id === c.id)!;
    expect(done.status).toBe('TRIGGERED');
    expect(done.orderId).toBeTruthy();
    const order = await engine.getOrder(userId, done.orderId!);
    expect(order).toMatchObject({ side: 'SELL', orderType: 'MP', source: 'CONDITIONAL', status: 'FILLED' });
    expect(events.some((e) => e.id === c.id && e.status === 'TRIGGERED')).toBe(true);
  });

  it('cặp OCO cắt lỗ + chốt lời: chốt lời kích hoạt thì cắt lỗ tự huỷ', async () => {
    await sellSetup();
    const legs = await cond.create(userId, {
      symbol: 'FPT',
      side: 'SELL',
      qty: 500,
      kind: 'STOP',
      triggerPrice: 95_000,
      orderType: 'LO',
      limitPrice: 94_800,
      validUntil: '2026-10-20',
      takeProfit: { triggerPrice: 105_000, orderType: 'LO', limitPrice: 99_900 },
    });
    expect(legs).toHaveLength(2);
    expect(legs[0].ocoGroup).toBe(legs[1].ocoGroup);
    market.trade('FPT', 105_000);
    await cond.onTick(['FPT']);
    const all = await cond.list(userId, 'all');
    expect(all.find((x) => x.kind === 'LIMIT_IF_TOUCHED')!.status).toBe('TRIGGERED');
    expect(all.find((x) => x.kind === 'STOP')).toMatchObject({ status: 'CANCELLED', message: expect.stringMatching(/OCO/) });
  });

  it('trailing stop: dời đỉnh theo giá, bán khi giảm đủ % từ đỉnh', async () => {
    await sellSetup();
    await cond.create(userId, { symbol: 'FPT', side: 'SELL', qty: 1_000, kind: 'TRAILING', trailPct: 5, orderType: 'MARKET', validUntil: '2026-10-20' });
    for (const p of [102_000, 106_000, 104_000]) {
      market.trade('FPT', p);
      await cond.onTick(['FPT']);
    }
    let c = (await cond.list(userId, 'all'))[0];
    expect(c).toMatchObject({ status: 'ACTIVE', peakPrice: 106_000 });
    market.trade('FPT', 100_700); // 106.000 × 95% = 100.700
    await cond.onTick(['FPT']);
    c = (await cond.list(userId, 'all'))[0];
    expect(c.status).toBe('TRIGGERED');
  });

  it('kích hoạt nhưng không đủ cổ phiếu → trạng thái lỗi kèm lý do; UPCOM dùng LO giá sàn thay MP', async () => {
    await db.many(`INSERT INTO holdings (user_id, symbol, qty_total, qty_available, total_cost) VALUES ($1,'ACV',200,200,10000000)`, [userId]);
    const [c] = await cond.create(userId, { symbol: 'ACV', side: 'SELL', qty: 200, kind: 'STOP', triggerPrice: 49_000, orderType: 'MARKET', validUntil: '2026-10-20' });
    // đã bán hết bằng lệnh thường trước khi kích hoạt
    await engine.placeOrder(userId, { symbol: 'ACV', side: 'SELL', orderType: 'LO', price: 49_900, qty: 200 });
    market.trade('ACV', 48_900);
    await cond.onTick(['ACV']);
    const failed = (await cond.list(userId, 'all')).find((x) => x.id === c.id)!;
    expect(failed.status).toBe('FAILED');
    expect(failed.message).toMatch(/không đủ cổ phiếu/i);

    await db.many(`INSERT INTO holdings (user_id, symbol, qty_total, qty_available, total_cost) VALUES ($1,'ACV',100,100,5000000)
                   ON CONFLICT (user_id, symbol) DO UPDATE SET qty_total = 100, qty_available = 100, total_cost = 5000000`, [userId]);
    market.trade('ACV', 49_500);
    const [c2] = await cond.create(userId, { symbol: 'ACV', side: 'SELL', qty: 100, kind: 'STOP', triggerPrice: 49_000, orderType: 'MARKET', validUntil: '2026-10-20' });
    market.trade('ACV', 48_800);
    await cond.onTick(['ACV']);
    const ok = (await cond.list(userId, 'all')).find((x) => x.id === c2.id)!;
    const o = await engine.getOrder(userId, ok.orderId!);
    expect(o).toMatchObject({ orderType: 'LO', price: market.quote('ACV')!.floor });
  });

  it('từ chối điều kiện đã thoả ngay lúc đặt; hết hạn cuối ngày; huỷ được', async () => {
    await sellSetup();
    market.trade('FPT', 100_000);
    await expect(cond.create(userId, { symbol: 'FPT', side: 'SELL', qty: 100, kind: 'STOP', triggerPrice: 100_500, orderType: 'MARKET', validUntil: '2026-10-15' })).rejects.toThrow(
      /thấp hơn giá hiện tại/,
    );
    await expect(cond.create(userId, { symbol: 'FPT', side: 'SELL', qty: 5_000, kind: 'STOP', triggerPrice: 95_000, orderType: 'MARKET', validUntil: '2026-10-15' })).rejects.toThrow(
      /không đủ/,
    );
    const [a] = await cond.create(userId, { symbol: 'FPT', side: 'BUY', qty: 100, kind: 'STOP', triggerPrice: 103_000, orderType: 'LO', limitPrice: 103_500, validUntil: '2026-10-15' });
    const [b] = await cond.create(userId, { symbol: 'FPT', side: 'BUY', qty: 100, kind: 'LIMIT_IF_TOUCHED', triggerPrice: 96_000, orderType: 'LO', limitPrice: 96_000, validUntil: '2026-10-16' });
    expect(await cond.expire('2026-10-15')).toBe(1);
    expect((await cond.list(userId, 'all')).find((x) => x.id === a.id)!.status).toBe('EXPIRED');
    await cond.cancel(userId, b.id);
    expect(await cond.list(userId, 'active')).toHaveLength(0);
  });
});
