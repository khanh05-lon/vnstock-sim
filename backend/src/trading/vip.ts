import { Router } from 'express';
import { Big, RULES, VIP_RULES, feesFor, scaledTiers, vipLevelFor, type Dec, type VipStatusDTO } from '@vss/shared';
import type { Database, Queryable } from '../db';
import { requireAuth, type AuthedRequest } from '../lib/auth';
import { ah } from '../lib/errors';
import { log } from '../lib/logger';

/*
 * Cấp VIP phí Spot (như Binance): đạt cấp khi CẢ khối lượng Spot 30 ngày (tổng fills.quote_qty, USDT) VÀ số BNB nắm giữ
 * đủ ngưỡng (ngưỡng thật × VIP_RULES.scale). Tính lại 1 lần mỗi ngày sau 00:00 UTC; phí chốt vào lệnh lúc đặt (engine).
 */

const META_KEY = 'vip.lastRunDay';
const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

/** Cấp VIP hiện tại của 1 người (đọc trong transaction đặt lệnh) */
export async function vipLevelOf(q: Queryable, userId: string): Promise<number> {
  const r = await q.one<{ vip_level: number }>('SELECT vip_level FROM users WHERE id = $1', [userId]);
  return Number(r?.vip_level ?? 0);
}

export class VipService {
  private timer: NodeJS.Timeout | null = null;
  /** Báo khách khi cấp thay đổi (làm mới ví / phí) */
  notify: (userId: string) => void = () => undefined;

  constructor(private db: Database) {}

  /** Tính lại cấp cho mọi khách hàng. Trả về số người đổi cấp */
  async recomputeAll(now = new Date()): Promise<number> {
    const since = new Date(now.getTime() - 30 * 86_400_000);
    const rows = await this.db.many<{ id: string; vol: string; bnb: string; vip_level: number }>(
      `WITH v AS (SELECT user_id, sum(quote_qty) AS s FROM fills WHERE executed_at > $1 AND executed_at <= $2 GROUP BY user_id),
            b AS (SELECT user_id, free + locked AS bnb FROM balances WHERE asset = 'BNB')
       SELECT u.id, COALESCE(v.s, 0)::text AS vol, COALESCE(b.bnb, 0)::text AS bnb, u.vip_level
       FROM users u LEFT JOIN v ON v.user_id = u.id LEFT JOIN b ON b.user_id = u.id
       WHERE u.role = 'USER' AND u.status <> 'DELETED'`,
      [since, now],
    );
    let changed = 0;
    await this.db.tx(async (tx) => {
      for (const r of rows) {
        const level = vipLevelFor(Number(r.vol), Number(r.bnb));
        if (level !== Number(r.vip_level)) changed++;
        await tx.many('UPDATE users SET vip_level = $2, vip_volume_30d = $3, vip_updated_at = $4 WHERE id = $1', [r.id, level, r.vol, now]);
      }
      await tx.many(
        `INSERT INTO market_meta (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [META_KEY, JSON.stringify(utcDay(now))],
      );
    });
    for (const r of rows) if (vipLevelFor(Number(r.vol), Number(r.bnb)) !== Number(r.vip_level)) this.notify(r.id);
    return changed;
  }

  /** Chạy nếu hôm nay (UTC) chưa tính */
  async runIfNewDay(now = new Date()): Promise<boolean> {
    const last = await this.db.one<{ value: string }>('SELECT value FROM market_meta WHERE key = $1', [META_KEY]);
    if (last?.value === utcDay(now)) return false;
    const n = await this.recomputeAll(now);
    log.info('[vip] đã tính lại cấp VIP', { changed: n });
    return true;
  }

  start(intervalMs = 10 * 60_000) {
    this.stop();
    void this.runIfNewDay().catch((err) => log.error('[vip] lỗi tính cấp VIP', { err }));
    this.timer = setInterval(() => void this.runIfNewDay().catch((err) => log.error('[vip] lỗi tính cấp VIP', { err })), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async status(userId: string): Promise<VipStatusDTO> {
    const u = await this.db.one<{ vip_level: number; vip_volume_30d: string; vip_updated_at: Date | null }>(
      'SELECT vip_level, vip_volume_30d, vip_updated_at FROM users WHERE id = $1',
      [userId],
    );
    const now = await this.db.one<{ s: string }>(
      `SELECT COALESCE(sum(quote_qty), 0)::text AS s FROM fills WHERE user_id = $1 AND executed_at > now() - interval '30 days'`,
      [userId],
    );
    const bnb = await this.db.one<{ t: string }>(`SELECT (free + locked)::text AS t FROM balances WHERE user_id = $1 AND asset = 'BNB'`, [userId]);
    const level = Number(u?.vip_level ?? 0);
    const f = feesFor(level);
    return {
      level,
      volume30d: new Big(u?.vip_volume_30d ?? 0).toFixed(),
      volumeNow: new Big(now?.s ?? 0).toFixed(),
      bnb: new Big(bnb?.t ?? 0).toFixed(),
      updatedAt: u?.vip_updated_at ? new Date(u.vip_updated_at).toISOString() : null,
      maker: f.maker,
      taker: f.taker,
      scale: VIP_RULES.scale,
      tiers: feeTable(),
    };
  }
}

/** Bảng phí đầy đủ (ngưỡng đã nhân hệ số), VIP 0 là phí cơ bản */
export function feeTable(): VipStatusDTO['tiers'] {
  return [
    { level: 0, volumeUsdt: 0, bnb: 0, maker: RULES.makerFee as Dec, taker: RULES.takerFee as Dec },
    ...scaledTiers().map((t) => ({ level: t.level, volumeUsdt: t.volumeUsdt, bnb: t.bnb, ...feesFor(t.level) })),
  ];
}

/** /api/fees (công khai: biểu phí) và /api/vip (cấp của tôi). Gắn TRƯỚC tradingRoutes */
export function vipRoutes(vip: VipService) {
  const r = Router();
  r.get('/fees', (_req, res) => {
    res.json({ scale: VIP_RULES.scale, bnbDiscount: RULES.bnbDiscount, tiers: feeTable() });
  });
  r.get(
    '/vip',
    requireAuth,
    ah(async (req, res) => res.json(await vip.status((req as AuthedRequest).user.id))),
  );
  return r;
}
