import { roundToTick, type BondInfo, type WarrantInfo } from '@vss/shared';
import type { Database, Queryable } from '../db';
import { addDays, prevTradingDay } from '../lib/calendar';
import { gaussian, hashString, mulberry32 } from '../lib/prng';
import { generateHistory, insertBatched, tradingDates } from '../seed/seed';

/* ============================ chứng quyền ============================ */

/** Hàm phân phối chuẩn (xấp xỉ Abramowitz–Stegun, sai số < 1e-7) */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/** Giá quyền chọn mua kiểu châu Âu theo Black–Scholes */
export function blackScholesCall(S: number, K: number, T: number, sigma: number, r = 0.03): number {
  if (T <= 0 || sigma <= 0) return Math.max(0, S - K);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
}

/**
 * Giá lý thuyết 1 chứng quyền (VNĐ) theo giá cổ phiếu cơ sở; độ biến động năm = biến động ngày × √250.
 * Chứng quyền ở VN là quyền mua kiểu châu Âu, thanh toán bằng tiền khi đáo hạn.
 */
export function warrantFair(underlyingPrice: number, w: Pick<WarrantInfo, 'exercisePrice' | 'ratio' | 'maturityDate'>, today: string, dailyVol: number): number {
  const days = Math.max(1, (Date.parse(`${w.maturityDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400_000);
  const v = blackScholesCall(underlyingPrice, w.exercisePrice, days / 365, Math.max(0.1, dailyVol * Math.sqrt(250)));
  return Math.max(10, v / w.ratio);
}

/* ============================ trái phiếu ============================ */

const addMonths = (d: string, m: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCMonth(x.getUTCMonth() + m);
  return x.toISOString().slice(0, 10);
};

/** Các ngày trả lãi từ ngày phát hành tới đáo hạn (ngày đáo hạn là kỳ cuối) */
export function couponDates(b: Pick<BondInfo, 'issueDate' | 'maturityDate' | 'couponFreq'>): string[] {
  const out: string[] = [];
  const step = 12 / b.couponFreq;
  for (let k = 1; ; k++) {
    const d = addMonths(b.issueDate, step * k);
    if (d >= b.maturityDate) break;
    out.push(d);
  }
  out.push(b.maturityDate);
  return out;
}

/** Lợi suất đáo hạn (YTM, năm) gần đúng từ giá — tìm nghiệm bằng chia đôi */
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

/* ============================ nạp thông tin & dữ liệu mẫu ============================ */

export async function loadInstrumentInfo(db: Queryable): Promise<{ warrants: Map<string, WarrantInfo>; bonds: Map<string, BondInfo> }> {
  const w = await db.many<{ symbol: string; underlying: string; issuer: string; ratio: number; exercise_price: number; maturity_date: string | Date; last_trading_date: string | Date }>(
    'SELECT * FROM warrants',
  );
  const b = await db.many<{ symbol: string; issuer: string; par_value: number; coupon_rate: number; coupon_freq: number; issue_date: string | Date; maturity_date: string | Date }>('SELECT * FROM bonds');
  const d = (x: string | Date) => (x instanceof Date ? x.toISOString().slice(0, 10) : x);
  return {
    warrants: new Map(
      w.map((x) => [
        x.symbol,
        { underlying: x.underlying, issuer: x.issuer, ratio: Number(x.ratio), exercisePrice: Number(x.exercise_price), maturityDate: d(x.maturity_date), lastTradingDate: d(x.last_trading_date) },
      ]),
    ),
    bonds: new Map(
      b.map((x) => [
        x.symbol,
        { issuer: x.issuer, parValue: Number(x.par_value), couponRate: Number(x.coupon_rate), couponFreq: x.coupon_freq, issueDate: d(x.issue_date), maturityDate: d(x.maturity_date) },
      ]),
    ),
  };
}

const ETFS = [
  { symbol: 'E1VFVN30', name: 'Quỹ ETF DCVFMVN30 (mô phỏng)', ref: 25_000, sharesM: 300, liq: 0.55 },
  { symbol: 'FUEVFVND', name: 'Quỹ ETF DCVFMVN Diamond (mô phỏng)', ref: 32_500, sharesM: 450, liq: 0.5 },
  { symbol: 'FUESSVFL', name: 'Quỹ ETF SSIAM VNFIN Lead (mô phỏng)', ref: 21_800, sharesM: 120, liq: 0.3 },
];

const CWS = [
  { symbol: 'CFPT2601', underlying: 'FPT', ratio: 5, strikeX: 1.0, days: 150 },
  { symbol: 'CHPG2602', underlying: 'HPG', ratio: 2, strikeX: 1.05, days: 120 },
  { symbol: 'CMWG2603', underlying: 'MWG', ratio: 4, strikeX: 0.95, days: 180 },
  { symbol: 'CVNM2604', underlying: 'VNM', ratio: 3, strikeX: 1.02, days: 90 },
];

const BONDS = [
  { symbol: 'TPVCB2801', issuer: 'Vietcombank', name: 'Trái phiếu Vietcombank 2028 (mô phỏng)', coupon: 0.062, freq: 1, issue: '2023-11-20', maturity: '2028-11-20', ref: 101_200 },
  { symbol: 'TPVIC2702', issuer: 'Vingroup', name: 'Trái phiếu Vingroup 2027 (mô phỏng)', coupon: 0.095, freq: 2, issue: '2024-03-15', maturity: '2027-03-15', ref: 100_450 },
  { symbol: 'TPHPG2903', issuer: 'Hòa Phát', name: 'Trái phiếu Hòa Phát 2029 (mô phỏng)', coupon: 0.08, freq: 2, issue: '2024-06-10', maturity: '2029-06-10', ref: 102_800 },
];

/**
 * Thêm ETF, chứng quyền, trái phiếu mẫu (chạy mỗi lần khởi động, chỉ thêm mã chưa có).
 * Mọi số liệu là giả lập phục vụ học tập, không phải sản phẩm thật.
 */
export async function seedInstruments(db: Database, tradeDate: string, skipWeekends: boolean): Promise<string[]> {
  const have = new Set((await db.many<{ symbol: string }>('SELECT symbol FROM stocks')).map((r) => r.symbol));
  const end = prevTradingDay(tradeDate, skipWeekends);
  const added: string[] = [];
  await db.tx(async (tx) => {
    for (const e of ETFS) {
      if (have.has(e.symbol)) continue;
      const dates = tradingDates(end, 250);
      await tx.many(
        `INSERT INTO stocks (symbol, exchange, type, name, industry, listed_shares, eps, bvps, is_vn30, liquidity, volatility, margin_ratio, listed_at)
         VALUES ($1,'HOSE','ETF',$2,'Chứng chỉ quỹ ETF',$3,0,$4,false,$5,0.013,0.5,$6)`,
        [e.symbol, e.name, e.sharesM * 1e6, e.ref, e.liq, dates[0]],
      );
      const bars = generateHistory({ symbol: e.symbol, exchange: 'HOSE', name: e.name, industry: 'Ngân hàng', ref: e.ref, sharesM: e.sharesM, eps: 0, bvps: e.ref, liq: e.liq }, dates);
      await insertBatched(tx, 'ohlcv_daily', ['symbol', 'trade_date', 'open', 'high', 'low', 'close', 'volume', 'value'], bars.map((b) => [e.symbol, b.date, b.open, b.high, b.low, b.close, b.volume, b.value]));
      added.push(e.symbol);
    }

    for (const c of CWS) {
      if (have.has(c.symbol)) continue;
      const u = await tx.one<{ volatility: number; status: string }>('SELECT volatility, status FROM stocks WHERE symbol = $1', [c.underlying]);
      if (!u || u.status !== 'ACTIVE') continue;
      const closes = await tx.many<{ d: string | Date; close: number }>(
        'SELECT trade_date AS d, close FROM ohlcv_daily WHERE symbol = $1 AND trade_date <= $2 ORDER BY trade_date DESC LIMIT 80',
        [c.underlying, end],
      );
      if (!closes.length) continue;
      closes.reverse();
      const iso = (d: string | Date) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
      const lastClose = closes[closes.length - 1].close;
      const strike = Math.round((lastClose * c.strikeX) / 100) * 100;
      const maturity = addDays(tradeDate, c.days);
      const lastTrading = addDays(maturity, -4);
      const w = { exercisePrice: strike, ratio: c.ratio, maturityDate: maturity };
      const issuer = 'CTCK Mô Phỏng';
      await tx.many(
        `INSERT INTO stocks (symbol, exchange, type, name, industry, listed_shares, eps, bvps, is_vn30, liquidity, volatility, margin_ratio, listed_at)
         VALUES ($1,'HOSE','CW',$2,'Chứng quyền',$3,0,0,false,0.45,$4,0,$5)`,
        [c.symbol, `Chứng quyền ${c.underlying} — ${issuer} (mô phỏng)`, 10_000_000, u.volatility * 3, iso(closes[0].d)],
      );
      await tx.many(
        `INSERT INTO warrants (symbol, underlying, issuer, ratio, exercise_price, maturity_date, last_trading_date) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [c.symbol, c.underlying, issuer, c.ratio, strike, maturity, lastTrading],
      );
      const rand = mulberry32(hashString(c.symbol));
      const rows = closes.map((x) => {
        const close = roundToTick({ exchange: 'HOSE', type: 'CW' }, warrantFair(x.close, w, iso(x.d), u.volatility));
        const sw = Math.max(10, Math.round((close * 0.03 * Math.abs(gaussian(rand))) / 10) * 10);
        const volume = Math.max(100, Math.round((20_000 + Math.abs(gaussian(rand)) * 60_000) / 100) * 100);
        return [c.symbol, iso(x.d), close, close + sw, Math.max(10, close - sw), close, volume, volume * close];
      });
      await insertBatched(tx, 'ohlcv_daily', ['symbol', 'trade_date', 'open', 'high', 'low', 'close', 'volume', 'value'], rows);
      added.push(c.symbol);
    }

    for (const b of BONDS) {
      if (have.has(b.symbol)) continue;
      const dates = tradingDates(end, 250);
      await tx.many(
        `INSERT INTO stocks (symbol, exchange, type, name, industry, listed_shares, eps, bvps, is_vn30, liquidity, volatility, margin_ratio, listed_at)
         VALUES ($1,'HNX','BOND',$2,'Trái phiếu',$3,0,100000,false,0.15,0.002,0,$4)`,
        [b.symbol, b.name, 20_000_000, b.issue],
      );
      const past = couponDates({ issueDate: b.issue, maturityDate: b.maturity, couponFreq: b.freq }).filter((d) => d <= end);
      await tx.many(
        `INSERT INTO bonds (symbol, issuer, par_value, coupon_rate, coupon_freq, issue_date, maturity_date, last_coupon_date) VALUES ($1,$2,100000,$3,$4,$5,$6,$7)`,
        [b.symbol, b.issuer, b.coupon, b.freq, b.issue, b.maturity, past.at(-1) ?? null],
      );
      // Giá trái phiếu dao động rất ít quanh giá hiện tại (bước giá 1đ)
      const rand = mulberry32(hashString(b.symbol));
      const closes: number[] = new Array(dates.length);
      closes[dates.length - 1] = b.ref;
      for (let i = dates.length - 1; i > 0; i--) closes[i - 1] = Math.round(closes[i] / (1 + gaussian(rand) * 0.0015));
      const rows = dates.map((d, i) => {
        const c = closes[i];
        const o = i ? closes[i - 1] : c;
        const vol = Math.max(100, Math.round((500 + Math.abs(gaussian(rand)) * 3_000) / 100) * 100);
        return [b.symbol, d, o, Math.max(o, c) + 50, Math.min(o, c) - 50, c, vol, vol * c];
      });
      await insertBatched(tx, 'ohlcv_daily', ['symbol', 'trade_date', 'open', 'high', 'low', 'close', 'volume', 'value'], rows);
      added.push(b.symbol);
    }
  });
  if (added.length) console.log(`[seed] thêm ${added.length} mã ETF / chứng quyền / trái phiếu mẫu: ${added.join(', ')}`);
  return added;
}
