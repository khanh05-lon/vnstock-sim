import type { StaffRole, UserRole } from './account';

/*
 * Phân quyền nhân viên theo chức năng (như các sàn lớn): mỗi vai trò chỉ làm đúng mảng của mình.
 * Quản trị hệ thống quản lý con người & hệ thống nhưng KHÔNG chỉnh tiền / giá; thao tác lớn cần người thứ hai duyệt.
 */

export type Permission =
  /** Vào khu quản trị: tổng quan, lệnh, thị trường, cặp, giá, hàng chờ duyệt (chỉ xem) */
  | 'admin.view'
  /** Xem danh sách / hồ sơ người dùng (mỗi lần xem hồ sơ ghi USER_VIEW) */
  | 'users.view'
  /** Tạo tài khoản, xác thực email, tắt 2FA, xoá tài khoản */
  | 'users.manage'
  /** Khoá / mở khoá tài khoản */
  | 'users.lock'
  /** Cấp / thu vai trò nhân viên */
  | 'staff.manage'
  /** Huỷ hộ lệnh */
  | 'orders.cancel'
  /** Cặp giao dịch, giá, biểu phí; đề xuất niêm yết / huỷ niêm yết / chỉnh giá lớn / tạm ngừng toàn sàn */
  | 'market.manage'
  /** Tạm ngừng / mở lại từng cặp (xử lý khẩn) */
  | 'market.halt'
  /** Duyệt đề xuất thị trường của người khác */
  | 'market.approve'
  /** Thông báo hệ thống */
  | 'system.announce'
  /** Điều chỉnh / đặt lại số dư (từ ngưỡng trở lên thành đề xuất) */
  | 'finance.adjust'
  /** Duyệt điều chỉnh số dư của người khác */
  | 'finance.approve'
  /** Xuất sao lưu, đề xuất khôi phục dữ liệu */
  | 'data.manage'
  /** Duyệt khôi phục dữ liệu của người khác */
  | 'data.approve'
  /** Xem giám sát hệ thống, dung lượng dữ liệu, log máy chủ */
  | 'system.view'
  /** Gửi cảnh báo thử */
  | 'system.manage'
  /** Nhật ký quản trị */
  | 'audit.view'
  /** Khu chăm sóc khách hàng */
  | 'support.desk'
  /** Giao yêu cầu hỗ trợ cho nhân viên khác */
  | 'support.lead'
  /** Xem báo cáo giám sát gian lận (đa tài khoản, đặt lại liên tục, spam lệnh) */
  | 'risk.monitor'
  /** Xem doanh thu phí, chạy / xem đối soát số dư */
  | 'finance.view'
  /** Duyệt / từ chối đơn xin làm thương nhân P2P, tạm ngừng thương nhân, trừ tiền cọc */
  | 'p2p.review'
  /** Xử lý khiếu nại đơn P2P (khu CSKH) */
  | 'p2p.appeal'
  /** Duyệt / từ chối hồ sơ KYC, xem hồ sơ đầy đủ (mỗi lần xem ghi KYC_VIEW) */
  | 'kyc.review'
  /** Xem cảnh báo AML, báo cáo giao dịch đáng ngờ (STR), tài khoản bị hạn chế */
  | 'aml.view'
  /** Xử lý cảnh báo AML, lập STR, hạn chế tài khoản, chỉnh ngưỡng AML */
  | 'aml.manage'
  /** Người phụ trách phòng chống rửa tiền (MLRO): duyệt nộp STR, duyệt gỡ hạn chế */
  | 'aml.report'
  /** Khôi phục quyền truy cập cho khách (tắt 2FA khi mất thiết bị) sau khi đối chiếu KYC */
  | 'account.recovery'
  /** Duyệt bồi hoàn nhỏ do nhân viên CSKH đề xuất (≤ SUPPORT_COMP_LIMIT_USDT) */
  | 'support.compensate'
  /** Xử lý yêu cầu của chủ thể dữ liệu (xoá / ẩn danh tài khoản) */
  | 'privacy.manage';

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  USER: [],
  SUPPORT: ['support.desk'],
  SUPPORT_LEAD: ['support.desk', 'support.lead', 'account.recovery', 'support.compensate'],
  // Quản trị hệ thống (IT): con người & hệ thống, KHÔNG làm nghiệp vụ khách hàng (CSKH, 2FA, xoá tài khoản), tiền, giá
  ADMIN: [
    'admin.view',
    'users.view',
    'users.manage',
    'users.lock',
    'staff.manage',
    'system.announce',
    'data.manage',
    'data.approve',
    'system.view',
    'system.manage',
    'audit.view',
  ],
  MARKET_OPS: ['admin.view', 'orders.cancel', 'market.manage', 'market.halt', 'market.approve', 'system.announce'],
  FINANCE: ['admin.view', 'users.view', 'finance.adjust', 'finance.approve', 'finance.view'],
  RISK: ['admin.view', 'users.view', 'users.lock', 'orders.cancel', 'market.halt', 'market.approve', 'audit.view', 'support.desk', 'risk.monitor'],
  P2P_OPS: ['admin.view', 'users.view', 'p2p.review', 'p2p.appeal', 'support.desk'],
  COMPLIANCE: ['admin.view', 'users.view', 'kyc.review', 'aml.view', 'aml.manage'],
  MLRO: ['admin.view', 'users.view', 'kyc.review', 'aml.view', 'aml.manage', 'aml.report'],
  DPO: ['admin.view', 'users.view', 'privacy.manage', 'audit.view'],
  AUDITOR: ['admin.view', 'users.view', 'audit.view', 'system.view', 'risk.monitor', 'finance.view', 'aml.view'],
};

export const can = (role: string | null | undefined, perm: Permission): boolean =>
  !!role && (ROLE_PERMISSIONS[role as UserRole]?.includes(perm) ?? false);

/** Thông báo khi thiếu quyền — nói rõ vai trò nào được làm */
export const PERMISSION_DENIED: Record<Permission, string> = {
  'admin.view': 'Chỉ nhân viên quản trị được vào khu vực này',
  'users.view': 'Vai trò của bạn không được xem hồ sơ người dùng',
  'users.manage': 'Chỉ Quản trị hệ thống được quản lý tài khoản người dùng',
  'users.lock': 'Chỉ Quản trị hệ thống hoặc Rủi ro & giám sát được khoá / mở khoá tài khoản',
  'staff.manage': 'Chỉ Quản trị hệ thống được phân quyền nhân viên',
  'orders.cancel': 'Chỉ Vận hành thị trường hoặc Rủi ro & giám sát được huỷ hộ lệnh',
  'market.manage': 'Chỉ Vận hành thị trường được thay đổi cặp giao dịch, giá, biểu phí',
  'market.halt': 'Chỉ Vận hành thị trường hoặc Rủi ro & giám sát được tạm ngừng cặp',
  'market.approve': 'Chỉ Vận hành thị trường hoặc Rủi ro & giám sát được duyệt đề xuất thị trường',
  'system.announce': 'Chỉ Quản trị hệ thống hoặc Vận hành thị trường được đăng thông báo',
  'finance.adjust': 'Chỉ Tài chính được điều chỉnh số dư',
  'finance.approve': 'Chỉ Tài chính được duyệt điều chỉnh số dư',
  'data.manage': 'Chỉ Quản trị hệ thống được sao lưu / khôi phục dữ liệu',
  'data.approve': 'Chỉ Quản trị hệ thống được duyệt khôi phục dữ liệu',
  'system.view': 'Vai trò của bạn không được xem giám sát hệ thống',
  'system.manage': 'Chỉ Quản trị hệ thống được thao tác giám sát',
  'audit.view': 'Vai trò của bạn không được xem nhật ký quản trị',
  'support.desk': 'Chỉ nhân viên CSKH, Vận hành P2P hoặc Rủi ro & giám sát được vào khu CSKH',
  'support.lead': 'Chỉ Trưởng nhóm CSKH được giao yêu cầu cho nhân viên khác',
  'risk.monitor': 'Chỉ Rủi ro & giám sát hoặc Kiểm toán được xem báo cáo gian lận',
  'finance.view': 'Chỉ Tài chính hoặc Kiểm toán được xem doanh thu phí và đối soát',
  'p2p.review': 'Chỉ bộ phận Vận hành P2P được duyệt và quản lý thương nhân P2P',
  'p2p.appeal': 'Chỉ bộ phận Vận hành P2P được xử lý khiếu nại P2P',
  'kyc.review': 'Chỉ bộ phận Tuân thủ được duyệt hồ sơ KYC',
  'aml.view': 'Chỉ Tuân thủ hoặc Kiểm toán được xem cảnh báo AML',
  'aml.manage': 'Chỉ bộ phận Tuân thủ được xử lý cảnh báo AML, lập STR, hạn chế tài khoản',
  'aml.report': 'Chỉ Trưởng Tuân thủ (MLRO) được duyệt nộp STR và gỡ hạn chế tài khoản',
  'account.recovery': 'Chỉ Trưởng nhóm CSKH được khôi phục quyền truy cập (tắt 2FA) cho khách',
  'support.compensate': 'Chỉ Trưởng nhóm CSKH được duyệt bồi hoàn nhỏ',
  'privacy.manage': 'Chỉ người phụ trách bảo vệ dữ liệu cá nhân (DPO) được xử lý yêu cầu xoá tài khoản',
};

/** Vai trò có quyền này (vd. danh sách người được giao yêu cầu hỗ trợ) */
export const rolesWith = (perm: Permission): StaffRole[] =>
  (Object.keys(ROLE_PERMISSIONS) as UserRole[]).filter((r): r is StaffRole => r !== 'USER' && ROLE_PERMISSIONS[r].includes(perm));

export const ROLE_DESC: Record<UserRole, string> = {
  USER: 'Giao dịch bằng tài khoản của mình, không có quyền quản trị.',
  SUPPORT: 'Khu CSKH: trả lời yêu cầu, xem hồ sơ khách qua yêu cầu, huỷ hộ lệnh, khoá khẩn, đề xuất bồi hoàn.',
  SUPPORT_LEAD: 'Trưởng nhóm CSKH: mọi việc của CSKH + giao / chuyển yêu cầu, duyệt bồi hoàn nhỏ, khôi phục 2FA cho khách sau khi đối chiếu KYC.',
  ADMIN: 'Quản trị hệ thống (IT): nhân viên & phân quyền, tài khoản đăng nhập, sao lưu / khôi phục, giám sát, nhật ký. Không làm nghiệp vụ khách hàng, không chỉnh tiền, không chỉnh giá.',
  MARKET_OPS: 'Cặp giao dịch, giá, biểu phí (cả cấp VIP), thông báo, tạm ngừng; niêm yết / chỉnh giá lớn / tạm ngừng toàn sàn phải có người duyệt.',
  FINANCE: 'Điều chỉnh / đặt lại số dư; duyệt đề xuất bồi hoàn và điều chỉnh lớn của người khác.',
  RISK: 'Giám sát gian lận, khoá tài khoản, huỷ hộ lệnh, tạm ngừng cặp, xem nhật ký; duyệt đề xuất thị trường của người khác.',
  P2P_OPS: 'Vận hành P2P: duyệt / tạm ngừng thương nhân, trừ tiền cọc, xử lý khiếu nại đơn P2P.',
  COMPLIANCE: 'Chuyên viên Tuân thủ: duyệt hồ sơ KYC, xử lý cảnh báo chống rửa tiền, soạn báo cáo giao dịch đáng ngờ (chờ MLRO duyệt), hạn chế tài khoản.',
  MLRO: 'Trưởng Tuân thủ, người phụ trách phòng chống rửa tiền: mọi việc của Tuân thủ + duyệt nộp STR, duyệt gỡ hạn chế tài khoản.',
  DPO: 'Bảo vệ dữ liệu cá nhân: xử lý yêu cầu xoá tài khoản của khách (ẩn danh, giữ dữ liệu giao dịch theo nghĩa vụ lưu trữ), xem nhật ký truy cập dữ liệu.',
  AUDITOR: 'Chỉ đọc: tổng quan, người dùng, lệnh, nhật ký, giám sát, cảnh báo AML. Không thao tác được gì.',
};

/* ---------------------------- hàng chờ duyệt (2 người) ---------------------------- */

export type ApprovalKind = 'PRICE_SET' | 'SYMBOL_LIST' | 'SYMBOL_DELIST' | 'MARKET_HALT' | 'MARKET_RESUME' | 'DATA_RESTORE' | 'ROLE_SET' | 'ACCOUNT_RESET' | 'AML_UNFREEZE' | 'STR_FILE';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';

export const APPROVAL_KIND_LABEL: Record<ApprovalKind, string> = {
  PRICE_SET: 'Chỉnh giá lớn',
  SYMBOL_LIST: 'Niêm yết cặp',
  SYMBOL_DELIST: 'Huỷ niêm yết cặp',
  MARKET_HALT: 'Tạm ngừng toàn sàn',
  MARKET_RESUME: 'Mở lại sàn',
  DATA_RESTORE: 'Khôi phục dữ liệu',
  ROLE_SET: 'Cấp / đổi vai trò nhân viên',
  ACCOUNT_RESET: 'Đặt lại tài khoản khách',
  AML_UNFREEZE: 'Gỡ hạn chế tài khoản (AML)',
  STR_FILE: 'Nộp báo cáo giao dịch đáng ngờ (STR)',
};

export const APPROVAL_STATUS_LABEL: Record<ApprovalStatus, string> = {
  PENDING: 'Chờ duyệt',
  APPROVED: 'Đã duyệt & thực hiện',
  REJECTED: 'Bị từ chối',
  CANCELLED: 'Người đề xuất đã huỷ',
  EXPIRED: 'Hết hạn',
  FAILED: 'Duyệt nhưng thực hiện lỗi',
};

/** Quyền cần có để duyệt từng loại đề xuất (người duyệt phải khác người đề xuất) */
export const APPROVAL_PERMISSION: Record<ApprovalKind, Permission> = {
  PRICE_SET: 'market.approve',
  SYMBOL_LIST: 'market.approve',
  SYMBOL_DELIST: 'market.approve',
  MARKET_HALT: 'market.approve',
  MARKET_RESUME: 'market.approve',
  DATA_RESTORE: 'data.approve',
  ROLE_SET: 'staff.manage',
  ACCOUNT_RESET: 'finance.approve',
  AML_UNFREEZE: 'aml.report',
  STR_FILE: 'aml.report',
};

/** Thời hạn chờ duyệt (phút) — giá / tạm ngừng cần quyết nhanh, quá hạn phải đề xuất lại */
export const APPROVAL_TTL_MIN: Record<ApprovalKind, number> = {
  PRICE_SET: 30,
  SYMBOL_LIST: 24 * 60,
  SYMBOL_DELIST: 24 * 60,
  MARKET_HALT: 30,
  MARKET_RESUME: 60,
  DATA_RESTORE: 120,
  ROLE_SET: 24 * 60,
  ACCOUNT_RESET: 24 * 60,
  AML_UNFREEZE: 24 * 60,
  STR_FILE: 3 * 24 * 60,
};

/** Điều chỉnh số dư trực tiếp: tổng của 1 người trong 24 giờ (mọi khách) vượt ngưỡng × hệ số này cũng phải duyệt */
export const ADJUST_DAILY_TOTAL_MULTIPLIER = 5;

export interface ApprovalDTO {
  id: number;
  kind: ApprovalKind;
  target: string | null;
  payload: Record<string, unknown>;
  summary: string;
  reason: string;
  status: ApprovalStatus;
  requestedByEmail: string;
  requestedRole: string;
  decidedByEmail: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  result: Record<string, unknown> | null;
  expiresAt: string;
  createdAt: string;
}

/* ---------------------------- dừng khẩn toàn sàn ---------------------------- */

/** Dừng khẩn: 1 người làm được ngay, tự mở lại sau chừng này phút nếu không có người thứ hai xác nhận */
export const EMERGENCY_HALT_MIN = 15;

export interface EmergencyHalt {
  by: string;
  byId: string;
  reason: string;
  at: string;
  expiresAt: string;
}

/* ---------------------------- giám sát gian lận ---------------------------- */

export const FRAUD_RULES = {
  /** Xét đăng nhập / đặt lại trong chừng này ngày */
  windowDays: 30,
  /** Từ chừng này tài khoản trở lên đăng nhập cùng 1 IP → nghi đa tài khoản */
  sameIpMin: 2,
  /** Tự đặt lại tài khoản từ chừng này lần trở lên → nghi "làm lại tới khi đẹp" để leo bảng xếp hạng */
  resetMin: 3,
  /** Cửa sổ xét spam lệnh (phút) */
  spamWindowMin: 60,
  /** Đặt từ chừng này lệnh trong cửa sổ → spam */
  spamPlaceMin: 100,
  /** Hoặc: đặt ≥ spamCancelMinPlaces lệnh và huỷ ≥ tỉ lệ này */
  spamCancelMinPlaces: 30,
  spamCancelRatio: 0.9,
} as const;

export interface FraudAccount {
  id: string;
  email: string;
  role: UserRole;
  status: string;
  leaderboardBanned: boolean;
}

export interface FraudReport {
  generatedAt: string;
  sameIp: { ip: string; accounts: FraudAccount[]; lastSeen: string }[];
  frequentResets: { account: FraudAccount; resets: number; last: string }[];
  orderSpam: { account: FraudAccount; placed: number; cancelled: number; cancelRatio: number }[];
  /** Tài khoản đang bị loại khỏi bảng xếp hạng */
  banned: (FraudAccount & { reason: string | null; at: string | null })[];
}

/* ---------------------------- đối soát & doanh thu ---------------------------- */

export type ReconIssueKind = 'LEDGER_MISMATCH' | 'LAST_BALANCE_MISMATCH' | 'LOCKED_WITHOUT_ORDERS' | 'LOCKED_MISMATCH' | 'FEE_MISMATCH' | 'BANK_MISMATCH';

export const RECON_ISSUE_LABEL: Record<ReconIssueKind, string> = {
  LEDGER_MISMATCH: 'Tổng sổ cái ≠ số dư',
  LAST_BALANCE_MISMATCH: 'Số dư sau giao dịch cuối ≠ số dư hiện tại',
  LOCKED_WITHOUT_ORDERS: 'Có tiền đang khoá nhưng không có lệnh mở',
  LOCKED_MISMATCH: 'Số dư khoá khác tổng khoá của lệnh Spot, quảng cáo P2P, ký quỹ đơn P2P và tiền cọc thương nhân',
  BANK_MISMATCH: 'Số dư ngân hàng giả lập khác tổng tiền vào / ra trong sao kê',
  FEE_MISMATCH: 'Phí trong sổ cái ≠ phí trong khớp lệnh',
};

export interface ReconIssue {
  kind: ReconIssueKind;
  userId?: string;
  email?: string;
  asset: string;
  expected: string;
  actual: string;
}

export interface ReconRunDTO {
  id: number;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  balancesChecked: number;
  issues: ReconIssue[];
  issueCount: number;
  triggeredBy: string;
}

export interface FeeRevenueDay {
  day: string;
  fills: number;
  volumeUsdt: string;
  feeUsdt: string;
  makerFeeUsdt: string;
  takerFeeUsdt: string;
}

export interface FeeRevenueReport {
  days: FeeRevenueDay[];
  bySymbol: { symbol: string; fills: number; volumeUsdt: string; feeUsdt: string }[];
  totalFeeUsdt: string;
  totalVolumeUsdt: string;
}
