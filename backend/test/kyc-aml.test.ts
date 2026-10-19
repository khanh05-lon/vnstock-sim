import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import express from 'express';
import bcrypt from 'bcryptjs';
import { Server } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyAmlRules, applyP2PRules, type AmlAlertDTO, type KycApplicationDTO, type MyKycDTO, type P2PAdDTO, type P2POrderDTO, type UserRole } from '@vss/shared';
import { adminRoutes } from '../src/admin/routes';
import { AdminStore } from '../src/admin/store';
import type { Database } from '../src/db';
import { initSessionCheck, signToken } from '../src/lib/auth';
import { errorHandler } from '../src/lib/errors';
import type { Mailer } from '../src/lib/mailer';
import { kycRoutes } from '../src/kyc/routes';
import { KycService } from '../src/kyc/service';
import type { MarketService } from '../src/market/marketService';
import { BankService } from '../src/p2p/bank';
import { p2pRoutes } from '../src/p2p/routes';
import { P2PService } from '../src/p2p/service';
import type { NavService } from '../src/portfolio/nav';
import { tradingRoutes } from '../src/routes/trading';
import { createUserAccount } from '../src/seed/seed';
import { SpotEngine } from '../src/trading/engine';
import { credit, ledger, lockFunds } from '../src/trading/wallet';
import { closeTestDb, openTestDb } from './helpers/db';
import { FakeMarket, TEST_FILTERS } from './helpers/fakeMarket';

let db: Database;
let server: http.Server;
let base: string;
const mailer: Mailer = { kind: 'smtp', send: async () => undefined };

type U = { id: string; email: string; token: string };
let comp1: U;
let comp2: U;
let mlro: U;
let auditor: U;
let risk: U;
let mer: U;
let alice: U;
let bob: U;
let carol: U;

async function call<T = any>(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function makeUser(email: string, role: UserRole = 'USER', fullName = email.split('@')[0]!): Promise<U> {
  const hash = await bcrypt.hash('matkhau123', 4);
  const u = await db.tx((tx) => createUserAccount(tx, email, hash, fullName));
  await db.many('UPDATE users SET role = $2, email_verified_at = now() WHERE id = $1', [u.id, role]);
  return { id: u.id, email, token: signToken({ id: u.id, email }) };
}

const LEVEL1 = { fullName: 'Nguyễn Văn An', dateOfBirth: '1995-04-12', nationality: 'Việt Nam', idType: 'CCCD', idNumber: '001095012345', idIssuedDate: '2021-06-01', isPep: false };

beforeAll(async () => {
  db = await openTestDb();
  initSessionCheck(db);
  await db.many(`INSERT INTO symbols (symbol, base_asset, quote_asset, name, filters) VALUES ('BTCUSDT','BTC','USDT','Bitcoin',$1)`, [JSON.stringify(TEST_FILTERS)]);
  const market = new FakeMarket();
  market.add('BTCUSDT', 'BTC', '80000', [['79990', '1']], [['80010', '1']]);
  const engine = new SpotEngine(db, market, { order: () => undefined, fill: () => undefined, account: () => undefined });
  await engine.load();
  const store = new AdminStore(db, engine);
  await store.load();
  const p2p = new P2PService(db, market);
  const kyc = new KycService(db);
  const mk = market as unknown as MarketService;
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes({ db, io: new Server(), market: mk, engine, store, mailer, p2p, kyc }));
  app.use('/api', p2pRoutes(p2p, new BankService(db)));
  app.use('/api', kycRoutes(kyc));
  app.use('/api', tradingRoutes(db, mk, engine, { history: async () => [] } as unknown as NavService));
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  comp1 = await makeUser('comp1@kyc.test', 'COMPLIANCE');
  comp2 = await makeUser('comp2@kyc.test', 'COMPLIANCE');
  mlro = await makeUser('mlro@kyc.test', 'MLRO');
  auditor = await makeUser('audit@kyc.test', 'AUDITOR');
  risk = await makeUser('risk@kyc.test', 'RISK');
  mer = await makeUser('mer@kyc.test', 'USER', 'Thương nhân Một');
  alice = await makeUser('alice@kyc.test', 'USER', 'An Nguyen');
  bob = await makeUser('bob@kyc.test');
  carol = await makeUser('carol@kyc.test');
  applyP2PRules({ require2fa: false, minAccountDays: 0, minCompletedOrders: 0, appealAfterMinutes: 0 });

  // Thương nhân sẵn sàng: KYC cấp 2, đã duyệt, cọc khoá
  await db.many(`UPDATE users SET kyc_level = 2, kyc_name = full_name WHERE id = $1`, [mer.id]);
  await db.tx(async (tx) => {
    // Thêm USDT để đủ hàng cho kịch bản vượt hạn mức (ghi sổ cái như điều chỉnh)
    const after = await credit(tx, mer.id, 'USDT', '20000');
    await ledger(tx, mer.id, 'USDT', 'ADJUST', '20000', after, null, 'test');
    await lockFunds(tx, mer.id, 'USDT', '2000');
    await tx.many(`INSERT INTO p2p_merchants (user_id, status, deposit_usdt) VALUES ($1, 'ACTIVE', 2000)`, [mer.id]);
  });
});

afterAll(async () => {
  applyP2PRules(null);
  applyAmlRules(null);
  initSessionCheck(null);
  await new Promise((r) => server.close(r));
  await closeTestDb(db);
});

let sellAd: P2PAdDTO;
let aliceOrder: P2POrderDTO;

describe('KYC theo cấp', () => {
  it('kiểm tra dữ liệu khai báo: đủ 18 tuổi, CCCD 12 số; cấp 2 cần cấp 1 trước', async () => {
    expect((await call('POST', '/kyc/level1', alice.token, { ...LEVEL1, dateOfBirth: '2015-01-01' })).body.error.message).toMatch(/18 tuổi/);
    expect((await call('POST', '/kyc/level1', alice.token, { ...LEVEL1, idNumber: '12345' })).body.error.message).toMatch(/12 chữ số/);
    const l2 = { address: '12 Lê Lợi, Quận 1, TP Hồ Chí Minh', occupation: 'Kỹ sư / CNTT', fundSource: 'Lương', purpose: 'Đầu tư dài hạn' };
    expect((await call('POST', '/kyc/level2', alice.token, l2)).body.error.code).toBe('NEED_LEVEL1');
    // Nhân viên không nộp hồ sơ khách
    expect((await call('POST', '/kyc/level1', risk.token, LEVEL1)).status).toBe(403);
  });

  it('chỉ Tuân thủ duyệt; xem chi tiết ghi KYC_VIEW và che số giấy tờ; duyệt cấp 1 → tên chính chủ ngân hàng', async () => {
    const sub = await call<MyKycDTO>('POST', '/kyc/level1', alice.token, LEVEL1);
    expect(sub.body).toMatchObject({ level: 0, applications: [{ level: 1, status: 'PENDING' }] });
    expect((await call('POST', '/kyc/level1', alice.token, LEVEL1)).body.error.code).toBe('PENDING');

    expect((await call('GET', '/admin/compliance/kyc', risk.token)).status).toBe(403);
    const list = await call<KycApplicationDTO[]>('GET', '/admin/compliance/kyc', comp1.token);
    const app = list.body.find((a) => a.userId === alice.id)!;
    expect(app).toMatchObject({ level: 1, idLast4: '2345', flags: [] });
    expect(app.data).toBeUndefined();

    const detail = await call<KycApplicationDTO>('GET', `/admin/compliance/kyc/${app.id}`, comp1.token);
    expect(detail.body.data).toMatchObject({ fullName: 'Nguyễn Văn An', idNumber: '•••••2345' });
    const views = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM admin_audit_log WHERE action = 'KYC_VIEW' AND target_id = $1`, [alice.id]);
    expect(views!.n).toBe(1);
    // Hồ sơ lưu mã hoá / băm, không có số giấy tờ dạng rõ
    const raw = await db.one<{ data_enc: string; id_hash: string }>('SELECT data_enc, id_hash FROM kyc_applications WHERE id = $1', [app.id]);
    expect(raw!.id_hash).not.toContain('001095012345');

    expect((await call('POST', `/admin/compliance/kyc/${app.id}/review`, comp1.token, { approve: true })).body.status).toBe('APPROVED');
    expect((await call<MyKycDTO>('GET', '/kyc', alice.token)).body).toMatchObject({ level: 1, name: 'Nguyễn Văn An', p2pDailyLimit: '200000000' });
    expect((await call('GET', '/bank', alice.token)).body.holderName).toBe('NGUYEN VAN AN');
  });

  it('trùng số giấy tờ với tài khoản khác → cờ + cảnh báo DUPLICATE_ID; khai PEP → cảnh báo PEP; từ chối bắt buộc lý do', async () => {
    await call('POST', '/kyc/level1', bob.token, { ...LEVEL1, fullName: 'Tran Van Binh', isPep: true });
    const app = (await call<KycApplicationDTO[]>('GET', '/admin/compliance/kyc', comp1.token)).body.find((a) => a.userId === bob.id)!;
    expect(app.flags.sort()).toEqual(['DUPLICATE_ID', 'PEP']);
    const alerts = (await call<AmlAlertDTO[]>('GET', `/admin/compliance/alerts?userId=${bob.id}`, comp1.token)).body;
    expect(alerts.map((a) => a.rule).sort()).toEqual(['DUPLICATE_ID', 'PEP']);
    expect((await call('POST', `/admin/compliance/kyc/${app.id}/review`, comp1.token, { approve: false })).status).toBe(400);
    await call('POST', `/admin/compliance/kyc/${app.id}/review`, comp1.token, { approve: false, reason: 'Số giấy tờ trùng với tài khoản khác' });
    expect((await call<MyKycDTO>('GET', '/kyc', bob.token)).body).toMatchObject({ level: 0, applications: [{ status: 'REJECTED', rejectReason: 'Số giấy tờ trùng với tài khoản khác' }] });
  });
});

describe('P2P theo cấp KYC', () => {
  it('cấp 0 không thêm tài khoản nhận tiền / đặt đơn; vượt hạn mức ngày bị chặn; xin thương nhân cần cấp 2', async () => {
    const pm = await call<{ id: number }>('POST', '/p2p/payment-methods', mer.token, { bankName: 'Vietcombank' });
    expect(pm.body).toMatchObject({ holderName: 'THUONG NHAN MOT' });
    sellAd = (
      await call<P2PAdDTO>('POST', '/p2p/my-ads', mer.token, {
        side: 'SELL', asset: 'USDT', priceType: 'FIXED', fixedPrice: '26000', totalQty: '15000', minFiat: '100000', maxFiat: '200000000', payMinutes: 15, paymentMethodIds: [pm.body.id],
      })
    ).body;
    expect(sellAd.id).toBeGreaterThan(0);

    expect((await call('POST', '/p2p/payment-methods', carol.token, { bankName: 'ACB' })).status).toBe(403);
    const lv0 = await call('POST', '/p2p/orders', carol.token, { adId: sellAd.id, fiatAmount: '1000000' });
    expect(lv0.status).toBe(403);
    expect(lv0.body.error.message).toMatch(/KYC cấp 1/);

    const o = await call<P2POrderDTO>('POST', '/p2p/orders', alice.token, { adId: sellAd.id, fiatAmount: '150000000' });
    expect(o.status).toBe(200);
    aliceOrder = o.body;
    const over = await call('POST', '/p2p/orders', alice.token, { adId: sellAd.id, fiatAmount: '60000000' });
    expect(over.body.error.code).toBe('KYC_LIMIT');
    expect((await call<MyKycDTO>('GET', '/kyc', alice.token)).body.p2pUsedToday).toBe('150000000');

    const m = await call('GET', '/p2p/merchant', alice.token);
    expect(m.body.requirements.find((x: { key: string }) => x.key === 'kyc')).toMatchObject({ ok: false });
  });
});

describe('Giám sát AML', () => {
  it('đơn lớn hoàn tất sinh cảnh báo cho cả hai bên, quét lại không trùng; Kiểm toán chỉ xem', async () => {
    expect((await call('PUT', '/admin/compliance/rules', auditor.token, { largeOrderVnd: 100_000_000 })).status).toBe(403);
    expect((await call('PUT', '/admin/compliance/rules', comp1.token, { largeOrderVnd: 100_000_000 })).body.rules.largeOrderVnd).toBe(100_000_000);
    await call('POST', `/p2p/orders/${aliceOrder.id}/paid`, alice.token);
    expect((await call<P2POrderDTO>('POST', `/p2p/orders/${aliceOrder.id}/release`, mer.token)).body.status).toBe('COMPLETED');

    expect((await call('POST', '/admin/compliance/scan', comp1.token)).body.created).toBe(2);
    expect((await call('POST', '/admin/compliance/scan', comp1.token)).body.created).toBe(0);
    const alerts = (await call<AmlAlertDTO[]>('GET', '/admin/compliance/alerts?rule=LARGE_P2P', auditor.token)).body;
    expect(alerts.map((a) => a.userId).sort()).toEqual([alice.id, mer.id].sort());
    expect(alerts[0]!.detail).toMatchObject({ orderId: aliceOrder.id, fiatVnd: '150000000' });

    const merAlert = alerts.find((a) => a.userId === mer.id)!;
    expect((await call('PATCH', `/admin/compliance/alerts/${merAlert.id}`, auditor.token, { status: 'CLOSED', notes: 'Thương nhân bình thường' })).status).toBe(403);
    expect((await call('PATCH', `/admin/compliance/alerts/${merAlert.id}`, comp1.token, { status: 'CLOSED' })).status).toBe(400);
    expect((await call<AmlAlertDTO>('PATCH', `/admin/compliance/alerts/${merAlert.id}`, comp1.token, { status: 'CLOSED', notes: 'Thương nhân đã xác minh, khối lượng bình thường' })).body.status).toBe('CLOSED');

    const activity = await call('GET', `/admin/compliance/users/${alice.id}`, comp1.token);
    expect(activity.body.p2p30d).toMatchObject({ boughtVnd: '150000000', orders: 1, counterparties: 1 });
  });

  it('lập STR: cảnh báo chuyển "Đã lập STR"; STR chỉ ghi thêm', async () => {
    const alert = (await call<AmlAlertDTO[]>('GET', `/admin/compliance/alerts?userId=${alice.id}`, comp1.token)).body.find((a) => a.rule === 'LARGE_P2P')!;
    expect((await call('POST', '/admin/compliance/reports', comp1.token, { userId: alice.id, alertIds: [alert.id], narrative: 'ngắn' })).status).toBe(400);
    const r = await call('POST', '/admin/compliance/reports', comp1.token, {
      userId: alice.id,
      alertIds: [alert.id],
      narrative: 'Khách mới xác minh cấp 1 mua 150 triệu đồng USDT trong ngày đầu tiên, không phù hợp nghề nghiệp khai báo.',
    });
    // Chuyên viên soạn → đề xuất STR_FILE; chuyên viên khác không duyệt được, MLRO duyệt mới ghi sổ
    expect(r.status).toBe(202);
    const reqId = r.body.request.id;
    expect((await call<AmlAlertDTO[]>('GET', `/admin/compliance/alerts?userId=${alice.id}`, comp1.token)).body.find((a) => a.id === alert.id)!.status).toBe('REVIEWING');
    expect((await call('POST', `/admin/approvals/${reqId}/approve`, comp2.token, {})).status).toBe(403);
    const ok = await call('POST', `/admin/approvals/${reqId}/approve`, mlro.token, {});
    expect(ok.body.status).toBe('APPROVED');
    const reportId = ok.body.result.reportId;
    expect((await call<AmlAlertDTO[]>('GET', `/admin/compliance/alerts?status=REPORTED`, comp1.token)).body[0]).toMatchObject({ id: alert.id, reportId });
    await expect(db.many('UPDATE aml_reports SET narrative = $1', ['sửa'])).rejects.toThrow(/chỉ được ghi thêm/);
    expect((await call('GET', '/admin/compliance/reports', auditor.token)).body).toHaveLength(1);
  });

  it('hạn chế tài khoản chặn Spot + P2P, đóng quảng cáo; gỡ hạn chế cần MLRO duyệt', async () => {
    expect((await call('POST', `/admin/compliance/users/${mer.id}/restrict`, comp1.token, { reason: 'Nghi tài khoản trung gian chuyển tiền' })).body.ok).toBe(true);
    expect((await p2pAdStatus(sellAd.id))).toBe('CLOSED');
    const spot = await call('POST', '/orders', mer.token, { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quoteOrderQty: '100' });
    expect(spot.body.error.code).toBe('ACCOUNT_RESTRICTED');
    expect(spot.body.error.message).not.toMatch(/trung gian/);
    expect((await call('POST', '/p2p/orders', mer.token, { adId: sellAd.id, fiatAmount: '1000000' })).status).toBe(403);
    expect((await call('GET', '/admin/compliance/restricted', auditor.token)).body).toMatchObject([{ userId: mer.id }]);

    const req = await call('POST', `/admin/compliance/users/${mer.id}/unrestrict`, comp1.token, { reason: 'Đã xác minh nguồn tiền hợp lệ' });
    expect(req.status).toBe(202);
    const id = req.body.request.id;
    expect((await call('POST', `/admin/approvals/${id}/approve`, comp1.token, {})).status).toBe(403);
    expect((await call('POST', `/admin/approvals/${id}/approve`, risk.token, {})).status).toBe(403);
    expect((await call('POST', `/admin/approvals/${id}/approve`, comp2.token, {})).status).toBe(403);
    expect((await call('POST', `/admin/approvals/${id}/approve`, mlro.token, {})).body.status).toBe('APPROVED');
    const after = await call('POST', '/orders', mer.token, { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quoteOrderQty: '100' });
    expect(after.body.error?.code).not.toBe('ACCOUNT_RESTRICTED');
  });
});

async function p2pAdStatus(id: number) {
  return (await db.one<{ status: string }>('SELECT status FROM p2p_ads WHERE id = $1', [id]))!.status;
}
