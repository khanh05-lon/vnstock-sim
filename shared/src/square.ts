import { z } from 'zod';
import { DEFAULT_ALLOWED_DOMAINS, MOD_RULES, type ModHit, type ModRule } from './squareModeration';

/* =====================================================================================
 * Cộng đồng VNCoin (kiểu Binance Square): bài viết gắn $coin, nhận định Tăng / Giảm, chia sẻ lệnh / ROI thật,
 * bình luận, thích, theo dõi; kiểm duyệt 3 lớp (bộ lọc → giữ chờ duyệt → báo cáo) + thang phạt.
 * Nghiệp vụ: docs/CONG-DONG.md
 * ===================================================================================== */

export const SQUARE_POST_MAX = 2000;
export const SQUARE_COMMENT_MAX = 500;
export const SQUARE_BIO_MAX = 160;

export type SquareSentiment = 'BULLISH' | 'BEARISH';
export const SENTIMENT_LABEL: Record<SquareSentiment, string> = { BULLISH: 'Tăng', BEARISH: 'Giảm' };

export type SquareStatus = 'PUBLISHED' | 'PENDING' | 'REMOVED' | 'DELETED';
export type SquareTargetType = 'POST' | 'COMMENT' | 'PROFILE';
export type SquareAppealStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED';

export type SquareReportReason = 'SPAM' | 'SCAM' | 'PII' | 'ABUSE' | 'OBSCENE' | 'MANIPULATION' | 'IMPERSONATION' | 'OTHER';
export const SQUARE_REPORT_REASONS: readonly SquareReportReason[] = ['SPAM', 'SCAM', 'PII', 'ABUSE', 'OBSCENE', 'MANIPULATION', 'IMPERSONATION', 'OTHER'];
export const REPORT_REASON_LABEL: Record<SquareReportReason, string> = {
  SPAM: 'Spam, quảng cáo',
  SCAM: 'Lừa đảo, rủ giao dịch ngoài sàn',
  PII: 'Lộ thông tin cá nhân',
  ABUSE: 'Xúc phạm, quấy rối',
  OBSCENE: 'Tục tĩu, khiêu dâm',
  MANIPULATION: 'Thao túng giá, hô hào',
  IMPERSONATION: 'Mạo danh',
  OTHER: 'Khác',
};

/* ---------------------------------- tham số (quản trị chỉnh) ---------------------------------- */

/** Tham số Cộng đồng — Kiểm duyệt nội dung chỉnh lúc chạy (applySquareRules), lưu market_meta key admin.squareRules */
export const SQUARE_RULES = {
  /** Từ chặn thêm (ngoài từ điển gốc) — KHÔNG gửi cho FE */
  extraBlockWords: [] as string[],
  /** Từ giữ lại chờ duyệt thêm — KHÔNG gửi cho FE */
  extraReviewWords: [] as string[],
  /** Tên miền được dẫn liên kết (gồm cả tên miền con) */
  allowedDomains: [...DEFAULT_ALLOWED_DOMAINS] as string[],
  /** Điều kiện đăng: tài khoản tạo đủ chừng này giờ */
  minAccountAgeHours: 24,
  postsPerHour: 5,
  postsPerDay: 20,
  commentsPerHour: 30,
  reportsPerDay: 20,
  /** Bị bộ lọc chặn chừng này lần trong 1 giờ → tự cấm đăng (không tính vi phạm) */
  blockedAttemptsPerHour: 5,
  blockedCooldownMinutes: 60,
  /** Số người báo cáo khác nhau để tự ẩn nội dung chờ duyệt */
  autoHideReports: 3,
  /** Chỉ tính báo cáo của tài khoản tạo đủ chừng này ngày */
  reporterMinAgeDays: 7,
  /** Vi phạm hết hiệu lực sau chừng này ngày */
  strikeExpiryDays: 90,
  /** Giờ cấm đăng theo số vi phạm còn hiệu lực: phần tử i = lần thứ i + 1 (0 = chỉ cảnh cáo); quá cuối danh sách dùng phần tử cuối */
  strikeBanHours: [0, 24, 168, 720] as number[],
  /** Từ chừng này vi phạm hiện cờ "đề xuất cấm vĩnh viễn" */
  permanentFlagAt: 5,
  /** Kiểm duyệt viên cấm tay tối đa chừng này ngày; dài hơn = cấm vĩnh viễn qua đề xuất */
  maxManualBanDays: 30,
  /** Gỡ cấm còn từ chừng này ngày trở lên (hoặc vĩnh viễn) phải có người thứ hai duyệt */
  unbanApprovalDays: 7,
};
export type SquareRules = typeof SQUARE_RULES;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
export const DEFAULT_SQUARE_RULES: SquareRules = clone(SQUARE_RULES);

const word = z.string().trim().min(2, 'Từ tối thiểu 2 ký tự').max(40, 'Từ tối đa 40 ký tự');
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'Tên miền không hợp lệ (vd. coingecko.com)');
const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const squareRulesPatchSchema = z
  .object({
    extraBlockWords: z.array(word).max(500).optional(),
    extraReviewWords: z.array(word).max(500).optional(),
    allowedDomains: z.array(domain).max(50).optional(),
    minAccountAgeHours: int(0, 24 * 30).optional(),
    postsPerHour: int(1, 100).optional(),
    postsPerDay: int(1, 500).optional(),
    commentsPerHour: int(1, 500).optional(),
    reportsPerDay: int(1, 500).optional(),
    blockedAttemptsPerHour: int(1, 100).optional(),
    blockedCooldownMinutes: int(1, 24 * 60).optional(),
    autoHideReports: int(1, 50).optional(),
    reporterMinAgeDays: int(0, 365).optional(),
    strikeExpiryDays: int(1, 3650).optional(),
    strikeBanHours: z.array(int(0, 24 * 365)).min(1).max(10).optional(),
    permanentFlagAt: int(2, 50).optional(),
    maxManualBanDays: int(1, 365).optional(),
    unbanApprovalDays: int(0, 365).optional(),
  })
  .strict();
export type SquareRulesPatch = z.infer<typeof squareRulesPatchSchema>;

export function applySquareRules(patch: SquareRulesPatch | null | undefined) {
  Object.assign(SQUARE_RULES, clone(DEFAULT_SQUARE_RULES), patch ?? {});
}

/** Giờ cấm đăng khi đạt `strikes` vi phạm còn hiệu lực (0 = chỉ cảnh cáo) */
export function strikePenaltyHours(strikes: number, ladder: readonly number[] = SQUARE_RULES.strikeBanHours): number {
  if (strikes <= 0 || !ladder.length) return 0;
  return ladder[Math.min(strikes, ladder.length) - 1]!;
}

/** Phần tham số công khai cho FE (không có danh sách từ quản trị thêm) */
export interface SquareConfigDTO {
  allowedDomains: string[];
  minAccountAgeHours: number;
  postsPerHour: number;
  postsPerDay: number;
  commentsPerHour: number;
  maxTags: number;
  strikeExpiryDays: number;
  strikeBanHours: number[];
  autoHideReports: number;
  /** Coin được gắn thẻ $ (đang niêm yết) */
  assets: string[];
}

/* ---------------------------------- schema ---------------------------------- */

export const squareHandleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,20}$/, 'Tên người dùng 3–20 ký tự: chữ thường không dấu, số, gạch dưới');

export const squareProfileSchema = z
  .object({
    handle: squareHandleSchema,
    displayName: z.string().trim().min(2, 'Tên hiển thị tối thiểu 2 ký tự').max(40, 'Tên hiển thị tối đa 40 ký tự'),
    bio: z.string().trim().max(SQUARE_BIO_MAX, `Giới thiệu tối đa ${SQUARE_BIO_MAX} ký tự`).default(''),
    acceptGuidelines: z.boolean().optional(),
  })
  .strict();
export type SquareProfileInput = z.infer<typeof squareProfileSchema>;

export const squareShareSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ORDER'), orderId: z.coerce.number().int().positive() }).strict(),
  z.object({ type: z.literal('ROI') }).strict(),
]);

export const squarePostSchema = z
  .object({
    body: z.string().trim().min(1, 'Bài viết trống').max(SQUARE_POST_MAX, `Bài viết tối đa ${SQUARE_POST_MAX} ký tự`),
    sentiment: z.enum(['BULLISH', 'BEARISH']).nullable().optional(),
    share: squareShareSchema.nullable().optional(),
  })
  .strict();
export type SquarePostInput = z.infer<typeof squarePostSchema>;

export const squareCommentSchema = z
  .object({
    body: z.string().trim().min(1, 'Bình luận trống').max(SQUARE_COMMENT_MAX, `Bình luận tối đa ${SQUARE_COMMENT_MAX} ký tự`),
    parentId: z.coerce.number().int().positive().nullable().optional(),
  })
  .strict();

export const squareReportSchema = z
  .object({
    targetType: z.enum(['POST', 'COMMENT', 'PROFILE']),
    /** Mã bài / bình luận, hoặc @handle với hồ sơ */
    targetId: z.string().trim().min(1).max(40),
    reason: z.enum(SQUARE_REPORT_REASONS as [SquareReportReason, ...SquareReportReason[]]),
    note: z.string().trim().max(300).default(''),
  })
  .strict();

export const squareAppealSchema = z
  .object({ note: z.string().trim().min(10, 'Trình bày lý do khiếu nại (tối thiểu 10 ký tự)').max(500) })
  .strict();

/* --- kiểm duyệt viên --- */

const modRule = z.enum(MOD_RULES as [ModRule, ...ModRule[]]);
const modNote = z.string().trim().min(3, 'Ghi lý do (tối thiểu 3 ký tự)').max(300);

export const squareRemoveSchema = z
  .object({
    rule: modRule,
    note: modNote,
    /** Tính 1 vi phạm cho tác giả (bỏ chọn khi gỡ vì lý do khác, vd. trùng lặp, sai chủ đề) */
    strike: z.boolean().default(true),
  })
  .strict();

export const squareBanSchema = z
  .object({
    /** Số ngày cấm; bỏ trống + permanent = cấm vĩnh viễn (qua đề xuất) */
    days: z.number().int().min(1).max(365).optional(),
    permanent: z.boolean().default(false),
    reason: modNote,
  })
  .strict()
  .refine((x) => x.permanent || x.days, { message: 'Chọn số ngày cấm hoặc cấm vĩnh viễn', path: ['days'] });

export const squareModNoteSchema = z.object({ note: modNote }).strict();
export const squareAppealDecisionSchema = z.object({ accept: z.boolean(), note: modNote }).strict();
export const squareHandleResetSchema = z.object({ rule: modRule.default('IMPERSONATION'), note: modNote }).strict();

/* ---------------------------------- DTO ---------------------------------- */

export interface SquareAuthorDTO {
  handle: string;
  displayName: string;
}

/** Số liệu chia sẻ do máy chủ dựng từ dữ liệu thật lúc đăng — khách không gõ tay được */
export type SquareShareDTO =
  | {
      type: 'ORDER';
      symbol: string;
      base: string;
      side: 'BUY' | 'SELL';
      orderType: string;
      avgPrice: string;
      /** Giá thị trường lúc chia sẻ */
      priceAtShare: string;
      /** Lãi / lỗ % của vị thế từ giá khớp tới giá lúc chia sẻ (bán thì ngược chiều) */
      pnlPct: number;
      filledAt: string;
    }
  | {
      type: 'ROI';
      /** Tỷ suất lợi nhuận từ đầu (NAV so với vốn đã góp) */
      returnPct: number;
      at: string;
    };

export interface SquareRemovedInfo {
  rule: ModRule;
  note: string | null;
  at: string;
  appealStatus: SquareAppealStatus | null;
  canAppeal: boolean;
}

export interface SquarePostDTO {
  id: number;
  author: SquareAuthorDTO;
  body: string;
  sentiment: SquareSentiment | null;
  assets: string[];
  hashtags: string[];
  share: SquareShareDTO | null;
  status: SquareStatus;
  createdAt: string;
  likeCount: number;
  commentCount: number;
  liked: boolean;
  mine: boolean;
  /** Chỉ tác giả thấy khi bài đang chờ duyệt / đã bị gỡ */
  hits?: ModHit[];
  removed?: SquareRemovedInfo;
}

export interface SquareCommentDTO {
  id: number;
  postId: number;
  parentId: number | null;
  author: SquareAuthorDTO;
  body: string;
  status: SquareStatus;
  createdAt: string;
  mine: boolean;
  removed?: SquareRemovedInfo;
}

export interface SquareProfileDTO {
  handle: string;
  displayName: string;
  bio: string;
  joinedAt: string;
  followers: number;
  following: number;
  posts: number;
  likesReceived: number;
  followed: boolean;
  isMe: boolean;
  banned: boolean;
}

export interface SquareStrikeDTO {
  id: number;
  rule: ModRule;
  targetType: SquareTargetType;
  targetId: string | null;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
}

/** Tình trạng của chính người dùng */
export interface SquareMeDTO {
  profile: SquareProfileDTO | null;
  canPost: boolean;
  /** Lý do chưa đăng được (chưa xác thực email, tài khoản mới, đang bị cấm, nhân viên…) */
  blockedReason: string | null;
  banUntil: string | null;
  banPermanent: boolean;
  banReason: string | null;
  activeStrikes: number;
  strikes: SquareStrikeDTO[];
  unread: number;
}

export type SquareNotificationKind =
  | 'LIKE'
  | 'COMMENT'
  | 'REPLY'
  | 'FOLLOW'
  | 'APPROVED'
  | 'REMOVED'
  | 'STRIKE'
  | 'BANNED'
  | 'UNBANNED'
  | 'APPEAL_ACCEPTED'
  | 'APPEAL_REJECTED'
  | 'HANDLE_RESET';

export interface SquareNotificationDTO {
  id: number;
  kind: SquareNotificationKind;
  actor: SquareAuthorDTO | null;
  postId: number | null;
  commentId: number | null;
  detail: Record<string, unknown>;
  createdAt: string;
  read: boolean;
}

export interface SquareTrendDTO {
  asset: string;
  posts: number;
  bullish: number;
  bearish: number;
}

export interface SquareFeedDTO {
  posts: SquarePostDTO[];
  /** Con trỏ trang sau (Mới nhất / Đang theo dõi: id bài cuối; Dành cho bạn: số trang) */
  next: string | null;
}

/* --- hàng chờ kiểm duyệt --- */

export interface SquareModAuthorDTO extends SquareAuthorDTO {
  userId: string;
  activeStrikes: number;
  banned: boolean;
}

export interface SquareQueueItemDTO {
  type: 'POST' | 'COMMENT' | 'PROFILE';
  id: string;
  postId: number | null;
  author: SquareModAuthorDTO;
  body: string;
  status: SquareStatus | 'ACTIVE';
  hits: ModHit[];
  createdAt: string;
  reports: { count: number; reasons: Partial<Record<SquareReportReason, number>>; notes: string[]; ids: number[] } | null;
  appeal: { note: string; at: string; removedBy: string | null; rule: ModRule | null; removedNote: string | null } | null;
}

export interface SquareModUserDTO extends SquareModAuthorDTO {
  bio: string;
  joinedAt: string;
  banUntil: string | null;
  banPermanent: boolean;
  banReason: string | null;
  strikes: (SquareStrikeDTO & { by: string })[];
  posts: number;
  removedPosts: number;
  flagPermanent: boolean;
}

/* ---------------------------------- tiêu chuẩn cộng đồng ---------------------------------- */

export const SQUARE_GUIDELINES: { title: string; items: string[] }[] = [
  {
    title: 'Tôn trọng',
    items: [
      'Tranh luận về ý kiến, không công kích cá nhân, không chửi bới, không dùng từ ngữ tục tĩu.',
      'Không phân biệt vùng miền, giới tính, tôn giáo, dân tộc.',
      'Không đăng nội dung người lớn, cờ bạc, cá độ, chất cấm.',
    ],
  },
  {
    title: 'An toàn tài sản',
    items: [
      'Không đăng số điện thoại, email, số tài khoản ngân hàng, số giấy tờ, địa chỉ ví, seed phrase hay khoá bí mật — kể cả của chính bạn.',
      'Không rủ nhắn tin riêng, vào nhóm Zalo / Telegram, giao dịch hay chuyển tiền ngoài sàn. Mua bán USDT bằng VNĐ chỉ qua chợ P2P của VNCoin.',
      'VNCoin không bao giờ liên hệ qua mạng xã hội để hỏi mật khẩu hay yêu cầu chuyển tiền. Người tự xưng nhân viên / quản trị trong Cộng đồng là mạo danh.',
      'Chỉ dẫn liên kết tới các trang được phép (Binance, CoinMarketCap, CoinGecko, TradingView, VNCoin).',
    ],
  },
  {
    title: 'Thị trường minh bạch',
    items: [
      'Không hô hào cùng mua / bán để kéo giá, không hứa hẹn lợi nhuận, không nhận uỷ thác đầu tư.',
      'Nhận định là quan điểm cá nhân, không phải khuyến nghị đầu tư. Gắn nhãn Tăng / Giảm khi bạn có quan điểm rõ.',
      'Khoe lãi lỗ bằng nút "Chia sẻ lệnh / ROI" — số liệu lấy thẳng từ dữ liệu sàn, có nhãn xác minh. Ảnh chụp hay số tự gõ không được tin cậy.',
    ],
  },
  {
    title: 'Nội dung chất lượng',
    items: [
      'Không spam, không đăng lặp lại, không viết hoa toàn bộ, tối đa 5 thẻ $coin và 5 #chủ đề mỗi bài.',
      'Nội dung chính trị, tôn giáo nhạy cảm sẽ được kiểm duyệt trước khi hiển thị.',
    ],
  },
];

/** Câu mô tả thang phạt theo tham số hiện tại (FE trang Tiêu chuẩn cộng đồng) */
export function describeStrikeLadder(ladder: readonly number[], expiryDays: number): string[] {
  const fmt = (h: number) => (h === 0 ? 'cảnh cáo' : h % 24 === 0 ? `cấm đăng ${h / 24} ngày` : `cấm đăng ${h} giờ`);
  const lines = ladder.map((h, i) => `Lần ${i + 1}${i === ladder.length - 1 ? ' trở đi' : ''}: ${fmt(h)}`);
  return [...lines, `Mỗi vi phạm hết hiệu lực sau ${expiryDays} ngày. Vi phạm nghiêm trọng hoặc lặp lại nhiều lần có thể bị cấm vĩnh viễn.`];
}

