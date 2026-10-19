import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express, { Router } from 'express';
import bcrypt from 'bcryptjs';
import { Server } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, STAFF_ROLES, can, rolesWith, type ApprovalDTO, type Permission, type UserRole } from '@vss/shared';
import { exportBackup, serializeBackup } from '../src/admin/backup';
import { assertRoutesGuarded, need } from '../src/admin/common';
import { adminRoutes } from '../src/admin/routes';
import { AdminStore } from '../src/admin/store';
import { config } from '../src/config';
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

describe('Ma trận quyền', () => {
  const WRITE: Permission[] = [
    'users.manage',
    'users.lock',
    'staff.manage',
    'orders.cancel',
    'market.manage',
    'market.halt',
    'market.approve',
    'system.announce',
    'finance.adjust',
    'finance.approve',
    'data.manage',
    'data.approve',
    'system.manage',
    'support.desk',
    'support.lead',
  ];

  it('kiểm toán chỉ đọc; quản trị hệ thống không chỉnh tiền / giá; chỉ tài chính chạm vào số dư', () => {
    for (const p of WRITE) expect(can('AUDITOR', p)).toBe(false);
    for (const p of ['finance.adjust', 'finance.approve', 'market.manage', 'market.approve', 'orders.cancel'] as Permission[]) expect(can('ADMIN', p)).toBe(false);
    expect(STAFF_ROLES.filter((r) => can(r, 'finance.adjust'))).toEqual(['FINANCE']);
    expect(STAFF_ROLES.filter((r) => can(r, 'staff.manage'))).toEqual(['ADMIN']);
    expect(rolesWith('market.approve').sort()).toEqual(['MARKET_OPS', 'RISK']);
    expect(rolesWith('support.desk').sort()).toEqual(['P2P_OPS', 'RISK', 'SUPPORT', 'SUPPORT_LEAD']);
    // Quản trị hệ thống (IT) không làm nghiệp vụ khách hàng
    for (const p of ['support.desk', 'support.lead', 'account.recovery', 'privacy.manage', 'p2p.appeal', 'kyc.review'] as Permission[]) expect(can('ADMIN', p)).toBe(false);
    expect(rolesWith('support.lead')).toEqual(['SUPPORT_LEAD']);
    expect(rolesWith('account.recovery')).toEqual(['SUPPORT_LEAD']);
    expect(rolesWith('aml.report')).toEqual(['MLRO']);
    expect(rolesWith('privacy.manage')).toEqual(['DPO']);
    expect(rolesWith('p2p.review')).toEqual(['P2P_OPS']);
    expect(ROLE_PERMISSIONS.USER).toEqual([]);
    expect(can('SUPPORT', 'admin.view')).toBe(false);
  });
});

describe('Phân quyền & duyệt 2 người (API)', () => {
  let db: Database;
  let server: http.Server;
  let base: string;
  let market: MarketService;
  let engine: SpotEngine;
  const sent: MailMessage[] = [];
  const mailer: Mailer = { kind: 'smtp', send: async (m) => void sent.push(m) };
  /** Email gửi tới `who` có tiêu đề khớp */
  const mailsTo = (who: string, re: RegExp) => sent.filter((m) => m.to === u[who]!.email && re.test(m.subject));
  const u: Record<string, { id: string; email: string; token: string }> = {};
  const backupDir = config.backupDir;
  let tmp: string;

  async function call<T = any>(method: string, p: string, who: string, body?: unknown, raw?: Buffer) {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: {
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(raw && { 'Content-Type': 'application/octet-stream' }),
        Authorization: `Bearer ${u[who]!.token}`,
      },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
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
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vncoin-approvals-'));
    (config as { backupDir: string }).backupDir = tmp;
    db = await openTestDb();
    await seedSymbols(db, null);
    market = new MarketService(db, null, { feed: 'sim' });
    await market.init();
    engine = new SpotEngine(db, market, { order: () => undefined, fill: () => undefined, account: () => undefined });
    await engine.load();
    const store = new AdminStore(db, engine);
    await store.load();
    const app = express();
    app.use(express.json());
    app.use('/api/admin', adminRoutes({ db, io: new Server(), market, engine, store, mailer }));
    app.use('/api', tradingRoutes(db, market, engine, { history: async () => [] } as unknown as NavService));
    app.use(errorHandler);
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin`;
    for (const [name, role] of [
      ['admin1', 'ADMIN'],
      ['admin2', 'ADMIN'],
      ['ops', 'MARKET_OPS'],
      ['ops2', 'MARKET_OPS'],
      ['fin', 'FINANCE'],
      ['fin2', 'FINANCE'],
      ['risk', 'RISK'],
      ['audit', 'AUDITOR'],
      ['cskh', 'SUPPORT'],
      ['khach', 'USER'],
    ] as [string, UserRole][]) {
      await makeUser(name, role);
    }
    await market.flushNow();
  });

  afterAll(async () => {
    (config as { backupDir: string }).backupDir = backupDir;
    await new Promise((r) => server.close(r));
    await closeTestDb(db);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('mỗi vai trò chỉ làm đúng mảng của mình; kiểm toán chỉ đọc; CSKH / nhà đầu tư không vào khu quản trị', async () => {
    expect((await call('GET', '/me', 'audit')).body.permissions).toEqual(ROLE_PERMISSIONS.AUDITOR);
    for (const p of ['/overview', '/audit', '/users', '/orders', '/approvals', '/monitor']) expect((await call('GET', p, 'audit')).status).toBe(200);
    const writes: [string, string, unknown][] = [
      ['POST', `/users/${u.khach!.id}/lock`, { reason: 'thử khoá' }],
      ['POST', '/market/halt', { halted: true, reason: 'thử' }],
      ['PUT', '/rules', { makerFee: '0.001' }],
      ['POST', '/prices/BTCUSDT/manual', { reason: 'thử' }],
      ['POST', `/users/${u.khach!.id}/adjust-balance`, { asset: 'USDT', amount: '1', reason: 'thử' }],
      ['POST', `/users/${u.khach!.id}/role`, { role: 'RISK' }],
      ['PUT', '/announcement', { text: 'thử thông báo', level: 'info' }],
    ];
    for (const [m, p, b] of writes) expect((await call(m, p, 'audit', b)).status, `${m} ${p}`).toBe(403);
    expect((await call('GET', '/data/export', 'audit')).status).toBe(403);
    // vận hành thị trường không xem hồ sơ người dùng, không xem nhật ký quản trị
    expect((await call('GET', '/users', 'ops')).status).toBe(403);
    expect((await call('GET', '/audit', 'ops')).status).toBe(403);
    // tài chính không đụng thị trường
    expect((await call('POST', '/prices/BTCUSDT/manual', 'fin', { reason: 'thử' })).status).toBe(403);
    // CSKH và nhà đầu tư không vào khu quản trị
    expect((await call('GET', '/overview', 'cskh')).status).toBe(403);
    expect((await call('GET', '/overview', 'khach')).status).toBe(403);
    // rủi ro khoá được tài khoản; chỉ quản trị hệ thống phân quyền
    expect((await call('POST', `/users/${u.khach!.id}/lock`, 'risk', { reason: 'Nghi bị chiếm tài khoản' })).status).toBe(200);
    expect((await call('POST', `/users/${u.khach!.id}/unlock`, 'risk', {})).status).toBe(200);
    expect((await call('POST', `/users/${u.cskh!.id}/role`, 'ops', { role: 'RISK' })).status).toBe(403);
    expect((await call('POST', `/users/${u.cskh!.id}/role`, 'admin1', { role: 'GOD' })).status).toBe(400);
  });

  it('tạm ngừng toàn sàn: đề xuất → người khác duyệt mới ngừng; mở lại cũng phải duyệt', async () => {
    const r = await call<{ pending: boolean; request: ApprovalDTO }>('POST', '/market/halt', 'ops', { halted: true, reason: 'Sự cố nguồn giá' });
    expect(r.status).toBe(202);
    expect(engine.control.haltAll).toBe(false);
    expect((await call('POST', '/market/halt', 'ops2', { halted: true, reason: 'Gửi trùng' })).body.error.code).toBe('PENDING_EXISTS');
    expect((await call('POST', `/approvals/${r.body.request.id}/approve`, 'fin', {})).status).toBe(403);
    const ok = await call<ApprovalDTO>('POST', `/approvals/${r.body.request.id}/approve`, 'risk', {});
    expect(ok.body).toMatchObject({ status: 'APPROVED', decidedByEmail: u.risk!.email });
    expect(engine.control.haltAll).toBe(true);
    expect(engine.control.haltReason).toBe('Sự cố nguồn giá');
    expect((await call('POST', '/market/halt', 'ops', { halted: false })).body.error.code).toBe('REASON');
    const resume = await call<{ request: ApprovalDTO }>('POST', '/market/halt', 'ops', { halted: false, reason: 'Đã xử lý nguồn giá' });
    expect(resume.status).toBe(202);
    expect(engine.control.haltAll).toBe(true);
    expect((await call<ApprovalDTO>('POST', `/approvals/${resume.body.request.id}/approve`, 'ops2', {})).body.status).toBe('APPROVED');
    expect(engine.control.haltAll).toBe(false);
  });

  it('huỷ niêm yết / niêm yết lại qua duyệt; từ chối bắt buộc lý do; người đề xuất tự rút được; quá hạn thì không duyệt được', async () => {
    const del = await call<{ request: ApprovalDTO }>('POST', '/symbols/ADAUSDT/delist', 'ops', { reason: 'Thanh khoản thấp' });
    expect(del.status).toBe(202);
    expect(market.info('ADAUSDT')).toBeTruthy();
    await call('POST', `/approvals/${del.body.request.id}/approve`, 'ops2', { note: 'Đồng ý' });
    expect(market.info('ADAUSDT')).toBeUndefined();

    const list = await call<{ request: ApprovalDTO }>('POST', '/symbols', 'ops', { symbol: 'ADAUSDT', reason: 'Đưa lại cặp' });
    expect(list.body.request).toMatchObject({ kind: 'SYMBOL_LIST', target: 'ADAUSDT', payload: { reactivate: true } });
    const done = await call<ApprovalDTO>('POST', `/approvals/${list.body.request.id}/approve`, 'risk', {});
    expect(done.body).toMatchObject({ status: 'APPROVED', result: { symbol: 'ADAUSDT', reactivated: true } });
    expect(market.info('ADAUSDT')).toBeTruthy();

    // từ chối
    const d2 = await call<{ request: ApprovalDTO }>('POST', '/symbols/DOGEUSDT/delist', 'ops', { reason: 'Thử từ chối' });
    expect((await call('POST', `/approvals/${d2.body.request.id}/reject`, 'risk', { note: '' })).status).toBe(400);
    expect((await call<ApprovalDTO>('POST', `/approvals/${d2.body.request.id}/reject`, 'risk', { note: 'Chưa đủ căn cứ' })).body.status).toBe('REJECTED');
    expect(market.info('DOGEUSDT')).toBeTruthy();

    // người đề xuất tự rút; người khác không rút hộ
    const d3 = await call<{ request: ApprovalDTO }>('POST', '/symbols/DOGEUSDT/delist', 'ops', { reason: 'Thử rút' });
    expect((await call('POST', `/approvals/${d3.body.request.id}/cancel`, 'ops2', {})).body.error.code).toBe('NOT_OWNER');
    expect((await call<ApprovalDTO>('POST', `/approvals/${d3.body.request.id}/cancel`, 'ops', {})).body.status).toBe('CANCELLED');

    // quá hạn
    const d4 = await call<{ request: ApprovalDTO }>('POST', '/symbols/DOGEUSDT/delist', 'ops', { reason: 'Thử hết hạn' });
    await db.many(`UPDATE approval_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`, [d4.body.request.id]);
    expect((await call('POST', `/approvals/${d4.body.request.id}/approve`, 'risk', {})).body.error.message).toMatch(/hết hạn/);
    expect(market.info('DOGEUSDT')).toBeTruthy();

    const all = (await call<ApprovalDTO[]>('GET', '/approvals?status=ALL', 'audit')).body;
    expect(all.filter((a) => a.target === 'DOGEUSDT').map((a) => a.status)).toEqual(['EXPIRED', 'CANCELLED', 'REJECTED']);
    const actions = (await db.many<{ action: string }>(`SELECT action FROM admin_audit_log WHERE target_type = 'approval' ORDER BY id`)).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['APPROVAL_REQUEST', 'APPROVAL_APPROVE', 'APPROVAL_REJECT', 'APPROVAL_CANCEL']));
  });

  it('cấp vai trò nhân viên cần Quản trị hệ thống khác duyệt; thu quyền về nhà đầu tư có hiệu lực ngay; thu quyền Quản trị hệ thống cũng phải duyệt', async () => {
    await makeUser('nhanvienmoi', 'USER');
    const g = await call<{ request: ApprovalDTO }>('POST', `/users/${u.nhanvienmoi!.id}/role`, 'admin1', { role: 'FINANCE', reason: 'Tuyển nhân viên tài chính' });
    expect(g.status).toBe(202);
    expect(g.body.request).toMatchObject({ kind: 'ROLE_SET', target: u.nhanvienmoi!.id, payload: { role: 'FINANCE', from: 'USER' } });
    expect((await db.one<{ role: string }>('SELECT role FROM users WHERE id = $1', [u.nhanvienmoi!.id]))!.role).toBe('USER');
    expect((await call('POST', `/approvals/${g.body.request.id}/approve`, 'admin1', {})).body.error.code).toBe('SELF');
    expect((await call('POST', `/approvals/${g.body.request.id}/approve`, 'risk', {})).status).toBe(403);
    expect((await call<ApprovalDTO>('POST', `/approvals/${g.body.request.id}/approve`, 'admin2', {})).body.status).toBe('APPROVED');
    expect((await db.one<{ role: string }>('SELECT role FROM users WHERE id = $1', [u.nhanvienmoi!.id]))!.role).toBe('FINANCE');
    // thu quyền nhân viên thường: ngay
    expect((await call('POST', `/users/${u.nhanvienmoi!.id}/role`, 'admin1', { role: 'USER' })).status).toBe(200);
    // thu quyền Quản trị hệ thống: phải duyệt (không ai tự gạt người kia để thành quản trị duy nhất)
    const demote = await call<{ request: ApprovalDTO }>('POST', `/users/${u.admin2!.id}/role`, 'admin1', { role: 'USER', reason: 'Thử thu quyền' });
    expect(demote.status).toBe(202);
    expect((await call<ApprovalDTO>('POST', `/approvals/${demote.body.request.id}/cancel`, 'admin1', {})).body.status).toBe('CANCELLED');
    // khởi tạo: chỉ còn 1 Quản trị hệ thống đang hoạt động → cấp ngay, nhật ký ghi bootstrap
    await db.many(`UPDATE users SET role = 'USER' WHERE id = $1`, [u.admin2!.id]);
    const boot = await call('POST', `/users/${u.nhanvienmoi!.id}/role`, 'admin1', { role: 'AUDITOR' });
    await db.many(`UPDATE users SET role = 'ADMIN' WHERE id = $1`, [u.admin2!.id]);
    expect(boot.body).toMatchObject({ ok: true, bootstrap: true, to: 'AUDITOR' });
    const last = await db.one<{ detail: { bootstrap?: boolean } }>(`SELECT detail FROM admin_audit_log WHERE action = 'ROLE_SET' ORDER BY id DESC LIMIT 1`);
    expect(last!.detail.bootstrap).toBe(true);
  });

  it('đặt lại tài khoản khách: đề xuất, người Tài chính khác duyệt mới xoá sạch', async () => {
    await makeUser('khach2', 'USER');
    await db.many(`UPDATE balances SET free = free + 500 WHERE user_id = $1 AND asset = 'USDT'`, [u.khach2!.id]);
    const before = (await db.one<{ free: string }>(`SELECT free FROM balances WHERE user_id = $1 AND asset = 'USDT'`, [u.khach2!.id]))!.free;
    expect((await call('POST', `/users/${u.khach2!.id}/reset`, 'admin1', { reason: 'thử' })).status).toBe(403);
    const r = await call<{ request: ApprovalDTO }>('POST', `/users/${u.khach2!.id}/reset`, 'fin', { reason: 'Khách xin làm lại từ đầu' });
    expect(r.status).toBe(202);
    expect((await db.one<{ free: string }>(`SELECT free FROM balances WHERE user_id = $1 AND asset = 'USDT'`, [u.khach2!.id]))!.free).toBe(before);
    expect((await call('POST', `/approvals/${r.body.request.id}/approve`, 'fin', {})).body.error.code).toBe('SELF');
    expect((await call('POST', `/approvals/${r.body.request.id}/approve`, 'risk', {})).status).toBe(403);
    expect((await call<ApprovalDTO>('POST', `/approvals/${r.body.request.id}/approve`, 'fin2', {})).body.status).toBe('APPROVED');
    expect(Number((await db.one<{ free: string }>(`SELECT free FROM balances WHERE user_id = $1 AND asset = 'USDT'`, [u.khach2!.id]))!.free)).toBeLessThan(Number(before));
    const a = await db.one<{ admin_email: string; detail: Record<string, unknown> }>(`SELECT admin_email, detail FROM admin_audit_log WHERE action = 'ACCOUNT_RESET' ORDER BY id DESC LIMIT 1`);
    expect(a).toMatchObject({ admin_email: u.fin2!.email, detail: { requestedBy: u.fin!.email } });
  });

  it('điều chỉnh số dư: cộng dồn 24 giờ của cùng người làm vượt ngưỡng thì phải duyệt (chống chia nhỏ)', async () => {
    await makeUser('khach3', 'USER');
    const adj = (amount: string) => call('POST', `/users/${u.khach3!.id}/adjust-balance`, 'fin', { asset: 'USDT', amount, reason: 'Bồi hoàn' });
    expect((await adj('600')).status).toBe(200);
    const second = await adj('600');
    expect(second.status).toBe(202);
    expect(second.body).toMatchObject({ pending: true, cumulative: true });
    expect(second.body.request.reason).toMatch(/cộng dồn 24 giờ/);
    // người Tài chính khác chưa làm gì cho khách này → vẫn được điều chỉnh nhỏ trực tiếp
    expect((await call('POST', `/users/${u.khach3!.id}/adjust-balance`, 'fin2', { asset: 'USDT', amount: '100', reason: 'Bồi hoàn' })).status).toBe(200);
  });

  it('nhân viên không giao dịch cặp đang ở giá điều chỉnh; lệnh chờ sẵn của nhân viên bị huỷ; nhân viên vừa đặt lệnh thì chỉnh giá nhỏ cũng phải duyệt', async () => {
    const SYM = 'DOGEUSDT';
    await market.flushNow();
    const order = async (who: string, priceFactor: number) => {
      const last = Number(market.lastPrice(SYM));
      const price = (last * priceFactor).toFixed(5);
      const res = await fetch(`${base.replace('/admin', '')}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u[who]!.token}` },
        body: JSON.stringify({ symbol: SYM, side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', price, quantity: String(Math.ceil(20 / Number(price))) }),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    // Giá thực tế: nhân viên giao dịch như thường
    const staffOrder = await order('ops', 0.95);
    expect(staffOrder.status).toBe(201);
    const custOrder = await order('khach', 0.95);
    expect(custOrder.status).toBe(201);

    // ops vừa đặt lệnh → chỉnh giá dù chỉ +1% cũng thành đề xuất, kèm cảnh báo tên nhân viên
    const target = (Number(market.lastPrice(SYM)) * 1.01).toFixed(5);
    sent.length = 0;
    const r = await call<{ request: ApprovalDTO }>('POST', `/prices/${SYM}/set`, 'ops', { price: target, volatilityPct: 0, reason: 'Thử chỉnh giá' });
    expect(r.status).toBe(202);
    expect(r.body.request.summary).toContain(`Nhân viên đã đặt lệnh ${SYM}`);
    expect(r.body.request.summary).toContain(u.ops!.email);
    // email báo người có thẩm quyền duyệt (Vận hành / Rủi ro khác), không báo người đề xuất / vai trò khác
    expect(mailsTo('risk', /Cần duyệt: Chỉnh giá lớn/)).toHaveLength(1);
    expect(mailsTo('ops2', /Cần duyệt/)).toHaveLength(1);
    expect(mailsTo('ops', /Cần duyệt/)).toHaveLength(0);
    expect(mailsTo('fin', /Cần duyệt/)).toHaveLength(0);
    expect(mailsTo('risk', /Cần duyệt/)[0]!.text).toContain('/admin?tab=approvals');

    const ok = await call<ApprovalDTO>('POST', `/approvals/${r.body.request.id}/approve`, 'risk', {});
    expect(ok.body.result).toMatchObject({ staffOrdersCancelled: 1 });
    expect((await db.one<{ status: string; reason: string }>('SELECT status, reason FROM orders WHERE id = $1', [staffOrder.body.id]))).toMatchObject({
      status: 'CANCELED',
      reason: expect.stringMatching(/nhân viên không được giữ lệnh/),
    });
    expect((await db.one<{ status: string }>('SELECT status FROM orders WHERE id = $1', [custOrder.body.id]))!.status).toBe('NEW');

    // đang giá điều chỉnh: nhân viên (kể cả Kiểm toán, CSKH) bị chặn, khách vẫn giao dịch được
    for (const who of ['ops', 'audit', 'cskh']) {
      const x = await order(who, 0.97);
      expect(x.status, who).toBe(403);
      expect(x.body.error.code).toBe('STAFF_MANUAL_PRICE');
    }
    expect((await order('khach', 0.97)).status).toBe(201);

    // về giá thực tế → nhân viên giao dịch lại được
    expect((await call('POST', `/prices/${SYM}/live`, 'ops', { reason: 'Kết thúc' })).status).toBe(200);
    const again = await order('ops', 0.95);
    expect(again.status).toBe(201);

    // chuyển sang giá điều chỉnh (giữ giá) cũng huỷ lệnh chờ của nhân viên; nhật ký ghi ai vừa đặt lệnh
    const m = await call('POST', `/prices/${SYM}/manual`, 'ops', { reason: 'Giữ giá cho bài học' });
    expect(m.status).toBe(200);
    expect(m.body.staffOrdersCancelled).toBe(1);
    expect((await db.one<{ status: string }>('SELECT status FROM orders WHERE id = $1', [again.body.id]))!.status).toBe('CANCELED');
    const a = await db.one<{ detail: { staffRecentOrders: { email: string }[] } }>(`SELECT detail FROM admin_audit_log WHERE action = 'PRICE_MODE_MANUAL' ORDER BY id DESC LIMIT 1`);
    expect(a!.detail.staffRecentOrders.map((x) => x.email)).toContain(u.ops!.email);
    expect((await call('POST', `/prices/${SYM}/live`, 'ops', { reason: 'Kết thúc' })).status).toBe(200);
  });

  it('email: yêu cầu điều chỉnh số dư báo Tài chính khác; đổi vai trò báo chính chủ và các Quản trị hệ thống khác', async () => {
    sent.length = 0;
    await makeUser('khach4', 'USER');
    const big = await call('POST', `/users/${u.khach4!.id}/adjust-balance`, 'fin', { asset: 'USDT', amount: '2000', reason: 'Bồi hoàn lớn' });
    expect(big.status).toBe(202);
    expect(mailsTo('fin2', /Cần duyệt: Điều chỉnh số dư/)).toHaveLength(1);
    expect(mailsTo('fin', /Cần duyệt/)).toHaveLength(0);
    expect(mailsTo('risk', /Cần duyệt/)).toHaveLength(0);

    sent.length = 0;
    await makeUser('nv2', 'USER');
    const g = await call<{ request: ApprovalDTO }>('POST', `/users/${u.nv2!.id}/role`, 'admin1', { role: 'RISK', reason: 'Tuyển nhân viên rủi ro' });
    expect(mailsTo('admin2', /Cần duyệt: Cấp \/ đổi vai trò/)).toHaveLength(1);
    await call('POST', `/approvals/${g.body.request.id}/approve`, 'admin2', {});
    const self = mailsTo('nv2', /Vai trò tài khoản của bạn/);
    expect(self).toHaveLength(1);
    expect(self[0]!.text).toContain(`đề xuất bởi ${u.admin1!.email}, duyệt bởi ${u.admin2!.email}`);
    expect(mailsTo('admin1', /Vai trò của nv2@example.test/)).toHaveLength(1);
    expect(mailsTo('admin2', /Vai trò của/)).toHaveLength(0);
  });

  it('khôi phục dữ liệu: lưu file + chạy thử, quản trị hệ thống KHÁC duyệt mới ghi đè; file bị sửa sau khi đề xuất thì từ chối', async () => {
    const raw = Buffer.from(serializeBackup(await exportBackup(db, { exportedBy: 'test', tradeDate: '2026-10-17' })));
    expect((await call('POST', '/data/restore', 'ops', undefined, raw)).status).toBe(403);
    const dry = await call('POST', '/data/restore?dryRun=1', 'admin1', undefined, raw);
    expect(dry.body.dryRun).toBe(true);
    const r = await call<{ pending: boolean; request: ApprovalDTO; report: { tables: unknown[] } }>('POST', '/data/restore?reason=Kh%C3%B4i%20ph%E1%BB%A5c%20th%E1%BB%AD', 'admin1', undefined, raw);
    expect(r.status).toBe(202);
    expect(r.body.request).toMatchObject({ kind: 'DATA_RESTORE', reason: 'Khôi phục thử' });
    const file = r.body.request.payload.file as string;
    expect(file.startsWith(tmp)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect((await call('POST', `/approvals/${r.body.request.id}/approve`, 'admin1', {})).body.error.code).toBe('SELF');
    expect((await call('POST', `/approvals/${r.body.request.id}/approve`, 'risk', {})).status).toBe(403);
    // đề xuất khác đang chờ lúc khôi phục → hết hiệu lực sau khôi phục
    const other = await call<{ request: ApprovalDTO }>('POST', '/symbols/XRPUSDT/delist', 'ops', { reason: 'Đang chờ lúc khôi phục' });
    const ok = await call<ApprovalDTO>('POST', `/approvals/${r.body.request.id}/approve`, 'admin2', {});
    expect(ok.body).toMatchObject({ status: 'APPROVED', result: { dryRun: false, requestedBy: u.admin1!.email } });
    // đề xuất khôi phục vẫn còn (bảng đề xuất chỉ gộp khi khôi phục) và có kết quả
    expect((await db.one<{ status: string }>('SELECT status FROM approval_requests WHERE id = $1', [r.body.request.id]))!.status).toBe('APPROVED');
    expect((await db.one<{ status: string }>('SELECT status FROM approval_requests WHERE id = $1', [other.body.request.id]))!.status).toBe('EXPIRED');
    // file chứa toàn bộ dữ liệu người dùng bị xoá ngay sau khi thực hiện
    expect(fs.existsSync(file)).toBe(false);

    const r2 = await call<{ request: ApprovalDTO }>('POST', '/data/restore', 'admin1', undefined, raw);
    fs.appendFileSync(r2.body.request.payload.file as string, ' ');
    const bad = await call('POST', `/approvals/${r2.body.request.id}/approve`, 'admin2', {});
    expect(bad.body.error.code).toBe('BACKUP_CHANGED');
    expect((await db.one<{ status: string; result: { error: string } }>('SELECT status, result FROM approval_requests WHERE id = $1', [r2.body.request.id]))).toMatchObject({
      status: 'FAILED',
      result: { error: expect.stringMatching(/bị thay đổi/) },
    });
    expect(fs.existsSync(r2.body.request.payload.file as string)).toBe(false);

    // từ chối / rút / hết hạn đều xoá file
    const ends: [string, (id: number) => Promise<unknown>][] = [
      ['từ chối', (id) => call('POST', `/approvals/${id}/reject`, 'admin2', { note: 'Không đúng bản cần khôi phục' })],
      ['rút', (id) => call('POST', `/approvals/${id}/cancel`, 'admin1', {})],
      [
        'hết hạn',
        async (id) => {
          await db.many(`UPDATE approval_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
          await call('GET', '/approvals', 'audit');
        },
      ],
    ];
    for (const [label, end] of ends) {
      const x = await call<{ request: ApprovalDTO }>('POST', '/data/restore', 'admin1', undefined, raw);
      const f = x.body.request.payload.file as string;
      expect(fs.existsSync(f), label).toBe(true);
      await end(x.body.request.id);
      expect(fs.existsSync(f), label).toBe(false);
    }
    expect(fs.readdirSync(path.join(tmp, 'pending-restore'))).toEqual([]);
  });
});

describe('Khu quản trị mặc định cấm', () => {
  it('route chưa khai báo need(...) → không khởi động được', () => {
    const r = Router();
    r.get('/ok', need('admin.view'), (_req, res) => void res.json({}));
    expect(() => assertRoutesGuarded(r)).not.toThrow();
    r.post('/quen-gan-quyen', (_req, res) => void res.json({}));
    expect(() => assertRoutesGuarded(r)).toThrow(/POST \/quen-gan-quyen/);
  });
});
