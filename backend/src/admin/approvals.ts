import type { Router } from 'express';
import { z } from 'zod';
import { APPROVAL_KIND_LABEL, APPROVAL_PERMISSION, APPROVAL_TTL_MIN, type ApprovalDTO, type ApprovalKind, type ApprovalStatus } from '@vss/shared';
import type { Database } from '../db';
import { AppError, ah, badRequest, notFound } from '../lib/errors';
import { log } from '../lib/logger';
import { assertCan, audit, need, type AdminCtx, type AdminRequest } from './common';

interface ApprovalRow {
  id: number | string;
  kind: ApprovalKind;
  target: string | null;
  payload: Record<string, unknown>;
  summary: string;
  reason: string;
  status: ApprovalStatus;
  requested_by: string;
  requested_by_email: string;
  requested_role: string;
  decided_by: string | null;
  decided_by_email: string | null;
  decision_note: string | null;
  decided_at: Date | null;
  result: Record<string, unknown> | null;
  expires_at: Date;
  created_at: Date;
}

const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());

const toDTO = (r: ApprovalRow): ApprovalDTO => ({
  id: Number(r.id),
  kind: r.kind,
  target: r.target,
  payload: r.payload ?? {},
  summary: r.summary,
  reason: r.reason,
  status: r.status,
  requestedByEmail: r.requested_by_email,
  requestedRole: r.requested_role,
  decidedByEmail: r.decided_by_email,
  decisionNote: r.decision_note,
  decidedAt: iso(r.decided_at),
  result: r.result,
  expiresAt: iso(r.expires_at)!,
  createdAt: iso(r.created_at)!,
});

/** Thông tin đề xuất truyền cho hàm thực hiện */
export interface ApprovedRequest extends ApprovalDTO {
  requestedBy: string;
}

/** Thực hiện thao tác đã được duyệt; `executor` = người duyệt. Kết quả trả về được lưu vào đề xuất */
export type ApprovalExecutor = (executor: AdminCtx, req: ApprovedRequest) => Promise<Record<string, unknown>>;

/**
 * Hàng chờ duyệt 2 người cho thao tác lớn (chỉnh giá lớn, niêm yết / huỷ niêm yết, tạm ngừng toàn sàn,
 * khôi phục dữ liệu): người đề xuất ≠ người duyệt, người duyệt phải có quyền theo loại đề xuất;
 * duyệt xong hệ thống mới thực hiện. Mọi bước ghi admin_audit_log (chỉ ghi thêm).
 */
export class Approvals {
  private executors = new Map<ApprovalKind, ApprovalExecutor>();
  private cleanups = new Map<ApprovalKind, (payload: Record<string, unknown>) => void>();

  constructor(private db: Database) {}

  register(kind: ApprovalKind, fn: ApprovalExecutor) {
    this.executors.set(kind, fn);
  }

  /** Dọn tài nguyên của đề xuất khi kết thúc (duyệt / lỗi / từ chối / rút / hết hạn) — vd. xoá file sao lưu tải lên */
  registerCleanup(kind: ApprovalKind, fn: (payload: Record<string, unknown>) => void) {
    this.cleanups.set(kind, fn);
  }

  private cleanup(rows: Pick<ApprovalRow, 'id' | 'kind' | 'payload'>[]) {
    for (const r of rows) {
      try {
        this.cleanups.get(r.kind)?.(r.payload ?? {});
      } catch (err) {
        log.error('[approval] lỗi dọn dẹp đề xuất', { id: r.id, kind: r.kind, err });
      }
    }
  }

  /** Đề xuất quá hạn chưa ai duyệt → hết hạn (phải đề xuất lại với số liệu mới) */
  async expireStale() {
    this.cleanup(
      await this.db.many<ApprovalRow>(`UPDATE approval_requests SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at < now() RETURNING id, kind, payload`),
    );
  }

  /** Sau khi khôi phục dữ liệu: mọi đề xuất đang chờ khác dựa trên dữ liệu cũ → hết hiệu lực (kể cả dòng gộp vào từ file sao lưu) */
  async invalidatePending(exceptId: number) {
    this.cleanup(
      await this.db.many<ApprovalRow>(
        `UPDATE approval_requests SET status = 'EXPIRED', decision_note = 'Hết hiệu lực do khôi phục dữ liệu' WHERE status = 'PENDING' AND id <> $1 RETURNING id, kind, payload`,
        [exceptId],
      ),
    );
  }

  async create(admin: AdminCtx, a: { kind: ApprovalKind; target: string | null; payload: Record<string, unknown>; summary: string; reason: string }): Promise<ApprovalDTO> {
    if (!this.executors.has(a.kind)) throw new Error(`Chưa đăng ký cách thực hiện cho ${a.kind}`);
    await this.expireStale();
    try {
      const row = await this.db.tx(async (tx) => {
        const r = await tx.one<ApprovalRow>(
          `INSERT INTO approval_requests (kind, target, payload, summary, reason, requested_by, requested_by_email, requested_role, expires_at)
           VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, now() + make_interval(mins => $9::int)) RETURNING *`,
          [a.kind, a.target, JSON.stringify(a.payload), a.summary, a.reason, admin.id, admin.email, admin.role ?? '', APPROVAL_TTL_MIN[a.kind]],
        );
        await audit(tx, admin, 'APPROVAL_REQUEST', 'approval', String(r!.id), { kind: a.kind, target: a.target, summary: a.summary, reason: a.reason });
        return r!;
      });
      return toDTO(row);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, 'PENDING_EXISTS', `Đã có đề xuất "${APPROVAL_KIND_LABEL[a.kind]}"${a.target ? ` cho ${a.target}` : ''} đang chờ duyệt — duyệt hoặc huỷ đề xuất đó trước`);
      }
      throw err;
    }
  }

  async list(status: 'PENDING' | 'ALL'): Promise<ApprovalDTO[]> {
    await this.expireStale();
    const rows = await this.db.many<ApprovalRow>(
      `SELECT * FROM approval_requests ${status === 'PENDING' ? `WHERE status = 'PENDING'` : ''} ORDER BY id DESC LIMIT 200`,
    );
    return rows.map(toDTO);
  }

  private async load(id: number): Promise<ApprovalRow> {
    await this.expireStale();
    const r = await this.db.one<ApprovalRow>('SELECT * FROM approval_requests WHERE id = $1', [id]);
    if (!r) throw notFound('Không tìm thấy đề xuất');
    if (r.status !== 'PENDING') throw badRequest('DECIDED', r.status === 'EXPIRED' ? 'Đề xuất đã hết hạn — cần đề xuất lại' : 'Đề xuất đã được xử lý');
    return r;
  }

  async approve(admin: AdminCtx, id: number, note: string | null): Promise<ApprovalDTO> {
    const r = await this.load(id);
    assertCan(admin, APPROVAL_PERMISSION[r.kind]);
    if (r.requested_by === admin.id) throw badRequest('SELF', 'Không được tự duyệt đề xuất do chính mình tạo — cần một người khác có thẩm quyền');
    // Giành quyền duyệt: 2 người bấm cùng lúc thì chỉ 1 người thực hiện
    const claimed = await this.db.one<ApprovalRow>(
      `UPDATE approval_requests SET status = 'APPROVED', decided_by = $2, decided_by_email = $3, decision_note = $4, decided_at = now()
       WHERE id = $1 AND status = 'PENDING' RETURNING *`,
      [id, admin.id, admin.email, note],
    );
    if (!claimed) throw badRequest('DECIDED', 'Đề xuất vừa được người khác xử lý');
    await audit(this.db, admin, 'APPROVAL_APPROVE', 'approval', String(id), {
      kind: r.kind,
      target: r.target,
      summary: r.summary,
      requestedBy: r.requested_by_email,
      note,
    });
    const exec = this.executors.get(r.kind)!;
    try {
      const result = await exec(admin, { ...toDTO(claimed), requestedBy: r.requested_by });
      const done = await this.db.one<ApprovalRow>(`UPDATE approval_requests SET result = $2::jsonb WHERE id = $1 RETURNING *`, [id, JSON.stringify(result)]);
      return toDTO(done!);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('[approval] duyệt nhưng thực hiện lỗi', { id, kind: r.kind, err });
      await this.db.many(`UPDATE approval_requests SET status = 'FAILED', result = $2::jsonb WHERE id = $1`, [id, JSON.stringify({ error: message })]);
      await audit(this.db, admin, 'APPROVAL_FAILED', 'approval', String(id), { kind: r.kind, target: r.target, error: message });
      throw err;
    } finally {
      this.cleanup([r]);
    }
  }

  async reject(admin: AdminCtx, id: number, note: string): Promise<ApprovalDTO> {
    const r = await this.load(id);
    assertCan(admin, APPROVAL_PERMISSION[r.kind]);
    if (r.requested_by === admin.id) throw badRequest('SELF', 'Muốn rút đề xuất của chính mình thì bấm "Huỷ đề xuất"');
    const row = await this.db.one<ApprovalRow>(
      `UPDATE approval_requests SET status = 'REJECTED', decided_by = $2, decided_by_email = $3, decision_note = $4, decided_at = now()
       WHERE id = $1 AND status = 'PENDING' RETURNING *`,
      [id, admin.id, admin.email, note],
    );
    if (!row) throw badRequest('DECIDED', 'Đề xuất vừa được người khác xử lý');
    this.cleanup([r]);
    await audit(this.db, admin, 'APPROVAL_REJECT', 'approval', String(id), { kind: r.kind, target: r.target, summary: r.summary, requestedBy: r.requested_by_email, note });
    return toDTO(row);
  }

  async cancel(admin: AdminCtx, id: number): Promise<ApprovalDTO> {
    const r = await this.load(id);
    if (r.requested_by !== admin.id) throw badRequest('NOT_OWNER', 'Chỉ người đề xuất được huỷ đề xuất');
    const row = await this.db.one<ApprovalRow>(
      `UPDATE approval_requests SET status = 'CANCELLED', decided_by = $2, decided_by_email = $3, decided_at = now()
       WHERE id = $1 AND status = 'PENDING' RETURNING *`,
      [id, admin.id, admin.email],
    );
    if (!row) throw badRequest('DECIDED', 'Đề xuất vừa được người khác xử lý');
    this.cleanup([r]);
    await audit(this.db, admin, 'APPROVAL_CANCEL', 'approval', String(id), { kind: r.kind, target: r.target, summary: r.summary });
    return toDTO(row);
  }
}

const idOf = (raw: string | undefined) => {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('ID', 'Mã đề xuất không hợp lệ');
  return id;
};

/** Route hàng chờ duyệt: mọi nhân viên quản trị xem được; duyệt / từ chối theo quyền của loại đề xuất */
export function mountApprovals(r: Router, approvals: Approvals) {
  r.get(
    '/approvals',
    need('admin.view'),
    ah(async (req, res) => {
      const status = req.query.status === 'ALL' ? 'ALL' : 'PENDING';
      res.json(await approvals.list(status));
    }),
  );

  r.post(
    '/approvals/:id/approve',
    need('admin.view'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const { note } = z.object({ note: z.string().trim().max(300).optional() }).parse(req.body ?? {});
      res.json(await approvals.approve(admin, idOf(req.params.id), note || null));
    }),
  );

  r.post(
    '/approvals/:id/reject',
    need('admin.view'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const { note } = z
        .object({ note: z.string().trim().min(3, 'Ghi lý do từ chối (tối thiểu 3 ký tự)').max(300) })
        .parse(req.body ?? {});
      res.json(await approvals.reject(admin, idOf(req.params.id), note));
    }),
  );

  r.post(
    '/approvals/:id/cancel',
    need('admin.view'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      res.json(await approvals.cancel(admin, idOf(req.params.id)));
    }),
  );
}
