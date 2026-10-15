import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { changePasswordSchema, RULES } from '@vss/shared';
import { api, errMsg } from '../../lib/api';
import { fmtInt } from '../../lib/format';
import { Modal, UnderlineTabs } from '../common/ui';

export function AccountSettingsModal({ open, onClose, initialTab = 'password' }: { open: boolean; onClose(): void; initialTab?: 'password' | 'reset' }) {
  const [tab, setTab] = useState<'password' | 'reset'>(initialTab);
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  const changePassword = async () => {
    const parsed = changePasswordSchema.safeParse({ currentPassword: cur, newPassword: next });
    if (!parsed.success) return toast.error(parsed.error.issues[0]?.message);
    setBusy(true);
    try {
      await api('/auth/change-password', { method: 'POST', body: parsed.data });
      toast.success('Đã đổi mật khẩu');
      setCur('');
      setNext('');
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      await api('/account/reset', { method: 'POST' });
      await qc.invalidateQueries();
      toast.success(`Tài khoản đã được đặt lại về ${fmtInt(RULES.initialCapital)}đ`);
      setConfirmText('');
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Cài đặt tài khoản" width={460}>
      <UnderlineTabs
        className="-mx-5 -mt-4 mb-4"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'password', label: 'Đổi mật khẩu' },
          { value: 'reset', label: 'Đặt lại tài khoản ảo' },
        ]}
      />
      {tab === 'password' ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void changePassword();
          }}
        >
          <label className="block">
            <span className="label">Mật khẩu hiện tại</span>
            <input className="input mt-1" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
          </label>
          <label className="block">
            <span className="label">Mật khẩu mới (≥ 8 ký tự, có chữ và số)</span>
            <input className="input mt-1" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </label>
          <button className="btn btn-brand w-full" disabled={busy || !cur || !next}>
            Cập nhật mật khẩu
          </button>
        </form>
      ) : (
        <div className="space-y-3">
          <p className="text-tx-2">
            Toàn bộ lệnh, lịch sử khớp, danh mục và sao kê sẽ bị xoá. Tiền mặt trở về <b className="text-tx-1">{fmtInt(RULES.initialCapital)}đ</b>. Thao tác không thể
            hoàn tác.
          </p>
          <label className="block">
            <span className="label">
              Gõ <b className="text-tx-1">DAT LAI</b> để xác nhận
            </span>
            <input className="input mt-1" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
          </label>
          <button className="btn btn-down w-full" disabled={busy || confirmText.trim().toUpperCase() !== 'DAT LAI'} onClick={() => void reset()}>
            Đặt lại tài khoản
          </button>
        </div>
      )}
    </Modal>
  );
}
