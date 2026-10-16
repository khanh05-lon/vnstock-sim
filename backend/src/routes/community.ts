import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Database } from '../db';
import { verifyToken } from '../lib/auth';
import { addDays } from '../lib/calendar';
import { ah } from '../lib/errors';
import { publicName, type NavService, type PriceSource } from '../portfolio/nav';

export const LEADERBOARD_PERIODS = { '1W': 7, '1M': 30, '3M': 90, ALL: 0 } as const;
type Period = keyof typeof LEADERBOARD_PERIODS;

interface Entry {
  userId: string;
  name: string;
  visible: boolean;
  returnPct: number;
  nav: number;
  trades: number;
  topSymbol: string | null;
}

/**
 * Bảng xếp hạng công khai theo tỷ suất lợi nhuận.
 * - ALL: (NAV − vốn đã góp) / vốn đã góp.
 * - Theo kỳ: so với NAV cuối ngày đầu kỳ, trừ phần vốn góp thêm trong kỳ (Modified Dietz đơn giản).
 * Chỉ gồm nhà đầu tư đang hoạt động, đã có ít nhất 1 lệnh khớp và không chọn ẩn; tên hiển thị không lộ email.
 */
export function communityRoutes(db: Database, nav: NavService, market: PriceSource) {
  const r = Router();
  const cache = new Map<Period, { at: number; rows: Entry[] }>();

  const compute = async (period: Period): Promise<Entry[]> => {
    const hit = cache.get(period);
    if (hit && Date.now() - hit.at < 30_000) return hit.rows;
    const days = LEADERBOARD_PERIODS[period];
    const since = days ? addDays(market.tradeDate, -days) : null;
    const users = await db.many<{ id: string; full_name: string; display_name: string | null; show_on_leaderboard: boolean; trades: number; period_trades: number }>(
      `SELECT u.id, u.full_name, u.display_name, u.show_on_leaderboard,
              (SELECT count(*)::int FROM trades t WHERE t.user_id = u.id) AS trades,
              (SELECT count(*)::int FROM trades t WHERE t.user_id = u.id AND ($1::date IS NULL OR (t.executed_at AT TIME ZONE 'UTC' + INTERVAL '7 hours')::date > $1::date)) AS period_trades
       FROM users u WHERE u.role = 'USER' AND u.status = 'ACTIVE'`,
      [since],
    );
    const navs = await nav.current(null);
    const base = new Map<string, { nav: number; contributed: number }>();
    if (since) {
      const rows = await db.many<{ user_id: string; nav: number; contributed: number }>(
        `SELECT DISTINCT ON (user_id) user_id, nav, contributed FROM nav_daily WHERE trade_date <= $1 ORDER BY user_id, trade_date DESC`,
        [since],
      );
      for (const b of rows) base.set(b.user_id, { nav: Number(b.nav), contributed: Number(b.contributed) });
    }
    const tops = await db.many<{ user_id: string; symbol: string; qty_total: number }>('SELECT user_id, symbol, qty_total FROM holdings');
    const top = new Map<string, { symbol: string; value: number }>();
    // mã chiếm tỷ trọng lớn nhất trong danh mục (theo giá hiện hành)
    for (const h of tops) {
      const v = h.qty_total * market.markPrice(h.symbol);
      const cur = top.get(h.user_id);
      if (!cur || v > cur.value) top.set(h.user_id, { symbol: h.symbol, value: v });
    }

    const out: Entry[] = [];
    for (const u of users) {
      const n = navs.get(u.id);
      if (!n || u.trades < 1 || n.contributed <= 0) continue;
      let ret: number;
      const b = base.get(u.id);
      if (since && b && b.nav > 0) {
        const flows = n.contributed - b.contributed;
        ret = (n.nav - b.nav - flows) / (b.nav + Math.max(flows, 0));
      } else {
        ret = (n.nav - n.contributed) / n.contributed;
      }
      out.push({
        userId: u.id,
        name: publicName(u.full_name, u.display_name),
        visible: u.show_on_leaderboard,
        returnPct: Math.round(ret * 10_000) / 100,
        nav: n.nav,
        trades: since ? u.period_trades : u.trades,
        topSymbol: top.get(u.id)?.symbol ?? null,
      });
    }
    out.sort((a, b) => b.returnPct - a.returnPct || b.nav - a.nav);
    cache.set(period, { at: Date.now(), rows: out });
    return out;
  };

  const viewer = (req: Request): string | null => {
    const h = req.headers.authorization ?? '';
    return h.startsWith('Bearer ') ? (verifyToken(h.slice(7))?.id ?? null) : null;
  };

  r.get(
    '/leaderboard',
    ah(async (req, res) => {
      const { period, limit } = z
        .object({ period: z.enum(['1W', '1M', '3M', 'ALL']).default('ALL'), limit: z.coerce.number().int().min(10).max(200).default(100) })
        .parse(req.query);
      const all = await compute(period);
      const visible = all.filter((e) => e.visible);
      const me = viewer(req);
      const mine = me ? all.find((e) => e.userId === me) : undefined;
      res.json({
        period,
        updatedAt: new Date(cache.get(period)?.at ?? Date.now()).toISOString(),
        total: visible.length,
        rows: visible.slice(0, limit).map((e, i) => ({
          rank: i + 1,
          name: e.name,
          returnPct: e.returnPct,
          nav: e.nav,
          trades: e.trades,
          topSymbol: e.topSymbol,
          isMe: e.userId === me,
        })),
        me: mine
          ? {
              rank: mine.visible ? visible.indexOf(mine) + 1 : null,
              hidden: !mine.visible,
              returnPct: mine.returnPct,
              nav: mine.nav,
              name: mine.name,
            }
          : null,
      });
    }),
  );

  return r;
}
