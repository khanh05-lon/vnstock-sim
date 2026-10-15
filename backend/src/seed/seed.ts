import bcrypt from 'bcryptjs';
import { RULES, buyHoldAmount, calcFee, isValidTick, priceBand, roundToTick, type MarketMode } from '@vss/shared';
import type { Database, Queryable } from '../db';
import { addDays, currentTradeDate, isWeekend, prevTradingDay } from '../lib/calendar';
import { gaussian, hashString, mulberry32 } from '../lib/prng';
import { INDEX_DEFS, SEED_STOCKS, VN30, volatilityOf, type SeedStock } from './stocks';

const HISTORY_DAYS = 500;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface DayBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  value: number;
}

/** Danh sách ngày giao dịch (T2–T6) kết thúc tại endDate */
function tradingDates(endDate: string, n: number): string[] {
  const out: string[] = [];
  let d = endDate;
  while (out.length < n) {
    if (!isWeekend(d)) out.push(d);
    d = addDays(d, -1);
  }
  return out.reverse();
}

/** Sinh lịch sử giá ngày (random walk ngược, có seed theo mã) sao cho phiên cuối đóng cửa = giá tham chiếu */
export function generateHistory(s: SeedStock, dates: string[]): DayBar[] {
  const rand = mulberry32(hashString(s.symbol));
  const ex = s.exchange;
  const vol = volatilityOf(s);
  const lim = RULES.priceLimitPct[ex] / 100;
  const n = dates.length;
  const closes = new Array<number>(n);
  closes[n - 1] = s.ref;
  for (let i = n - 1; i > 0; i--) {
    const r = clamp(gaussian(rand) * vol + 0.0004, -lim * 0.95, lim * 0.95);
    closes[i - 1] = Math.max(1_000, roundToTick(ex, closes[i] / (1 + r)));
  }
  const baseVolume = s.sharesM * 1e6 * (0.0015 + s.liq * 0.006);
  const bars: DayBar[] = [];
  for (let i = 0; i < n; i++) {
    const prev = i === 0 ? closes[0] : closes[i - 1];
    const band = priceBand(ex, prev);
    const close = clamp(closes[i], band.floor, band.ceil);
    closes[i] = close;
    const open = clamp(roundToTick(ex, prev * (1 + gaussian(rand) * vol * 0.35)), band.floor, band.ceil);
    const high = clamp(roundToTick(ex, Math.max(open, close) * (1 + Math.abs(gaussian(rand)) * vol * 0.45), 'up'), Math.max(open, close), band.ceil);
    const low = clamp(roundToTick(ex, Math.min(open, close) * (1 - Math.abs(gaussian(rand)) * vol * 0.45), 'down'), band.floor, Math.min(open, close));
    const move = Math.abs(close / prev - 1);
    const volume = Math.max(100, Math.round((baseVolume * Math.exp(gaussian(rand) * 0.4) * (1 + move * 12)) / 100) * 100);
    bars.push({ date: dates[i], open, high, low, close, volume, value: Math.round((volume * (open + high + low + close)) / 4) });
  }
  return bars;
}

async function insertBatched(q: Queryable, table: string, cols: string[], rows: unknown[][], conflict = '') {
  const per = cols.length;
  const chunk = Math.floor(5000 / per);
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const values = part.map((r, j) => {
      params.push(...r);
      return `(${r.map((_, k) => `$${j * per + k + 1}`).join(',')})`;
    });
    await q.many(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values.join(',')} ${conflict}`, params);
  }
}

export async function seedMarket(db: Database, mode: MarketMode): Promise<void> {
  const existing = await db.one<{ n: number }>('SELECT count(*)::int AS n FROM stocks');
  if (existing && existing.n > 0) return;

  for (const s of SEED_STOCKS) {
    if (!isValidTick(s.exchange, s.ref)) throw new Error(`Giá tham chiếu ${s.symbol} sai bước giá: ${s.ref}`);
  }

  console.log('[seed] tạo danh mục mã và lịch sử giá...');
  const td = currentTradeDate(Date.now(), mode);
  const endDate = prevTradingDay(td, true);
  const dates = tradingDates(endDate, HISTORY_DAYS);

  await db.tx(async (tx) => {
    await insertBatched(
      tx,
      'stocks',
      ['symbol', 'exchange', 'name', 'industry', 'listed_shares', 'eps', 'bvps', 'is_vn30', 'liquidity', 'volatility'],
      SEED_STOCKS.map((s) => [s.symbol, s.exchange, s.name, s.industry, Math.round(s.sharesM * 1e6), s.eps, s.bvps, VN30.has(s.symbol), s.liq, volatilityOf(s)]),
    );

    const history = new Map<string, DayBar[]>();
    const rows: unknown[][] = [];
    for (const s of SEED_STOCKS) {
      const bars = generateHistory(s, dates);
      history.set(s.symbol, bars);
      for (const b of bars) rows.push([s.symbol, b.date, b.open, b.high, b.low, b.close, b.volume, b.value]);
    }
    await insertBatched(tx, 'ohlcv_daily', ['symbol', 'trade_date', 'open', 'high', 'low', 'close', 'volume', 'value'], rows);

    // Chỉ số = bình quân gia quyền vốn hoá, phiên cuối đúng bằng giá trị gốc
    const members: Record<string, SeedStock[]> = {
      VNINDEX: SEED_STOCKS.filter((s) => s.exchange === 'HOSE'),
      VN30: SEED_STOCKS.filter((s) => VN30.has(s.symbol)),
      HNXINDEX: SEED_STOCKS.filter((s) => s.exchange === 'HNX'),
      UPCOMINDEX: SEED_STOCKS.filter((s) => s.exchange === 'UPCOM'),
    };
    const idxRows: unknown[][] = [];
    for (const def of INDEX_DEFS) {
      const list = members[def.code];
      const capRef = list.reduce((a, s) => a + s.ref * s.sharesM, 0);
      for (let i = 0; i < dates.length; i++) {
        let o = 0;
        let h = 0;
        let l = 0;
        let c = 0;
        let v = 0;
        let val = 0;
        for (const s of list) {
          const b = history.get(s.symbol)![i];
          o += b.open * s.sharesM;
          h += b.high * s.sharesM;
          l += b.low * s.sharesM;
          c += b.close * s.sharesM;
          v += b.volume;
          val += b.value;
        }
        const k = def.base / capRef;
        idxRows.push([def.code, dates[i], o * k, Math.max(h * k, o * k, c * k), Math.min(l * k, o * k, c * k), c * k, v, val]);
      }
    }
    await insertBatched(tx, 'index_daily', ['code', 'trade_date', 'open', 'high', 'low', 'close', 'volume', 'value'], idxRows);
  });
  console.log(`[seed] ${SEED_STOCKS.length} mã, ${dates.length} phiên lịch sử (${dates[0]} → ${endDate})`);
}

/** Tạo tài khoản mới với vốn ảo ban đầu */
export async function createUserAccount(tx: Queryable, email: string, passwordHash: string, fullName: string) {
  const user = await tx.one<{ id: string; email: string; full_name: string; created_at: string }>(
    'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id, email, full_name, created_at',
    [email, passwordHash, fullName],
  );
  const capital = RULES.initialCapital;
  await tx.many('INSERT INTO accounts (user_id, cash_balance, initial_capital) VALUES ($1, $2, $2)', [user!.id, capital]);
  await tx.many(`INSERT INTO transactions_ledger (user_id, type, amount, balance_after, note) VALUES ($1, 'DEPOSIT', $2, $2, $3)`, [
    user!.id,
    capital,
    'Cấp vốn ảo khi mở tài khoản',
  ]);
  return user!;
}

/** Tài khoản demo có sẵn danh mục và lịch sử để trải nghiệm ngay (chỉ dùng cho dev) */
export async function seedDemoUser(db: Database, email: string, password: string, mode: MarketMode): Promise<void> {
  if (!email || !password) return;
  const exists = await db.one('SELECT 1 FROM users WHERE email = $1', [email]);
  if (exists) return;
  const hash = await bcrypt.hash(password, 10);
  const td = currentTradeDate(Date.now(), mode);
  const buyDate = prevTradingDay(prevTradingDay(prevTradingDay(td, true), true), true);
  const positions: [string, number, number][] = [
    ['FPT', 2_000, 0.95],
    ['HPG', 10_000, 0.97],
    ['MBB', 5_000, 0.96],
    ['VNM', 1_000, 1.02],
    ['SSI', 3_000, 1.04],
  ];
  await db.tx(async (tx) => {
    const user = await createUserAccount(tx, email, hash, 'Nhà đầu tư Demo');
    let balance = RULES.initialCapital;
    for (const [symbol, qty, factor] of positions) {
      const seed = SEED_STOCKS.find((s) => s.symbol === symbol)!;
      const price = roundToTick(seed.exchange, seed.ref * factor);
      const value = price * qty;
      const fee = calcFee(value);
      const executedAt = `${buyDate}T03:${String(10 + positions.findIndex((p) => p[0] === symbol) * 7).padStart(2, '0')}:00Z`;
      const order = await tx.one<{ id: number }>(
        `INSERT INTO orders (user_id, symbol, side, order_type, price, hold_price, qty, filled_qty, avg_fill_price, status, trade_date, created_at, updated_at)
         VALUES ($1,$2,'BUY','LO',$3,$3,$4,$4,$3,'FILLED',$5,$6,$6) RETURNING id`,
        [user.id, symbol, price, qty, buyDate, executedAt],
      );
      await tx.many(
        `INSERT INTO trades (order_id, user_id, symbol, side, price, qty, value, fee, executed_at) VALUES ($1,$2,$3,'BUY',$4,$5,$6,$7,$8)`,
        [order!.id, user.id, symbol, price, qty, value, fee, executedAt],
      );
      await tx.many(
        `INSERT INTO holdings (user_id, symbol, qty_total, qty_available, total_cost) VALUES ($1,$2,$3,$3,$4)`,
        [user.id, symbol, qty, value + fee],
      );
      balance -= value;
      await tx.many(
        `INSERT INTO transactions_ledger (user_id, type, amount, balance_after, order_id, note, created_at) VALUES ($1,'BUY',$2,$3,$4,$5,$6)`,
        [user.id, -value, balance, order!.id, `Mua ${qty.toLocaleString('en-US')} ${symbol} giá ${price.toLocaleString('en-US')}`, executedAt],
      );
      balance -= fee;
      await tx.many(
        `INSERT INTO transactions_ledger (user_id, type, amount, balance_after, order_id, note, created_at) VALUES ($1,'FEE',$2,$3,$4,$5,$6)`,
        [user.id, -fee, balance, order!.id, `Phí giao dịch lệnh #${order!.id}`, executedAt],
      );
      if (buyHoldAmount(price, qty) !== value + fee) throw new Error('Sai lệch tính phí');
    }
    await tx.many('UPDATE accounts SET cash_balance = $2 WHERE user_id = $1', [user.id, balance]);
    for (const symbol of ['FPT', 'HPG', 'MBB', 'VNM', 'SSI', 'VCB', 'TCB', 'MWG', 'VHM', 'DGC']) {
      await tx.many('INSERT INTO watchlists (user_id, symbol) VALUES ($1, $2)', [user.id, symbol]);
    }
  });
  console.log(`[seed] đã tạo tài khoản demo ${email}`);
}
