import { Big, decimalsOf, fixed, floorStep, isMultiple, str, type Dec } from './decimal';
import type { SymbolFilters, SymbolInfo } from './market';
import type { OrderType, Side } from './orders';

/*
 * Kiểm tra lệnh theo bộ lọc của cặp (cùng công thức với Binance Spot):
 *  PRICE_FILTER          minPrice ≤ price ≤ maxPrice, price % tickSize = 0 (áp dụng cho cả stopPrice)
 *  LOT_SIZE              minQty ≤ qty ≤ maxQty, qty % stepSize = 0
 *  MARKET_LOT_SIZE       qty ≤ marketMaxQty với lệnh MARKET theo khối lượng
 *  NOTIONAL              minNotional ≤ price × qty ≤ maxNotional (MARKET: qty × giá TB, hoặc quoteOrderQty)
 *  PERCENT_PRICE_BY_SIDE giá mua trong [avg × bidDown, avg × bidUp], giá bán trong [avg × askDown, avg × askUp]
 * Dùng chung ở frontend (báo lỗi ngay khi nhập) và backend (từ chối lệnh).
 */

export interface OrderCheckInput {
  side: Side;
  type: OrderType;
  price?: Dec | null;
  stopPrice?: Dec | null;
  quantity?: Dec | null;
  quoteOrderQty?: Dec | null;
}

export interface FilterError {
  code: 'SYMBOL_STATUS' | 'PRICE_FILTER' | 'LOT_SIZE' | 'MARKET_LOT_SIZE' | 'NOTIONAL' | 'PERCENT_PRICE';
  field: 'price' | 'stopPrice' | 'quantity' | 'quoteOrderQty' | 'symbol';
  message: string;
}

/** Hiển thị số theo số chữ số lẻ của bước (bỏ số 0 vô nghĩa) */
export function fmtStep(v: Dec, step: Dec): string {
  const dp = decimalsOf(step);
  return new Big(fixed(v, dp)).toFixed();
}

function checkPrice(f: SymbolFilters, field: 'price' | 'stopPrice', label: string, p: Dec): FilterError | null {
  const v = new Big(p);
  if (!new Big(f.minPrice).eq(0) && v.lt(f.minPrice)) {
    return { code: 'PRICE_FILTER', field, message: `${label} tối thiểu ${str(f.minPrice)}` };
  }
  if (!new Big(f.maxPrice).eq(0) && v.gt(f.maxPrice)) {
    return { code: 'PRICE_FILTER', field, message: `${label} tối đa ${str(f.maxPrice)}` };
  }
  if (!isMultiple(v, f.tickSize)) {
    return { code: 'PRICE_FILTER', field, message: `${label} phải là bội số của bước giá ${str(f.tickSize)}` };
  }
  return null;
}

function checkQty(f: SymbolFilters, q: Dec, market: boolean): FilterError | null {
  const v = new Big(q);
  if (v.lt(f.minQty)) return { code: 'LOT_SIZE', field: 'quantity', message: `Khối lượng tối thiểu ${str(f.minQty)}` };
  if (!new Big(f.maxQty).eq(0) && v.gt(f.maxQty)) {
    return { code: 'LOT_SIZE', field: 'quantity', message: `Khối lượng tối đa ${str(f.maxQty)} mỗi lệnh` };
  }
  if (!isMultiple(v, f.stepSize)) {
    return { code: 'LOT_SIZE', field: 'quantity', message: `Khối lượng phải là bội số của ${str(f.stepSize)}` };
  }
  if (market && !new Big(f.marketMaxQty).eq(0) && v.gt(f.marketMaxQty)) {
    return { code: 'MARKET_LOT_SIZE', field: 'quantity', message: `Lệnh thị trường tối đa ${str(f.marketMaxQty)} mỗi lệnh` };
  }
  return null;
}

function checkNotional(f: SymbolFilters, notional: Big, market: boolean, quote: string, field: FilterError['field']): FilterError | null {
  if ((!market || f.applyMinToMarket) && notional.lt(f.minNotional)) {
    return { code: 'NOTIONAL', field, message: `Giá trị lệnh tối thiểu ${str(f.minNotional)} ${quote}` };
  }
  if ((!market || f.applyMaxToMarket) && !new Big(f.maxNotional).eq(0) && notional.gt(f.maxNotional)) {
    return { code: 'NOTIONAL', field, message: `Giá trị lệnh tối đa ${str(f.maxNotional)} ${quote}` };
  }
  return null;
}

function checkPercentPrice(f: SymbolFilters, side: Side, p: Dec, avg: Dec): FilterError | null {
  const a = new Big(avg);
  if (a.lte(0)) return null;
  const [up, down] = side === 'BUY' ? [f.bidMultiplierUp, f.bidMultiplierDown] : [f.askMultiplierUp, f.askMultiplierDown];
  const hi = new Big(up).eq(0) ? null : a.times(up);
  const lo = new Big(down).eq(0) ? null : a.times(down);
  const v = new Big(p);
  const tick = f.tickSize;
  if (hi && v.gt(hi)) {
    return { code: 'PERCENT_PRICE', field: 'price', message: `Giá ${side === 'BUY' ? 'mua' : 'bán'} tối đa ${fmtStep(hi.toFixed(), tick)} (cách giá trung bình quá xa)` };
  }
  if (lo && v.lt(lo)) {
    return { code: 'PERCENT_PRICE', field: 'price', message: `Giá ${side === 'BUY' ? 'mua' : 'bán'} tối thiểu ${fmtStep(lo.toFixed(), tick)} (cách giá trung bình quá xa)` };
  }
  return null;
}

/**
 * Kiểm tra 1 lệnh. avgPrice: giá trung bình gia quyền 5 phút gần nhất (dùng cho PERCENT_PRICE và NOTIONAL của lệnh MARKET).
 * Trả về lỗi đầu tiên gặp phải, hoặc null nếu hợp lệ.
 */
export function validateOrder(info: SymbolInfo, o: OrderCheckInput, avgPrice: Dec | null): FilterError | null {
  const f = info.filters;
  if (info.status !== 'TRADING') {
    return { code: 'SYMBOL_STATUS', field: 'symbol', message: `${info.symbol} đang tạm ngừng giao dịch` };
  }
  const market = o.type === 'MARKET';
  if (!market && o.price) {
    const e = checkPrice(f, 'price', 'Giá', o.price);
    if (e) return e;
  }
  if (o.stopPrice) {
    const e = checkPrice(f, 'stopPrice', 'Giá kích hoạt', o.stopPrice);
    if (e) return e;
  }
  if (o.quantity) {
    const e = checkQty(f, o.quantity, market);
    if (e) return e;
  }
  if (market) {
    if (o.quoteOrderQty) return checkNotional(f, new Big(o.quoteOrderQty), true, info.quoteAsset, 'quoteOrderQty');
    if (o.quantity && avgPrice && new Big(avgPrice).gt(0)) {
      return checkNotional(f, new Big(o.quantity).times(avgPrice), true, info.quoteAsset, 'quantity');
    }
    return null;
  }
  if (o.price && o.quantity) {
    const e = checkNotional(f, new Big(o.price).times(o.quantity), false, info.quoteAsset, 'quantity');
    if (e) return e;
  }
  if (o.price && avgPrice) return checkPercentPrice(f, o.side, o.price, avgPrice);
  return null;
}

/** Khối lượng tối đa mua được với số tiền `funds` ở giá `price` (đã làm tròn xuống theo stepSize) */
export function maxBuyQty(f: SymbolFilters, funds: Dec, price: Dec): Dec {
  const p = new Big(price);
  if (p.lte(0)) return '0';
  return floorStep(new Big(funds).div(p), f.stepSize);
}

/** Làm tròn giá về bội số tickSize gần nhất phía dưới */
export const roundTick = (f: SymbolFilters, price: Dec): Dec => floorStep(price, f.tickSize);
/** Làm tròn khối lượng xuống bội số stepSize */
export const roundStep = (f: SymbolFilters, qty: Dec): Dec => floorStep(qty, f.stepSize);
