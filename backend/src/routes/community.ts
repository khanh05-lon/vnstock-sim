import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Database } from '../db';
import { verifyToken } from '../lib/auth';
import { ah } from '../lib/errors';
import { addDays, publicName, utcDay, type NavService } from '../portfolio/nav';
import type { UsdtPricer } from '../trading/account';

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
 * Mốc ngày theo UTC; topSymbol = coin chiếm tỷ trọng lớn nhất (không tính USDT).
 */
export function communityRoutes(db: Database, nav: NavService, market: UsdtPricer) {
  const r = Router();
  const cache = new Map<Period, { at: number; rows: Entry[] }>();

  const compute = async (period: Period): Promise<Entry[]> => {
    const hit = cache.get(period);
    if (hit && Date.now() - hit.at < 30_000) return hit.rows;
    const days = LEADERBOARD_PERIODS[period];
    const since = days ? addDays(utcDay(), -days) : null;
    const users = await db.many<{ id: string; full_name: string; display_name: string | null; show_on_leaderboard: boolean; trades: number; period_trades: number }>(
      `SELECT u.id, u.full_name, u.display_name, u.show_on_leaderboard,
              (SELECT count(*)::int FROM fills t WHERE t.user_id = u.id) AS trades,
              (SELECT count(*)::int FROM fills t WHERE t.user_id = u.id AND ($1::date IS NULL OR (t.executed_at AT TIME ZONE 'UTC')::date > $1::date)) AS period_trades
       FROM users u WHERE u.role = 'USER' AND u.status = 'ACTIVE' AND u.leaderboard_banned_at IS NULL`,
      [since],
    );
    const navs = await nav.current(null);
    const base = new Map<string, { nav: number; contributed: number }>();
    if (since) {
      const rows = await db.many<{ user_id: string; nav_usdt: string; contributed_usdt: string }>(
        `SELECT DISTINCT ON (user_id) user_id, nav_usdt, contributed_usdt FROM nav_daily WHERE day <= $1 ORDER BY user_id, day DESC`,
        [since],
      );
      for (const b of rows) base.set(b.user_id, { nav: Number(b.nav_usdt), contributed: Number(b.contributed_usdt) });
    }
    const bals = await db.many<{ user_id: string; asset: string; total: string }>(
      `SELECT user_id, asset, (free + locked)::text AS total FROM balances WHERE asset <> 'USDT' AND free + locked > 0`,
    );
    const top = new Map<string, { symbol: string; value: number }>();
    for (const h of bals) {
      const v = Number(h.total) * Number(market.priceUsdt(h.asset) ?? 0);
      const cur = top.get(h.user_id);
      if (!cur || v > cur.value) top.set(h.user_id, { symbol: h.asset, value: v });
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
