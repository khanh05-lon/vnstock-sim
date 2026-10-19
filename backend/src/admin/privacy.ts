import type { Router } from 'express';
import { z } from 'zod';
import { privacyDecisionSchema, type PrivacyRequestStatus } from '@vss/shared';
import { privacyResultEmail } from '../lib/emails';
import { ah, badRequest, notFound } from '../lib/errors';
import { privacyChecks, toPrivacyDTO } from '../privacy/service';
import { sendLater } from '../routes/auth';
import { audit, need, type AdminDeps, type AdminRequest } from './common';
import { anonymizeUser } from './staff';

/**
 * Bảo vệ dữ liệu cá nhân (DPO, quyền privacy.manage): xử lý yêu cầu xoá tài khoản của khách.
 * Chấp thuận = ẩn danh thông tin cá nhân (anonymizeUser), GIỮ dữ liệu giao dịch theo nghĩa vụ lưu trữ.
 * Chỉ chấp thuận khi mọi điều kiện đạt (không đơn P2P dở dang, không còn là thương nhân, không có nghĩa vụ giữ tài khoản).
 */
export function mountPrivacyAdmin(r: Router, deps: AdminDeps) {
  const { db, mailer } = deps;

  r.get(
    '/privacy/requests',
    need('privacy.manage'),
    ah(async (req, res) => {
      const { status } = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'ALL']).default('PENDING') }).parse(req.query);
      const rows = await db.many<{ id: string | number; user_id: string; status: PrivacyRequestStatus } & Record<string, unknown>>(
        `SELECT p.*, u.email, u.full_name FROM privacy_requests p JOIN users u ON u.id = p.user_id
         WHERE ($1 = 'ALL' OR p.status = $1) ORDER BY p.created_at ${status === 'PENDING' ? 'ASC' : 'DESC'} LIMIT 300`,
        [status],
      );
      const out = [];
      for (const row of rows) out.push(toPrivacyDTO(row as never, row.status === 'PENDING' ? await privacyChecks(db, row.user_id) : undefined));
      res.json(out);
    }),
  );

  r.post(
    '/privacy/requests/:id/decide',
    need('privacy.manage'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('ID', 'Mã yêu cầu không hợp lệ');
      const { approve, note } = privacyDecisionSchema.parse(req.body);
      const p = await db.one<{ id: string | number; user_id: string; status: PrivacyRequestStatus; reason: string }>('SELECT * FROM privacy_requests WHERE id = $1', [id]);
      if (!p) throw notFound('Không tìm thấy yêu cầu');
      if (p.status !== 'PENDING') throw badRequest('DECIDED', 'Yêu cầu đã được xử lý');
      if (p.user_id === admin.id) throw badRequest('SELF', 'Không được tự xử lý yêu cầu của chính mình');
      const u = await db.one<{ id: string; email: string; full_name: string; role: string; status: string }>(
        'SELECT id, email, full_name, role, status FROM users WHERE id = $1',
        [p.user_id],
      );
      if (!u || u.status === 'DELETED') throw badRequest('DELETED', 'Tài khoản đã bị xoá');
      if (u.role !== 'USER') throw badRequest('IS_STAFF', 'Tài khoản nhân viên phải được thu quyền trước');
      if (approve) {
        const failed = (await privacyChecks(db, u.id)).filter((c) => !c.ok);
        if (failed.length) throw badRequest('CHECKS', `Chưa đủ điều kiện xoá: ${failed.map((c) => c.label).join('; ')}`);
      }
      const original = { email: u.email, name: u.full_name };
      await db.many(`UPDATE privacy_requests SET status = $2, decided_by = $3, decision_note = $4, decided_at = now() WHERE id = $1`, [
        id,
        approve ? 'APPROVED' : 'REJECTED',
        admin.email,
        note || null,
      ]);
      await audit(db, admin, approve ? 'PRIVACY_DELETE_APPROVE' : 'PRIVACY_DELETE_REJECT', 'user', u.id, { email: u.email, requestId: id, note: note || null });
      // Báo kết quả trước khi ẩn danh (sau đó không còn địa chỉ email)
      sendLater(mailer, original.email, privacyResultEmail(original.name, approve, note || undefined), { userId: u.id });
      if (approve) await anonymizeUser(deps, admin, u, { privacyRequestId: id, reason: p.reason });
      res.json({ ok: true });
    }),
  );
}
