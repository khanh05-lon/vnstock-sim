import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { MailCheck } from 'lucide-react';
import { toast } from 'sonner';
import { forgotPasswordSchema, PASSWORD_RESET_TTL_MIN } from '@vss/shared';
import { AuthCard } from '../components/auth/AuthFrame';
import { api, errMsg } from '../lib/api';

export default function ForgotPasswordPage() {
  const loc = useLocation();
  const [email, setEmail] = useState((loc.state as { email?: string } | null)?.email ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = forgotPasswordSchema.safeParse({ email });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Email không hợp lệ');
    setError('');
    setBusy(true);
    try {
      await api('/auth/forgot-password', { method: 'POST', body: parsed.data });
      setSentTo(parsed.data.email);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  if (sentTo) {
    return (
      <AuthCard title="Kiểm tra hộp thư" subtitle="Yêu cầu đặt lại mật khẩu đã được ghi nhận">
        <div className="flex items-start gap-3 rounded-lg bg-up/10 p-4 text-[13px] text-tx-2">
          <MailCheck size={20} className="mt-0.5 shrink-0 text-up" />
          <div>
            Nếu <b className="text-tx-1">{sentTo}</b> đã đăng ký tài khoản, chúng tôi vừa gửi link đặt lại mật khẩu. Link có hiệu lực trong{' '}
            {PASSWORD_RESET_TTL_MIN} phút và chỉ dùng được 1 lần.
            <div className="mt-2 text-tx-3">Không thấy email? Kiểm tra thư mục Thư rác / Quảng cáo, hoặc thử lại sau vài phút.</div>
          </div>
        </div>
        <div className="mt-6 flex items-center justify-between text-[13px]">
          <button className="text-brand hover:underline" onClick={() => setSentTo(null)}>
            Gửi lại / dùng email khác
          </button>
          <Link to="/login" className="font-semibold text-brand hover:underline">
            Về trang đăng nhập
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Quên mật khẩu" subtitle="Nhập email đã đăng ký, chúng tôi sẽ gửi link để đặt mật khẩu mới">
      <form className="space-y-4" onSubmit={(e) => void submit(e)} noValidate>
        <label className="block">
          <span className="label">Email</span>
          <input className="input mt-1 h-11" type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!error} />
          {error && <span className="mt-1 block text-[12px] text-down">{error}</span>}
        </label>
        <button className="btn btn-brand h-11 w-full text-[15px]" disabled={busy}>
          {busy ? 'Đang gửi…' : 'Gửi link đặt lại mật khẩu'}
        </button>
      </form>
      <p className="mt-6 text-center text-tx-3">
        Nhớ ra mật khẩu?{' '}
        <Link to="/login" className="font-semibold text-brand hover:underline">
          Đăng nhập
        </Link>
      </p>
    </AuthCard>
  );
}
