import { useMemo, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { BarChart3, Eye, EyeOff, ShieldCheck, Sparkles, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { loginSchema, registerSchema } from '@vss/shared';
import { Logo } from '../components/layout/Header';
import { api, errMsg } from '../lib/api';
import { cn, fmtPrice, priceTone, toneText } from '../lib/format';
import { useAuth, type User } from '../store/auth';
import { useMarket } from '../store/market';

function LiveTicker() {
  const rows = useMarket((s) => s.rows);
  const list = useMemo(() => Object.values(rows).filter((r) => r.isVn30), [rows]);
  if (!list.length) return null;
  const items = [...list, ...list];
  return (
    <div className="overflow-hidden border-y border-line bg-bg-1/60 py-2">
      <div className="ticker-track flex w-max gap-6">
        {items.map((r, i) => {
          const traded = r.volume > 0;
          const tone = traded ? priceTone(r.last, r.ref, r.ceil, r.floor) : 'ref';
          return (
            <span key={`${r.symbol}-${i}`} className="num flex items-center gap-1.5 text-[12px]">
              <b className="text-tx-1">{r.symbol}</b>
              <span className={toneText[tone]}>{fmtPrice(traded ? r.last : r.ref)}</span>
              <span className={cn('text-[11px]', toneText[tone])}>
                {r.changePct > 0 ? '+' : ''}
                {r.changePct.toFixed(2)}%
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function IndexMini() {
  const indices = useMarket((s) => s.indices);
  return (
    <div className="grid grid-cols-2 gap-2">
      {indices.map((ix) => {
        const tone = ix.change > 0 ? 'up' : ix.change < 0 ? 'down' : 'ref';
        return (
          <div key={ix.code} className="rounded-lg border border-line bg-bg-1/70 px-3 py-2">
            <div className="text-[11px] text-tx-3">{ix.name}</div>
            <div className={cn('num text-[16px] font-bold', toneText[tone])}>{ix.value.toFixed(2)}</div>
            <div className={cn('num text-[11px]', toneText[tone])}>
              {ix.change > 0 ? '+' : ''}
              {ix.change.toFixed(2)} ({ix.changePct > 0 ? '+' : ''}
              {ix.changePct.toFixed(2)}%)
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const token = useAuth((s) => s.token);
  const setAuth = useAuth((s) => s.setAuth);
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const from = (loc.state as { from?: string } | null)?.from ?? '/';
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [agree, setAgree] = useState(false);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (token) return <Navigate to={from} replace />;
  const isLogin = mode === 'login';

  const done = (res: { token: string; user: User }, msg: string) => {
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
      const res = await api<{ token: string; user: User }>(isLogin ? '/auth/login' : '/auth/register', { method: 'POST', body: parsed.data });
      done(res, isLogin ? `Chào mừng trở lại, ${res.user.fullName}!` : 'Tạo tài khoản thành công — bạn được cấp 1 tỷ đồng vốn ảo');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const demo = async () => {
    setBusy(true);
    try {
      done(await api<{ token: string; user: User }>('/auth/demo', { method: 'POST' }), 'Đang dùng tài khoản demo');
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
  ) => (
    <label className="block">
      <span className="label">{label}</span>
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

  return (
    <div className="flex min-h-full flex-col bg-bg-0">
      <div className="flex h-14 items-center justify-between border-b border-line px-4">
        <Logo />
        <Link to="/" className="text-[13px] text-tx-2 hover:text-brand">
          Xem bảng giá →
        </Link>
      </div>
      <LiveTicker />
      <div className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-10 px-4 py-10 lg:grid-cols-[1.1fr_1fr]">
        <div className="hidden lg:block">
          <div className="chip bg-brand/15 text-brand">
            <Sparkles size={12} className="mr-1" /> Giao dịch mô phỏng — vốn ảo 1 tỷ đồng
          </div>
          <h1 className="mt-4 text-[40px] font-extrabold leading-[1.1] tracking-tight">
            Luyện đầu tư chứng khoán
            <br />
            <span className="text-brand">không rủi ro, như sàn thật.</span>
          </h1>
          <p className="mt-4 max-w-lg text-[15px] text-tx-2">
            Bảng giá realtime HOSE · HNX · UPCOM, biểu đồ nến chuyên nghiệp, khớp lệnh theo đúng quy tắc bước giá, biên độ trần/sàn, phí giao dịch và T+2.
          </p>
          <ul className="mt-6 space-y-3 text-[14px]">
            {[
              [Zap, 'Giá cập nhật từng giây, sổ lệnh 3 bước giá như bảng điện'],
              [BarChart3, 'Biểu đồ nến TradingView với MA20/MA50, 1 phút đến 1 tháng'],
              [ShieldCheck, 'Lệnh LO / MP / ATO / ATC, phong toả tiền, thanh toán T+2'],
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
            <IndexMini />
          </div>
        </div>

        <div className="mx-auto w-full max-w-md rounded-2xl border border-line bg-bg-1 p-6 sm:p-8" style={{ boxShadow: 'var(--shadow)' }}>
          <h2 className="text-[24px] font-bold">{isLogin ? 'Đăng nhập' : 'Mở tài khoản miễn phí'}</h2>
          <p className="mt-1 text-tx-3">{isLogin ? 'Chào mừng bạn quay lại VNStock' : 'Nhận ngay 1.000.000.000đ vốn ảo để giao dịch'}</p>
          <form className="mt-6 space-y-4" onSubmit={(e) => void submit(e)} noValidate>
            {!isLogin && field('fullName', 'Họ và tên', fullName, setFullName, 'text', 'name')}
            {field('email', 'Email', email, setEmail, 'email', 'email')}
            {field('password', 'Mật khẩu', password, setPassword, 'password', isLogin ? 'current-password' : 'new-password')}
            {!isLogin && field('confirm', 'Nhập lại mật khẩu', confirm, setConfirm, 'password', 'new-password')}
            {!isLogin && (
              <label className="flex items-start gap-2 text-[12px] text-tx-2">
                <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 accent-[var(--brand)]" />
                <span>
                  Tôi hiểu đây là sàn <b>giao dịch mô phỏng</b> dùng vốn ảo, dữ liệu giá là giả lập và không phải khuyến nghị đầu tư.
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
        </div>
      </div>
    </div>
  );
}
