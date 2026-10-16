import { z } from 'zod';
import { isDecString, type Dec } from './decimal';

/* ===================== Lệnh Spot (theo Binance Spot API) ===================== */

export type Side = 'BUY' | 'SELL';

/**
 * LIMIT            lệnh giới hạn (kèm TIF)
 * MARKET           lệnh thị trường: theo khối lượng coin (quantity) hoặc theo số tiền (quoteOrderQty)
 * LIMIT_MAKER      lệnh giới hạn chỉ làm maker (post-only): bị từ chối nếu khớp ngay
 * STOP_LOSS_LIMIT  cắt lỗ: bán khi giá ≤ stopPrice / mua khi giá ≥ stopPrice → đặt lệnh LIMIT
 * TAKE_PROFIT_LIMIT chốt lời: bán khi giá ≥ stopPrice / mua khi giá ≤ stopPrice → đặt lệnh LIMIT
 */
export type OrderType = 'LIMIT' | 'MARKET' | 'LIMIT_MAKER' | 'STOP_LOSS_LIMIT' | 'TAKE_PROFIT_LIMIT';
export const ORDER_TYPES: OrderType[] = ['LIMIT', 'MARKET', 'LIMIT_MAKER', 'STOP_LOSS_LIMIT', 'TAKE_PROFIT_LIMIT'];

/** GTC còn hiệu lực tới khi huỷ; IOC khớp ngay phần có thể, huỷ phần còn lại; FOK khớp toàn bộ ngay hoặc huỷ */
export type TimeInForce = 'GTC' | 'IOC' | 'FOK';

export type OrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'REJECTED';
export const OPEN_STATUSES: OrderStatus[] = ['NEW', 'PARTIALLY_FILLED'];

export const isAlgoType = (t: OrderType) => t === 'STOP_LOSS_LIMIT' || t === 'TAKE_PROFIT_LIMIT';

/** Lệnh dừng đã đủ điều kiện kích hoạt chưa (so với giá khớp gần nhất) */
export function stopTriggered(type: OrderType, side: Side, stopPrice: number, last: number): boolean {
  if (type === 'STOP_LOSS_LIMIT') return side === 'SELL' ? last <= stopPrice : last >= stopPrice;
  if (type === 'TAKE_PROFIT_LIMIT') return side === 'SELL' ? last >= stopPrice : last <= stopPrice;
  return false;
}

export interface OrderDTO {
  id: number;
  clientOrderId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  timeInForce: TimeInForce | null;
  price: Dec | null;
  stopPrice: Dec | null;
  origQty: Dec;
  executedQty: Dec;
  /** Tổng giá trị đã khớp theo tài sản định giá */
  cummulativeQuoteQty: Dec;
  /** Lệnh MARKET đặt theo số tiền */
  origQuoteOrderQty: Dec | null;
  /** Giá khớp trung bình ("0" khi chưa khớp) */
  avgPrice: Dec;
  status: OrderStatus;
  /** Lệnh dừng đã kích hoạt / lệnh đang nằm trên sổ */
  isWorking: boolean;
  orderListId: number | null;
  /** Lý do từ chối / hết hiệu lực / huỷ do hệ thống */
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type OrderListStatus = 'EXECUTING' | 'ALL_DONE';

/** Danh sách lệnh OCO (one-cancels-the-other) */
export interface OrderListDTO {
  id: number;
  symbol: string;
  side: Side;
  status: OrderListStatus;
  orders: OrderDTO[];
  createdAt: string;
}

/** Một lần khớp lệnh */
export interface FillDTO {
  id: number;
  orderId: number;
  symbol: string;
  side: Side;
  price: Dec;
  qty: Dec;
  quoteQty: Dec;
  commission: Dec;
  commissionAsset: string;
  isMaker: boolean;
  /** Lãi / lỗ đã thực hiện (USDT) theo giá vốn bình quân — chỉ có ở lệnh bán */
  realizedPnl: Dec | null;
  time: string;
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  NEW: 'Đang chờ',
  PARTIALLY_FILLED: 'Khớp một phần',
  FILLED: 'Đã khớp',
  CANCELED: 'Đã huỷ',
  EXPIRED: 'Hết hiệu lực',
  REJECTED: 'Từ chối',
};

export const ORDER_TYPE_LABEL: Record<OrderType, string> = {
  LIMIT: 'Giới hạn',
  MARKET: 'Thị trường',
  LIMIT_MAKER: 'Post-only',
  STOP_LOSS_LIMIT: 'Stop-limit (cắt lỗ)',
  TAKE_PROFIT_LIMIT: 'Stop-limit (chốt lời)',
};

export const TIF_LABEL: Record<TimeInForce, string> = {
  GTC: 'GTC: hiệu lực tới khi huỷ',
  IOC: 'IOC: khớp ngay, huỷ phần còn lại',
  FOK: 'FOK: khớp toàn bộ hoặc huỷ',
};

/* ---------------------------- schema đầu vào ---------------------------- */

export const symbolField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{5,20}$/, 'Cặp giao dịch không hợp lệ');

/** Số thập phân dương dạng chuỗi (nhận cả number để tiện gọi API) */
const decField = (label: string) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === 'number' ? v.toString() : v.trim()))
    .refine((s) => isDecString(s) && Number(s) > 0, `${label} phải là số dương (tối đa 18 chữ số lẻ)`);

export const placeOrderSchema = z
  .object({
    symbol: symbolField,
    side: z.enum(['BUY', 'SELL']),
    type: z.enum(['LIMIT', 'MARKET', 'LIMIT_MAKER', 'STOP_LOSS_LIMIT', 'TAKE_PROFIT_LIMIT']),
    timeInForce: z.enum(['GTC', 'IOC', 'FOK']).optional(),
    price: decField('Giá').optional(),
    stopPrice: decField('Giá kích hoạt').optional(),
    quantity: decField('Khối lượng').optional(),
    quoteOrderQty: decField('Số tiền').optional(),
    clientOrderId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]{1,36}$/, 'clientOrderId chỉ gồm chữ, số và . _ - (tối đa 36 ký tự)')
      .optional(),
  })
  .strict()
  .superRefine((o, ctx) => {
    const need = (field: 'price' | 'stopPrice' | 'quantity', message: string) => {
      if (!o[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
    };
    const forbid = (field: 'price' | 'stopPrice' | 'quoteOrderQty' | 'timeInForce', message: string) => {
      if (o[field] != null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
    };
    switch (o.type) {
      case 'LIMIT':
        need('price', 'Lệnh giới hạn phải có giá');
        need('quantity', 'Nhập khối lượng');
        forbid('stopPrice', 'Lệnh giới hạn không có giá kích hoạt');
        forbid('quoteOrderQty', 'Lệnh giới hạn đặt theo khối lượng');
        break;
      case 'LIMIT_MAKER':
        need('price', 'Lệnh post-only phải có giá');
        need('quantity', 'Nhập khối lượng');
        forbid('timeInForce', 'Lệnh post-only không chọn TIF');
        forbid('stopPrice', 'Lệnh post-only không có giá kích hoạt');
        forbid('quoteOrderQty', 'Lệnh post-only đặt theo khối lượng');
        break;
      case 'MARKET':
        if (!o.quantity === !o.quoteOrderQty) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['quantity'], message: 'Lệnh thị trường nhập khối lượng HOẶC số tiền (một trong hai)' });
        }
        forbid('price', 'Lệnh thị trường không có giá');
        forbid('stopPrice', 'Lệnh thị trường không có giá kích hoạt');
        forbid('timeInForce', 'Lệnh thị trường không chọn TIF');
        break;
      case 'STOP_LOSS_LIMIT':
      case 'TAKE_PROFIT_LIMIT':
        need('price', 'Nhập giá đặt khi kích hoạt');
        need('stopPrice', 'Nhập giá kích hoạt');
        need('quantity', 'Nhập khối lượng');
        forbid('quoteOrderQty', 'Lệnh stop-limit đặt theo khối lượng');
        break;
    }
  });

export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;

/**
 * OCO: chân LIMIT_MAKER (giá `price`) + chân STOP_LOSS_LIMIT (kích hoạt `stopPrice`, đặt `stopLimitPrice`).
 * Bán: price > giá hiện tại > stopPrice (chốt lời phía trên, cắt lỗ phía dưới).
 * Mua: price < giá hiện tại < stopPrice.
 */
export const ocoOrderSchema = z
  .object({
    symbol: symbolField,
    side: z.enum(['BUY', 'SELL']),
    quantity: decField('Khối lượng'),
    price: decField('Giá giới hạn'),
    stopPrice: decField('Giá kích hoạt'),
    stopLimitPrice: decField('Giá đặt khi kích hoạt'),
  })
  .strict();

export type OcoOrderInput = z.infer<typeof ocoOrderSchema>;

/** Sửa lệnh = huỷ và đặt lại (cancel-replace), mất thứ tự hàng đợi */
export const replaceOrderSchema = z
  .object({
    price: decField('Giá').optional(),
    quantity: decField('Khối lượng').optional(),
  })
  .strict()
  .refine((o) => o.price != null || o.quantity != null, { message: 'Không có thay đổi' });

export type ReplaceOrderInput = z.infer<typeof replaceOrderSchema>;
