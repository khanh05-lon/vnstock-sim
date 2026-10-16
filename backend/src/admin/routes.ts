import fs from 'node:fs';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { Big, RULES, registerSchema } from '@vss/shared';
import { config } from '../config';
import { markEmailVerified, requireAuth, type AuthedRequest } from '../lib/auth';
import { accountLockedEmail, twoFactorChangedEmail } from '../lib/emails';
import { AppError, ah, badRequest, notFound } from '../lib/errors';
import { utcDay } from '../portfolio/nav';
import { sendLater } from '../routes/auth';
import { createUserAccount } from '../seed/seed';
import { accountView, navOf } from '../trading/account';
import { toLedgerDTO, toOrderDTO, type BalanceRow, type LedgerRow, type OrderRow } from '../trading/dto';
import { credit, ledger as writeLedger } from '../trading/wallet';
import { exportBackup, serializeBackup } from './backup';
import { assetParam, audit, forbidden, reasonSchema, uuid, type AdminDeps, type AdminRequest } from './common';
import { metrics } from '../ops/metrics';
import { recentLogs } from './logBuffer';
import { mountMarketAdmin } from './marketAdmin';

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
  { name: 'admin_audit_log', group: 'Vận hành', desc: 'Nhật ký thao tác quản trị' },
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
  role: 'USER' | 'ADMIN';
  status: 'ACTIVE' | 'LOCKED';
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

  /** Chỉ quản trị viên đang hoạt động; vai trò đọc lại từ CSDL ở mỗi request để thu quyền có hiệu lực ngay */
  r.use(requireAuth, (req: Request, _res: Response, next: NextFunction) => {
    const { user } = req as AuthedRequest;
    db.one<{ role: string; status: string }>('SELECT role, status FROM users WHERE id = $1', [user.id]).then((row) => {
      if (!row || row.role !== 'ADMIN') return next(forbidden('Bạn không có quyền truy cập khu vực quản trị'));
      if (row.status !== 'ACTIVE') return next(forbidden('Tài khoản quản trị đang bị khoá'));
      (req as AdminRequest).admin = { id: user.id, email: user.email };
      next();
    }, next);
  });

  const broadcast = () => io.emit('system', store.status());

  // Tham số giao dịch, danh mục mã, khôi phục dữ liệu
  mountMarketAdmin(r, deps, broadcast);

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

  r.get('/me', (req, res) => {
    res.json({ ok: true, admin: (req as AdminRequest).admin });
  });

  r.get(
    '/overview',
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
    ah(async (req, res) => {
      const id = uuid.parse(req.params.id);
      const u = await db.one<UserRow>(`SELECT ${ADMIN_USER_COLS} FROM users WHERE id = $1`, [id]);
      if (!u) throw notFound('Không tìm thấy người dùng');
      const account = await accountView(db, market, id);
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
      });
    }),
  );

  /** Quản trị viên tạo tài khoản nhà đầu tư (vd. cho một lớp học / giải đấu) — không qua giới hạn đăng ký theo IP */
  r.post(
    '/users',
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
    return u;
  };

  r.post(
    '/users/:id/verify-email',
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
    '/users/:id/reset-2fa',
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = uuid.parse(req.params.id);
      const { reason } = z.object({ reason: reasonSchema }).parse(req.body);
      const u = await loadTarget(id);
      if (!u.totp_enabled_at) throw badRequest('MFA_NOT_ENABLED', 'Tài khoản chưa bật xác thực 2 lớp');
      await db.tx(async (tx) => {
        await tx.many(
          `UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_pending_at = NULL, totp_enabled_at = NULL, totp_last_step = NULL
           WHERE id = $1`,
          [id],
        );
        await tx.many('DELETE FROM recovery_codes WHERE user_id = $1', [id]);
        await audit(tx, admin, 'USER_RESET_2FA', 'user', id, { email: u.email, reason });
      });
      sendLater(mailer, u.email, twoFactorChangedEmail(u.full_name, false, 'admin'), { userId: id });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/users/:id/lock',
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = uuid.parse(req.params.id);
      const { reason } = z.object({ reason: reasonSchema }).parse(req.body);
      if (id === admin.id) throw badRequest('SELF', 'Không thể tự khoá tài khoản của mình');
      const u = await loadTarget(id);
      if (u.role === 'ADMIN') throw badRequest('IS_ADMIN', 'Hãy thu quyền quản trị trước khi khoá tài khoản này');
      await db.many(`UPDATE users SET status = 'LOCKED', locked_reason = $2 WHERE id = $1`, [id, reason]);
      store.locked.add(id);
      const cancelled = await engine.cancelAllForUser(id, 'Tài khoản bị khoá bởi quản trị viên');
      io.in(`user:${id}`).disconnectSockets(true);
      await audit(db, admin, 'USER_LOCK', 'user', id, { email: u.email, reason, cancelledOrders: cancelled });
      sendLater(mailer, u.email, accountLockedEmail(u.full_name, true, reason), { userId: id });
      res.json({ ok: true, cancelledOrders: cancelled });
    }),
  );

  r.post(
    '/users/:id/unlock',
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

  r.post(
    '/users/:id/role',
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = uuid.parse(req.params.id);
      const { role } = z.object({ role: z.enum(['USER', 'ADMIN']) }).parse(req.body);
      if (id === admin.id) throw badRequest('SELF', 'Không thể tự thay đổi quyền của chính mình');
      const u = await loadTarget(id);
      if (u.status === 'LOCKED' && role === 'ADMIN') throw badRequest('LOCKED', 'Không cấp quyền quản trị cho tài khoản đang bị khoá');
      await db.many('UPDATE users SET role = $2 WHERE id = $1', [id, role]);
      await audit(db, admin, role === 'ADMIN' ? 'ROLE_GRANT_ADMIN' : 'ROLE_REVOKE_ADMIN', 'user', id, { email: u.email });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/users/:id/reset',
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = uuid.parse(req.params.id);
      const { reason } = z.object({ reason: reasonSchema }).parse(req.body);
      const u = await loadTarget(id);
      await engine.resetAccount(id);
      await audit(db, admin, 'ACCOUNT_RESET', 'user', id, { email: u.email, reason });
      res.json({ ok: true });
    }),
  );

  /**
   * Cộng / trừ số dư 1 tài sản (vd. thưởng giải đấu). Phần quy đổi USDT được tính vào vốn đã góp
   * để lợi nhuận và bảng xếp hạng không bị thổi phồng. Không trừ vào phần đang khoá cho lệnh.
   */
  r.post(
    '/users/:id/adjust-balance',
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
      const u = await loadTarget(id);
      const price = market.priceUsdt(asset);
      if (!price) throw badRequest('ASSET', `Không định giá được ${asset} (chưa có cặp ${asset}USDT trên sàn)`);
      const usdtValue = new Big(amount).times(price);
      if (usdtValue.abs().gt(1_000_000)) throw badRequest('LIMIT', 'Mỗi lần điều chỉnh tối đa tương đương 1.000.000 USDT');
      const after = await db.tx(async (tx) => {
        let total: string;
        if (new Big(amount).gt(0)) {
          total = await credit(tx, id, asset, amount, usdtValue.toFixed());
        } else {
          const take = new Big(amount).abs().toFixed();
          const row = await tx.one<BalanceRow>(
            `UPDATE balances SET free = free - $3,
                    cost_usdt = GREATEST(cost_usdt - cost_usdt * $3 / NULLIF(free + locked, 0), 0), updated_at = now()
             WHERE user_id = $1 AND asset = $2 AND free >= $3 RETURNING *`,
            [id, asset, take],
          );
          if (!row) throw badRequest('INSUFFICIENT_BALANCE', `Số dư ${asset} khả dụng không đủ để trừ ${take}`);
          total = new Big(row.free).plus(row.locked).toFixed();
        }
        await tx.many('UPDATE accounts SET contributed_usdt = contributed_usdt + $2, updated_at = now() WHERE user_id = $1', [id, usdtValue.toFixed()]);
        await writeLedger(tx, id, asset, 'ADJUST', amount, total, null, `Quản trị viên điều chỉnh: ${reason}`);
        await audit(tx, admin, 'BALANCE_ADJUST', 'user', id, { email: u.email, asset, amount, usdtValue: usdtValue.toFixed(2), reason, balanceAfter: total });
        return total;
      });
      io.to(`user:${id}`).emit('account');
      res.json({ ok: true, balanceAfter: after });
    }),
  );

  r.delete(
    '/users/:id',
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = uuid.parse(req.params.id);
      const { confirmEmail } = z.object({ confirmEmail: z.string().trim().toLowerCase() }).parse(req.body ?? {});
      if (id === admin.id) throw badRequest('SELF', 'Không thể tự xoá tài khoản của mình');
      const u = await loadTarget(id);
      if (u.role === 'ADMIN') throw badRequest('IS_ADMIN', 'Hãy thu quyền quản trị trước khi xoá tài khoản này');
      if (confirmEmail !== u.email) throw badRequest('CONFIRM', 'Email xác nhận không khớp');
      await engine.cancelAllForUser(id, 'Tài khoản bị xoá');
      io.in(`user:${id}`).disconnectSockets(true);
      await db.tx(async (tx) => {
        await tx.many('DELETE FROM users WHERE id = $1', [id]);
        await audit(tx, admin, 'USER_DELETE', 'user', id, { email: u.email, fullName: u.full_name });
      });
      store.locked.delete(id);
      res.json({ ok: true });
    }),
  );

  /* ------------------------------ lệnh ------------------------------ */

  r.get(
    '/orders',
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
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('ID', 'Mã lệnh không hợp lệ');
      const { reason } = z.object({ reason: reasonSchema }).parse(req.body);
      const order = await engine.adminCancel(id, `Quản trị viên huỷ: ${reason}`);
      await audit(db, admin, 'ORDER_CANCEL', 'order', String(id), { symbol: order.symbol, side: order.side, qty: order.origQty, reason });
      res.json(order);
    }),
  );

  /* ------------------------------ vận hành thị trường ------------------------------ */

  r.get(
    '/market',
    ah(async (_req, res) => {
      res.json({
        market: market.status(),
        source: market.opts.feed,
        status: store.status(),
        rules: RULES,
        symbols: market.rows().map((s) => ({ symbol: s.symbol, baseAsset: s.baseAsset, name: s.name, status: s.status })),
      });
    }),
  );

  r.post(
    '/market/halt',
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const body = z.object({ halted: z.boolean(), reason: z.string().trim().max(200).optional() }).parse(req.body);
      if (body.halted && (!body.reason || body.reason.length < 3)) throw badRequest('REASON', 'Nhập lý do tạm ngừng (tối thiểu 3 ký tự)');
      await store.setHalt(body.halted, body.reason ?? '');
      await audit(db, admin, body.halted ? 'TRADING_HALT' : 'TRADING_RESUME', 'market', null, { reason: body.reason ?? '' });
      broadcast();
      res.json(store.status());
    }),
  );

  r.post(
    '/market/symbols/:symbol/halt',
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

  r.get('/logs', (req, res) => {
    const limit = Math.min(400, Math.max(1, Number(req.query.limit) || 200));
    res.json(recentLogs(limit));
  });

  return r;
}
