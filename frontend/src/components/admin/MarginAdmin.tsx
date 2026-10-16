import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RULES } from '@vss/shared';
import { api } from '../../lib/api';
import { useAdminAction } from '../../lib/admin';
import { cn, fmtCompact, fmtInt, fmtVnd, parseIntInput } from '../../lib/format';
import { Empty, Spinner } from '../common/ui';
import { Kpi, Pill, ReasonModal, Section, fmtAgo } from './adminUi';

interface MarginRow {
  userId: string;
  email: string;
  fullName: string;
  creditLimit: number;
  loanBalance: number;
  loanInterest: number;
  loanHold: number;
  stockValue: number;
  ratio: number | null;
  status: 'NORMAL' | 'CALL' | 'FORCE';
  callAmount: number;
  callSince: string | null;
}

export function MarginAdmin({ onOpenUser }: { onOpenUser(id: string): void }) {
  const { data, isLoading } = useQuery({ queryKey: ['admin', 'margin'], queryFn: () => api<MarginRow[]>('/admin/margin'), refetchInterval: 15_000 });
  const act = useAdminAction();
  const [edit, setEdit] = useState<MarginRow | null>(null);
  const [limit, setLimit] = useState('');
  const m = RULES.margin;
  const rows = data ?? [];
  const totalLoan = rows.reduce((s, r) => s + r.loanBalance, 0);
  const calls = rows.filter((r) => r.status !== 'NORMAL').length;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Tài khoản đã kích hoạt" value={fmtInt(rows.length)} />
        <Kpi label="Tổng dư nợ" value={fmtCompact(totalLoan)} sub={`Lãi suất ${(m.interestRateYear * 100).toFixed(1)}%/năm`} />
        <Kpi label="Đang bị cảnh báo / xử lý" value={fmtInt(calls)} tone={calls ? 'text-down' : undefined} />
        <Kpi label="Ngưỡng ban đầu / duy trì / xử lý" value={`${m.initialRatio * 100}/${m.callRatio * 100}/${m.forceRatio * 100}%`} sub="Đổi ở Vận hành thị trường → Tham số" />
      </div>
      <Section title="Tài khoản ký quỹ" pad={false}>
        {isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : !rows.length ? (
          <Empty title="Chưa có tài khoản nào dùng ký quỹ" />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl num w-full min-w-[960px] text-[12.5px]">
              <thead>
                <tr className="h-9 text-left">
                  <th className="px-4">Nhà đầu tư</th>
                  <th className="px-2 text-right">Hạn mức</th>
                  <th className="px-2 text-right">Dư nợ gốc</th>
                  <th className="px-2 text-right">Lãi chưa trả</th>
                  <th className="px-2 text-right">Giá trị CK</th>
                  <th className="px-2 text-right">Tỷ lệ ký quỹ</th>
                  <th className="px-2">Trạng thái</th>
                  <th className="px-4" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.userId} className="h-11 border-t border-line">
                    <td className="px-4">
                      <button className="text-left hover:text-brand" onClick={() => onOpenUser(r.userId)}>
                        <div className="font-medium">{r.fullName}</div>
                        <div className="text-[11px] text-tx-3">{r.email}</div>
                      </button>
                    </td>
                    <td className="px-2 text-right">{fmtCompact(r.creditLimit)}</td>
                    <td className="px-2 text-right">{fmtVnd(r.loanBalance)}</td>
                    <td className="px-2 text-right">{fmtVnd(r.loanInterest)}</td>
                    <td className="px-2 text-right">{fmtCompact(r.stockValue)}</td>
                    <td className={cn('px-2 text-right font-semibold', r.ratio == null ? 'text-tx-3' : r.ratio < m.forceRatio ? 'text-down' : r.ratio < m.callRatio ? 'text-ref' : 'text-up')}>
                      {r.ratio == null ? '—' : `${(r.ratio * 100).toFixed(1)}%`}
                    </td>
                    <td className="px-2">
                      {r.status === 'FORCE' ? (
                        <Pill tone="bad">Xử lý</Pill>
                      ) : r.status === 'CALL' ? (
                        <span title={`Cần nộp ~${fmtVnd(r.callAmount)}đ`}>
                          <Pill tone="warn">Call {fmtAgo(r.callSince)}</Pill>
                        </span>
                      ) : (
                        <Pill tone="good">An toàn</Pill>
                      )}
                    </td>
                    <td className="px-4 text-right">
                      <button
                        className="text-[12px] text-brand hover:underline"
                        onClick={() => {
                          setLimit(fmtInt(r.creditLimit));
                          setEdit(r);
                        }}
                      >
                        Đổi hạn mức
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <ReasonModal
        open={!!edit}
        title={`Hạn mức vay của ${edit?.email ?? ''}`}
        description={edit ? `Dư nợ hiện tại ${fmtVnd(edit.loanBalance)}đ. Hạn mức mới chỉ áp dụng cho khoản vay mới; đặt 0 để ngừng cho vay thêm.` : undefined}
        confirmLabel="Lưu hạn mức"
        extra={<input className="input num" value={limit} onChange={(e) => setLimit(e.target.value ? fmtInt(parseIntInput(e.target.value)) : '')} />}
        onClose={() => setEdit(null)}
        onConfirm={async (reason) => {
          if (edit && (await act(`/admin/users/${edit.userId}/credit`, 'POST', { creditLimit: parseIntInput(limit), reason }, 'Đã cập nhật hạn mức'))) setEdit(null);
        }}
      />
    </div>
  );
}
