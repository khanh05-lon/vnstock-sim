import { useEffect, useState } from 'react';
import { Download, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { PRIVACY_EXPORTS_PER_DAY, PRIVACY_STATUS_LABEL } from '@vss/shared';
import { Empty, Modal } from '../components/common/ui';
import { api, errMsg } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useMyPrivacyRequests } from '../lib/fees';
import { useAuth } from '../store/auth';

/** Quyền của chủ thể dữ liệu: tải dữ liệu cá nhân, yêu cầu xoá tài khoản (DPO xử lý) */
export default function PrivacyPage() {
  const user = useAuth((s) => s.user);
  const { data: requests } = useMyPrivacyRequests();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(false);
  const [reason, setReason] = useState('');
  const pending = requests?.find((r) => r.status === 'PENDING');

  useEffect(() => {
    document.title = 'Dữ liệu cá nhân · VNCoin';
    return () => void (document.title = 'VNCoin · Sàn giao dịch coin mô phỏng');
  }, []);

  const download = async () => {
    setBusy(true);
    try {
      const data = await api<unknown>('/privacy/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `vncoin-du-lieu-ca-nhan-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      void qc.invalidateQueries({ queryKey: ['privacy'] });
      setAsk(false);
      setReason('');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (user?.role && user.role !== 'USER') return <Empty title="Tài khoản nhân viên xử lý dữ liệu qua Quản trị hệ thống" />;
  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-5 sm:px-6">
      <h1 className="text-[26px] font-bold tracking-tight">Dữ liệu cá nhân</h1>
      <p className="mt-1 max-w-[75ch] text-[13px] text-tx-2">
        Bạn có quyền xem và tải toàn bộ dữ liệu cá nhân VNCoin đang lưu, và yêu cầu xoá tài khoản. Yêu cầu xoá do người phụ trách bảo vệ dữ liệu cá nhân (DPO) xử lý.
      </p>

      <section className="mt-5 panel p-5">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold">
          <Download size={17} className="text-brand" /> Tải dữ liệu của tôi
        </h2>
        <p className="mt-1 text-[13px] text-tx-2">
          File JSON gồm hồ sơ, xác minh danh tính (số giấy tờ chỉ hiện 4 số cuối), số dư, lệnh, khớp lệnh, biến động số dư, đơn P2P, sao kê ngân hàng giả lập, yêu cầu hỗ trợ và
          lịch sử đăng nhập. Tối đa {PRIVACY_EXPORTS_PER_DAY} lần / ngày.
        </p>
        <button className="btn btn-brand mt-3" disabled={busy} onClick={() => void download()}>
          <Download size={15} /> Tải xuống
        </button>
      </section>

      <section className="mt-4 panel p-5">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold">
          <Trash2 size={17} className="text-down" /> Xoá tài khoản
        </h2>
        <ul className="mt-2 space-y-1 text-[13px] text-tx-2">
          <li>• Email, họ tên, hồ sơ xác minh và thông tin đăng nhập được ẩn danh; bạn không đăng nhập lại được.</li>
          <li>• Lịch sử giao dịch (lệnh, khớp, sổ cái, đơn P2P) được giữ ở dạng ẩn danh theo nghĩa vụ lưu trữ đối soát và phòng chống rửa tiền.</li>
          <li>• Cần hoàn tất mọi đơn P2P đang xử lý và nghỉ làm thương nhân (nếu có) trước khi xoá.</li>
        </ul>
        {pending ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md bg-ref/10 px-3 py-2 text-[13px] text-ref">
            <ShieldCheck size={16} />
            Yêu cầu #{pending.id} gửi lúc {fmtDateTime(pending.createdAt)} đang chờ xử lý.
            <button
              className="font-semibold underline-offset-2 hover:underline"
              disabled={busy}
              onClick={() => void run(() => api(`/privacy/requests/${pending.id}`, { method: 'DELETE' }), 'Đã rút yêu cầu')}
            >
              Rút yêu cầu
            </button>
          </div>
        ) : (
          <button className="btn btn-ghost mt-3 text-down" onClick={() => setAsk(true)}>
            Yêu cầu xoá tài khoản
          </button>
        )}
        {!!requests?.length && (
          <ul className="mt-4 divide-y divide-line border-t border-line text-[12px]">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span>
                  #{r.id} · {fmtDateTime(r.createdAt)} · {r.reason}
                </span>
                <span className="text-tx-3">
                  {PRIVACY_STATUS_LABEL[r.status]}
                  {r.decisionNote && ` · ${r.decisionNote}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal
        open={ask}
        onClose={() => setAsk(false)}
        title="Yêu cầu xoá tài khoản"
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setAsk(false)}>
              Huỷ
            </button>
            <button
              className="btn btn-down"
              disabled={busy || reason.trim().length < 5}
              onClick={() => void run(() => api('/privacy/requests', { method: 'POST', body: { reason } }), 'Đã gửi yêu cầu xoá')}
            >
              Gửi yêu cầu
            </button>
          </>
        }
      >
        <label className="block text-[13px]">
          <span className="label">Lý do (tối thiểu 5 ký tự)</span>
          <textarea className="input mt-1 h-24 py-2" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      </Modal>
    </div>
  );
}
