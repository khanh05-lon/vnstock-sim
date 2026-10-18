import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Headset, History, Landmark, LogOut, Moon, Settings, ShieldCheck, Store, Sun, Wallet } from 'lucide-react';
import { cn, fmtPct, fmtUsd, signTone, toneText } from '../../lib/format';
import { useAccount } from '../../lib/queries';
import { useAdminMe } from '../../lib/admin';
import { useDeskStats, useIsStaff, useSupportUnread } from '../../lib/support';
import { useAuth } from '../../store/auth';
import { useMarket } from '../../store/market';
import { useUi } from '../../store/ui';
import { AccountSettingsModal } from './AccountSettingsModal';

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link to="/" className="flex shrink-0 items-center gap-2" aria-label="VNCoin, trang chủ">
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="8" fill="var(--brand)" />
        <circle cx="16" cy="16" r="9" fill="none" stroke="var(--brand-ink)" strokeWidth="2.5" />
        <path d="M13 11.5h4.2a2.3 2.3 0 0 1 0 4.5H13zM13 16h4.8a2.3 2.3 0 0 1 0 4.5H13z" fill="none" stroke="var(--brand-ink)" strokeWidth="2" strokeLinejoin="round" />
        <path d="M14.5 9.5v2M14.5 20.5v2" stroke="var(--brand-ink)" strokeWidth="2" strokeLinecap="round" />
      </svg>
      {!compact && (
        <span className="hidden items-baseline gap-1.5 sm:flex">
          <span className="text-[17px] font-extrabold tracking-tight">
            VN<span className="text-brand">Coin</span>
          </span>
          <span className="chip h-[18px] bg-brand/15 px-1.5 text-[10px] text-brand">SIM</span>
        </span>
      )}
    </Link>
  );
}

const NAV = [
  { to: '/trade', label: 'Giao dịch' },
  { to: '/p2p', label: 'P2P' },
  { to: '/xep-hang', label: 'Xếp hạng' },
  { to: '/vi', label: 'Ví' },
  { to: '/lich-su', label: 'Lịch sử' },
];

/** Trạng thái nguồn dữ liệu: Binance (thật) hay giả lập, kèm đồng hồ UTC (sàn coin chốt ngày theo UTC) */
function FeedBadge() {
  const status = useMarket((s) => s.status);
  const connected = useMarket((s) => s.connected);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const live = connected && status?.feed === 'LIVE';
  return (
    <div
      className="hidden items-center gap-2 rounded-md bg-bg-2 px-2.5 py-1 text-xs md:flex"
      title={live ? 'Giá realtime từ Binance' : connected ? 'Mất kết nối Binance, giá đang chạy giả lập' : 'Đang kết nối máy chủ'}
    >
      <span className={cn('h-2 w-2 rounded-full', !connected ? 'bg-tx-3' : live ? 'bg-up pulse-dot' : 'bg-ref')} />
      <span className="text-tx-2">{!connected ? 'Đang kết nối' : live ? 'Binance' : 'Giả lập'}</span>
      <span className="num font-medium text-tx-1">{new Date(now).toISOString().slice(11, 19)} UTC</span>
    </div>
  );
}

function UserMenu() {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const qc = useQueryClient();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data } = useAccount();
  const rows = useMarket((s) => s.rows);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Tổng tài sản theo giá realtime
  let total = 0;
  let pnlPct = 0;
  if (data) {
    for (const b of data.balances) total += Number(b.total) * (b.asset === 'USDT' ? 1 : Number(rows[`${b.asset}USDT`]?.last ?? 0));
    const base = Number(data.contributedUsdt);
    pnlPct = base ? ((total - base) / base) * 100 : 0;
  }
  const initials = (user?.fullName ?? '?')
    .split(' ')
    .filter(Boolean)
    .slice(-2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-bg-3" aria-haspopup="menu" aria-expanded={open}>
        <span className="hidden text-right leading-tight lg:block">
          <span className="block text-[11px] text-tx-3">Tổng tài sản</span>
          <span className="num block text-[13px] font-semibold">
            {data ? `${fmtUsd(total)} USDT` : '--'}{' '}
            {data && <span className={cn('text-[11px] font-medium', toneText[signTone(pnlPct)])}>{fmtPct(pnlPct)}</span>}
          </span>
        </span>
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand/15 text-[12px] font-bold text-brand">{initials}</span>
        <ChevronDown size={14} className="text-tx-3" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-40 mt-2 w-64 rounded-lg border border-line bg-bg-1 p-1.5" style={{ boxShadow: 'var(--shadow)' }}>
          <div className="px-3 py-2.5">
            <div className="truncate font-semibold">{user?.fullName}</div>
            <div className="truncate text-xs text-tx-3">{user?.email}</div>
          </div>
          <div className="my-1 h-px bg-line" />
          {[
            { icon: Wallet, label: 'Ví Spot', to: '/vi' },
            { icon: History, label: 'Lịch sử giao dịch', to: '/lich-su' },
            { icon: Store, label: 'Trung tâm thương nhân', to: '/p2p/thuong-nhan' },
            { icon: Landmark, label: 'Ngân hàng giả lập', to: '/ngan-hang' },
          ].map((it) => (
            <button
              key={it.to}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                nav(it.to);
              }}
              className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-tx-2 hover:bg-bg-3 hover:text-tx-1"
            >
              <it.icon size={16} /> {it.label}
            </button>
          ))}
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setSettings(true);
            }}
            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-tx-2 hover:bg-bg-3 hover:text-tx-1"
          >
            <Settings size={16} /> Cài đặt tài khoản
          </button>
          <div className="my-1 h-px bg-line" />
          <button
            role="menuitem"
            onClick={() => {
              logout();
              qc.clear();
              nav('/');
            }}
            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-down hover:bg-bg-3"
          >
            <LogOut size={16} /> Đăng xuất
          </button>
        </div>
      )}
      <AccountSettingsModal open={settings} onClose={() => setSettings(false)} />
    </div>
  );
}

const Badge = ({ n, tone = 'bg-brand' }: { n: number; tone?: string }) =>
  n > 0 ? <span className={cn('ml-1 rounded-full px-1.5 text-[10px] font-bold leading-4 text-white', tone)}>{n > 99 ? '99+' : n}</span> : null;

/** Khách: trang Hỗ trợ + số tin nhắn CSKH chưa đọc */
function SupportLink({ item }: { item: (active: boolean) => string }) {
  const unread = useSupportUnread();
  return (
    <NavLink to="/ho-tro" className={({ isActive }) => cn(item(isActive), 'flex items-center')}>
      Hỗ trợ
      <Badge n={unread} />
    </NavLink>
  );
}

/** Nhân viên: khu CSKH + số yêu cầu chưa ai nhận (đỏ nếu có yêu cầu quá hạn) */
function DeskLink({ item }: { item: (active: boolean) => string }) {
  const { data } = useDeskStats();
  return (
    <NavLink to="/cskh" className={({ isActive }) => cn(item(isActive), 'flex items-center gap-1.5')}>
      <Headset size={15} /> CSKH
      <Badge n={data?.unassigned ?? 0} tone={(data?.overdue ?? 0) > 0 ? 'bg-down' : 'bg-brand'} />
    </NavLink>
  );
}

export function Header() {
  const token = useAuth((s) => s.token);
  const { isAdmin } = useAdminMe();
  const staff = useIsStaff();
  const theme = useUi((s) => s.theme);
  const toggleTheme = useUi((s) => s.toggleTheme);
  const { pathname } = useLocation();
  const onMarkets = pathname === '/' || pathname === '/thi-truong';
  const item = (active: boolean) => cn('rounded-md px-3 py-1.5 text-[14px] font-medium whitespace-nowrap transition-colors', active ? 'text-brand' : 'text-tx-2 hover:text-tx-1');
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-line bg-bg-1 px-3 sm:px-4">
      <Logo />
      <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" aria-label="Điều hướng chính">
        {/* "/" chỉ là trang Thị trường khi đã đăng nhập (khách thấy trang giới thiệu) → khách dùng /thi-truong */}
        <Link to={token ? '/' : '/thi-truong'} aria-current={onMarkets ? 'page' : undefined} className={item(onMarkets)}>
          Thị trường
        </Link>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => item(isActive)}>
            {n.label}
          </NavLink>
        ))}
        {token && <SupportLink item={item} />}
        {staff && <DeskLink item={item} />}
        {isAdmin && (
          <NavLink to="/admin" className={({ isActive }) => cn(item(isActive), 'flex items-center gap-1.5')}>
            <ShieldCheck size={15} /> Quản trị
          </NavLink>
        )}
      </nav>
      <FeedBadge />
      <button
        onClick={toggleTheme}
        className="rounded-md p-2 text-tx-2 hover:bg-bg-3 hover:text-tx-1"
        aria-label={theme === 'dark' ? 'Chuyển giao diện sáng' : 'Chuyển giao diện tối'}
        title={theme === 'dark' ? 'Giao diện sáng' : 'Giao diện tối'}
      >
        {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      {token ? (
        <UserMenu />
      ) : (
        <div className="flex items-center gap-2">
          <Link to="/login" className="btn btn-ghost h-8 px-3">
            Đăng nhập
          </Link>
          <Link to="/register" className="btn btn-brand h-8 px-3">
            Đăng ký
          </Link>
        </div>
      )}
    </header>
  );
}
