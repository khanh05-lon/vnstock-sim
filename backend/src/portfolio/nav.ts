import type { Database } from '../db';
import { log } from '../lib/logger';

/** Những gì cần từ thị trường để định giá danh mục */
export interface PriceSource {
  tradeDate: string;
  markPrice(symbol: string): number;
}

/** Dòng tài khoản đủ để tính NAV — các cột của tính năng ký quỹ / tiền chờ về có thể chưa có */
export interface AccountLike {
  user_id: string;
  cash_balance: number;
  contributed: number;
  cash_pending?: number | null;
  loan_balance?: number | null;
  loan_interest?: number | null;
}

export interface NavBreakdown {
  nav: number;
  cash: number;
  stock: number;
  debt: number;
  /** Quyền chờ về (cổ tức tiền, cổ phiếu thưởng chưa về tài khoản) */
  rights: number;
  contributed: number;
}

/**
 * Tài sản ròng = tiền mặt + tiền bán chờ về + giá trị cổ phiếu (giá hiện hành) + quyền chờ về − dư nợ ký quỹ − lãi vay.
 */
export function navOf(a: AccountLike, stock: number, rights = 0): NavBreakdown {
  const cash = Number(a.cash_balance) + Number(a.cash_pending ?? 0);
  const debt = Number(a.loan_balance ?? 0) + Number(a.loan_interest ?? 0);
  return { nav: cash + stock + rights - debt, cash, stock, debt, rights, contributed: Number(a.contributed) };
}

/** Giá trị quyền chờ về theo người dùng (bảng sự kiện quyền có thể chưa tồn tại) */
export type RightsValuer = (userIds: string[] | null) => Promise<Map<string, number>>;

export class NavService {
  /** Định giá quyền chờ về — tính năng sự kiện quyền gắn vào */
  rightsValue: RightsValuer = async () => new Map();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private db: Database,
    private market: PriceSource,
  ) {}

  /** NAV hiện tại của 1 hoặc nhiều tài khoản (null = tất cả) */
  async current(userIds: string[] | null): Promise<Map<string, NavBreakdown>> {
    const filter = userIds ? `WHERE user_id IN (${userIds.map((_, i) => `$${i + 1}`).join(',') || 'NULL'})` : '';
    const params = userIds ?? [];
    const accts = await this.db.many<AccountLike>(`SELECT * FROM accounts ${filter}`, params);
    const holds = await this.db.many<{ user_id: string; symbol: string; qty_total: number }>(`SELECT user_id, symbol, qty_total FROM holdings ${filter}`, params);
    const stock = new Map<string, number>();
    for (const h of holds) stock.set(h.user_id, (stock.get(h.user_id) ?? 0) + h.qty_total * this.market.markPrice(h.symbol));
    const rights = await this.rightsValue(userIds);
    const out = new Map<string, NavBreakdown>();
    for (const a of accts) out.set(a.user_id, navOf(a, stock.get(a.user_id) ?? 0, rights.get(a.user_id) ?? 0));
    return out;
  }

  /** Ghi NAV của mọi tài khoản cho ngày giao dịch hiện tại (ghi đè trong ngày, lần cuối = giá đóng cửa) */
  async snapshotAll(tradeDate = this.market.tradeDate): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const all = await this.current(null);
      const rows = [...all.entries()];
      for (let i = 0; i < rows.length; i += 500) {
        const part = rows.slice(i, i + 500);
        const params: unknown[] = [];
        const values = part.map(([uid, n], j) => {
          params.push(uid, tradeDate, n.nav, n.cash, n.stock + n.rights, n.debt, n.contributed);
          const b = j * 7;
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},now())`;
        });
        await this.db.many(
          `INSERT INTO nav_daily (user_id, trade_date, nav, cash, stock_value, debt, contributed, updated_at) VALUES ${values.join(',')}
           ON CONFLICT (user_id, trade_date) DO UPDATE SET nav = EXCLUDED.nav, cash = EXCLUDED.cash, stock_value = EXCLUDED.stock_value,
           debt = EXCLUDED.debt, contributed = EXCLUDED.contributed, updated_at = now()`,
          params,
        );
      }
      return rows.length;
    } finally {
      this.running = false;
    }
  }

  /** Chụp NAV định kỳ (mặc định 5 phút) để biểu đồ luôn có điểm của ngày hôm nay kể cả khi máy chủ tắt đột ngột */
  start(everyMs = 5 * 60_000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.snapshotAll().catch((err) => log.error('[nav] lỗi chụp NAV', { err })), everyMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Dựng lại NAV các ngày trước (tài khoản có từ trước khi có tính năng này): tiền mặt cuối ngày lấy từ sao kê,
   * số cổ phiếu cuối ngày cộng dồn từ lịch sử khớp, định giá theo giá đóng cửa trong ohlcv_daily.
   */
  async backfill(userId: string): Promise<number> {
    const before = this.market.tradeDate;
    const ledger = await this.db.many<{ type: string; amount: number; balance_after: number; d: string }>(
      `SELECT type, amount, balance_after, ((created_at AT TIME ZONE 'UTC') + INTERVAL '7 hours')::date::text AS d
       FROM transactions_ledger WHERE user_id = $1 ORDER BY id`,
      [userId],
    );
    if (!ledger.length || ledger[0].d >= before) return 0;
    const start = ledger[0].d;
    const trades = await this.db.many<{ symbol: string; side: string; qty: number; d: string }>(
      `SELECT symbol, side, qty, ((executed_at AT TIME ZONE 'UTC') + INTERVAL '7 hours')::date::text AS d FROM trades WHERE user_id = $1 ORDER BY id`,
      [userId],
    );
    const symbols = [...new Set(trades.map((t) => t.symbol))];
    const dates = (
      await this.db.many<{ d: string }>(`SELECT DISTINCT trade_date::text AS d FROM ohlcv_daily WHERE trade_date >= $1 AND trade_date < $2 ORDER BY 1`, [start, before])
    ).map((r) => r.d);
    if (!dates.length) return 0;
    const closes = new Map<string, Map<string, number>>();
    if (symbols.length) {
      const rows = await this.db.many<{ symbol: string; d: string; close: number }>(
        `SELECT symbol, trade_date::text AS d, close FROM ohlcv_daily WHERE trade_date >= $1 AND trade_date < $2
         AND symbol IN (${symbols.map((_, i) => `$${i + 3}`).join(',')})`,
        [dates[0], before, ...symbols],
      );
      for (const r of rows) {
        let m = closes.get(r.symbol);
        if (!m) closes.set(r.symbol, (m = new Map()));
        m.set(r.d, r.close);
      }
    }

    const qty = new Map<string, number>();
    const lastPx = new Map<string, number>();
    let li = 0;
    let ti = 0;
    let cash = 0;
    let contributed = 0;
    const out: unknown[][] = [];
    for (const d of dates) {
      while (li < ledger.length && ledger[li].d <= d) {
        const l = ledger[li++];
        cash = l.balance_after;
        if (l.type === 'DEPOSIT' || l.type === 'RESET') contributed = l.amount;
        if (l.type === 'ADJUST') contributed += l.amount;
      }
      while (ti < trades.length && trades[ti].d <= d) {
        const t = trades[ti++];
        qty.set(t.symbol, (qty.get(t.symbol) ?? 0) + (t.side === 'BUY' ? t.qty : -t.qty));
      }
      let stock = 0;
      for (const [sym, q] of qty) {
        const px = closes.get(sym)?.get(d);
        if (px) lastPx.set(sym, px);
        if (q > 0) stock += q * (lastPx.get(sym) ?? 0);
      }
      out.push([userId, d, cash + stock, cash, stock, 0, contributed]);
    }
    for (let i = 0; i < out.length; i += 500) {
      const part = out.slice(i, i + 500);
      const params: unknown[] = [];
      const values = part.map((r, j) => {
        params.push(...r);
        const b = j * 7;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
      });
      await this.db.many(
        `INSERT INTO nav_daily (user_id, trade_date, nav, cash, stock_value, debt, contributed) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`,
        params,
      );
    }
    return out.length;
  }
}

/** Tên hiển thị công khai: tên tự đặt, hoặc viết tắt họ tên ("Nguyễn Văn An" → "N.V. An") — không bao giờ lộ email */
export function publicName(fullName: string, displayName: string | null): string {
  if (displayName && displayName.trim()) return displayName.trim();
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return words[0] ?? 'Nhà đầu tư';
  return `${words
    .slice(0, -1)
    .map((w) => `${w[0]!.toUpperCase()}.`)
    .join('')} ${words[words.length - 1]}`;
}
