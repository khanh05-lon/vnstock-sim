import { z } from 'zod';

/* =====================================================================================
 * Quyền của chủ thể dữ liệu (bảo vệ dữ liệu cá nhân): khách tự tải dữ liệu của mình, gửi yêu cầu xoá tài khoản.
 * Người phụ trách bảo vệ dữ liệu (DPO) xử lý: xoá = ẨN DANH thông tin cá nhân, dữ liệu giao dịch được giữ
 * theo nghĩa vụ lưu trữ (phòng chống rửa tiền, đối soát).
 * ===================================================================================== */

export type PrivacyRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export const PRIVACY_STATUS_LABEL: Record<PrivacyRequestStatus, string> = {
  PENDING: 'Chờ xử lý',
  APPROVED: 'Đã xoá (ẩn danh)',
  REJECTED: 'Bị từ chối',
  CANCELLED: 'Đã rút yêu cầu',
};

/** Điều kiện trước khi xoá (DPO đối chiếu) */
export interface PrivacyCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface PrivacyRequestDTO {
  id: number;
  userId: string;
  email: string;
  accountName: string;
  type: 'DELETE';
  reason: string;
  status: PrivacyRequestStatus;
  decisionNote: string | null;
  decidedBy: string | null;
  createdAt: string;
  decidedAt: string | null;
  /** Chỉ trả cho DPO */
  checks?: PrivacyCheck[];
}

export const privacyDeleteSchema = z
  .object({ reason: z.string().trim().min(5, 'Cho biết lý do (tối thiểu 5 ký tự)').max(500) })
  .strict();

export const privacyDecisionSchema = z
  .object({
    approve: z.boolean(),
    note: z.string().trim().max(500).default(''),
  })
  .strict()
  .refine((v) => v.approve || v.note.length >= 5, { message: 'Ghi lý do từ chối (tối thiểu 5 ký tự)', path: ['note'] });

/** Số lần tải dữ liệu cá nhân tối đa mỗi ngày */
export const PRIVACY_EXPORTS_PER_DAY = 3;
