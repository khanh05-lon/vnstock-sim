import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RULES, applyRules, buyHoldAmount, calcFee, priceBand } from '@vss/shared';
import { installAdmin } from '../src/admin';
import type { Database } from '../src/db';
import { initSessionCheck, signToken } from '../src/lib/auth';
import { setHolidays } from '../src/lib/calendar';
import { errorHandler } from '../src/lib/errors';
import type { Mailer } from '../src/lib/mailer';
import { mulberry32 } from '../src/lib/prng';
import { MarketService } from '../src/market/marketService';
import { MockProvider } from '../src/market/mockProvider';
import { createUserAccount } from '../src/seed/seed';
import { noopNotifier, TradingEngine } from '../src/trading/engine';
import { closeTestDb, openTestDb } from './helpers/db';

let db: Database;
let market: MarketService;
let engine: TradingEngine;
let server: http.Server;
let io: Server;
let base: string;
let adminToken: string;
let investorId: string;
const mailer: Mailer = { kind: 'log', send: async () => undefined };
const NOW = Date.parse('2026-10-15T03:00:00Z'); // 10:00 giờ VN

async function call(method: string, path: string, body?: unknown, raw?: Buffer) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      ...(raw ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* tải file */
  }
  return { status: res.status, body: json, text };
}

const indexValue = (code: string) => market.indexSnapshots().find((i) => i.code === code)!.value;

beforeAll(async () => {
  setHolidays([]);
  db = await openTestDb();
  initSessionCheck(db);
  await db.exec(`INSERT INTO stocks (symbol, exchange, name, industry, listed_shares, eps, bvps, is_vn30, margin_ratio) VALUES
    ('FPT','HOSE','FPT','Công nghệ',1500000000,5900,22000,true,0.5),
    ('VCB','HOSE','Vietcombank','Ngân hàng',5500000000,6000,40000,true,0.5),
    ('HPG','HOSE','Hoà Phát','Thép',7600000000,1900,16500,false,0.3),
    ('SHS','HNX','Chứng khoán SHS','Chứng khoán',813000000,900,12500,false,0.2)`);
  await db.exec(`INSERT INTO ohlcv_daily (symbol, trade_date, open, high, low, close, volume, value) VALUES
    ('FPT','2026-10-14',98000,99000,97000,98500,1,1), ('VCB','2026-10-14',65000,66000,64000,65500,1,1),
    ('HPG','2026-10-14',26500,27000,26300,26800,1,1), ('SHS','2026-10-14',12000,12200,11900,12100,1,1)`);
  market = new MarketService(db, new MockProvider(mulberry32(5)), { mode: 'SIMULATED_24_7', tickIntervalMs: 1000 });
  await market.init(NOW);
  engine = new TradingEngine(db, market, noopNotifier, { settlementDays: 0 });
  await engine.load();

  const admin = await db.tx((tx) => createUserAccount(tx, 'qtv@example.test', 'x', 'Quản trị'));
  await db.many(`UPDATE users SET role = 'ADMIN' WHERE id = $1`, [admin.id]);
  adminToken = signToken({ id: admin.id, email: admin.email });
  investorId = (await db.tx((tx) => createUserAccount(tx, 'ndt@example.test', 'x', 'Nhà đầu tư'))).id;

  const app = express();
  app.use(express.json());
  io = new Server();
  await installAdmin({ app, io, db, market, engine, mailer, providerName: 'mock', settlementDays: 0 });
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  applyRules({});
  initSessionCheck(null);
  io.disconnectSockets(true);
  await new Promise((r) => server.close(r));
  await closeTestDb(db);
});

describe('Tham số giao dịch do quản trị viên chỉnh', () => {
  it('đổi phí: lệnh đã đặt giữ biểu phí cũ, lệnh mới theo biểu phí mới; tham số công khai qua /api/system', async () => {
    const fpt = market.quote('FPT')!;
    const limit = fpt.floor;
    const resting = await engine.placeOrder(investorId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: limit, qty: 1_000 });
    expect(resting.holdAmount).toBe(buyHoldAmount(limit, 1_000, 0.0015));

    const r = await call('PUT', '/admin/rules', { feeRate: 0.003, priceLimitPct: { HOSE: 10 } });
    expect(r.status).toBe(200);
    expect(RULES.feeRate).toBe(0.003);
    const sys = (await (await fetch(`${base}/system`)).json()) as { rules: typeof RULES };
    expect(sys.rules.feeRate).toBe(0.003);
    expect(sys.rules.priceLimitPct).toEqual({ HOSE: 10, HNX: 10, UPCOM: 15 });

    // lệnh cũ khớp với phí 0,15% dù biểu phí đã tăng → không vượt số tiền đã phong toả
    await engine.onTick(new Set(['FPT']), new Map([['FPT', { price: limit, vol: 5_000 }]]));
    const trade = await db.one<{ fee: number; value: number }>('SELECT fee, value FROM trades WHERE order_id = $1', [resting.id]);
    expect(trade!.fee).toBe(calcFee(trade!.value, 0.0015));

    const fresh = await engine.placeOrder(investorId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: limit, qty: 100 });
    expect(fresh.holdAmount).toBe(buyHoldAmount(limit, 100, 0.003));
    await engine.cancelOrder(investorId, fresh.id);
  });

  it('từ chối tham số sai; khôi phục mặc định', async () => {
    expect((await call('PUT', '/admin/rules', { feeRate: 0.5 })).status).toBe(400);
    expect((await call('PUT', '/admin/rules', { margin: { forceRatio: 0.6 } })).status).toBe(400);
    expect((await call('PUT', '/admin/rules', { lotSize: 10 })).status).toBe(400);
    expect((await call('DELETE', '/admin/rules')).status).toBe(200);
    expect(RULES.feeRate).toBe(0.0015);
    expect(RULES.priceLimitPct.HOSE).toBe(7);
    const audit = await db.many<{ action: string }>(`SELECT action FROM admin_audit_log WHERE action LIKE 'RULES_%' ORDER BY id`);
    expect(audit.map((a) => a.action)).toEqual(['RULES_UPDATE', 'RULES_RESET']);
  });
});

describe('Danh mục mã: niêm yết, rổ VN30, huỷ niêm yết', () => {
  it('niêm yết mã mới: lên bảng giá ngay, có lịch sử giả lập, chỉ số không nhảy', async () => {
    const vni = indexValue('VNINDEX');
    const vn30 = indexValue('VN30');
    const r = await call('POST', '/admin/symbols', {
      symbol: 'NEW',
      exchange: 'HOSE',
      name: 'Công ty Cổ phần Niêm yết Mới',
      industry: 'Công nghệ',
      listedShares: 500_000_000,
      ref: 20_050,
      isVn30: true,
      marginRatio: 0.3,
    });
    expect(r.status).toBe(201);
    const s = market.quote('NEW')!;
    expect(s.ref).toBe(20_050);
    expect({ ceil: s.ceil, floor: s.floor }).toEqual(priceBand('HOSE', 20_050));
    expect(market.rows().some((x) => x.symbol === 'NEW' && x.marginRatio === 0.3)).toBe(true);
    expect(indexValue('VNINDEX')).toBeCloseTo(vni, 1);
    expect(indexValue('VN30')).toBeCloseTo(vn30, 1);
    const bars = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ohlcv_daily WHERE symbol = 'NEW'`);
    expect(bars!.n).toBe(250);
    // giá sai bước giá, mã trùng → từ chối
    expect((await call('POST', '/admin/symbols', { symbol: 'BAD', exchange: 'HOSE', name: 'Sai bước giá', industry: 'Thử nghiệm', listedShares: 1e9, ref: 20_020 })).status).toBe(400);
    expect((await call('POST', '/admin/symbols', { symbol: 'FPT', exchange: 'HOSE', name: 'Trùng mã', industry: 'Thử nghiệm', listedShares: 1e9, ref: 20_000 })).status).toBe(409);
  });

  it('đưa mã ra khỏi rổ VN30: VN30 không nhảy, số mã trong rổ giảm', async () => {
    const vn30 = indexValue('VN30');
    const r = await call('PATCH', '/admin/symbols/NEW', { isVn30: false });
    expect(r.status).toBe(200);
    expect(market.info('NEW')!.isVn30).toBe(false);
    expect(indexValue('VN30')).toBeCloseTo(vn30, 1);
    const list = await call('GET', '/admin/symbols');
    expect(list.body.find((x: { symbol: string }) => x.symbol === 'NEW')).toMatchObject({ isVn30: false, status: 'ACTIVE' });
  });

  it('huỷ niêm yết: huỷ lệnh chờ, trả tiền cho người nắm giữ theo giá thanh toán, gỡ khỏi bảng giá', async () => {
    await db.many(`INSERT INTO holdings (user_id, symbol, qty_total, qty_available, total_cost) VALUES ($1, 'VCB', 2000, 2000, 130000000)`, [investorId]);
    const vcb = market.quote('VCB')!;
    const sell = await engine.placeOrder(investorId, { symbol: 'VCB', side: 'SELL', orderType: 'LO', price: vcb.ceil, qty: 500 });
    const cashBefore = (await db.one<{ cash_balance: number }>('SELECT cash_balance FROM accounts WHERE user_id = $1', [investorId]))!.cash_balance;
    const vni = indexValue('VNINDEX');

    const r = await call('POST', '/admin/symbols/VCB/delist', { reason: 'Chuyển sàn (thử nghiệm)', payoutPrice: 64_000 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ holdersPaid: 1, cancelledOrders: 1, payoutPrice: 64_000 });
    expect((await engine.getOrder(investorId, sell.id)).status).toBe('CANCELLED');
    expect(await db.one(`SELECT 1 FROM holdings WHERE user_id = $1 AND symbol = 'VCB'`, [investorId])).toBeUndefined();
    const cashAfter = (await db.one<{ cash_balance: number }>('SELECT cash_balance FROM accounts WHERE user_id = $1', [investorId]))!.cash_balance;
    expect(cashAfter - cashBefore).toBe(2_000 * 64_000);
    const led = await db.one<{ amount: number; type: string }>(`SELECT type, amount FROM transactions_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [investorId]);
    expect(led).toMatchObject({ type: 'DELIST', amount: 128_000_000 });
    expect(market.quote('VCB')).toBeUndefined();
    expect(indexValue('VNINDEX')).toBeCloseTo(vni, 1);
    expect((await db.one<{ status: string }>(`SELECT status FROM stocks WHERE symbol = 'VCB'`))!.status).toBe('DELISTED');
    await expect(engine.placeOrder(investorId, { symbol: 'VCB', side: 'BUY', orderType: 'LO', price: 64_000, qty: 100 })).rejects.toThrow(/không tồn tại/);
  });
});

describe('Sao lưu & khôi phục dữ liệu', () => {
  it('chạy thử không thay đổi gì; khôi phục thật đưa dữ liệu về đúng thời điểm sao lưu', async () => {
    const exp = await call('GET', '/admin/data/export');
    expect(exp.status).toBe(200);
    const file = Buffer.from(exp.text);
    const backup = JSON.parse(exp.text);
    expect(backup.version).toBe(2);
    expect(backup.data.users.every((u: { password_hash?: string }) => typeof u.password_hash === 'string')).toBe(true);
    const ordersAtBackup = backup.counts.orders as number;
    const maxOrderId = Math.max(...backup.data.orders.map((o: { id: number }) => o.id));

    // phát sinh sau thời điểm sao lưu
    const late = (await db.tx((tx) => createUserAccount(tx, 'sau@example.test', 'x', 'Người đến sau'))).id;
    await engine.placeOrder(investorId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: market.quote('FPT')!.floor, qty: 100 });

    const dry = await call('POST', '/admin/data/restore?dryRun=1', undefined, file);
    expect(dry.status).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.tables.find((t: { name: string }) => t.name === 'orders').rows).toBe(ordersAtBackup);
    expect(await db.one('SELECT 1 FROM users WHERE id = $1', [late])).toBeTruthy();

    const real = await call('POST', '/admin/data/restore', undefined, file);
    expect(real.status).toBe(200);
    expect(fs.existsSync(real.body.autoBackupFile)).toBe(true);
    fs.unlinkSync(real.body.autoBackupFile);
    expect(await db.one('SELECT 1 FROM users WHERE id = $1', [late])).toBeUndefined();
    expect((await db.one<{ n: number }>('SELECT count(*)::int AS n FROM orders'))!.n).toBe(ordersAtBackup);
    // bộ đếm id nối tiếp dữ liệu đã khôi phục; bộ khớp lệnh nạp lại lệnh đang chờ
    const next = await engine.placeOrder(investorId, { symbol: 'FPT', side: 'BUY', orderType: 'LO', price: market.quote('FPT')!.floor, qty: 100 });
    expect(next.id).toBeGreaterThan(maxOrderId);
    const audit = await db.one<{ action: string }>(`SELECT action FROM admin_audit_log ORDER BY id DESC LIMIT 1`);
    expect(audit!.action).toBe('DATA_RESTORE');
  });

  it('từ chối file không phải bản sao lưu', async () => {
    expect((await call('POST', '/admin/data/restore?dryRun=1', undefined, Buffer.from('{"hello":1}'))).status).toBe(400);
    expect((await call('POST', '/admin/data/restore?dryRun=1', undefined, Buffer.from('không phải json'))).status).toBe(400);
  });
});
