import { useState } from 'react';
import { Download } from 'lucide-react';
import type { MonthlyReportRow } from '@vss/shared';
import { cn, downloadCsv, fmtUsd, signTone, toneText } from '../../lib/format';
import { useMonthlyReport } from '../../lib/queries';
import { Empty, Spinner } from '../common/ui';

type Col = { key: keyof Omit<MonthlyReportRow, 'month'>; label: string; hint: string; signed?: boolean };

const COLS: Col[] = [
  { key: 'trades', label: 'Số lần khớp', hint: 'Số lần lệnh được khớp trong tháng' },
  { key: 'tradedValue', label: 'Giá trị khớp (USDT)', hint: 'Tổng giá trị mua + bán' },
  { key: 'fees', label: 'Phí (USDT)', hint: 'Tổng phí quy USDT, đã tính trong lãi/lỗ' },
  { key: 'realizedPnl', label: 'Lãi/lỗ đã thực hiện (USDT)', hint: 'Của các lần bán theo giá vốn bình quân, đã trừ phí', signed: true },
];

const money = (v: number, signed?: boolean, key?: string) => (v === 0 ? '--' : key === 'trades' ? String(v) : `${signed && v > 0 ? '+' : ''}${fmtUsd(v)}`);
const monthLabel = (m: string) => `Tháng ${Number(m.slice(5, 7))}`;

/** Báo cáo lãi / lỗ theo tháng (tab trong trang Lịch sử) */
export function MonthlyReport({ defaultYear }: { defaultYear: number }) {
  const [year, setYear] = useState(defaultYear);
  const { data, isLoading } = useMonthlyReport(year);
  const max = Math.max(1, ...(data?.months ?? []).map((m) => Math.abs(m.realizedPnl)));

  const exportCsv = () => {
    if (!data) return;
    downloadCsv(
      `bao-cao-lai-lo-${year}.csv`,
      ['Tháng', ...COLS.map((c) => c.label)],
      [...data.months.map((m) => [m.month, ...COLS.map((c) => m[c.key])]), ['Cả năm', ...COLS.map((c) => data.total[c.key])]],
    );
  };

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3">
        <label>
          <span className="label">Năm</span>
          <select className="input mt-1 h-8 w-28" value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Chọn năm báo cáo">
            {(data?.years ?? [year]).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <p className="max-w-xl text-[12px] text-tx-3">
          Lãi/lỗ đã thực hiện tính cho các lần bán theo giá vốn bình quân của coin, đã trừ phí. Tháng tính theo giờ UTC. Lãi/lỗ của coin đang nắm giữ (chưa
          bán) xem ở trang Ví.
        </p>
        <button className="btn btn-ghost ml-auto h-8" onClick={exportCsv} disabled={!data?.months.length}>
          <Download size={14} /> Xuất CSV
        </button>
      </div>
      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : !data?.months.length ? (
        <Empty title={`Chưa có giao dịch nào trong năm ${year}`} />
      ) : (
        <div className="overflow-x-auto">
          <table className="tbl num w-full min-w-[720px] text-[12px]">
            <thead>
              <tr className="h-9 text-right">
                <th className="px-4 text-left">Tháng</th>
                {COLS.map((c) => (
                  <th key={c.key} className="px-2" title={c.hint}>
                    {c.label}
                  </th>
                ))}
                <th className="w-40 px-4 text-left">So sánh</th>
              </tr>
            </thead>
            <tbody>
              {data.months.map((m) => (
                <tr key={m.month} className="h-9 border-t border-line text-right">
                  <td className="px-4 text-left font-medium">{monthLabel(m.month)}</td>
                  {COLS.map((c) => (
                    <td key={c.key} className={cn('px-2', c.signed && m[c.key] !== 0 && toneText[signTone(m[c.key])], c.key === 'realizedPnl' && 'font-semibold')}>
                      {money(m[c.key], c.signed, c.key)}
                    </td>
                  ))}
                  <td className="px-4">
                    <div className="h-2 rounded-sm bg-bg-3">
                      <div className={cn('h-2 rounded-sm', m.realizedPnl >= 0 ? 'bg-up' : 'bg-down')} style={{ width: `${(Math.abs(m.realizedPnl) / max) * 100}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
              <tr className="h-10 border-t-2 border-line text-right font-semibold">
                <td className="px-4 text-left">Cả năm {year}</td>
                {COLS.map((c) => (
                  <td key={c.key} className={cn('px-2', c.signed && data.total[c.key] !== 0 && toneText[signTone(data.total[c.key])])}>
                    {money(data.total[c.key], c.signed, c.key)}
                  </td>
                ))}
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
