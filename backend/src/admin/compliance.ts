import type { Router } from 'express';
import { z } from 'zod';
import {
  AML_RULES,
  DEFAULT_AML_RULES,
  amlAlertUpdateSchema,
  amlReportSchema,
  amlRestrictSchema,
  amlRulesPatchSchema,
  kycReviewSchema,
  type AmlAlertDTO,
  type AmlAlertStatus,
  type AmlReportDTO,
  type AmlRule,
  type AmlSeverity,
  type KycLevel,
  type RestrictedAccountDTO,
} from '@vss/shared';
import { ah, badRequest, notFound } from '../lib/errors';
import { runAmlScan } from '../kyc/aml';
import type { P2POrderRow } from '../p2p/service';
import type { Approvals } from './approvals';
import { audit, need, uuid, type AdminCtx, type AdminDeps, type AdminRequest } from './common';
import { auditView } from './staff';

interface AlertRow {
  id: string | number;
  user_id: string;
  rule: AmlRule;
  severity: AmlSeverity;
  detail: Record<string, unknown>;
  status: AmlAlertStatus;
  notes: string | null;
  handled_by: string | null;
  handled_at: Date | null;
  report_id: string | number | null;
  created_at: Date;
  email: string;
  full_name: string;
  kyc_level: number;
  aml_restricted_at: Date | null;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const idOf = (raw: string | undefined, what: string) => {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('ID', `Mã ${what} không hợp lệ`);
  return id;
};
const toAlert = (a: AlertRow): AmlAlertDTO => ({
  id: Number(a.id),
  userId: a.user_id,
  email: a.email,
  accountName: a.full_name,
  kycLevel: Number(a.kyc_level) as KycLevel,
  restricted: !!a.aml_restricted_at,
  rule: a.rule,
  severity: a.severity,
  detail: a.detail ?? {},
  status: a.status,
  notes: a.notes,
  handledBy: a.handled_by,
  handledAt: iso(a.handled_at),
  reportId: a.report_id == null ? null : Number(a.report_id),
  createdAt: iso(a.created_at)!,
});

const ALERT_SELECT = `SELECT a.*, u.email, u.full_name, u.kyc_level, u.aml_restricted_at FROM aml_alerts a JOIN users u ON u.id = a.user_id`;

/**
 * Bộ phận Tuân thủ (KYC/AML) — /api/admin/compliance/*:
 *  - kyc.review: duyệt / từ chối hồ sơ KYC (xem chi tiết ghi KYC_VIEW)
 *  - aml.view:   xem cảnh báo, hoạt động P2P của khách, STR, tài khoản bị hạn chế (Kiểm toán cũng xem được)
 *  - aml.manage: xử lý cảnh báo, lập STR (chỉ ghi thêm), hạn chế tài khoản, chỉnh ngưỡng; gỡ hạn chế = đề xuất AML_UNFREEZE
 * Khách không bao giờ thấy cảnh báo / STR (nguyên tắc không tiết lộ); thông báo hạn chế chỉ là câu chung.
 */
export function mountCompliance(r: Router, deps: AdminDeps, approvals: Approvals) {
  const { db, io, store, kyc, p2p } = deps;
  const tellUser = (id: string) => {
    io.to(`user:${id}`).emit('kyc');
    io.to(`user:${id}`).emit('account');
  };
  if (kyc) kyc.notify = tellUser;

  /* ---------------- KYC ---------------- */

  r.get(
    '/compliance/kyc',
    need('kyc.review'),
    ah(async (req, res) => {
      if (!kyc) throw notFound('Chưa bật KYC');
      const { status } = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'ALL']).default('PENDING') }).parse(req.query);
      res.json(await kyc.list(status));
    }),
  );

  r.get(
    '/compliance/kyc/:id',
    need('kyc.review'),
    ah(async (req, res) => {
      if (!kyc) throw notFound('Chưa bật KYC');
      res.json(await kyc.detail((req as AdminRequest).admin, idOf(req.params.id, 'hồ sơ')));
    }),
  );

  r.post(
    '/compliance/kyc/:id/review',
    need('kyc.review'),
    ah(async (req, res) => {
      if (!kyc) throw notFound('Chưa bật KYC');
      const { approve, reason } = kycReviewSchema.parse(req.body);
      res.json(await kyc.review((req as AdminRequest).admin, idOf(req.params.id, 'hồ sơ'), approve, reason));
    }),
  );

  /* ---------------- cảnh báo AML ---------------- */

  r.get(
    '/compliance/alerts',
    need('aml.view'),
    ah(async (req, res) => {
      const f = z
        .object({
          status: z.enum(['ACTIVE', 'OPEN', 'REVIEWING', 'CLOSED', 'REPORTED', 'ALL']).default('ACTIVE'),
          rule: z.string().trim().max(40).optional(),
          userId: uuid.optional(),
        })
        .parse(req.query);
      const rows = await db.many<AlertRow>(
        `${ALERT_SELECT}
         WHERE ($1 = 'ALL' OR ($1 = 'ACTIVE' AND a.status IN ('OPEN', 'REVIEWING')) OR a.status = $1)
           AND ($2::text IS NULL OR a.rule = $2) AND ($3::uuid IS NULL OR a.user_id = $3)
         ORDER BY (a.severity = 'HIGH') DESC, a.created_at DESC LIMIT 300`,
        [f.status, f.rule ?? null, f.userId ?? null],
      );
      res.json(rows.map(toAlert));
    }),
  );

  r.patch(
    '/compliance/alerts/:id',
    need('aml.manage'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = idOf(req.params.id, 'cảnh báo');
      const input = amlAlertUpdateSchema.parse(req.body);
      const row = await db.tx(async (tx) => {
        const a = await tx.one<{ status: AmlAlertStatus; user_id: string; rule: string }>('SELECT status, user_id, rule FROM aml_alerts WHERE id = $1 FOR UPDATE', [id]);
        if (!a) throw notFound('Không tìm thấy cảnh báo');
        if (a.status === 'CLOSED' || a.status === 'REPORTED') throw badRequest('DONE', 'Cảnh báo đã được xử lý xong');
        await tx.many(`UPDATE aml_alerts SET status = $2, notes = $3, handled_by = $4, handled_at = now() WHERE id = $1`, [id, input.status, input.notes || null, admin.email]);
        await audit(tx, admin, 'AML_ALERT_UPDATE', 'user', a.user_id, { alertId: id, rule: a.rule, status: input.status, notes: input.notes });
        return tx.one<AlertRow>(`${ALERT_SELECT} WHERE a.id = $1`, [id]);
      });
      res.json(toAlert(row!));
    }),
  );

  /** Hồ sơ hoạt động của 1 khách để thẩm định cảnh báo (ghi USER_VIEW) */
  r.get(
    '/compliance/users/:id',
    need('aml.view'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = uuid.parse(req.params.id);
      const u = await db.one<{
        id: string;
        email: string;
        full_name: string;
        kyc_level: number;
        kyc_name: string | null;
        created_at: Date;
        aml_restricted_at: Date | null;
        aml_restricted_reason: string | null;
        aml_restricted_by: string | null;
        merchant: string | null;
      }>(
        `SELECT u.id, u.email, u.full_name, u.kyc_level, u.kyc_name, u.created_at, u.aml_restricted_at, u.aml_restricted_reason, u.aml_restricted_by,
                m.status AS merchant
         FROM users u LEFT JOIN p2p_merchants m ON m.user_id = u.id WHERE u.id = $1`,
        [id],
      );
      if (!u) throw notFound('Không tìm thấy người dùng');
      await auditView(db, admin, u.id, u.email, 'compliance');
      const sums = await db.one<{ bought: string; sold: string; orders: number; counterparties: number }>(
        `WITH p AS (
           SELECT fiat_amount, 'IN' AS dir, seller_id AS cp FROM p2p_orders WHERE buyer_id = $1 AND status = 'COMPLETED' AND released_at > now() - interval '30 days'
           UNION ALL SELECT fiat_amount, 'OUT', buyer_id FROM p2p_orders WHERE seller_id = $1 AND status = 'COMPLETED' AND released_at > now() - interval '30 days'
         )
         SELECT COALESCE(sum(fiat_amount) FILTER (WHERE dir = 'IN'), 0)::text AS bought, COALESCE(sum(fiat_amount) FILTER (WHERE dir = 'OUT'), 0)::text AS sold,
                count(*)::int AS orders, count(DISTINCT cp)::int AS counterparties FROM p`,
        [id],
      );
      const orders = await db.many<P2POrderRow>(`SELECT * FROM p2p_orders WHERE buyer_id = $1 OR seller_id = $1 ORDER BY id DESC LIMIT 30`, [id]);
      res.json({
        user: {
          id: u.id,
          email: u.email,
          accountName: u.full_name,
          kycLevel: Number(u.kyc_level),
          kycName: u.kyc_name,
          createdAt: iso(u.created_at),
          merchantStatus: u.merchant,
          restricted: u.aml_restricted_at ? { at: iso(u.aml_restricted_at), reason: u.aml_restricted_reason, by: u.aml_restricted_by } : null,
        },
        p2p30d: { boughtVnd: sums!.bought, soldVnd: sums!.sold, orders: sums!.orders, counterparties: sums!.counterparties },
        orders: p2p ? await p2p.toOrderDTOs(orders, null) : [],
      });
    }),
  );

  r.post(
    '/compliance/scan',
    need('aml.manage'),
    ah(async (req, res) => {
      const created = await runAmlScan(db);
      await audit(db, (req as AdminRequest).admin, 'AML_SCAN', 'system', null, { created });
      res.json({ created });
    }),
  );

  /* ---------------- báo cáo giao dịch đáng ngờ (STR) ---------------- */

  r.get(
    '/compliance/reports',
    need('aml.view'),
    ah(async (_req, res) => {
      const rows = await db.many<{ id: string | number; user_id: string; email: string; alert_ids: (string | number)[]; narrative: string; created_by: string; created_at: Date }>(
        `SELECT r.*, u.email FROM aml_reports r JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT 200`,
      );
      const out: AmlReportDTO[] = rows.map((x) => ({
        id: Number(x.id),
        userId: x.user_id,
        email: x.email,
        alertIds: x.alert_ids.map(Number),
        narrative: x.narrative,
        createdBy: x.created_by,
        createdAt: iso(x.created_at)!,
      }));
      res.json(out);
    }),
  );

  r.post(
    '/compliance/reports',
    need('aml.manage'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const input = amlReportSchema.parse(req.body);
      const id = await db.tx(async (tx) => {
        const alerts = await tx.many<{ id: string | number; user_id: string; status: AmlAlertStatus }>(
          'SELECT id, user_id, status FROM aml_alerts WHERE id = ANY($1::bigint[]) FOR UPDATE',
          [input.alertIds],
        );
        if (alerts.length !== new Set(input.alertIds).size) throw badRequest('ALERTS', 'Có cảnh báo không tồn tại');
        if (alerts.some((a) => a.user_id !== input.userId)) throw badRequest('ALERTS', 'Các cảnh báo phải cùng 1 khách hàng');
        if (alerts.some((a) => a.status === 'CLOSED' || a.status === 'REPORTED')) throw badRequest('ALERTS', 'Có cảnh báo đã được xử lý xong');
        const r = await tx.one<{ id: string | number }>(
          'INSERT INTO aml_reports (user_id, alert_ids, narrative, created_by) VALUES ($1, $2::bigint[], $3, $4) RETURNING id',
          [input.userId, input.alertIds, input.narrative, admin.email],
        );
        await tx.many(`UPDATE aml_alerts SET status = 'REPORTED', report_id = $2, handled_by = $3, handled_at = now() WHERE id = ANY($1::bigint[])`, [
          input.alertIds,
          r!.id,
          admin.email,
        ]);
        await audit(tx, admin, 'AML_STR_FILE', 'user', input.userId, { reportId: Number(r!.id), alertIds: input.alertIds });
        return Number(r!.id);
      });
      res.json({ ok: true, id });
    }),
  );

  /* ---------------- hạn chế tài khoản ---------------- */

  r.get(
    '/compliance/restricted',
    need('aml.view'),
    ah(async (_req, res) => {
      const rows = await db.many<{ id: string; email: string; full_name: string; aml_restricted_reason: string | null; aml_restricted_by: string | null; aml_restricted_at: Date }>(
        `SELECT id, email, full_name, aml_restricted_reason, aml_restricted_by, aml_restricted_at FROM users WHERE aml_restricted_at IS NOT NULL ORDER BY aml_restricted_at DESC`,
      );
      const out: RestrictedAccountDTO[] = rows.map((u) => ({
        userId: u.id,
        email: u.email,
        accountName: u.full_name,
        reason: u.aml_restricted_reason ?? '',
        by: u.aml_restricted_by ?? '',
        at: iso(u.aml_restricted_at)!,
      }));
      res.json(out);
    }),
  );

  const loadCustomer = async (id: string) => {
    const u = await db.one<{ id: string; email: string; role: string; status: string; aml_restricted_at: Date | null }>(
      'SELECT id, email, role, status, aml_restricted_at FROM users WHERE id = $1',
      [id],
    );
    if (!u) throw notFound('Không tìm thấy người dùng');
    if (u.role !== 'USER') throw badRequest('IS_STAFF', 'Chỉ hạn chế được tài khoản khách hàng');
    if (u.status === 'DELETED') throw badRequest('DELETED', 'Tài khoản đã bị xoá');
    return u;
  };

  /** Hạn chế: vẫn đăng nhập được, không đặt lệnh Spot / P2P mới; quảng cáo P2P đóng, thương nhân tạm ngừng */
  r.post(
    '/compliance/users/:id/restrict',
    need('aml.manage'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = uuid.parse(req.params.id);
      const { reason } = amlRestrictSchema.parse(req.body);
      if (id === admin.id) throw badRequest('SELF', 'Không thể tự hạn chế tài khoản của mình');
      const u = await loadCustomer(id);
      if (u.aml_restricted_at) throw badRequest('ALREADY', 'Tài khoản đã bị hạn chế');
      await db.many('UPDATE users SET aml_restricted_at = now(), aml_restricted_reason = $2, aml_restricted_by = $3 WHERE id = $1', [id, reason, admin.email]);
      // Lý do chỉ lưu nội bộ: thương nhân chỉ thấy ghi chú chung (không tiết lộ việc bị điều tra)
      if (p2p) await p2p.onUserCleanup(id, 'Tạm ngừng theo yêu cầu kiểm tra tài khoản');
      await audit(db, admin, 'AML_RESTRICT', 'user', id, { email: u.email, reason });
      tellUser(id);
      res.json({ ok: true });
    }),
  );

  approvals.register('AML_UNFREEZE', async (admin: AdminCtx, req) => {
    if (req.target === admin.id) throw badRequest('SELF', 'Không được duyệt gỡ hạn chế tài khoản của chính mình');
    const u = await loadCustomer(req.target!);
    if (!u.aml_restricted_at) throw badRequest('NOT_RESTRICTED', 'Tài khoản không còn bị hạn chế');
    await db.many('UPDATE users SET aml_restricted_at = NULL, aml_restricted_reason = NULL, aml_restricted_by = NULL WHERE id = $1', [u.id]);
    await audit(db, admin, 'AML_UNRESTRICT', 'user', u.id, { email: u.email, reason: req.reason, approvalId: req.id, requestedBy: req.requestedByEmail });
    tellUser(u.id);
    return { email: u.email };
  });

  /** Gỡ hạn chế: đề xuất, người Tuân thủ khác duyệt (tư cách thương nhân do Rủi ro & giám sát khôi phục riêng) */
  r.post(
    '/compliance/users/:id/unrestrict',
    need('aml.manage'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = uuid.parse(req.params.id);
      const { reason } = amlRestrictSchema.parse(req.body);
      const u = await loadCustomer(id);
      if (!u.aml_restricted_at) throw badRequest('NOT_RESTRICTED', 'Tài khoản không bị hạn chế');
      const request = await approvals.create(admin, {
        kind: 'AML_UNFREEZE',
        target: id,
        payload: { email: u.email },
        summary: `Gỡ hạn chế giao dịch cho ${u.email}`,
        reason,
      });
      res.status(202).json({ ok: true, pending: true, request });
    }),
  );

  /* ---------------- ngưỡng AML ---------------- */

  r.get('/compliance/rules', need('aml.view'), (_req, res) => {
    res.json({ rules: AML_RULES, defaults: DEFAULT_AML_RULES, overrides: store.amlRulesPatch });
  });

  r.put(
    '/compliance/rules',
    need('aml.manage'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const patch = amlRulesPatchSchema.parse(req.body);
      const before = { ...store.amlRulesPatch };
      await store.setAmlRules(patch);
      await audit(db, admin, 'AML_RULES_SET', 'system', null, { before, patch });
      res.json({ rules: AML_RULES, overrides: store.amlRulesPatch });
    }),
  );

  r.delete(
    '/compliance/rules',
    need('aml.manage'),
    ah(async (req, res) => {
      await store.setAmlRules(null);
      await audit(db, (req as AdminRequest).admin, 'AML_RULES_RESET', 'system', null, {});
      res.json({ rules: AML_RULES, overrides: store.amlRulesPatch });
    }),
  );
}
