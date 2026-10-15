import { Link, Outlet } from 'react-router-dom';
import { AlertTriangle, Info, OctagonAlert } from 'lucide-react';
import { useSystemStatus } from '../../lib/admin';
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
      <Link to="/dieu-khoan" className="ml-auto hover:text-tx-2">
        Điều khoản sử dụng
      </Link>
      <Link to="/chinh-sach-bao-mat" className="hover:text-tx-2">
        Chính sách bảo mật
      </Link>
      <a className="hover:text-tx-2" href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
        Biểu đồ: TradingView Lightweight Charts™
      </a>
    </footer>
  );
}

/** Banner do quản trị viên điều khiển: tạm ngừng nhận lệnh + thông báo hệ thống */
function SystemBanner() {
  const { data } = useSystemStatus();
  if (!data) return null;
  const a = data.announcement;
  const tone = { info: 'border-info/30 bg-info/10 text-info', warning: 'border-ref/30 bg-ref/10 text-ref', critical: 'border-down/30 bg-down/10 text-down' };
  return (
    <>
      {data.tradingHalted && (
        <div role="alert" className="flex items-center gap-2 border-b border-down/30 bg-down/12 px-4 py-2 text-[13px] text-down">
          <OctagonAlert size={16} className="shrink-0" />
          <b>Hệ thống đang tạm ngừng nhận lệnh</b>
          {data.haltReason && <span>— {data.haltReason}</span>}
        </div>
      )}
      {a && (
        <div role="status" className={cn('flex items-center gap-2 border-b px-4 py-2 text-[13px]', tone[a.level])}>
          {a.level === 'info' ? <Info size={16} className="shrink-0" /> : <AlertTriangle size={16} className="shrink-0" />}
          <span>{a.text}</span>
        </div>
      )}
      {data.haltedSymbols.length > 0 && !data.tradingHalted && (
        <div className="border-b border-line bg-bg-2 px-4 py-1.5 text-[12px] text-tx-2">
          Mã đang tạm ngừng giao dịch: <b className="text-down">{data.haltedSymbols.join(', ')}</b>
        </div>
      )}
    </>
  );
}

export function AppShell() {
  return (
    <div className="flex h-full flex-col">
      <Header />
      <SystemBanner />
      <main className="flex min-h-0 flex-1 flex-col">
        <Outlet />
      </main>
      <StatusBar />
    </div>
  );
}
