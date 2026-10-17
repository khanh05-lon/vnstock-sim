import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express from 'express';
import bcrypt from 'bcryptjs';
import { Server } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, STAFF_ROLES, can, rolesWith, type ApprovalDTO, type Permission, type UserRole } from '@vss/shared';
import { exportBackup, serializeBackup } from '../src/admin/backup';
import { adminRoutes } from '../src/admin/routes';
import { AdminStore } from '../src/admin/store';
import { config } from '../src/config';
import type { Database } from '../src/db';
import { signToken } from '../src/lib/auth';
import { errorHandler } from '../src/lib/errors';
import type { Mailer } from '../src/lib/mailer';
import { MarketService } from '../src/market/marketService';
import { seedSymbols } from '../src/market/symbols';
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
    expect(rolesWith('support.desk').sort()).toEqual(['ADMIN', 'RISK', 'SUPPORT']);
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
  const mailer: Mailer = { kind: 'smtp', send: async () => undefined };
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
    expect((await call('POST', `/users/${u.cskh!.id}/role`, 'admin1', { role: 'AUDITOR' })).status).toBe(200);
    expect((await call('POST', `/users/${u.cskh!.id}/role`, 'admin1', { role: 'SUPPORT' })).status).toBe(200);
    expect((await call('POST', `/users/${u.cskh!.id}/role`, 'admin1', { role: 'GOD' })).status).toBe(400);
  });

  it('tạm ngừng toàn sàn: đề xuất → người khác duyệt mới ngừng; mở lại có hiệu lực ngay', async () => {
    const r = await call<{ pending: boolean; request: ApprovalDTO }>('POST', '/market/halt', 'ops', { halted: true, reason: 'Sự cố nguồn giá' });
    expect(r.status).toBe(202);
    expect(engine.control.haltAll).toBe(false);
    expect((await call('POST', '/market/halt', 'ops2', { halted: true, reason: 'Gửi trùng' })).body.error.code).toBe('PENDING_EXISTS');
    expect((await call('POST', `/approvals/${r.body.request.id}/approve`, 'fin', {})).status).toBe(403);
    const ok = await call<ApprovalDTO>('POST', `/approvals/${r.body.request.id}/approve`, 'risk', {});
    expect(ok.body).toMatchObject({ status: 'APPROVED', decidedByEmail: u.risk!.email });
    expect(engine.control.haltAll).toBe(true);
    expect(engine.control.haltReason).toBe('Sự cố nguồn giá');
    expect((await call('POST', '/market/halt', 'ops', { halted: false })).status).toBe(200);
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
    const ok = await call<ApprovalDTO>('POST', `/approvals/${r.body.request.id}/approve`, 'admin2', {});
    expect(ok.body).toMatchObject({ status: 'APPROVED', result: { dryRun: false, requestedBy: u.admin1!.email } });
    // đề xuất khôi phục vẫn còn (bảng đề xuất chỉ gộp khi khôi phục) và có kết quả
    expect((await db.one<{ status: string }>('SELECT status FROM approval_requests WHERE id = $1', [r.body.request.id]))!.status).toBe('APPROVED');

    const r2 = await call<{ request: ApprovalDTO }>('POST', '/data/restore', 'admin1', undefined, raw);
    fs.appendFileSync(r2.body.request.payload.file as string, ' ');
    const bad = await call('POST', `/approvals/${r2.body.request.id}/approve`, 'admin2', {});
    expect(bad.body.error.code).toBe('BACKUP_CHANGED');
    expect((await db.one<{ status: string; result: { error: string } }>('SELECT status, result FROM approval_requests WHERE id = $1', [r2.body.request.id]))).toMatchObject({
      status: 'FAILED',
      result: { error: expect.stringMatching(/bị thay đổi/) },
    });
  });
});
