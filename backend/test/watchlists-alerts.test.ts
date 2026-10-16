import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PriceAlertDTO, WatchlistDTO } from '@vss/shared';
import { exportBackup, parseBackup, RestoreError, restoreBackup, serializeBackup } from '../src/admin/backup';
import type { Database } from '../src/db';
import { signToken } from '../src/lib/auth';
import { errorHandler } from '../src/lib/errors';
import type { MailMessage, Mailer } from '../src/lib/mailer';
import { alertRoutes } from '../src/routes/alerts';
import { watchlistRoutes } from '../src/routes/watchlists';
import { createUserAccount } from '../src/seed/seed';
import { PriceAlertService } from '../src/trading/priceAlerts';
import { closeTestDb, openTestDb } from './helpers/db';
import { FakeMarket, TEST_FILTERS } from './helpers/fakeMarket';

let db: Database;
let server: http.Server;
let base: string;
let token: string;
let userId: string;
let market: FakeMarket;
let alerts: PriceAlertService;
const sent: MailMessage[] = [];
const fired: { userId: string; alert: PriceAlertDTO; message: string }[] = [];
const mailer: Mailer = { kind: 'smtp', send: async (m) => void sent.push(m) };

async function call<T = any>(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
  db = await openTestDb();
  await db.many(
    `INSERT INTO symbols (symbol, base_asset, quote_asset, name, filters) VALUES
     ('BTCUSDT','BTC','USDT','Bitcoin',$1), ('ETHUSDT','ETH','USDT','Ethereum',$1), ('SOLUSDT','SOL','USDT','Solana',$1)`,
    [JSON.stringify(TEST_FILTERS)],
  );
  const u = await db.tx((tx) => createUserAccount(tx, 'theodoi@example.test', 'x', 'Người Theo Dõi'));
  userId = u.id;
  token = signToken({ id: u.id, email: u.email });
  market = new FakeMarket();
  market.add('BTCUSDT', 'BTC', '80000');
  market.add('ETHUSDT', 'ETH', '2400');
  market.add('SOLUSDT', 'SOL', '105.5');
  alerts = new PriceAlertService(db, market, mailer);
  alerts.notify = (uid, alert, message) => void fired.push({ userId: uid, alert, message });
  await alerts.load();
  const app = express();
  app.use(express.json());
  app.use('/api', watchlistRoutes(db));
  app.use('/api', alertRoutes(alerts));
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await closeTestDb(db);
});

describe('Danh sách theo dõi', () => {
  it('tự tạo danh sách mặc định; tạo / đổi tên / xoá danh sách; thêm bớt cặp', async () => {
    const first = await call<WatchlistDTO[]>('GET', '/watchlists');
    expect(first.body).toEqual([{ id: expect.any(Number), name: 'Theo dõi', symbols: [] }]);

    expect((await call('POST', '/watchlist', { symbol: 'btcusdt' })).status).toBe(201);
    expect((await call<string[]>('GET', '/watchlist')).body).toEqual(['BTCUSDT']);

    const l1 = await call<WatchlistDTO>('POST', '/watchlists', { name: 'Layer 1' });
    expect(l1.status).toBe(201);
    expect((await call('POST', '/watchlists', { name: 'Layer 1' })).status).toBe(409);
    expect((await call('POST', `/watchlists/${l1.body.id}/symbols`, { symbol: 'SOLUSDT' })).status).toBe(201);
    expect((await call('POST', `/watchlists/${l1.body.id}/symbols`, { symbol: 'XYZUSDT' })).body.error.message).toMatch(/không tồn tại/);
    expect((await call('PATCH', `/watchlists/${l1.body.id}`, { name: 'L1' })).status).toBe(200);

    const all = (await call<WatchlistDTO[]>('GET', '/watchlists')).body;
    expect(all.map((l) => [l.name, l.symbols])).toEqual([
      ['Theo dõi', ['BTCUSDT']],
      ['L1', ['SOLUSDT']],
    ]);

    await call('DELETE', `/watchlists/${l1.body.id}/symbols/SOLUSDT`);
    expect((await call('DELETE', `/watchlists/${l1.body.id}`)).status).toBe(200);
    // không xoá được danh sách cuối cùng
    expect((await call('DELETE', `/watchlists/${first.body[0]!.id}`)).body.error.message).toMatch(/ít nhất 1/);
  });

  it('sao lưu rồi khôi phục giữ nguyên dữ liệu; từ chối bản sao lưu của sàn chứng khoán cũ', async () => {
    const b = parseBackup(serializeBackup(await exportBackup(db, { exportedBy: 'test', tradeDate: '2026-10-16' })));
    const report = await restoreBackup(db, b, { dryRun: false });
    expect(report.tables.find((t) => t.name === 'balances')!.rows).toBeGreaterThan(0);
    const lists = await db.many<{ name: string; n: number }>(
      'SELECT l.name, (SELECT count(*)::int FROM watchlists w WHERE w.list_id = l.id) AS n FROM watchlist_lists l WHERE l.user_id = $1',
      [userId],
    );
    expect(lists).toEqual([{ name: 'Theo dõi', n: 1 }]);
    const usdt = await db.one<{ free: string }>(`SELECT free::text FROM balances WHERE user_id = $1 AND asset = 'USDT'`, [userId]);
    expect(Number(usdt!.free)).toBe(10000);
    expect(() => parseBackup(JSON.stringify({ app: 'vnstock-sim', version: 2, data: {} }))).toThrow(RestoreError);
  });
});

describe('Cảnh báo giá', () => {
  beforeEach(async () => {
    await db.many(`UPDATE price_alerts SET status = 'CANCELLED' WHERE status = 'ACTIVE'`);
    await alerts.load();
    fired.length = 0;
    sent.length = 0;
    market.trade('BTCUSDT', '80000', 0);
  });

  it('từ chối cảnh báo đã thoả ngay lúc tạo; báo đúng 1 lần khi giá chạm; gửi email nếu chọn', async () => {
    const bad = await call('POST', '/alerts', { symbol: 'BTCUSDT', kind: 'PRICE_ABOVE', value: '79000' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/đã thoả ngay bây giờ.*80000/);

    const up = await call<PriceAlertDTO>('POST', '/alerts', { symbol: 'BTCUSDT', kind: 'PRICE_ABOVE', value: '82000.5', notifyEmail: true, note: 'chốt lời' });
    expect(up.status).toBe(201);
    expect(up.body.value).toBe('82000.5');
    const pct = await call<PriceAlertDTO>('POST', '/alerts', { symbol: 'BTCUSDT', kind: 'CHANGE_DOWN', value: 3.5 });
    expect(pct.body.value).toBe('3.5');

    market.trade('BTCUSDT', '81500');
    await alerts.onTick(['BTCUSDT']);
    expect(fired).toHaveLength(0);

    market.trade('BTCUSDT', '82100');
    await alerts.onTick(['BTCUSDT']);
    await alerts.onTick(['BTCUSDT']);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.message).toBe('BTCUSDT: Giá ≥ 82000.5, giá hiện tại 82100');
    await new Promise((r) => setTimeout(r, 20));
    expect(sent[0]!.subject).toMatch(/Cảnh báo BTCUSDT/);
    expect(sent[0]!.text).toMatch(/chốt lời/);

    // giảm 3,5% trong 24h
    market.trade('BTCUSDT', '77200', -3.6);
    await alerts.onTick(['BTCUSDT']);
    expect(fired.at(-1)!.alert).toMatchObject({ kind: 'CHANGE_DOWN', status: 'TRIGGERED', triggeredPrice: '77200' });

    const list = (await call<PriceAlertDTO[]>('GET', '/alerts?scope=all&symbol=BTCUSDT')).body;
    expect(list.filter((a) => a.status === 'TRIGGERED')).toHaveLength(2);
  });

  it('giá nhỏ nhiều chữ số lẻ, huỷ cảnh báo, giới hạn số cảnh báo, cặp ngừng giao dịch', async () => {
    market.add('PEPEUSDT', 'PEPE', '0.00000409');
    await db.many(`INSERT INTO symbols (symbol, base_asset, quote_asset, name, filters) VALUES ('PEPEUSDT','PEPE','USDT','Pepe',$1)`, [JSON.stringify(TEST_FILTERS)]);
    const pepe = await call<PriceAlertDTO>('POST', '/alerts', { symbol: 'PEPEUSDT', kind: 'PRICE_BELOW', value: '0.00000400' });
    expect(pepe.body.value).toBe('0.000004');
    market.trade('PEPEUSDT', '0.00000399');
    await alerts.onTick(['PEPEUSDT']);
    expect(fired.at(-1)!.alert.id).toBe(pepe.body.id);

    const a = await call<PriceAlertDTO>('POST', '/alerts', { symbol: 'SOLUSDT', kind: 'PRICE_BELOW', value: '90' });
    expect((await call<PriceAlertDTO>('DELETE', `/alerts/${a.body.id}`)).body.status).toBe('CANCELLED');
    expect((await call('DELETE', `/alerts/${a.body.id}`)).status).toBe(400);

    for (let i = 0; i < 50; i++) await alerts.create(userId, { symbol: 'SOLUSDT', kind: 'PRICE_ABOVE', value: String(110 + i) });
    expect((await call('POST', '/alerts', { symbol: 'SOLUSDT', kind: 'PRICE_ABOVE', value: '200' })).body.error.message).toMatch(/Tối đa 50/);

    market.symbols.delete('SOLUSDT');
    expect(await alerts.cancelMissingSymbols()).toBe(50);
  });
});
