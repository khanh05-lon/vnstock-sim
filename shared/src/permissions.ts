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
  | 'support.lead';

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  USER: [],
  SUPPORT: ['support.desk'],
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
    'support.desk',
    'support.lead',
  ],
  MARKET_OPS: ['admin.view', 'orders.cancel', 'market.manage', 'market.halt', 'market.approve', 'system.announce'],
  FINANCE: ['admin.view', 'users.view', 'finance.adjust', 'finance.approve'],
  RISK: ['admin.view', 'users.view', 'users.lock', 'orders.cancel', 'market.halt', 'market.approve', 'audit.view', 'support.desk'],
  AUDITOR: ['admin.view', 'users.view', 'audit.view', 'system.view'],
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
  'support.desk': 'Chỉ nhân viên CSKH, Rủi ro hoặc Quản trị hệ thống được vào khu CSKH',
  'support.lead': 'Chỉ Quản trị hệ thống được giao yêu cầu cho nhân viên khác',
};

/** Vai trò có quyền này (vd. danh sách người được giao yêu cầu hỗ trợ) */
export const rolesWith = (perm: Permission): StaffRole[] =>
  (Object.keys(ROLE_PERMISSIONS) as UserRole[]).filter((r): r is StaffRole => r !== 'USER' && ROLE_PERMISSIONS[r].includes(perm));

export const ROLE_DESC: Record<UserRole, string> = {
  USER: 'Giao dịch bằng tài khoản của mình, không có quyền quản trị.',
  SUPPORT: 'Khu CSKH: trả lời yêu cầu, xem hồ sơ khách qua yêu cầu, huỷ hộ lệnh, khoá khẩn, đề xuất bồi hoàn.',
  ADMIN: 'Nhân viên & phân quyền, tài khoản người dùng, sao lưu / khôi phục, giám sát, nhật ký. Không chỉnh tiền, không chỉnh giá.',
  MARKET_OPS: 'Cặp giao dịch, giá, biểu phí, thông báo, tạm ngừng; niêm yết / chỉnh giá lớn / tạm ngừng toàn sàn phải có người duyệt.',
  FINANCE: 'Điều chỉnh / đặt lại số dư; duyệt đề xuất bồi hoàn và điều chỉnh lớn của người khác.',
  RISK: 'Khoá tài khoản, huỷ hộ lệnh, tạm ngừng cặp, xem nhật ký; duyệt đề xuất thị trường của người khác.',
  AUDITOR: 'Chỉ đọc: tổng quan, người dùng, lệnh, nhật ký, giám sát. Không thao tác được gì.',
};

/* ---------------------------- hàng chờ duyệt (2 người) ---------------------------- */

export type ApprovalKind = 'PRICE_SET' | 'SYMBOL_LIST' | 'SYMBOL_DELIST' | 'MARKET_HALT' | 'DATA_RESTORE' | 'ROLE_SET' | 'ACCOUNT_RESET';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';

export const APPROVAL_KIND_LABEL: Record<ApprovalKind, string> = {
  PRICE_SET: 'Chỉnh giá lớn',
  SYMBOL_LIST: 'Niêm yết cặp',
  SYMBOL_DELIST: 'Huỷ niêm yết cặp',
  MARKET_HALT: 'Tạm ngừng toàn sàn',
  DATA_RESTORE: 'Khôi phục dữ liệu',
  ROLE_SET: 'Cấp / đổi vai trò nhân viên',
  ACCOUNT_RESET: 'Đặt lại tài khoản khách',
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
  DATA_RESTORE: 'data.approve',
  ROLE_SET: 'staff.manage',
  ACCOUNT_RESET: 'finance.approve',
};

/** Thời hạn chờ duyệt (phút) — giá / tạm ngừng cần quyết nhanh, quá hạn phải đề xuất lại */
export const APPROVAL_TTL_MIN: Record<ApprovalKind, number> = {
  PRICE_SET: 30,
  SYMBOL_LIST: 24 * 60,
  SYMBOL_DELIST: 24 * 60,
  MARKET_HALT: 30,
  DATA_RESTORE: 120,
  ROLE_SET: 24 * 60,
  ACCOUNT_RESET: 24 * 60,
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
