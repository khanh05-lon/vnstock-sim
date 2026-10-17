import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express from 'express';
import bcrypt from 'bcryptjs';
import { Server } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Big, isMultiple, pathProgress, priceOnPath, type AdminPriceRow } from '@vss/shared';
import { adminRoutes } from '../src/admin/routes';
import { AdminStore } from '../src/admin/store';
import type { Database } from '../src/db';
import { signToken } from '../src/lib/auth';
import { errorHandler } from '../src/lib/errors';
import type { Mailer } from '../src/lib/mailer';
import { MarketService } from '../src/market/marketService';
import { seedSymbols } from '../src/market/symbols';
import { createUserAccount } from '../src/seed/seed';
import { SpotEngine } from '../src/trading/engine';
import { closeTestDb, openTestDb } from './helpers/db';

const BTC = 'BTCUSDT';

describe('Đường giá kịch bản', () => {
  it('nội suy theo hàm mũ: % thay đổi đều theo thời gian; trước / sau khoảng thì đứng ở giá đầu / giá đích', () => {
    const c = { from: '100', to: '400', startAt: 1_000, endAt: 11_000 };
    expect(priceOnPath(c, 0)).toBe(100);
    expect(priceOnPath(c, 6_000)).toBeCloseTo(200, 6);
    expect(priceOnPath(c, 11_000)).toBe(400);
    expect(priceOnPath(c, 99_000)).toBe(400);
    expect(pathProgress(c, 6_000)).toBe(0.5);
    // đặt giá ngay (startAt = endAt)
    expect(priceOnPath({ from: '100', to: '90', startAt: 5, endAt: 5 }, 5)).toBe(90);
  });
});

describe('MarketService: giá điều chỉnh', () => {
  let db: Database;
  let m: MarketService;
  const binance = (close: string) =>
    (m as unknown as { onMiniTickers(l: unknown[]): void }).onMiniTickers([
      { symbol: BTC, close, open: '80000', high: '95000', low: '79000', volume: '1', quoteVolume: '80000', time: Date.now() },
    ]);

  beforeAll(async () => {
    db = await openTestDb();
    await seedSymbols(db, null);
    // Nguồn Binance chưa kết nối, chưa tới ngưỡng chuyển giả lập → cặp giá thực tế chỉ đổi khi có dữ liệu Binance
    m = new MarketService(db, null, { feed: 'binance', simAfterMs: 3_600_000 });
    await m.init();
  });
  afterAll(() => closeTestDb(db));

  it('bỏ qua dữ liệu Binance (vẫn nhớ giá tham chiếu), sinh giá / sổ lệnh / giao dịch quanh giá đặt; về giá thực tế lấy lại giá Binance', async () => {
    const events: string[] = [];
    m.on('symbols', () => events.push('symbols'));
    binance('90000');
    expect(m.lastPrice(BTC)).toBe('90000');

    const now = Date.now();
    m.setPriceControl(BTC, { since: now, from: '90000', to: '100000', startAt: now, endAt: now, volatilityPct: 0 });
    expect(m.info(BTC)).toMatchObject({ priceMode: 'MANUAL', priceSince: now });
    expect(events).toEqual(['symbols']);
    await m.flushNow();
    expect(m.lastPrice(BTC)).toBe('100000');
    // Binance vẫn chạy nhưng không ảnh hưởng giá trên sàn
    binance('91000');
    await m.flushNow();
    expect(m.lastPrice(BTC)).toBe('100000');
    expect(m.priceControl(BTC)!.ref).toBe('91000');
    // sổ lệnh quanh giá điều chỉnh, đúng bước giá → lệnh người dùng khớp theo giá này
    const d = m.depth(BTC)!;
    const tick = m.info(BTC)!.filters.tickSize;
    expect(Number(d.asks[0]![0])).toBeGreaterThan(100000);
    expect(Number(d.asks[0]![0])).toBeLessThan(100050);
    expect(Number(d.bids[0]![0])).toBeLessThan(100000);
    for (const [p] of [...d.bids, ...d.asks]) expect(isMultiple(p, tick)).toBe(true);
    const fills = m.consumeBook(BTC, 'BUY', { qty: '0.001' }, '100100');
    expect(fills.length).toBeGreaterThan(0);
    expect(Number(fills[0]!.price)).toBeLessThan(100100);

    // về giá thực tế: lấy ngay giá Binance gần nhất
    m.setPriceControl(BTC, null);
    expect(m.lastPrice(BTC)).toBe('91000');
    expect(m.info(BTC)!.priceMode).toBe('LIVE');
    binance('92000');
    expect(m.lastPrice(BTC)).toBe('92000');
    expect(events).toEqual(['symbols', 'symbols']);
  });

  it('kịch bản chạy dần tới giá đích; dao động không vượt biên đã đặt', async () => {
    const now = Date.now();
    // đã chạy được một nửa thời gian của kịch bản 92000 → 101200 (+10%)
    m.setPriceControl(BTC, { since: now, from: '92000', to: '101200', startAt: now - 300_000, endAt: now + 300_000, volatilityPct: 0 });
    await m.flushNow();
    const mid = Math.sqrt(92000 * 101200);
    expect(Math.abs(Number(m.lastPrice(BTC)) / mid - 1)).toBeLessThan(0.001);

    m.setPriceControl(BTC, { since: now, from: '100000', to: '100000', startAt: now, endAt: now, volatilityPct: 1 });
    for (let i = 0; i < 40; i++) {
      await m.flushNow();
      await new Promise((r) => setTimeout(r, 5));
      expect(Math.abs(Number(m.lastPrice(BTC)) / 100000 - 1)).toBeLessThanOrEqual(0.0101);
    }
    m.setPriceControl(BTC, null);
  });
});

describe('Trang quản trị: chỉnh giá', () => {
  let db: Database;
  let server: http.Server;
  let base: string;
  let market: MarketService;
  let engine: SpotEngine;
  let admin: { id: string; token: string };
  let user: { id: string; token: string };
  const mailer: Mailer = { kind: 'smtp', send: async () => undefined };

  async function call<T = any>(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  async function makeUser(email: string, role: 'USER' | 'ADMIN') {
    const u = await db.tx(async (tx) => createUserAccount(tx, email, await bcrypt.hash('matkhau123', 4), email.split('@')[0]!));
    await db.many('UPDATE users SET role = $2, email_verified_at = now() WHERE id = $1', [u.id, role]);
    return { id: u.id, token: signToken({ id: u.id, email }) };
  }

  beforeAll(async () => {
    db = await openTestDb();
    await seedSymbols(db, null);
    market = new MarketService(db, null, { feed: 'sim' });
    await market.init();
    engine = new SpotEngine(db, market, { order: () => undefined, fill: () => undefined, account: () => undefined });
    await engine.load();
    market.hooks = { onTick: (c, t) => engine.onTick(c, t) };
    const store = new AdminStore(db, engine);
    await store.load();
    const app = express();
    app.use(express.json());
    app.use('/api/admin', adminRoutes({ db, io: new Server(), market, engine, store, mailer }));
    app.use(errorHandler);
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin`;
    admin = await makeUser('admin@example.test', 'ADMIN');
    user = await makeUser('nhadautu@example.test', 'USER');
    await market.flushNow();
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await closeTestDb(db);
  });

  it('chỉ quản trị viên; bắt buộc lý do; giá phải đúng khoảng giá của cặp', async () => {
    expect((await call('POST', `/prices/${BTC}/set`, user.token, { price: '1', reason: 'thử' })).status).toBe(403);
    expect((await call('POST', `/prices/${BTC}/set`, admin.token, { price: '60000' })).status).toBe(400);
    const tooSmall = await call('POST', `/prices/${BTC}/set`, admin.token, { price: '0.000001', reason: 'thử giá quá nhỏ' });
    expect(tooSmall.body.error.code).toBe('PRICE');
    expect((await call('POST', `/prices/${BTC}/live`, admin.token, { reason: 'chưa điều chỉnh' })).status).toBe(409);
    const rows = (await call<AdminPriceRow[]>('GET', '/prices', admin.token)).body;
    expect(rows.find((r) => r.symbol === BTC)).toMatchObject({ mode: 'LIVE', control: null });
  });

  it('đặt giá → lệnh của nhà đầu tư khớp theo giá điều chỉnh; ghi nhật ký; giữ nguyên sau khi khởi động lại; về giá thực tế', async () => {
    const before = market.lastPrice(BTC)!;
    const to = new Big(before).times(0.9).round(0).toFixed();
    const r = await call('POST', `/prices/${BTC}/set`, admin.token, { price: to, durationMin: 0, volatilityPct: 0, reason: 'Kịch bản giảm giá cho lớp học' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ from: before, to });
    await market.flushNow();
    expect(market.lastPrice(BTC)).toBe(to);
    expect(market.info(BTC)!.priceMode).toBe('MANUAL');

    // lệnh mua giới hạn cao hơn giá điều chỉnh 0,2% khớp ngay quanh giá điều chỉnh
    const limit = new Big(to).times(1.002).round(2).toFixed();
    const o = await engine.placeOrder(user.id, { symbol: BTC, side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', price: limit, quantity: '0.001' });
    expect(o.status).toBe('FILLED');
    const fill = await db.one<{ price: string }>('SELECT price FROM fills WHERE order_id = $1', [o.id]);
    expect(Number(fill!.price)).toBeGreaterThanOrEqual(Number(to));
    expect(Number(fill!.price)).toBeLessThan(Number(limit));

    const row = (await call<AdminPriceRow[]>('GET', '/prices', admin.token)).body.find((x) => x.symbol === BTC)!;
    expect(row).toMatchObject({ mode: 'MANUAL', last: to });
    expect(row.control).toMatchObject({ to, reason: 'Kịch bản giảm giá cho lớp học', by: 'admin@example.test', progress: 1 });
    expect((await call('POST', `/prices/${BTC}/manual`, admin.token, { reason: 'bật lại' })).status).toBe(409);

    // khởi động lại máy chủ: cặp vẫn ở giá điều chỉnh
    const again = new MarketService(db, null, { feed: 'sim' });
    await again.init();
    expect(again.info(BTC)).toMatchObject({ priceMode: 'MANUAL' });
    expect(again.priceControl(BTC)!.control).toMatchObject({ to, volatilityPct: 0 });

    // kịch bản: chạy tới giá đích trong 30 phút
    const target = new Big(to).times(1.05).round(0).toFixed();
    const s = await call('POST', `/prices/${BTC}/set`, admin.token, { price: target, durationMin: 30, volatilityPct: 0.5, reason: 'Hồi phục dần' });
    expect(s.body.endAt - Date.now()).toBeGreaterThan(29 * 60_000);
    await market.flushNow();
    expect(Math.abs(Number(market.lastPrice(BTC)) / Number(to) - 1)).toBeLessThan(0.006);

    expect((await call('POST', `/prices/${BTC}/live`, admin.token, { reason: 'Kết thúc bài học' })).status).toBe(200);
    expect(market.info(BTC)!.priceMode).toBe('LIVE');
    expect((await db.one<{ price_mode: string; price_control: unknown }>('SELECT price_mode, price_control FROM symbols WHERE symbol = $1', [BTC]))).toMatchObject({
      price_mode: 'LIVE',
      price_control: null,
    });

    const hist = (await call<{ action: string; adminEmail: string; detail: Record<string, unknown> }[]>('GET', `/prices/${BTC}/history`, admin.token)).body;
    expect(hist.map((h) => h.action)).toEqual(['PRICE_MODE_LIVE', 'PRICE_SET', 'PRICE_SET']);
    expect(hist[2]).toMatchObject({ adminEmail: 'admin@example.test', detail: { from: before, to, enteredManual: true, reason: 'Kịch bản giảm giá cho lớp học' } });
    expect(hist[1]!.detail).toMatchObject({ durationMin: 30, volatilityPct: 0.5, enteredManual: false });
    // nhật ký chỉ ghi thêm
    await expect(db.many(`DELETE FROM admin_audit_log WHERE action = 'PRICE_SET'`)).rejects.toThrow(/chỉ được ghi thêm/);
  });
});
