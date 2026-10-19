import { z } from 'zod';
import { Big, type Dec } from './decimal';
import { RULES } from './rules';

/* =====================================================================================
 * Cấp VIP phí Spot theo Binance: đạt cấp khi CẢ khối lượng Spot 30 ngày (USDT) VÀ số BNB nắm giữ đủ ngưỡng.
 * Cấp được tính lại mỗi ngày lúc 00:00 UTC; phí chốt vào lệnh lúc đặt theo cấp hiện tại.
 * Ngưỡng thật nhân hệ số `VIP_RULES.scale` (mặc định 0,01 vì vốn ảo chỉ 10.000 USDT); biểu phí giữ nguyên số thật.
 * VIP 0 dùng phí cơ bản RULES.makerFee / takerFee (Vận hành thị trường chỉnh).
 * ===================================================================================== */

export interface VipTier {
  level: number;
  /** Khối lượng Spot 30 ngày tối thiểu (USDT) — số thật của Binance, chưa nhân hệ số */
  volumeUsdt: number;
  /** Số BNB nắm giữ tối thiểu — số thật */
  bnb: number;
  maker: Dec;
  taker: Dec;
}

/** Bảng Spot VIP 1 → 9 (Binance) */
export const VIP_TIERS: readonly VipTier[] = [
  { level: 1, volumeUsdt: 1_000_000, bnb: 25, maker: '0.0009', taker: '0.001' },
  { level: 2, volumeUsdt: 5_000_000, bnb: 100, maker: '0.0008', taker: '0.001' },
  { level: 3, volumeUsdt: 20_000_000, bnb: 250, maker: '0.0004', taker: '0.0006' },
  { level: 4, volumeUsdt: 75_000_000, bnb: 500, maker: '0.0004', taker: '0.00052' },
  { level: 5, volumeUsdt: 150_000_000, bnb: 1_000, maker: '0.00025', taker: '0.00031' },
  { level: 6, volumeUsdt: 400_000_000, bnb: 1_750, maker: '0.0002', taker: '0.00029' },
  { level: 7, volumeUsdt: 800_000_000, bnb: 3_000, maker: '0.00019', taker: '0.00028' },
  { level: 8, volumeUsdt: 2_000_000_000, bnb: 4_500, maker: '0.00016', taker: '0.00025' },
  { level: 9, volumeUsdt: 4_000_000_000, bnb: 5_500, maker: '0.00011', taker: '0.00023' },
];

export const MAX_VIP_LEVEL = 9;

/** Tham số VIP — Vận hành thị trường chỉnh lúc chạy (applyVipRules), lưu market_meta key admin.vipRules */
export const VIP_RULES = {
  /** Hệ số nhân ngưỡng thật (0,01 = 1/100) */
  scale: 0.01,
};
export type VipRules = typeof VIP_RULES;
export const DEFAULT_VIP_RULES: VipRules = { ...VIP_RULES };

export const vipRulesPatchSchema = z
  .object({ scale: z.number().min(0.000001, 'Hệ số quá nhỏ').max(1, 'Hệ số tối đa 1 (ngưỡng thật)').optional() })
  .strict();
export type VipRulesPatch = z.infer<typeof vipRulesPatchSchema>;

export function applyVipRules(patch: VipRulesPatch | null | undefined) {
  Object.assign(VIP_RULES, DEFAULT_VIP_RULES, patch ?? {});
}

/** Ngưỡng đã nhân hệ số */
export function scaledTiers(scale = VIP_RULES.scale): VipTier[] {
  return VIP_TIERS.map((t) => ({ ...t, volumeUsdt: t.volumeUsdt * scale, bnb: t.bnb * scale }));
}

/** Cấp cao nhất mà cả khối lượng 30 ngày và BNB đều đạt */
export function vipLevelFor(volume30dUsdt: number, bnb: number, scale = VIP_RULES.scale): number {
  let level = 0;
  for (const t of scaledTiers(scale)) if (volume30dUsdt >= t.volumeUsdt && bnb >= t.bnb) level = t.level;
  return level;
}

/** Phí maker / taker theo cấp. Không bao giờ cao hơn phí cơ bản (khi sàn hạ phí cơ bản, cấp VIP không bị thiệt) */
export function feesFor(level: number): { maker: Dec; taker: Dec } {
  const base = { maker: RULES.makerFee, taker: RULES.takerFee };
  const t = VIP_TIERS.find((x) => x.level === level);
  if (!t) return base;
  const min = (a: Dec, b: Dec) => (new Big(a).lt(b) ? a : b);
  return { maker: min(t.maker, base.maker), taker: min(t.taker, base.taker) };
}

export interface VipStatusDTO {
  level: number;
  /** Khối lượng Spot 30 ngày lúc chốt cấp gần nhất (USDT) */
  volume30d: Dec;
  /** Khối lượng Spot 30 ngày tính tới hiện tại (USDT) */
  volumeNow: Dec;
  bnb: Dec;
  updatedAt: string | null;
  maker: Dec;
  taker: Dec;
  scale: number;
  tiers: { level: number; volumeUsdt: number; bnb: number; maker: Dec; taker: Dec }[];
}
