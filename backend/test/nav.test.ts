import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/db';
import { signToken } from '../src/lib/auth';
import { errorHandler } from '../src/lib/errors';
import { NavService, navOf, publicName } from '../src/portfolio/nav';
import { communityRoutes } from '../src/routes/community';
import { createUserAccount } from '../src/seed/seed';
import { closeTestDb, openTestDb } from './helpers/db';

let db: Database;
const prices: Record<string, number> = { FPT: 110_000, VNM: 60_000 };
const market = { tradeDate: '2026-10-15', markPrice: (s: string) => prices[s] ?? 0 };
let nav: NavService;

beforeAll(async () => {
  db = await openTestDb();
  await db.exec(`INSERT INTO stocks (symbol, exchange, name, industry, listed_shares, eps, bvps) VALUES
    ('FPT','HOSE','FPT','Test',1000000000,1,1), ('VNM','HOSE','VNM','Test',1000000000,1,1)`);
  await db.exec(`INSERT INTO ohlcv_daily (symbol, trade_date, open, high, low, close, volume, value) VALUES
    ('FPT','2026-10-12',100000,100000,100000,100000,1,1), ('FPT','2026-10-13',102000,102000,102000,102000,1,1), ('FPT','2026-10-14',105000,105000,105000,105000,1,1),
    ('VNM','2026-10-12',60000,60000,60000,60000,1,1), ('VNM','2026-10-13',60000,60000,60000,60000,1,1), ('VNM','2026-10-14',60000,60000,60000,60000,1,1)`);
  nav = new NavService(db, market);
});
afterAll(() => closeTestDb(db));

/** Tài khoản có lịch sử: nạp vốn 12/10, mua 1.000 FPT giá 100.000 ngày 13/10 */
async function investor(email: string, name: string) {
  const u = await db.tx((tx) => createUserAccount(tx, email, 'x', name));
  await db.many(`UPDATE transactions_ledger SET created_at = '2026-10-12T02:00:00Z' WHERE user_id = $1`, [u.id]);
  const o = await db.one<{ id: number }>(
    `INSERT INTO orders (user_id, symbol, side, order_type, price, hold_price, qty, filled_qty, avg_fill_price, status, trade_date, created_at)
     VALUES ($1,'FPT','BUY','LO',100000,100000,1000,1000,100000,'FILLED','2026-10-13','2026-10-13T03:00:00Z') RETURNING id`,
    [u.id],
  );
  await db.many(`INSERT INTO trades (order_id, user_id, symbol, side, price, qty, value, fee, executed_at) VALUES ($1,$2,'FPT','BUY',100000,1000,100000000,150000,'2026-10-13T03:00:00Z')`, [
    o!.id,
    u.id,
  ]);
  await db.many(
    `INSERT INTO transactions_ledger (user_id, type, amount, balance_after, order_id, created_at) VALUES
     ($1,'BUY',-100000000,900000000,$2,'2026-10-13T03:00:00Z'), ($1,'FEE',-150000,899850000,$2,'2026-10-13T03:00:00Z')`,
    [u.id, o!.id],
  );
  await db.many(`UPDATE accounts SET cash_balance = 899850000 WHERE user_id = $1`, [u.id]);
  await db.many(`INSERT INTO holdings (user_id, symbol, qty_total, qty_available, total_cost) VALUES ($1,'FPT',1000,1000,100150000)`, [u.id]);
  return u.id;
}

describe('NAV theo ngày', () => {
  it('công thức NAV: tiền + chờ về + cổ phiếu + quyền − nợ', () => {
    expect(navOf({ user_id: 'x', cash_balance: 100, contributed: 1000, cash_pending: 20, loan_balance: 50, loan_interest: 5 }, 900, 10)).toMatchObject({
      nav: 100 + 20 + 900 + 10 - 55,
      cash: 120,
      debt: 55,
    });
  });

  it('dựng lại lịch sử từ sao kê + lịch sử khớp, định giá theo giá đóng cửa; chụp NAV hôm nay', async () => {
    const id = await investor('nav@example.test', 'Lê Văn Định');
    expect(await nav.backfill(id)).toBe(3);
    const rows = await db.many<{ d: string; nav: number; cash: number; stock_value: number }>(
      `SELECT trade_date::text AS d, nav, cash, stock_value FROM nav_daily WHERE user_id = $1 ORDER BY trade_date`,
      [id],
    );
    expect(rows).toEqual([
      { d: '2026-10-12', nav: 1_000_000_000, cash: 1_000_000_000, stock_value: 0 },
      { d: '2026-10-13', nav: 899_850_000 + 102_000_000, cash: 899_850_000, stock_value: 102_000_000 },
      { d: '2026-10-14', nav: 899_850_000 + 105_000_000, cash: 899_850_000, stock_value: 105_000_000 },
    ]);
    await nav.snapshotAll();
    const today = await db.one<{ nav: number }>(`SELECT nav FROM nav_daily WHERE user_id = $1 AND trade_date = '2026-10-15'`, [id]);
    expect(today!.nav).toBe(899_850_000 + 110_000_000);
  });
});

describe('Bảng xếp hạng', () => {
  let server: http.Server;
  let base: string;
  beforeAll(async () => {
    const app = express();
    app.use('/api', communityRoutes(db, nav, market));
    app.use(errorHandler);
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it('xếp theo tỷ suất lợi nhuận, ẩn người chọn ẩn / chưa giao dịch, không lộ email; người xem thấy hạng của mình', async () => {
    const good = await investor('tot@example.test', 'Trần Thị Tốt');
    const hidden = await investor('an@example.test', 'Phạm Ẩn');
    await db.many(`UPDATE users SET show_on_leaderboard = false WHERE id = $1`, [hidden]);
    await db.many(`UPDATE accounts SET cash_balance = cash_balance + 50000000 WHERE user_id = $1`, [good]); // lãi thêm
    await db.tx((tx) => createUserAccount(tx, 'moi@example.test', 'x', 'Chưa Giao Dịch'));

    const res = await fetch(`${base}/leaderboard?period=ALL`, { headers: { Authorization: `Bearer ${signToken({ id: hidden, email: 'an@example.test' })}` } });
    const body = (await res.json()) as { rows: { rank: number; name: string; returnPct: number }[]; me: { hidden: boolean; rank: number | null } };
    expect(body.rows.map((r) => r.name)).toEqual(['T.T. Tốt', 'L.V. Định']);
    expect(body.rows[0].returnPct).toBeCloseTo(((899_850_000 + 50_000_000 + 110_000_000 - 1e9) / 1e9) * 100, 2);
    expect(JSON.stringify(body)).not.toContain('@example.test');
    expect(body.me).toMatchObject({ hidden: true, rank: null });

    // theo tuần: so với NAV đầu kỳ (đã có trong nav_daily)
    const week = (await (await fetch(`${base}/leaderboard?period=1W`)).json()) as { rows: unknown[] };
    expect(week.rows.length).toBe(2);
  });

  it('tên hiển thị công khai', () => {
    expect(publicName('Nguyễn Văn An', null)).toBe('N.V. An');
    expect(publicName('Minh', null)).toBe('Minh');
    expect(publicName('Nguyễn Văn An', 'Sói già')).toBe('Sói già');
  });
});
