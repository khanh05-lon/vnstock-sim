import type { MonthlyReportDTO, MonthlyReportRow } from '@vss/shared';
import type { Queryable } from '../db';

const utcMonth = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM')`;

const empty = (month: string): MonthlyReportRow => ({ month, tradedValue: 0, realizedPnl: 0, fees: 0, trades: 0 });

/**
 * Báo cáo theo tháng (UTC) của 1 năm: tổng giá trị khớp (USDT), lãi / lỗ đã thực hiện của lệnh bán
 * theo giá vốn bình quân (đã trừ phí), tổng phí quy USDT, số lần khớp.
 */
export async function monthlyReport(db: Queryable, userId: string, year: number): Promise<MonthlyReportDTO> {
  const rows = await db.many<{ m: string; value: number; pnl: number; fee: number; n: number }>(
    `SELECT ${utcMonth('executed_at')} AS m, sum(quote_qty)::float8 AS value, COALESCE(sum(realized_pnl), 0)::float8 AS pnl,
            sum(commission_usdt)::float8 AS fee, count(*)::int AS n
     FROM fills WHERE user_id = $1 GROUP BY 1 HAVING ${utcMonth('executed_at')} BETWEEN $2 AND $3 ORDER BY 1`,
    [userId, `${year}-01`, `${year}-12`],
  );
  const months: MonthlyReportRow[] = [];
  for (let i = 1; i <= 12; i++) {
    const m = `${year}-${String(i).padStart(2, '0')}`;
    const r = rows.find((x) => x.m === m);
    months.push(r ? { month: m, tradedValue: r.value, realizedPnl: r.pnl, fees: r.fee, trades: r.n } : empty(m));
  }
  const total = months.reduce(
    (a, m) => ({ tradedValue: a.tradedValue + m.tradedValue, realizedPnl: a.realizedPnl + m.realizedPnl, fees: a.fees + m.fees, trades: a.trades + m.trades }),
    { tradedValue: 0, realizedPnl: 0, fees: 0, trades: 0 },
  );
  const ys = await db.many<{ y: number }>(
    `SELECT DISTINCT extract(year FROM executed_at AT TIME ZONE 'UTC')::int AS y FROM fills WHERE user_id = $1 ORDER BY 1`,
    [userId],
  );
  const years = ys.map((r) => r.y);
  if (!years.includes(year)) years.push(year);
  return { year, months, total, years: years.sort() };
}
