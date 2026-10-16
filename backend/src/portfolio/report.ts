import type { MonthlyReportDTO, MonthlyReportRow } from '@vss/shared';
import type { Queryable } from '../db';

/** Tháng theo giờ Việt Nam của 1 cột thời gian */
const vnMonth = (col: string) => `to_char(${col} AT TIME ZONE 'UTC' + INTERVAL '7 hours', 'YYYY-MM')`;

const empty = (month: string): MonthlyReportRow => ({
  month,
  tradedValue: 0,
  realizedPnl: 0,
  fees: 0,
  sellTax: 0,
  income: 0,
  maturityProceeds: 0,
  depositInterest: 0,
  financingCost: 0,
  net: 0,
});

/**
 * Báo cáo lãi / lỗ theo tháng của 1 năm: lãi lỗ đã thực hiện từ lệnh khớp, cổ tức và lãi trái phiếu (sau thuế),
 * lãi tiền gửi, chi phí vốn (lãi vay ký quỹ, phí ứng trước). Thuế của lệnh bán có ghi chú "lệnh #" trong sao kê,
 * nên thuế còn lại (TAX không gắn lệnh) là thuế cổ tức / lãi trái phiếu / chứng quyền.
 */
export async function monthlyReport(db: Queryable, userId: string, year: number): Promise<MonthlyReportDTO> {
  const from = `${year}-01`;
  const to = `${year}-12`;
  const trades = await db.many<{ m: string; value: number; pnl: number; fee: number; tax: number }>(
    `SELECT ${vnMonth('executed_at')} AS m, sum(value)::float8 AS value, COALESCE(sum(realized_pnl), 0)::float8 AS pnl,
            sum(fee)::float8 AS fee, sum(tax)::float8 AS tax
     FROM trades WHERE user_id = $1 GROUP BY 1 HAVING ${vnMonth('executed_at')} BETWEEN $2 AND $3`,
    [userId, from, to],
  );
  const ledger = await db.many<{ m: string; type: string; trade_tax: boolean; amount: number }>(
    `SELECT ${vnMonth('created_at')} AS m, type, (type = 'TAX' AND COALESCE(note, '') LIKE '%lệnh #%') AS trade_tax, sum(amount)::float8 AS amount
     FROM transactions_ledger
     WHERE user_id = $1 AND type IN ('DIVIDEND', 'COUPON', 'TAX', 'CW_SETTLE', 'BOND_REDEEM', 'INTEREST', 'MARGIN_INTEREST', 'ADVANCE_FEE')
     GROUP BY 1, 2, 3 HAVING ${vnMonth('created_at')} BETWEEN $2 AND $3`,
    [userId, from, to],
  );
  const rows = new Map<string, MonthlyReportRow>();
  const row = (m: string) => rows.get(m) ?? rows.set(m, empty(m)).get(m)!;
  for (const t of trades) {
    const r = row(t.m);
    r.tradedValue += t.value;
    r.realizedPnl += t.pnl;
    r.fees += t.fee;
    r.sellTax += t.tax;
  }
  for (const l of ledger) {
    const r = row(l.m);
    if (l.type === 'DIVIDEND' || l.type === 'COUPON') r.income += l.amount;
    else if (l.type === 'TAX' && !l.trade_tax) r.income += l.amount; // thuế âm: trừ vào thu nhập cổ tức / coupon / CW
    else if (l.type === 'CW_SETTLE' || l.type === 'BOND_REDEEM') r.maturityProceeds += l.amount;
    else if (l.type === 'INTEREST') r.depositInterest += l.amount;
    else if (l.type === 'MARGIN_INTEREST' || l.type === 'ADVANCE_FEE') r.financingCost += -l.amount;
  }
  const months = [...rows.values()].sort((a, b) => a.month.localeCompare(b.month));
  for (const r of months) r.net = r.realizedPnl + r.income + r.depositInterest - r.financingCost;
  const keys = Object.keys(empty('')).filter((k) => k !== 'month') as (keyof Omit<MonthlyReportRow, 'month'>)[];
  const total = Object.fromEntries(keys.map((k) => [k, months.reduce((s, r) => s + r[k], 0)])) as Omit<MonthlyReportRow, 'month'>;
  const ys = await db.many<{ y: number }>(
    `SELECT DISTINCT y FROM (
       SELECT extract(year FROM executed_at AT TIME ZONE 'UTC' + INTERVAL '7 hours')::int AS y FROM trades WHERE user_id = $1
       UNION SELECT extract(year FROM created_at AT TIME ZONE 'UTC' + INTERVAL '7 hours')::int FROM transactions_ledger WHERE user_id = $1
     ) x ORDER BY y DESC`,
    [userId],
  );
  const years = ys.map((x) => Number(x.y));
  if (!years.includes(year)) years.unshift(year);
  return { year, months, total, years: years.sort((a, b) => b - a) };
}
