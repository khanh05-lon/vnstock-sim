import { useState } from 'react';
import {
  APPROVAL_KIND_LABEL,
  APPROVAL_PERMISSION,
  APPROVAL_STATUS_LABEL,
  ROLE_LABEL,
  rolesWith,
  type ApprovalDTO,
  type ApprovalStatus,
  type UserRole,
} from '@vss/shared';
import { useAdminAction, useAdminMe, useApprovals } from '../../lib/admin';
import { fmtDateTime } from '../../lib/format';
import { useAuth } from '../../store/auth';
import { Empty, Spinner } from '../common/ui';
import { Pill, ReasonModal, Section } from './adminUi';

const TONE: Record<ApprovalStatus, 'warn' | 'good' | 'bad' | 'muted'> = {
  PENDING: 'warn',
  APPROVED: 'good',
  REJECTED: 'bad',
  CANCELLED: 'muted',
  EXPIRED: 'muted',
  FAILED: 'bad',
};

const minutesLeft = (iso: string) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 60_000));

/** Ai được duyệt loại đề xuất này (theo vai trò) */
const approversOf = (a: ApprovalDTO) =>
  rolesWith(APPROVAL_PERMISSION[a.kind])
    .map((r) => ROLE_LABEL[r])
    .join(' hoặc ');

/** Thao tác lớn chờ người thứ hai duyệt: chỉnh giá lớn, niêm yết / huỷ niêm yết, tạm ngừng toàn sàn, khôi phục dữ liệu */
export function OperationApprovals() {
  const [status, setStatus] = useState<'PENDING' | 'ALL'>('PENDING');
  const { data, isLoading } = useApprovals(status);
  const me = useAdminMe();
  const myEmail = useAuth((s) => s.user?.email);
  const act = useAdminAction();
  const [deciding, setDeciding] = useState<{ a: ApprovalDTO; approve: boolean } | null>(null);

  return (
    <Section
      title="Thao tác lớn chờ duyệt"
      pad={false}
      actions={
        <select className="input h-8 w-40" value={status} onChange={(e) => setStatus(e.target.value as 'PENDING' | 'ALL')} aria-label="Lọc trạng thái">
          <option value="PENDING">Chờ duyệt</option>
          <option value="ALL">Tất cả</option>
        </select>
      }
    >
      <p className="border-b border-line px-4 py-2 text-[12px] text-tx-3">
        Chỉnh giá lớn, niêm yết / huỷ niêm yết, tạm ngừng toàn sàn (duyệt: Vận hành thị trường hoặc Rủi ro & giám sát), cấp vai trò nhân viên và khôi phục dữ liệu (duyệt: Quản trị hệ thống), đặt lại tài khoản khách (duyệt: Tài chính)
        chỉ được thực hiện khi một người KHÁC người đề xuất bấm duyệt. Đề xuất có hạn chờ; quá hạn phải đề xuất lại. Mọi bước ghi vào nhật ký quản trị.
      </p>
      {isLoading ? (
        <Spinner className="m-6" />
      ) : !data?.length ? (
        <Empty title={status === 'PENDING' ? 'Không có đề xuất nào chờ duyệt' : 'Chưa có đề xuất nào'} />
      ) : (
        <div className="overflow-x-auto">
          <table className="tbl w-full min-w-[960px] text-[12px]">
            <thead>
              <tr className="h-8 text-left">
                <th className="px-3">#</th>
                <th className="px-2">Thời gian</th>
                <th className="px-2">Loại</th>
                <th className="px-2">Nội dung</th>
                <th className="px-2">Người đề xuất</th>
                <th className="px-2">Trạng thái</th>
                <th className="px-3 text-right" />
              </tr>
            </thead>
            <tbody>
              {data.map((a) => {
                const mine = a.requestedByEmail === myEmail;
                const canDecide = me.can(APPROVAL_PERMISSION[a.kind]);
                const error = a.status === 'FAILED' && typeof a.result?.error === 'string' ? a.result.error : null;
                return (
                  <tr key={a.id} className="border-t border-line align-top">
                    <td className="px-3 py-2 text-tx-3">#{a.id}</td>
                    <td className="whitespace-nowrap px-2 py-2">{fmtDateTime(a.createdAt)}</td>
                    <td className="whitespace-nowrap px-2 py-2 font-semibold">{APPROVAL_KIND_LABEL[a.kind]}</td>
                    <td className="min-w-[260px] max-w-[380px] whitespace-normal px-2 py-2">
                      <div className="num">{a.summary}</div>
                      <div className="mt-0.5 text-tx-2">Lý do: {a.reason}</div>
                    </td>
                    <td className="px-2 py-2">
                      {a.requestedByEmail}
                      <div className="text-tx-3">{ROLE_LABEL[a.requestedRole as UserRole] ?? a.requestedRole}</div>
                    </td>
                    <td className="max-w-[220px] whitespace-normal px-2 py-2">
                      <Pill tone={TONE[a.status]}>{APPROVAL_STATUS_LABEL[a.status]}</Pill>
                      {a.status === 'PENDING' && <div className="mt-0.5 text-tx-3">còn {minutesLeft(a.expiresAt)} phút</div>}
                      {a.decidedByEmail && (
                        <div className="mt-0.5 text-tx-3">
                          {a.decidedByEmail} · {a.decidedAt ? fmtDateTime(a.decidedAt) : ''}
                          {a.decisionNote ? ` · ${a.decisionNote}` : ''}
                        </div>
                      )}
                      {error && <div className="mt-0.5 text-down">{error}</div>}
                    </td>
                    <td className="max-w-[240px] whitespace-normal px-3 py-2 text-right">
                      {a.status === 'PENDING' &&
                        (mine ? (
                          <>
                            <span className="text-tx-3">Chờ {approversOf(a)} khác duyệt</span>{' '}
                            <button
                              className="btn btn-ghost h-7 text-[12px]"
                              onClick={() => void act(`/admin/approvals/${a.id}/cancel`, 'POST', {}, `Đã rút đề xuất #${a.id}`)}
                            >
                              Rút đề xuất
                            </button>
                          </>
                        ) : canDecide ? (
                          <>
                            <button className="btn btn-up h-7 text-[12px]" onClick={() => setDeciding({ a, approve: true })}>
                              Duyệt
                            </button>{' '}
                            <button className="btn btn-ghost h-7 text-[12px] text-down" onClick={() => setDeciding({ a, approve: false })}>
                              Từ chối
                            </button>
                          </>
                        ) : (
                          <span className="text-tx-3">Chờ {approversOf(a)} duyệt</span>
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
        danger={deciding?.approve === false || deciding?.a.kind === 'DATA_RESTORE'}
        title={deciding ? `${deciding.approve ? 'Duyệt' : 'Từ chối'} đề xuất #${deciding.a.id}: ${APPROVAL_KIND_LABEL[deciding.a.kind]}` : ''}
        description={
          deciding ? (
            <>
              <div className="num">{deciding.a.summary}</div>
              <div className="mt-1">
                Người đề xuất: {deciding.a.requestedByEmail}. Lý do: {deciding.a.reason}
              </div>
              {deciding.approve && <div className="mt-2 text-[12px] text-tx-3">Bấm duyệt là hệ thống thực hiện ngay, nhật ký ghi bạn là người duyệt và thực hiện.</div>}
            </>
          ) : null
        }
        confirmLabel={deciding?.approve ? 'Duyệt và thực hiện' : 'Từ chối'}
        requireReason={deciding?.approve === false}
        placeholder="Lý do từ chối"
        onClose={() => setDeciding(null)}
        onConfirm={async (note) => {
          if (!deciding) return;
          const ok = await act(
            `/admin/approvals/${deciding.a.id}/${deciding.approve ? 'approve' : 'reject'}`,
            'POST',
            { note: note || undefined },
            deciding.approve ? `Đã duyệt và thực hiện đề xuất #${deciding.a.id}` : `Đã từ chối đề xuất #${deciding.a.id}`,
          );
          if (ok) setDeciding(null);
        }}
      />
    </Section>
  );
}
