import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { resetPasswordSchema } from '@vss/shared';
import { AuthCard } from '../components/auth/AuthFrame';
import { api, ApiError, errMsg } from '../lib/api';
import { useAuth, type LoginResult } from '../store/auth';

export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const nav = useNavigate();
  const qc = useQueryClient();
  const setAuth = useAuth((s) => s.setAuth);
  const logout = useAuth((s) => s.logout);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(!token);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = resetPasswordSchema.safeParse({ token, password });
    const errs: Record<string, string> = {};
    if (!parsed.success) for (const i of parsed.error.issues) errs[String(i.path[0])] ??= i.message;
    if (password !== confirm) errs.confirm = 'Mật khẩu xác nhận không khớp';
    setErrors(errs);
    if (Object.keys(errs).length || !parsed.success) return;
    setBusy(true);
    try {
      const res = await api<LoginResult>('/auth/reset-password', { method: 'POST', body: parsed.data });
      // Đăng xuất phiên cũ trên trình duyệt này (nếu có) — mọi phiên cũ đã bị thu hồi
      logout();
      qc.clear();
      if (res.mfaRequired) {
        toast.success('Đã đặt mật khẩu mới. Nhập mã xác thực 2 lớp để đăng nhập.');
        nav('/login', { replace: true, state: { mfaToken: res.mfaToken } });
        return;
      }
      setAuth(res.token, res.user);
      toast.success('Đã đặt mật khẩu mới và đăng nhập');
      nav('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'RESET_TOKEN_INVALID') setInvalid(true);
      else toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  if (invalid) {
    return (
      <AuthCard title="Link không còn hiệu lực">
        <div className="flex items-start gap-3 rounded-lg bg-down/10 p-4 text-[13px] text-tx-2">
          <TriangleAlert size={20} className="mt-0.5 shrink-0 text-down" />
          <span>Link đặt lại mật khẩu không hợp lệ, đã được dùng hoặc đã hết hạn. Mỗi link chỉ dùng được 1 lần — hãy yêu cầu link mới.</span>
        </div>
        <Link to="/forgot-password" className="btn btn-brand mt-6 h-11 w-full text-[15px]">
          Yêu cầu link mới
        </Link>
      </AuthCard>
    );
  }

  const pwInput = (key: 'password' | 'confirm', label: string, value: string, set: (v: string) => void) => (
    <label className="block">
      <span className="label">{label}</span>
      <div className="relative mt-1">
        <input
          className="input h-11"
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          value={value}
          onChange={(e) => set(e.target.value)}
          aria-invalid={!!errors[key]}
          autoFocus={key === 'password'}
        />
        {key === 'password' && (
          <button type="button" onClick={() => setShow((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-tx-3 hover:text-tx-1" aria-label={show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}>
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        )}
      </div>
      {errors[key] && <span className="mt-1 block text-[12px] text-down">{errors[key]}</span>}
    </label>
  );

  return (
    <AuthCard title="Đặt mật khẩu mới" subtitle="Mật khẩu tối thiểu 8 ký tự, có cả chữ và số. Mọi phiên đăng nhập cũ sẽ bị đăng xuất.">
      <form className="space-y-4" onSubmit={(e) => void submit(e)} noValidate>
        {pwInput('password', 'Mật khẩu mới', password, setPassword)}
        {pwInput('confirm', 'Nhập lại mật khẩu mới', confirm, setConfirm)}
        <button className="btn btn-brand h-11 w-full text-[15px]" disabled={busy}>
          {busy ? 'Đang lưu…' : 'Lưu mật khẩu mới'}
        </button>
      </form>
    </AuthCard>
  );
}
