import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/db';
import type { MailMessage, Mailer } from '../src/lib/mailer';
import { AlertMonitor } from '../src/ops/alerts';
import { FillDigest } from '../src/ops/fillDigest';
import { metrics } from '../src/ops/metrics';
import { createUserAccount } from '../src/seed/seed';
import { closeTestDb, openTestDb } from './helpers/db';

let db: Database;
const sent: MailMessage[] = [];
const mailer: Mailer = { kind: 'smtp', send: async (m) => void sent.push(m) };
let hook: http.Server;
let hookUrl: string;
const posts: Record<string, unknown>[] = [];

beforeAll(async () => {
  db = await openTestDb();
  hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      posts.push(JSON.parse(body));
      res.end('ok');
    });
  });
  hook.listen(0);
  await new Promise((r) => hook.once('listening', r));
  hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
});
afterAll(async () => {
  await new Promise((r) => hook.close(r));
  await closeTestDb(db);
});

describe('Giám sát & cảnh báo', () => {
  it('lỗi 2 lần liên tiếp mới báo (tránh báo nhầm); gửi email + webhook, ghi lịch sử; hết lỗi 2 lần thì báo đã xử lý', async () => {
    const thresholds = { eventLoopMs: 1e9, p95Ms: 1e9, rssMb: 1e9, dbSlowMs: -1, errorRate: 1 };
    const mon = new AlertMonitor(db, mailer, { emails: ['ops@example.test'], webhookUrl: hookUrl, thresholds });
    metrics.lastTickAt = Date.now();
    await mon.check();
    expect(mon.active.size).toBe(0);
    await mon.check();
    expect([...mon.active.keys()]).toEqual(['db_slow']);
    expect(sent.at(-1)!.subject).toContain('Cơ sở dữ liệu phản hồi chậm');
    expect(posts.at(-1)).toMatchObject({ title: 'Cơ sở dữ liệu phản hồi chậm', resolved: false });
    const row = await db.one<{ notified: boolean; resolved_at: Date | null }>(`SELECT notified, resolved_at FROM system_alerts WHERE key = 'db_slow'`);
    expect(row).toMatchObject({ notified: true, resolved_at: null });

    thresholds.dbSlowMs = 1e9;
    await mon.check();
    expect(mon.active.size).toBe(1);
    await mon.check();
    expect(mon.active.size).toBe(0);
    expect(posts.at(-1)).toMatchObject({ resolved: true });
    expect((await db.one<{ resolved_at: Date | null }>(`SELECT resolved_at FROM system_alerts WHERE key = 'db_slow'`))!.resolved_at).not.toBeNull();
    // khởi động lại không báo lại cảnh báo đã xử lý
    const again = new AlertMonitor(db, mailer, { emails: [], webhookUrl: '', thresholds });
    await again.loadActive();
    expect(again.active.size).toBe(0);
  });

  it('vòng lặp thị trường ngừng > 30 giây → cảnh báo nghiêm trọng', async () => {
    const mon = new AlertMonitor(db, mailer, { emails: [], webhookUrl: '', thresholds: { eventLoopMs: 1e9, p95Ms: 1e9, rssMb: 1e9, dbSlowMs: 1e9, errorRate: 1 } });
    metrics.lastTickAt = Date.now() - 60_000;
    await mon.check();
    await mon.check();
    expect(mon.active.get('market_stalled')?.level).toBe('critical');
    metrics.lastTickAt = Date.now();
  });

  it('chỉ số định dạng Prometheus', () => {
    metrics.recordFill(1_000_000);
    const text = metrics.prometheus({ open_orders: 3 });
    expect(text).toContain('# TYPE vnstock_http_requests_total counter');
    expect(text).toMatch(/vnstock_fills_total \d+/);
    expect(text).toContain('vnstock_open_orders 3');
  });
});

describe('Email tổng hợp lệnh khớp', () => {
  it('gom nhiều lần khớp thành 1 email, chỉ gửi cho người bật tuỳ chọn', async () => {
    const on = (await db.tx((tx) => createUserAccount(tx, 'bat@example.test', 'x', 'Người Bật'))).id;
    const off = (await db.tx((tx) => createUserAccount(tx, 'tat@example.test', 'x', 'Người Tắt'))).id;
    await db.many('UPDATE users SET notify_fills = true WHERE id = $1', [on]);
    const digest = new FillDigest(db, mailer, 60_000);
    const fill = (id: number, qty: string) => ({
      id,
      orderId: 7,
      symbol: 'BTCUSDT',
      side: 'BUY' as const,
      price: '82000.5',
      qty,
      quoteQty: '0',
      commission: '0',
      commissionAsset: 'BTC',
      isMaker: false,
      realizedPnl: null,
      time: '',
    });
    digest.push(on, fill(1, '0.1'));
    digest.push(on, fill(2, '0.3'));
    digest.push(off, fill(3, '0.1'));
    const before = sent.length;
    expect(await digest.flush()).toBe(1);
    const mail = sent.slice(before);
    expect(mail).toHaveLength(1);
    expect(mail[0].to).toBe('bat@example.test');
    expect(mail[0].subject).toContain('2 giao dịch');
    expect(mail[0].text).toContain('MUA 0.3 BTCUSDT giá 82000.5');
  });
});
