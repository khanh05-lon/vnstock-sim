import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PriceAlertDTO, WatchlistDTO } from '@vss/shared';
import { exportBackup, parseBackup, restoreBackup, serializeBackup } from '../src/admin/backup';
import type { Database } from '../src/db';
import { signToken } from '../src/lib/auth';
import { errorHandler } from '../src/lib/errors';
import type { MailMessage, Mailer } from '../src/lib/mailer';
import { alertRoutes } from '../src/routes/alerts';
import { watchlistRoutes } from '../src/routes/watchlists';
import { createUserAccount } from '../src/seed/seed';
import { PriceAlertService } from '../src/trading/priceAlerts';
import { closeTestDb, openTestDb } from './helpers/db';
import { FakeMarket } from './helpers/fakeMarket';

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
  await db.exec(`INSERT INTO stocks (symbol, exchange, name, industry, listed_shares, eps, bvps) VALUES
    ('FPT','HOSE','FPT','Test',1000000000,1,1), ('VCB','HOSE','VCB','Test',1000000000,1,1), ('SHS','HNX','SHS','Test',1000000000,1,1)`);
  const u = await db.tx((tx) => createUserAccount(tx, 'theodoi@example.test', 'x', 'Người Theo Dõi'));
  userId = u.id;
  token = signToken({ id: u.id, email: u.email });
  market = new FakeMarket();
  market.add('FPT', 'HOSE', 100_000, [], []);
  market.add('VCB', 'HOSE', 60_000, [], []);
  market.add('SHS', 'HNX', 13_400, [], []);
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

describe('Nhiều danh sách theo dõi', () => {
  it('tự tạo danh sách mặc định; tạo / đổi tên / xoá danh sách; thêm bớt mã; API cũ dùng danh sách đầu tiên', async () => {
    const first = await call<WatchlistDTO[]>('GET', '/watchlists');
    expect(first.body).toEqual([{ id: expect.any(Number), name: 'Theo dõi', symbols: [] }]);

    expect((await call('POST', '/watchlist', { symbol: 'fpt' })).status).toBe(201);
    expect((await call<string[]>('GET', '/watchlist')).body).toEqual(['FPT']);

    const bank = await call<WatchlistDTO>('POST', '/watchlists', { name: 'Ngân hàng' });
    expect(bank.status).toBe(201);
    expect((await call('POST', '/watchlists', { name: 'Ngân hàng' })).status).toBe(409);
    expect((await call('POST', `/watchlists/${bank.body.id}/symbols`, { symbol: 'VCB' })).status).toBe(201);
    expect((await call('POST', `/watchlists/${bank.body.id}/symbols`, { symbol: 'XYZ' })).body.error.message).toMatch(/không tồn tại/);
    expect((await call('PATCH', `/watchlists/${bank.body.id}`, { name: 'Bank' })).status).toBe(200);

    const all = (await call<WatchlistDTO[]>('GET', '/watchlists')).body;
    expect(all.map((l) => [l.name, l.symbols])).toEqual([
      ['Theo dõi', ['FPT']],
      ['Bank', ['VCB']],
    ]);

    await call('DELETE', `/watchlists/${bank.body.id}/symbols/VCB`);
    expect((await call('DELETE', `/watchlists/${bank.body.id}`)).status).toBe(200);
    // không xoá được danh sách cuối cùng
    expect((await call('DELETE', `/watchlists/${first.body[0].id}`)).body.error.message).toMatch(/ít nhất 1/);
  });

  it('khôi phục bản sao lưu cũ (chưa có nhiều danh sách) → mỗi người 1 danh sách mặc định', async () => {
    const b = parseBackup(serializeBackup(await exportBackup(db, { exportedBy: 'test', tradeDate: '2026-10-16' })));
    delete b.data.watchlist_lists;
    for (const w of b.data.watchlists) delete w.list_id;
    await restoreBackup(db, b, { dryRun: false });
    const lists = await db.many<{ name: string; n: number }>(
      'SELECT l.name, (SELECT count(*)::int FROM watchlists w WHERE w.list_id = l.id) AS n FROM watchlist_lists l WHERE l.user_id = $1',
      [userId],
    );
    expect(lists).toEqual([{ name: 'Theo dõi', n: 1 }]);
  });
});

describe('Cảnh báo giá', () => {
  beforeEach(async () => {
    await db.many(`UPDATE price_alerts SET status = 'CANCELLED' WHERE status = 'ACTIVE'`);
    await alerts.load();
    fired.length = 0;
    sent.length = 0;
    market.setRef('FPT', 100_000);
  });

  it('từ chối cảnh báo đã thoả ngay lúc tạo; báo đúng 1 lần khi giá chạm; gửi email nếu chọn', async () => {
    const bad = await call('POST', '/alerts', { symbol: 'FPT', kind: 'PRICE_ABOVE', value: 99_000 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/đã thoả ngay bây giờ.*100,000/);

    const up = await call<PriceAlertDTO>('POST', '/alerts', { symbol: 'FPT', kind: 'PRICE_ABOVE', value: 102_000, notifyEmail: true, note: 'chốt lời' });
    expect(up.status).toBe(201);
    const pct = await call<PriceAlertDTO>('POST', '/alerts', { symbol: 'FPT', kind: 'CHANGE_DOWN', value: 3.5 });
    expect(pct.body.value).toBe(3.5);

    market.trade('FPT', 101_500);
    await alerts.onTick(['FPT']);
    expect(fired).toHaveLength(0);

    market.trade('FPT', 102_100);
    await alerts.onTick(['FPT']);
    await alerts.onTick(['FPT']);
    expect(fired).toHaveLength(1);
    expect(fired[0].message).toMatch(/FPT: Giá khớp ≥ 102,000đ — giá khớp 102,100đ/);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent[0].subject).toMatch(/Cảnh báo FPT/);
    expect(sent[0].text).toMatch(/chốt lời/);

    // giảm 3,5% so với tham chiếu
    market.trade('FPT', 96_500);
    await alerts.onTick(['FPT']);
    expect(fired.at(-1)!.alert).toMatchObject({ kind: 'CHANGE_DOWN', status: 'TRIGGERED', triggeredPrice: 96_500 });

    const list = (await call<PriceAlertDTO[]>('GET', '/alerts?scope=all&symbol=FPT')).body;
    expect(list.filter((a) => a.status === 'TRIGGERED')).toHaveLength(2);
  });

  it('khối lượng, huỷ cảnh báo, giới hạn số cảnh báo, mã ngừng giao dịch', async () => {
    const vol = await call<PriceAlertDTO>('POST', '/alerts', { symbol: 'VCB', kind: 'VOLUME_ABOVE', value: 5_000 });
    market.trade('VCB', 60_100, 6_000);
    await alerts.onTick(['VCB']);
    expect(fired.at(-1)!.alert.id).toBe(vol.body.id);

    const a = await call<PriceAlertDTO>('POST', '/alerts', { symbol: 'SHS', kind: 'PRICE_BELOW', value: 12_000 });
    expect((await call<PriceAlertDTO>('DELETE', `/alerts/${a.body.id}`)).body.status).toBe('CANCELLED');
    expect((await call('DELETE', `/alerts/${a.body.id}`)).status).toBe(400);

    for (let i = 0; i < 50; i++) await alerts.create(userId, { symbol: 'SHS', kind: 'PRICE_ABOVE', value: 14_000 + i * 100 });
    expect((await call('POST', '/alerts', { symbol: 'SHS', kind: 'PRICE_ABOVE', value: 20_000 })).body.error.message).toMatch(/Tối đa 50/);

    market.stocks.delete('SHS');
    expect(await alerts.cancelMissingSymbols()).toBe(50);
  });
});
