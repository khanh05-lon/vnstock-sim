import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import express from 'express';
import bcrypt from 'bcryptjs';
import { Server } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyVipRules, type AccountDTO, type PrivacyRequestDTO, type UserRole, type VipStatusDTO } from '@vss/shared';
import { runReconciliation } from '../src/admin/reconcile';
import { adminRoutes } from '../src/admin/routes';
import { AdminStore } from '../src/admin/store';
import type { Database } from '../src/db';
import { initSessionCheck, signToken } from '../src/lib/auth';
import { errorHandler } from '../src/lib/errors';
import type { Mailer } from '../src/lib/mailer';
import { sealSecret } from '../src/lib/secretBox';
import type { MarketService } from '../src/market/marketService';
import type { NavService } from '../src/portfolio/nav';
import { privacyRoutes } from '../src/privacy/routes';
import { PrivacyService } from '../src/privacy/service';
import { tradingRoutes } from '../src/routes/trading';
import { createUserAccount } from '../src/seed/seed';
import { deskRoutes } from '../src/support/desk';
import { SupportService } from '../src/support/service';
import { SpotEngine } from '../src/trading/engine';
import { VipService, vipRoutes } from '../src/trading/vip';
import { credit, ledger } from '../src/trading/wallet';
import { closeTestDb, openTestDb } from './helpers/db';
import { FakeMarket, TEST_FILTERS } from './helpers/fakeMarket';

let db: Database;
let server: http.Server;
let base: string;
let support: SupportService;
let vip: VipService;
const mailer: Mailer = { kind: 'smtp', send: async () => undefined };
const BTC = 'BTCUSDT';

type U = { id: string; email: string; token: string };
let admin: U;
let agent: U;
let agent2: U;
let lead: U;
let fin: U;
let dpo: U;
let ann: U;
let erin: U;
let carl: U;

async function call<T = any>(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function makeUser(email: string, role: UserRole = 'USER'): Promise<U> {
  const hash = await bcrypt.hash('matkhau123', 4);
  const u = await db.tx((tx) => createUserAccount(tx, email, hash, email.split('@')[0]!));
  await db.many('UPDATE users SET role = $2, email_verified_at = now() WHERE id = $1', [u.id, role]);
  return { id: u.id, email, token: signToken({ id: u.id, email }) };
}

/** Khách đã KYC cấp 1 với số giấy tờ (giả lập) kết thúc bằng 2345 */
async function giveKyc(u: U) {
  await db.many(`UPDATE users SET kyc_level = 1, kyc_name = 'Nguyen Van Thu' WHERE id = $1`, [u.id]);
  await db.many(`INSERT INTO kyc_applications (user_id, level, status, data_enc, id_hash, id_last4) VALUES ($1, 1, 'APPROVED', $2, $3, '2345')`, [
    u.id,
    sealSecret(JSON.stringify({ fullName: 'Nguyen Van Thu', idType: 'CCCD', idNumber: '001095012345' })),
    `h-${u.id}`,
  ]);
}

async function addUsdt(u: U, amount: string) {
  await db.tx(async (tx) => {
    const after = await credit(tx, u.id, 'USDT', amount);
    await ledger(tx, u.id, 'USDT', 'ADJUST', amount, after, null, 'test');
  });
}

beforeAll(async () => {
  db = await openTestDb();
  initSessionCheck(db);
  await db.many(`INSERT INTO symbols (symbol, base_asset, quote_asset, name, filters) VALUES ('BTCUSDT','BTC','USDT','Bitcoin',$1)`, [JSON.stringify(TEST_FILTERS)]);
  await db.many(`INSERT INTO symbols (symbol, base_asset, quote_asset, name, filters) VALUES ('BNBUSDT','BNB','USDT','BNB',$1)`, [JSON.stringify(TEST_FILTERS)]);
  const market = new FakeMarket();
  market.add(BTC, 'BTC', '80000', [['79990', '5']], [['80010', '5']]);
  market.add('BNBUSDT', 'BNB', '600', [['599', '100']], [['601', '100']]);
  const engine = new SpotEngine(db, market, { order: () => undefined, fill: () => undefined, account: () => undefined });
  await engine.load();
  const store = new AdminStore(db, engine);
  await store.load();
  support = new SupportService(db, mailer);
  vip = new VipService(db);
  const mk = market as unknown as MarketService;
  const io = new Server();
  const deps = { db, io, market: mk, engine, store, mailer, vip };
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes(deps));
  app.use('/api/support-desk', deskRoutes({ ...deps, support }));
  app.use('/api', privacyRoutes(new PrivacyService(db)));
  app.use('/api', vipRoutes(vip));
  app.use('/api', tradingRoutes(db, mk, engine, { history: async () => [] } as unknown as NavService));
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  admin = await makeUser('it@roles.test', 'ADMIN');
  agent = await makeUser('cskh@roles.test', 'SUPPORT');
  agent2 = await makeUser('cskh2@roles.test', 'SUPPORT');
  lead = await makeUser('lead@roles.test', 'SUPPORT_LEAD');
  fin = await makeUser('fin@roles.test', 'FINANCE');
  dpo = await makeUser('dpo@roles.test', 'DPO');
  ann = await makeUser('ann@roles.test');
  erin = await makeUser('erin@roles.test');
  carl = await makeUser('carl@roles.test');
});

afterAll(async () => {
  applyVipRules(null);
  initSessionCheck(null);
  await new Promise((r) => server.close(r));
  await closeTestDb(db);
});

describe('Trưởng nhóm CSKH', () => {
  let ticketId: number;

  it('Quản trị hệ thống (IT) không còn vào khu CSKH; chỉ Trưởng nhóm giao việc cho người khác', async () => {
    expect((await call('GET', '/support-desk/tickets', admin.token)).status).toBe(403);
    const t = await support.create(ann.id, { subject: 'Mất điện thoại', category: 'SECURITY', message: 'Tôi mất điện thoại nên không đăng nhập được 2FA' });
    ticketId = t.ticket.id;
    expect((await call('POST', `/support-desk/tickets/${ticketId}/assign`, agent.token, { assigneeId: agent2.id })).body.error.message).toMatch(/Trưởng nhóm CSKH/);
    expect((await call('POST', `/support-desk/tickets/${ticketId}/assign`, lead.token, { assigneeId: agent2.id })).status).toBe(200);
  });

  it('khôi phục 2FA: chỉ Trưởng nhóm, phải khớp 4 số cuối giấy tờ KYC; sai thì ghi nhật ký', async () => {
    await db.many(`UPDATE users SET totp_secret = 'plain:ABC', totp_enabled_at = now() WHERE id = $1`, [ann.id]);
    const body = { idLast4: '2345', nameConfirmed: true, reason: 'Khách mất điện thoại, đã gọi xác minh' };
    expect((await call('POST', `/support-desk/tickets/${ticketId}/reset-2fa`, agent.token, body)).status).toBe(403);
    // Chưa KYC thì không đối chiếu được
    expect((await call('POST', `/support-desk/tickets/${ticketId}/reset-2fa`, lead.token, body)).body.error.code).toBe('NO_KYC');
    await giveKyc(ann);
    const wrong = await call('POST', `/support-desk/tickets/${ticketId}/reset-2fa`, lead.token, { ...body, idLast4: '9999' });
    expect(wrong.body.error.code).toBe('IDENTITY_MISMATCH');
    const failed = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM admin_audit_log WHERE action = 'USER_RECOVERY_FAILED' AND target_id = $1`, [ann.id]);
    expect(failed!.n).toBe(1);
    expect((await call('POST', `/support-desk/tickets/${ticketId}/reset-2fa`, lead.token, body)).body.ok).toBe(true);
    const u = await db.one<{ totp_enabled_at: Date | null }>('SELECT totp_enabled_at FROM users WHERE id = $1', [ann.id]);
    expect(u!.totp_enabled_at).toBeNull();
    // Route cũ ở khu quản trị đã bị gỡ
    const old = await fetch(`${base}/admin/users/${ann.id}/reset-2fa`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` }, body: '{"reason":"thử"}' });
    expect(old.status).toBe(404);
  });

  it('bồi hoàn: Trưởng nhóm duyệt khoản nhỏ; vượt hạn mức hoặc tự duyệt thì không; Tài chính vẫn duyệt được', async () => {
    const small = await call('POST', `/support-desk/tickets/${ticketId}/adjust-request`, agent.token, { asset: 'USDT', amount: '50', reason: 'Bồi hoàn lỗi hiển thị' });
    const big = await call('POST', `/support-desk/tickets/${ticketId}/adjust-request`, agent.token, { asset: 'USDT', amount: '500', reason: 'Bồi hoàn lớn' });
    const own = await call('POST', `/support-desk/tickets/${ticketId}/adjust-request`, lead.token, { asset: 'USDT', amount: '10', reason: 'Trưởng nhóm tự đề xuất' });
    const list = await call('GET', '/support-desk/compensations', lead.token);
    expect(list.body.limitUsdt).toBe(100);
    expect(list.body.items.find((x: { id: number }) => x.id === big.body.request.id).leadCanApprove).toBe(false);
    expect((await call('GET', '/support-desk/compensations', agent.token)).status).toBe(403);

    expect((await call('POST', `/support-desk/compensations/${big.body.request.id}/approve`, lead.token, {})).body.error.code).toBe('OVER_LIMIT');
    expect((await call('POST', `/support-desk/compensations/${own.body.request.id}/approve`, lead.token, {})).body.error.code).toBe('SELF');
    expect((await call('POST', `/support-desk/compensations/${small.body.request.id}/approve`, lead.token, {})).body.status).toBe('APPROVED');
    expect((await call('POST', `/admin/adjust-requests/${big.body.request.id}/approve`, fin.token, {})).body.status).toBe('APPROVED');
    const usdt = await db.one<{ free: string }>(`SELECT free::text FROM balances WHERE user_id = $1 AND asset = 'USDT'`, [ann.id]);
    expect(Number(usdt!.free)).toBe(10550);
  });
});

describe('Bảo vệ dữ liệu cá nhân (DPO)', () => {
  it('khách tải dữ liệu của mình: có hồ sơ KYC nhưng số giấy tờ chỉ 4 số cuối; tối đa 3 lần / ngày', async () => {
    await giveKyc(erin);
    const r = await call('GET', '/privacy/export', erin.token);
    expect(r.status).toBe(200);
    expect(r.body.profile).toMatchObject({ email: erin.email, kyc_level: 1 });
    expect(r.body.kyc[0].data.idNumber).toBe('•••••2345');
    expect(JSON.stringify(r.body)).not.toContain('001095012345');
    await call('GET', '/privacy/export', erin.token);
    await call('GET', '/privacy/export', erin.token);
    expect((await call('GET', '/privacy/export', erin.token)).status).toBe(429);
  });

  it('yêu cầu xoá: Quản trị hệ thống không xử lý; DPO chỉ chấp thuận khi đủ điều kiện; xoá = ẩn danh, giữ giao dịch', async () => {
    await call('POST', '/orders', erin.token, { symbol: BTC, side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', price: '60000', quantity: '0.01' });
    const req = await call<PrivacyRequestDTO>('POST', '/privacy/requests', erin.token, { reason: 'Không dùng nữa' });
    expect(req.body.status).toBe('PENDING');
    expect((await call('POST', '/privacy/requests', erin.token, { reason: 'Gửi lại lần nữa' })).body.error.code).toBe('PENDING');
    expect((await call('GET', '/admin/privacy/requests', admin.token)).status).toBe(403);
    expect((await call('DELETE', `/admin/users/${erin.id}`, admin.token, { confirmEmail: erin.email })).status).toBe(403);

    // Có nghĩa vụ giữ tài khoản (bị Tuân thủ hạn chế) → không xoá được
    await db.many('UPDATE users SET aml_restricted_at = now() WHERE id = $1', [erin.id]);
    const pending = (await call<PrivacyRequestDTO[]>('GET', '/admin/privacy/requests', dpo.token)).body.find((x) => x.userId === erin.id)!;
    expect(pending.checks!.find((c) => c.key === 'hold')).toMatchObject({ ok: false });
    expect((await call('POST', `/admin/privacy/requests/${pending.id}/decide`, dpo.token, { approve: true })).body.error.code).toBe('CHECKS');
    await db.many('UPDATE users SET aml_restricted_at = NULL WHERE id = $1', [erin.id]);

    expect((await call('POST', `/admin/privacy/requests/${pending.id}/decide`, dpo.token, { approve: true })).body.ok).toBe(true);
    const u = await db.one<{ status: string; email: string; kyc_name: string | null }>('SELECT status, email, kyc_name FROM users WHERE id = $1', [erin.id]);
    expect(u).toMatchObject({ status: 'DELETED', kyc_name: null });
    expect(u!.email).toMatch(/deleted\.invalid$/);
    const orders = await db.one<{ n: number }>('SELECT count(*)::int AS n FROM orders WHERE user_id = $1', [erin.id]);
    expect(orders!.n).toBe(1);
    expect((await call('GET', '/account', erin.token)).status).toBe(401);
  });
});

describe('Cấp VIP phí (Spot)', () => {
  it('đủ khối lượng mà thiếu BNB vẫn VIP 0; đủ cả hai lên VIP 1; lệnh mới chốt phí theo cấp', async () => {
    await addUsdt(carl, '20000');
    // ~10.400 USDT khối lượng (ngưỡng VIP 1 thu nhỏ = 10.000 USDT + 0,25 BNB)
    expect((await call('POST', '/orders', carl.token, { symbol: BTC, side: 'BUY', type: 'MARKET', quantity: '0.13' })).status).toBe(201);
    await vip.recomputeAll();
    expect((await call<VipStatusDTO>('GET', '/vip', carl.token)).body).toMatchObject({ level: 0 });

    expect((await call('POST', '/orders', carl.token, { symbol: 'BNBUSDT', side: 'BUY', type: 'MARKET', quantity: '0.5' })).status).toBe(201);
    await vip.recomputeAll();
    const st = await call<VipStatusDTO>('GET', '/vip', carl.token);
    expect(st.body).toMatchObject({ level: 1, maker: '0.0009', taker: '0.001' });
    expect((await call<AccountDTO>('GET', '/account', carl.token)).body).toMatchObject({ vipLevel: 1, makerFee: '0.0009' });

    const o = await call('POST', '/orders', carl.token, { symbol: BTC, side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', price: '70000', quantity: '0.01' });
    const row = await db.one<{ maker_fee: string; taker_fee: string }>('SELECT maker_fee::text, taker_fee::text FROM orders WHERE id = $1', [o.body.orderId ?? o.body.id]);
    expect(Number(row!.maker_fee)).toBe(0.0009);
    expect(Number(row!.taker_fee)).toBe(0.001);
  });

  it('Vận hành thị trường đổi hệ số ngưỡng rồi tính lại ngay; IT thì không; đối soát vẫn sạch', async () => {
    const ops = await makeUser('ops@roles.test', 'MARKET_OPS');
    expect((await call('PUT', '/admin/vip/rules', admin.token, { scale: 1 })).status).toBe(403);
    expect((await call('PUT', '/admin/vip/rules', ops.token, { scale: 1 })).body.rules.scale).toBe(1);
    expect((await call('POST', '/admin/vip/recompute', ops.token)).body.changed).toBeGreaterThanOrEqual(1);
    expect((await call<VipStatusDTO>('GET', '/vip', carl.token)).body.level).toBe(0);
    await call('DELETE', '/admin/vip/rules', ops.token);
    const fees = await call('GET', '/fees');
    expect(fees.body.tiers[1]).toMatchObject({ level: 1, volumeUsdt: 10000, bnb: 0.25 });
    expect((await runReconciliation(db, 'test')).issues).toEqual([]);
  });
});
