import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { ADJUST_DAILY_TOTAL_MULTIPLIER, Big, EMERGENCY_HALT_MIN, ROLE_LABEL, ROLE_PERMISSIONS, RULES, USER_ROLES, registerSchema, type UserRole } from '@vss/shared';
import { config } from '../config';
import { markEmailVerified } from '../lib/auth';
import { listAuthEvents } from '../lib/authEvents';
import { listOrderEvents } from '../trading/orderEvents';
import { accountLockedEmail, emergencyHaltEmail, roleChangedEmail } from '../lib/emails';
import { AppError, ah, badRequest, notFound } from '../lib/errors';
import { log } from '../lib/logger';
import { utcDay } from '../portfolio/nav';
import { sendLater } from '../routes/auth';
import { createUserAccount } from '../seed/seed';
import { accountView, navOf } from '../trading/account';
import { toLedgerDTO, toOrderDTO, type BalanceRow, type LedgerRow, type OrderRow } from '../trading/dto';
import { exportBackup, serializeBackup } from './backup';
import { Approvals, mountApprovals } from './approvals';
import { expireEmergencyIfDue } from './emergency';
import { mountFraud } from './fraud';
import { mountReconcile } from './reconcile';
import { mountP2PAdmin } from './p2p';
import { mountCompliance } from './compliance';
import { mountPrivacyAdmin } from './privacy';
import { mountVipAdmin } from './vip';
import { mountSquareAdmin } from './square';
import { notifyStaff } from './notify';
import { assertCan, assertRoutesGuarded, assetParam, audit, need, reasonSchema, uuid, type AdminCtx, type AdminDeps, type AdminRequest } from './common';
import { anonymizeUser, applyBalanceAdjust, auditView, createAdjustRequest, lockUser, staffGuard, toAdjustRequestDTO, type AdjustRequestRow } from './staff';
import { metrics } from '../ops/metrics';
import { recentLogs } from './logBuffer';
import { mountMarketAdmin } from './marketAdmin';
import { mountPriceControl } from './priceControl';

export type { AdminDeps } from './common';

/** Các bảng dữ liệu — dùng cho thống kê dung lượng */
export const TABLES: { name: string; group: string; desc: string }[] = [
  { name: 'users', group: 'Người dùng', desc: 'Tài khoản đăng nhập, vai trò, trạng thái khoá, 2FA, tuỳ chọn' },
  { name: 'accounts', group: 'Người dùng', desc: 'Vốn ban đầu, vốn đã góp, tuỳ chọn trả phí bằng BNB' },
  { name: 'balances', group: 'Người dùng', desc: 'Số dư từng tài sản (khả dụng, đang khoá, giá vốn)' },
  { name: 'watchlist_lists', group: 'Người dùng', desc: 'Các danh sách theo dõi (tên, thứ tự)' },
  { name: 'watchlists', group: 'Người dùng', desc: 'Cặp trong từng danh sách theo dõi' },
  { name: 'price_alerts', group: 'Người dùng', desc: 'Cảnh báo giá, % thay đổi 24h' },
  { name: 'recovery_codes', group: 'Người dùng', desc: 'Mã khôi phục 2FA (đã băm)' },
  { name: 'password_reset_tokens', group: 'Người dùng', desc: 'Link đặt lại mật khẩu (đã băm, 30 phút)' },
  { name: 'email_verification_tokens', group: 'Người dùng', desc: 'Link xác thực email (đã băm, 24 giờ)' },
  { name: 'orders', group: 'Giao dịch', desc: 'Toàn bộ lệnh đã đặt' },
  { name: 'order_lists', group: 'Giao dịch', desc: 'Lệnh OCO' },
  { name: 'fills', group: 'Giao dịch', desc: 'Mỗi lần khớp lệnh (giá, khối lượng, phí)' },
  { name: 'ledger', group: 'Giao dịch', desc: 'Sổ cái biến động số dư theo tài sản' },
  { name: 'nav_daily', group: 'Giao dịch', desc: 'Tổng tài sản (USDT) cuối ngày UTC (biểu đồ hiệu quả, bảng xếp hạng)' },
  { name: 'symbols', group: 'Thị trường', desc: 'Cặp giao dịch và bộ lọc (cả cặp đã gỡ)' },
  { name: 'market_meta', group: 'Vận hành', desc: 'Cấu hình vận hành (ngừng giao dịch, thông báo, biểu phí)' },
  { name: 'admin_audit_log', group: 'Vận hành', desc: 'Nhật ký thao tác quản trị (chỉ ghi thêm)' },
  { name: 'approval_requests', group: 'Vận hành', desc: 'Đề xuất thao tác lớn chờ người thứ hai duyệt' },
  { name: 'reconciliation_runs', group: 'Vận hành', desc: 'Kết quả đối soát số dư ↔ sổ cái ↔ khớp lệnh hằng ngày' },
  { name: 'system_alerts', group: 'Vận hành', desc: 'Lịch sử cảnh báo vận hành (giám sát tự động)' },
];

function dirSize(dir: string): number {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else if (entry.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

/** Chuỗi kết nối Postgres đã che mật khẩu */
function safeDbUrl(): string | null {
  const raw = process.env.DATABASE_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.username ? `${u.username}:***@` : ''}${u.host}${u.pathname}`;
  } catch {
    return 'postgres://***';
  }
}

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  status: 'ACTIVE' | 'LOCKED' | 'DELETED';
  locked_reason: string | null;
  created_at: Date;
  last_seen_at: Date | null;
  email_verified_at: Date | null;
  totp_enabled_at: Date | null;
}

const ADMIN_USER_COLS = 'id, email, full_name, role, status, locked_reason, created_at, last_seen_at, email_verified_at, totp_enabled_at';

const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());

export function adminRoutes(deps: AdminDeps) {
  const { db, io, market, engine, store, mailer } = deps;
  const r = Router();

  /**
   * Nhân viên có quyền vào khu quản trị (bắt buộc 2FA nếu REQUIRE_STAFF_2FA); từng route kiểm thêm quyền chi tiết
   * theo vai trò bằng need(). Nhân viên CSKH dùng /api/support-desk.
   */
  r.use(...staffGuard(db, 'admin.view'));

  const broadcast = () => io.emit('system', store.status());
  // Thao tác lớn: người thứ hai có thẩm quyền duyệt rồi mới thực hiện
  const approvals = new Approvals(db, mailer);
  mountApprovals(r, approvals);

  // Tham số giao dịch, danh mục mã, khôi phục dữ liệu
  mountMarketAdmin(r, deps, broadcast, approvals);
  mountPriceControl(r, deps, approvals);
  mountFraud(r, deps);
  mountReconcile(r, deps);
  mountP2PAdmin(r, deps);
  mountCompliance(r, deps, approvals);
  mountPrivacyAdmin(r, deps);
  mountVipAdmin(r, deps);
  mountSquareAdmin(r, deps, approvals);

  const onlineCount = async () => {
    const sockets = await io.fetchSockets();
    const users = new Set(sockets.map((s) => (s.data as { user?: { id: string } }).user?.id).filter(Boolean));
    return { connections: sockets.length, users: users.size, userIds: users as Set<string | undefined> };
  };

  /** Tổng tài sản (USDT) mọi tài khoản theo giá hiện tại; mốc lãi/lỗ = vốn đã góp */
  const navs = async () => {
    const accts = await db.many<{ user_id: string; contributed_usdt: string }>('SELECT user_id, contributed_usdt FROM accounts');
    const bals = await db.many<BalanceRow>('SELECT * FROM balances');
    const by = new Map<string, BalanceRow[]>();
    for (const b of bals) {
      const list = by.get(b.user_id);
      if (list) list.push(b);
      else by.set(b.user_id, [b]);
    }
    const out = new Map<string, { nav: number; initial: number; usdt: number }>();
    for (const a of accts) {
      const list = by.get(a.user_id) ?? [];
      const usdt = list.find((b) => b.asset === RULES.quoteAsset);
      out.set(a.user_id, {
        nav: navOf(list, market).toNumber(),
        initial: Number(a.contributed_usdt),
        usdt: usdt ? Number(usdt.free) + Number(usdt.locked) : 0,
      });
    }
    return out;
  };

  const dbSize = async (): Promise<number> => {
    if (db.kind === 'postgres') {
      const row = await db.one<{ n: number }>('SELECT pg_database_size(current_database())::bigint AS n');
      return Number(row?.n ?? 0);
    }
    return dirSize(config.dataDir);
  };

  const feed = () => market.feed();

  /* ------------------------------ tổng quan ------------------------------ */

  r.get('/me', need('admin.view'), (req, res) => {
    const { admin } = req as AdminRequest;
    res.json({ ok: true, admin, permissions: admin.role ? ROLE_PERMISSIONS[admin.role] : [] });
  });

  r.get(
    '/overview',
    need('admin.view'),
    ah(async (_req, res) => {
      const td = utcDay();
      const users = await db.one<{ total: number; new7d: number; locked: number; admins: number; active15m: number }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new7d,
                count(*) FILTER (WHERE status = 'LOCKED')::int AS locked,
                count(*) FILTER (WHERE role = 'ADMIN')::int AS admins,
                count(*) FILTER (WHERE last_seen_at > now() - interval '15 minutes')::int AS active15m
         FROM users`,
      );
      const byStatus = await db.many<{ status: string; n: number }>(
        `SELECT status, count(*)::int AS n FROM orders WHERE (created_at AT TIME ZONE 'UTC')::date = $1::date GROUP BY status`,
        [td],
      );
      const trades = await db.one<{ n: number; value: number; fee: number }>(
        `SELECT count(*)::int AS n, COALESCE(sum(quote_qty), 0)::float8 AS value, COALESCE(sum(commission_usdt), 0)::float8 AS fee
         FROM fills WHERE (executed_at AT TIME ZONE 'UTC')::date = $1::date`,
        [td],
      );
      const nav = await navs();
      const people = await db.many<{ id: string; email: string; full_name: string }>(`SELECT id, email, full_name FROM users WHERE role = 'USER'`);
      const ranking = people
        .map((p) => {
          const n = nav.get(p.id);
          const pnl = n ? n.nav - n.initial : 0;
          return { id: p.id, email: p.email, fullName: p.full_name, nav: n?.nav ?? 0, pnl, pnlPct: n && n.initial ? (pnl / n.initial) * 100 : 0 };
        })
        .sort((a, b) => b.pnlPct - a.pnlPct);
      let totalNav = 0;
      for (const v of nav.values()) totalNav += v.nav;
      const online = await onlineCount();
      const recent = await db.many(`SELECT id, admin_email, action, target_type, target_id, detail, created_at FROM admin_audit_log ORDER BY id DESC LIMIT 8`);
      const mem = process.memoryUsage();
      res.json({
        tradeDate: td,
        users: { ...users, online: online.users, connections: online.connections },
        orders: Object.fromEntries(byStatus.map((x) => [x.status, x.n])),
        trades: trades ?? { n: 0, value: 0, fee: 0 },
        totalNav,
        topInvestors: ranking.slice(0, 10),
        bottomInvestors: ranking.slice(-5).reverse(),
        health: {
          source: market.opts.feed,
          feed: feed(),
          symbols: market.symbols().length,
          uptimeSec: Math.round(process.uptime()),
          rssBytes: mem.rss,
          heapBytes: mem.heapUsed,
          node: process.version,
          dbKind: db.kind,
          dbBytes: await dbSize(),
          openOrders: engine.openOrderCount(),
        },
        status: store.status(),
        recentAudit: recent,
      });
    }),
  );

  /* ------------------------------ người dùng ------------------------------ */

  r.get(
    '/users',
    need('users.view'),
    ah(async (req, res) => {
      const q = z
        .object({ q: z.string().trim().max(100).optional(), status: z.enum(['ACTIVE', 'LOCKED']).optional(), role: z.enum(['USER', 'ADMIN']).optional() })
        .parse(req.query);
      const params: unknown[] = [];
      const where: string[] = [];
      if (q.q) {
        params.push(`%${q.q}%`);
        where.push(`(u.email ILIKE $${params.length} OR u.full_name ILIKE $${params.length})`);
      }
      if (q.status) {
        params.push(q.status);
        where.push(`u.status = $${params.length}`);
      }
      if (q.role) {
        params.push(q.role);
        where.push(`u.role = $${params.length}`);
      }
      const rows = await db.many<UserRow & { orders_count: number; trades_count: number }>(
        `SELECT u.id, u.email, u.full_name, u.role, u.status, u.locked_reason, u.created_at, u.last_seen_at,
                u.email_verified_at, u.totp_enabled_at,
                (SELECT count(*)::int FROM orders o WHERE o.user_id = u.id) AS orders_count,
                (SELECT count(*)::int FROM fills t WHERE t.user_id = u.id) AS trades_count
         FROM users u JOIN accounts a ON a.user_id = u.id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY u.created_at DESC LIMIT 500`,
        params,
      );
      const nav = await navs();
      const online = await onlineCount();
      res.json(
        rows.map((u) => {
          const n = nav.get(u.id);
          const pnl = n ? n.nav - n.initial : 0;
          return {
            id: u.id,
            email: u.email,
            fullName: u.full_name,
            role: u.role,
            status: u.status,
            lockedReason: u.locked_reason,
            createdAt: iso(u.created_at),
            lastSeenAt: iso(u.last_seen_at),
            emailVerified: u.email_verified_at != null,
            twoFactorEnabled: u.totp_enabled_at != null,
            online: online.userIds.has(u.id),
            usdt: n?.usdt ?? 0,
            nav: n?.nav ?? 0,
            pnl,
            pnlPct: n?.initial ? (pnl / n.initial) * 100 : 0,
            ordersCount: u.orders_count,
            tradesCount: u.trades_count,
          };
        }),
      );
    }),
  );

  r.get(
    '/users/:id',
    need('users.view'),
    ah(async (req, res) => {
      const id = uuid.parse(req.params.id);
      const u = await db.one<UserRow>(`SELECT ${ADMIN_USER_COLS} FROM users WHERE id = $1`, [id]);
      if (!u) throw notFound('Không tìm thấy người dùng');
      await auditView(db, (req as AdminRequest).admin, id, u.email, 'admin');
      const account = await accountView(db, market, id);
      const authEvents = await listAuthEvents(db, id, 30);
      const orders = await db.many<OrderRow>('SELECT * FROM orders WHERE user_id = $1 ORDER BY id DESC LIMIT 30', [id]);
      const ledger = await db.many<LedgerRow>('SELECT * FROM ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 30', [id]);
      const auditRows = await db.many(
        `SELECT id, admin_email, action, detail, created_at FROM admin_audit_log WHERE target_type = 'user' AND target_id = $1 ORDER BY id DESC LIMIT 20`,
        [id],
      );
      const stats = await db.one<{ trades: number; realized: number; fees: number; watch: number }>(
        `SELECT (SELECT count(*)::int FROM fills WHERE user_id = $1) AS trades,
                (SELECT COALESCE(sum(realized_pnl), 0)::float8 FROM fills WHERE user_id = $1) AS realized,
                (SELECT COALESCE(sum(commission_usdt), 0)::float8 FROM fills WHERE user_id = $1) AS fees,
                (SELECT count(*)::int FROM watchlists WHERE user_id = $1) AS watch`,
        [id],
      );
      const online = await onlineCount();
      res.json({
        user: {
          id: u.id,
          email: u.email,
          fullName: u.full_name,
          role: u.role,
          status: u.status,
          lockedReason: u.locked_reason,
          createdAt: iso(u.created_at),
          lastSeenAt: iso(u.last_seen_at),
          emailVerified: u.email_verified_at != null,
          twoFactorEnabled: u.totp_enabled_at != null,
          online: online.userIds.has(u.id),
        },
        account,
        stats,
        orders: orders.map(toOrderDTO),
        ledger: ledger.map(toLedgerDTO),
        audit: auditRows,
        authEvents,
      });
    }),
  );

  /** Quản trị viên tạo tài khoản nhà đầu tư (vd. cho một lớp học / giải đấu) — không qua giới hạn đăng ký theo IP */
  r.post(
    '/users',
    need('users.manage'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const input = registerSchema.parse(req.body);
      const exists = await db.one('SELECT 1 FROM users WHERE email = $1', [input.email]);
      if (exists) throw new AppError(409, 'EMAIL_TAKEN', 'Email đã được sử dụng');
      const hash = await bcrypt.hash(input.password, 10);
      const user = await db.tx(async (tx) => {
        const u = await createUserAccount(tx, input.email, hash, input.fullName);
        // Quản trị viên tạo hộ → coi như đã xác thực email
        await tx.many('UPDATE users SET email_verified_at = now() WHERE id = $1', [u.id]);
        await audit(tx, admin, 'USER_CREATE', 'user', u.id, { email: u.email });
        return u;
      });
      res.status(201).json({ id: user.id, email: user.email, fullName: user.full_name });
    }),
  );

  const loadTarget = async (id: string) => {
    const u = await db.one<UserRow>(`SELECT ${ADMIN_USER_COLS} FROM users WHERE id = $1`, [id]);
    if (!u) throw notFound('Không tìm thấy người dùng');
    if (u.status === 'DELETED') throw badRequest('DELETED', 'Tài khoản đã bị xoá (ẩn danh) — không thao tác được');
    return u;
  };

  r.post(
    '/users/:id/verify-email',
    need('users.manage'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = uuid.parse(req.params.id);
      const u = await loadTarget(id);
      if (u.email_verified_at) throw badRequest('ALREADY', 'Email đã được xác thực');
      await db.tx(async (tx) => {
        await tx.many('UPDATE users SET email_verified_at = now() WHERE id = $1', [id]);
        await audit(tx, admin, 'USER_VERIFY_EMAIL', 'user', id, { email: u.email });
      });
      markEmailVerified(id);
      res.json({ ok: true });
    }),
  );

  /** Người dùng mất điện thoại và hết mã khôi phục: quản trị viên tắt 2FA sau khi xác minh danh tính */
  r.post(
    '/users/:id/lock',
    need('users.lock'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = uuid.parse(req.params.id);
      const { reason } = z.object({ reason: reasonSchema }).parse(req.body);
      const { cancelledOrders } = await lockUser(deps, admin, id, reason);
      res.json({ ok: true, cancelledOrders });
    }),
  );

  r.post(
    '/users/:id/unlock',
    need('users.lock'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = uuid.parse(req.params.id);
      const u = await loadTarget(id);
      if (u.status !== 'LOCKED') throw badRequest('NOT_LOCKED', 'Tài khoản không bị khoá');
      await db.many(`UPDATE users SET status = 'ACTIVE', locked_reason = NULL WHERE id = $1`, [id]);
      store.locked.delete(id);
      await audit(db, admin, 'USER_UNLOCK', 'user', id, { email: u.email });
      sendLater(mailer, u.email, accountLockedEmail(u.full_name, false), { userId: id });
      res.json({ ok: true });
    }),
  );

  const setRole = async (admin: AdminCtx, u: UserRow, role: UserRole, extra: Record<string, unknown>) => {
    await db.many('UPDATE users SET role = $2 WHERE id = $1', [u.id, role]);
    await audit(db, admin, 'ROLE_SET', 'user', u.id, { email: u.email, from: u.role, to: role, ...extra });
    // Báo chính người được đổi và mọi Quản trị hệ thống khác — cấp quyền lạ bị phát hiện ngay
    const info = {
      email: u.email,
      from: ROLE_LABEL[u.role],
      to: ROLE_LABEL[role],
      by: admin.email,
      requestedBy: typeof extra.requestedBy === 'string' ? extra.requestedBy : null,
      bootstrap: extra.bootstrap === true,
    };
    sendLater(mailer, u.email, roleChangedEmail(u.full_name, { ...info, self: true }), { userId: u.id });
    await notifyStaff(db, mailer, 'staff.manage', [admin.id, u.id], (name) => roleChangedEmail(name, { ...info, self: false }), { target: u.id }).catch(
      () => undefined,
    );
    return { email: u.email, from: u.role, to: role };
  };

  approvals.register('ROLE_SET', async (admin, req) => {
    if (req.target === admin.id) throw badRequest('SELF', 'Không được duyệt thay đổi vai trò của chính mình');
    const u = await loadTarget(req.target!);
    const role = (req.payload as { role: UserRole }).role;
    if (u.role === role) throw badRequest('NO_CHANGE', 'Vai trò đã như đề xuất');
    if (u.status !== 'ACTIVE' && role !== 'USER') throw badRequest('LOCKED', 'Tài khoản đang bị khoá — không cấp quyền nhân viên');
    return setRole(admin, u, role, { approvalId: req.id, requestedBy: req.requestedByEmail, reason: req.reason });
  });

  /**
   * Phân quyền. Thu quyền nhân viên (không phải Quản trị hệ thống) về Nhà đầu tư: có hiệu lực ngay (chiều an toàn).
   * Mọi thay đổi khác — cấp / đổi vai trò nhân viên, thu quyền Quản trị hệ thống — cần Quản trị hệ thống KHÁC duyệt,
   * để 1 người không tự tạo tài khoản phụ rồi tự cấp quyền mà lách luật 2 người. Ngoại lệ: hệ thống mới chỉ có
   * đúng 1 Quản trị hệ thống (khởi tạo ban đầu) → áp dụng ngay, nhật ký ghi bootstrap.
   */
  r.post(
    '/users/:id/role',
    need('staff.manage'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = uuid.parse(req.params.id);
      const { role, reason } = z
        .object({ role: z.enum(USER_ROLES as [UserRole, ...UserRole[]]), reason: reasonSchema.optional() })
        .parse(req.body);
      if (id === admin.id) throw badRequest('SELF', 'Không thể tự thay đổi quyền của chính mình');
      const u = await loadTarget(id);
      if (u.role === role) throw badRequest('NO_CHANGE', 'Vai trò không đổi');
      if (u.status !== 'ACTIVE' && role !== 'USER') throw badRequest('LOCKED', 'Không cấp quyền nhân viên cho tài khoản đang bị khoá');
      if (role === 'USER' && u.role !== 'ADMIN') {
        res.json({ ok: true, ...(await setRole(admin, u, role, { reason: reason ?? null })) });
        return;
      }
      const admins = (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'`))!.n;
      if (admins <= 1) {
        log.warn('[admin] cấp vai trò khi hệ thống chỉ có 1 Quản trị hệ thống (khởi tạo)', { by: admin.email, target: u.email, role });
        res.json({ ok: true, bootstrap: true, ...(await setRole(admin, u, role, { reason: reason ?? null, bootstrap: true })) });
        return;
      }
      const request = await approvals.create(admin, {
        kind: 'ROLE_SET',
        target: id,
        payload: { role, from: u.role, email: u.email },
        summary: `${u.email}: ${ROLE_LABEL[u.role]} → ${ROLE_LABEL[role]}`,
        reason: reason ?? `Đổi vai trò thành ${ROLE_LABEL[role]}`,
      });
      res.status(202).json({ ok: true, pending: true, request });
    }),
  );

  approvals.register('ACCOUNT_RESET', async (admin, req) => {
    if (req.target === admin.id) throw badRequest('SELF', 'Không được duyệt đặt lại tài khoản của chính mình');
    const u = await loadTarget(req.target!);
    await engine.resetAccount(u.id);
    await audit(db, admin, 'ACCOUNT_RESET', 'user', u.id, { email: u.email, reason: req.reason, approvalId: req.id, requestedBy: req.requestedByEmail });
    io.to(`user:${u.id}`).emit('account');
    return { email: u.email };
  });

  /** Đặt lại tài khoản khách (xoá sạch lệnh, khớp, coin, sổ cái; ví về vốn ban đầu): đề xuất, người Tài chính khác duyệt */
  r.post(
    '/users/:id/reset',
    need('finance.adjust'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = uuid.parse(req.params.id);
      const { reason } = z.object({ reason: reasonSchema }).parse(req.body);
      if (id === admin.id) throw badRequest('SELF', 'Không thể tự đặt lại tài khoản của mình');
      const u = await loadTarget(id);
      const request = await approvals.create(admin, {
        kind: 'ACCOUNT_RESET',
        target: id,
        payload: { email: u.email },
        summary: `Đặt lại tài khoản ${u.email}: xoá toàn bộ lệnh, khớp lệnh, số dư coin, sổ cái; ví về vốn ảo ban đầu (không hoàn tác được)`,
        reason,
      });
      res.status(202).json({ ok: true, pending: true, request });
    }),
  );

  /**
   * Cộng / trừ số dư 1 tài sản (vd. thưởng giải đấu). Phần quy đổi USDT được tính vào vốn đã góp
   * để lợi nhuận và bảng xếp hạng không bị thổi phồng. Không trừ vào phần đang khoá cho lệnh.
   */
  r.post(
    '/users/:id/adjust-balance',
    need('finance.adjust'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = uuid.parse(req.params.id);
      const { asset, amount, reason } = z
        .object({
          asset: assetParam,
          amount: z
            .string()
            .trim()
            .regex(/^-?\d{1,15}(\.\d{1,18})?$/, 'Số lượng không hợp lệ')
            .refine((v) => Number(v) !== 0, 'Số lượng phải khác 0'),
          reason: reasonSchema,
        })
        .parse(req.body);
      if (id === admin.id) throw badRequest('SELF', 'Không thể tự điều chỉnh số dư của chính mình');
      const u = await loadTarget(id);
      const price = market.priceUsdt(asset);
      if (!price) throw badRequest('ASSET', `Không định giá được ${asset} (chưa có cặp ${asset}USDT trên sàn)`);
      const usdtValue = new Big(amount).times(price);
      if (usdtValue.abs().gt(1_000_000)) throw badRequest('LIMIT', 'Mỗi lần điều chỉnh tối đa tương đương 1.000.000 USDT');
      // Cộng dồn các lần điều chỉnh TRỰC TIẾP (không qua duyệt) của người này trong 24 giờ — chống chia nhỏ để lách ngưỡng
      const used = await db.one<{ per_user: string; total: string }>(
        `SELECT COALESCE(sum(abs((detail->>'usdtValue')::numeric)) FILTER (WHERE target_id = $2), 0)::text AS per_user,
                COALESCE(sum(abs((detail->>'usdtValue')::numeric)), 0)::text AS total
         FROM admin_audit_log
         WHERE action = 'BALANCE_ADJUST' AND admin_id = $1 AND detail->>'requestId' IS NULL AND created_at > now() - interval '24 hours'`,
        [admin.id, id],
      );
      const limit = config.adjustApprovalUsdt;
      const abs = usdtValue.abs();
      const cumulative = abs.plus(used!.per_user).gte(limit) || abs.plus(used!.total).gte(limit * ADJUST_DAILY_TOTAL_MULTIPLIER);
      // Từ ngưỡng trở lên (một lần hoặc cộng dồn 24 giờ): tạo yêu cầu, người Tài chính KHÁC phải duyệt (nguyên tắc 2 người)
      if (abs.gte(limit) || cumulative) {
        const request = await createAdjustRequest(db, admin, {
          userId: id,
          email: u.email,
          asset,
          amount,
          usdtValue: usdtValue.toFixed(),
          reason: abs.lt(limit) ? `${reason} (cộng dồn 24 giờ vượt ngưỡng duyệt)` : reason,
        }, mailer);
        res.status(202).json({ ok: true, pending: true, request, cumulative: abs.lt(limit) });
        return;
      }
      const after = await db.tx((tx) => applyBalanceAdjust(tx, admin, { userId: id, email: u.email, asset, amount, usdtValue: usdtValue.toFixed(), reason }));
      io.to(`user:${id}`).emit('account');
      res.json({ ok: true, balanceAfter: after });
    }),
  );

  /**
   * Xoá tài khoản khách: ẩn danh (privacy.manage — DPO, thường qua yêu cầu của chính khách ở mục Dữ liệu cá nhân);
   * xoá hẳn tài khoản thử (purge, chỉ ngoài production) do Quản trị hệ thống làm (users.manage).
   */
  r.delete(
    '/users/:id',
    need('admin.view'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = uuid.parse(req.params.id);
      const { confirmEmail, purge } = z
        .object({ confirmEmail: z.string().trim().toLowerCase(), purge: z.boolean().optional() })
        .parse(req.body ?? {});
      if (id === admin.id) throw badRequest('SELF', 'Không thể tự xoá tài khoản của mình');
      const u = await loadTarget(id);
      if (u.role !== 'USER') throw badRequest('IS_STAFF', 'Hãy thu quyền nhân viên trước khi xoá tài khoản này');
      if (confirmEmail !== u.email) throw badRequest('CONFIRM', 'Email xác nhận không khớp');
      if (purge && config.isProd) throw badRequest('PURGE', 'Môi trường thật không được xoá hẳn dữ liệu giao dịch — chỉ ẩn danh');
      assertCan(admin, purge ? 'users.manage' : 'privacy.manage');
      if (!purge) {
        await anonymizeUser(deps, admin, u);
        return void res.json({ ok: true, anonymized: true });
      }
      // Xoá hẳn: chỉ môi trường chạy thử (dọn tài khoản thử của khảo sát tải)
      await engine.cancelAllForUser(id, 'Tài khoản bị xoá', { actor: admin.email });
      io.in(`user:${id}`).disconnectSockets(true);
      await db.tx(async (tx) => {
        await tx.exec(`SET LOCAL vss.purge = 'on'`);
        await tx.many('DELETE FROM users WHERE id = $1', [id]);
        await audit(tx, admin, 'USER_PURGE', 'user', id, { email: u.email, fullName: u.full_name });
      });
      store.locked.delete(id);
      res.json({ ok: true, anonymized: false });
    }),
  );

  /* ------------------------------ lệnh ------------------------------ */

  r.get(
    '/orders',
    need('admin.view'),
    ah(async (req, res) => {
      const q = z
        .object({
          scope: z.enum(['open', 'today', 'all']).optional(),
          status: z.enum(['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED', 'REJECTED']).optional(),
          symbol: z.string().trim().toUpperCase().max(20).optional(),
          email: z.string().trim().max(100).optional(),
          side: z.enum(['BUY', 'SELL']).optional(),
        })
        .parse(req.query);
      const params: unknown[] = [];
      const where: string[] = [];
      if (q.scope === 'open') where.push(`o.status IN ('NEW','PARTIALLY_FILLED')`);
      if (q.scope === 'today') {
        params.push(utcDay());
        where.push(`(o.created_at AT TIME ZONE 'UTC')::date = $${params.length}::date`);
      }
      if (q.status) {
        params.push(q.status);
        where.push(`o.status = $${params.length}`);
      }
      if (q.symbol) {
        params.push(q.symbol);
        where.push(`o.symbol = $${params.length}`);
      }
      if (q.side) {
        params.push(q.side);
        where.push(`o.side = $${params.length}`);
      }
      if (q.email) {
        params.push(`%${q.email}%`);
        where.push(`u.email ILIKE $${params.length}`);
      }
      const rows = await db.many<OrderRow & { email: string }>(
        `SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.id DESC LIMIT 500`,
        params,
      );
      res.json(rows.map((o) => ({ ...toOrderDTO(o), userId: o.user_id, userEmail: o.email })));
    }),
  );

  r.post(
    '/orders/:id/cancel',
    need('orders.cancel'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('ID', 'Mã lệnh không hợp lệ');
      const { reason } = z.object({ reason: reasonSchema }).parse(req.body);
      const order = await engine.adminCancel(id, `Quản trị viên huỷ: ${reason}`, { actor: admin.email });
      await audit(db, admin, 'ORDER_CANCEL', 'order', String(id), { symbol: order.symbol, side: order.side, qty: order.origQty, reason });
      res.json(order);
    }),
  );

  r.get(
    '/orders/:id/events',
    need('admin.view'),
    ah(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('ID', 'Mã lệnh không hợp lệ');
      res.json(await listOrderEvents(db, id));
    }),
  );

  /* ------------------------------ duyệt điều chỉnh số dư ------------------------------ */

  r.get(
    '/adjust-requests',
    need('admin.view'),
    ah(async (req, res) => {
      const { status } = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'ALL']).default('PENDING') }).parse(req.query);
      const rows = await db.many<AdjustRequestRow>(
        `SELECT r.*, u.email, u.full_name FROM balance_adjust_requests r JOIN users u ON u.id = r.user_id
         ${status === 'ALL' ? '' : 'WHERE r.status = $1'} ORDER BY r.id DESC LIMIT 200`,
        status === 'ALL' ? [] : [status],
      );
      res.json(rows.map(toAdjustRequestDTO));
    }),
  );

  r.post(
    '/adjust-requests/:id/:decision',
    need('finance.approve'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('ID', 'Mã yêu cầu không hợp lệ');
      const decision = z.enum(['approve', 'reject']).parse(req.params.decision);
      const { note } = z.object({ note: z.string().trim().max(300).optional() }).parse(req.body ?? {});
      if (decision === 'reject' && (!note || note.length < 3)) throw badRequest('NOTE', 'Ghi lý do từ chối (tối thiểu 3 ký tự)');
      const out = await db.tx(async (tx) => {
        const r = await tx.one<AdjustRequestRow>(
          'SELECT r.*, u.email, u.full_name FROM balance_adjust_requests r JOIN users u ON u.id = r.user_id WHERE r.id = $1 FOR UPDATE OF r',
          [id],
        );
        if (!r) throw notFound('Không tìm thấy yêu cầu');
        if (r.status !== 'PENDING') throw badRequest('DECIDED', 'Yêu cầu đã được xử lý');
        // Nguyên tắc 2 người: người đề xuất không tự duyệt / từ chối yêu cầu của mình
        if (r.requested_by === admin.id) throw badRequest('SELF', 'Không được tự duyệt yêu cầu do chính mình tạo — cần một người khác thuộc bộ phận Tài chính');
        if (r.user_id === admin.id) throw badRequest('SELF', 'Không được duyệt điều chỉnh số dư của chính mình');
        let balanceAfter: string | null = null;
        if (decision === 'approve') {
          balanceAfter = await applyBalanceAdjust(tx, admin, {
            userId: r.user_id,
            email: r.email ?? '',
            asset: r.asset,
            amount: new Big(r.amount).toFixed(),
            usdtValue: new Big(r.usdt_value).toFixed(),
            reason: r.reason,
            requestId: id,
            requestedBy: r.requested_by_email,
            ticketId: r.ticket_id == null ? null : Number(r.ticket_id),
          });
        }
        const row = await tx.one<AdjustRequestRow>(
          `UPDATE balance_adjust_requests SET status = $2, decided_by = $3, decided_by_email = $4, decision_note = $5, decided_at = now()
           WHERE id = $1 RETURNING *`,
          [id, decision === 'approve' ? 'APPROVED' : 'REJECTED', admin.id, admin.email, note ?? null],
        );
        await audit(tx, admin, decision === 'approve' ? 'BALANCE_ADJUST_APPROVE' : 'BALANCE_ADJUST_REJECT', 'user', r.user_id, {
          requestId: id,
          email: r.email,
          asset: r.asset,
          amount: new Big(r.amount).toFixed(),
          note: note ?? null,
        });
        return { dto: toAdjustRequestDTO({ ...row!, email: r.email, full_name: r.full_name }), userId: r.user_id, ticketId: r.ticket_id, balanceAfter };
      });
      if (decision === 'approve') io.to(`user:${out.userId}`).emit('account');
      await deps.onAdjustDecided?.(out.dto);
      res.json({ ...out.dto, balanceAfter: out.balanceAfter });
    }),
  );

  /* ------------------------------ vận hành thị trường ------------------------------ */

  r.get(
    '/market',
    need('admin.view'),
    ah(async (_req, res) => {
      await expireEmergencyIfDue({ db, store, io });
      res.json({
        market: market.status(),
        source: market.opts.feed,
        status: store.status(),
        emergency: store.emergency,
        rules: RULES,
        symbols: market.rows().map((s) => ({ symbol: s.symbol, baseAsset: s.baseAsset, name: s.name, status: s.status })),
      });
    }),
  );

  r.post(
    '/market/halt',
    need('market.manage'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const body = z.object({ halted: z.boolean(), reason: z.string().trim().max(200).optional() }).parse(req.body);
      if (body.halted) {
        // Tạm ngừng toàn sàn: đề xuất, người thứ hai duyệt (sự cố 1 cặp → tạm ngừng riêng cặp đó, có hiệu lực ngay)
        if (!body.reason || body.reason.length < 3) throw badRequest('REASON', 'Nhập lý do tạm ngừng (tối thiểu 3 ký tự)');
        if (engine.control.haltAll) throw badRequest('ALREADY_HALTED', 'Sàn đang tạm ngừng nhận lệnh');
        const request = await approvals.create(admin, {
          kind: 'MARKET_HALT',
          target: null,
          payload: {},
          summary: 'Tạm ngừng nhận lệnh và khớp lệnh trên toàn sàn',
          reason: body.reason,
        });
        res.status(202).json({ ok: true, pending: true, request });
        return;
      }
      // Mở lại sàn: cũng phải có người thứ hai duyệt (mở lại khi sự cố chưa xử lý xong cũng nguy hiểm như dừng sai)
      if (!engine.control.haltAll) throw badRequest('NOT_HALTED', 'Sàn đang nhận lệnh bình thường');
      if (store.emergency) throw badRequest('EMERGENCY', 'Sàn đang dừng khẩn: hãy xác nhận hoặc huỷ dừng khẩn');
      if (!body.reason || body.reason.length < 3) throw badRequest('REASON', 'Nhập lý do mở lại (tối thiểu 3 ký tự)');
      const request = await approvals.create(admin, {
        kind: 'MARKET_RESUME',
        target: null,
        payload: { haltReason: engine.control.haltReason },
        summary: `Mở lại nhận lệnh và khớp lệnh toàn sàn (đang ngừng vì: ${engine.control.haltReason || 'không rõ'})`,
        reason: body.reason,
      });
      res.status(202).json({ ok: true, pending: true, request });
    }),
  );
  approvals.register('MARKET_HALT', async (admin, req) => {
    await store.setHalt(true, req.reason);
    await audit(db, admin, 'TRADING_HALT', 'market', null, { reason: req.reason, approvalId: req.id, requestedBy: req.requestedByEmail });
    broadcast();
    return { halted: true };
  });
  approvals.register('MARKET_RESUME', async (admin, req) => {
    if (!engine.control.haltAll) throw badRequest('NOT_HALTED', 'Sàn đã được mở lại');
    if (store.emergency) throw badRequest('EMERGENCY', 'Sàn đang dừng khẩn: hãy xác nhận hoặc huỷ dừng khẩn');
    const was = engine.control.haltReason;
    await store.setHalt(false, '');
    await audit(db, admin, 'TRADING_RESUME', 'market', null, { reason: req.reason, haltReason: was, approvalId: req.id, requestedBy: req.requestedByEmail });
    broadcast();
    return { halted: false };
  });

  /* ---- dừng khẩn: 1 người dừng ngay, người thứ hai xác nhận; không ai xác nhận thì tự mở lại ---- */

  /** Sự cố cần dừng ngay toàn sàn mà không chờ duyệt — tự hết hiệu lực sau EMERGENCY_HALT_MIN phút nếu không ai xác nhận */
  r.post(
    '/market/emergency-halt',
    need('market.halt'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const { reason } = z.object({ reason: reasonSchema }).parse(req.body);
      if (engine.control.haltAll) throw badRequest('ALREADY_HALTED', 'Sàn đang tạm ngừng nhận lệnh');
      const at = new Date();
      const emergency = { by: admin.email, byId: admin.id, reason, at: at.toISOString(), expiresAt: new Date(at.getTime() + EMERGENCY_HALT_MIN * 60_000).toISOString() };
      await store.setHalt(true, `Dừng khẩn: ${reason}`, emergency);
      await audit(db, admin, 'TRADING_EMERGENCY_HALT', 'market', null, { reason, expiresAt: emergency.expiresAt });
      broadcast();
      // Báo người có thể xác nhận (Vận hành thị trường / Rủi ro khác)
      await notifyStaff(db, mailer, 'market.approve', [admin.id], (name) => emergencyHaltEmail(name, emergency), { emergency: true }).catch(() => undefined);
      res.json({ ok: true, emergency });
    }),
  );

  /** Người thứ hai xác nhận → thành tạm ngừng chính thức (mở lại phải qua đề xuất + duyệt) */
  r.post(
    '/market/emergency-halt/confirm',
    need('market.approve'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      await expireEmergencyIfDue({ db, store, io });
      const e = store.emergency;
      if (!e) throw badRequest('NO_EMERGENCY', 'Không có dừng khẩn nào đang chờ xác nhận');
      if (e.byId === admin.id) throw badRequest('SELF', 'Người dừng khẩn không tự xác nhận được — cần một người khác');
      await store.setHalt(true, engine.control.haltReason, null);
      await audit(db, admin, 'TRADING_HALT_CONFIRM', 'market', null, { startedBy: e.by, reason: e.reason, at: e.at });
      broadcast();
      res.json(store.status());
    }),
  );

  /** Báo động nhầm: huỷ dừng khẩn chưa xác nhận → mở lại ngay */
  r.post(
    '/market/emergency-halt/cancel',
    need('market.halt'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const { reason } = z.object({ reason: reasonSchema }).parse(req.body);
      await expireEmergencyIfDue({ db, store, io });
      const e = store.emergency;
      if (!e) throw badRequest('NO_EMERGENCY', 'Không có dừng khẩn nào đang chờ xác nhận (đã xác nhận thì mở lại phải qua đề xuất)');
      await store.setHalt(false, '');
      await audit(db, admin, 'TRADING_EMERGENCY_CANCEL', 'market', null, { reason, startedBy: e.by, emergencyReason: e.reason });
      broadcast();
      res.json(store.status());
    }),
  );

  r.post(
    '/market/symbols/:symbol/halt',
    need('market.halt'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const symbol = String(req.params.symbol).toUpperCase();
      if (!market.info(symbol)) throw notFound('Cặp giao dịch không tồn tại');
      const { halted } = z.object({ halted: z.boolean() }).parse(req.body);
      await store.setSymbolHalt(symbol, halted);
      market.setStatus(symbol, halted ? 'HALT' : 'TRADING');
      await db.many('UPDATE symbols SET status = $2, updated_at = now() WHERE symbol = $1', [symbol, halted ? 'HALT' : 'TRADING']);
      await audit(db, admin, halted ? 'SYMBOL_HALT' : 'SYMBOL_RESUME', 'symbol', symbol);
      broadcast();
      res.json(store.status());
    }),
  );

  r.put(
    '/announcement',
    need('system.announce'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const body = z
        .object({
          text: z.string().trim().min(3, 'Nội dung tối thiểu 3 ký tự').max(300, 'Nội dung tối đa 300 ký tự'),
          level: z.enum(['info', 'warning', 'critical']),
        })
        .parse(req.body);
      await store.setAnnouncement({ ...body, updatedAt: new Date().toISOString() });
      await audit(db, admin, 'ANNOUNCEMENT_SET', 'system', null, body);
      broadcast();
      res.json(store.status());
    }),
  );

  r.delete(
    '/announcement',
    need('system.announce'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      await store.setAnnouncement(null);
      await audit(db, admin, 'ANNOUNCEMENT_CLEAR', 'system', null);
      broadcast();
      res.json(store.status());
    }),
  );

  /* ------------------------------ dữ liệu & sao lưu ------------------------------ */

  r.get(
    '/data',
    need('system.view'),
    ah(async (_req, res) => {
      const tables = [];
      for (const t of TABLES) {
        const row = await db.one<{ n: number }>(`SELECT count(*)::bigint AS n FROM ${t.name}`);
        tables.push({ ...t, rows: Number(row?.n ?? 0) });
      }
      res.json({
        db: {
          kind: db.kind,
          location: db.kind === 'postgres' ? safeDbUrl() : config.dataDir,
          sizeBytes: await dbSize(),
        },
        tables,
        memory: {
          rssBytes: process.memoryUsage().rss,
          symbols: market.symbols().length,
          openOrders: engine.openOrderCount(),
          lockedUsers: store.locked.size,
          logLines: recentLogs(10_000).length,
        },
      });
    }),
  );

  r.get(
    '/data/export',
    need('data.manage'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const backup = await exportBackup(db, { exportedBy: admin.email, tradeDate: utcDay() });
      await audit(db, admin, 'DATA_EXPORT', 'system', null, { counts: backup.counts });
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="vncoin-backup-${stamp}.json"`);
      res.send(serializeBackup(backup));
    }),
  );

  /* ------------------------------ giám sát ------------------------------ */

  r.get(
    '/monitor',
    need('system.view'),
    ah(async (_req, res) => {
      const w = metrics.window();
      const mem = process.memoryUsage();
      res.json({
        now: {
          requests5m: w.requests,
          rps: Math.round(w.rps * 100) / 100,
          p50: Math.round(w.p50),
          p95: Math.round(w.p95),
          p99: Math.round(w.p99),
          errors5m: w.errors,
          errorRate: w.errorRate,
          eventLoopMs: metrics.eventLoopMs,
          rssMb: Math.round(mem.rss / 1e6),
          heapMb: Math.round(mem.heapUsed / 1e6),
          sockets: metrics.socketCount(),
          dbMs: metrics.dbPingMs,
          dbOk: metrics.dbOk,
          uptimeSec: Math.round(process.uptime()),
          tickAgeSec: metrics.lastTickAt ? Math.round((Date.now() - metrics.lastTickAt) / 1000) : null,
          http: metrics.http,
          orders: metrics.orders,
          openOrders: engine.openOrderCount(),
        },
        series: metrics.series,
        alerts: deps.alerts ? [...deps.alerts.active.values()] : [],
        history: deps.alerts ? await deps.alerts.history(50) : [],
        channels: deps.alerts?.channels() ?? { emails: [], webhook: null },
        thresholds: config.alertThresholds,
        metricsEndpoint: config.metricsToken ? 'token' : config.isProd ? 'off' : 'open',
      });
    }),
  );

  r.post(
    '/monitor/test',
    need('system.manage'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      if (!deps.alerts) throw badRequest('NO_MONITOR', 'Chưa bật giám sát');
      const ok = await deps.alerts.notify('warning', 'Cảnh báo thử nghiệm', `Quản trị viên ${admin.email} gửi thử kênh cảnh báo lúc ${new Date().toISOString()}`, false);
      await audit(db, admin, 'ALERT_TEST', 'system', null, { delivered: ok });
      res.json({ ok, channels: deps.alerts.channels() });
    }),
  );

  /* ------------------------------ nhật ký ------------------------------ */

  r.get(
    '/audit',
    need('audit.view'),
    ah(async (req, res) => {
      const { limit, action } = z
        .object({ limit: z.coerce.number().int().min(1).max(1000).default(200), action: z.string().trim().max(40).optional() })
        .parse(req.query);
      const rows = action
        ? await db.many('SELECT * FROM admin_audit_log WHERE action = $1 ORDER BY id DESC LIMIT $2', [action, limit])
        : await db.many('SELECT * FROM admin_audit_log ORDER BY id DESC LIMIT $1', [limit]);
      res.json(rows);
    }),
  );

  r.get('/logs', need('system.view'), (req, res) => {
    const limit = Math.min(400, Math.max(1, Number(req.query.limit) || 200));
    res.json(recentLogs(limit));
  });


  // Mặc định cấm: route nào chưa khai báo need(...) thì không cho khởi động
  assertRoutesGuarded(r);
  return r;
}
