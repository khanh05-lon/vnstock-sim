import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleX } from 'lucide-react';
import { PRIVACY_STATUS_LABEL, type PrivacyRequestDTO } from '@vss/shared';
import { useAdminAction } from '../../lib/admin';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { Empty, Spinner } from '../common/ui';
import { Pill, ReasonModal, Section } from './adminUi';

/**
 * Bảo vệ dữ liệu cá nhân (DPO, quyền privacy.manage): xử lý yêu cầu xoá tài khoản của khách.
 * Chấp thuận = ẩn danh thông tin cá nhân, dữ liệu giao dịch giữ lại theo nghĩa vụ lưu trữ. Chỉ chấp thuận khi mọi điều kiện đạt.
 */
export function PrivacyAdmin() {
  const [status, setStatus] = useState('PENDING');
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'privacy', status],
    queryFn: () => api<PrivacyRequestDTO[]>(`/admin/privacy/requests?status=${status}`),
  });
  const act = useAdminAction();
  const [target, setTarget] = useState<{ r: PrivacyRequestDTO; approve: boolean } | null>(null);

  return (
    <Section
      title="Yêu cầu xoá tài khoản"
      pad={false}
      actions={
        <select className="input h-8 w-auto text-[12px]" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Lọc trạng thái">
          <option value="PENDING">Chờ xử lý</option>
          <option value="APPROVED">Đã xoá</option>
          <option value="REJECTED">Bị từ chối</option>
          <option value="CANCELLED">Khách đã rút</option>
          <option value="ALL">Tất cả</option>
        </select>
      }
    >
      <p className="px-4 pt-3 text-[12px] text-tx-3">
        Xoá = ẩn danh email, họ tên, hồ sơ xác minh; tài khoản không đăng nhập được nữa. Lệnh, khớp, sổ cái, đơn P2P, tin nhắn hỗ trợ được giữ ở dạng ẩn danh (nghĩa vụ lưu
        trữ đối soát và phòng chống rửa tiền). Có nghĩa vụ giữ tài khoản thì chuyển bộ phận Tuân thủ, không nêu lý do với khách.
      </p>
      {isLoading ? (
        <Spinner className="m-4" />
      ) : !data?.length ? (
        <Empty title="Không có yêu cầu" />
      ) : (
        <ul className="divide-y divide-line">
          {data.map((r) => {
            const ready = r.checks?.every((c) => c.ok) ?? false;
            return (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-[13px]">
                <div className="min-w-0">
                  <div className="font-medium">
                    {r.accountName} <span className="font-normal text-tx-3">{r.email}</span>
                  </div>
                  <div className="text-[12px] text-tx-3">
                    #{r.id} · gửi {fmtDateTime(r.createdAt)} · lý do: {r.reason}
                  </div>
                  {r.checks && (
                    <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
                      {r.checks.map((c) => (
                        <li key={c.key} className="flex items-center gap-1">
                          {c.ok ? <CheckCircle2 size={13} className="text-up" /> : <CircleX size={13} className="text-down" />}
                          {c.label} <span className="text-tx-3">({c.detail})</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {r.status !== 'PENDING' && (
                    <div className="mt-1 text-[12px] text-tx-3">
                      {PRIVACY_STATUS_LABEL[r.status]}
                      {r.decidedBy && ` · ${r.decidedBy}`}
                      {r.decidedAt && ` · ${fmtDateTime(r.decidedAt)}`}
                      {r.decisionNote && ` · ${r.decisionNote}`}
                    </div>
                  )}
                </div>
                {r.status === 'PENDING' ? (
                  <div className="flex gap-2">
                    <button className="btn btn-down h-8" disabled={!ready} title={ready ? '' : 'Chưa đủ điều kiện'} onClick={() => setTarget({ r, approve: true })}>
                      Xoá (ẩn danh)
                    </button>
                    <button className="btn btn-ghost h-8" onClick={() => setTarget({ r, approve: false })}>
                      Từ chối
                    </button>
                  </div>
                ) : (
                  <Pill tone={r.status === 'APPROVED' ? 'bad' : 'muted'}>{PRIVACY_STATUS_LABEL[r.status]}</Pill>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <ReasonModal
        open={!!target}
        title={target?.approve ? `Xoá tài khoản ${target.r.email}` : 'Từ chối yêu cầu xoá'}
        description={
          target?.approve
            ? 'Không hoàn tác được. Lệnh đang mở bị huỷ, khách bị đăng xuất, nhận email xác nhận trước khi email bị ẩn danh.'
            : 'Lý do được gửi cho khách qua email.'
        }
        confirmLabel={target?.approve ? 'Xoá (ẩn danh)' : 'Từ chối'}
        danger={target?.approve}
        requireReason={!target?.approve}
        placeholder={target?.approve ? 'Ghi chú (tuỳ chọn)' : 'Lý do từ chối'}
        onClose={() => setTarget(null)}
        onConfirm={(note) =>
          target
            ? act(`/admin/privacy/requests/${target.r.id}/decide`, 'POST', { approve: target.approve, note }, target.approve ? 'Đã xoá tài khoản (ẩn danh)' : 'Đã từ chối').then(() =>
                setTarget(null),
              )
            : undefined
        }
      />
    </Section>
  );
}
