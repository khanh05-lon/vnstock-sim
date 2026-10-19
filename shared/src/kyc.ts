import { z } from 'zod';

/* =====================================================================================
 * Xác minh danh tính (KYC) theo cấp và chống rửa tiền (AML) — theo cách Binance / OKX làm:
 *   cấp 0: chưa xác minh → Spot bằng vốn ảo, chưa dùng P2P
 *   cấp 1: danh tính (giấy tờ)  → P2P hạn mức thấp
 *   cấp 2: nâng cao (địa chỉ, nguồn tiền) → P2P hạn mức cao, được xin làm thương nhân
 * Sàn mô phỏng: hồ sơ là KHAI BÁO GIẢ LẬP (không tải ảnh), số giấy tờ được mã hoá, chỉ hiện 4 số cuối.
 * Bộ phận Tuân thủ (COMPLIANCE) duyệt hồ sơ, xử lý cảnh báo AML, lập báo cáo giao dịch đáng ngờ (STR), phong toả tài khoản.
 * ===================================================================================== */

export type KycLevel = 0 | 1 | 2;

export const KYC_LEVEL_LABEL: Record<KycLevel, string> = {
  0: 'Chưa xác minh',
  1: 'Đã xác minh danh tính',
  2: 'Đã xác minh nâng cao',
};

export type KycIdType = 'CCCD' | 'PASSPORT';
export const KYC_ID_TYPE_LABEL: Record<KycIdType, string> = { CCCD: 'Căn cước công dân', PASSPORT: 'Hộ chiếu' };

export const KYC_OCCUPATIONS = ['Nhân viên văn phòng', 'Kinh doanh tự do', 'Sinh viên', 'Kỹ sư / CNTT', 'Giáo viên', 'Y tế', 'Nghỉ hưu', 'Khác'] as const;
export const KYC_FUND_SOURCES = ['Lương', 'Kinh doanh', 'Đầu tư', 'Tiết kiệm', 'Thừa kế / quà tặng', 'Khác'] as const;
export const KYC_PURPOSES = ['Đầu tư dài hạn', 'Giao dịch ngắn hạn', 'Học tập / thử nghiệm', 'Thanh toán', 'Khác'] as const;

const yearsBetween = (from: Date, to: Date) => {
  let y = to.getUTCFullYear() - from.getUTCFullYear();
  const m = to.getUTCMonth() - from.getUTCMonth();
  if (m < 0 || (m === 0 && to.getUTCDate() < from.getUTCDate())) y--;
  return y;
};
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày không hợp lệ (YYYY-MM-DD)')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Ngày không hợp lệ');

export const kycLevel1Schema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(4, 'Nhập họ tên đầy đủ theo giấy tờ')
      .max(80)
      .regex(/^[\p{L} '.-]+$/u, 'Họ tên chỉ gồm chữ cái'),
    dateOfBirth: isoDate,
    nationality: z.string().trim().min(2, 'Nhập quốc tịch').max(40),
    idType: z.enum(['CCCD', 'PASSPORT']),
    idNumber: z.string().trim().toUpperCase(),
    idIssuedDate: isoDate,
    /** Người có ảnh hưởng chính trị (PEP) hoặc người thân của họ */
    isPep: z.boolean(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const now = new Date();
    const dob = new Date(`${v.dateOfBirth}T00:00:00Z`);
    if (yearsBetween(dob, now) < 18) ctx.addIssue({ code: 'custom', path: ['dateOfBirth'], message: 'Phải đủ 18 tuổi' });
    if (yearsBetween(dob, now) > 120) ctx.addIssue({ code: 'custom', path: ['dateOfBirth'], message: 'Ngày sinh không hợp lệ' });
    const issued = new Date(`${v.idIssuedDate}T00:00:00Z`);
    if (issued > now || issued < dob) ctx.addIssue({ code: 'custom', path: ['idIssuedDate'], message: 'Ngày cấp không hợp lệ' });
    if (v.idType === 'CCCD' && !/^\d{12}$/.test(v.idNumber)) ctx.addIssue({ code: 'custom', path: ['idNumber'], message: 'Số CCCD gồm 12 chữ số' });
    if (v.idType === 'PASSPORT' && !/^[A-Z0-9]{6,9}$/.test(v.idNumber)) ctx.addIssue({ code: 'custom', path: ['idNumber'], message: 'Số hộ chiếu gồm 6–9 ký tự chữ / số' });
  });
export type KycLevel1Input = z.infer<typeof kycLevel1Schema>;

export const kycLevel2Schema = z
  .object({
    address: z.string().trim().min(10, 'Nhập địa chỉ cư trú đầy đủ').max(200),
    occupation: z.enum(KYC_OCCUPATIONS),
    fundSource: z.enum(KYC_FUND_SOURCES),
    purpose: z.enum(KYC_PURPOSES),
  })
  .strict();
export type KycLevel2Input = z.infer<typeof kycLevel2Schema>;

export type KycApplicationStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export const KYC_STATUS_LABEL: Record<KycApplicationStatus, string> = { PENDING: 'Chờ duyệt', APPROVED: 'Đã duyệt', REJECTED: 'Bị từ chối' };

/** Cờ tự kiểm tra khi nộp (gợi ý cho người duyệt) */
export type KycFlag = 'DUPLICATE_ID' | 'PEP';
export const KYC_FLAG_LABEL: Record<KycFlag, string> = {
  DUPLICATE_ID: 'Số giấy tờ trùng với tài khoản khác',
  PEP: 'Khai là người có ảnh hưởng chính trị (PEP)',
};

/** Trạng thái KYC của chính khách (thông tin đã che) */
export interface MyKycDTO {
  level: KycLevel;
  name: string | null;
  /** Đang bị Tuân thủ hạn chế giao dịch */
  restricted: boolean;
  /** Hồ sơ gần nhất của từng cấp */
  applications: { id: number; level: 1 | 2; status: KycApplicationStatus; rejectReason: string | null; createdAt: string; reviewedAt: string | null }[];
  /** Hạn mức P2P / ngày theo cấp hiện tại và phần đã dùng hôm nay (VNĐ) */
  p2pDailyLimit: string;
  p2pUsedToday: string;
}

/** Hồ sơ cho nhân viên Tuân thủ */
export interface KycApplicationDTO {
  id: number;
  userId: string;
  email: string;
  accountName: string;
  level: 1 | 2;
  status: KycApplicationStatus;
  idLast4: string | null;
  flags: KycFlag[];
  rejectReason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  /** Chỉ có khi xem chi tiết (giải mã, ghi KYC_VIEW) */
  data?: (KycLevel1Input | KycLevel2Input) & Record<string, unknown>;
}

export const kycReviewSchema = z
  .object({
    approve: z.boolean(),
    reason: z.string().trim().max(500).default(''),
  })
  .strict()
  .refine((v) => v.approve || v.reason.length >= 5, { message: 'Ghi lý do từ chối (tối thiểu 5 ký tự)', path: ['reason'] });

/* ------------------------------ AML ------------------------------ */

export type AmlRule = 'LARGE_P2P' | 'HIGH_DAILY_VOLUME' | 'STRUCTURING' | 'RAPID_IN_OUT' | 'MANY_COUNTERPARTIES' | 'DUPLICATE_ID' | 'PEP';
export const AML_RULE_LABEL: Record<AmlRule, string> = {
  LARGE_P2P: 'Giao dịch P2P giá trị lớn',
  HIGH_DAILY_VOLUME: 'Khối lượng P2P 24 giờ cao',
  STRUCTURING: 'Chia nhỏ giao dịch để né ngưỡng',
  RAPID_IN_OUT: 'Mua vào bán ra nhanh (tiền đi qua tài khoản)',
  MANY_COUNTERPARTIES: 'Giao dịch với nhiều đối tác lạ',
  DUPLICATE_ID: 'Trùng số giấy tờ với tài khoản khác',
  PEP: 'Người có ảnh hưởng chính trị',
};
export type AmlSeverity = 'LOW' | 'MEDIUM' | 'HIGH';
export const AML_RULE_SEVERITY: Record<AmlRule, AmlSeverity> = {
  LARGE_P2P: 'MEDIUM',
  HIGH_DAILY_VOLUME: 'MEDIUM',
  STRUCTURING: 'HIGH',
  RAPID_IN_OUT: 'HIGH',
  MANY_COUNTERPARTIES: 'MEDIUM',
  DUPLICATE_ID: 'HIGH',
  PEP: 'MEDIUM',
};

export type AmlAlertStatus = 'OPEN' | 'REVIEWING' | 'CLOSED' | 'REPORTED';
export const AML_STATUS_LABEL: Record<AmlAlertStatus, string> = {
  OPEN: 'Mới',
  REVIEWING: 'Đang xem xét',
  CLOSED: 'Đã đóng (không đáng ngờ)',
  REPORTED: 'Đã lập STR',
};

/** Ngưỡng cảnh báo AML (VNĐ) — Tuân thủ chỉnh lúc chạy, lưu market_meta key admin.amlRules */
export const AML_RULES = {
  largeOrderVnd: 400_000_000,
  dailyVolumeVnd: 1_000_000_000,
  /** Chia nhỏ: số đơn tối thiểu trong 24 giờ, mỗi đơn từ structuringLowPct% đến dưới ngưỡng đơn lớn */
  structuringCount: 3,
  structuringLowPct: 80,
  /** Mua vào và bán ra qua P2P trong 24 giờ, mỗi chiều từ mức này */
  rapidInOutVnd: 100_000_000,
  /** Khách (không phải thương nhân) giao dịch với từ chừng này đối tác khác nhau trong 24 giờ */
  counterpartyCount: 5,
};
export type AmlRules = typeof AML_RULES;
export const DEFAULT_AML_RULES: AmlRules = { ...AML_RULES };

export const amlRulesPatchSchema = z
  .object({
    largeOrderVnd: z.number().int().min(1_000_000).max(1e13).optional(),
    dailyVolumeVnd: z.number().int().min(1_000_000).max(1e14).optional(),
    structuringCount: z.number().int().min(2).max(100).optional(),
    structuringLowPct: z.number().int().min(10).max(99).optional(),
    rapidInOutVnd: z.number().int().min(1_000_000).max(1e13).optional(),
    counterpartyCount: z.number().int().min(2).max(1000).optional(),
  })
  .strict();
export type AmlRulesPatch = z.infer<typeof amlRulesPatchSchema>;

export function applyAmlRules(patch: AmlRulesPatch | null | undefined) {
  Object.assign(AML_RULES, DEFAULT_AML_RULES, patch ?? {});
}

export interface AmlAlertDTO {
  id: number;
  userId: string;
  email: string;
  accountName: string;
  kycLevel: KycLevel;
  restricted: boolean;
  rule: AmlRule;
  severity: AmlSeverity;
  detail: Record<string, unknown>;
  status: AmlAlertStatus;
  notes: string | null;
  handledBy: string | null;
  handledAt: string | null;
  reportId: number | null;
  createdAt: string;
}

export interface AmlReportDTO {
  id: number;
  userId: string;
  email: string;
  alertIds: number[];
  narrative: string;
  createdBy: string;
  createdAt: string;
}

export interface RestrictedAccountDTO {
  userId: string;
  email: string;
  accountName: string;
  reason: string;
  by: string;
  at: string;
}

export const amlAlertUpdateSchema = z
  .object({
    status: z.enum(['REVIEWING', 'CLOSED']),
    notes: z.string().trim().max(1000).default(''),
  })
  .strict()
  .refine((v) => v.status !== 'CLOSED' || v.notes.length >= 5, { message: 'Đóng cảnh báo phải ghi kết luận (tối thiểu 5 ký tự)', path: ['notes'] });

export const amlReportSchema = z
  .object({
    userId: z.string().uuid(),
    alertIds: z.array(z.number().int().positive()).min(1, 'Chọn ít nhất 1 cảnh báo').max(50),
    narrative: z.string().trim().min(30, 'Mô tả giao dịch đáng ngờ tối thiểu 30 ký tự').max(5000),
  })
  .strict();

export const amlRestrictSchema = z.object({ reason: z.string().trim().min(5, 'Ghi lý do (tối thiểu 5 ký tự)').max(500) }).strict();
