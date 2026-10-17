import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express from 'express';
import bcrypt from 'bcryptjs';
import { Server } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Big, type ApprovalDTO, type FeeRevenueReport, type FraudReport, type ReconRunDTO, type UserRole } from '@vss/shared';
import { expireEmergencyIfDue } from '../src/admin/emergency';
import { adminRoutes } from '../src/admin/routes';
import { AdminStore } from '../src/admin/store';
import type { Database } from '../src/db';
import { signToken } from '../src/lib/auth';
import { errorHandler } from '../src/lib/errors';
import type { MailMessage, Mailer } from '../src/lib/mailer';
import { MarketService } from '../src/market/marketService';
import { seedSymbols } from '../src/market/symbols';
import type { NavService } from '../src/portfolio/nav';
import { tradingRoutes } from '../src/routes/trading';
import { createUserAccount } from '../src/seed/seed';
import { SpotEngine } from '../src/trading/engine';
import { closeTestDb, openTestDb } from './helpers/db';

let db: Database;
let server: http.Server;
let base: string;
let market: MarketService;
let engine: SpotEngine;
let store: AdminStore;
const io = new Server();
const sent: MailMessage[] = [];
const mailer: Mailer = { kind: 'smtp', send: async (m) => void sent.push(m) };
const u: Record<string, { id: string; email: string; token: string }> = {};

async function call<T = any>(method: string, p: string, who: string, body?: unknown) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), Authorization: `Bearer ${u[who]!.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function makeUser(name: string, role: UserRole) {
  const email = `${name}@example.test`;
  const row = await db.tx(async (tx) => createUserAccount(tx, email, await bcrypt.hash('matkhau123', 4), name));
  await db.many('UPDATE users SET role = $2, email_verified_at = now() WHERE id = $1', [row.id, role]);
  u[name] = { id: row.id, email, token: signToken({ id: row.id, email }) };
}

beforeAll(async () => {
  db = await openTestDb();
  await seedSymbols(db, null);
  market = new MarketService(db, null, { feed: 'sim' });
  await market.init();
  engine = new SpotEngine(db, market, { order: () => undefined, fill: () => undefined, account: () => undefined });
  await engine.load();
  market.hooks = { onTick: (c, t) => engine.onTick(c, t) };
  store = new AdminStore(db, engine);
  await store.load();
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes({ db, io, market, engine, store, mailer }));
  app.use('/api', tradingRoutes(db, market, engine, { history: async () => [] } as unknown as NavService));
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  for (const [name, role] of [
    ['ops', 'MARKET_OPS'],
    ['risk', 'RISK'],
    ['risk2', 'RISK'],
    ['fin', 'FINANCE'],
    ['audit', 'AUDITOR'],
    ['sys', 'ADMIN'],
    ['an', 'USER'],
    ['binh', 'USER'],
  ] as [string, UserRole][]) {
    await makeUser(name, role);
  }
  await market.flushNow();
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await closeTestDb(db);
});

describe('Dừng khẩn toàn sàn', () => {
  it('1 người dừng ngay; người khác xác nhận thì thành tạm ngừng chính thức; mở lại phải có người duyệt', async () => {
    expect((await call('POST', '/admin/market/emergency-halt', 'fin', { reason: 'thử' })).status).toBe(403);
    sent.length = 0;
    const e = await call('POST', '/admin/market/emergency-halt', 'risk', { reason: 'Nguồn giá trả về giá sai' });
    expect(e.status).toBe(200);
    expect(engine.control.haltAll).toBe(true);
    expect(store.status().emergencyUntil).toBe(e.body.emergency.expiresAt);
    expect(Date.parse(e.body.emergency.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
    // khách không đặt được lệnh
    const order = await call('POST', '/orders', 'an', { symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', price: '60000', quantity: '0.001' });
    expect(order.status).toBeGreaterThanOrEqual(400);
    // báo người có thể xác nhận
    expect(sent.filter((m) => /dừng khẩn/i.test(m.subject)).map((m) => m.to).sort()).toEqual([u.ops!.email, u.risk2!.email].sort());

    expect((await call('POST', '/admin/market/emergency-halt/confirm', 'risk', {})).body.error.code).toBe('SELF');
    // đang dừng khẩn: không đề xuất mở lại được — phải xác nhận hoặc huỷ trước
    expect((await call('POST', '/admin/market/halt', 'ops', { halted: false, reason: 'Mở lại' })).body.error.code).toBe('EMERGENCY');
    expect((await call('POST', '/admin/market/emergency-halt/confirm', 'ops', {})).status).toBe(200);
    expect(store.emergency).toBeNull();
    expect(engine.control.haltAll).toBe(true);

    // mở lại: đề xuất → người khác duyệt
    const r = await call<{ request: ApprovalDTO }>('POST', '/admin/market/halt', 'ops', { halted: false, reason: 'Đã sửa nguồn giá' });
    expect(r.status).toBe(202);
    expect(engine.control.haltAll).toBe(true);
    expect((await call('POST', `/admin/approvals/${r.body.request.id}/approve`, 'ops', {})).body.error.code).toBe('SELF');
    expect((await call<ApprovalDTO>('POST', `/admin/approvals/${r.body.request.id}/approve`, 'risk2', {})).body.status).toBe('APPROVED');
    expect(engine.control.haltAll).toBe(false);
  });

  it('không ai xác nhận thì tự mở lại khi hết hạn; báo động nhầm thì huỷ ngay', async () => {
    await call('POST', '/admin/market/emergency-halt', 'ops', { reason: 'Nghi tấn công' });
    expect(engine.control.haltAll).toBe(true);
    expect(await expireEmergencyIfDue({ db, store, io })).toBe(false);
    // khởi động lại máy chủ vẫn nhớ dừng khẩn
    const again = new AdminStore(db, new SpotEngine(db, market, { order: () => undefined, fill: () => undefined, account: () => undefined }));
    await again.load();
    expect(again.emergency?.reason).toBe('Nghi tấn công');
    expect(await expireEmergencyIfDue({ db, store, io }, Date.now() + 16 * 60_000)).toBe(true);
    expect(engine.control.haltAll).toBe(false);
    const a = await db.one<{ admin_id: string | null; admin_email: string }>(`SELECT admin_id, admin_email FROM admin_audit_log WHERE action = 'TRADING_EMERGENCY_EXPIRED' ORDER BY id DESC LIMIT 1`);
    expect(a).toMatchObject({ admin_id: null, admin_email: 'Hệ thống' });

    await call('POST', '/admin/market/emergency-halt', 'risk', { reason: 'Bấm nhầm' });
    expect((await call('POST', '/admin/market/emergency-halt/cancel', 'ops', { reason: 'Báo động nhầm' })).status).toBe(200);
    expect(engine.control.haltAll).toBe(false);
    expect((await call('POST', '/admin/market/emergency-halt/cancel', 'ops', { reason: 'Lần nữa' })).body.error.code).toBe('NO_EMERGENCY');
  });
});

describe('Giám sát gian lận bảng xếp hạng', () => {
  it('phát hiện chung IP, tự đặt lại liên tục, spam đặt / huỷ lệnh; loại khỏi bảng xếp hạng có lý do', async () => {
    for (const who of ['an', 'binh']) {
      await db.many(`INSERT INTO auth_events (user_id, email, event, ip) VALUES ($1, $2, 'LOGIN_OK', '203.0.113.7')`, [u[who]!.id, u[who]!.email]);
    }
    for (let i = 0; i < 3; i++) await db.many(`INSERT INTO auth_events (user_id, email, event, ip) VALUES ($1, $2, 'ACCOUNT_RESET', '198.51.100.1')`, [u.an!.id, u.an!.email]);
    for (let i = 0; i < 40; i++) {
      await db.many(`INSERT INTO order_events (order_id, user_id, event, actor) VALUES ($1, $2, 'PLACE', 'user')`, [100_000 + i, u.binh!.id]);
      await db.many(`INSERT INTO order_events (order_id, user_id, event, actor) VALUES ($1, $2, 'CANCEL', 'user')`, [100_000 + i, u.binh!.id]);
    }
    expect((await call('GET', '/admin/fraud', 'ops')).status).toBe(403);
    expect((await call('GET', '/admin/fraud', 'audit')).status).toBe(200);
    const rep = (await call<FraudReport>('GET', '/admin/fraud', 'risk')).body;
    const group = rep.sameIp.find((g) => g.ip === '203.0.113.7')!;
    expect(group.accounts.map((a) => a.email).sort()).toEqual([u.an!.email, u.binh!.email].sort());
    expect(rep.frequentResets.find((x) => x.account.id === u.an!.id)?.resets).toBe(3);
    expect(rep.orderSpam.find((x) => x.account.id === u.binh!.id)).toMatchObject({ placed: 40, cancelled: 40, cancelRatio: 1 });

    expect((await call('POST', `/admin/users/${u.an!.id}/leaderboard`, 'audit', { banned: true, reason: 'thử' })).status).toBe(403);
    expect((await call('POST', `/admin/users/${u.an!.id}/leaderboard`, 'risk', { banned: true })).status).toBe(400);
    expect((await call('POST', `/admin/users/${u.an!.id}/leaderboard`, 'risk', { banned: true, reason: 'Đặt lại tài khoản 3 lần để giữ kết quả đẹp' })).status).toBe(200);
    const after = (await call<FraudReport>('GET', '/admin/fraud', 'risk')).body;
    expect(after.banned.find((b) => b.id === u.an!.id)).toMatchObject({ leaderboardBanned: true, reason: 'Đặt lại tài khoản 3 lần để giữ kết quả đẹp' });
    // bảng xếp hạng loại tài khoản bị cấm (cùng điều kiện truy vấn trong routes/community.ts)
    const visible = await db.many<{ id: string }>(`SELECT id FROM users u WHERE u.role = 'USER' AND u.status = 'ACTIVE' AND u.leaderboard_banned_at IS NULL`);
    expect(visible.map((x) => x.id)).not.toContain(u.an!.id);
    expect(visible.map((x) => x.id)).toContain(u.binh!.id);
    expect((await call('POST', `/admin/users/${u.an!.id}/leaderboard`, 'risk', { banned: true, reason: 'Lần nữa' })).body.error.code).toBe('NO_CHANGE');
    expect((await call('POST', `/admin/users/${u.an!.id}/leaderboard`, 'risk', { banned: false, reason: 'Đã xác minh, cho lại' })).status).toBe(200);
    const actions = (await db.many<{ action: string }>(`SELECT action FROM admin_audit_log WHERE target_id = $1 AND action LIKE 'LEADERBOARD%' ORDER BY id`, [u.an!.id])).map((x) => x.action);
    expect(actions).toEqual(['LEADERBOARD_BAN', 'LEADERBOARD_UNBAN']);
  });
});

describe('Đối soát và doanh thu phí', () => {
  it('sau giao dịch thật không lệch; doanh thu phí khớp bảng khớp lệnh; sửa tay số dư thì bị phát hiện và báo Tài chính / Kiểm toán', async () => {
    // giao dịch: khớp ngay với sổ lệnh giả lập
    const ask = market.depth('BTCUSDT')!.asks[0]![0];
    const buy = await call('POST', '/orders', 'binh', { symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', price: new Big(ask).times(1.01).round(2).toFixed(), quantity: '0.01' });
    expect(buy.body.status).toBe('FILLED');
    const sell = await call('POST', '/orders', 'binh', { symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', quantity: '0.005' });
    expect(sell.status).toBe(201);
    // lệnh chờ đang khoá tiền
    await call('POST', '/orders', 'an', { symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', price: new Big(ask).times(0.9).round(2).toFixed(), quantity: '0.001' });

    expect((await call('POST', '/admin/finance/reconciliations', 'ops', {})).status).toBe(403);
    const clean = await call<ReconRunDTO>('POST', '/admin/finance/reconciliations', 'fin', {});
    expect(clean.body).toMatchObject({ ok: true, issueCount: 0, triggeredBy: u.fin!.email });
    expect(clean.body.balancesChecked).toBeGreaterThan(5);

    const rev = (await call<FeeRevenueReport>('GET', '/admin/finance/revenue?days=7', 'audit')).body;
    const fills = (await db.one<{ fee: string; n: number }>('SELECT COALESCE(sum(commission_usdt), 0)::text AS fee, count(*)::int AS n FROM fills'))!;
    expect(new Big(rev.totalFeeUsdt).eq(fills.fee)).toBe(true);
    expect(rev.days[0]!.fills).toBe(fills.n);
    expect(rev.bySymbol[0]!.symbol).toBe('BTCUSDT');

    // sửa tay CSDL (không ghi sổ cái) → lệch
    await db.many(`UPDATE balances SET free = free + 123 WHERE user_id = $1 AND asset = 'USDT'`, [u.binh!.id]);
    sent.length = 0;
    const bad = (await call<ReconRunDTO>('POST', '/admin/finance/reconciliations', 'audit', {})).body;
    expect(bad.ok).toBe(false);
    expect(bad.issues.filter((i) => i.userId === u.binh!.id).map((i) => i.kind).sort()).toEqual(['LAST_BALANCE_MISMATCH', 'LEDGER_MISMATCH']);
    expect(sent.map((m) => m.to).sort()).toEqual([u.audit!.email, u.fin!.email].sort());
    expect(sent[0]!.subject).toMatch(/phát hiện 2 chỗ lệch/);

    const runs = (await call<ReconRunDTO[]>('GET', '/admin/finance/reconciliations', 'fin')).body;
    expect(runs.map((x) => x.ok)).toEqual([false, true]);
  });
});
