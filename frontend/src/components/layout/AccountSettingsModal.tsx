import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, ShieldCheck, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { changePasswordSchema, preferencesSchema, RULES, type UserDTO } from '@vss/shared';
import { api, errMsg } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useAuth } from '../../store/auth';
import { Modal, Spinner, UnderlineTabs } from '../common/ui';

type Tab = 'password' | 'security' | 'prefs' | 'reset';

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange(v: boolean): void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2">
      <span>
        <span className="block text-tx-1">{label}</span>
        {hint && <span className="block text-[12px] text-tx-3">{hint}</span>}
      </span>
      <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[var(--brand)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone(): void }) {
  const text = `Mã khôi phục 2FA — VNStock Sim\nMỗi mã dùng được 1 lần khi mất điện thoại.\n\n${codes.join('\n')}\n`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'vnstock-ma-khoi-phuc-2fa.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-tx-2">
        Lưu 10 mã khôi phục sau ở nơi an toàn (trình quản lý mật khẩu, giấy cất kỹ). Khi mất điện thoại, mỗi mã dùng được <b>1 lần</b> để đăng nhập.
        Mã chỉ hiển thị <b>một lần duy nhất</b>.
      </p>
      <div className="num grid grid-cols-2 gap-2 rounded-lg bg-bg-2 p-3 text-center text-[14px] tracking-wider">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="flex gap-2">
        <button className="btn btn-ghost flex-1" onClick={download}>
          <Download size={14} /> Tải về .txt
        </button>
        <button
          className="btn btn-ghost flex-1"
          onClick={() => void navigator.clipboard.writeText(text).then(() => toast.success('Đã sao chép mã khôi phục'), () => toast.error('Không sao chép được'))}
        >
          <Copy size={14} /> Sao chép
        </button>
      </div>
      <button className="btn btn-brand w-full" onClick={onDone}>
        Tôi đã lưu mã khôi phục
      </button>
    </div>
  );
}

function TwoFactorPanel() {
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const status = useQuery({ queryKey: ['2fa'], queryFn: () => api<{ enabled: boolean; enabledAt: string | null; recoveryCodesLeft: number }>('/auth/2fa') });
  const [step, setStep] = useState<'idle' | 'password' | 'scan' | 'codes' | 'disable' | 'regen'>('idle');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setStep('idle');
    setPassword('');
    setCode('');
    setSetup(null);
  };
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['2fa'] });
    void qc.invalidateQueries({ queryKey: ['me'] });
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (status.isLoading) return <Spinner />;
  const enabled = status.data?.enabled ?? false;

  if (step === 'codes') {
    return (
      <RecoveryCodes
        codes={codes}
        onDone={() => {
          setCodes([]);
          reset();
          refresh();
        }}
      />
    );
  }

  if (step === 'scan' && setup) {
    return (
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await api<{ recoveryCodes: string[] }>('/auth/2fa/enable', { method: 'POST', body: { code } });
            if (user) useAuth.getState().setUser({ ...user, twoFactorEnabled: true });
            toast.success('Đã bật xác thực 2 lớp');
            setCodes(r.recoveryCodes);
            setStep('codes');
          });
        }}
      >
        <p className="text-[13px] text-tx-2">
          1. Mở ứng dụng xác thực (Google Authenticator, Microsoft Authenticator, Authy…) và quét mã QR. 2. Nhập mã 6 số đang hiển thị.
        </p>
        <div className="flex flex-col items-center gap-2 sm:flex-row sm:items-start">
          <img
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(setup.qrSvg)}`}
            alt="Mã QR thiết lập xác thực 2 lớp"
            className="h-40 w-40 rounded-lg bg-white p-2"
          />
          <div className="min-w-0 flex-1 text-[12px] text-tx-3">
            Không quét được? Nhập khoá thủ công:
            <div className="num mt-1 break-all rounded bg-bg-2 p-2 text-[13px] tracking-wider text-tx-1">{setup.secret.match(/.{1,4}/g)?.join(' ')}</div>
          </div>
        </div>
        <input
          className="input num h-11 text-center text-[18px] tracking-[0.3em]"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          autoFocus
        />
        <div className="flex gap-2">
          <button type="button" className="btn btn-ghost flex-1" onClick={reset}>
            Huỷ
          </button>
          <button className="btn btn-brand flex-1" disabled={busy || code.length !== 6}>
            Xác nhận & bật
          </button>
        </div>
      </form>
    );
  }

  if (step === 'password' || step === 'disable' || step === 'regen') {
    const needCode = step !== 'password';
    return (
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (step === 'password') {
              const r = await api<{ secret: string; qrSvg: string }>('/auth/2fa/setup', { method: 'POST', body: { password } });
              setSetup(r);
              setPassword('');
              setStep('scan');
            } else if (step === 'disable') {
              await api('/auth/2fa/disable', { method: 'POST', body: { password, code } });
              if (user) useAuth.getState().setUser({ ...user, twoFactorEnabled: false });
              toast.success('Đã tắt xác thực 2 lớp');
              reset();
              refresh();
            } else {
              const r = await api<{ recoveryCodes: string[] }>('/auth/2fa/recovery-codes', { method: 'POST', body: { password, code } });
              setCodes(r.recoveryCodes);
              setStep('codes');
            }
          });
        }}
      >
        <p className="text-[13px] text-tx-2">
          {step === 'password'
            ? 'Nhập mật khẩu để bắt đầu thiết lập.'
            : step === 'disable'
              ? 'Tắt 2FA làm tài khoản kém an toàn hơn. Nhập mật khẩu và mã 6 số (hoặc mã khôi phục) để xác nhận.'
              : 'Bộ mã cũ sẽ mất hiệu lực. Nhập mật khẩu và mã 6 số để tạo bộ mới.'}
        </p>
        <input className="input" type="password" autoComplete="current-password" placeholder="Mật khẩu hiện tại" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        {needCode && <input className="input num" placeholder="Mã 6 số hoặc mã khôi phục" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />}
        <div className="flex gap-2">
          <button type="button" className="btn btn-ghost flex-1" onClick={reset}>
            Huỷ
          </button>
          <button className={step === 'disable' ? 'btn btn-down flex-1' : 'btn btn-brand flex-1'} disabled={busy || !password || (needCode && !code.trim())}>
            {step === 'password' ? 'Tiếp tục' : step === 'disable' ? 'Tắt 2FA' : 'Tạo mã mới'}
          </button>
        </div>
      </form>
    );
  }

  return enabled ? (
    <div className="space-y-3">
      <div className="flex items-start gap-3 rounded-lg bg-up/10 p-3 text-[13px] text-tx-2">
        <ShieldCheck size={18} className="mt-0.5 shrink-0 text-up" />
        <span>
          Xác thực 2 lớp <b className="text-up">đang bật</b>
          {status.data?.enabledAt && <> từ {fmtDateTime(status.data.enabledAt)}</>}. Còn <b className="text-tx-1">{status.data?.recoveryCodesLeft ?? 0}</b> mã
          khôi phục chưa dùng.
        </span>
      </div>
      <div className="flex gap-2">
        <button className="btn btn-ghost flex-1" onClick={() => setStep('regen')}>
          Tạo mã khôi phục mới
        </button>
        <button className="btn btn-ghost flex-1 text-down" onClick={() => setStep('disable')}>
          Tắt 2FA
        </button>
      </div>
    </div>
  ) : (
    <div className="space-y-3">
      <div className="flex items-start gap-3 rounded-lg bg-bg-2 p-3 text-[13px] text-tx-2">
        <ShieldOff size={18} className="mt-0.5 shrink-0 text-tx-3" />
        <span>
          Xác thực 2 lớp đang <b>tắt</b>. Bật để mỗi lần đăng nhập cần thêm mã 6 số từ điện thoại — kẻ gian biết mật khẩu cũng không vào được tài khoản.
        </span>
      </div>
      <button className="btn btn-brand w-full" onClick={() => setStep('password')}>
        Bật xác thực 2 lớp
      </button>
    </div>
  );
}

function PreferencesPanel({ onSaved }: { onSaved(): void }) {
  const user = useAuth((s) => s.user);
  const qc = useQueryClient();
  const [notifyFills, setNotifyFills] = useState(user?.notifyFills ?? false);
  const [showOnLeaderboard, setShow] = useState(user?.showOnLeaderboard ?? true);
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const parsed = preferencesSchema.safeParse({ notifyFills, showOnLeaderboard, displayName: displayName.trim() ? displayName.trim() : null });
    if (!parsed.success) return toast.error(parsed.error.issues[0]?.message);
    setBusy(true);
    try {
      const r = await api<{ user: UserDTO }>('/auth/preferences', { method: 'PUT', body: parsed.data });
      useAuth.getState().setUser(r.user);
      void qc.invalidateQueries({ queryKey: ['leaderboard'] });
      toast.success('Đã lưu tuỳ chọn');
      onSaved();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <Toggle
        checked={notifyFills}
        onChange={setNotifyFills}
        label="Email thông báo khớp lệnh"
        hint="Gộp các lệnh khớp trong 1 phút thành 1 email. Email bảo mật (đổi mật khẩu, 2FA, khoá tài khoản) luôn được gửi."
      />
      <div className="h-px bg-line" />
      <Toggle
        checked={showOnLeaderboard}
        onChange={setShow}
        label="Hiện tôi trên bảng xếp hạng"
        hint="Chỉ hiện tên hiển thị và tỷ suất lợi nhuận — không bao giờ hiện email."
      />
      <label className="block pt-1">
        <span className="label">Tên hiển thị (để trống = viết tắt họ tên)</span>
        <input className="input mt-1" maxLength={30} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="vd. Sói già phố Wall" />
      </label>
      <button className="btn btn-brand mt-2 w-full" disabled={busy} onClick={() => void save()}>
        Lưu tuỳ chọn
      </button>
    </div>
  );
}

export function AccountSettingsModal({ open, onClose, initialTab = 'password' }: { open: boolean; onClose(): void; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
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
      const r = await api<{ token: string }>('/auth/change-password', { method: 'POST', body: parsed.data });
      // Phiên cũ bị thu hồi → dùng token mới máy chủ trả về
      const st = useAuth.getState();
      if (st.user) st.setAuth(r.token, st.user);
      toast.success('Đã đổi mật khẩu — các thiết bị khác đã bị đăng xuất');
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
      toast.success(`Tài khoản đã được đặt lại về ${Number(RULES.initialUsdt).toLocaleString('en-US')} USDT`);
      setConfirmText('');
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Cài đặt tài khoản" width={500}>
      <UnderlineTabs
        className="-mx-5 -mt-4 mb-4"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'password', label: 'Mật khẩu' },
          { value: 'security', label: 'Xác thực 2 lớp' },
          { value: 'prefs', label: 'Thông báo & riêng tư' },
          { value: 'reset', label: 'Đặt lại vốn ảo' },
        ]}
      />
      {tab === 'password' && (
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
      )}
      {tab === 'security' && <TwoFactorPanel />}
      {tab === 'prefs' && <PreferencesPanel onSaved={onClose} />}
      {tab === 'reset' && (
        <div className="space-y-3">
          <p className="text-tx-2">
            Toàn bộ lệnh, lịch sử khớp, số dư coin và sổ cái sẽ bị xoá. Ví trở về <b className="text-tx-1">{Number(RULES.initialUsdt).toLocaleString('en-US')} USDT</b>. Thao tác không thể
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
