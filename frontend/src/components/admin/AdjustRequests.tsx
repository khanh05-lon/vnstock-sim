import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ADJUST_STATUS_LABEL, type AdjustRequestDTO } from '@vss/shared';
import { useAdminAction, useAdminMe } from '../../lib/admin';
import { cn, fmtDateTime, fmtQty, fmtUsd } from '../../lib/format';
import { useAdjustRequests } from '../../lib/support';
import { useAuth } from '../../store/auth';
import { Empty, Spinner } from '../common/ui';
import { Pill, ReasonModal, Section } from './adminUi';

const TONE: Record<AdjustRequestDTO['status'], 'warn' | 'good' | 'bad' | 'muted'> = { PENDING: 'warn', APPROVED: 'good', REJECTED: 'bad', CANCELLED: 'muted' };

/** Yêu cầu điều chỉnh số dư chờ quản trị viên thứ hai duyệt (nguyên tắc 2 người) */
export function AdjustRequests() {
  const [status, setStatus] = useState<'PENDING' | 'ALL'>('PENDING');
  const { data, isLoading } = useAdjustRequests(status);
  const me = useAuth((s) => s.user);
  const act = useAdminAction();
  const canDecide = useAdminMe().can('finance.approve');
  const [deciding, setDeciding] = useState<{ r: AdjustRequestDTO; approve: boolean } | null>(null);

  return (
    <Section
      title="Duyệt điều chỉnh số dư"
      pad={false}
      actions={
        <select className="input h-8 w-40" value={status} onChange={(e) => setStatus(e.target.value as 'PENDING' | 'ALL')} aria-label="Lọc trạng thái">
          <option value="PENDING">Chờ duyệt</option>
          <option value="ALL">Tất cả</option>
        </select>
      }
    >
      <p className="border-b border-line px-4 py-2 text-[12px] text-tx-3">
        Điều chỉnh từ ngưỡng phê duyệt trở lên (cấu hình ADJUST_APPROVAL_USDT) và mọi đề xuất bồi hoàn của nhân viên CSKH phải được một người KHÁC thuộc bộ phận Tài chính
        duyệt. Người đề xuất không tự duyệt được; quyết định được ghi vào nhật ký quản trị và sổ cái của khách.
      </p>
      {isLoading ? (
        <Spinner className="m-6" />
      ) : !data?.length ? (
        <Empty title={status === 'PENDING' ? 'Không có yêu cầu nào chờ duyệt' : 'Chưa có yêu cầu nào'} />
      ) : (
        <div className="overflow-x-auto">
          <table className="tbl num w-full min-w-[900px] text-[12px]">
            <thead>
              <tr className="h-8 text-left">
                <th className="px-3">#</th>
                <th className="px-2">Thời gian</th>
                <th className="px-2">Khách hàng</th>
                <th className="px-2 text-right">Số lượng</th>
                <th className="px-2 text-right">≈ USDT</th>
                <th className="px-2">Lý do</th>
                <th className="px-2">Người đề xuất</th>
                <th className="px-2">Trạng thái</th>
                <th className="px-3 text-right" />
              </tr>
            </thead>
            <tbody>
              {data.map((r) => {
                const mine = r.requestedByEmail === me?.email;
                return (
                  <tr key={r.id} className="border-t border-line align-top">
                    <td className="px-3 py-2 text-tx-3">#{r.id}</td>
                    <td className="px-2 py-2">{fmtDateTime(r.createdAt)}</td>
                    <td className="px-2 py-2">{r.user.email}</td>
                    <td className={cn('px-2 py-2 text-right font-semibold', Number(r.amount) > 0 ? 'text-up' : 'text-down')}>
                      {Number(r.amount) > 0 ? '+' : ''}
                      {fmtQty(r.amount)} {r.asset}
                    </td>
                    <td className="px-2 py-2 text-right">{fmtUsd(r.usdtValue)}</td>
                    <td className="min-w-[200px] max-w-[300px] whitespace-normal px-2 py-2 text-tx-2">
                      {r.reason}
                      {r.ticketId && (
                        <Link to={`/cskh?ticket=${r.ticketId}`} className="ml-1 text-brand hover:underline">
                          (yêu cầu hỗ trợ #{r.ticketId})
                        </Link>
                      )}
                    </td>
                    <td className="px-2 py-2">{r.requestedByEmail}</td>
                    <td className="px-2 py-2">
                      <Pill tone={TONE[r.status]}>{ADJUST_STATUS_LABEL[r.status]}</Pill>
                      {r.decidedByEmail && (
                        <div className="mt-0.5 text-tx-3">
                          {r.decidedByEmail} · {r.decidedAt ? fmtDateTime(r.decidedAt) : ''}
                          {r.decisionNote ? ` · ${r.decisionNote}` : ''}
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {r.status === 'PENDING' &&
                        (mine ? (
                          <span className="text-tx-3">Chờ Tài chính khác duyệt</span>
                        ) : !canDecide ? (
                          <span className="text-tx-3">Chờ Tài chính duyệt</span>
                        ) : (
                          <>
                            <button className="btn btn-up h-7 text-[12px]" onClick={() => setDeciding({ r, approve: true })}>
                              Duyệt
                            </button>{' '}
                            <button className="btn btn-ghost h-7 text-[12px] text-down" onClick={() => setDeciding({ r, approve: false })}>
                              Từ chối
                            </button>
                          </>
                        ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ReasonModal
        open={!!deciding}
        danger={deciding?.approve === false}
        title={deciding?.approve ? `Duyệt yêu cầu #${deciding?.r.id}` : `Từ chối yêu cầu #${deciding?.r.id}`}
        description={deciding ? `${Number(deciding.r.amount) > 0 ? 'Cộng' : 'Trừ'} ${fmtQty(deciding.r.amount.replace('-', ''))} ${deciding.r.asset} cho ${deciding.r.user.email}. Lý do: ${deciding.r.reason}` : ''}
        confirmLabel={deciding?.approve ? 'Duyệt và áp dụng' : 'Từ chối'}
        requireReason={deciding?.approve === false}
        placeholder="Lý do từ chối"
        onClose={() => setDeciding(null)}
        onConfirm={async (note) => {
          if (!deciding) return;
          const ok = await act(`/admin/adjust-requests/${deciding.r.id}/${deciding.approve ? 'approve' : 'reject'}`, 'POST', { note: note || undefined }, deciding.approve ? 'Đã duyệt và áp dụng' : 'Đã từ chối');
          if (ok) setDeciding(null);
        }}
      />
    </Section>
  );
}
