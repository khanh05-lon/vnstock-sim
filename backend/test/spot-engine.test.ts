import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Big, type FillDTO, type OrderDTO, type TradeTick } from '@vss/shared';
import { AdminStore } from '../src/admin/store';
import type { Database } from '../src/db';
import { createUserAccount } from '../src/seed/seed';
import { accountView } from '../src/trading/account';
import { SpotEngine } from '../src/trading/engine';
import { credit } from '../src/trading/wallet';
import { closeTestDb, openTestDb } from './helpers/db';
import { FakeMarket, TEST_FILTERS } from './helpers/fakeMarket';

let db: Database;
let market: FakeMarket;
let engine: SpotEngine;
let userId: string;
let seq = 0;
const fills: FillDTO[] = [];
const orders: OrderDTO[] = [];

const BTC = 'BTCUSDT';

async function bal(asset: string) {
  const r = await db.one<{ free: string; locked: string; cost_usdt: string }>('SELECT free, locked, cost_usdt FROM balances WHERE user_id = $1 AND asset = $2', [
    userId,
    asset,
  ]);
  return { free: new Big(r?.free ?? 0).toFixed(), locked: new Big(r?.locked ?? 0).toFixed(), cost: new Big(r?.cost_usdt ?? 0) };
}

const tick = (price: string, qty: string): TradeTick => ({ id: ++seq, symbol: BTC, price, qty, time: Date.now(), buyerMaker: true });
const runTick = (...ticks: TradeTick[]) => engine.onTick(new Set([BTC]), new Map(ticks.length ? [[BTC, ticks]] : []));

/** Tổng phần khoá của lệnh mở phải đúng bằng số dư đang khoá (bất biến sổ sách) */
async function assertLocksConsistent() {
  const rows = await db.many<{ asset: string; locked: string; by_orders: string }>(
    `SELECT b.asset, b.locked::text AS locked,
            COALESCE((SELECT sum(o.locked_amount) FROM orders o WHERE o.user_id = b.user_id AND o.locked_asset = b.asset AND o.status IN ('NEW','PARTIALLY_FILLED')), 0)::text AS by_orders
     FROM balances b WHERE b.user_id = $1`,
    [userId],
  );
  for (const r of rows) expect(new Big(r.locked).eq(r.by_orders), `${r.asset}: khoá ${r.locked} ≠ lệnh ${r.by_orders}`).toBe(true);
}

beforeAll(async () => {
  db = await openTestDb();
  const filters = JSON.stringify(TEST_FILTERS);
  await db.many(
    `INSERT INTO symbols (symbol, base_asset, quote_asset, name, filters) VALUES
     ('BTCUSDT','BTC','USDT','Bitcoin',$1), ('BNBUSDT','BNB','USDT','BNB',$1)`,
    [filters],
  );
});
afterAll(() => closeTestDb(db));

beforeEach(async () => {
  // CSDL dùng chung giữa các test: đóng lệnh mở của người dùng ở test trước để engine mới không nạp lại
  await db.exec(`UPDATE orders SET status = 'CANCELED', locked_amount = 0 WHERE status IN ('NEW','PARTIALLY_FILLED')`);
  userId = (await db.tx((tx) => createUserAccount(tx, `u${++seq}@example.test`, 'x', 'Nhà đầu tư'))).id;
  market = new FakeMarket();
  market.add(BTC, 'BTC', '80000', [
    ['79990', '0.05'],
    ['79980', '0.1'],
  ], [
    ['80000', '0.05'],
    ['80010', '0.1'],
  ]);
  market.add('BNBUSDT', 'BNB', '600', [['599.9', '10']], [['600', '10']]);
  fills.length = 0;
  orders.length = 0;
  engine = new SpotEngine(db, market, { order: (_u, o) => void orders.push(o), fill: (_u, f) => void fills.push(f), account: () => undefined });
  await engine.load();
});

describe('Lệnh giới hạn (taker) và phí', () => {
  it('mua ăn 2 mức giá, phí 0,1% trừ bằng BTC, trả lại phần khoá dư', async () => {
    const o = await engine.placeOrder(userId, { symbol: BTC, side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', price: '80010', quantity: '0.08' });
    expect(o.status).toBe('FILLED');
    expect(o.executedQty).toBe('0.08');
    expect(o.cummulativeQuoteQty).toBe('6400.3');
    expect(o.avgPrice).toBe('80003.75');
    expect(fills.map((f) => [f.price, f.qty, f.commission, f.commissionAsset, f.isMaker])).toEqual([
      ['80000', '0.05', '0.00005', 'BTC', false],
      ['80010', '0.03', '0.00003', 'BTC', false],
    ]);
    expect(await bal('USDT')).toMatchObject({ free: '3599.7', locked: '0' });
    const btc = await bal('BTC');
    expect(btc.free).toBe('0.07992');
    expect(btc.cost.toFixed()).toBe('6400.3');
    await assertLocksConsistent();
  });

  it('bán: phí trừ bằng USDT, lãi/lỗ đã thực hiện theo giá vốn bình quân', async () => {
    await engine.placeOrder(userId, { symbol: BTC, side: 'BUY', type: 'LIMIT', price: '80010', quantity: '0.08' });
    fills.length = 0;
    const o = await engine.placeOrder(userId, { symbol: BTC, side: 'SELL', type: 'LIMIT', price: '79980', quantity: '0.0799' });
    expect(o.status).toBe('FILLED');
    expect(o.cummulativeQuoteQty).toBe('6390.902');
    const fee = fills.reduce((a, f) => a.plus(f.commission), new Big(0));
    expect(fee.toFixed()).toBe('6.390902');
    expect(fills.every((f) => f.commissionAsset === 'USDT')).toBe(true);
    // Giá vốn của 0.0799 BTC = 6400.3 × 0.0799 / 0.07992
    const costRemoved = new Big('6400.3').times('0.0799').div('0.07992');
    const realized = fills.reduce((a, f) => a.plus(f.realizedPnl!), new Big(0));
    expect(realized.minus(new Big('6384.511098').minus(costRemoved)).abs().lt('0.0001')).toBe(true);
    expect((await bal('USDT')).free).toBe(new Big('3599.7').plus('6384.511098').toFixed());
    expect((await bal('BTC')).free).toBe('0.00002');
  });

  it('lỗi bộ lọc và không đủ số dư', async () => {
    await expect(engine.placeOrder(userId, { symbol: BTC, side: 'BUY', type: 'LIMIT', price: '80000', quantity: '0.00001' })).rejects.toMatchObject({ code: 'LOT_SIZE' });
    await expect(engine.placeOrder(userId, { symbol: BTC, side: 'BUY', type: 'LIMIT', price: '80000.001', quantity: '0.001' })).rejects.toMatchObject({ code: 'PRICE_FILTER' });
    await expect(engine.placeOrder(userId, { symbol: BTC, side: 'BUY', type: 'LIMIT', price: '40000', quantity: '0.0001' })).rejects.toMatchObject({ code: 'NOTIONAL' });
    await expect(engine.placeOrder(userId, { symbol: BTC, side: 'BUY', type: 'LIMIT', price: '79000', quantity: '1' })).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
    await expect(engine.placeOrder(userId, { symbol: BTC, side: 'SELL', type: 'LIMIT', price: '81000', quantity: '0.01' })).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
    expect(await bal('USDT')).toMatchObject({ free: '10000', locked: '0' });
  });
});

describe('Lệnh chờ (maker), huỷ, IOC / FOK / post-only', () => {
  it('lệnh mua dưới giá nằm chờ, khớp maker theo khối lượng giao dịch thị trường đi qua giá đặt', async () => {
    const o = await engine.placeOrder(userId, { symbol: BTC, side: 'BUY', type: 'LIMIT', price: '79000', quantity: '0.01' });
    expect(o.status).toBe('NEW');
    expect(await bal('USDT')).toMatchObject({ free: '9210', locked: '790' });

    await runTick(tick('79500', '5'));
    expect(fills).toHaveLength(0);
    await runTick(tick('78990', '0.004'));
    expect(fills.at(-1)).toMatchObject({ price: '79000', qty: '0.004', isMaker: true });
    await runTick(tick('79000', '1'));
    expect(orders.at(-1)).toMatchObject({ status: 'FILLED', executedQty: '0.01' });
    expect(await bal('USDT')).toMatchObject({ free: '9210', locked: '0' });
    expect((await bal('BTC')).free).toBe('0.00999');
    await assertLocksConsistent();
  });

  it('sổ lệnh đi qua giá chờ cũng khớp maker ở đúng giá đặt', async () => {
    await engine.placeOrder(userId, { symbol: BTC, side: 'BUY', type: 'LIMIT', price: '79000', quantity: '0.01' });
    market.setBook(BTC, [['78900', '1']], [['78950', '0.006']]);
    await runTick();
    expect(fills.at(-1)).toMatchObject({ price: '79000', qty: '0.006', isMaker: true });
    expect(orders.at(-1)!.status).toBe('PARTIALLY_FILLED');
  });

  it('huỷ lệnh trả lại đúng phần khoá', async () => {
    const o = await engine.placeOrder(userId, { symbol: BTC, side: 'BUY', type: 'LIMIT', price: '79000', quantity: '0.01' });
    const c = await engine.cancelOrder(userId, o.id);
    expect(c.status).toBe('CANCELED');
    expect(await bal('USDT')).toMatchObject({ free: '10000', locked: '0' });
    await expect(engine.cancelOrder(userId, o.id)).rejects.toMatchObject({ code: 'NOT_CANCELABLE' });
  });

  it('IOC khớp phần có thể rồi huỷ phần còn lại; FOK không đủ thì hết hiệu lực', async () => {
    market.setBook(BTC, [], [['80000', '0.02']]);
    const ioc = await engine.placeOrder(userId, { symbol: BTC, side: 'BUY', type: 'LIMIT', timeInForce: 'IOC', price: '80000', quantity: '0.05' });
    expect(ioc).toMatchObject({ status: 'EXPIRED', executedQty: '0.02' });
    market.setBook(BTC, [], [['80000', '0.02']]);
    const fok = await engine.placeOrder(userId, { symbol: BTC, side: 'BUY', type: 'LIMIT', timeInForce: 'FOK', price: '80000', quantity: '0.05' });
    expect(fok).toMatchObject({ status: 'EXPIRED', executedQty: '0' });
    expect((await bal('USDT')).locked).toBe('0');
    await assertLocksConsistent();
  });

  it('post-only bị từ chối nếu khớp ngay', async () => {
    await expect(engine.placeOrder(userId, { symbol: BTC, side: 'BUY', type: 'LIMIT_MAKER', price: '80000', quantity: '0.001' })).rejects.toMatchObject({
      code: 'POST_ONLY',
    });
    const ok = await engine.placeOrder(userId, { symbol: BTC, side: 'BUY', type: 'LIMIT_MAKER', price: '79995', quantity: '0.001' });
    expect(ok.status).toBe('NEW');
  });

  it('sửa lệnh = huỷ và đặt lại', async () => {
    const o = await engine.placeOrder(userId, { symbol: BTC, side: 'BUY', type: 'LIMIT', price: '79000', quantity: '0.01' });
    const n = await engine.replaceOrder(userId, o.id, { price: '78000' });
    expect(n.id).not.toBe(o.id);
    expect(n).toMatchObject({ price: '78000', origQty: '0.01', status: 'NEW' });
    expect(await bal('USDT')).toMatchObject({ free: '9220', locked: '780' });
    await assertLocksConsistent();
  });
});

describe('Lệnh thị trường', () => {
  it('mua theo số tiền: ăn sổ lệnh, trả lại phần dư không đủ 1 bước khối lượng', async () => {
    market.setBook(BTC, [], [['80000', '1']]);
    const o = await engine.placeOrder(userId, { symbol: BTC, side: 'BUY', type: 'MARKET', quoteOrderQty: '100' });
    expect(o).toMatchObject({ status: 'FILLED', executedQty: '0.0012', cummulativeQuoteQty: '96', origQty: '0.0012', origQuoteOrderQty: '100' });
    expect(await bal('USDT')).toMatchObject({ free: '9904', locked: '0' });
  });

  it('bán theo khối lượng khi sổ lệnh thiếu thanh khoản: phần còn lại hết hiệu lực', async () => {
    await engine.placeOrder(userId, { symbol: BTC, side: 'BUY', type: 'LIMIT', price: '80010', quantity: '0.08' });
    market.setBook(BTC, [['79000', '0.03']], []);
    const o = await engine.placeOrder(userId, { symbol: BTC, side: 'SELL', type: 'MARKET', quantity: '0.05' });
    expect(o).toMatchObject({ status: 'EXPIRED', executedQty: '0.03' });
    expect(await bal('BTC')).toMatchObject({ free: '0.04992', locked: '0' });
    await assertLocksConsistent();
  });
});

describe('Lệnh dừng và OCO', () => {
  beforeEach(async () => {
    await db.tx((tx) => credit(tx, userId, 'BTC', '0.1', '8000'));
  });

  it('stop-limit bán: kích hoạt khi giá ≤ stop rồi khớp như lệnh giới hạn; từ chối nếu sẽ kích hoạt ngay', async () => {
    await expect(
      engine.placeOrder(userId, { symbol: BTC, side: 'SELL', type: 'STOP_LOSS_LIMIT', stopPrice: '81000', price: '80900', quantity: '0.01' }),
    ).rejects.toMatchObject({ code: 'STOP_IMMEDIATE' });
    const o = await engine.placeOrder(userId, { symbol: BTC, side: 'SELL', type: 'STOP_LOSS_LIMIT', stopPrice: '79000', price: '78900', quantity: '0.01' });
    expect(o).toMatchObject({ status: 'NEW', isWorking: false });
    expect(await bal('BTC')).toMatchObject({ free: '0.09', locked: '0.01' });
    await runTick(tick('79500', '1'));
    expect(fills).toHaveLength(0);
    market.trade(BTC, '78990');
    market.setBook(BTC, [['78950', '1']], [['79000', '1']]);
    await runTick(tick('78990', '1'));
    expect(fills.at(-1)).toMatchObject({ price: '78950', qty: '0.01', isMaker: false });
    // isWorking giữ true sau khi lệnh dừng đã kích hoạt (như Binance)
    expect(orders.at(-1)).toMatchObject({ status: 'FILLED', isWorking: true });
    await assertLocksConsistent();
  });

  it('OCO bán: chân giới hạn khớp thì chân dừng hết hiệu lực', async () => {
    const list = await engine.placeOco(userId, { symbol: BTC, side: 'SELL', quantity: '0.02', price: '82000', stopPrice: '78000', stopLimitPrice: '77900' });
    expect(list.orders.map((o) => o.type)).toEqual(['LIMIT_MAKER', 'STOP_LOSS_LIMIT']);
    expect(await bal('BTC')).toMatchObject({ free: '0.08', locked: '0.02' });
    await runTick(tick('82000', '1'));
    const legs = await db.many<{ type: string; status: string }>('SELECT type, status FROM orders WHERE order_list_id = $1 ORDER BY id', [list.id]);
    expect(legs).toEqual([
      { type: 'LIMIT_MAKER', status: 'FILLED' },
      { type: 'STOP_LOSS_LIMIT', status: 'EXPIRED' },
    ]);
    expect((await db.one<{ status: string }>('SELECT status FROM order_lists WHERE id = $1', [list.id]))!.status).toBe('ALL_DONE');
    expect(await bal('BTC')).toMatchObject({ free: '0.08', locked: '0' });
    await assertLocksConsistent();
  });

  it('OCO bán: giá giảm chạm stop thì chân giới hạn hết hiệu lực, phần khoá chuyển sang chân dừng', async () => {
    const list = await engine.placeOco(userId, { symbol: BTC, side: 'SELL', quantity: '0.02', price: '82000', stopPrice: '78000', stopLimitPrice: '77900' });
    // Giá giảm qua stop, sổ lệnh mua chỉ còn 0.01 ở trên giá đặt 77900 (không có giao dịch đi qua 77900)
    market.trade(BTC, '77990');
    market.setBook(BTC, [['77950', '0.01']], [['78000', '1']]);
    await runTick();
    const legs = await db.many<{ type: string; status: string; executed_qty: string }>(
      'SELECT type, status, executed_qty::text FROM orders WHERE order_list_id = $1 ORDER BY id',
      [list.id],
    );
    expect(legs[0]).toMatchObject({ type: 'LIMIT_MAKER', status: 'EXPIRED' });
    expect(legs[1]).toMatchObject({ type: 'STOP_LOSS_LIMIT', status: 'PARTIALLY_FILLED' });
    expect(new Big(legs[1]!.executed_qty).toFixed()).toBe('0.01');
    expect(await bal('BTC')).toMatchObject({ free: '0.08', locked: '0.01' });
    await assertLocksConsistent();
  });

  it('OCO sai thứ tự giá bị từ chối; huỷ 1 chân là huỷ cả danh sách', async () => {
    await expect(engine.placeOco(userId, { symbol: BTC, side: 'SELL', quantity: '0.02', price: '79000', stopPrice: '78000', stopLimitPrice: '77900' })).rejects.toMatchObject({
      code: 'OCO_PRICES',
    });
    const list = await engine.placeOco(userId, { symbol: BTC, side: 'SELL', quantity: '0.02', price: '82000', stopPrice: '78000', stopLimitPrice: '77900' });
    await engine.cancelOrder(userId, list.orders[1]!.id);
    const legs = await db.many<{ status: string }>('SELECT status FROM orders WHERE order_list_id = $1', [list.id]);
    expect(legs.every((l) => l.status === 'CANCELED')).toBe(true);
    expect(await bal('BTC')).toMatchObject({ free: '0.1', locked: '0' });
  });
});

describe('Trả phí bằng BNB, ví, vận hành', () => {
  it('bật trả phí bằng BNB: giảm 25%, nhận đủ coin', async () => {
    await db.tx((tx) => credit(tx, userId, 'BNB', '1', '600'));
    await db.many('UPDATE accounts SET pay_fee_with_bnb = true WHERE user_id = $1', [userId]);
    market.setBook(BTC, [], [['80000', '1']]);
    await engine.placeOrder(userId, { symbol: BTC, side: 'BUY', type: 'LIMIT', price: '80000', quantity: '0.01' });
    // 800 USDT × 0,1% × 75% = 0,6 USDT = 0,001 BNB (giá 600)
    expect(fills.at(-1)).toMatchObject({ commission: '0.001', commissionAsset: 'BNB' });
    expect((await bal('BTC')).free).toBe('0.01');
    expect((await bal('BNB')).free).toBe('0.999');
  });

  it('ví quy đổi tổng tài sản theo USDT và BTC', async () => {
    await engine.placeOrder(userId, { symbol: BTC, side: 'BUY', type: 'LIMIT', price: '80010', quantity: '0.08' });
    const v = await accountView(db, market, userId);
    const btc = v.balances.find((b) => b.asset === 'BTC')!;
    expect(btc.usdtValue).toBe(new Big('0.07992').times('80000').toFixed());
    expect(new Big(v.totalUsdt).eq(new Big('3599.7').plus(btc.usdtValue))).toBe(true);
    expect(v.balances[0]!.asset).toBe('BTC');
  });

  it('tạm ngừng toàn sàn chặn đặt lệnh và chặn khớp; khoá tài khoản huỷ lệnh mở', async () => {
    const store = new AdminStore(db, engine);
    await engine.placeOrder(userId, { symbol: BTC, side: 'BUY', type: 'LIMIT', price: '79000', quantity: '0.01' });
    await store.setHalt(true, 'Bảo trì');
    await expect(engine.placeOrder(userId, { symbol: BTC, side: 'BUY', type: 'LIMIT', price: '79000', quantity: '0.01' })).rejects.toThrow(/Bảo trì/);
    await runTick(tick('78000', '5'));
    expect(fills).toHaveLength(0);
    await store.setHalt(false, '');
    expect(await engine.cancelAllForUser(userId, 'Khoá tài khoản')).toBe(1);
    expect(await bal('USDT')).toMatchObject({ free: '10000', locked: '0' });
  });

  it('đặt lại tài khoản: xoá lịch sử, cấp lại 10.000 USDT', async () => {
    await engine.placeOrder(userId, { symbol: BTC, side: 'BUY', type: 'LIMIT', price: '80010', quantity: '0.08' });
    await engine.resetAccount(userId);
    expect(await bal('USDT')).toMatchObject({ free: '10000', locked: '0' });
    expect(await db.one('SELECT 1 FROM balances WHERE user_id = $1 AND asset = $2', [userId, 'BTC'])).toBeUndefined();
    expect((await db.one<{ n: number }>('SELECT count(*)::int AS n FROM orders WHERE user_id = $1', [userId]))!.n).toBe(0);
  });
});
