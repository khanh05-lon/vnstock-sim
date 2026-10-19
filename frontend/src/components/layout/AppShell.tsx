import { useState } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { AlertTriangle, Info, MailWarning, OctagonAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api, errMsg } from '../../lib/api';
import { useSystemStatus } from '../../lib/admin';
import { cn } from '../../lib/format';
import { useAuth } from '../../store/auth';
import { useMarket } from '../../store/market';
import { ChatWidget } from '../support/ChatWidget';
import { Header } from './Header';

function StatusBar() {
  const connected = useMarket((s) => s.connected);
  const status = useMarket((s) => s.status);
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 overflow-x-auto border-t border-line bg-bg-1 px-3 text-[11px] text-tx-3 whitespace-nowrap">
      <span className="flex items-center gap-1.5">
        <span className={cn('h-1.5 w-1.5 rounded-full', connected ? 'bg-up' : 'bg-down')} />
        {connected ? 'Kết nối realtime ổn định' : 'Mất kết nối, đang thử lại...'}
      </span>
      <span>Giao dịch 24/7, chốt ngày theo 00:00 UTC</span>
      <span className="text-ref">
        {status?.feed === 'SIM'
          ? 'Mất kết nối Binance: giá đang giả lập. Giao dịch bằng vốn ảo, không phải khuyến nghị đầu tư'
          : 'Giá thật từ Binance (trễ dưới 1 giây), giao dịch bằng vốn ảo. Không phải khuyến nghị đầu tư'}
      </span>
      <Link to="/gioi-thieu" className="ml-auto hover:text-tx-2">
        Giới thiệu
      </Link>
      <Link to="/dieu-khoan" className="hover:text-tx-2">
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
      {data.maintenance && (
        <div role="alert" className="flex items-center gap-2 border-b border-down/30 bg-down/12 px-4 py-2 text-[13px] text-down">
          <OctagonAlert size={16} className="shrink-0" />
          <b>{data.maintenance}</b>
        </div>
      )}
      {data.tradingHalted && !data.maintenance && (
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

/** Nhắc xác thực email (chỉ hiện khi máy chủ báo chưa xác thực) */
function VerifyEmailBanner() {
  const user = useAuth((s) => s.user);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  if (!user || user.emailVerified !== false) return null;
  const resend = async () => {
    setBusy(true);
    try {
      const r = await api<{ message?: string; alreadyVerified?: boolean }>('/auth/resend-verification', { method: 'POST', body: {} });
      if (r.alreadyVerified) useAuth.getState().setUser({ ...user, emailVerified: true });
      else {
        setSent(true);
        toast.success(r.message ?? 'Đã gửi lại email xác thực');
      }
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ref/30 bg-ref/10 px-4 py-2 text-[13px] text-ref">
      <MailWarning size={16} className="shrink-0" />
      <span>
        Email <b>{user.email}</b> chưa được xác thực — mở link trong email chúng tôi đã gửi để bảo vệ tài khoản.
      </span>
      <button className="font-semibold underline-offset-2 hover:underline disabled:opacity-50" disabled={busy || sent} onClick={() => void resend()}>
        {sent ? 'Đã gửi — kiểm tra hộp thư' : 'Gửi lại email xác thực'}
      </button>
    </div>
  );
}

/** Tài khoản bị bộ phận Tuân thủ hạn chế (chỉ câu chung, không nêu lý do — nguyên tắc không tiết lộ của AML) */
function RestrictedBanner() {
  const restricted = useAuth((s) => !!s.user?.restricted);
  if (!restricted) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-down/30 bg-down/10 px-4 py-2 text-[13px] text-down">
      <OctagonAlert size={16} className="shrink-0" />
      <span>Tài khoản đang bị hạn chế giao dịch: tạm thời không đặt được lệnh Spot và P2P mới. Lệnh đang mở và đơn P2P đang chạy vẫn xử lý bình thường.</span>
      <Link to="/ho-tro" className="font-semibold underline-offset-2 hover:underline">
        Liên hệ CSKH
      </Link>
    </div>
  );
}

export function AppShell() {
  return (
    <div className="flex h-full flex-col">
      <Header />
      <SystemBanner />
      <VerifyEmailBanner />
      <RestrictedBanner />
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Outlet />
      </main>
      <StatusBar />
      <ChatWidget />
    </div>
  );
}
