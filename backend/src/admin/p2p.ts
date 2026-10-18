import type { Router } from 'express';
import { z } from 'zod';
import {
  Big,
  DEFAULT_P2P_RULES,
  P2P_RULES,
  depositPenaltySchema,
  merchantReviewSchema,
  merchantSuspendSchema,
  p2pRulesPatchSchema,
  type MerchantAdminDTO,
  type MerchantStatus,
} from '@vss/shared';
import { ah, badRequest } from '../lib/errors';
import { EMPTY_STATS, statsFor, type P2POrderRow } from '../p2p/service';
import { audit, need, uuid, type AdminDeps, type AdminRequest } from './common';
import { auditView } from './staff';

/**
 * Quản trị thương nhân P2P (vai trò Rủi ro & giám sát — quyền p2p.review):
 * duyệt / từ chối đơn xin, tạm ngừng / khôi phục, trừ tiền cọc. Tham số P2P (tỷ giá, phí...) do Vận hành thị trường chỉnh.
 * Khiếu nại đơn P2P xử lý ở khu CSKH (/api/support-desk/p2p).
 */
export function mountP2PAdmin(r: Router, deps: AdminDeps) {
  const { db, store, io } = deps;
  const p2p = deps.p2p;
  if (!p2p) return;
  const notifyUser = (id: string) => io.to(`user:${id}`).emit('p2p', { kind: 'merchant' });

  r.get('/p2p/rules', need('admin.view'), (_req, res) => {
    res.json({ rules: P2P_RULES, defaults: DEFAULT_P2P_RULES, overrides: store.p2pRulesPatch });
  });

  r.put(
    '/p2p/rules',
    need('market.manage'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const patch = p2pRulesPatchSchema.parse(req.body);
      const before = { ...store.p2pRulesPatch };
      await store.setP2PRules(patch);
      await audit(db, admin, 'P2P_RULES_SET', 'system', null, { before, patch });
      res.json({ rules: P2P_RULES, overrides: store.p2pRulesPatch });
    }),
  );

  r.delete(
    '/p2p/rules',
    need('market.manage'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      await store.setP2PRules(null);
      await audit(db, admin, 'P2P_RULES_RESET', 'system', null, {});
      res.json({ rules: P2P_RULES, overrides: store.p2pRulesPatch });
    }),
  );

  /** Danh sách thương nhân / đơn xin */
  r.get(
    '/p2p/merchants',
    need('p2p.review'),
    ah(async (req, res) => {
      const { status } = z.object({ status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED', 'RESIGNED', 'ALL']).default('ALL') }).parse(req.query);
      const rows = await db.many<{
        user_id: string;
        email: string;
        full_name: string;
        status: MerchantStatus;
        deposit_usdt: string;
        applied_at: Date;
        reviewed_at: Date | null;
        reviewed_by: string | null;
        note: string | null;
        open_ads: number;
        open_orders: number;
      }>(
        `SELECT m.*, u.email, u.full_name,
                (SELECT count(*)::int FROM p2p_ads a WHERE a.merchant_id = m.user_id AND a.status <> 'CLOSED') AS open_ads,
                (SELECT count(*)::int FROM p2p_orders o WHERE o.maker_id = m.user_id AND o.status IN ('PENDING_PAYMENT', 'PAID', 'APPEAL')) AS open_orders
         FROM p2p_merchants m JOIN users u ON u.id = m.user_id
         WHERE ($1 = 'ALL' OR m.status = $1)
         ORDER BY (m.status = 'PENDING') DESC, m.applied_at DESC LIMIT 300`,
        [status],
      );
      const stats = await statsFor(
        db,
        rows.map((x) => x.user_id),
      );
      const out: MerchantAdminDTO[] = [];
      for (const m of rows) {
        // Điều kiện hiện tại (để người duyệt đối chiếu); đơn đã duyệt thì không cần tính lại
        const reqs = m.status === 'PENDING' ? (await p2p.requirements(m.user_id).catch(() => null))?.list ?? [] : [];
        out.push({
          userId: m.user_id,
          email: m.email,
          name: m.full_name,
          status: m.status,
          depositUsdt: new Big(m.deposit_usdt).toFixed(),
          appliedAt: new Date(m.applied_at).toISOString(),
          reviewedAt: m.reviewed_at ? new Date(m.reviewed_at).toISOString() : null,
          reviewedBy: m.reviewed_by,
          note: m.note,
          openAds: m.open_ads,
          openOrders: m.open_orders,
          stats: stats.get(m.user_id) ?? EMPTY_STATS,
          // Đơn đang chờ: điều kiện tiền cọc đã khoá rồi nên bỏ khỏi danh sách đối chiếu
          requirements: reqs.filter((x) => x.key !== 'deposit'),
        });
      }
      res.json(out);
    }),
  );

  const merchantAction = (
    path: string,
    action: string,
    run: (admin: AdminRequest['admin'], id: string, body: unknown) => Promise<Record<string, unknown>>,
  ) =>
    r.post(
      `/p2p/merchants/:id/${path}`,
      need('p2p.review'),
      ah(async (req, res) => {
        const { admin } = req as AdminRequest;
        const id = uuid.parse(req.params.id);
        if (id === admin.id) throw badRequest('SELF', 'Không thao tác trên tư cách thương nhân của chính mình');
        const u = await db.one<{ email: string }>('SELECT email FROM users WHERE id = $1', [id]);
        if (!u) throw badRequest('NOT_FOUND', 'Không tìm thấy người dùng');
        const detail = await run(admin, id, req.body ?? {});
        await audit(db, admin, action, 'user', id, { email: u.email, ...detail });
        notifyUser(id);
        io.to(`user:${id}`).emit('account');
        res.json({ ok: true, ...detail });
      }),
    );

  merchantAction('approve', 'P2P_MERCHANT_APPROVE', async (admin, id, body) => {
    const { note } = merchantReviewSchema.parse(body);
    await p2p.approve(admin, id, note);
    return { note };
  });
  merchantAction('reject', 'P2P_MERCHANT_REJECT', async (admin, id, body) => {
    const { note } = merchantReviewSchema.parse(body);
    await p2p.reject(admin, id, note);
    return { note };
  });
  merchantAction('suspend', 'P2P_MERCHANT_SUSPEND', async (admin, id, body) => {
    const { reason } = merchantSuspendSchema.parse(body);
    const offline = await p2p.suspend(admin, id, reason);
    return { reason, adsOffline: offline };
  });
  merchantAction('restore', 'P2P_MERCHANT_RESTORE', async (admin, id, body) => {
    const { note } = merchantReviewSchema.parse(body);
    await p2p.restore(admin, id, note);
    return { note };
  });
  merchantAction('penalty', 'P2P_DEPOSIT_PENALTY', async (_admin, id, body) => {
    const input = depositPenaltySchema.parse(body);
    const left = await db.tx((tx) => p2p.deductDeposit(tx, id, input.amountUsdt, input.reason, input.compensateUserId ?? null, null));
    if (input.compensateUserId) io.to(`user:${input.compensateUserId}`).emit('account');
    return { amountUsdt: input.amountUsdt, reason: input.reason, compensateUserId: input.compensateUserId ?? null, depositLeft: left };
  });

  /** Đơn P2P toàn sàn (theo dõi) */
  r.get(
    '/p2p/orders',
    need('p2p.review'),
    ah(async (req, res) => {
      const f = z
        .object({ status: z.enum(['PENDING_PAYMENT', 'PAID', 'APPEAL', 'COMPLETED', 'CANCELLED', 'OPEN', 'ALL']).default('ALL'), userId: uuid.optional() })
        .parse(req.query);
      const rows = await db.many<P2POrderRow>(
        `SELECT * FROM p2p_orders
         WHERE ($1 = 'ALL' OR ($1 = 'OPEN' AND status IN ('PENDING_PAYMENT', 'PAID', 'APPEAL')) OR status = $1)
           AND ($2::uuid IS NULL OR buyer_id = $2 OR seller_id = $2)
         ORDER BY id DESC LIMIT 300`,
        [f.status, f.userId ?? null],
      );
      if (f.userId) {
        const u = await db.one<{ email: string }>('SELECT email FROM users WHERE id = $1', [f.userId]);
        if (u) await auditView(db, (req as AdminRequest).admin, f.userId, u.email, 'p2p_orders');
      }
      res.json(await p2p.toOrderDTOs(rows, null));
    }),
  );
}
