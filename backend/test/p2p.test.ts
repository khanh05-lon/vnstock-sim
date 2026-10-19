import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import express from 'express';
import bcrypt from 'bcryptjs';
import { Server } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Big, DEFAULT_P2P_RULES, applyP2PRules, type P2PAdDTO, type P2POrderDTO, type UserRole } from '@vss/shared';
import { runReconciliation } from '../src/admin/reconcile';
import { adminRoutes } from '../src/admin/routes';
import { AdminStore } from '../src/admin/store';
import type { Database } from '../src/db';
import { initSessionCheck, signToken } from '../src/lib/auth';
import { errorHandler } from '../src/lib/errors';
import type { Mailer } from '../src/lib/mailer';
import type { MarketService } from '../src/market/marketService';
import { BankService } from '../src/p2p/bank';
import { p2pRoutes } from '../src/p2p/routes';
import { P2PService } from '../src/p2p/service';
import type { NavService } from '../src/portfolio/nav';
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
let p2p: P2PService;
const mailer: Mailer = { kind: 'smtp', send: async () => undefined };

type U = { id: string; email: string; token: string };
let risk: U;
let agent: U;
let ops: U;
let mer: U;
let alice: U;
let bob: U;
let carol: U;
let dave: U;

/** Điều kiện nới lỏng cho test (2FA, tuổi tài khoản, số đơn tối thiểu, thời gian chờ khiếu nại) */
const RELAXED = { require2fa: false, minAccountDays: 0, minCompletedOrders: 0, appealAfterMinutes: 0 };

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
  // Khách thử coi như đã KYC cấp 2 (kiểm tra cấp KYC nằm ở kyc-aml.test.ts)
  await db.many(`UPDATE users SET role = $2, email_verified_at = now(), kyc_level = CASE WHEN $2 = 'USER' THEN 2 ELSE 0 END, kyc_name = full_name WHERE id = $1`, [u.id, role]);
  return { id: u.id, email, token: signToken({ id: u.id, email }) };
}

async function bal(userId: string, asset = 'USDT') {
  const r = await db.one<{ free: string; locked: string }>('SELECT free::text, locked::text FROM balances WHERE user_id = $1 AND asset = $2', [userId, asset]);
  return { free: new Big(r?.free ?? 0).toFixed(), locked: new Big(r?.locked ?? 0).toFixed() };
}

async function bankNo(u: U) {
  return (await call<{ accountNo: string }>('GET', '/bank', u.token)).body.accountNo;
}

async function payMethod(u: U, bankName = 'Vietcombank') {
  const r = await call<{ id: number }>('POST', '/p2p/payment-methods', u.token, { bankName });
  expect(r.status).toBe(200);
  return r.body.id;
}

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
  p2p = new P2PService(db, market);
  engine.userCleanup.push((id, reason) => p2p.onUserCleanup(id, reason));
  engine.resetGuards.push((id) => p2p.assertCanReset(id));
  const bank = new BankService(db);
  const io = new Server();
  const mk = market as unknown as MarketService;
  const deps = { db, io, market: mk, engine, store, mailer, p2p };
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes(deps));
  app.use('/api/support-desk', deskRoutes({ ...deps, support: new SupportService(db, mailer) }));
  app.use('/api', p2pRoutes(p2p, bank));
  app.use('/api', tradingRoutes(db, mk, engine, { history: async () => [] } as unknown as NavService));
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  risk = await makeUser('risk@p2p.test', 'RISK');
  agent = await makeUser('cskh@p2p.test', 'SUPPORT');
  ops = await makeUser('ops@p2p.test', 'MARKET_OPS');
  mer = await makeUser('merchant@p2p.test');
  alice = await makeUser('alice@p2p.test');
  bob = await makeUser('bob@p2p.test');
  carol = await makeUser('carol@p2p.test');
  dave = await makeUser('dave@p2p.test');
  applyP2PRules(RELAXED);
});

afterAll(async () => {
  applyP2PRules(null);
  initSessionCheck(null);
  await new Promise((r) => server.close(r));
  await closeTestDb(db);
});

let sellAd: P2PAdDTO;
let merPm: number;

describe('Thương nhân P2P', () => {
  it('mỗi tài khoản có ngân hàng giả lập 100.000.000đ; chuyển khoản thiếu tiền bị từ chối', async () => {
    const b = await call('GET', '/bank', alice.token);
    expect(b.body).toMatchObject({ balanceVnd: DEFAULT_P2P_RULES.initialBankVnd });
    expect(b.body.accountNo).toMatch(/^\d{10}$/);
    const to = await bankNo(bob);
    expect((await call('GET', `/bank/lookup/${to}`, alice.token)).body).toMatchObject({ accountNo: to, holderName: 'BOB' });
    const r = await call('POST', '/bank/transfers', alice.token, { toAccountNo: to, amount: '100000001', memo: 'thử' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INSUFFICIENT_BANK');
  });

  it('chưa đủ điều kiện (chưa bật 2FA) thì không nộp được đơn; đủ thì khoá cọc 2.000 USDT', async () => {
    applyP2PRules({ ...RELAXED, require2fa: true });
    const info = await call('GET', '/p2p/merchant', mer.token);
    expect(info.body.eligible).toBe(false);
    expect(info.body.requirements.find((x: { key: string }) => x.key === '2fa').ok).toBe(false);
    expect((await call('POST', '/p2p/merchant/apply', mer.token)).body.error.code).toBe('NOT_ELIGIBLE');

    applyP2PRules(RELAXED);
    const ok = await call('POST', '/p2p/merchant/apply', mer.token);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'PENDING', depositUsdt: '2000' });
    expect(await bal(mer.id)).toEqual({ free: '8000', locked: '2000' });
    // Chưa duyệt thì chưa đăng được quảng cáo
    merPm = await payMethod(mer);
    const ad = await call('POST', '/p2p/my-ads', mer.token, {
      side: 'SELL', asset: 'USDT', priceType: 'FIXED', fixedPrice: '26300', totalQty: '1000', minFiat: '500000', maxFiat: '20000000', payMinutes: 15, paymentMethodIds: [merPm],
    });
    expect(ad.status).toBe(403);
  });

  it('chỉ Rủi ro & giám sát duyệt được thương nhân; nhân viên không giao dịch P2P', async () => {
    expect((await call('POST', `/admin/p2p/merchants/${mer.id}/approve`, agent.token, {})).status).toBe(403);
    expect((await call('POST', `/admin/p2p/merchants/${mer.id}/approve`, ops.token, {})).status).toBe(403);
    const list = await call('GET', '/admin/p2p/merchants?status=PENDING', risk.token);
    expect(list.body.map((m: { email: string }) => m.email)).toContain(mer.email);
    expect((await call('POST', `/admin/p2p/merchants/${mer.id}/approve`, risk.token, { note: 'Đủ điều kiện' })).status).toBe(200);
    expect((await call('GET', '/p2p/merchant', mer.token)).body.status).toBe('ACTIVE');
    const audit = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM admin_audit_log WHERE action = 'P2P_MERCHANT_APPROVE'`);
    expect(audit!.n).toBe(1);
    // Nhân viên không đăng ký thương nhân / đặt đơn được
    expect((await call('POST', '/p2p/merchant/apply', risk.token)).status).toBe(403);
  });

  it('quảng cáo bán khoá ngay số coin + phí; giá ngoài biên ±20% bị từ chối', async () => {
    const bad = await call('POST', '/p2p/my-ads', mer.token, {
      side: 'SELL', asset: 'USDT', priceType: 'FIXED', fixedPrice: '40000', totalQty: '1000', minFiat: '500000', maxFiat: '20000000', payMinutes: 15, paymentMethodIds: [merPm],
    });
    expect(bad.body.error.code).toBe('PRICE_BAND');
    const r = await call<P2PAdDTO>('POST', '/p2p/my-ads', mer.token, {
      side: 'SELL', asset: 'USDT', priceType: 'FIXED', fixedPrice: '26300', totalQty: '1000', minFiat: '500000', maxFiat: '20000000', payMinutes: 15, paymentMethodIds: [merPm], terms: 'Ghi mã đơn',
    });
    expect(r.status).toBe(200);
    sellAd = r.body;
    expect(sellAd).toMatchObject({ price: '26300', availableQty: '1000', limitMax: '20000000', banks: ['Vietcombank'], makerFee: '0.002' });
    // 1000 USDT × 1,002 (phí 0,2%) + 2000 cọc
    expect(await bal(mer.id)).toEqual({ free: '6998', locked: '3002' });
    const market = await call<P2PAdDTO[]>('GET', '/p2p/ads?side=BUY&asset=USDT');
    expect(market.body.map((a) => a.id)).toContain(sellAd.id);
    expect(market.body[0]!.merchant).toMatchObject({ verified: true });
    expect(market.body[0]!.paymentMethodIds).toBeUndefined();
  });

  it('mua USDT: chuyển khoản → đã thanh toán → thương nhân nhả coin; phí, sổ cái, vốn góp đúng', async () => {
    expect((await call('POST', '/p2p/orders', mer.token, { adId: sellAd.id, fiatAmount: '2630000' })).body.error.code).toBe('SELF');
    expect((await call('POST', '/p2p/orders', risk.token, { adId: sellAd.id, fiatAmount: '2630000' })).status).toBe(403);
    expect((await call('POST', '/p2p/orders', alice.token, { adId: sellAd.id, fiatAmount: '100000' })).body.error.message).toMatch(/tối thiểu/);

    const o = await call<P2POrderDTO>('POST', '/p2p/orders', alice.token, { adId: sellAd.id, fiatAmount: '2630000' });
    expect(o.status).toBe(200);
    expect(o.body).toMatchObject({ status: 'PENDING_PAYMENT', side: 'BUY', role: 'TAKER', qty: '100', fiatAmount: '2630000', fee: '0.2' });
    expect(o.body.paymentMethod.accountNo).toBe(await bankNo(mer));
    const id = o.body.id;
    // Bên bán không bấm "đã thanh toán" được; người mua không nhả coin được
    expect((await call('POST', `/p2p/orders/${id}/paid`, mer.token)).status).toBe(403);
    expect((await call('POST', `/p2p/orders/${id}/release`, alice.token)).status).toBe(403);

    expect((await call('POST', '/bank/transfers', alice.token, { toAccountNo: o.body.paymentMethod.accountNo, amount: '2630000', memo: `P2P ${id}` })).status).toBe(200);
    expect((await call<P2POrderDTO>('POST', `/p2p/orders/${id}/paid`, alice.token)).body.status).toBe('PAID');
    expect((await call('POST', `/p2p/orders/${id}/messages`, mer.token, { body: 'Đã thấy tiền về' })).status).toBe(200);
    const done = await call<P2POrderDTO>('POST', `/p2p/orders/${id}/release`, mer.token);
    expect(done.body).toMatchObject({ status: 'COMPLETED', side: 'SELL', role: 'MAKER' });

    expect(await bal(alice.id)).toEqual({ free: '10100', locked: '0' });
    // Thương nhân: 1000 + 2000 cọc khoá, đã giao 100 + phí 0,2
    expect(await bal(mer.id)).toEqual({ free: '6998', locked: '2901.8' });
    const acct = await db.one<{ c: string }>('SELECT contributed_usdt::text AS c FROM accounts WHERE user_id = $1', [alice.id]);
    expect(new Big(acct!.c).minus('10101.15384615').abs().lt('0.00000001')).toBe(true);
    const ledgerRows = await db.many<{ type: string; amount: string; p2p_order_id: number }>(
      'SELECT type, amount::text, p2p_order_id FROM ledger WHERE user_id = $1 AND p2p_order_id IS NOT NULL ORDER BY id',
      [mer.id],
    );
    expect(ledgerRows.map((l) => [l.type, new Big(l.amount).toFixed(), Number(l.p2p_order_id)])).toEqual([
      ['P2P', '-100', id],
      ['FEE', '-0.2', id],
    ]);
    const msgs = await call('GET', `/p2p/orders/${id}/messages`, alice.token);
    expect(msgs.body.map((m: { kind: string }) => m.kind)).toEqual(['SYSTEM', 'SYSTEM', 'USER', 'SYSTEM']);
    expect((await call('GET', `/p2p/orders/${id}/messages`, bob.token)).status).toBe(404);
  });

  it('quá hạn thanh toán tự huỷ trả coin về quảng cáo; khách huỷ 3 lần / ngày bị khoá P2P', async () => {
    const before = await bal(mer.id);
    const o1 = await call<P2POrderDTO>('POST', '/p2p/orders', bob.token, { adId: sellAd.id, qty: '20' });
    expect(o1.body).toMatchObject({ qty: '20', fiatAmount: '526000' });
    await db.many(`UPDATE p2p_orders SET pay_deadline = now() - interval '1 minute' WHERE id = $1`, [o1.body.id]);
    expect(await p2p.expireDue()).toBe(1);
    expect((await call<P2POrderDTO>('GET', `/p2p/orders/${o1.body.id}`, bob.token)).body).toMatchObject({ status: 'CANCELLED', cancelledBy: 'SYSTEM' });
    expect(await bal(mer.id)).toEqual(before);
    expect((await p2p.adById(sellAd.id))!.availableQty).toBe('900');

    for (let i = 0; i < 2; i++) {
      const o = await call<P2POrderDTO>('POST', '/p2p/orders', bob.token, { adId: sellAd.id, fiatAmount: '526000' });
      expect((await call('POST', `/p2p/orders/${o.body.id}/cancel`, bob.token, { reason: 'Đổi ý' })).body.status).toBe('CANCELLED');
    }
    const blocked = await call('POST', '/p2p/orders', bob.token, { adId: sellAd.id, fiatAmount: '526000' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.message).toMatch(/huỷ 3 đơn/);
    expect((await call('GET', '/p2p/merchant', bob.token)).body.blockedUntil).toMatch(/T00:00:00/);
  });

  it('khiếu nại: bấm "đã thanh toán" mà chưa chuyển tiền → trả coin về bên bán', async () => {
    const o = await call<P2POrderDTO>('POST', '/p2p/orders', carol.token, { adId: sellAd.id, fiatAmount: '1315000' });
    const id = o.body.id;
    // Chưa thanh toán thì chưa khiếu nại được
    expect((await call('POST', `/p2p/orders/${id}/appeal`, mer.token, { reason: 'NOT_RECEIVED', description: 'Chưa thấy tiền về tài khoản' })).body.error.code).toBe('STATUS');
    await call('POST', `/p2p/orders/${id}/paid`, carol.token);
    const ap = await call<P2POrderDTO>('POST', `/p2p/orders/${id}/appeal`, mer.token, { reason: 'NOT_RECEIVED', description: 'Chưa thấy tiền về tài khoản' });
    expect(ap.body).toMatchObject({ status: 'APPEAL', appeal: { by: 'SELLER', reason: 'NOT_RECEIVED' } });

    const queue = await call<P2POrderDTO[]>('GET', '/support-desk/p2p/appeals', agent.token);
    expect(queue.body.map((x) => x.id)).toContain(id);
    const detail = await call('GET', `/support-desk/p2p/orders/${id}`, agent.token);
    expect(detail.body.transfers).toEqual([]);
    // Người mua có lỗi nhưng không phải thương nhân → không có cọc để trừ
    const pen = await call('POST', `/support-desk/p2p/orders/${id}/resolve`, agent.token, { outcome: 'RETURN', note: 'Không có giao dịch chuyển khoản', penaltyUsdt: '10' });
    expect(pen.body.error.code).toBe('PENALTY');
    const r = await call<P2POrderDTO>('POST', `/support-desk/p2p/orders/${id}/resolve`, agent.token, { outcome: 'RETURN', note: 'Không có giao dịch chuyển khoản' });
    expect(r.body).toMatchObject({ status: 'CANCELLED', cancelledBy: 'STAFF', appeal: { resolution: 'RETURNED', resolvedBy: agent.email } });
    expect(await bal(carol.id)).toEqual({ free: '10000', locked: '0' });
    expect((await p2p.adById(sellAd.id))!.availableQty).toBe('900');
  });

  it('khiếu nại: đã nhận tiền mà không nhả coin → nhả cho người mua, trừ cọc thương nhân bồi thường', async () => {
    const o = await call<P2POrderDTO>('POST', '/p2p/orders', carol.token, { adId: sellAd.id, fiatAmount: '1315000' });
    const id = o.body.id;
    await call('POST', '/bank/transfers', carol.token, { toAccountNo: o.body.paymentMethod.accountNo, amount: '1315000', memo: `P2P ${id}` });
    await call('POST', `/p2p/orders/${id}/paid`, carol.token);
    await call('POST', `/p2p/orders/${id}/appeal`, carol.token, { reason: 'NOT_RELEASED', description: 'Đã chuyển khoản đúng số tiền nhưng chưa nhận coin' });
    const detail = await call('GET', `/support-desk/p2p/orders/${id}`, agent.token);
    expect(detail.body.transfers).toMatchObject([{ direction: 'OUT', amount: '1315000', memo: `P2P ${id}` }]);
    const r = await call<P2POrderDTO>('POST', `/support-desk/p2p/orders/${id}/resolve`, agent.token, {
      outcome: 'RELEASE', note: 'Sao kê có lệnh chuyển đúng số tiền', penaltyUsdt: '50',
    });
    expect(r.body).toMatchObject({ status: 'COMPLETED', appeal: { resolution: 'RELEASED' } });
    expect(await bal(carol.id)).toEqual({ free: '10100', locked: '0' });
    expect((await call('GET', '/p2p/merchant', mer.token)).body.depositUsdt).toBe('1950');
    const viewed = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM admin_audit_log WHERE action = 'USER_VIEW' AND admin_email = $1`, [agent.email]);
    expect(viewed!.n).toBeGreaterThan(0);
  });

  it('quảng cáo mua: coin của khách bán vào ký quỹ, thương nhân nhận coin trừ phí', async () => {
    const ad = await call<P2PAdDTO>('POST', '/p2p/my-ads', mer.token, {
      side: 'BUY', asset: 'USDT', priceType: 'FLOATING', floatRatio: '99.50', totalQty: '500', minFiat: '500000', maxFiat: '10000000', payMinutes: 30, paymentMethodIds: [merPm],
    });
    expect(ad.body).toMatchObject({ price: '25870', side: 'BUY' });
    expect((await call<P2PAdDTO[]>('GET', '/p2p/ads?side=SELL&asset=USDT')).body.map((a) => a.id)).toContain(ad.body.id);

    expect((await call('POST', '/p2p/orders', dave.token, { adId: ad.body.id, qty: '50' })).body.error.code).toBe('PAYMENT_METHOD');
    const wrongBank = await payMethod(dave, 'ACB');
    expect((await call('POST', '/p2p/orders', dave.token, { adId: ad.body.id, qty: '50', paymentMethodId: wrongBank })).body.error.message).toMatch(/Vietcombank/);
    const davePm = await payMethod(dave, 'Vietcombank');
    const o = await call<P2POrderDTO>('POST', '/p2p/orders', dave.token, { adId: ad.body.id, qty: '50', paymentMethodId: davePm });
    expect(o.body).toMatchObject({ side: 'SELL', fiatAmount: '1293500', fee: '0.1' });
    expect(await bal(dave.id)).toEqual({ free: '9950', locked: '50' });
    const merBefore = await bal(mer.id);

    await call('POST', '/bank/transfers', mer.token, { toAccountNo: await bankNo(dave), amount: '1293500', memo: `P2P ${o.body.id}` });
    await call('POST', `/p2p/orders/${o.body.id}/paid`, mer.token);
    expect((await call<P2POrderDTO>('POST', `/p2p/orders/${o.body.id}/release`, dave.token)).body.status).toBe('COMPLETED');
    expect(await bal(dave.id)).toEqual({ free: '9950', locked: '0' });
    expect(new Big((await bal(mer.id)).free).minus(merBefore.free).toFixed()).toBe('49.9');
  });

  it('đặt lại tài khoản bị chặn khi còn đơn P2P dở dang', async () => {
    const o = await call<P2POrderDTO>('POST', '/p2p/orders', alice.token, { adId: sellAd.id, fiatAmount: '526000' });
    const r = await call('POST', '/account/reset', alice.token, {});
    expect(r.body.error.code).toBe('P2P_OPEN_ORDERS');
    await call('POST', `/p2p/orders/${o.body.id}/cancel`, alice.token, {});
    expect((await call('POST', '/account/reset', alice.token, {})).status).toBe(200);
    expect(await bal(alice.id)).toEqual({ free: '10000', locked: '0' });
    expect((await call('GET', '/bank', alice.token)).body.balanceVnd).toBe(DEFAULT_P2P_RULES.initialBankVnd);
  });

  it('tạm ngừng thương nhân đưa quảng cáo offline; đối soát sạch sau mọi kịch bản', async () => {
    expect((await call('POST', `/admin/p2p/merchants/${mer.id}/suspend`, risk.token, { reason: 'Kiểm tra khiếu nại' })).body.adsOffline).toBe(2);
    expect((await call<P2PAdDTO[]>('GET', '/p2p/ads?side=BUY&asset=USDT')).body).toEqual([]);
    expect((await call('POST', `/p2p/my-ads/${sellAd.id}/online`, mer.token, { online: true })).status).toBe(403);
    await call('POST', `/admin/p2p/merchants/${mer.id}/restore`, risk.token, {});
    expect((await call('POST', `/p2p/my-ads/${sellAd.id}/online`, mer.token, { online: true })).body.status).toBe('ONLINE');

    const run = await runReconciliation(db, 'test');
    expect(run.issues).toEqual([]);
    expect(run.ok).toBe(true);
  });

  it('nghỉ thương nhân: đóng quảng cáo, trả cọc; đối soát vẫn sạch', async () => {
    expect((await call('POST', '/p2p/merchant/resign', mer.token)).body.status).toBe('RESIGNED');
    expect((await bal(mer.id)).locked).toBe('0');
    expect((await call('GET', '/p2p/my-ads', mer.token)).body.every((a: P2PAdDTO) => a.status === 'CLOSED')).toBe(true);
    const run = await runReconciliation(db, 'test');
    expect(run.issues).toEqual([]);
  });

  it('Vận hành thị trường chỉnh tỷ giá tham chiếu P2P; Rủi ro thì không', async () => {
    expect((await call('PUT', '/admin/p2p/rules', risk.token, { usdtVnd: '26500' })).status).toBe(403);
    expect((await call('PUT', '/admin/p2p/rules', ops.token, { usdtVnd: '26500' })).body.rules.usdtVnd).toBe('26500');
    expect((await call('GET', '/p2p/config')).body.refPrices.USDT).toBe('26500');
    await call('DELETE', '/admin/p2p/rules', ops.token);
    applyP2PRules(RELAXED);
  });
});
