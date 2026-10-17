import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express from 'express';
import bcrypt from 'bcryptjs';
import { Server } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Big, type TicketDetailDTO, type UserRole } from '@vss/shared';
import { exportBackup, parseBackup, restoreBackup, serializeBackup } from '../src/admin/backup';
import { adminRoutes } from '../src/admin/routes';
import { AdminStore } from '../src/admin/store';
import type { Database } from '../src/db';
import { initSessionCheck, signToken } from '../src/lib/auth';
import { totpCode } from '../src/lib/totp';
import { errorHandler } from '../src/lib/errors';
import type { MailMessage, Mailer } from '../src/lib/mailer';
import type { MarketService } from '../src/market/marketService';
import type { NavService } from '../src/portfolio/nav';
import { authRoutes } from '../src/routes/auth';
import { supportRoutes } from '../src/routes/support';
import { tradingRoutes } from '../src/routes/trading';
import { createUserAccount } from '../src/seed/seed';
import { deskRoutes } from '../src/support/desk';
import { SupportService } from '../src/support/service';
import { SpotEngine } from '../src/trading/engine';
import { closeTestDb, openTestDb } from './helpers/db';
import { FakeMarket, TEST_FILTERS } from './helpers/fakeMarket';

let db: Database;
let server: http.Server;
let base: string;
let market: FakeMarket;
let engine: SpotEngine;
let support: SupportService;
const sent: MailMessage[] = [];
const mailer: Mailer = { kind: 'smtp', send: async (m) => void sent.push(m) };
const BTC = 'BTCUSDT';

type U = { id: string; email: string; token: string };
let admin1: U;
let admin2: U;
/** Tài chính (điều chỉnh / duyệt số dư) và rủi ro (huỷ hộ lệnh) — Quản trị hệ thống không làm các việc này */
let fin1: U;
let fin2: U;
let risk: U;
let agent: U;
let alice: U;

async function call<T = any>(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function makeUser(email: string, role: UserRole, password = 'matkhau123'): Promise<U> {
  const hash = await bcrypt.hash(password, 4);
  const u = await db.tx((tx) => createUserAccount(tx, email, hash, email.split('@')[0]!));
  await db.many('UPDATE users SET role = $2, email_verified_at = now() WHERE id = $1', [u.id, role]);
  return { id: u.id, email, token: signToken({ id: u.id, email }) };
}

beforeAll(async () => {
  db = await openTestDb();
  initSessionCheck(db);
  await db.many(`INSERT INTO symbols (symbol, base_asset, quote_asset, name, filters) VALUES ('BTCUSDT','BTC','USDT','Bitcoin',$1)`, [JSON.stringify(TEST_FILTERS)]);
  market = new FakeMarket();
  market.add(BTC, 'BTC', '80000', [['79990', '1']], [['80010', '1']]);
  engine = new SpotEngine(db, market, { order: () => undefined, fill: () => undefined, account: () => undefined });
  await engine.load();
  const store = new AdminStore(db, engine);
  await store.load();
  const io = new Server();
  support = new SupportService(db, mailer);
  const mk = market as unknown as MarketService;
  const deps = { db, io, market: mk, engine, store, mailer };
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/auth', authRoutes(db, mailer));
  app.use('/api/admin', adminRoutes({ ...deps, onAdjustDecided: async (r) => void (r.ticketId && (await support.postSystem(r.ticketId, `duyệt #${r.id}: ${r.status}`, true))) }));
  app.use('/api/support-desk', deskRoutes({ ...deps, support }));
  app.use('/api', supportRoutes(support));
  app.use('/api', tradingRoutes(db, mk, engine, { history: async () => [] } as unknown as NavService));
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  admin1 = await makeUser('admin1@example.test', 'ADMIN');
  admin2 = await makeUser('admin2@example.test', 'ADMIN');
  agent = await makeUser('cskh@example.test', 'SUPPORT');
  fin1 = await makeUser('fin1@example.test', 'FINANCE');
  fin2 = await makeUser('fin2@example.test', 'FINANCE');
  risk = await makeUser('risk@example.test', 'RISK');
  alice = await makeUser('alice@example.test', 'USER');
});

afterAll(async () => {
  initSessionCheck(null);
  await new Promise((r) => server.close(r));
  await closeTestDb(db);
});

describe('Nhật ký quản trị chỉ được ghi thêm', () => {
  it('không sửa / xoá / TRUNCATE được; khôi phục sao lưu cũ KHÔNG làm mất nhật ký mới hơn', async () => {
    await db.many(`INSERT INTO admin_audit_log (admin_id, admin_email, action) VALUES ($1, $2, 'TRUOC_SAO_LUU')`, [admin1.id, admin1.email]);
    for (const sql of ['UPDATE admin_audit_log SET action = $1', 'DELETE FROM admin_audit_log', 'TRUNCATE admin_audit_log']) {
      await expect(db.many(sql, sql.includes('$1') ? ['X'] : [])).rejects.toThrow(/chỉ được ghi thêm/);
    }
    const backup = parseBackup(serializeBackup(await exportBackup(db, { exportedBy: 'test', tradeDate: '2026-10-17' })));
    await db.many(`INSERT INTO admin_audit_log (admin_id, admin_email, action) VALUES ($1, $2, 'SAU_SAO_LUU')`, [admin1.id, admin1.email]);
    await restoreBackup(db, backup, { dryRun: false, actor: { id: admin1.id, email: admin1.email } });
    const actions = (await db.many<{ action: string }>('SELECT action FROM admin_audit_log ORDER BY id')).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['TRUOC_SAO_LUU', 'SAU_SAO_LUU', 'DATA_RESTORE']));
  });
});

describe('Đăng nhập: nhật ký và chặn dò mật khẩu theo tài khoản', () => {
  it('sai 5 lần → chặn 15 phút kể cả đúng mật khẩu, email cảnh báo; nhật ký có IP', async () => {
    const bob = await makeUser('bob@example.test', 'USER', 'dungroi123');
    for (let i = 0; i < 5; i++) expect((await call('POST', '/auth/login', undefined, { email: bob.email, password: 'sai-mat-khau' })).status).toBe(401);
    const blocked = await call('POST', '/auth/login', undefined, { email: bob.email, password: 'dungroi123' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('LOGIN_BLOCKED');
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.some((m) => m.to === bob.email && /sai nhiều lần/.test(m.subject))).toBe(true);
    const events = (await call<any[]>('GET', '/auth/activity', bob.token)).body.map((e) => e.event);
    expect(events.filter((e) => e === 'LOGIN_FAIL')).toHaveLength(5);
    expect(events).toContain('LOGIN_BLOCKED');
  });

  it('đăng nhập đúng ghi LOGIN_OK; tài khoản bị khoá không đăng nhập được', async () => {
    const carol = await makeUser('carol@example.test', 'USER', 'dungroi123');
    expect((await call('POST', '/auth/login', undefined, { email: carol.email, password: 'dungroi123' })).status).toBe(200);
    expect((await call<any[]>('GET', '/auth/activity', carol.token)).body[0]).toMatchObject({ event: 'LOGIN_OK', label: 'Đăng nhập thành công' });
    await db.many(`UPDATE users SET status = 'LOCKED' WHERE id = $1`, [carol.id]);
    const r = await call('POST', '/auth/login', undefined, { email: carol.email, password: 'dungroi123' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('ACCOUNT_LOCKED');
  });
});

describe('Nhật ký lệnh', () => {
  it('đặt, sửa (liên kết lệnh cũ ↔ mới), huỷ của khách có IP; quản trị viên huỷ hộ ghi email', async () => {
    const placed = await call('POST', '/orders', alice.token, { symbol: BTC, side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', price: '70000', quantity: '0.01' });
    expect(placed.status).toBe(201);
    const replaced = await call('PUT', `/orders/${placed.body.id}`, alice.token, { price: '71000' });
    expect(replaced.status).toBe(200);
    const oldEv = (await call<any[]>('GET', `/orders/${placed.body.id}/events`, alice.token)).body;
    expect(oldEv.map((e) => e.event)).toEqual(['PLACE', 'REPLACE']);
    expect(oldEv[0]).toMatchObject({ actor: 'Khách hàng', ip: expect.stringMatching(/127\.0\.0\.1/) });
    expect(oldEv[1].detail).toMatchObject({ newOrderId: replaced.body.id, newPrice: '71000' });
    const newEv = (await call<any[]>('GET', `/orders/${replaced.body.id}/events`, alice.token)).body;
    expect(newEv[0].detail).toMatchObject({ replacesOrderId: placed.body.id });

    // Quản trị hệ thống không huỷ hộ lệnh; Rủi ro & giám sát được
    expect((await call('POST', `/admin/orders/${replaced.body.id}/cancel`, admin1.token, { reason: 'Kiểm tra huỷ hộ' })).status).toBe(403);
    const cancel = await call('POST', `/admin/orders/${replaced.body.id}/cancel`, risk.token, { reason: 'Kiểm tra huỷ hộ' });
    expect(cancel.status).toBe(200);
    const ev = (await call<any[]>('GET', `/admin/orders/${replaced.body.id}/events`, admin1.token)).body;
    expect(ev.at(-1)).toMatchObject({ event: 'CANCEL', actor: risk.email });
    // khách không xem được nhật ký lệnh của người khác
    expect((await call<any[]>('GET', `/orders/${placed.body.id}/events`, admin2.token)).body).toEqual([]);
  });
});

describe('Điều chỉnh số dư: không tự điều chỉnh, từ ngưỡng phải 2 người duyệt', () => {
  it('nhỏ thì áp dụng ngay; lớn thành yêu cầu, người tạo không tự duyệt, người khác duyệt mới cộng', async () => {
    // Quản trị hệ thống không đụng vào tiền
    expect((await call('POST', `/admin/users/${alice.id}/adjust-balance`, admin1.token, { asset: 'USDT', amount: '10', reason: 'thử' })).status).toBe(403);
    expect((await call('POST', `/admin/users/${fin1.id}/adjust-balance`, fin1.token, { asset: 'USDT', amount: '10', reason: 'tự cộng' })).body.error.code).toBe('SELF');
    const small = await call('POST', `/admin/users/${alice.id}/adjust-balance`, fin1.token, { asset: 'USDT', amount: '50', reason: 'Bồi hoàn nhỏ' });
    expect(small.status).toBe(200);
    const big = await call('POST', `/admin/users/${alice.id}/adjust-balance`, fin1.token, { asset: 'USDT', amount: '5000', reason: 'Bồi hoàn lớn' });
    expect(big.status).toBe(202);
    expect(big.body.request).toMatchObject({ status: 'PENDING', requestedByEmail: fin1.email });
    const before = await db.one<{ free: string }>(`SELECT free FROM balances WHERE user_id = $1 AND asset = 'USDT'`, [alice.id]);
    const self = await call('POST', `/admin/adjust-requests/${big.body.request.id}/approve`, fin1.token, {});
    expect(self.body.error.message).toMatch(/không được tự duyệt/i);
    // Quản trị hệ thống / Rủi ro không duyệt được tiền
    expect((await call('POST', `/admin/adjust-requests/${big.body.request.id}/approve`, admin2.token, {})).status).toBe(403);
    expect((await call('POST', `/admin/adjust-requests/${big.body.request.id}/approve`, risk.token, {})).status).toBe(403);
    const ok = await call('POST', `/admin/adjust-requests/${big.body.request.id}/approve`, fin2.token, {});
    expect(ok.body).toMatchObject({ status: 'APPROVED', decidedByEmail: fin2.email });
    const after = await db.one<{ free: string }>(`SELECT free FROM balances WHERE user_id = $1 AND asset = 'USDT'`, [alice.id]);
    expect(new Big(after!.free).minus(before!.free).toFixed()).toBe('5000');
    const audit = (await db.many<{ action: string }>(`SELECT action FROM admin_audit_log WHERE target_id = $1 ORDER BY id`, [alice.id])).map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['BALANCE_ADJUST', 'BALANCE_ADJUST_REQUEST', 'BALANCE_ADJUST_APPROVE']));
  });
});

describe('Xoá người dùng = ẩn danh, giữ hồ sơ giao dịch', () => {
  it('xoá thông tin cá nhân nhưng giữ lệnh, sổ cái; không thao tác tiếp được', async () => {
    const dan = await makeUser('dan@example.test', 'USER');
    await call('POST', '/orders', dan.token, { symbol: BTC, side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', price: '60000', quantity: '0.01' });
    const r = await call('DELETE', `/admin/users/${dan.id}`, admin1.token, { confirmEmail: dan.email });
    expect(r.body).toMatchObject({ ok: true, anonymized: true });
    const u = await db.one<{ email: string; full_name: string; status: string }>('SELECT email, full_name, status FROM users WHERE id = $1', [dan.id]);
    expect(u).toMatchObject({ status: 'DELETED', full_name: 'Người dùng đã xoá' });
    expect(u!.email).not.toContain('dan@');
    expect((await db.one<{ n: number }>('SELECT count(*)::int AS n FROM orders WHERE user_id = $1', [dan.id]))!.n).toBe(1);
    expect((await db.one<{ n: number }>('SELECT count(*)::int AS n FROM ledger WHERE user_id = $1', [dan.id]))!.n).toBeGreaterThan(0);
    expect((await call('POST', `/admin/users/${dan.id}/lock`, admin1.token, { reason: 'thử' })).body.error.code).toBe('DELETED');
    // Dòng users vẫn còn (ẩn danh) → phiên đăng nhập cũ phải bị thu hồi, không đặt lệnh tiếp được
    expect((await call('GET', '/account', dan.token)).status).toBe(401);
    expect((await call('POST', '/orders', dan.token, { symbol: BTC, side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', price: '60000', quantity: '0.01' })).status).toBe(401);
  });
});

describe('Tài khoản bị khoá vẫn nhắn được CSKH (vé hỗ trợ)', () => {
  it('đúng mật khẩu → không có phiên, chỉ vé hỗ trợ: gửi được yêu cầu, không giao dịch được; nhân viên được nhắc xác minh', async () => {
    const eve = await makeUser('eve@example.test', 'USER', 'dungroi123');
    await db.many(`UPDATE users SET status = 'LOCKED' WHERE id = $1`, [eve.id]);
    expect((await call('POST', '/auth/login', undefined, { email: eve.email, password: 'sai-mat-khau' })).body.error.supportToken).toBeUndefined();
    const r = await call('POST', '/auth/login', undefined, { email: eve.email, password: 'dungroi123' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(r.body.token).toBeUndefined();
    const pass: string = r.body.error.supportToken;
    expect(pass).toEqual(expect.any(String));
    // vé hỗ trợ không phải phiên đăng nhập
    expect((await call('GET', '/account', pass)).status).toBe(401);
    expect((await call('GET', '/auth/me', pass)).status).toBe(401);
    expect((await call('GET', '/support-desk/stats', pass)).status).toBe(401);

    const t = await call<TicketDetailDTO>('POST', '/support/tickets', pass, { subject: 'Tài khoản bị khoá', category: 'ACCOUNT', message: 'Tôi không đăng nhập được' });
    expect(t.status).toBe(201);
    // đang bị khoá thì không làm gì được → tối thiểu ưu tiên Cao dù mục "Tài khoản" bình thường là ưu tiên thường
    expect(t.body.ticket.priority).toBe('HIGH');
    const id = t.body.ticket.id;
    // ghi chú nội bộ nhắc xác minh chính chủ: nhân viên thấy, khách không thấy
    const staffView = (await call('GET', `/support-desk/tickets/${id}`, agent.token)).body;
    expect(staffView.ticket.customer.status).toBe('LOCKED');
    expect(staffView.messages.some((m: any) => m.internal && /đang bị khoá/.test(m.body))).toBe(true);
    await call('POST', `/support-desk/tickets/${id}/messages`, agent.token, { body: 'Bạn hãy đặt lại mật khẩu qua email để xác minh.' });
    const mine = (await call<TicketDetailDTO>('GET', `/support/tickets/${id}`, pass)).body;
    expect(mine.messages.some((m) => m.internal)).toBe(false);
    expect(mine.messages.at(-1)!.body).toContain('đặt lại mật khẩu');
    expect((await call('POST', `/support/tickets/${id}/messages`, pass, { body: 'Đã đặt lại' })).status).toBe(200);

    // Đặt lại mật khẩu qua email: đổi được mật khẩu nhưng vẫn không có phiên; vé hỗ trợ cũ bị thu hồi, nhận vé mới
    await call('POST', '/auth/forgot-password', undefined, { email: eve.email });
    await new Promise((res) => setTimeout(res, 20));
    const link = sent.filter((m) => m.to === eve.email && m.text.includes('/reset-password?token=')).at(-1)!.text;
    const resetToken = /token=([\w-]+)/.exec(link)![1]!;
    const reset = await call('POST', '/auth/reset-password', undefined, { token: resetToken, password: 'matkhaumoi123' });
    expect(reset.status).toBe(403);
    expect(reset.body.error.message).toMatch(/Đã đặt lại mật khẩu/);
    expect((await call('GET', '/support/tickets', pass)).status).toBe(401);
    expect((await call('GET', '/support/tickets', reset.body.error.supportToken)).body).toHaveLength(1);
    const events = (await db.many<{ event: string }>('SELECT event FROM auth_events WHERE user_id = $1 ORDER BY id', [eve.id])).map((e) => e.event);
    expect(events).toEqual(expect.arrayContaining(['LOGIN_LOCKED_ACCOUNT', 'PASSWORD_RESET']));
  });

  it('bật 2FA thì phải qua bước mã mới nhận vé hỗ trợ', async () => {
    const fay = await makeUser('fay@example.test', 'USER', 'dungroi123');
    const secret: string = (await call('POST', '/auth/2fa/setup', fay.token, { password: 'dungroi123' })).body.secret;
    expect((await call('POST', '/auth/2fa/enable', fay.token, { code: totpCode(secret) })).status).toBe(200);
    await db.many(`UPDATE users SET status = 'LOCKED' WHERE id = $1`, [fay.id]);
    const l = await call('POST', '/auth/login', undefined, { email: fay.email, password: 'dungroi123' });
    expect(l.status).toBe(200);
    expect(l.body).toMatchObject({ mfaRequired: true });
    expect(l.body.token).toBeUndefined();
    expect((await call('GET', '/support/tickets', l.body.mfaToken)).status).toBe(401);
    expect((await call('POST', '/auth/login/2fa', undefined, { mfaToken: l.body.mfaToken, code: '000000' })).body.error.code).toBe('MFA_INVALID');
    const ok = await call('POST', '/auth/login/2fa', undefined, { mfaToken: l.body.mfaToken, code: totpCode(secret, Date.now() + 30_000) });
    expect(ok.status).toBe(403);
    expect(ok.body.token).toBeUndefined();
    expect((await call('GET', '/support/tickets', ok.body.error.supportToken)).status).toBe(200);
  });
});

describe('Chatbox CSKH', () => {
  let ticketId: number;
  let orderId: number;

  it('khách gửi yêu cầu gắn lệnh → ưu tiên Cao, có tin nhắn hệ thống báo hạn trả lời', async () => {
    const o = await call('POST', '/orders', alice.token, { symbol: BTC, side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', price: '65000', quantity: '0.01' });
    orderId = o.body.id;
    const r = await call<TicketDetailDTO>('POST', '/support/tickets', alice.token, {
      subject: 'Lệnh treo không huỷ được',
      category: 'ORDER',
      message: 'Tôi bấm huỷ nhưng lệnh vẫn còn',
      orderId,
    });
    expect(r.status).toBe(201);
    ticketId = r.body.ticket.id;
    expect(r.body.ticket).toMatchObject({ priority: 'HIGH', status: 'OPEN', orderId });
    expect(r.body.messages.map((m) => m.authorKind)).toEqual(['CUSTOMER', 'SYSTEM']);
    // không gắn được lệnh của người khác
    expect((await call('POST', '/support/tickets', admin2.token, { subject: 'Thử lệnh', category: 'ORDER', message: 'x', orderId })).status).toBe(400);
  });

  it('phân quyền: CSKH vào khu CSKH được nhưng không vào khu quản trị; khách không vào khu CSKH', async () => {
    expect((await call('GET', '/support-desk/tickets', agent.token)).status).toBe(200);
    expect((await call('GET', '/admin/users', agent.token)).status).toBe(403);
    expect((await call('GET', '/support-desk/tickets', alice.token)).status).toBe(403);
  });

  it('nhân viên xem hồ sơ khách qua yêu cầu (có ghi nhật ký), trả lời, ghi chú nội bộ khách không thấy', async () => {
    const list = await call<any[]>('GET', '/support-desk/tickets?scope=unassigned', agent.token);
    expect(list.body.map((t) => t.id)).toContain(ticketId);
    const d = await call('GET', `/support-desk/tickets/${ticketId}`, agent.token);
    expect(d.body.customer.openOrders.map((o: { id: number }) => o.id)).toContain(orderId);
    expect(d.body.linkedOrder.events.map((e: { event: string }) => e.event)).toEqual(['PLACE']);
    expect((await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM admin_audit_log WHERE action = 'USER_VIEW' AND admin_email = $1 AND target_id = $2`, [agent.email, alice.id]))!.n).toBe(1);

    await call('POST', `/support-desk/tickets/${ticketId}/messages`, agent.token, { body: 'Ghi chú: kiểm tra log', internal: true });
    const reply = await call('POST', `/support-desk/tickets/${ticketId}/messages`, agent.token, { body: 'Chào chị, em kiểm tra ngay ạ' });
    expect(reply.body.ticket).toMatchObject({ status: 'IN_PROGRESS', assigneeEmail: agent.email });
    expect(reply.body.ticket.firstResponseAt).not.toBeNull();
    const mine = await call<TicketDetailDTO>('GET', `/support/tickets/${ticketId}`, alice.token);
    expect(mine.body.messages.some((m) => m.body.includes('Ghi chú'))).toBe(false);
    expect(mine.body.messages.at(-1)).toMatchObject({ authorKind: 'STAFF', authorName: 'Nhân viên CSKH' });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.some((m) => m.to === alice.email && /#\d+/.test(m.subject))).toBe(true);
  });

  it('huỷ hộ lệnh qua yêu cầu (chỉ lệnh của chính khách đó), đề xuất bồi hoàn chờ quản trị viên duyệt', async () => {
    const c = await call('POST', `/support-desk/tickets/${ticketId}/cancel-order`, agent.token, { orderId, reason: 'Khách không huỷ được' });
    expect(c.body.order.status).toBe('CANCELED');
    const ev = (await call<any[]>('GET', `/orders/${orderId}/events`, alice.token)).body;
    expect(ev.at(-1)).toMatchObject({ event: 'CANCEL', actor: agent.email });
    expect(c.body.ticket.messages.some((m: { body: string }) => m.body.includes(`huỷ hộ lệnh #${orderId}`))).toBe(true);

    const adj = await call('POST', `/support-desk/tickets/${ticketId}/adjust-request`, agent.token, { asset: 'USDT', amount: '20', reason: 'Bồi hoàn phí' });
    expect(adj.status).toBe(201);
    expect(adj.body.request).toMatchObject({ status: 'PENDING', ticketId });
    // CSKH không tự duyệt được (không vào khu quản trị)
    expect((await call('POST', `/admin/adjust-requests/${adj.body.request.id}/approve`, agent.token, {})).status).toBe(403);
    expect((await call('POST', `/admin/adjust-requests/${adj.body.request.id}/approve`, fin1.token, {})).body.status).toBe('APPROVED');
    const staffView = await call('GET', `/support-desk/tickets/${ticketId}`, agent.token);
    expect(staffView.body.messages.some((m: { body: string }) => m.body.includes(`duyệt #${adj.body.request.id}: APPROVED`))).toBe(true);
  });

  it('đóng phải ghi cách xử lý; khách đánh giá; khách nhắn lại thì yêu cầu mở lại', async () => {
    expect((await call('POST', `/support-desk/tickets/${ticketId}/update`, agent.token, { status: 'RESOLVED' })).status).toBe(400);
    const done = await call('POST', `/support-desk/tickets/${ticketId}/update`, agent.token, { status: 'RESOLVED', resolution: 'Đã huỷ hộ lệnh và hoàn phí 20 USDT' });
    expect(done.body.ticket).toMatchObject({ status: 'RESOLVED', resolution: 'Đã huỷ hộ lệnh và hoàn phí 20 USDT' });
    const rated = await call<TicketDetailDTO>('POST', `/support/tickets/${ticketId}/rate`, alice.token, { rating: 5, comment: 'Nhanh' });
    expect(rated.body.ticket.rating).toBe(5);
    const reopen = await call<TicketDetailDTO>('POST', `/support/tickets/${ticketId}/messages`, alice.token, { body: 'Còn 1 lệnh khác nữa' });
    expect(reopen.body.ticket.status).toBe('IN_PROGRESS');
    // tin nhắn hỗ trợ là bằng chứng: không sửa / xoá được
    await expect(db.many('DELETE FROM support_messages WHERE ticket_id = $1', [ticketId])).rejects.toThrow(/chỉ được ghi thêm/);
  });

  it('quá hạn trả lời được đếm để cảnh báo vận hành; yêu cầu đã xử lý tự đóng sau 7 ngày', async () => {
    await db.many(`UPDATE support_tickets SET customer_waiting_since = now() - interval '2 hours' WHERE id = $1`, [ticketId]);
    await support.housekeeping();
    expect(support.overdueCount()).toBe(1);
    const overdue = await call<any[]>('GET', '/support-desk/tickets?scope=overdue', agent.token);
    expect(overdue.body.map((t) => t.id)).toContain(ticketId);
    await db.many(`UPDATE support_tickets SET status = 'RESOLVED', resolved_at = now() - interval '8 days', customer_waiting_since = NULL WHERE id = $1`, [ticketId]);
    await support.housekeeping();
    expect((await db.one<{ status: string }>('SELECT status FROM support_tickets WHERE id = $1', [ticketId]))!.status).toBe('CLOSED');
    expect((await call('POST', `/support/tickets/${ticketId}/messages`, alice.token, { body: 'thêm' })).status).toBe(400);
  });
});
