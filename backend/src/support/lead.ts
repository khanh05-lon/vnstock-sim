import type { Router } from 'express';
import { z } from 'zod';
import { Big, type AdjustRequestDTO } from '@vss/shared';
import { audit, need, type AdminDeps, type AdminRequest } from '../admin/common';
import { applyBalanceAdjust, resetUser2fa, toAdjustRequestDTO, type AdjustRequestRow } from '../admin/staff';
import { config } from '../config';
import { twoFactorChangedEmail } from '../lib/emails';
import { ah, badRequest, notFound } from '../lib/errors';
import { sendLater } from '../routes/auth';
import type { SupportService } from './service';

const idOf = (raw: string | undefined, what = 'yêu cầu') => {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('ID', `Mã ${what} không hợp lệ`);
  return id;
};

/**
 * Việc của Trưởng nhóm CSKH trong khu CSKH (/api/support-desk):
 *  - support.compensate: duyệt bồi hoàn NHỎ (cộng tiền, ≤ SUPPORT_COMP_LIMIT_USDT) do nhân viên CSKH đề xuất từ yêu cầu hỗ trợ;
 *    lớn hơn / trừ tiền vẫn phải Tài chính duyệt. Người đề xuất không tự duyệt.
 *  - account.recovery: tắt 2FA cho khách mất thiết bị, BẮT BUỘC đối chiếu danh tính với hồ sơ KYC đã duyệt
 *    (4 số cuối giấy tờ + họ tên). Sai thì ghi nhật ký lần thử thất bại.
 */
export function mountSupportLead(r: Router, deps: Pick<AdminDeps, 'db' | 'io' | 'mailer'> & { support: SupportService }) {
  const { db, io, mailer, support } = deps;

  const pendingSql = `SELECT r.*, u.email, u.full_name FROM balance_adjust_requests r JOIN users u ON u.id = r.user_id
    WHERE r.status = 'PENDING' AND r.ticket_id IS NOT NULL ORDER BY r.id`;

  /** Bồi hoàn CSKH đang chờ: kèm cờ Trưởng nhóm có được duyệt không (≤ hạn mức, cộng tiền) */
  r.get(
    '/compensations',
    need('support.compensate'),
    ah(async (_req, res) => {
      const rows = await db.many<AdjustRequestRow>(pendingSql);
      const limit = config.supportCompLimitUsdt;
      res.json({
        limitUsdt: limit,
        items: rows.map((x) => ({ ...toAdjustRequestDTO(x), leadCanApprove: new Big(x.amount).gt(0) && new Big(x.usdt_value).abs().lte(limit) })),
      });
    }),
  );

  r.post(
    '/compensations/:id/:decision',
    need('support.compensate'),
    ah(async (req, res) => {
      const staff = (req as AdminRequest).admin;
      const id = idOf(req.params.id);
      const decision = z.enum(['approve', 'reject']).parse(req.params.decision);
      const { note } = z.object({ note: z.string().trim().max(300).optional() }).parse(req.body ?? {});
      if (decision === 'reject' && (!note || note.length < 3)) throw badRequest('NOTE', 'Ghi lý do từ chối (tối thiểu 3 ký tự)');
      const out = await db.tx(async (tx) => {
        const x = await tx.one<AdjustRequestRow>(
          'SELECT r.*, u.email, u.full_name FROM balance_adjust_requests r JOIN users u ON u.id = r.user_id WHERE r.id = $1 FOR UPDATE OF r',
          [id],
        );
        if (!x) throw notFound('Không tìm thấy yêu cầu');
        if (x.status !== 'PENDING') throw badRequest('DECIDED', 'Yêu cầu đã được xử lý');
        if (x.ticket_id == null) throw badRequest('NOT_SUPPORT', 'Chỉ duyệt được bồi hoàn tạo từ yêu cầu hỗ trợ');
        if (x.requested_by === staff.id) throw badRequest('SELF', 'Không được tự duyệt đề xuất do chính mình tạo');
        if (x.user_id === staff.id) throw badRequest('SELF', 'Không được duyệt điều chỉnh số dư của chính mình');
        if (decision === 'approve') {
          if (new Big(x.amount).lte(0)) throw badRequest('OVER_LIMIT', 'Trừ tiền của khách phải do Tài chính duyệt');
          if (new Big(x.usdt_value).abs().gt(config.supportCompLimitUsdt)) {
            throw badRequest('OVER_LIMIT', `Bồi hoàn trên ${config.supportCompLimitUsdt} USDT phải do Tài chính duyệt`);
          }
          await applyBalanceAdjust(tx, staff, {
            userId: x.user_id,
            email: x.email ?? '',
            asset: x.asset,
            amount: new Big(x.amount).toFixed(),
            usdtValue: new Big(x.usdt_value).toFixed(),
            reason: x.reason,
            requestId: id,
            requestedBy: x.requested_by_email,
            ticketId: Number(x.ticket_id),
          });
        }
        const row = await tx.one<AdjustRequestRow>(
          `UPDATE balance_adjust_requests SET status = $2, decided_by = $3, decided_by_email = $4, decision_note = $5, decided_at = now()
           WHERE id = $1 RETURNING *`,
          [id, decision === 'approve' ? 'APPROVED' : 'REJECTED', staff.id, staff.email, note ?? null],
        );
        await audit(tx, staff, decision === 'approve' ? 'BALANCE_ADJUST_APPROVE' : 'BALANCE_ADJUST_REJECT', 'user', x.user_id, {
          requestId: id,
          email: x.email,
          asset: x.asset,
          amount: new Big(x.amount).toFixed(),
          note: note ?? null,
          via: 'support_lead',
        });
        return { dto: toAdjustRequestDTO({ ...row!, email: x.email, full_name: x.full_name }) as AdjustRequestDTO, userId: x.user_id, ticketId: Number(x.ticket_id) };
      });
      const approved = decision === 'approve';
      await support.postSystem(out.ticketId, `Bồi hoàn #${id} (${out.dto.amount} ${out.dto.asset}) ${approved ? 'đã được duyệt' : 'bị từ chối'} bởi ${staff.email}${note ? `: ${note}` : ''}`, true);
      if (approved) {
        await support.postSystem(out.ticketId, `Số dư của bạn đã được điều chỉnh ${out.dto.amount} ${out.dto.asset}`, false);
        io.to(`user:${out.userId}`).emit('account');
      }
      res.json(out.dto);
    }),
  );

  /** Khôi phục quyền truy cập: tắt 2FA của chủ yêu cầu hỗ trợ sau khi đối chiếu KYC */
  r.post(
    '/tickets/:id/reset-2fa',
    need('account.recovery'),
    ah(async (req, res) => {
      const staff = (req as AdminRequest).admin;
      const ticketId = idOf(req.params.id);
      const input = z
        .object({
          idLast4: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4}$/, 'Nhập đúng 4 ký tự cuối số giấy tờ khách cung cấp'),
          nameConfirmed: z.literal(true, { errorMap: () => ({ message: 'Xác nhận đã đối chiếu họ tên khách với hồ sơ KYC' }) }),
          reason: z.string().trim().min(5, 'Ghi lý do (tối thiểu 5 ký tự)').max(300),
        })
        .strict()
        .parse(req.body);
      const t = await support.getRow(ticketId);
      const u = await db.one<{ id: string; email: string; full_name: string; kyc_level: number; totp_enabled_at: Date | null; role: string }>(
        'SELECT id, email, full_name, kyc_level, totp_enabled_at, role FROM users WHERE id = $1',
        [t.user_id],
      );
      if (!u) throw notFound('Không tìm thấy khách hàng');
      if (u.role !== 'USER') throw badRequest('IS_STAFF', 'Tài khoản nhân viên khôi phục qua Quản trị hệ thống');
      if (!u.totp_enabled_at) throw badRequest('MFA_NOT_ENABLED', 'Tài khoản chưa bật xác thực 2 lớp');
      if (Number(u.kyc_level) < 1) throw badRequest('NO_KYC', 'Khách chưa xác minh danh tính (KYC) nên không đối chiếu được — không thể khôi phục qua CSKH');
      const kyc = await db.one<{ id_last4: string | null }>(
        `SELECT id_last4 FROM kyc_applications WHERE user_id = $1 AND level = 1 AND status = 'APPROVED' ORDER BY id DESC LIMIT 1`,
        [u.id],
      );
      if (!kyc?.id_last4 || kyc.id_last4.toUpperCase() !== input.idLast4) {
        await audit(db, staff, 'USER_RECOVERY_FAILED', 'user', u.id, { email: u.email, ticketId });
        throw badRequest('IDENTITY_MISMATCH', 'Thông tin giấy tờ không khớp hồ sơ KYC — không khôi phục. Lần thử đã được ghi nhật ký.');
      }
      await db.tx((tx) => resetUser2fa(tx, staff, u, { reason: input.reason, ticketId, verifiedBy: 'KYC id_last4 + họ tên' }));
      await support.postSystem(ticketId, 'Đã tắt xác thực 2 lớp sau khi đối chiếu danh tính với hồ sơ KYC. Đăng nhập lại và bật 2FA mới ngay.', false);
      sendLater(mailer, u.email, twoFactorChangedEmail(u.full_name, false, 'admin'), { userId: u.id });
      res.json({ ok: true });
    }),
  );
}
