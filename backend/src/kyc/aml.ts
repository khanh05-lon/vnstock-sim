import { AML_RULES, AML_RULE_SEVERITY, type AmlRule } from '@vss/shared';
import type { Database, Queryable } from '../db';
import { log } from '../lib/logger';

/*
 * Giám sát chống rửa tiền (AML) theo quy tắc trên đơn P2P (tiền VNĐ vào / ra sàn chỉ đi qua P2P).
 * Mỗi (quy tắc, người dùng, ngày UTC) chỉ tạo 1 cảnh báo (dedupe_key UNIQUE). Cảnh báo không bao giờ báo cho khách
 * (nguyên tắc không tiết lộ) — chỉ bộ phận Tuân thủ thấy.
 */

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** Tạo cảnh báo (bỏ qua nếu hôm nay đã có cảnh báo cùng quy tắc cho người này). Trả về true nếu tạo mới */
export async function raiseAlert(q: Queryable, userId: string, rule: AmlRule, detail: Record<string, unknown>, now = new Date()): Promise<boolean> {
  const row = await q.one(
    `INSERT INTO aml_alerts (user_id, rule, severity, detail, dedupe_key) VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [userId, rule, AML_RULE_SEVERITY[rule], JSON.stringify(detail), `${rule}:${userId}:${utcDay(now)}`],
  );
  return !!row;
}

/**
 * Quét các quy tắc trên đơn P2P hoàn tất trong 24 giờ trước `now`. Trả về số cảnh báo mới.
 * Mỗi đơn có 2 bên (người mua, người bán) — quy tắc xét theo từng bên.
 */
export async function runAmlScan(db: Queryable, now = new Date()): Promise<number> {
  const R = AML_RULES;
  const since = new Date(now.getTime() - 24 * 60 * 60_000);
  // Bảng tạm theo bên: mỗi đơn hoàn tất → 2 dòng (người tham gia, chiều, đối tác)
  const parts = `WITH parts AS (
      SELECT o.id, o.fiat_amount::numeric AS fiat, o.buyer_id AS uid, 'IN' AS dir, o.seller_id AS cp
        FROM p2p_orders o WHERE o.status = 'COMPLETED' AND o.released_at > $1 AND o.released_at <= $2
      UNION ALL
      SELECT o.id, o.fiat_amount::numeric, o.seller_id, 'OUT', o.buyer_id
        FROM p2p_orders o WHERE o.status = 'COMPLETED' AND o.released_at > $1 AND o.released_at <= $2
    )`;
  const isMerchant = `EXISTS (SELECT 1 FROM p2p_merchants m WHERE m.user_id = p.uid AND m.status = 'ACTIVE')`;
  let created = 0;
  const add = async (rows: { uid: string }[], rule: AmlRule, detail: (r: any) => Record<string, unknown>) => {
    for (const r of rows) if (await raiseAlert(db, r.uid, rule, detail(r), now)) created++;
  };

  await add(
    await db.many(`${parts} SELECT uid, max(fiat)::text AS fiat, (array_agg(id ORDER BY fiat DESC))[1] AS order_id FROM parts p WHERE fiat >= $3 GROUP BY uid`, [
      since,
      now,
      R.largeOrderVnd,
    ]),
    'LARGE_P2P',
    (r) => ({ orderId: Number(r.order_id), fiatVnd: r.fiat, thresholdVnd: R.largeOrderVnd }),
  );

  await add(
    await db.many(`${parts} SELECT uid, sum(fiat)::text AS total, count(*)::int AS orders FROM parts p GROUP BY uid HAVING sum(fiat) >= $3`, [since, now, R.dailyVolumeVnd]),
    'HIGH_DAILY_VOLUME',
    (r) => ({ totalVnd: r.total, orders: r.orders, thresholdVnd: R.dailyVolumeVnd }),
  );

  await add(
    await db.many(
      `${parts} SELECT uid, count(*)::int AS orders, array_agg(id ORDER BY id) AS ids, sum(fiat)::text AS total FROM parts p
       WHERE fiat >= $3 AND fiat < $4 GROUP BY uid HAVING count(*) >= $5`,
      [since, now, Math.floor((R.largeOrderVnd * R.structuringLowPct) / 100), R.largeOrderVnd, R.structuringCount],
    ),
    'STRUCTURING',
    (r) => ({ orders: r.orders, orderIds: (r.ids as (string | number)[]).map(Number), totalVnd: r.total, thresholdVnd: R.largeOrderVnd }),
  );

  await add(
    await db.many(
      `${parts} SELECT uid, sum(fiat) FILTER (WHERE dir = 'IN')::text AS bought, sum(fiat) FILTER (WHERE dir = 'OUT')::text AS sold FROM parts p
       WHERE NOT ${isMerchant} GROUP BY uid
       HAVING COALESCE(sum(fiat) FILTER (WHERE dir = 'IN'), 0) >= $3 AND COALESCE(sum(fiat) FILTER (WHERE dir = 'OUT'), 0) >= $3`,
      [since, now, R.rapidInOutVnd],
    ),
    'RAPID_IN_OUT',
    (r) => ({ boughtVnd: r.bought, soldVnd: r.sold, thresholdVnd: R.rapidInOutVnd }),
  );

  await add(
    await db.many(
      `${parts} SELECT uid, count(DISTINCT cp)::int AS counterparties, count(*)::int AS orders FROM parts p
       WHERE NOT ${isMerchant} GROUP BY uid HAVING count(DISTINCT cp) >= $3`,
      [since, now, R.counterpartyCount],
    ),
    'MANY_COUNTERPARTIES',
    (r) => ({ counterparties: r.counterparties, orders: r.orders, threshold: R.counterpartyCount }),
  );

  return created;
}

/** Quét AML định kỳ (mặc định 10 phút / lần) */
export function startAmlSchedule(db: Database, intervalMs = 10 * 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const n = await runAmlScan(db);
      if (n) log.warn('[aml] có cảnh báo AML mới', { created: n });
    } catch (err) {
      log.error('[aml] lỗi quét AML', { err });
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 30_000);
  const timer = setInterval(() => void tick(), intervalMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
