import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '../layout/Header';
import { cn, fmtPrice, priceTone, toneText } from '../../lib/format';
import { useMarket } from '../../store/market';

/** Dải giá VN30 chạy ngang ở các trang đăng nhập / đăng ký */
export function LiveTicker() {
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

export function IndexMini() {
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

/** Khung chung: thanh logo + dải giá + nội dung */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col bg-bg-0">
      <div className="flex h-14 items-center justify-between border-b border-line px-4">
        <Logo />
        <Link to="/" className="text-[13px] text-tx-2 hover:text-brand">
          Xem bảng giá →
        </Link>
      </div>
      <LiveTicker />
      {children}
    </div>
  );
}

/** Thẻ căn giữa cho các trang chỉ có 1 biểu mẫu (quên mật khẩu, xác thực email...) */
export function AuthCard({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <AuthFrame>
      <div className="flex flex-1 items-start justify-center px-4 py-10 sm:items-center">
        <div className="w-full max-w-md rounded-2xl border border-line bg-bg-1 p-6 sm:p-8" style={{ boxShadow: 'var(--shadow)' }}>
          <h1 className="text-[22px] font-bold">{title}</h1>
          {subtitle && <p className="mt-1 text-tx-3">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </AuthFrame>
  );
}
