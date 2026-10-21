import { z } from 'zod';
import { Big, roundDp, type Dec } from './decimal';

/* ===================== Biểu phí & tham số sàn =====================
 * Mặc định theo biểu phí Spot của Binance cho người dùng thường (VIP 0): maker 0,1%, taker 0,1%,
 * trả phí bằng BNB được giảm 25%. Quản trị viên chỉnh được lúc chạy (applyRules).
 */
export const RULES = {
  makerFee: '0.001' as Dec,
  takerFee: '0.001' as Dec,
  /** Giảm phí khi trả bằng BNB (0.25 = giảm 25%) */
  bnbDiscount: '0.25' as Dec,
  /** Tài sản dùng để trả phí ưu đãi */
  feeAsset: 'BNB',
  /** Tài sản định giá chính (cấp vốn, quy đổi tổng tài sản) */
  quoteAsset: 'USDT',
  /** Vốn ảo cấp khi mở / đặt lại tài khoản */
  initialUsdt: '10000' as Dec,
  /** Số chữ số lẻ của phí (như commissionPrecision của Binance) */
  commissionPrecision: 8,
};

export type TradingRules = typeof RULES;

/** Bản gốc (trước khi quản trị viên chỉnh) — dùng cho nút "khôi phục mặc định" */
export const DEFAULT_RULES: TradingRules = JSON.parse(JSON.stringify(RULES));

const rate = (max: number, msg: string) =>
  z
    .string()
    .regex(/^\d+(\.\d+)?$/, msg)
    .refine((s) => Number(s) >= 0 && Number(s) <= max, msg);

export const rulesPatchSchema = z
  .object({
    makerFee: rate(0.01, 'Phí maker từ 0 đến 1%').optional(),
    takerFee: rate(0.01, 'Phí taker từ 0 đến 1%').optional(),
    bnbDiscount: rate(0.5, 'Mức giảm phí BNB từ 0 đến 50%').optional(),
    initialUsdt: z
      .string()
      .regex(/^\d+(\.\d+)?$/, 'Vốn ban đầu không hợp lệ')
      .refine((s) => Number(s) >= 10 && Number(s) <= 1e9, 'Vốn ban đầu từ 10 đến 1.000.000.000 USDT')
      .optional(),
  })
  .strict();

export type RulesPatch = z.infer<typeof rulesPatchSchema>;

/** Ghép bản chỉnh vào RULES (thay đổi tại chỗ để mọi nơi đang dùng RULES nhận giá trị mới) */
export function applyRules(patch: RulesPatch | Partial<TradingRules> | null | undefined) {
  const fresh: TradingRules = JSON.parse(JSON.stringify(DEFAULT_RULES));
  Object.assign(RULES, fresh, patch ?? {});
}

/** Phí của 1 lần khớp: amount (tài sản nhận về) × rate, làm tròn lên theo commissionPrecision */
export function commissionOf(amount: Dec, rate: Dec, precision = RULES.commissionPrecision): Dec {
  return roundDp(new Big(amount).times(rate), precision, 'up');
}

/** Tỷ lệ phí áp dụng thực tế khi trả bằng BNB */
export function bnbRate(rate: Dec, discount: Dec = RULES.bnbDiscount): Dec {
  return new Big(rate).times(new Big(1).minus(discount)).toFixed();
}

/**
 * Các cặp mặc định khi khởi tạo sàn (coin vốn hoá lớn, giao dịch với USDT).
 * Quản trị viên thêm / tắt cặp ở trang Quản trị.
 */
export const DEFAULT_SYMBOLS = [
  'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'TRX', 'AVAX', 'LINK',
  'DOT', 'TON', 'SUI', 'NEAR', 'LTC', 'BCH', 'UNI', 'AAVE', 'ATOM', 'APT',
  'ARB', 'OP', 'INJ', 'FIL', 'PEPE', 'SHIB', 'WLD', 'FET', 'HBAR', 'ETC',
  // Thêm đợt 2: mọi cặp đang giao dịch trên Binance Spot, khối lượng ≥ 1 triệu USDT / ngày (đủ sổ lệnh để khớp mô phỏng)
  'ZEC', 'ENA', 'TAO', 'STRK', 'QNT', 'TRUMP', 'ONDO', 'XLM', 'TIA', 'DASH',
  'W', 'ZRO', 'PENGU', 'COMP', 'ICP', 'SEI', 'CRV', 'POL', 'PYTH', 'BAT',
  'RENDER', 'JUP', 'LDO', 'ZK', 'EIGEN', 'ETHFI', 'STX', 'BONK', 'ALGO', 'SAND',
  'RUNE', 'S', 'CAKE', 'JTO', 'IMX', 'WIF', 'FLOKI', 'VET', 'MANA', 'AXS',
  'GALA', 'APE', 'THETA', 'GRT', 'CHZ', 'NEO', 'IOTA', 'ENS', 'JASMY', 'PEOPLE',
  'ORDI', 'TRB',
].map((base) => `${base}USDT`);
