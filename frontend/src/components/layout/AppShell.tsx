import { Outlet } from 'react-router-dom';
import { cn } from '../../lib/format';
import { useMarket } from '../../store/market';
import { Header } from './Header';

function StatusBar() {
  const connected = useMarket((s) => s.connected);
  const session = useMarket((s) => s.session);
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 overflow-x-auto border-t border-line bg-bg-1 px-3 text-[11px] text-tx-3 whitespace-nowrap">
      <span className="flex items-center gap-1.5">
        <span className={cn('h-1.5 w-1.5 rounded-full', connected ? 'bg-up' : 'bg-down')} />
        {connected ? 'Kết nối realtime ổn định' : 'Mất kết nối — đang thử lại…'}
      </span>
      <span>
        {session?.mode === 'REAL_HOURS' ? 'Theo giờ giao dịch HOSE' : 'Thị trường mô phỏng 24/7'} · ngày GD {session?.tradeDate ?? '—'}
      </span>
      <span>Đơn vị giá: 1.000 VNĐ · KL: cổ phiếu</span>
      <span className="text-ref">
        {session?.feed === 'LIVE'
          ? 'Giá thị trường thật (có độ trễ vài giây), giao dịch bằng vốn ảo — không phải khuyến nghị đầu tư'
          : 'Dữ liệu giả lập phục vụ học tập — không phải giá thật, không phải khuyến nghị đầu tư'}
      </span>
      <a className="ml-auto hover:text-tx-2" href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
        Biểu đồ: TradingView Lightweight Charts™
      </a>
    </footer>
  );
}

export function AppShell() {
  return (
    <div className="flex h-full flex-col">
      <Header />
      <main className="flex min-h-0 flex-1 flex-col">
        <Outlet />
      </main>
      <StatusBar />
    </div>
  );
}
