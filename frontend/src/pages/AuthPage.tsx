import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { BarChart3, Eye, EyeOff, KeyRound, ShieldCheck, Sparkles, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { RULES, loginSchema, registerSchema, type UserDTO } from '@vss/shared';
import { AuthFrame, MajorsMini } from '../components/auth/AuthFrame';
import { api, errMsg } from '../lib/api';
import { useAuth, type LoginResult } from '../store/auth';

/** Bước 2 khi tài khoản bật 2FA: nhập mã 6 số hoặc mã khôi phục */
export function MfaStep({ mfaToken, onDone, onCancel }: { mfaToken: string; onDone(res: { token: string; user: UserDTO }): void; onCancel(): void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    try {
      onDone(await api<{ token: string; user: UserDTO }>('/auth/login/2fa', { method: 'POST', body: { mfaToken, code: code.trim() } }));
    } catch (err) {
      toast.error(errMsg(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="space-y-4" onSubmit={(e) => void submit(e)}>
      <div className="flex items-start gap-3 rounded-lg bg-bg-2 p-3 text-[13px] text-tx-2">
        <KeyRound size={18} className="mt-0.5 shrink-0 text-brand" />
        <span>
          {useRecovery
            ? 'Nhập một mã khôi phục (dạng xxxx-xxxx) bạn đã lưu khi bật xác thực 2 lớp. Mỗi mã chỉ dùng được 1 lần.'
            : 'Tài khoản đã bật xác thực 2 lớp. Mở ứng dụng xác thực trên điện thoại và nhập mã 6 số.'}
        </span>
      </div>
      <label className="block">
        <span className="label">{useRecovery ? 'Mã khôi phục' : 'Mã xác thực'}</span>
        <input
          className="input num mt-1 h-11 text-center text-[18px] tracking-[0.3em]"
          value={code}
          onChange={(e) => setCode(useRecovery ? e.target.value : e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode={useRecovery ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          autoFocus
          placeholder={useRecovery ? 'xxxx-xxxx' : '123456'}
        />
      </label>
      <button className="btn btn-brand h-11 w-full text-[15px]" disabled={busy || (useRecovery ? code.trim().length < 8 : code.length !== 6)}>
        {busy ? 'Đang kiểm tra…' : 'Xác nhận'}
      </button>
      <div className="flex items-center justify-between text-[13px]">
        <button
          type="button"
          className="text-brand hover:underline"
          onClick={() => {
            setUseRecovery((v) => !v);
            setCode('');
          }}
        >
          {useRecovery ? 'Dùng mã từ ứng dụng' : 'Mất điện thoại? Dùng mã khôi phục'}
        </button>
        <button type="button" className="text-tx-3 hover:text-tx-1" onClick={onCancel}>
          Quay lại
        </button>
      </div>
    </form>
  );
}

export default function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const token = useAuth((s) => s.token);
  const setAuth = useAuth((s) => s.setAuth);
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const state = loc.state as { from?: string; mfaToken?: string } | null;
  const from = state?.from ?? '/';
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [agree, setAgree] = useState(false);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Vé chờ nhập mã 2FA (từ bước mật khẩu, hoặc chuyển từ trang đặt lại mật khẩu)
  const [mfaToken, setMfaToken] = useState<string | null>(state?.mfaToken ?? null);

  if (token) return <Navigate to={from} replace />;
  const isLogin = mode === 'login';

  const done = (res: { token: string; user: UserDTO }, msg: string) => {
    qc.clear();
    setAuth(res.token, res.user);
    toast.success(msg);
    nav(from, { replace: true });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const parsed = isLogin ? loginSchema.safeParse({ email, password }) : registerSchema.safeParse({ fullName, email, password });
    if (!parsed.success) for (const i of parsed.error.issues) errs[String(i.path[0])] ??= i.message;
    if (!isLogin && password !== confirm) errs.confirm = 'Mật khẩu xác nhận không khớp';
    if (!isLogin && !agree) errs.agree = 'Vui lòng xác nhận điều khoản';
    setErrors(errs);
    if (Object.keys(errs).length || !parsed.success) return;
    setBusy(true);
    try {
      const res = await api<LoginResult>(isLogin ? '/auth/login' : '/auth/register', { method: 'POST', body: parsed.data });
      if (res.mfaRequired) {
        setMfaToken(res.mfaToken);
        setPassword('');
        return;
      }
      done(
        res,
        isLogin
          ? `Chào mừng trở lại, ${res.user.fullName}!`
          : `Tạo tài khoản thành công, bạn được cấp ${Number(RULES.initialUsdt).toLocaleString('en-US')} USDT vốn ảo. Hãy kiểm tra email để xác thực tài khoản.`,
      );
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const demo = async () => {
    setBusy(true);
    try {
      done(await api<{ token: string; user: UserDTO }>('/auth/demo', { method: 'POST' }), 'Đang dùng tài khoản demo');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const field = (
    key: string,
    label: string,
    value: string,
    set: (v: string) => void,
    type = 'text',
    autoComplete?: string,
    extra?: React.ReactNode,
  ) => (
    <label className="block">
      <span className="flex items-center justify-between">
        <span className="label">{label}</span>
        {extra}
      </span>
      <div className="relative mt-1">
        <input
          className="input h-11"
          type={type === 'password' && show ? 'text' : type}
          value={value}
          autoComplete={autoComplete}
          onChange={(e) => set(e.target.value)}
          aria-invalid={!!errors[key]}
        />
        {type === 'password' && key === 'password' && (
          <button type="button" onClick={() => setShow((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-tx-3 hover:text-tx-1" aria-label={show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}>
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        )}
      </div>
      {errors[key] && <span className="mt-1 block text-[12px] text-down">{errors[key]}</span>}
    </label>
  );

  const forgotLink = (
    <Link to="/forgot-password" state={{ email }} className="text-[12px] font-medium text-brand hover:underline">
      Quên mật khẩu?
    </Link>
  );

  return (
    <AuthFrame>
      <div className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-10 px-4 py-10 lg:grid-cols-[1.1fr_1fr]">
        <div className="hidden lg:block">
          <div className="chip bg-brand/15 text-brand">
            <Sparkles size={12} className="mr-1" /> Giao dịch mô phỏng, vốn ảo {Number(RULES.initialUsdt).toLocaleString('en-US')} USDT
          </div>
          <h1 className="mt-4 text-[40px] font-extrabold leading-[1.1] tracking-tight">
            Luyện giao dịch coin
            <br />
            <span className="text-brand">không rủi ro, giá thật từ Binance.</span>
          </h1>
          <p className="mt-4 max-w-lg text-[15px] text-tx-2">
            Bảng giá và sổ lệnh realtime, biểu đồ nến chuyên nghiệp, khớp lệnh đúng bộ lọc giá, khối lượng và phí maker/taker như sàn thật.
          </p>
          <ul className="mt-6 space-y-3 text-[14px]">
            {[
              [Zap, 'Giá và sổ lệnh 20 mức cập nhật liên tục từ Binance'],
              [BarChart3, 'Biểu đồ nến với MA7/MA25/MA99, khung 1 phút đến 1 tháng'],
              [ShieldCheck, 'Lệnh giới hạn, thị trường, stop-limit, OCO; trả phí bằng BNB giảm 25%'],
            ].map(([Icon, text], i) => {
              const I = Icon as typeof Zap;
              return (
                <li key={i} className="flex items-center gap-3 text-tx-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-bg-2 text-brand">
                    <I size={16} />
                  </span>
                  {text as string}
                </li>
              );
            })}
          </ul>
          <div className="mt-8 max-w-md">
            <MajorsMini />
          </div>
        </div>

        <div className="mx-auto w-full max-w-md rounded-2xl border border-line bg-bg-1 p-6 sm:p-8" style={{ boxShadow: 'var(--shadow)' }}>
          {mfaToken ? (
            <>
              <h2 className="text-[24px] font-bold">Xác thực 2 lớp</h2>
              <p className="mb-6 mt-1 text-tx-3">Bước cuối để đăng nhập an toàn</p>
              <MfaStep
                mfaToken={mfaToken}
                onDone={(res) => done(res, `Chào mừng trở lại, ${res.user.fullName}!`)}
                onCancel={() => {
                  setMfaToken(null);
                  nav(loc.pathname, { replace: true, state: { from } });
                }}
              />
            </>
          ) : (
            <>
              <h2 className="text-[24px] font-bold">{isLogin ? 'Đăng nhập' : 'Mở tài khoản miễn phí'}</h2>
              <p className="mt-1 text-tx-3">{isLogin ? 'Chào mừng bạn quay lại VNCoin' : `Nhận ngay ${Number(RULES.initialUsdt).toLocaleString('en-US')} USDT vốn ảo để giao dịch`}</p>
              <form className="mt-6 space-y-4" onSubmit={(e) => void submit(e)} noValidate>
                {!isLogin && field('fullName', 'Họ và tên', fullName, setFullName, 'text', 'name')}
                {field('email', 'Email', email, setEmail, 'email', 'email')}
                {field('password', 'Mật khẩu', password, setPassword, 'password', isLogin ? 'current-password' : 'new-password', isLogin ? forgotLink : undefined)}
                {!isLogin && field('confirm', 'Nhập lại mật khẩu', confirm, setConfirm, 'password', 'new-password')}
                {!isLogin && (
                  <label className="flex items-start gap-2 text-[12px] text-tx-2">
                    <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 accent-[var(--brand)]" />
                    <span>
                      Tôi đã đọc{' '}
                      <Link to="/dieu-khoan" target="_blank" className="text-brand hover:underline">
                        Điều khoản sử dụng
                      </Link>{' '}
                      và hiểu đây là sàn <b>giao dịch mô phỏng</b> dùng vốn ảo, không phải khuyến nghị đầu tư.
                      {errors.agree && <span className="block text-down">{errors.agree}</span>}
                    </span>
                  </label>
                )}
                <button className="btn btn-brand h-11 w-full text-[15px]" disabled={busy}>
                  {busy ? 'Đang xử lý…' : isLogin ? 'Đăng nhập' : 'Tạo tài khoản'}
                </button>
              </form>
              {isLogin && (
                <>
                  <div className="my-5 flex items-center gap-3 text-[12px] text-tx-3">
                    <span className="h-px flex-1 bg-line" /> hoặc <span className="h-px flex-1 bg-line" />
                  </div>
                  <button onClick={() => void demo()} disabled={busy} className="btn btn-ghost h-11 w-full">
                    Trải nghiệm nhanh với tài khoản demo
                  </button>
                </>
              )}
              <p className="mt-6 text-center text-tx-3">
                {isLogin ? 'Chưa có tài khoản? ' : 'Đã có tài khoản? '}
                <Link to={isLogin ? '/register' : '/login'} state={loc.state} className="font-semibold text-brand hover:underline">
                  {isLogin ? 'Đăng ký ngay' : 'Đăng nhập'}
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </AuthFrame>
  );
}
