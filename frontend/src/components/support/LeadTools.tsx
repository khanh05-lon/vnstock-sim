import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AdjustRequestDTO } from '@vss/shared';
import { api, errMsg } from '../../lib/api';
import { cn, fmtDateTime } from '../../lib/format';
import { Empty, Modal, Spinner } from '../common/ui';
import { Pill, ReasonModal } from '../admin/adminUi';

type Compensation = AdjustRequestDTO & { leadCanApprove: boolean };

/**
 * Bồi hoàn chờ duyệt (Trưởng nhóm CSKH, quyền support.compensate): khoản cộng tiền nhỏ (≤ hạn mức) do nhân viên CSKH
 * đề xuất từ yêu cầu hỗ trợ thì Trưởng nhóm duyệt; lớn hơn / trừ tiền chỉ xem, do Tài chính duyệt.
 */
export function CompensationQueue() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['desk', 'compensations'],
    queryFn: () => api<{ limitUsdt: number; items: Compensation[] }>('/support-desk/compensations'),
    refetchInterval: 30_000,
  });
  const [reject, setReject] = useState<Compensation | null>(null);
  const decide = async (c: Compensation, decision: 'approve' | 'reject', note?: string) => {
    try {
      await api(`/support-desk/compensations/${c.id}/${decision}`, { method: 'POST', body: note ? { note } : {} });
      toast.success(decision === 'approve' ? 'Đã duyệt bồi hoàn' : 'Đã từ chối');
      void qc.invalidateQueries({ queryKey: ['desk'] });
      return true;
    } catch (e) {
      toast.error(errMsg(e));
      return false;
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <h2 className="text-[15px] font-semibold">Bồi hoàn chờ duyệt</h2>
      <p className="mt-1 text-[12px] text-tx-3">
        Trưởng nhóm duyệt được khoản cộng tiền tới {data?.limitUsdt ?? '…'} USDT do nhân viên CSKH đề xuất. Lớn hơn hoặc trừ tiền phải do Tài chính duyệt. Không duyệt đề xuất của chính mình.
      </p>
      <div className="panel mt-3 overflow-x-auto">
        {isLoading ? (
          <Spinner className="m-4" />
        ) : !data?.items.length ? (
          <Empty title="Không có bồi hoàn chờ duyệt" />
        ) : (
          <table className="tbl w-full min-w-[760px] text-[12.5px]">
            <thead>
              <tr className="h-8 text-left">
                <th className="px-4">Khách hàng</th>
                <th className="px-2 text-right">Số lượng</th>
                <th className="px-2 text-right">≈ USDT</th>
                <th className="px-2">Lý do · yêu cầu</th>
                <th className="px-2">Đề xuất</th>
                <th className="px-4 text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((c) => (
                <tr key={c.id} className="border-t border-line align-top">
                  <td className="px-4 py-2">{c.user.email}</td>
                  <td className={cn('num px-2 py-2 text-right font-semibold', Number(c.amount) > 0 ? 'text-up' : 'text-down')}>
                    {Number(c.amount) > 0 ? '+' : ''}
                    {c.amount} {c.asset}
                  </td>
                  <td className="num px-2 py-2 text-right">{Math.abs(Number(c.usdtValue)).toFixed(2)}</td>
                  <td className="px-2 py-2 text-tx-2">
                    {c.reason}
                    {c.ticketId && <div className="text-[11px] text-tx-3">Yêu cầu #{c.ticketId}</div>}
                  </td>
                  <td className="px-2 py-2 text-[12px] text-tx-3">
                    {c.requestedByEmail}
                    <div>{fmtDateTime(c.createdAt)}</div>
                  </td>
                  <td className="px-4 py-2 text-right">
                    {c.leadCanApprove ? (
                      <div className="flex justify-end gap-1">
                        <button className="btn btn-up h-7 px-2 text-[12px]" onClick={() => void decide(c, 'approve')}>
                          Duyệt
                        </button>
                        <button className="btn btn-ghost h-7 px-2 text-[12px] text-down" onClick={() => setReject(c)}>
                          Từ chối
                        </button>
                      </div>
                    ) : (
                      <Pill tone="muted">Chờ Tài chính</Pill>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <ReasonModal
        open={!!reject}
        title="Từ chối bồi hoàn"
        confirmLabel="Từ chối"
        danger
        placeholder="Lý do (ghi vào yêu cầu hỗ trợ)"
        onClose={() => setReject(null)}
        onConfirm={async (note) => {
          if (reject && (await decide(reject, 'reject', note))) setReject(null);
        }}
      />
    </div>
  );
}

/**
 * Khôi phục quyền truy cập (tắt 2FA) cho chủ yêu cầu hỗ trợ — Trưởng nhóm CSKH, quyền account.recovery.
 * Bắt buộc đối chiếu danh tính với hồ sơ KYC: 4 ký tự cuối số giấy tờ khách đọc được + họ tên. Sai thì máy chủ ghi nhật ký.
 */
export function Recovery2faModal({ open, ticketId, onClose, onDone }: { open: boolean; ticketId: number; onClose(): void; onDone(): void }) {
  const [last4, setLast4] = useState('');
  const [named, setNamed] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setLast4('');
      setNamed(false);
      setReason('');
    }
  }, [open]);
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/support-desk/tickets/${ticketId}/reset-2fa`, { method: 'POST', body: { idLast4: last4, nameConfirmed: true, reason } });
      toast.success('Đã tắt 2FA, khách nhận email và tin nhắn trong yêu cầu');
      onDone();
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Khôi phục quyền truy cập (tắt 2FA)"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn btn-down" disabled={busy || last4.length !== 4 || !named || reason.trim().length < 5} onClick={() => void submit()}>
            Tắt 2FA
          </button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        <p className="text-tx-2">
          Chỉ làm khi khách mất thiết bị và hết mã khôi phục. Hỏi khách 4 ký tự cuối số giấy tờ đã khai khi xác minh danh tính; không đọc gợi ý cho khách. Nhập sai được ghi
          vào nhật ký quản trị.
        </p>
        <label className="block">
          <span className="label">4 ký tự cuối số giấy tờ (khách cung cấp)</span>
          <input className="input num mt-1 w-32 uppercase" maxLength={4} value={last4} onChange={(e) => setLast4(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
        </label>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--brand)]" checked={named} onChange={(e) => setNamed(e.target.checked)} />
          <span>Khách đọc đúng họ tên trên giấy tờ (đã đối chiếu với hồ sơ KYC)</span>
        </label>
        <label className="block">
          <span className="label">Lý do / cách xác minh</span>
          <input className="input mt-1" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Ví dụ: Khách mất điện thoại, đã gọi lại số đăng ký" />
        </label>
      </div>
    </Modal>
  );
}
