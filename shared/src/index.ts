import { z } from 'zod';

/* ===================== Kiểu dữ liệu chung ===================== */

export type Exchange = 'HOSE' | 'HNX' | 'UPCOM';
export type Side = 'BUY' | 'SELL';
export type OrderType = 'LO' | 'MP' | 'ATO' | 'ATC';
export type OrderStatus = 'PENDING' | 'PARTIAL' | 'FILLED' | 'CANCELLED' | 'EXPIRED' | 'REJECTED';
export type SessionPhase = 'PRE_OPEN' | 'ATO' | 'CONTINUOUS' | 'LUNCH' | 'ATC' | 'PUT_THROUGH' | 'CLOSED';
export type MarketMode = 'SIMULATED_24_7' | 'REAL_HOURS';

export const EXCHANGES: Exchange[] = ['HOSE', 'HNX', 'UPCOM'];

export interface BookLevel {
  p: number; // giá (VNĐ)
  v: number; // khối lượng (cổ phiếu)
}

/** Thông tin tĩnh của 1 mã */
export interface StockInfo {
  symbol: string;
  exchange: Exchange;
  name: string;
  industry: string;
  listedShares: number;
  eps: number;
  bvps: number;
  isVn30: boolean;
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
  createdAt: string;
  updatedAt: string;
}

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

export interface LedgerDTO {
  id: number;
  type: 'DEPOSIT' | 'BUY' | 'SELL' | 'FEE' | 'TAX' | 'RESET';
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
  /** Lô chẵn */
  lotSize: 100,
  /** Khối lượng tối đa mỗi lệnh */
  maxOrderQty: { HOSE: 500_000, HNX: 1_000_000, UPCOM: 1_000_000 } as Record<Exchange, number>,
  /** Phí giao dịch mỗi chiều */
  feeRate: 0.0015,
  /** Thuế TNCN khi bán */
  sellTaxRate: 0.001,
  /** Vốn ảo cấp khi mở tài khoản */
  initialCapital: 1_000_000_000,
  /** Loại lệnh cho phép theo sàn */
  orderTypes: {
    HOSE: ['LO', 'MP', 'ATO', 'ATC'],
    HNX: ['LO', 'MP', 'ATC'],
    UPCOM: ['LO'],
  } as Record<Exchange, OrderType[]>,
};

/** Bước giá theo sàn và vùng giá */
export function tickSize(exchange: Exchange, price: number): number {
  if (exchange === 'HOSE') {
    if (price < 10_000) return 10;
    if (price < 50_000) return 50;
    return 100;
  }
  return 100;
}

export function isValidTick(exchange: Exchange, price: number): boolean {
  return Number.isInteger(price) && price > 0 && price % tickSize(exchange, price) === 0;
}

export function roundToTick(exchange: Exchange, price: number, mode: 'down' | 'up' | 'nearest' = 'nearest'): number {
  const t = tickSize(exchange, price);
  const n = price / t;
  const r = mode === 'down' ? Math.floor(n) : mode === 'up' ? Math.ceil(n) : Math.round(n);
  return Math.max(t, r * t);
}

/** Giá trần / sàn từ giá tham chiếu */
export function priceBand(exchange: Exchange, ref: number): { ceil: number; floor: number } {
  const pct = RULES.priceLimitPct[exchange];
  const rawCeil = (ref * (100 + pct)) / 100;
  const rawFloor = (ref * (100 - pct)) / 100;
  let ceil = roundToTick(exchange, rawCeil, 'down');
  let floor = roundToTick(exchange, rawFloor, 'up');
  if (ceil <= ref) ceil = ref + tickSize(exchange, ref);
  if (floor >= ref) floor = Math.max(tickSize(exchange, ref), ref - tickSize(exchange, ref));
  return { ceil, floor };
}

export function stepPrice(exchange: Exchange, price: number, dir: 1 | -1): number {
  if (dir === 1) return price + tickSize(exchange, price);
  const below = price - 1;
  return Math.max(tickSize(exchange, below), price - tickSize(exchange, below));
}

export function calcFee(value: number): number {
  return Math.round(value * RULES.feeRate);
}

export function calcSellTax(value: number): number {
  return Math.round(value * RULES.sellTaxRate);
}

/** Số tiền cần phong toả cho lệnh mua */
export function buyHoldAmount(price: number, qty: number): number {
  const value = price * qty;
  return value + calcFee(value);
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

export const placeOrderSchema = z
  .object({
    symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,10}$/, 'Mã chứng khoán không hợp lệ'),
    side: z.enum(['BUY', 'SELL']),
    orderType: z.enum(['LO', 'MP', 'ATO', 'ATC']),
    price: z.number().int('Giá phải là số nguyên (VNĐ)').positive('Giá phải lớn hơn 0').nullable().optional(),
    qty: z.number().int('Khối lượng phải là số nguyên').positive('Khối lượng phải lớn hơn 0'),
  })
  .strict()
  .refine((o) => o.orderType !== 'LO' || (o.price != null && o.price > 0), {
    message: 'Lệnh LO phải có giá',
    path: ['price'],
  });

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
