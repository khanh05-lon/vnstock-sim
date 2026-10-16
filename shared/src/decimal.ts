import Big, { type BigSource } from 'big.js';

/*
 * Số thập phân chính xác cho giá, khối lượng, số dư (crypto cần tới 8–18 chữ số lẻ).
 * Quy ước: mọi giá trị tiền / khối lượng đi qua API và CSDL dưới dạng CHUỖI thập phân ("0.00012000"),
 * chỉ chuyển sang number để hiển thị hoặc vẽ biểu đồ. Không cộng trừ tiền bằng number của JS.
 */

// Không bao giờ in dạng mũ (1e-7) và giữ đủ 18 chữ số lẻ khi chia
Big.NE = -40;
Big.PE = 40;
Big.DP = 18;

export type Dec = string;
export { Big };

export const dec = (v: BigSource): Big => new Big(v);

/** Chuỗi chuẩn hoá: bỏ số 0 thừa ở cuối ("1.5000" → "1.5", "0.0" → "0") */
export const str = (v: BigSource): Dec => new Big(v).toFixed();

export const add = (a: BigSource, b: BigSource): Dec => new Big(a).plus(b).toFixed();
export const sub = (a: BigSource, b: BigSource): Dec => new Big(a).minus(b).toFixed();
export const mul = (a: BigSource, b: BigSource): Dec => new Big(a).times(b).toFixed();
export const div = (a: BigSource, b: BigSource): Dec => new Big(a).div(b).toFixed();

export const cmp = (a: BigSource, b: BigSource): number => new Big(a).cmp(b);
export const gt = (a: BigSource, b: BigSource) => new Big(a).gt(b);
export const gte = (a: BigSource, b: BigSource) => new Big(a).gte(b);
export const lt = (a: BigSource, b: BigSource) => new Big(a).lt(b);
export const lte = (a: BigSource, b: BigSource) => new Big(a).lte(b);
export const eq = (a: BigSource, b: BigSource) => new Big(a).eq(b);
export const isZero = (a: BigSource) => new Big(a).eq(0);
export const isPos = (a: BigSource) => new Big(a).gt(0);
export const minD = (a: BigSource, b: BigSource): Dec => (new Big(a).lte(b) ? str(a) : str(b));
export const maxD = (a: BigSource, b: BigSource): Dec => (new Big(a).gte(b) ? str(a) : str(b));

/** Chuỗi có phải số thập phân không âm hợp lệ không ("12", "0.5", ".5" không hợp lệ) */
export function isDecString(s: unknown): s is string {
  return typeof s === 'string' && /^\d{1,20}(\.\d{1,18})?$/.test(s);
}

/** Số chữ số lẻ có nghĩa của bước giá / bước khối lượng: "0.01000000" → 2, "1.00000000" → 0 */
export function decimalsOf(step: BigSource): number {
  const s = new Big(step).toFixed();
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** v có là bội số của step không (step = 0 → bỏ qua kiểm tra) */
export function isMultiple(v: BigSource, step: BigSource): boolean {
  const st = new Big(step);
  if (st.eq(0)) return true;
  return new Big(v).mod(st).eq(0);
}

/** Làm tròn xuống theo bước (khối lượng, giá mua) */
export function floorStep(v: BigSource, step: BigSource): Dec {
  const st = new Big(step);
  if (st.eq(0)) return str(v);
  return new Big(v).div(st).round(0, Big.roundDown).times(st).toFixed();
}

/** Làm tròn lên theo bước */
export function ceilStep(v: BigSource, step: BigSource): Dec {
  const st = new Big(step);
  if (st.eq(0)) return str(v);
  return new Big(v).div(st).round(0, Big.roundUp).times(st).toFixed();
}

/** Làm tròn tới số chữ số lẻ: mode 'down' | 'up' | 'half' */
export function roundDp(v: BigSource, dp: number, mode: 'down' | 'up' | 'half' = 'half'): Dec {
  const rm = mode === 'down' ? Big.roundDown : mode === 'up' ? Big.roundUp : Big.roundHalfUp;
  return new Big(v).round(dp, rm).toFixed();
}

/** Hiển thị cố định dp chữ số lẻ (chuỗi) — "0.1" với dp 4 → "0.1000" */
export function fixed(v: BigSource, dp: number): string {
  return new Big(v).toFixed(dp, Big.roundDown);
}

/** Chuyển sang number (chỉ để hiển thị / biểu đồ / sắp xếp) */
export const num = (v: BigSource | null | undefined): number => (v == null || v === '' ? 0 : Number(v));

/** Tổng một dãy */
export function sum(values: BigSource[]): Dec {
  let t = new Big(0);
  for (const v of values) t = t.plus(v);
  return t.toFixed();
}
