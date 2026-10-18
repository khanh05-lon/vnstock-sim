import { z } from 'zod';
import type { Dec } from './decimal';
import { symbolField } from './orders';

/* ===================== Ví & sổ cái ===================== */

export interface BalanceDTO {
  asset: string;
  free: Dec;
  locked: Dec;
  /** free + locked */
  total: Dec;
  /** Giá trị quy đổi USDT theo giá hiện tại */
  usdtValue: Dec;
  /** Giá vốn bình quân (USDT / 1 đơn vị) — null với USDT hoặc khi chưa mua */
  avgCost: Dec | null;
  /** Lãi / lỗ chưa thực hiện (USDT) theo giá vốn bình quân */
  unrealizedPnl: Dec | null;
}

export interface AccountDTO {
  balances: BalanceDTO[];
  /** Tổng tài sản ước tính */
  totalUsdt: Dec;
  totalBtc: Dec;
  initialUsdt: Dec;
  /** Vốn đã góp (vốn ban đầu + điều chỉnh của quản trị viên) — mốc tính lãi/lỗ */
  contributedUsdt: Dec;
  payFeeWithBnb: boolean;
  makerFee: Dec;
  takerFee: Dec;
}

export type LedgerType = 'RESET' | 'TRADE' | 'FEE' | 'ADJUST' | 'P2P';

export const LEDGER_LABEL: Record<LedgerType, string> = {
  RESET: 'Cấp vốn ảo',
  TRADE: 'Giao dịch',
  FEE: 'Phí giao dịch',
  ADJUST: 'Điều chỉnh',
  P2P: 'Giao dịch P2P',
};

export interface LedgerDTO {
  id: number;
  asset: string;
  type: LedgerType;
  /** Số tiền có dấu (+ cộng vào, − trừ đi) */
  amount: Dec;
  balanceAfter: Dec;
  orderId: number | null;
  note: string | null;
  createdAt: string;
}

/* ===================== Tài khoản người dùng ===================== */

export const registerSchema = z
  .object({
    fullName: z.string().trim().min(2, 'Họ tên tối thiểu 2 ký tự').max(80, 'Họ tên quá dài'),
    email: z.string().trim().toLowerCase().email('Email không hợp lệ'),
    password: z
      .string()
      .min(8, 'Mật khẩu tối thiểu 8 ký tự')
      .max(72, 'Mật khẩu tối đa 72 ký tự')
      .regex(/[A-Za-z]/, 'Mật khẩu phải có chữ cái')
      .regex(/[0-9]/, 'Mật khẩu phải có chữ số'),
  })
  .strict();

export const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().email('Email không hợp lệ'),
    password: z.string().min(1, 'Vui lòng nhập mật khẩu').max(72),
  })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Nhập mật khẩu hiện tại'),
    newPassword: registerSchema.shape.password,
  })
  .strict();

export const forgotPasswordSchema = z
  .object({
    email: registerSchema.shape.email,
  })
  .strict();

export const resetPasswordSchema = z
  .object({
    token: z.string().trim().min(20, 'Link đặt lại mật khẩu không hợp lệ').max(200, 'Link đặt lại mật khẩu không hợp lệ'),
    password: registerSchema.shape.password,
  })
  .strict();

/** Thời hạn của link đặt lại mật khẩu (phút) */
export const PASSWORD_RESET_TTL_MIN = 30;
/** Thời hạn của link xác thực email (giờ) */
export const EMAIL_VERIFY_TTL_HOURS = 24;

export const verifyEmailSchema = z
  .object({
    token: z.string().trim().min(20, 'Link xác thực không hợp lệ').max(200, 'Link xác thực không hợp lệ'),
  })
  .strict();

/** Mã 2FA: 6 số từ ứng dụng xác thực, hoặc mã khôi phục dạng xxxx-xxxx */
const otpCode = z.string().trim().min(6, 'Nhập mã 6 số hoặc mã khôi phục').max(20, 'Mã không hợp lệ');

export const loginMfaSchema = z
  .object({
    mfaToken: z.string().min(20).max(1000),
    code: otpCode,
  })
  .strict();

export const twoFactorSetupSchema = z.object({ password: z.string().min(1, 'Nhập mật khẩu hiện tại').max(72) }).strict();
export const twoFactorEnableSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Nhập mã 6 số trong ứng dụng xác thực') }).strict();
export const twoFactorConfirmSchema = z.object({ password: z.string().min(1, 'Nhập mật khẩu hiện tại').max(72), code: otpCode }).strict();

export const preferencesSchema = z
  .object({
    notifyFills: z.boolean().optional(),
    showOnLeaderboard: z.boolean().optional(),
    /** Trả phí giao dịch bằng BNB (được giảm phí) */
    payFeeWithBnb: z.boolean().optional(),
    displayName: z
      .string()
      .trim()
      .min(2, 'Tên hiển thị tối thiểu 2 ký tự')
      .max(30, 'Tên hiển thị tối đa 30 ký tự')
      .regex(/^[\p{L}\p{N} ._-]+$/u, 'Tên hiển thị chỉ gồm chữ, số, khoảng trắng và . _ -')
      .nullable()
      .optional(),
  })
  .strict();

/** Vai trò nhân viên — quyền chi tiết của từng vai trò ở permissions.ts */
export type StaffRole = 'ADMIN' | 'MARKET_OPS' | 'FINANCE' | 'RISK' | 'AUDITOR' | 'SUPPORT';
export type UserRole = 'USER' | StaffRole;

export const STAFF_ROLES: readonly StaffRole[] = ['ADMIN', 'MARKET_OPS', 'FINANCE', 'RISK', 'AUDITOR', 'SUPPORT'];
export const USER_ROLES: readonly UserRole[] = ['USER', ...STAFF_ROLES];

export const ROLE_LABEL: Record<UserRole, string> = {
  USER: 'Nhà đầu tư',
  SUPPORT: 'Nhân viên CSKH',
  ADMIN: 'Quản trị hệ thống',
  MARKET_OPS: 'Vận hành thị trường',
  FINANCE: 'Tài chính',
  RISK: 'Rủi ro & giám sát',
  AUDITOR: 'Kiểm toán (chỉ đọc)',
};

/** Có vai trò nhân viên (bất kỳ) */
export const isStaff = (role: string | null | undefined): role is StaffRole => !!role && (STAFF_ROLES as readonly string[]).includes(role);

/** Thông tin người dùng đăng nhập */
export interface UserDTO {
  id: string;
  email: string;
  fullName: string;
  createdAt: string;
  role: UserRole;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  notifyFills: boolean;
  displayName: string | null;
  showOnLeaderboard: boolean;
}

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

/* ===================== Danh sách theo dõi & cảnh báo giá ===================== */

export const MAX_WATCHLISTS = 10;
export const MAX_WATCHLIST_SYMBOLS = 100;

export interface WatchlistDTO {
  id: number;
  name: string;
  symbols: string[];
}

export const watchlistNameSchema = z
  .object({ name: z.string().trim().min(1, 'Nhập tên danh sách').max(40, 'Tên danh sách tối đa 40 ký tự') })
  .strict();

export const watchlistSymbolSchema = z.object({ symbol: symbolField }).strict();

/** PRICE_*: giá khớp vượt lên / xuống dưới mức; CHANGE_*: % thay đổi 24h đạt ngưỡng */
export type PriceAlertKind = 'PRICE_ABOVE' | 'PRICE_BELOW' | 'CHANGE_UP' | 'CHANGE_DOWN';
export type PriceAlertStatus = 'ACTIVE' | 'TRIGGERED' | 'CANCELLED';

export const MAX_ACTIVE_ALERTS = 50;

export const PRICE_ALERT_LABEL: Record<PriceAlertKind, string> = {
  PRICE_ABOVE: 'Giá ≥',
  PRICE_BELOW: 'Giá ≤',
  CHANGE_UP: 'Tăng 24h ≥ (%)',
  CHANGE_DOWN: 'Giảm 24h ≥ (%)',
};

export const PRICE_ALERT_STATUS_LABEL: Record<PriceAlertStatus, string> = {
  ACTIVE: 'Đang theo dõi',
  TRIGGERED: 'Đã báo',
  CANCELLED: 'Đã huỷ',
};

export interface PriceAlertDTO {
  id: number;
  symbol: string;
  kind: PriceAlertKind;
  /** Giá (PRICE_*) hoặc phần trăm (CHANGE_*, vd "3.5") */
  value: Dec;
  note: string | null;
  notifyEmail: boolean;
  status: PriceAlertStatus;
  triggeredPrice: Dec | null;
  triggeredAt: string | null;
  createdAt: string;
}

export const priceAlertSchema = z
  .object({
    symbol: symbolField,
    kind: z.enum(['PRICE_ABOVE', 'PRICE_BELOW', 'CHANGE_UP', 'CHANGE_DOWN']),
    value: z
      .union([z.string(), z.number()])
      .transform((v) => (typeof v === 'number' ? v.toString() : v.trim()))
      .refine((s) => /^\d{1,20}(\.\d{1,18})?$/.test(s) && Number(s) > 0, 'Giá trị phải lớn hơn 0'),
    note: z.string().trim().max(100, 'Ghi chú tối đa 100 ký tự').optional(),
    notifyEmail: z.boolean().optional(),
  })
  .strict()
  .refine((o) => !o.kind.startsWith('CHANGE') || Number(o.value) <= 1000, { message: 'Phần trăm thay đổi tối đa 1000%', path: ['value'] });

export type PriceAlertInput = z.infer<typeof priceAlertSchema>;

/* ===================== Báo cáo lãi lỗ theo tháng (USDT) ===================== */

export interface MonthlyReportRow {
  /** YYYY-MM (UTC) */
  month: string;
  /** Tổng giá trị khớp mua + bán (USDT) */
  tradedValue: number;
  /** Lãi / lỗ đã thực hiện của các lần bán theo giá vốn bình quân (đã trừ phí) */
  realizedPnl: number;
  /** Tổng phí quy đổi USDT */
  fees: number;
  trades: number;
}

export interface MonthlyReportDTO {
  year: number;
  months: MonthlyReportRow[];
  total: Omit<MonthlyReportRow, 'month'>;
  years: number[];
}
