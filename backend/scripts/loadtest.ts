/**
 * KHẢO SÁT CHỊU TẢI (demo — chỉ chạy với máy chủ local, không chạy vào hệ thống thật):
 *  1. Đăng nhập quản trị, tạo N nhà đầu tư thử qua API quản trị (POST /api/admin/users)
 *  2. Mỗi nhà đầu tư mở 1 kết nối realtime và gửi M lệnh: xen kẽ lệnh khớp ngay (LO giá trần, 100 CP)
 *     và lệnh chờ (LO giá sàn) rồi huỷ — tất cả nhà đầu tư chạy đồng thời
 *  3. Đo độ trễ API (p50/p95/p99), tỷ lệ lỗi, số thông báo khớp nhận qua realtime, tần suất cập nhật bảng giá
 *  4. Dọn dẹp: xoá toàn bộ tài khoản thử
 *
 * Chạy (máy chủ đang bật ở :4000):  npm run loadtest -w backend -- --users 30 --orders 20
 */
import fs from 'node:fs';
import path from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { signToken } from '../src/lib/auth';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = arg('url', 'http://localhost:4000');
const USERS = Number(arg('users', '20'));
const ORDERS = Number(arg('orders', '20'));
const SYMBOLS = arg('symbols', 'FPT,HPG,MBB,SSI,VNM,TCB,VPB,ACB').split(',');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@vnstock.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin12345';
const RUN = Date.now().toString(36);

interface Res<T = unknown> {
  status: number;
  ms: number;
  data: T & { error?: { code: string; message: string } };
}

async function call<T = unknown>(method: string, p: string, token?: string, body?: unknown): Promise<Res<T>> {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api${p}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Res<T>['data'];
  return { status: res.status, ms: performance.now() - t0, data };
}

function pct(xs: number[], p: number) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const r1 = (x: number) => Math.round(x * 10) / 10;

async function main() {
  console.log(`Khảo sát chịu tải → ${BASE} · ${USERS} nhà đầu tư × ${ORDERS} lệnh · mã ${SYMBOLS.join(', ')}`);
  const health0 = await call<{ openOrders: number }>('GET', '/health');
  if (health0.status >= 500 || health0.status === 0) throw new Error(`Máy chủ chưa sẵn sàng (${health0.status})`);

  const login = await call<{ token: string }>('POST', '/auth/login', undefined, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (!login.data.token) throw new Error(`Không đăng nhập được quản trị: ${login.data.error?.message}`);
  const admin = login.data.token;

  // Giá trần / sàn hiện tại của các mã thử
  const quotes = new Map<string, { ceil: number; floor: number }>();
  for (const s of SYMBOLS) {
    const q = await call<{ ceil: number; floor: number }>('GET', `/market/stocks/${s}`);
    if (q.status === 200) quotes.set(s, { ceil: q.data.ceil, floor: q.data.floor });
  }

  // 1. Tạo tài khoản thử
  const createMs: number[] = [];
  const users: { id: string; email: string; token: string }[] = [];
  for (let i = 0; i < USERS; i++) {
    const email = `loadtest-${RUN}-${i}@example.test`;
    const r = await call<{ id: string }>('POST', '/admin/users', admin, { fullName: `Thử tải ${i}`, email, password: 'loadtest123' });
    createMs.push(r.ms);
    if (r.status !== 201) throw new Error(`Tạo tài khoản thử thất bại: ${r.data.error?.message}`);
    users.push({ id: r.data.id, email, token: signToken({ id: r.data.id, email }) });
  }
  console.log(`Đã tạo ${users.length} tài khoản thử (trung bình ${r1(createMs.reduce((a, b) => a + b, 0) / createMs.length)} ms / tài khoản)`);

  // 2. Kết nối realtime
  const sockets: Socket[] = [];
  let boardEvents = 0;
  let fillEvents = 0;
  let orderEvents = 0;
  const connectMs: number[] = [];
  await Promise.all(
    users.map(
      (u) =>
        new Promise<void>((resolve) => {
          const t0 = performance.now();
          const s = io(BASE, { auth: { token: u.token }, transports: ['websocket'], reconnection: false });
          s.on('board', () => boardEvents++);
          s.on('fill', () => fillEvents++);
          s.on('order', () => orderEvents++);
          s.on('connect', () => {
            connectMs.push(performance.now() - t0);
            resolve();
          });
          s.on('connect_error', () => resolve());
          sockets.push(s);
        }),
    ),
  );
  console.log(`Đã mở ${connectMs.length}/${users.length} kết nối realtime`);

  // 3. Gửi lệnh đồng thời
  const placeMs: number[] = [];
  const cancelMs: number[] = [];
  const errors = new Map<string, number>();
  let filledOrders = 0;
  const boardBefore = boardEvents;
  const t0 = performance.now();
  await Promise.all(
    users.map(async (u, ui) => {
      for (let i = 0; i < ORDERS; i++) {
        const symbol = SYMBOLS[(ui + i) % SYMBOLS.length];
        const q = quotes.get(symbol);
        if (!q) continue;
        const aggressive = i % 2 === 0;
        const r = await call<{ id: number; status: string }>('POST', '/orders', u.token, {
          symbol,
          side: 'BUY',
          orderType: 'LO',
          price: aggressive ? q.ceil : q.floor,
          qty: 100,
        });
        placeMs.push(r.ms);
        if (r.status !== 201) {
          const code = r.data.error?.code ?? String(r.status);
          errors.set(code, (errors.get(code) ?? 0) + 1);
          continue;
        }
        if (r.data.status === 'FILLED') filledOrders++;
        if (!aggressive && (r.data.status === 'PENDING' || r.data.status === 'PARTIAL')) {
          const c = await call('DELETE', `/orders/${r.data.id}`, u.token);
          cancelMs.push(c.ms);
          if (c.status !== 200) {
            const code = c.data.error?.code ?? String(c.status);
            errors.set(`huỷ:${code}`, (errors.get(`huỷ:${code}`) ?? 0) + 1);
          }
        }
      }
    }),
  );
  const elapsed = (performance.now() - t0) / 1000;
  await new Promise((r) => setTimeout(r, 1500)); // chờ sự kiện realtime cuối cùng tới
  const boardRate = (boardEvents - boardBefore) / sockets.length / (elapsed + 1.5);

  const overview = await call<{ health: { rssBytes: number; openOrders: number } }>('GET', '/admin/overview', admin);
  for (const s of sockets) s.close();

  // 4. Dọn dẹp
  let deleted = 0;
  for (const u of users) {
    const r = await call('DELETE', `/admin/users/${u.id}`, admin, { confirmEmail: u.email, purge: true });
    if (r.status === 200) deleted++;
  }

  const requests = placeMs.length + cancelMs.length;
  const report = {
    at: new Date().toISOString(),
    target: BASE,
    users: USERS,
    ordersPerUser: ORDERS,
    durationSec: r1(elapsed),
    requests,
    throughputReqPerSec: r1(requests / elapsed),
    placeOrderMs: { p50: r1(pct(placeMs, 50)), p95: r1(pct(placeMs, 95)), p99: r1(pct(placeMs, 99)), max: r1(Math.max(...placeMs)) },
    cancelOrderMs: { p50: r1(pct(cancelMs, 50)), p95: r1(pct(cancelMs, 95)), max: r1(cancelMs.length ? Math.max(...cancelMs) : 0) },
    errors: Object.fromEntries(errors),
    errorRatePct: r1((([...errors.values()].reduce((a, b) => a + b, 0)) / Math.max(1, requests)) * 100),
    filledImmediately: filledOrders,
    realtime: {
      connected: connectMs.length,
      connectMsP95: r1(pct(connectMs, 95)),
      fillEventsReceived: fillEvents,
      orderEventsReceived: orderEvents,
      boardUpdatesPerSocketPerSec: r1(boardRate),
    },
    server: { rssMbAfter: r1((overview.data.health?.rssBytes ?? 0) / 1048576), openOrdersAfter: overview.data.health?.openOrders },
    cleanup: { deletedUsers: deleted },
  };

  console.log('\n=== KẾT QUẢ KHẢO SÁT ===');
  console.table({
    'Thời gian chạy (giây)': report.durationSec,
    'Tổng request lệnh': requests,
    'Thông lượng (request/giây)': report.throughputReqPerSec,
    'Đặt lệnh p50 (ms)': report.placeOrderMs.p50,
    'Đặt lệnh p95 (ms)': report.placeOrderMs.p95,
    'Đặt lệnh p99 (ms)': report.placeOrderMs.p99,
    'Đặt lệnh lâu nhất (ms)': report.placeOrderMs.max,
    'Huỷ lệnh p95 (ms)': report.cancelOrderMs.p95,
    'Tỷ lệ lỗi (%)': report.errorRatePct,
    'Lệnh khớp ngay': filledOrders,
    'Thông báo khớp nhận qua realtime': fillEvents,
    'Cập nhật bảng giá / kết nối / giây': report.realtime.boardUpdatesPerSocketPerSec,
    'RAM máy chủ sau thử (MB)': report.server.rssMbAfter,
    'Tài khoản thử đã xoá': deleted,
  });
  if (errors.size) console.log('Lỗi theo mã:', report.errors);
  const out = path.resolve(process.cwd(), 'data', `loadtest-${RUN}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`Báo cáo JSON: ${out}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Khảo sát thất bại:', err instanceof Error ? err.message : err);
  process.exit(1);
});
