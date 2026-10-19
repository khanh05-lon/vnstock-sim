import { z } from 'zod';
import { Big, roundDp, type Dec } from './decimal';

/* =====================================================================================
 * Chợ P2P và thương nhân (theo Binance P2P / OKX P2P)
 *
 * - Thương nhân (merchant) là KHÁCH HÀNG đã được sàn duyệt, có tiền cọc USDT, được đăng quảng cáo.
 *   Không phải vai trò nhân viên: users.role vẫn là USER, trạng thái nằm ở bảng p2p_merchants.
 * - Quảng cáo theo góc nhìn thương nhân: SELL = thương nhân bán coin (khách MUA), BUY = thương nhân mua coin (khách BÁN).
 * - Coin của bên bán nằm trong ký quỹ (escrow) suốt đơn; tiền VNĐ đi qua ngân hàng giả lập bên ngoài sàn,
 *   sàn không tự kiểm tra được nên bên bán phải tự xác nhận đã nhận tiền rồi mới nhả coin.
 * ===================================================================================== */

export const P2P_ASSETS = ['USDT', 'BTC', 'ETH', 'BNB'] as const;
export type P2PAsset = (typeof P2P_ASSETS)[number];
export const P2P_FIAT = 'VND';

/** Số chữ số lẻ của khối lượng coin trên chợ P2P */
export const P2P_ASSET_DP: Record<P2PAsset, number> = { USDT: 2, BTC: 6, ETH: 5, BNB: 4 };

export const P2P_PAY_MINUTES = [15, 30, 45, 60] as const;

/** Nhãn ngân hàng của phương thức thanh toán (mọi phương thức đều nhận tiền vào tài khoản ngân hàng giả lập) */
export const BANK_NAMES = ['Vietcombank', 'Techcombank', 'MB Bank', 'ACB', 'BIDV', 'VPBank', 'VietinBank', 'TPBank', 'Sacombank'] as const;
export type BankName = (typeof BANK_NAMES)[number];

/** Tham số P2P — quản trị viên chỉnh lúc chạy (applyP2PRules), lưu ở market_meta key admin.p2pRules */
export const P2P_RULES = {
  /** Tỷ giá tham chiếu 1 USDT = ? VNĐ (giá tham chiếu coin khác = giá USDT của coin × tỷ giá) */
  usdtVnd: '26000' as Dec,
  /** Phí thương nhân (maker), thu bằng coin của đơn. Khách (taker) miễn phí như Binance P2P */
  makerFee: '0.002' as Dec,
  /** Tiền cọc thương nhân (USDT, khoá trong ví) */
  merchantDepositUsdt: '2000' as Dec,
  /** Điều kiện xin làm thương nhân */
  minAccountDays: 3,
  minCompletedOrders: 5,
  /** Tỷ lệ hoàn tất tối thiểu (0..1) trong 30 ngày */
  minCompletionRate: 0.9,
  requireEmailVerified: true,
  require2fa: true,
  /** Số quảng cáo đang mở (online + offline) tối đa của 1 thương nhân */
  maxOpenAds: 10,
  maxPaymentMethods: 5,
  /** Khoảng tỷ lệ giá thả nổi (% giá tham chiếu) */
  floatMinPct: 80,
  floatMaxPct: 120,
  /** Giá quảng cáo phải nằm trong ±priceBandPct % giá tham chiếu */
  priceBandPct: 20,
  /** Giá trị đơn tối thiểu / tối đa (VNĐ) */
  minOrderVnd: 100_000,
  maxOrderVnd: 2_000_000_000,
  /** Khách (taker) huỷ / để hết hạn quá số lần này trong 1 ngày UTC → khoá P2P tới 00:00 UTC */
  takerCancelLimit: 3,
  /** Đơn ở trạng thái "đã thanh toán" bao lâu (phút) thì được khiếu nại */
  appealAfterMinutes: 10,
  /** Hạn mức P2P / ngày UTC theo cấp KYC (tổng tiền các đơn chưa huỷ mà người đó là một bên) */
  kycLevel1DailyVnd: 200_000_000,
  kycLevel2DailyVnd: 2_000_000_000,
  /** Cấp KYC tối thiểu để xin làm thương nhân */
  merchantMinKyc: 2,
  /** Số dư ngân hàng giả lập cấp khi mở / đặt lại tài khoản */
  initialBankVnd: '100000000' as Dec,
};

export type P2PRules = typeof P2P_RULES;
export const DEFAULT_P2P_RULES: P2PRules = JSON.parse(JSON.stringify(P2P_RULES));

const decStr = (msg: string) => z.string().trim().regex(/^\d+(\.\d+)?$/, msg);
const intStr = (msg: string) => z.string().trim().regex(/^\d+$/, msg);

export const p2pRulesPatchSchema = z
  .object({
    usdtVnd: intStr('Tỷ giá không hợp lệ')
      .refine((s) => Number(s) >= 1000 && Number(s) <= 1_000_000, 'Tỷ giá USDT/VNĐ từ 1.000 đến 1.000.000')
      .optional(),
    makerFee: decStr('Phí không hợp lệ').refine((s) => Number(s) <= 0.01, 'Phí thương nhân từ 0 đến 1%').optional(),
    merchantDepositUsdt: decStr('Tiền cọc không hợp lệ').refine((s) => Number(s) <= 1_000_000, 'Tiền cọc tối đa 1.000.000 USDT').optional(),
    minAccountDays: z.number().int().min(0).max(365).optional(),
    minCompletedOrders: z.number().int().min(0).max(10_000).optional(),
    minCompletionRate: z.number().min(0).max(1).optional(),
    requireEmailVerified: z.boolean().optional(),
    require2fa: z.boolean().optional(),
    maxOpenAds: z.number().int().min(1).max(100).optional(),
    priceBandPct: z.number().min(1).max(100).optional(),
    minOrderVnd: z.number().int().min(10_000).max(100_000_000).optional(),
    takerCancelLimit: z.number().int().min(1).max(100).optional(),
    appealAfterMinutes: z.number().int().min(0).max(1440).optional(),
    kycLevel1DailyVnd: z.number().int().min(1_000_000).max(1e13).optional(),
    kycLevel2DailyVnd: z.number().int().min(1_000_000).max(1e14).optional(),
    merchantMinKyc: z.number().int().min(0).max(2).optional(),
    initialBankVnd: intStr('Số dư không hợp lệ')
      .refine((s) => Number(s) <= 1e13, 'Số dư ngân hàng ban đầu quá lớn')
      .optional(),
  })
  .strict();
export type P2PRulesPatch = z.infer<typeof p2pRulesPatchSchema>;

export function applyP2PRules(patch: P2PRulesPatch | Partial<P2PRules> | null | undefined) {
  Object.assign(P2P_RULES, JSON.parse(JSON.stringify(DEFAULT_P2P_RULES)), patch ?? {});
}

/* ------------------------------ giá & khối lượng ------------------------------ */

export type P2PAdSide = 'BUY' | 'SELL';
export type P2PPriceType = 'FIXED' | 'FLOATING';

/** Giá tham chiếu 1 coin theo VNĐ (làm tròn tới đồng) */
export function refPriceVnd(asset: string, assetUsdt: Dec | null, usdtVnd: Dec = P2P_RULES.usdtVnd): Dec | null {
  if (asset === 'USDT') return roundDp(usdtVnd, 0);
  if (!assetUsdt || new Big(assetUsdt).lte(0)) return null;
  return roundDp(new Big(assetUsdt).times(usdtVnd), 0);
}

/** Giá của quảng cáo: cố định, hoặc thả nổi = giá tham chiếu × tỷ lệ % */
export function adPrice(ad: { priceType: P2PPriceType; fixedPrice: Dec | null; floatRatio: Dec | null }, ref: Dec | null): Dec | null {
  if (ad.priceType === 'FIXED') return ad.fixedPrice;
  if (!ref || !ad.floatRatio) return null;
  return roundDp(new Big(ref).times(ad.floatRatio).div(100), 0);
}

/** Giá có nằm trong biên ±priceBandPct % so với tham chiếu không */
export function priceInBand(price: Dec, ref: Dec | null, bandPct = P2P_RULES.priceBandPct): boolean {
  if (!ref) return true;
  const r = new Big(ref);
  const p = new Big(price);
  return p.gte(r.times(100 - bandPct).div(100)) && p.lte(r.times(100 + bandPct).div(100));
}

const dpOf = (asset: string) => P2P_ASSET_DP[asset as P2PAsset] ?? 8;

/** Nhập số tiền VNĐ → số coin (làm tròn xuống theo độ chính xác của coin) */
export function qtyForFiat(fiat: Dec, price: Dec, asset: string): Dec {
  if (new Big(price).lte(0)) return '0';
  return roundDp(new Big(fiat).div(price), dpOf(asset), 'down');
}

/** Nhập số coin → số tiền VNĐ phải trả (làm tròn lên tới đồng) */
export function fiatForQty(qty: Dec, price: Dec): Dec {
  return roundDp(new Big(qty).times(price), 0, 'up');
}

/** Làm tròn số coin theo độ chính xác của coin trên chợ P2P */
export const roundP2PQty = (qty: Dec, asset: string): Dec => roundDp(qty, dpOf(asset), 'down');

/** Hạn mức thực tế của 1 đơn: [min, min(max, khả dụng × giá)] */
export function effectiveLimits(ad: { minFiat: Dec; maxFiat: Dec; availableQty: Dec }, price: Dec): { min: Dec; max: Dec } {
  const cap = roundDp(new Big(ad.availableQty).times(price), 0, 'down');
  const max = new Big(ad.maxFiat).lt(cap) ? ad.maxFiat : cap;
  return { min: ad.minFiat, max };
}

/** Kiểm tra số tiền một đơn so với hạn mức quảng cáo; trả về thông báo lỗi hoặc null */
export function validateP2POrderAmount(fiat: Dec, qty: Dec, ad: { minFiat: Dec; maxFiat: Dec; availableQty: Dec }, price: Dec): string | null {
  if (new Big(qty).lte(0)) return 'Số lượng coin phải lớn hơn 0';
  const { min, max } = effectiveLimits(ad, price);
  if (new Big(max).lt(min)) return 'Quảng cáo không còn đủ số lượng';
  if (new Big(fiat).lt(min)) return `Số tiền tối thiểu ${fmtVnd(min)}`;
  if (new Big(fiat).gt(max)) return `Số tiền tối đa ${fmtVnd(max)}`;
  if (new Big(qty).gt(ad.availableQty)) return 'Vượt quá số lượng còn lại của quảng cáo';
  return null;
}

/** 1234567 → "1.234.567 ₫" */
export function fmtVnd(v: Dec | number): string {
  return `${Number(v).toLocaleString('vi-VN', { maximumFractionDigits: 0 })} ₫`;
}

/* ------------------------------ trạng thái ------------------------------ */

export type P2PAdStatus = 'ONLINE' | 'OFFLINE' | 'CLOSED';
export type P2POrderStatus = 'PENDING_PAYMENT' | 'PAID' | 'APPEAL' | 'COMPLETED' | 'CANCELLED';
export type MerchantStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'REJECTED' | 'RESIGNED';
export type P2PCancelBy = 'BUYER' | 'SYSTEM' | 'STAFF';
export type AppealReason = 'NOT_RECEIVED' | 'NOT_RELEASED' | 'WRONG_AMOUNT' | 'OTHER';
export type AppealResolution = 'RELEASED' | 'RETURNED';

export const P2P_ORDER_STATUS_LABEL: Record<P2POrderStatus, string> = {
  PENDING_PAYMENT: 'Chờ thanh toán',
  PAID: 'Đã thanh toán, chờ nhả coin',
  APPEAL: 'Đang khiếu nại',
  COMPLETED: 'Hoàn tất',
  CANCELLED: 'Đã huỷ',
};

export const MERCHANT_STATUS_LABEL: Record<MerchantStatus, string> = {
  PENDING: 'Chờ duyệt',
  ACTIVE: 'Thương nhân đã xác minh',
  SUSPENDED: 'Tạm ngừng',
  REJECTED: 'Bị từ chối',
  RESIGNED: 'Đã nghỉ',
};

export const APPEAL_REASON_LABEL: Record<AppealReason, string> = {
  NOT_RECEIVED: 'Chưa nhận được tiền',
  NOT_RELEASED: 'Đã thanh toán nhưng chưa nhận coin',
  WRONG_AMOUNT: 'Số tiền chuyển không đúng',
  OTHER: 'Lý do khác',
};

export const isP2POrderOpen = (s: P2POrderStatus) => s === 'PENDING_PAYMENT' || s === 'PAID' || s === 'APPEAL';

/* ------------------------------ DTO ------------------------------ */

export interface MerchantStats {
  /** Số đơn hoàn tất 30 ngày */
  orders30d: number;
  /** Hoàn tất / (hoàn tất + huỷ do phía này) trong 30 ngày; null khi chưa có đơn */
  completionRate30d: number | null;
  /** Thời gian nhả coin trung bình (giây) khi là bên bán */
  avgReleaseSec: number | null;
  /** Thời gian thanh toán trung bình (giây) khi là bên mua */
  avgPaySec: number | null;
  /** Tổng đơn hoàn tất từ trước tới nay */
  totalCompleted: number;
}

export interface P2PTraderDTO extends MerchantStats {
  userId: string;
  name: string;
  /** Thương nhân đã xác minh (huy hiệu) */
  verified: boolean;
}

export interface PaymentMethodDTO {
  id: number;
  bankName: string;
  accountNo: string;
  holderName: string;
}

export interface P2PAdDTO {
  id: number;
  merchant: P2PTraderDTO;
  side: P2PAdSide;
  asset: P2PAsset;
  fiat: 'VND';
  priceType: P2PPriceType;
  fixedPrice: Dec | null;
  floatRatio: Dec | null;
  /** Giá hiện tại (VNĐ / 1 coin); null khi chưa có giá tham chiếu */
  price: Dec | null;
  totalQty: Dec;
  availableQty: Dec;
  minFiat: Dec;
  maxFiat: Dec;
  /** Hạn mức thực tế theo số lượng còn lại */
  limitMin: Dec;
  limitMax: Dec;
  payMinutes: number;
  /** Ngân hàng nhận tiền (chỉ tên ngân hàng; số tài khoản chỉ hiện trong đơn) */
  banks: string[];
  /** Chỉ chủ quảng cáo nhận được: id phương thức thanh toán */
  paymentMethodIds?: number[];
  terms: string;
  minAccountDays: number;
  makerFee: Dec;
  status: P2PAdStatus;
  createdAt: string;
}

export interface P2POrderDTO {
  id: number;
  adId: number;
  asset: P2PAsset;
  /** Theo góc nhìn người đang xem */
  side: 'BUY' | 'SELL';
  /** Người đang xem là thương nhân (maker) hay khách (taker); null với nhân viên */
  role: 'MAKER' | 'TAKER' | null;
  price: Dec;
  qty: Dec;
  fiatAmount: Dec;
  /** Phí thương nhân (coin) */
  fee: Dec;
  status: P2POrderStatus;
  payMinutes: number;
  payDeadline: string;
  paidAt: string | null;
  releasedAt: string | null;
  cancelledAt: string | null;
  cancelledBy: P2PCancelBy | null;
  cancelReason: string | null;
  /** Thời điểm được phép khiếu nại (khi đã thanh toán) */
  appealAvailableAt: string | null;
  appeal: {
    by: 'BUYER' | 'SELLER';
    reason: AppealReason;
    description: string;
    at: string;
    resolution: AppealResolution | null;
    resolvedBy: string | null;
    resolvedAt: string | null;
    note: string | null;
  } | null;
  buyer: { id: string; name: string };
  seller: { id: string; name: string };
  maker: P2PTraderDTO;
  /** Tài khoản nhận tiền của bên bán */
  paymentMethod: { bankName: string; accountNo: string; holderName: string };
  terms: string;
  createdAt: string;
  updatedAt: string;
}

export interface P2PMessageDTO {
  id: number;
  orderId: number;
  kind: 'USER' | 'SYSTEM' | 'STAFF';
  senderId: string | null;
  senderName: string;
  body: string;
  createdAt: string;
}

export interface MerchantRequirement {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface MyMerchantDTO {
  status: MerchantStatus | null;
  depositUsdt: Dec;
  appliedAt: string | null;
  reviewedAt: string | null;
  note: string | null;
  stats: MerchantStats;
  requirements: MerchantRequirement[];
  /** Đủ mọi điều kiện để nộp đơn */
  eligible: boolean;
  /** Bị khoá P2P (huỷ quá nhiều) tới thời điểm này */
  blockedUntil: string | null;
  cancelsToday: number;
}

export interface MerchantAdminDTO {
  userId: string;
  email: string;
  name: string;
  status: MerchantStatus;
  depositUsdt: Dec;
  appliedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  note: string | null;
  openAds: number;
  openOrders: number;
  stats: MerchantStats;
  requirements: MerchantRequirement[];
}

export interface BankAccountDTO {
  accountNo: string;
  holderName: string;
  bankName: string;
  balanceVnd: Dec;
}

export interface BankTransferDTO {
  id: number;
  direction: 'IN' | 'OUT';
  counterpartyAccount: string;
  counterpartyName: string;
  amount: Dec;
  memo: string;
  createdAt: string;
}

export interface P2PConfigDTO {
  rules: P2PRules;
  assets: readonly P2PAsset[];
  /** Giá tham chiếu VNĐ hiện tại theo coin */
  refPrices: Record<string, Dec | null>;
}

/* ------------------------------ schema ------------------------------ */

const amountField = (msg: string) =>
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, msg)
    .refine((s) => Number(s) > 0, msg);
const vndField = (msg: string) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, msg)
    .refine((s) => Number(s) > 0, msg);

export const createAdSchema = z
  .object({
    side: z.enum(['BUY', 'SELL']),
    asset: z.enum(P2P_ASSETS),
    priceType: z.enum(['FIXED', 'FLOATING']),
    fixedPrice: vndField('Giá cố định phải là số nguyên VNĐ dương').nullable().optional(),
    floatRatio: z
      .string()
      .trim()
      .regex(/^\d+(\.\d{1,2})?$/, 'Tỷ lệ thả nổi không hợp lệ')
      .nullable()
      .optional(),
    totalQty: amountField('Tổng số lượng phải lớn hơn 0'),
    minFiat: vndField('Hạn mức tối thiểu phải là số nguyên VNĐ dương'),
    maxFiat: vndField('Hạn mức tối đa phải là số nguyên VNĐ dương'),
    payMinutes: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)]),
    paymentMethodIds: z.array(z.number().int().positive()).min(1, 'Chọn ít nhất 1 phương thức thanh toán').max(5, 'Tối đa 5 phương thức thanh toán'),
    terms: z.string().trim().max(500, 'Điều khoản tối đa 500 ký tự').default(''),
    minAccountDays: z.number().int().min(0).max(365).default(0),
    online: z.boolean().default(true),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.priceType === 'FIXED' && !v.fixedPrice) ctx.addIssue({ code: 'custom', path: ['fixedPrice'], message: 'Nhập giá cố định' });
    if (v.priceType === 'FLOATING' && !v.floatRatio) ctx.addIssue({ code: 'custom', path: ['floatRatio'], message: 'Nhập tỷ lệ thả nổi' });
    if (Number(v.maxFiat) < Number(v.minFiat)) ctx.addIssue({ code: 'custom', path: ['maxFiat'], message: 'Hạn mức tối đa phải ≥ tối thiểu' });
  });
export type CreateAdInput = z.infer<typeof createAdSchema>;

/** Sửa quảng cáo: không đổi chiều, coin, tổng số lượng (muốn đổi thì đóng và đăng quảng cáo mới) */
export const updateAdSchema = z
  .object({
    priceType: z.enum(['FIXED', 'FLOATING']).optional(),
    fixedPrice: vndField('Giá cố định phải là số nguyên VNĐ dương').nullable().optional(),
    floatRatio: z
      .string()
      .trim()
      .regex(/^\d+(\.\d{1,2})?$/, 'Tỷ lệ thả nổi không hợp lệ')
      .nullable()
      .optional(),
    minFiat: vndField('Hạn mức tối thiểu không hợp lệ').optional(),
    maxFiat: vndField('Hạn mức tối đa không hợp lệ').optional(),
    payMinutes: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)]).optional(),
    paymentMethodIds: z.array(z.number().int().positive()).min(1).max(5).optional(),
    terms: z.string().trim().max(500).optional(),
    minAccountDays: z.number().int().min(0).max(365).optional(),
  })
  .strict();
export type UpdateAdInput = z.infer<typeof updateAdSchema>;

export const placeP2POrderSchema = z
  .object({
    adId: z.number().int().positive(),
    /** Nhập theo tiền VNĐ hoặc theo số coin (một trong hai) */
    fiatAmount: vndField('Số tiền phải là số nguyên VNĐ dương').optional(),
    qty: amountField('Số lượng coin phải lớn hơn 0').optional(),
    /** Khách bán coin (quảng cáo BUY): tài khoản nhận tiền của khách */
    paymentMethodId: z.number().int().positive().optional(),
  })
  .strict()
  .refine((v) => !!v.fiatAmount !== !!v.qty, { message: 'Nhập số tiền VNĐ hoặc số lượng coin' });
export type PlaceP2POrderInput = z.infer<typeof placeP2POrderSchema>;

export const appealSchema = z
  .object({
    reason: z.enum(['NOT_RECEIVED', 'NOT_RELEASED', 'WRONG_AMOUNT', 'OTHER']),
    description: z.string().trim().min(10, 'Mô tả tối thiểu 10 ký tự').max(1000, 'Mô tả tối đa 1000 ký tự'),
  })
  .strict();

export const resolveAppealSchema = z
  .object({
    outcome: z.enum(['RELEASE', 'RETURN']),
    note: z.string().trim().min(5, 'Ghi rõ căn cứ phân xử (tối thiểu 5 ký tự)').max(1000),
    /** Trừ tiền cọc của thương nhân có lỗi để bồi thường bên kia (USDT) */
    penaltyUsdt: amountField('Số tiền trừ cọc không hợp lệ').optional(),
  })
  .strict();

export const p2pMessageSchema = z.object({ body: z.string().trim().min(1, 'Nhập nội dung').max(1000, 'Tin nhắn tối đa 1000 ký tự') }).strict();

/** Tên chủ tài khoản lấy theo họ tên KYC (chính chủ), không cho tự nhập */
export const paymentMethodSchema = z.object({ bankName: z.enum(BANK_NAMES) }).strict();

export const bankTransferSchema = z
  .object({
    toAccountNo: z.string().trim().regex(/^\d{10}$/, 'Số tài khoản gồm 10 chữ số'),
    amount: vndField('Số tiền phải là số nguyên VNĐ dương'),
    memo: z.string().trim().max(100, 'Nội dung tối đa 100 ký tự').default(''),
  })
  .strict();

export const merchantReviewSchema = z.object({ note: z.string().trim().max(500).default('') }).strict();
export const merchantSuspendSchema = z.object({ reason: z.string().trim().min(5, 'Ghi lý do (tối thiểu 5 ký tự)').max(500) }).strict();
export const depositPenaltySchema = z
  .object({
    amountUsdt: amountField('Số tiền không hợp lệ'),
    reason: z.string().trim().min(5, 'Ghi lý do (tối thiểu 5 ký tự)').max(500),
    /** Bồi thường cho người dùng này (vd. bên bị thiệt trong khiếu nại); trống = thu về sàn */
    compensateUserId: z.string().uuid().optional(),
  })
  .strict();
