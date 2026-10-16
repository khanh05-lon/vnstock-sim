import type { Exchange, InstrumentType, StockRow } from '@vss/shared';

/** Bộ lọc cổ phiếu: để trống (null) = không lọc theo tiêu chí đó */
export interface ScreenFilter {
  exchange: Exchange | '';
  type: InstrumentType | '';
  industry: string;
  vn30: boolean;
  marginOnly: boolean;
  peMin: number | null;
  peMax: number | null;
  pbMin: number | null;
  pbMax: number | null;
  /** Vốn hoá tối thiểu (tỷ đồng) */
  capMin: number | null;
  /** Giá trị giao dịch trong phiên tối thiểu (tỷ đồng) */
  valueMin: number | null;
  changeMin: number | null;
  changeMax: number | null;
}

export const EMPTY_FILTER: ScreenFilter = {
  exchange: '',
  type: 'STOCK',
  industry: '',
  vn30: false,
  marginOnly: false,
  peMin: null,
  peMax: null,
  pbMin: null,
  pbMax: null,
  capMin: null,
  valueMin: null,
  changeMin: null,
  changeMax: null,
};

/** Bộ lọc mẫu hay dùng */
export const PRESETS: { id: string; label: string; hint: string; filter: Partial<ScreenFilter> }[] = [
  { id: 'value', label: 'Cổ phiếu giá trị', hint: 'P/E dưới 10, P/B dưới 1,5', filter: { peMin: 0.01, peMax: 10, pbMax: 1.5 } },
  { id: 'bluechip', label: 'Vốn hoá lớn', hint: 'Vốn hoá trên 50.000 tỷ', filter: { capMin: 50_000 } },
  { id: 'liquid', label: 'Thanh khoản cao', hint: 'Giá trị khớp trong phiên trên 100 tỷ', filter: { valueMin: 100 } },
  { id: 'gainers', label: 'Tăng mạnh', hint: 'Tăng từ 3% trở lên so với tham chiếu', filter: { changeMin: 3 } },
  { id: 'losers', label: 'Giảm mạnh', hint: 'Giảm từ 3% trở lên', filter: { changeMax: -3 } },
  { id: 'margin', label: 'Được cho vay ký quỹ', hint: 'Mã có tỷ lệ cho vay ký quỹ', filter: { marginOnly: true } },
];

export interface ScreenRow {
  symbol: string;
  name: string;
  exchange: Exchange;
  industry: string;
  price: number;
  /** % thay đổi so với tham chiếu */
  change: number;
  volume: number;
  /** Giá trị khớp trong phiên (đ) */
  value: number;
  /** Vốn hoá (đ) */
  cap: number;
  /** null khi EPS / BVPS ≤ 0 (lỗ hoặc âm vốn) — không có ý nghĩa */
  pe: number | null;
  pb: number | null;
  eps: number;
  bvps: number;
  marginRatio: number;
  isVn30: boolean;
}

export function toScreenRow(r: StockRow): ScreenRow {
  const price = r.volume > 0 ? r.last : r.ref;
  return {
    symbol: r.symbol,
    name: r.name,
    exchange: r.exchange,
    industry: r.industry,
    price,
    change: r.ref > 0 ? ((price - r.ref) / r.ref) * 100 : 0,
    volume: r.volume,
    value: r.value,
    cap: price * r.listedShares,
    pe: r.eps > 0 ? price / r.eps : null,
    pb: r.bvps > 0 ? price / r.bvps : null,
    eps: r.eps,
    bvps: r.bvps,
    marginRatio: r.marginRatio ?? 0,
    isVn30: r.isVn30,
  };
}

const inRange = (v: number | null, min: number | null, max: number | null) => {
  if (min == null && max == null) return true;
  if (v == null) return false;
  return (min == null || v >= min) && (max == null || v <= max);
};

export function screen(rows: StockRow[], f: ScreenFilter): ScreenRow[] {
  return rows
    .filter(
      (r) =>
        (!f.exchange || r.exchange === f.exchange) &&
        (!f.type || (r.type ?? 'STOCK') === f.type) &&
        (!f.industry || r.industry === f.industry) &&
        (!f.vn30 || r.isVn30) &&
        (!f.marginOnly || (r.marginRatio ?? 0) > 0),
    )
    .map(toScreenRow)
    .filter(
      (r) =>
        inRange(r.pe, f.peMin, f.peMax) &&
        inRange(r.pb, f.pbMin, f.pbMax) &&
        inRange(r.change, f.changeMin, f.changeMax) &&
        (f.capMin == null || r.cap >= f.capMin * 1e9) &&
        (f.valueMin == null || r.value >= f.valueMin * 1e9),
    );
}
