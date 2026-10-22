import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import express from 'express';
import bcrypt from 'bcryptjs';
import { Server } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySquareRules, type SquareFeedDTO, type SquareMeDTO, type SquarePostDTO, type UserRole } from '@vss/shared';
import { adminRoutes } from '../src/admin/routes';
import { AdminStore } from '../src/admin/store';
import type { Database } from '../src/db';
import { initSessionCheck, signToken } from '../src/lib/auth';
import { errorHandler } from '../src/lib/errors';
import type { Mailer } from '../src/lib/mailer';
import type { MarketService } from '../src/market/marketService';
import { PrivacyService } from '../src/privacy/service';
import { createUserAccount } from '../src/seed/seed';
import { squareRoutes } from '../src/square/routes';
import { SquareService } from '../src/square/service';
import { SpotEngine } from '../src/trading/engine';
import { closeTestDb, openTestDb } from './helpers/db';
import { FakeMarket, TEST_FILTERS } from './helpers/fakeMarket';

let db: Database;
let server: http.Server;
let base: string;
let square: SquareService;
const mailer: Mailer = { kind: 'smtp', send: async () => undefined };
const emails: { userId: string; title: string }[] = [];

type U = { id: string; email: string; token: string };
let ann: U, bob: U, cat: U, dan: U, eve: U, fay: U, gus: U, newbie: U, unverified: U, mod: U, mod2: U, risk: U, dpo: U;

async function call<T = any>(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

/** Tài khoản đã xác thực email, tạo 10 ngày trước (đủ điều kiện đăng / báo cáo) */
async function makeUser(email: string, role: UserRole = 'USER', o: { verified?: boolean; ageDays?: number } = {}): Promise<U> {
  const hash = await bcrypt.hash('matkhau123', 4);
  const u = await db.tx((tx) => createUserAccount(tx, email, hash, email.split('@')[0]!));
  await db.many(`UPDATE users SET role = $2, email_verified_at = $3, created_at = now() - make_interval(days => $4::int) WHERE id = $1`, [
    u.id,
    role,
    o.verified === false ? null : new Date(),
    o.ageDays ?? 10,
  ]);
  return { id: u.id, email, token: signToken({ id: u.id, email }) };
}

const profile = (u: U, handle: string) => call('PUT', '/square/me', u.token, { handle, displayName: handle.toUpperCase(), bio: '', acceptGuidelines: true });
const post = (u: U, body: string, extra: Record<string, unknown> = {}) => call<SquarePostDTO & { error?: any }>('POST', '/square/posts', u.token, { body, ...extra });

beforeAll(async () => {
  db = await openTestDb();
  initSessionCheck(db);
  for (const [s, b] of [
    ['BTCUSDT', 'BTC'],
    ['ETHUSDT', 'ETH'],
  ])
    await db.many(`INSERT INTO symbols (symbol, base_asset, quote_asset, name, filters) VALUES ($1, $2, 'USDT', $2, $3)`, [s, b, JSON.stringify(TEST_FILTERS)]);
  const market = new FakeMarket();
  market.add('BTCUSDT', 'BTC', '80000', [['79990', '5']], [['80010', '5']]);
  market.add('ETHUSDT', 'ETH', '3000', [['2999', '5']], [['3001', '5']]);
  const engine = new SpotEngine(db, market, { order: () => undefined, fill: () => undefined, account: () => undefined });
  await engine.load();
  const store = new AdminStore(db, engine);
  await store.load();
  square = new SquareService({
    db,
    market: { listedAssets: () => [...market.symbols.values()].map((s) => s.info.baseAsset), lastPrice: (s) => market.lastPrice(s) },
    roiOf: async () => 12.345,
    emailUser: async (userId, title) => void emails.push({ userId, title }),
  });
  const deps = { db, io: new Server(), market: market as unknown as MarketService, engine, store, mailer, square };
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes(deps));
  app.use('/api', squareRoutes(square));
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  [ann, bob, cat, dan, eve, fay, gus] = await Promise.all(['ann', 'bob', 'cat', 'dan', 'eve', 'fay', 'gus'].map((n) => makeUser(`${n}@sq.test`)));
  newbie = await makeUser('newbie@sq.test', 'USER', { ageDays: 0 });
  unverified = await makeUser('unv@sq.test', 'USER', { verified: false });
  mod = await makeUser('mod@sq.test', 'CONTENT_MOD');
  mod2 = await makeUser('mod2@sq.test', 'CONTENT_MOD');
  risk = await makeUser('risk@sq.test', 'RISK');
  dpo = await makeUser('dpo@sq.test', 'DPO');
});

afterAll(async () => {
  applySquareRules(null);
  initSessionCheck(null);
  await new Promise((r) => server.close(r));
  await closeTestDb(db);
});

describe('hồ sơ & điều kiện đăng', () => {
  it('chưa xác thực email / tài khoản mới / nhân viên / chưa có hồ sơ đều không đăng được', async () => {
    expect((await post(unverified, 'xin chào')).body.error.code).toBe('EMAIL_UNVERIFIED');
    expect((await post(newbie, 'xin chào')).body.error.code).toBe('ACCOUNT_TOO_NEW');
    expect((await post(risk, 'xin chào')).body.error.code).toBe('STAFF');
    expect((await profile(risk, 'risk_guy')).status).toBe(403);
    expect((await post(ann, 'xin chào')).body.error.code).toBe('NO_PROFILE');
  });

  it('tên mạo danh / tục bị từ chối; phải đồng ý tiêu chuẩn; tên trùng bị từ chối', async () => {
    expect((await profile(ann, 'vncoin_support')).body.error.code).toBe('NAME_REJECTED');
    expect((await profile(ann, 'ann_vcl')).body.error.code).toBe('NAME_REJECTED');
    expect((await call('PUT', '/square/me', ann.token, { handle: 'ann_trader', displayName: 'Ann' })).body.error.code).toBe('GUIDELINES');
    expect((await profile(ann, 'ann_trader')).status).toBe(200);
    expect((await profile(bob, 'ann_trader')).body.error.code).toBe('HANDLE_TAKEN');
    for (const [u, h] of [
      [bob, 'bob_swing'],
      [cat, 'cat_dca'],
      [dan, 'dan_hodl'],
      [eve, 'eve_btc'],
      [fay, 'fay_eth'],
      [gus, 'gus_alt'],
    ] as const)
      expect((await profile(u, h)).status).toBe(200);
    const me = (await call<SquareMeDTO>('GET', '/square/me', ann.token)).body;
    expect(me.profile?.handle).toBe('ann_trader');
    expect(me.canPost).toBe(true);
  });
});

describe('đăng bài & bộ lọc', () => {
  let clean: number;
  let held: number;

  it('bài sạch hiện ngay; $coin chỉ nhận coin niêm yết; ai cũng đọc được', async () => {
    const r = await post(ann, '$BTC giữ hỗ trợ tốt, $XYZ thì không biết #phantich', { sentiment: 'BULLISH' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'PUBLISHED', assets: ['BTC'], hashtags: ['phantich'], sentiment: 'BULLISH', mine: true });
    clean = r.body.id;
    const feed = (await call<SquareFeedDTO>('GET', '/square/feed?tab=latest')).body;
    expect(feed.posts.map((p) => p.id)).toContain(clean);
    expect((await call<SquareFeedDTO>('GET', '/square/feed?tab=latest&coin=BTC')).body.posts.map((p) => p.id)).toContain(clean);
    expect((await call<SquareFeedDTO>('GET', '/square/feed?tab=latest&coin=ETH')).body.posts).toHaveLength(0);
    expect((await call<SquareFeedDTO>('GET', '/square/feed?tab=foryou')).body.posts.map((p) => p.id)).toContain(clean);
  });

  it('vi phạm rõ bị chặn 400, không lưu', async () => {
    const r = await post(bob, 'liên hệ mình 0912 345 678 nhé');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'CONTENT_BLOCKED', rules: ['PII'] });
    expect(r.body.error.message).not.toContain('0912');
    expect((await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM square_posts WHERE user_id = $1`, [bob.id]))!.n).toBe(0);
  });

  it('nghi ngờ → chờ duyệt: chỉ tác giả thấy; kiểm duyệt viên duyệt thì hiện', async () => {
    const r = await post(bob, 'Anh em ib mình để vào nhóm kín nhận kèo');
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('PENDING');
    expect(r.body.hits?.map((h) => h.rule)).toContain('SCAM');
    held = r.body.id;
    expect((await call('GET', `/square/posts/${held}`, cat.token)).status).toBe(404);
    expect((await call('GET', `/square/posts/${held}`, bob.token)).status).toBe(200);
    expect((await call<SquareFeedDTO>('GET', '/square/feed?tab=latest')).body.posts.map((p) => p.id)).not.toContain(held);
    const q = (await call<any[]>('GET', '/admin/square/queue?view=pending', mod.token)).body;
    expect(q.find((x) => x.id === String(held))).toMatchObject({ type: 'POST', author: { handle: 'bob_swing' } });
    expect(q[0].author.email).toBeUndefined();
    expect((await call('GET', '/admin/square/queue', ann.token)).status).toBe(403);
    expect((await call('GET', '/admin/square/queue', risk.token)).status).toBe(403);
    expect((await call('GET', '/admin/users', mod.token)).status).toBe(403); // không có users.view
    expect((await call('POST', `/admin/square/posts/${held}/approve`, mod.token, {})).status).toBe(200);
    expect((await call('GET', `/square/posts/${held}`, cat.token)).status).toBe(200);
  });

  it('chia sẻ lệnh: chỉ lệnh đã khớp của chính mình, số liệu do máy chủ dựng', async () => {
    const o = await db.one<{ id: number }>(
      `INSERT INTO orders (client_order_id, user_id, symbol, side, type, orig_qty, executed_qty, cumm_quote_qty, status, maker_fee, taker_fee, locked_asset)
       VALUES ('sq1', $1, 'BTCUSDT', 'BUY', 'MARKET', '0.1', '0.1', '7000', 'FILLED', 0.001, 0.001, 'USDT') RETURNING id`,
      [ann.id],
    );
    expect((await post(bob, 'Lệnh của mình', { share: { type: 'ORDER', orderId: o!.id } })).body.error.code).toBe('SHARE_ORDER');
    const r = await post(ann, 'Vào lệnh từ sớm', { share: { type: 'ORDER', orderId: o!.id } });
    expect(r.body.share).toMatchObject({ type: 'ORDER', symbol: 'BTCUSDT', side: 'BUY', avgPrice: '70000', priceAtShare: '80000', pnlPct: 14.29 });
    expect(r.body.assets).toEqual(['BTC']);
    const roi = await post(ann, 'ROI của mình', { share: { type: 'ROI' } });
    expect(roi.body.share).toMatchObject({ type: 'ROI', returnPct: 12.35 });
  });

  it('thích, bình luận, trả lời → đếm + thông báo; theo dõi → bảng tin Đang theo dõi', async () => {
    expect((await call('POST', `/square/posts/${clean}/like`, cat.token)).body).toEqual({ liked: true, likeCount: 1 });
    expect((await call('POST', `/square/posts/${clean}/like`, cat.token)).body.likeCount).toBe(1);
    const c = await call('POST', `/square/posts/${clean}/comments`, cat.token, { body: 'Đồng ý với bạn' });
    expect(c.status).toBe(201);
    const reply = await call('POST', `/square/posts/${clean}/comments`, ann.token, { body: 'Cảm ơn nhé', parentId: c.body.id });
    expect(reply.body.parentId).toBe(c.body.id);
    expect((await call('POST', `/square/posts/${clean}/comments`, dan.token, { body: 'đm sai rồi' })).body.error.code).toBe('CONTENT_BLOCKED');
    const p = (await call<SquarePostDTO>('GET', `/square/posts/${clean}`, cat.token)).body;
    expect(p).toMatchObject({ likeCount: 1, commentCount: 2, liked: true });
    expect((await call<any[]>('GET', `/square/posts/${clean}/comments`)).body).toHaveLength(2);
    const notes = (await call<any[]>('GET', '/square/notifications', ann.token)).body.map((n) => n.kind);
    expect(notes).toEqual(expect.arrayContaining(['LIKE', 'COMMENT']));
    expect((await call<any[]>('GET', '/square/notifications', cat.token)).body.map((n) => n.kind)).toContain('REPLY');
    expect((await call<SquareMeDTO>('GET', '/square/me', ann.token)).body.unread).toBeGreaterThan(0);
    await call('POST', '/square/notifications/read', ann.token);
    expect((await call<SquareMeDTO>('GET', '/square/me', ann.token)).body.unread).toBe(0);

    expect((await call('POST', '/square/users/ann_trader/follow', dan.token)).body.followed).toBe(true);
    const f = (await call<SquareFeedDTO>('GET', '/square/feed?tab=following', dan.token)).body.posts;
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((x) => x.author.handle === 'ann_trader')).toBe(true);
    expect((await call('GET', '/square/users/ann_trader', dan.token)).body).toMatchObject({ followers: 1, followed: true, likesReceived: 1 });
    expect((await call('GET', '/square/trends')).body[0]).toMatchObject({ asset: 'BTC', bullish: 1 });
  });

  it('đủ 3 người báo cáo (tài khoản đủ tuổi) → tự ẩn chờ duyệt', async () => {
    const r = await post(gus, 'Coin này sắp x100, gom ngay kẻo lỡ');
    expect(r.body.status).toBe('PUBLISHED');
    const id = String(r.body.id);
    expect((await call('POST', '/square/reports', gus.token, { targetType: 'POST', targetId: id, reason: 'SPAM' })).body.error.code).toBe('SELF');
    for (const u of [cat, dan]) expect((await call('POST', '/square/reports', u.token, { targetType: 'POST', targetId: id, reason: 'MANIPULATION' })).status).toBe(201);
    // Tài khoản mới tạo không được tính
    expect((await call('POST', '/square/reports', newbie.token, { targetType: 'POST', targetId: id, reason: 'MANIPULATION' })).status).toBe(201);
    expect((await call('GET', `/square/posts/${id}`, ann.token)).status).toBe(200);
    expect((await call('POST', '/square/reports', eve.token, { targetType: 'POST', targetId: id, reason: 'SCAM', note: 'hô hào' })).status).toBe(201);
    expect((await call('GET', `/square/posts/${id}`, ann.token)).status).toBe(404);
    const q = (await call<any[]>('GET', '/admin/square/queue?view=pending', mod.token)).body.find((x) => x.id === id);
    expect(q.reports).toMatchObject({ count: 4, reasons: { MANIPULATION: 3, SCAM: 1 } });
  });
});

describe('gỡ bài, thang phạt, khiếu nại', () => {
  const removeBody = { rule: 'MANIPULATION', note: 'Hô hào mua', strike: true };
  let first: number;

  it('lần 1 cảnh cáo, lần 2 cấm 24 giờ; bị cấm thì không đăng / bình luận được nhưng vẫn thích được', async () => {
    first = (await post(fay, 'Bài số một')).body.id;
    const second = (await post(fay, 'Bài số hai')).body.id;
    const r1 = await call('POST', `/admin/square/posts/${first}/remove`, mod.token, removeBody);
    expect(r1.body.strike).toMatchObject({ count: 1, hours: 0 });
    expect((await call<SquareMeDTO>('GET', '/square/me', fay.token)).body).toMatchObject({ canPost: true, activeStrikes: 1 });
    const r2 = await call('POST', `/admin/square/posts/${second}/remove`, mod.token, removeBody);
    expect(r2.body.strike).toMatchObject({ count: 2, hours: 24 });
    const me = (await call<SquareMeDTO>('GET', '/square/me', fay.token)).body;
    expect(me.canPost).toBe(false);
    expect(me.banUntil).not.toBeNull();
    expect((await post(fay, 'Bài số ba')).body.error.code).toBe('SQUARE_BANNED');
    const someone = (await call<SquareFeedDTO>('GET', '/square/feed?tab=latest')).body.posts[0]!.id;
    expect((await call('POST', `/square/posts/${someone}/like`, fay.token)).status).toBe(200);
    expect(emails.filter((e) => e.userId === fay.id)).toHaveLength(2);
    // Tác giả thấy bài bị gỡ trên trang cá nhân của mình, người khác thì không
    const mine = (await call<SquareFeedDTO>('GET', '/square/feed?tab=latest&author=fay_eth', fay.token)).body.posts;
    expect(mine.find((p) => p.id === first)?.removed).toMatchObject({ rule: 'MANIPULATION', canAppeal: true });
    expect((await call<SquareFeedDTO>('GET', '/square/feed?tab=latest&author=fay_eth', ann.token)).body.posts).toHaveLength(0);
  });

  it('khiếu nại: người đã gỡ không tự xử lý; người khác chấp nhận → hiện lại, gỡ vi phạm, hết bị cấm', async () => {
    expect((await call('POST', `/square/posts/${first}/appeal`, fay.token, { note: 'Mình chỉ chia sẻ quan điểm cá nhân' })).status).toBe(200);
    expect((await call('POST', `/square/posts/${first}/appeal`, fay.token, { note: 'Khiếu nại lần hai nữa nhé' })).body.error.code).toBe('APPEAL');
    const q = (await call<any[]>('GET', '/admin/square/queue?view=appeals', mod.token)).body;
    expect(q.find((x) => x.id === String(first))?.appeal).toMatchObject({ removedBy: 'mod@sq.test', rule: 'MANIPULATION' });
    expect((await call('POST', `/admin/square/posts/${first}/appeal`, mod.token, { accept: true, note: 'Xem lại' })).body.error.code).toBe('SELF');
    expect((await call('POST', `/admin/square/posts/${first}/appeal`, mod2.token, { accept: true, note: 'Không vi phạm' })).status).toBe(200);
    expect((await call('GET', `/square/posts/${first}`, ann.token)).status).toBe(200);
    const me = (await call<SquareMeDTO>('GET', '/square/me', fay.token)).body;
    expect(me).toMatchObject({ activeStrikes: 1, canPost: true, banUntil: null });
  });

  it('cấm vĩnh viễn và gỡ cấm vĩnh viễn cần người thứ hai; cấm tay quá 30 ngày bị từ chối', async () => {
    expect((await call('POST', `/admin/square/users/${gus.id}/ban`, mod.token, { days: 60, reason: 'Spam liên tục' })).body.error.code).toBe('BAN_TOO_LONG');
    const r = await call('POST', `/admin/square/users/${gus.id}/ban`, mod.token, { permanent: true, reason: 'Lừa đảo nhiều lần' });
    expect(r.status).toBe(202);
    expect((await call('POST', `/admin/approvals/${r.body.request.id}/approve`, mod.token, {})).status).toBe(400);
    expect((await call('POST', `/admin/approvals/${r.body.request.id}/approve`, mod2.token, {})).status).toBe(200);
    expect((await post(gus, 'xin chào')).body.error.code).toBe('SQUARE_BANNED');
    expect((await call('GET', `/admin/square/users/${gus.id}`, mod.token)).body).toMatchObject({ banPermanent: true, handle: 'gus_alt' });
    // Cấm tay không được rút ngắn cấm vĩnh viễn (lách duyệt 2 người)
    expect((await call('POST', `/admin/square/users/${gus.id}/ban`, mod.token, { days: 1, reason: 'Rút ngắn' })).body.error?.code).toBe('ALREADY');
    expect((await call('GET', `/admin/square/users/${gus.id}`, mod.token)).body.banPermanent).toBe(true);
    const u = await call('POST', `/admin/square/users/${gus.id}/unban`, mod2.token, { note: 'Đã cam kết' });
    expect(u.status).toBe(202);
    expect((await call('POST', `/admin/approvals/${u.body.request.id}/approve`, mod.token, {})).status).toBe(200);
    expect((await call<SquareMeDTO>('GET', '/square/me', gus.token)).body.canPost).toBe(true);
    // Cấm ngắn: gỡ trực tiếp
    expect((await call('POST', `/admin/square/users/${gus.id}/ban`, mod.token, { days: 2, reason: 'Spam' })).status).toBe(200);
    expect((await call('POST', `/admin/square/users/${gus.id}/unban`, mod.token, { note: 'Nhầm' })).status).toBe(200);
    // Cấm tay ngắn hơn không rút ngắn được lệnh cấm đang dài hơn
    await call('POST', `/admin/square/users/${gus.id}/ban`, mod.token, { days: 20, reason: 'Spam' });
    await call('POST', `/admin/square/users/${gus.id}/ban`, mod.token, { days: 1, reason: 'Spam' });
    const until = (await call('GET', `/admin/square/users/${gus.id}`, mod.token)).body.banUntil;
    expect(new Date(until).getTime() - Date.now()).toBeGreaterThan(19 * 86_400_000);
  });

  it('đặt lại tên phản cảm: đổi handle + 1 vi phạm; báo cáo hồ sơ đóng lại', async () => {
    await call('POST', '/square/reports', ann.token, { targetType: 'PROFILE', targetId: '@dan_hodl', reason: 'IMPERSONATION' });
    const q = (await call<any[]>('GET', '/admin/square/queue?view=reports', mod.token)).body;
    expect(q.find((x) => x.type === 'PROFILE')).toMatchObject({ id: dan.id, reports: { count: 1 } });
    const r = await call('POST', `/admin/square/users/${dan.id}/reset-handle`, mod.token, { rule: 'IMPERSONATION', note: 'Giả danh' });
    expect(r.body.handle).toMatch(/^user_[0-9a-f]{6}$/);
    expect((await call<SquareMeDTO>('GET', '/square/me', dan.token)).body).toMatchObject({ activeStrikes: 1, profile: { handle: r.body.handle } });
    expect((await call<any[]>('GET', '/admin/square/queue?view=reports', mod.token)).body.find((x) => x.type === 'PROFILE')).toBeUndefined();
  });
});

describe('quy tắc lọc, chống thử liên tục, dữ liệu cá nhân', () => {
  it('kiểm duyệt viên thêm từ chặn / chỉnh giới hạn; thử câu', async () => {
    expect((await call('PUT', '/admin/square/rules', mod.token, { extraBlockWords: ['coin rác'], postsPerHour: 2 })).status).toBe(200);
    expect((await call('POST', '/admin/square/rules/test', mod.token, { text: 'đây là coin rác' })).body.verdict).toBe('BLOCK');
    expect((await post(eve, 'đây là coin rác')).body.error.rules).toEqual(['CUSTOM']);
    expect((await call('GET', '/square/config')).body).not.toHaveProperty('extraBlockWords');
    expect((await post(eve, 'bài một')).status).toBe(201);
    expect((await post(eve, 'bài hai')).status).toBe(201);
    expect((await post(eve, 'bài ba')).status).toBe(429);
    expect((await call('DELETE', '/admin/square/rules', mod.token)).status).toBe(200);
  });

  it('bị bộ lọc chặn 5 lần / giờ → tạm khoá đăng', async () => {
    for (let i = 0; i < 5; i++) expect((await post(cat, `đm lần ${i}`)).status).toBe(400);
    expect((await post(cat, 'bài bình thường')).body.error.code).toBe('SQUARE_COOLDOWN');
  });

  it('xuất dữ liệu có phần Cộng đồng; xoá tài khoản (ẩn danh) xoá hồ sơ và nội dung', async () => {
    const data = (await new PrivacyService(db).exportData(ann.id)) as { community: { profile: { handle: string }; posts: unknown[] } };
    expect(data.community.profile.handle).toBe('ann_trader');
    expect(data.community.posts.length).toBeGreaterThan(0);
    expect((await call('DELETE', `/admin/users/${ann.id}`, dpo.token, { confirmEmail: ann.email })).status).toBe(200);
    expect((await call('GET', '/square/users/ann_trader')).status).toBe(404);
    const left = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM square_posts WHERE user_id = $1 AND (status <> 'DELETED' OR body <> '')`, [ann.id]);
    expect(left!.n).toBe(0);
  });
});
