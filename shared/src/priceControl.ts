import { z } from 'zod';
import { isDecString } from './decimal';
import type { PriceMode, SymbolStatus } from './market';

/*
 * Chế độ giá từng cặp do quản trị viên chọn:
 *   LIVE   — giá thực tế: giá, sổ lệnh, giao dịch lấy từ Binance (mất kết nối thì giả lập tạm)
 *   MANUAL — giá điều chỉnh: sàn tự sinh giá theo giá / kịch bản quản trị viên đặt, lệnh khớp theo giá đó
 * Mọi lần chuyển chế độ / đặt giá đều có lý do và ghi nhật ký quản trị; nhà đầu tư thấy nhãn "Giá điều chỉnh".
 */

export const PRICE_MODE_LABEL: Record<PriceMode, string> = {
  LIVE: 'Giá thực tế (Binance)',
  MANUAL: 'Giá điều chỉnh',
};

/** Kịch bản giá điều chỉnh: đi từ `from` tới `to` trong khoảng [startAt, endAt] (ms), dao động ngẫu nhiên quanh đường giá */
export interface PriceControl {
  /** Thời điểm cặp bắt đầu chế độ điều chỉnh (ms) */
  since: number;
  from: string;
  to: string;
  startAt: number;
  /** = startAt khi đặt giá ngay lập tức */
  endAt: number;
  /** Biên dao động ngẫu nhiên quanh đường giá (%), 0 = giá đứng yên */
  volatilityPct: number;
}

export const PRICE_MAX_DURATION_MIN = 24 * 60;
export const PRICE_MAX_VOLATILITY_PCT = 5;
export const PRICE_DEFAULT_VOLATILITY_PCT = 0.2;
/** Thay đổi lớn hơn mức này (so với giá hiện tại) phải xác nhận lại trên giao diện */
export const PRICE_LARGE_MOVE_PCT = 20;

/** Giá trên đường kịch bản tại `now` — nội suy theo hàm mũ để % thay đổi đều theo thời gian */
export function priceOnPath(c: Pick<PriceControl, 'from' | 'to' | 'startAt' | 'endAt'>, now: number): number {
  const from = Number(c.from);
  const to = Number(c.to);
  if (now >= c.endAt || c.endAt <= c.startAt || !(from > 0) || !(to > 0)) return to;
  if (now <= c.startAt) return from;
  return from * Math.pow(to / from, (now - c.startAt) / (c.endAt - c.startAt));
}

/** Tiến độ kịch bản 0..1 (1 = đã tới giá đích) */
export function pathProgress(c: Pick<PriceControl, 'startAt' | 'endAt'>, now: number): number {
  if (c.endAt <= c.startAt || now >= c.endAt) return 1;
  return Math.max(0, (now - c.startAt) / (c.endAt - c.startAt));
}

/* ---------------------------- schema đầu vào ---------------------------- */

const reason = z.string().trim().min(3, 'Lý do tối thiểu 3 ký tự').max(200, 'Lý do tối đa 200 ký tự');
const volatilityPct = z
  .number()
  .min(0, 'Dao động không được âm')
  .max(PRICE_MAX_VOLATILITY_PCT, `Dao động tối đa ${PRICE_MAX_VOLATILITY_PCT}%`);

/** Đặt giá / chạy kịch bản: durationMin = 0 → nhảy giá ngay */
export const priceSetSchema = z
  .object({
    price: z
      .union([z.string(), z.number()])
      .transform((v) => (typeof v === 'number' ? v.toString() : v.trim()))
      .refine((s) => isDecString(s) && Number(s) > 0, 'Giá phải là số dương (tối đa 18 chữ số lẻ)'),
    durationMin: z.number().int('Thời gian tính bằng phút').min(0).max(PRICE_MAX_DURATION_MIN, 'Kịch bản tối đa 24 giờ').default(0),
    volatilityPct: volatilityPct.default(PRICE_DEFAULT_VOLATILITY_PCT),
    reason,
  })
  .strict();
export type PriceSetInput = z.infer<typeof priceSetSchema>;

/** Chuyển sang giá điều chỉnh (giữ giá hiện tại) hoặc về giá thực tế */
export const priceModeSchema = z.object({ reason, volatilityPct: volatilityPct.optional() }).strict();

/* ---------------------------- dữ liệu trả về ---------------------------- */

export interface AdminPriceRow {
  symbol: string;
  name: string;
  baseAsset: string;
  quoteAsset: string;
  status: SymbolStatus;
  tickSize: string;
  minPrice: string;
  maxPrice: string;
  mode: PriceMode;
  /** Giá đang dùng trên sàn */
  last: string | null;
  /** Giá Binance gần nhất (vẫn theo dõi khi cặp đang ở giá điều chỉnh) */
  ref: string | null;
  /** Chênh lệch giá trên sàn so với Binance (%) */
  diffPct: number | null;
  control: (PriceControl & { reason: string; by: string; progress: number; pathPrice: string }) | null;
}

export interface PriceHistoryItem {
  id: number;
  action: string;
  adminEmail: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export const PRICE_ACTION_LABEL: Record<string, string> = {
  PRICE_MODE_MANUAL: 'Chuyển sang giá điều chỉnh',
  PRICE_SET: 'Đặt giá / kịch bản',
  PRICE_MODE_LIVE: 'Về giá thực tế',
};
