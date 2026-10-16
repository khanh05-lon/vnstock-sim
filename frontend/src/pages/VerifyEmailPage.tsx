import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import type { UserDTO } from '@vss/shared';
import { Spinner } from '../components/common/ui';
import { AuthCard } from '../components/auth/AuthFrame';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../store/auth';

export default function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const loggedIn = useAuth((s) => !!s.token);
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'ok'; email: string } | { kind: 'error'; message: string }>(
    token ? { kind: 'loading' } : { kind: 'error', message: 'Thiếu mã xác thực trong link.' },
  );
  // StrictMode chạy effect 2 lần ở dev: token chỉ dùng được 1 lần nên chặn gọi lặp
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    api<{ user: UserDTO }>('/auth/verify-email', { method: 'POST', body: { token } }).then(
      (res) => {
        const cur = useAuth.getState().user;
        if (cur?.id === res.user.id) useAuth.getState().setUser({ ...cur, ...res.user });
        setState({ kind: 'ok', email: res.user.email });
      },
      (err) => setState({ kind: 'error', message: errMsg(err) }),
    );
  }, [token]);

  return (
    <AuthCard title="Xác thực email">
      {state.kind === 'loading' && (
        <div className="flex items-center gap-3 text-tx-2">
          <Spinner /> Đang xác thực…
        </div>
      )}
      {state.kind === 'ok' && (
        <>
          <div className="flex items-start gap-3 rounded-lg bg-up/10 p-4 text-[13px] text-tx-2">
            <CircleCheck size={20} className="mt-0.5 shrink-0 text-up" />
            <span>
              Email <b className="text-tx-1">{state.email}</b> đã được xác thực. Cảm ơn bạn!
            </span>
          </div>
          <Link to={loggedIn ? '/trade' : '/login'} className="btn btn-brand mt-6 h-11 w-full text-[15px]">
            {loggedIn ? 'Bắt đầu giao dịch' : 'Đăng nhập'}
          </Link>
        </>
      )}
      {state.kind === 'error' && (
        <>
          <div className="flex items-start gap-3 rounded-lg bg-down/10 p-4 text-[13px] text-tx-2">
            <TriangleAlert size={20} className="mt-0.5 shrink-0 text-down" />
            <span>{state.message}</span>
          </div>
          <p className="mt-4 text-[13px] text-tx-3">
            {loggedIn ? 'Bạn có thể gửi lại email xác thực từ thanh thông báo phía trên bảng giá.' : 'Đăng nhập để gửi lại email xác thực.'}
          </p>
          <Link to={loggedIn ? '/' : '/login'} className="btn btn-ghost mt-6 h-11 w-full">
            {loggedIn ? 'Về bảng giá' : 'Đăng nhập'}
          </Link>
        </>
      )}
    </AuthCard>
  );
}
