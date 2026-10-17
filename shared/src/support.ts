import { z } from 'zod';

/* ===================== Hỗ trợ khách hàng (CSKH) ===================== */

export type TicketCategory = 'ORDER' | 'BALANCE' | 'ACCOUNT' | 'SECURITY' | 'DATA' | 'OTHER';
export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'WAITING_CUSTOMER' | 'RESOLVED' | 'CLOSED';
export type TicketPriority = 'NORMAL' | 'HIGH' | 'URGENT';

export const TICKET_CATEGORY_LABEL: Record<TicketCategory, string> = {
  ORDER: 'Lệnh / khớp lệnh bất thường',
  BALANCE: 'Số dư, phí, sổ cái',
  ACCOUNT: 'Tài khoản, đăng nhập',
  SECURITY: 'Nghi bị truy cập trái phép',
  DATA: 'Dữ liệu cá nhân, xoá tài khoản',
  OTHER: 'Khác',
};

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  OPEN: 'Chờ tiếp nhận',
  IN_PROGRESS: 'Đang xử lý',
  WAITING_CUSTOMER: 'Chờ khách phản hồi',
  RESOLVED: 'Đã xử lý',
  CLOSED: 'Đã đóng',
};

export const TICKET_PRIORITY_LABEL: Record<TicketPriority, string> = {
  NORMAL: 'Bình thường',
  HIGH: 'Cao',
  URGENT: 'Khẩn cấp',
};

/** Hạn trả lời khách (phút) tính từ tin nhắn đầu tiên chưa được trả lời */
export const SUPPORT_SLA_MINUTES: Record<TicketPriority, number> = { URGENT: 15, HIGH: 60, NORMAL: 240 };

/** Danh mục mặc định mức ưu tiên Cao (ảnh hưởng tiền / bảo mật) */
export const HIGH_PRIORITY_CATEGORIES: readonly TicketCategory[] = ['ORDER', 'BALANCE', 'SECURITY'];

/** Yêu cầu đã xử lý tự đóng sau số ngày này nếu khách không phản hồi */
export const SUPPORT_AUTO_CLOSE_DAYS = 7;
/** Số yêu cầu đang mở tối đa của 1 khách */
export const SUPPORT_MAX_OPEN_TICKETS = 5;

export const isTicketActive = (s: TicketStatus) => s === 'OPEN' || s === 'IN_PROGRESS' || s === 'WAITING_CUSTOMER';

export interface TicketDTO {
  id: number;
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  orderId: number | null;
  assigneeEmail: string | null;
  customerWaitingSince: string | null;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  rating: number | null;
  ratingComment: string | null;
  /** Số tin chưa đọc của phía đang xem (khách hoặc nhân viên) */
  unread: number;
  lastMessageAt: string;
  createdAt: string;
  /** Chỉ có ở màn hình nhân viên */
  customer?: { id: string; email: string; fullName: string; status: string };
  /** Hạn trả lời (ISO) và đã quá hạn hay chưa — chỉ ở màn hình nhân viên */
  dueAt?: string | null;
  overdue?: boolean;
}

export interface TicketMessageDTO {
  id: number;
  authorKind: 'CUSTOMER' | 'STAFF' | 'SYSTEM';
  /** Khách chỉ thấy "Nhân viên CSKH", không thấy email nhân viên */
  authorName: string;
  body: string;
  internal: boolean;
  createdAt: string;
}

export interface TicketDetailDTO {
  ticket: TicketDTO;
  messages: TicketMessageDTO[];
}

const body = z.string().trim().min(1, 'Nhập nội dung').max(4000, 'Nội dung tối đa 4000 ký tự');

export const createTicketSchema = z
  .object({
    subject: z.string().trim().min(3, 'Tiêu đề tối thiểu 3 ký tự').max(120, 'Tiêu đề tối đa 120 ký tự'),
    category: z.enum(['ORDER', 'BALANCE', 'ACCOUNT', 'SECURITY', 'DATA', 'OTHER']),
    message: body,
    orderId: z.number().int().positive().nullable().optional(),
    urgent: z.boolean().optional(),
  })
  .strict();

export const ticketMessageSchema = z.object({ body, internal: z.boolean().optional() }).strict();

export const rateTicketSchema = z
  .object({
    rating: z.number().int().min(1, 'Chọn từ 1 đến 5 sao').max(5, 'Chọn từ 1 đến 5 sao'),
    comment: z.string().trim().max(500, 'Nhận xét tối đa 500 ký tự').optional(),
  })
  .strict();

export const ticketUpdateSchema = z
  .object({
    status: z.enum(['IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED']).optional(),
    priority: z.enum(['NORMAL', 'HIGH', 'URGENT']).optional(),
    resolution: z.string().trim().min(5, 'Ghi rõ cách đã xử lý (tối thiểu 5 ký tự)').max(1000, 'Tối đa 1000 ký tự').optional(),
  })
  .strict()
  .refine((o) => o.status !== 'RESOLVED' || !!o.resolution, { message: 'Đóng yêu cầu phải ghi rõ cách đã xử lý', path: ['resolution'] });

/* ===================== Trợ lý AI (hộp chat) ===================== */

export const AI_CHAT_LIMITS = {
  /** Số lượt (hỏi + đáp) gần nhất gửi lên máy chủ */
  maxTurns: 20,
  /** Độ dài 1 câu hỏi của khách */
  maxQuestionChars: 2000,
  /** Số câu hỏi tối đa của 1 người dùng mỗi 10 phút / mỗi ngày */
  per10Min: 15,
  perDay: 80,
};

export const aiChatSchema = z
  .object({
    messages: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(8000) }).strict())
      .min(1)
      .max(AI_CHAT_LIMITS.maxTurns * 2),
  })
  .strict()
  .refine((o) => o.messages.at(-1)?.role === 'user', { message: 'Tin nhắn cuối phải là câu hỏi', path: ['messages'] })
  .refine((o) => (o.messages.at(-1)?.content.length ?? 0) <= AI_CHAT_LIMITS.maxQuestionChars, {
    message: `Câu hỏi tối đa ${AI_CHAT_LIMITS.maxQuestionChars} ký tự`,
    path: ['messages'],
  });

export type AiChatTurn = z.infer<typeof aiChatSchema>['messages'][number];

/** Trạng thái trợ lý AI (GET /support/ai) */
export interface AiStatusDTO {
  enabled: boolean;
}

/** Mỗi dòng NDJSON máy chủ stream về khi trả lời */
export type AiStreamEvent = { t: string } | { done: true } | { error: string };

export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type TicketUpdateInput = z.infer<typeof ticketUpdateSchema>;

/* ===================== Nhật ký đăng nhập & nhật ký lệnh ===================== */

export const AUTH_EVENT_LABEL: Record<string, string> = {
  LOGIN_OK: 'Đăng nhập thành công',
  LOGIN_FAIL: 'Sai mật khẩu',
  LOGIN_BLOCKED: 'Bị chặn đăng nhập (sai quá nhiều lần)',
  LOGIN_2FA_FAIL: 'Sai mã xác thực 2 lớp',
  LOGIN_LOCKED_ACCOUNT: 'Đăng nhập khi tài khoản bị khoá',
  REGISTER: 'Đăng ký tài khoản',
  DEMO_LOGIN: 'Đăng nhập tài khoản demo',
  PASSWORD_CHANGE: 'Đổi mật khẩu',
  PASSWORD_RESET: 'Đặt lại mật khẩu qua email',
  TWO_FA_ENABLE: 'Bật xác thực 2 lớp',
  TWO_FA_DISABLE: 'Tắt xác thực 2 lớp',
  RECOVERY_CODES_REGENERATE: 'Tạo lại mã khôi phục',
  EMAIL_VERIFIED: 'Xác thực email',
  ACCOUNT_RESET: 'Đặt lại ví ảo',
};

export interface AuthEventDTO {
  id: number;
  event: string;
  label: string;
  ip: string | null;
  userAgent: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export const ORDER_EVENT_LABEL: Record<string, string> = {
  PLACE: 'Đặt lệnh',
  REPLACE: 'Sửa lệnh (huỷ và đặt lại)',
  TRIGGER: 'Lệnh dừng được kích hoạt',
  CANCEL: 'Huỷ lệnh',
  EXPIRE: 'Hết hiệu lực',
  REJECT: 'Bị từ chối',
};

export interface OrderEventDTO {
  id: number;
  orderId: number;
  event: string;
  label: string;
  /** "Khách hàng", "Hệ thống" hoặc email nhân viên */
  actor: string;
  ip: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

/* ===================== Điều chỉnh số dư cần duyệt ===================== */

export type AdjustRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export const ADJUST_STATUS_LABEL: Record<AdjustRequestStatus, string> = {
  PENDING: 'Chờ duyệt',
  APPROVED: 'Đã duyệt',
  REJECTED: 'Từ chối',
  CANCELLED: 'Đã huỷ',
};

export interface AdjustRequestDTO {
  id: number;
  user: { id: string; email: string; fullName: string };
  asset: string;
  amount: string;
  usdtValue: string;
  reason: string;
  ticketId: number | null;
  requestedByEmail: string;
  status: AdjustRequestStatus;
  decidedByEmail: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
}
