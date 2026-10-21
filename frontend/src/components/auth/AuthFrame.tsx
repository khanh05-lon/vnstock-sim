import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '../layout/Header';
import { cn, fmtPct, fmtPrice, signTone, toneText } from '../../lib/format';
import { useMarket } from '../../store/market';
import { CoinIcon } from '../common/CoinIcon';

/** Dải giá các cặp chạy ngang (trang đăng nhập / đăng ký, trang giới thiệu) */
export function LiveTicker() {
  const rows = useMarket((s) => s.rows);
  const symbols = useMarket((s) => s.symbols);
  const list = useMemo(() => symbols.map((s) => rows[s]!).filter(Boolean), [rows, symbols]);
  if (!list.length) return null;
  const items = [...list, ...list];
  return (
    <div className="overflow-hidden bg-bg-1 py-3">
      <div className="ticker-track flex w-max gap-6">
        {items.map((r, i) => {
          const tone = signTone(r.changePct);
          return (
            <Link key={`${r.symbol}-${i}`} to={`/trade/${r.symbol}`} className="num flex items-center gap-1.5 text-[12px]">
              <b className="text-tx-1">{r.baseAsset}</b>
              <span className="text-tx-2">{fmtPrice(r.last, r.filters.tickSize)}</span>
              <span className={cn('text-[11px]', toneText[tone])}>{fmtPct(r.changePct)}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/** 4 coin chính với giá và % 24h */
export function MajorsMini() {
  const rows = useMarket((s) => s.rows);
  const list = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'].map((s) => rows[s]).filter((r) => !!r);
  return (
    <div className="grid grid-cols-2 gap-2">
      {list.map((r) => {
        const tone = signTone(r!.changePct);
        return (
          <div key={r!.symbol} className="flex items-center gap-3 rounded-lg border border-line bg-bg-1/70 px-3 py-2">
            <CoinIcon asset={r!.baseAsset} size={26} />
            <div className="min-w-0">
              <div className="text-[11px] text-tx-3">{r!.baseAsset}/USDT</div>
              <div className="num text-[15px] font-bold">{fmtPrice(r!.last, r!.filters.tickSize)}</div>
              <div className={cn('num text-[11px]', toneText[tone])}>{fmtPct(r!.changePct)}</div>
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
        <Link to="/thi-truong" className="text-[13px] text-tx-2 hover:text-brand">
          Xem thị trường →
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
        <div className="w-full max-w-md rounded-md border border-line bg-bg-1 p-6 sm:p-8">
          <h1 className="text-[22px] font-bold">{title}</h1>
          {subtitle && <p className="mt-1 text-tx-3">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </AuthFrame>
  );
}
