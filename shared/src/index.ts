import { z } from 'zod';

/* ===================== Kiểu dữ liệu chung ===================== */

export type Exchange = 'HOSE' | 'HNX' | 'UPCOM';
/** Loại chứng khoán: cổ phiếu, chứng chỉ quỹ ETF, chứng quyền có bảo đảm, trái phiếu niêm yết */
export type InstrumentType = 'STOCK' | 'ETF' | 'CW' | 'BOND';
export type Side = 'BUY' | 'SELL';
/**
 * Loại lệnh: LO giới hạn; MP thị trường (HOSE); MTL / MOK / MAK thị trường của HNX; ATO / ATC lệnh phiên định kỳ.
 * MP, MTL: phần chưa khớp chuyển thành LO (giá khớp cuối ± 1 bước giá); MAK: phần chưa khớp bị huỷ;
 * MOK: không khớp được toàn bộ thì huỷ cả lệnh.
 */
export type OrderType = 'LO' | 'MP' | 'MTL' | 'MOK' | 'MAK' | 'ATO' | 'ATC';
export type OrderStatus = 'PENDING' | 'PARTIAL' | 'FILLED' | 'CANCELLED' | 'EXPIRED' | 'REJECTED';
export type SessionPhase = 'PRE_OPEN' | 'ATO' | 'CONTINUOUS' | 'LUNCH' | 'ATC' | 'PUT_THROUGH' | 'CLOSED';
export type MarketMode = 'SIMULATED_24_7' | 'REAL_HOURS';

export const EXCHANGES: Exchange[] = ['HOSE', 'HNX', 'UPCOM'];

export interface BookLevel {
  p: number; // giá (VNĐ)
  v: number; // khối lượng (cổ phiếu)
}

/** Thông tin chứng quyền có bảo đảm (CW) */
export interface WarrantInfo {
  underlying: string;
  issuer: string;
  /** Tỷ lệ chuyển đổi: số CW cho 1 cổ phiếu cơ sở (vd. 2 = 2 CW : 1 CP) */
  ratio: number;
  exercisePrice: number;
  maturityDate: string;
  lastTradingDate: string;
}

/** Thông tin trái phiếu niêm yết */
export interface BondInfo {
  issuer: string;
  parValue: number;
  /** Lãi suất coupon /năm (0.085 = 8,5%) */
  couponRate: number;
  /** Số kỳ trả lãi mỗi năm */
  couponFreq: number;
  issueDate: string;
  maturityDate: string;
}

/** Thông tin tĩnh của 1 mã */
export interface StockInfo {
  symbol: string;
  exchange: Exchange;
  type: InstrumentType;
  name: string;
  industry: string;
  listedShares: number;
  eps: number;
  bvps: number;
  isVn30: boolean;
  /** Tỷ lệ cho vay ký quỹ (0 = không cho vay) */
  marginRatio: number;
  warrant?: WarrantInfo;
  bond?: BondInfo;
}

/** Trạng thái giá realtime của 1 mã */
export interface StockSnapshot {
  symbol: string;
  ref: number;
  ceil: number;
  floor: number;
  open: number;
  high: number;
  low: number;
  last: number;
  lastVol: number;
  change: number;
  changePct: number;
  volume: number;
  value: number;
  bids: BookLevel[];
  asks: BookLevel[];
  foreignBuy: number;
  foreignSell: number;
  updatedAt: number;
}

export type StockRow = StockInfo & StockSnapshot;

export interface IndexSnapshot {
  code: string;
  name: string;
  value: number;
  prevClose: number;
  change: number;
  changePct: number;
  volume: number;
  totalValue: number;
  advances: number;
  declines: number;
  unchanged: number;
  ceilings: number;
  floors: number;
  spark: number[];
}

export interface TradeTick {
  symbol: string;
  time: number;
  price: number;
  vol: number;
  side: 'B' | 'S';
}

export interface Candle {
  time: number; // epoch giây (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SessionInfo {
  mode: MarketMode;
  phase: SessionPhase;
  tradeDate: string;
  serverTime: number;
  /** LIVE = bảng giá lấy từ nguồn thật, SIM = giả lập */
  feed?: 'LIVE' | 'SIM';
}

/** Nguồn lệnh: người dùng đặt, lệnh điều kiện kích hoạt, hệ thống bán giải chấp ký quỹ */
export type OrderSource = 'USER' | 'CONDITIONAL' | 'FORCE_SELL';

export interface OrderDTO {
  id: number;
  symbol: string;
  side: Side;
  orderType: OrderType;
  price: number | null;
  qty: number;
  filledQty: number;
  avgFillPrice: number;
  status: OrderStatus;
  holdAmount: number;
  rejectReason: string | null;
  tradeDate: string;
  /** Lệnh nhiều ngày: còn hiệu lực tới hết ngày này (null = trong ngày) */
  validUntil: string | null;
  source: OrderSource;
  createdAt: string;
  updatedAt: string;
}

export type ConditionalKind = 'STOP' | 'LIMIT_IF_TOUCHED' | 'TRAILING';
export type ConditionalStatus = 'ACTIVE' | 'TRIGGERED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';

export interface ConditionalOrderDTO {
  id: number;
  symbol: string;
  side: Side;
  kind: ConditionalKind;
  triggerPrice: number | null;
  trailPct: number | null;
  /** Đỉnh (bán) / đáy (mua) đang theo dõi của lệnh trailing */
  peakPrice: number | null;
  orderType: 'LO' | 'MARKET';
  limitPrice: number | null;
  qty: number;
  validUntil: string;
  ocoGroup: string | null;
  status: ConditionalStatus;
  orderId: number | null;
  triggeredPrice: number | null;
  message: string | null;
  createdAt: string;
  triggeredAt: string | null;
}

export const CONDITIONAL_STATUS_LABEL: Record<ConditionalStatus, string> = {
  ACTIVE: 'Đang chờ kích hoạt',
  TRIGGERED: 'Đã kích hoạt',
  CANCELLED: 'Đã huỷ',
  EXPIRED: 'Hết hiệu lực',
  FAILED: 'Kích hoạt lỗi',
};

/** Tên gọi quen thuộc theo chiều lệnh */
export function conditionalLabel(kind: ConditionalKind, side: Side): string {
  if (kind === 'TRAILING') return side === 'SELL' ? 'Trailing stop (bán)' : 'Trailing stop (mua)';
  if (kind === 'STOP') return side === 'SELL' ? 'Cắt lỗ' : 'Mua khi giá vượt';
  return side === 'SELL' ? 'Chốt lời' : 'Mua khi giá giảm về';
}

/** Số ngày tối đa của lệnh nhiều ngày / lệnh điều kiện */
export const GTD_MAX_DAYS = 30;
export const CONDITIONAL_MAX_DAYS = 90;

export interface TradeDTO {
  id: number;
  orderId: number;
  symbol: string;
  side: Side;
  price: number;
  qty: number;
  value: number;
  fee: number;
  tax: number;
  realizedPnl: number | null;
  executedAt: string;
}

export interface AccountDTO {
  cashBalance: number;
  cashHold: number;
  cashAvailable: number;
  initialCapital: number;
  /** Vốn đã góp (vốn ban đầu + điều chỉnh) — mốc tính lãi/lỗ */
  contributed?: number;
  /** Tiền bán chờ về (T+2), chưa ứng trước */
  cashPending?: number;
  /** Thực nhận tối đa nếu ứng trước toàn bộ tiền chờ về (đã trừ phí) */
  advanceable?: number;
  autoAdvance?: boolean;
  marginEnabled?: boolean;
  creditLimit?: number;
  /** Dư nợ gốc ký quỹ */
  loanBalance?: number;
  /** Lãi vay cộng dồn chưa trả */
  loanInterest?: number;
  /** Phần vay đang giữ cho lệnh mua chờ khớp */
  loanHold?: number;
  marginStatus?: 'NORMAL' | 'CALL' | 'FORCE';
  /** Tỷ lệ ký quỹ thực tế (null khi không có nợ) */
  marginRatio?: number | null;
  /** Tiền cần nộp thêm để về tỷ lệ ký quỹ ban đầu */
  marginCallAmount?: number;
  /** Lãi tiền gửi tạm tính trong tháng */
  depositInterestAccrued?: number;
  /** Giá trị quyền chờ về (cổ tức, cổ phiếu thưởng...) */
  rightsValue?: number;
}

export interface HoldingDTO {
  symbol: string;
  qtyTotal: number;
  qtyAvailable: number;
  qtyHold: number;
  qtyPending: number;
  totalCost: number;
  avgCost: number;
}

export type LedgerType =
  | 'DEPOSIT'
  | 'BUY'
  | 'SELL'
  | 'FEE'
  | 'TAX'
  | 'RESET'
  | 'ADJUST'
  | 'DELIST'
  | 'DIVIDEND'
  | 'RIGHTS'
  | 'INTEREST'
  | 'LOAN'
  | 'LOAN_REPAY'
  | 'MARGIN_INTEREST'
  | 'ADVANCE'
  | 'ADVANCE_FEE'
  | 'CW_SETTLE'
  | 'COUPON'
  | 'BOND_REDEEM';

export const LEDGER_LABEL: Record<LedgerType, string> = {
  DEPOSIT: 'Nạp vốn',
  BUY: 'Mua CK',
  SELL: 'Bán CK',
  FEE: 'Phí GD',
  TAX: 'Thuế',
  RESET: 'Đặt lại TK',
  ADJUST: 'Điều chỉnh',
  DELIST: 'Huỷ niêm yết',
  DIVIDEND: 'Cổ tức',
  RIGHTS: 'Mua quyền',
  INTEREST: 'Lãi tiền gửi',
  LOAN: 'Giải ngân vay',
  LOAN_REPAY: 'Trả nợ vay',
  MARGIN_INTEREST: 'Lãi vay',
  ADVANCE: 'Ứng trước',
  ADVANCE_FEE: 'Phí ứng trước',
  CW_SETTLE: 'Thanh toán CW',
  COUPON: 'Lãi trái phiếu',
  BOND_REDEEM: 'Đáo hạn TP',
};

export interface LedgerDTO {
  id: number;
  type: LedgerType;
  amount: number;
  balanceAfter: number;
  orderId: number | null;
  note: string | null;
  createdAt: string;
}

/* ===================== Quy tắc nghiệp vụ =====================
 * Tham khảo quy định HOSE/HNX/UPCOM. Cần kiểm tra lại quy định hiện hành
 * trước khi dùng cho mục đích khác ngoài mô phỏng.
 */
export const RULES = {
  /** Biên độ dao động giá (%) */
  priceLimitPct: { HOSE: 7, HNX: 10, UPCOM: 15 } as Record<Exchange, number>,
  /** Biên độ giá trái phiếu niêm yết (%) — tham số mô phỏng */
  bondLimitPct: 10,
  /** Lô chẵn; dưới 1 lô là lô lẻ (chỉ lệnh LO, khớp liên tục) */
  lotSize: 100,
  /** Khối lượng tối đa mỗi lệnh */
  maxOrderQty: { HOSE: 500_000, HNX: 1_000_000, UPCOM: 1_000_000 } as Record<Exchange, number>,
  /** Phí giao dịch mỗi chiều */
  feeRate: 0.0015,
  /** Thuế TNCN khi bán */
  sellTaxRate: 0.001,
  /** Thuế TNCN trên cổ tức / coupon bằng tiền */
  dividendTaxRate: 0.05,
  /** Vốn ảo cấp khi mở tài khoản */
  initialCapital: 1_000_000_000,
  /** Phí ứng trước tiền bán mỗi ngày (0,04%/ngày ≈ 14,6%/năm) */
  advanceFeeRateDaily: 0.0004,
  /** Lãi suất tiền gửi không kỳ hạn trên tiền mặt /năm */
  depositRateYear: 0.005,
  /** Giao dịch ký quỹ */
  margin: {
    /** Lãi vay /năm */
    interestRateYear: 0.13,
    /** Tỷ lệ ký quỹ ban đầu: sau khi mua bằng tiền vay, tài sản ròng / tài sản ≥ ngưỡng này */
    initialRatio: 0.5,
    /** Tỷ lệ duy trì: dưới ngưỡng → cảnh báo (margin call) */
    callRatio: 0.4,
    /** Tỷ lệ xử lý: dưới ngưỡng → hệ thống tự bán giải chấp */
    forceRatio: 0.3,
    /** Hạn mức vay mặc định khi kích hoạt ký quỹ */
    defaultCreditLimit: 1_000_000_000,
  },
  /** Loại lệnh cho phép theo sàn */
  orderTypes: {
    HOSE: ['LO', 'MP', 'ATO', 'ATC'],
    HNX: ['LO', 'MTL', 'MOK', 'MAK', 'ATC'],
    UPCOM: ['LO'],
  } as Record<Exchange, OrderType[]>,
};

/** Lệnh thị trường (không ghi giá, chỉ đặt trong phiên liên tục) */
export const MARKET_ORDER_TYPES: readonly OrderType[] = ['MP', 'MTL', 'MOK', 'MAK'];

export function isMarketOrder(type: OrderType): boolean {
  return MARKET_ORDER_TYPES.includes(type);
}

/**
 * Lệnh thị trường "thông thường" của sàn — phần chưa khớp chuyển thành LO (MP ở HOSE, MTL ở HNX).
 * Dùng cho lệnh điều kiện kiểu "thị trường" và bán giải chấp. UPCOM không có → null.
 */
export function marketOrderTypeFor(exchange: Exchange): 'MP' | 'MTL' | null {
  const types = RULES.orderTypes[exchange];
  return types.includes('MP') ? 'MP' : types.includes('MTL') ? 'MTL' : null;
}

/** Giải thích ngắn từng loại lệnh (hiện trên form đặt lệnh) */
export const ORDER_TYPE_HINT: Record<OrderType, string> = {
  LO: 'Lệnh giới hạn: khớp ở giá đặt hoặc tốt hơn',
  MP: 'Lệnh thị trường HOSE: khớp ngay ở giá tốt nhất, phần còn lại thành LO (giá khớp cuối ± 1 bước giá)',
  MTL: 'Lệnh thị trường giới hạn: khớp ngay ở giá tốt nhất, phần còn lại thành LO (giá khớp cuối ± 1 bước giá)',
  MOK: 'Khớp toàn bộ hoặc huỷ: không khớp được hết khối lượng ngay thì huỷ cả lệnh',
  MAK: 'Khớp và huỷ: khớp ngay phần có thể, phần còn lại bị huỷ',
  ATO: 'Lệnh phiên mở cửa: khớp ở giá mở cửa',
  ATC: 'Lệnh phiên đóng cửa: khớp ở giá đóng cửa',
};

export type TradingRules = typeof RULES;

/** Bản gốc (trước khi quản trị viên chỉnh) — dùng cho nút "khôi phục mặc định" */
export const DEFAULT_RULES: TradingRules = JSON.parse(JSON.stringify(RULES));

const pct = (max: number, msg: string) => z.number().min(0, msg).max(max, msg);

/** Phần quy tắc quản trị viên được chỉnh (lô, loại lệnh theo sàn là quy định cố định) */
export const rulesPatchSchema = z
  .object({
    priceLimitPct: z
      .object({
        HOSE: z.number().min(1).max(30),
        HNX: z.number().min(1).max(30),
        UPCOM: z.number().min(1).max(40),
      })
      .partial()
      .optional(),
    bondLimitPct: z.number().min(1).max(50).optional(),
    maxOrderQty: z
      .object({
        HOSE: z.number().int().min(100).max(10_000_000),
        HNX: z.number().int().min(100).max(10_000_000),
        UPCOM: z.number().int().min(100).max(10_000_000),
      })
      .partial()
      .optional(),
    feeRate: pct(0.01, 'Phí giao dịch từ 0 đến 1%').optional(),
    sellTaxRate: pct(0.01, 'Thuế bán từ 0 đến 1%').optional(),
    dividendTaxRate: pct(0.2, 'Thuế cổ tức từ 0 đến 20%').optional(),
    initialCapital: z.number().int().min(1_000_000).max(1_000_000_000_000).optional(),
    advanceFeeRateDaily: pct(0.002, 'Phí ứng trước từ 0 đến 0,2%/ngày').optional(),
    depositRateYear: pct(0.2, 'Lãi tiền gửi từ 0 đến 20%/năm').optional(),
    margin: z
      .object({
        interestRateYear: pct(0.5, 'Lãi vay từ 0 đến 50%/năm'),
        initialRatio: z.number().min(0.1).max(1),
        callRatio: z.number().min(0.05).max(1),
        forceRatio: z.number().min(0.01).max(1),
        defaultCreditLimit: z.number().int().min(0).max(1_000_000_000_000),
      })
      .partial()
      .optional(),
  })
  .strict();

export type RulesPatch = z.infer<typeof rulesPatchSchema>;

/** Ghép bản chỉnh vào RULES (thay đổi tại chỗ để mọi nơi đang dùng RULES nhận giá trị mới) */
export function applyRules(patch: RulesPatch | Partial<TradingRules> | null | undefined) {
  const p = (patch ?? {}) as Partial<TradingRules>;
  const fresh: TradingRules = JSON.parse(JSON.stringify(DEFAULT_RULES));
  const merged: TradingRules = {
    ...fresh,
    ...p,
    priceLimitPct: { ...fresh.priceLimitPct, ...(p.priceLimitPct ?? {}) },
    maxOrderQty: { ...fresh.maxOrderQty, ...(p.maxOrderQty ?? {}) },
    margin: { ...fresh.margin, ...(p.margin ?? {}) },
    orderTypes: fresh.orderTypes,
    lotSize: fresh.lotSize,
  };
  if (!(merged.margin.forceRatio < merged.margin.callRatio && merged.margin.callRatio <= merged.margin.initialRatio)) {
    throw new Error('Tỷ lệ ký quỹ phải thoả: xử lý < duy trì ≤ ban đầu');
  }
  Object.assign(RULES, merged);
}

/** Sàn + loại chứng khoán (bước giá của ETF, chứng quyền, trái phiếu khác cổ phiếu) */
export type Venue = Exchange | { exchange: Exchange; type?: InstrumentType };

const venueOf = (v: Venue): { exchange: Exchange; type: InstrumentType } =>
  typeof v === 'string' ? { exchange: v, type: 'STOCK' } : { exchange: v.exchange, type: v.type ?? 'STOCK' };

/** Bước giá theo sàn, loại chứng khoán và vùng giá */
export function tickSize(venue: Venue, price: number): number {
  const { exchange, type } = venueOf(venue);
  if (type === 'BOND') return 1;
  if (exchange === 'HOSE') {
    // ETF và chứng quyền trên HOSE: bước giá 10đ ở mọi vùng giá
    if (type === 'ETF' || type === 'CW') return 10;
    if (price < 10_000) return 10;
    if (price < 50_000) return 50;
    return 100;
  }
  return 100;
}

export function isValidTick(venue: Venue, price: number): boolean {
  return Number.isInteger(price) && price > 0 && price % tickSize(venue, price) === 0;
}

export function roundToTick(venue: Venue, price: number, mode: 'down' | 'up' | 'nearest' = 'nearest'): number {
  const t = tickSize(venue, price);
  const n = price / t;
  const r = mode === 'down' ? Math.floor(n) : mode === 'up' ? Math.ceil(n) : Math.round(n);
  return Math.max(t, r * t);
}

/** Giá trần / sàn từ giá tham chiếu (chứng quyền tính theo cổ phiếu cơ sở: xem warrantBand) */
export function priceBand(venue: Venue, ref: number): { ceil: number; floor: number } {
  const { exchange, type } = venueOf(venue);
  const pct = type === 'BOND' ? RULES.bondLimitPct : RULES.priceLimitPct[exchange];
  const rawCeil = (ref * (100 + pct)) / 100;
  const rawFloor = (ref * (100 - pct)) / 100;
  let ceil = roundToTick(venue, rawCeil, 'down');
  let floor = roundToTick(venue, rawFloor, 'up');
  if (ceil <= ref) ceil = ref + tickSize(venue, ref);
  if (floor >= ref) floor = Math.max(tickSize(venue, ref), ref - tickSize(venue, ref));
  return { ceil, floor };
}

/**
 * Biên độ chứng quyền: giá trần/sàn CW = giá tham chiếu CW ± (chênh lệch trần/sàn của cổ phiếu cơ sở) / tỷ lệ chuyển đổi.
 * Giá sàn tối thiểu bằng 1 bước giá.
 */
export function warrantBand(cwRef: number, underlying: { ref: number; ceil: number; floor: number }, ratio: number): { ceil: number; floor: number } {
  const venue: Venue = { exchange: 'HOSE', type: 'CW' };
  const ceil = roundToTick(venue, cwRef + (underlying.ceil - underlying.ref) / ratio, 'down');
  const floor = Math.max(10, roundToTick(venue, cwRef - (underlying.ref - underlying.floor) / ratio, 'up'));
  return { ceil: Math.max(ceil, cwRef + 10), floor: Math.min(floor, Math.max(10, cwRef - 10)) };
}

export function stepPrice(venue: Venue, price: number, dir: 1 | -1): number {
  if (dir === 1) return price + tickSize(venue, price);
  const below = price - 1;
  return Math.max(tickSize(venue, below), price - tickSize(venue, below));
}

/** Lô lẻ: 1–99 cổ phiếu (không áp dụng cho trái phiếu) */
export function isOddLot(qty: number): boolean {
  return qty > 0 && qty < RULES.lotSize;
}

export function calcFee(value: number, rate: number = RULES.feeRate): number {
  return Math.round(value * rate);
}

export function calcSellTax(value: number, rate: number = RULES.sellTaxRate): number {
  return Math.round(value * rate);
}

/** Số tiền cần phong toả cho lệnh mua */
export function buyHoldAmount(price: number, qty: number, feeRate: number = RULES.feeRate): number {
  const value = price * qty;
  return value + calcFee(value, feeRate);
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: 'Chờ khớp',
  PARTIAL: 'Khớp một phần',
  FILLED: 'Đã khớp',
  CANCELLED: 'Đã huỷ',
  EXPIRED: 'Hết hiệu lực',
  REJECTED: 'Từ chối',
};

export const PHASE_LABEL: Record<SessionPhase, string> = {
  PRE_OPEN: 'Chờ mở cửa',
  ATO: 'Phiên ATO',
  CONTINUOUS: 'Khớp lệnh liên tục',
  LUNCH: 'Nghỉ trưa',
  ATC: 'Phiên ATC',
  PUT_THROUGH: 'Thoả thuận',
  CLOSED: 'Đóng cửa',
};

/* ===================== Schema validate (dùng chung FE/BE) ===================== */

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
const otpCode = z
  .string()
  .trim()
  .min(6, 'Nhập mã 6 số hoặc mã khôi phục')
  .max(20, 'Mã không hợp lệ');

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

/** Thông tin người dùng đăng nhập */
export interface UserDTO {
  id: string;
  email: string;
  fullName: string;
  createdAt: string;
  role: 'USER' | 'ADMIN';
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  notifyFills: boolean;
  displayName: string | null;
  showOnLeaderboard: boolean;
}

const symbolField = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,10}$/, 'Mã chứng khoán không hợp lệ');

export const placeOrderSchema = z
  .object({
    symbol: symbolField,
    side: z.enum(['BUY', 'SELL']),
    orderType: z.enum(['LO', 'MP', 'MTL', 'MOK', 'MAK', 'ATO', 'ATC']),
    price: z.number().int('Giá phải là số nguyên (VNĐ)').positive('Giá phải lớn hơn 0').nullable().optional(),
    qty: z.number().int('Khối lượng phải là số nguyên').positive('Khối lượng phải lớn hơn 0'),
    /** Lệnh nhiều ngày (chỉ LO): hiệu lực tới hết ngày này */
    validUntil: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày hiệu lực không hợp lệ')
      .nullable()
      .optional(),
  })
  .strict()
  .refine((o) => o.orderType !== 'LO' || (o.price != null && o.price > 0), {
    message: 'Lệnh LO phải có giá',
    path: ['price'],
  })
  .refine((o) => !o.validUntil || o.orderType === 'LO', { message: 'Chỉ lệnh LO được đặt nhiều ngày', path: ['validUntil'] });

const conditionalLeg = {
  kind: z.enum(['STOP', 'LIMIT_IF_TOUCHED', 'TRAILING']),
  triggerPrice: z.number().int().positive('Giá kích hoạt phải > 0').nullable().optional(),
  trailPct: z.number().min(0.5, 'Biên trailing tối thiểu 0,5%').max(50, 'Biên trailing tối đa 50%').nullable().optional(),
  orderType: z.enum(['LO', 'MARKET']),
  limitPrice: z.number().int().positive('Giá đặt phải > 0').nullable().optional(),
};

export const conditionalOrderSchema = z
  .object({
    symbol: symbolField,
    side: z.enum(['BUY', 'SELL']),
    qty: z.number().int('Khối lượng phải là số nguyên').positive('Khối lượng phải lớn hơn 0'),
    validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày hiệu lực không hợp lệ'),
    ...conditionalLeg,
    /** Lệnh chốt lời đi kèm (OCO): 1 lệnh kích hoạt thì lệnh kia tự huỷ — chỉ đi với lệnh cắt lỗ bán */
    takeProfit: z
      .object({ triggerPrice: z.number().int().positive(), orderType: z.enum(['LO', 'MARKET']), limitPrice: z.number().int().positive().nullable().optional() })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .refine((o) => o.kind === 'TRAILING' || (o.triggerPrice ?? 0) > 0, { message: 'Nhập giá kích hoạt', path: ['triggerPrice'] })
  .refine((o) => o.kind !== 'TRAILING' || (o.trailPct ?? 0) > 0, { message: 'Nhập biên trailing (%)', path: ['trailPct'] })
  .refine((o) => o.orderType === 'MARKET' || (o.limitPrice ?? 0) > 0, { message: 'Nhập giá đặt khi kích hoạt', path: ['limitPrice'] })
  .refine((o) => !o.takeProfit || (o.side === 'SELL' && o.kind === 'STOP'), { message: 'Chốt lời kèm theo chỉ dùng cho lệnh cắt lỗ bán', path: ['takeProfit'] })
  .refine((o) => !o.takeProfit || o.takeProfit.orderType === 'MARKET' || (o.takeProfit.limitPrice ?? 0) > 0, {
    message: 'Nhập giá đặt của lệnh chốt lời',
    path: ['takeProfit'],
  });

export type ConditionalOrderInput = z.infer<typeof conditionalOrderSchema>;

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

export type PriceAlertKind = 'PRICE_ABOVE' | 'PRICE_BELOW' | 'CHANGE_UP' | 'CHANGE_DOWN' | 'VOLUME_ABOVE';
export type PriceAlertStatus = 'ACTIVE' | 'TRIGGERED' | 'CANCELLED';

export const MAX_ACTIVE_ALERTS = 50;

export const PRICE_ALERT_LABEL: Record<PriceAlertKind, string> = {
  PRICE_ABOVE: 'Giá khớp ≥',
  PRICE_BELOW: 'Giá khớp ≤',
  CHANGE_UP: 'Tăng ≥ (% so với tham chiếu)',
  CHANGE_DOWN: 'Giảm ≥ (% so với tham chiếu)',
  VOLUME_ABOVE: 'Tổng khối lượng ≥',
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
  /** Giá (đ) với PRICE_*; phần trăm (vd 3.5) với CHANGE_*; số cổ phiếu với VOLUME_ABOVE */
  value: number;
  note: string | null;
  notifyEmail: boolean;
  status: PriceAlertStatus;
  triggeredPrice: number | null;
  triggeredAt: string | null;
  createdAt: string;
}

export const priceAlertSchema = z
  .object({
    symbol: symbolField,
    kind: z.enum(['PRICE_ABOVE', 'PRICE_BELOW', 'CHANGE_UP', 'CHANGE_DOWN', 'VOLUME_ABOVE']),
    value: z.number().positive('Giá trị phải lớn hơn 0'),
    note: z.string().trim().max(100, 'Ghi chú tối đa 100 ký tự').optional(),
    notifyEmail: z.boolean().optional(),
  })
  .strict()
  .refine((o) => !o.kind.startsWith('CHANGE') || o.value <= 100, { message: 'Phần trăm thay đổi tối đa 100%', path: ['value'] })
  .refine((o) => o.kind.startsWith('CHANGE') || Number.isInteger(o.value), { message: 'Giá / khối lượng phải là số nguyên', path: ['value'] });

export type PriceAlertInput = z.infer<typeof priceAlertSchema>;

/* ===================== Báo cáo lãi lỗ theo tháng ===================== */

export interface MonthlyReportRow {
  /** YYYY-MM (giờ Việt Nam) */
  month: string;
  /** Tổng giá trị khớp mua + bán */
  tradedValue: number;
  /** Lãi / lỗ đã thực hiện của các lần bán (đã trừ phí mua, phí bán, thuế bán) */
  realizedPnl: number;
  fees: number;
  sellTax: number;
  /** Cổ tức tiền + lãi trái phiếu, sau thuế */
  income: number;
  /** Tiền nhận khi chứng quyền / trái phiếu đáo hạn (không phải lãi) */
  maturityProceeds: number;
  depositInterest: number;
  /** Lãi vay ký quỹ đã trả + phí ứng trước tiền bán */
  financingCost: number;
  /** = lãi / lỗ đã thực hiện + cổ tức, lãi TP + lãi tiền gửi − chi phí vốn */
  net: number;
}

export interface MonthlyReportDTO {
  year: number;
  months: MonthlyReportRow[];
  total: Omit<MonthlyReportRow, 'month'>;
  /** Các năm có dữ liệu (để chọn) */
  years: number[];
}

export const modifyOrderSchema = z
  .object({
    price: z.number().int().positive().optional(),
    qty: z.number().int().positive().optional(),
  })
  .strict()
  .refine((o) => o.price != null || o.qty != null, { message: 'Không có thay đổi' });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;
export type ModifyOrderInput = z.infer<typeof modifyOrderSchema>;
