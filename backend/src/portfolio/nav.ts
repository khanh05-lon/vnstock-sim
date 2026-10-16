import type { Database } from '../db';
import { log } from '../lib/logger';
import { navOf, type UsdtPricer } from '../trading/account';

/** Ngày UTC (YYYY-MM-DD) — sàn coin chốt số liệu ngày theo 00:00 UTC như Binance */
export const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface NavBreakdown {
  /** Tổng tài sản quy USDT */
  nav: number;
  contributed: number;
}

/** Tên hiển thị công khai: tên tự đặt, hoặc viết tắt họ + tên (không lộ email) */
export function publicName(fullName: string, displayName: string | null): string {
  if (displayName && displayName.trim()) return displayName.trim();
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return words[0] ?? 'Nhà đầu tư';
  return `${words
    .slice(0, -1)
    .map((w) => `${w[0]!.toUpperCase()}.`)
    .join('')} ${words[words.length - 1]}`;
}

export class NavService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private db: Database,
    private market: UsdtPricer,
  ) {}

  /** Tổng tài sản hiện tại (USDT) của 1 hoặc nhiều tài khoản (null = tất cả) */
  async current(userIds: string[] | null): Promise<Map<string, NavBreakdown>> {
    const filter = userIds ? `WHERE user_id IN (${userIds.map((_, i) => `$${i + 1}`).join(',') || 'NULL'})` : '';
    const params = userIds ?? [];
    const accts = await this.db.many<{ user_id: string; contributed_usdt: string }>(`SELECT user_id, contributed_usdt FROM accounts ${filter}`, params);
    const bals = await this.db.many<{ user_id: string; asset: string; free: string; locked: string }>(
      `SELECT user_id, asset, free, locked FROM balances ${filter}`,
      params,
    );
    const byUser = new Map<string, typeof bals>();
    for (const b of bals) {
      const list = byUser.get(b.user_id);
      if (list) list.push(b);
      else byUser.set(b.user_id, [b]);
    }
    const out = new Map<string, NavBreakdown>();
    for (const a of accts) {
      out.set(a.user_id, { nav: navOf(byUser.get(a.user_id) ?? [], this.market).toNumber(), contributed: Number(a.contributed_usdt) });
    }
    return out;
  }

  /** Ghi tổng tài sản của mọi tài khoản cho ngày UTC hiện tại (ghi đè trong ngày, lần cuối = chốt ngày) */
  async snapshotAll(day = utcDay()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const rows = [...(await this.current(null)).entries()];
      for (let i = 0; i < rows.length; i += 500) {
        const part = rows.slice(i, i + 500);
        const params: unknown[] = [];
        const values = part.map(([uid, n], j) => {
          params.push(uid, day, n.nav.toFixed(8), n.contributed.toFixed(8));
          const b = j * 4;
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},now())`;
        });
        await this.db.many(
          `INSERT INTO nav_daily (user_id, day, nav_usdt, contributed_usdt, updated_at) VALUES ${values.join(',')}
           ON CONFLICT (user_id, day) DO UPDATE SET nav_usdt = EXCLUDED.nav_usdt, contributed_usdt = EXCLUDED.contributed_usdt, updated_at = now()`,
          params,
        );
      }
      return rows.length;
    } finally {
      this.running = false;
    }
  }

  /** Lịch sử tổng tài sản theo ngày (kèm điểm hiện tại) */
  async history(userId: string, days: number): Promise<{ date: string; nav: number; contributed: number }[]> {
    const today = utcDay();
    const since = days ? addDays(today, -days) : '1900-01-01';
    const rows = await this.db.many<{ d: string; nav_usdt: string; contributed_usdt: string }>(
      `SELECT day::text AS d, nav_usdt, contributed_usdt FROM nav_daily WHERE user_id = $1 AND day >= $2 AND day < $3 ORDER BY day`,
      [userId, since, today],
    );
    const points = rows.map((r) => ({ date: r.d, nav: Number(r.nav_usdt), contributed: Number(r.contributed_usdt) }));
    const cur = (await this.current([userId])).get(userId);
    if (cur) points.push({ date: today, nav: cur.nav, contributed: cur.contributed });
    return points;
  }

  /** Chụp định kỳ (mặc định 5 phút) — điểm cuối của mỗi ngày UTC chính là số chốt ngày */
  start(everyMs = 5 * 60_000) {
    if (this.timer) return;
    let lastDay = utcDay();
    this.timer = setInterval(() => {
      const day = utcDay();
      // Vừa qua 00:00 UTC: chốt lần cuối cho ngày cũ trước khi ghi ngày mới
      const run = day !== lastDay ? this.snapshotAll(lastDay).then(() => this.snapshotAll(day)) : this.snapshotAll(day);
      lastDay = day;
      void run.catch((err) => log.error('[nav] lỗi chụp tổng tài sản', { err }));
    }, everyMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
