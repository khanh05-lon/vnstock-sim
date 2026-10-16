import type { BondInfo, StockRow } from '@vss/shared';

/** Lợi suất đáo hạn (YTM, năm) gần đúng của trái phiếu từ giá — chia đôi tìm nghiệm */
export function bondYield(price: number, b: Pick<BondInfo, 'parValue' | 'couponRate' | 'couponFreq' | 'maturityDate'>, today: string): number {
  const years = Math.max(0.01, (Date.parse(`${b.maturityDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / (365 * 86400_000));
  const n = Math.max(1, Math.ceil(years * b.couponFreq));
  const c = (b.parValue * b.couponRate) / b.couponFreq;
  const pv = (y: number) => {
    const r = y / b.couponFreq;
    let s = 0;
    for (let k = 1; k <= n; k++) s += c / (1 + r) ** k;
    return s + b.parValue / (1 + r) ** n;
  };
  let lo = -0.5;
  let hi = 2;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (pv(mid) > price) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Chứng quyền: giá trị nội tại / 1 CW, điểm hoà vốn của cổ phiếu cơ sở, trạng thái ITM/OTM */
export function warrantStats(cw: StockRow, underlyingPrice: number) {
  const w = cw.warrant!;
  const price = cw.volume ? cw.last : cw.ref;
  const intrinsic = Math.max(0, (underlyingPrice - w.exercisePrice) / w.ratio);
  return {
    intrinsic,
    breakEven: w.exercisePrice + price * w.ratio,
    moneyness: underlyingPrice > w.exercisePrice ? 'ITM' : underlyingPrice < w.exercisePrice ? 'OTM' : 'ATM',
    daysLeft: Math.max(0, Math.round((Date.parse(`${w.maturityDate}T00:00:00Z`) - Date.now()) / 86400_000)),
  };
}

export const TYPE_LABEL = { STOCK: 'Cổ phiếu', ETF: 'ETF', CW: 'Chứng quyền', BOND: 'Trái phiếu' } as const;
