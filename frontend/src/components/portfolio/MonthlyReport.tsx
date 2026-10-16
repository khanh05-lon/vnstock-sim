import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import type { MonthlyReportDTO, MonthlyReportRow } from '@vss/shared';
import { api } from '../../lib/api';
import { cn, downloadCsv, fmtVnd, signTone, toneText } from '../../lib/format';
import { useLoggedIn } from '../../lib/queries';
import { Empty, Spinner } from '../common/ui';

type Col = { key: keyof Omit<MonthlyReportRow, 'month'>; label: string; hint: string; signed?: boolean };

const COLS: Col[] = [
  { key: 'tradedValue', label: 'Giá trị khớp', hint: 'Tổng giá trị mua + bán' },
  { key: 'realizedPnl', label: 'Lãi/lỗ đã thực hiện', hint: 'Của các lần bán, đã trừ phí mua, phí bán, thuế bán', signed: true },
  { key: 'fees', label: 'Phí GD', hint: 'Đã tính trong lãi/lỗ đã thực hiện' },
  { key: 'sellTax', label: 'Thuế bán', hint: 'Đã tính trong lãi/lỗ đã thực hiện' },
  { key: 'income', label: 'Cổ tức, lãi TP', hint: 'Cổ tức tiền, lãi trái phiếu, sau thuế 5%', signed: true },
  { key: 'depositInterest', label: 'Lãi tiền gửi', hint: 'Lãi không kỳ hạn trên tiền nhàn rỗi', signed: true },
  { key: 'financingCost', label: 'Chi phí vốn', hint: 'Lãi vay ký quỹ đã trả + phí ứng trước tiền bán' },
  { key: 'maturityProceeds', label: 'Nhận đáo hạn CW/TP', hint: 'Tiền thanh toán khi chứng quyền / trái phiếu đáo hạn (không phải lãi)' },
  { key: 'net', label: 'Kết quả ròng', hint: 'Lãi/lỗ đã thực hiện + cổ tức, lãi TP + lãi tiền gửi − chi phí vốn', signed: true },
];

const money = (v: number, signed?: boolean) => (v === 0 ? '—' : `${signed && v > 0 ? '+' : ''}${fmtVnd(v)}`);
const monthLabel = (m: string) => `Tháng ${Number(m.slice(5, 7))}`;

/** Báo cáo lãi / lỗ theo tháng (tab trong trang Lịch sử) */
export function MonthlyReport({ defaultYear }: { defaultYear: number }) {
  const loggedIn = useLoggedIn();
  const [year, setYear] = useState(defaultYear);
  const { data, isLoading } = useQuery({
    queryKey: ['report-monthly', year],
    queryFn: () => api<MonthlyReportDTO>(`/reports/monthly?year=${year}`),
    enabled: loggedIn,
  });
  const max = Math.max(1, ...(data?.months ?? []).map((m) => Math.abs(m.net)));

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
          Kết quả ròng = lãi/lỗ đã thực hiện (đã trừ phí, thuế) + cổ tức, lãi trái phiếu (sau thuế) + lãi tiền gửi − lãi vay ký quỹ, phí ứng trước. Lãi/lỗ của cổ
          phiếu đang nắm (chưa bán) xem ở trang Tài sản.
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
        <Empty title={`Chưa có giao dịch hay thu nhập nào trong năm ${year}`} />
      ) : (
        <div className="overflow-x-auto">
          <table className="tbl num w-full min-w-[1100px] text-[12px]">
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
                    <td key={c.key} className={cn('px-2', c.signed && m[c.key] !== 0 && toneText[signTone(m[c.key])], c.key === 'net' && 'font-semibold')}>
                      {money(m[c.key], c.signed)}
                    </td>
                  ))}
                  <td className="px-4">
                    <div className="h-2 rounded-sm bg-bg-3">
                      <div className={cn('h-2 rounded-sm', m.net >= 0 ? 'bg-up' : 'bg-down')} style={{ width: `${(Math.abs(m.net) / max) * 100}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
              <tr className="h-10 border-t-2 border-line text-right font-semibold">
                <td className="px-4 text-left">Cả năm {year}</td>
                {COLS.map((c) => (
                  <td key={c.key} className={cn('px-2', c.signed && data.total[c.key] !== 0 && toneText[signTone(data.total[c.key])])}>
                    {money(data.total[c.key], c.signed)}
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
