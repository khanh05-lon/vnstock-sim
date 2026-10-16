import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, History, LogOut, Moon, Settings, ShieldCheck, Sun, Wallet } from 'lucide-react';
import { PHASE_LABEL } from '@vss/shared';
import { cn, fmtCompact, fmtPct, signTone, toneText } from '../../lib/format';
import { navOfAccount, usePortfolio } from '../../lib/queries';
import { useAdminMe } from '../../lib/admin';
import { useAuth } from '../../store/auth';
import { useMarket } from '../../store/market';
import { useUi } from '../../store/ui';
import { AccountSettingsModal } from './AccountSettingsModal';

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link to="/" className="flex items-center gap-2 shrink-0" aria-label="VNStock — trang chủ">
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="8" fill="var(--brand)" />
        <g fill="var(--brand-ink)">
          <rect x="7" y="12" width="4" height="10" rx="1" />
          <rect x="8.5" y="8" width="1" height="17" />
          <rect x="14" y="7" width="4" height="12" rx="1" />
          <rect x="15.5" y="4" width="1" height="18" />
          <rect x="21" y="14" width="4" height="8" rx="1" />
          <rect x="22.5" y="10" width="1" height="15" />
        </g>
      </svg>
      {!compact && (
        <span className="hidden items-baseline gap-1.5 sm:flex">
          <span className="text-[17px] font-extrabold tracking-tight">
            VN<span className="text-brand">Stock</span>
          </span>
          <span className="chip h-[18px] bg-brand/15 px-1.5 text-[10px] text-brand">SIM</span>
        </span>
      )}
    </Link>
  );
}

const NAV = [
  { to: '/trade', label: 'Giao dịch' },
  { to: '/market', label: 'Thị trường' },
  { to: '/bo-loc', label: 'Bộ lọc' },
  { to: '/xep-hang', label: 'Xếp hạng' },
  { to: '/portfolio', label: 'Tài sản' },
  { to: '/history', label: 'Lịch sử' },
];

function useVnClock() {
  const skew = useMarket((s) => s.clockSkew);
  const [now, setNow] = useState(() => Date.now() + skew);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + skew), 1000);
    return () => clearInterval(t);
  }, [skew]);
  return new Date(now + 7 * 3600_000).toISOString().slice(11, 19);
}

function SessionBadge() {
  const session = useMarket((s) => s.session);
  const connected = useMarket((s) => s.connected);
  const clock = useVnClock();
  const open = session?.phase === 'CONTINUOUS' || session?.phase === 'ATO' || session?.phase === 'ATC';
  return (
    <div className="hidden items-center gap-2 rounded-md bg-bg-2 px-2.5 py-1 text-xs md:flex" title={session?.mode === 'SIMULATED_24_7' ? 'Thị trường mô phỏng hoạt động 24/7' : 'Theo giờ giao dịch HOSE'}>
      <span className={cn('h-2 w-2 rounded-full', !connected ? 'bg-tx-3' : open ? 'bg-up pulse-dot' : 'bg-ref')} />
      <span className="text-tx-2">{session ? PHASE_LABEL[session.phase] : 'Đang kết nối…'}</span>
      <span className="num font-medium text-tx-1">{clock}</span>
      {session?.feed && (
        <span
          className={cn('rounded px-1.5 py-px text-[10px] font-semibold', session.feed === 'LIVE' ? 'bg-up/15 text-up' : 'bg-bg-3 text-tx-3')}
          title={session.feed === 'LIVE' ? 'Bảng giá lấy từ dữ liệu thị trường thật' : 'Giá giả lập (chưa có dữ liệu thật hoặc ngoài giờ giao dịch)'}
        >
          {session.feed === 'LIVE' ? 'Giá thật' : 'Giả lập'}
        </span>
      )}
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
  const { data } = usePortfolio();
  const rows = useMarket((s) => s.rows);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  let nav_ = 0;
  let pnlPct = 0;
  if (data) {
    const stock = data.holdings.reduce((a, h) => {
      const r = rows[h.symbol];
      const p = r ? (r.volume > 0 ? r.last : r.ref) : h.marketPrice;
      return a + p * h.qtyTotal;
    }, 0);
    nav_ = navOfAccount(data.account, stock);
    const base = data.account.contributed ?? data.account.initialCapital;
    pnlPct = ((nav_ - base) / base) * 100;
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
          <span className="block text-[11px] text-tx-3">Tài sản ròng</span>
          <span className="num block text-[13px] font-semibold">
            {data ? fmtCompact(nav_) : '—'}{' '}
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
            { icon: Wallet, label: 'Tài sản & danh mục', to: '/portfolio' },
            { icon: History, label: 'Lịch sử giao dịch', to: '/history' },
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

export function Header() {
  const token = useAuth((s) => s.token);
  const { isAdmin } = useAdminMe();
  const theme = useUi((s) => s.theme);
  const toggleTheme = useUi((s) => s.toggleTheme);
  const { pathname } = useLocation();
  const onBoard = pathname === '/' || pathname === '/bang-gia';
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-line bg-bg-1 px-3 sm:px-4">
      <Logo />
      <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" aria-label="Điều hướng chính">
        {/* "/" chỉ là bảng giá khi đã đăng nhập (khách thấy trang giới thiệu) → khách dùng /bang-gia */}
        <Link
          to={token ? '/' : '/bang-gia'}
          aria-current={onBoard ? 'page' : undefined}
          className={cn(
            'rounded-md px-3 py-1.5 text-[14px] font-medium whitespace-nowrap transition-colors',
            onBoard ? 'text-brand' : 'text-tx-2 hover:text-tx-1',
          )}
        >
          Bảng giá
        </Link>
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            className={({ isActive }) =>
              cn(
                'rounded-md px-3 py-1.5 text-[14px] font-medium whitespace-nowrap transition-colors',
                isActive ? 'text-brand' : 'text-tx-2 hover:text-tx-1',
              )
            }
          >
            {n.label}
          </NavLink>
        ))}
        {isAdmin && (
          <NavLink
            to="/admin"
            className={({ isActive }) =>
              cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[14px] font-medium whitespace-nowrap transition-colors',
                isActive ? 'text-brand' : 'text-tx-2 hover:text-tx-1',
              )
            }
          >
            <ShieldCheck size={15} /> Quản trị
          </NavLink>
        )}
      </nav>
      <SessionBadge />
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
