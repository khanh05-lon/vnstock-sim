import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { BadgeCheck, Check, Copy } from 'lucide-react';
import { P2P_ORDER_STATUS_LABEL, type P2POrderStatus, type P2PTraderDTO } from '@vss/shared';
import { cn } from '../../lib/format';
import { fmtDuration, fmtRate } from '../../lib/p2p';

/** Điều hướng trong khu P2P */
export function P2PNav() {
  const items = [
    { to: '/p2p', label: 'Chợ P2P', end: true },
    { to: '/p2p/don', label: 'Đơn của tôi' },
    { to: '/p2p/thuong-nhan', label: 'Trung tâm thương nhân' },
    { to: '/ngan-hang', label: 'Ngân hàng giả lập' },
  ];
  return (
    <nav className="flex gap-1 overflow-x-auto" aria-label="Mục P2P">
      {items.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          end={it.end}
          className={({ isActive }) =>
            cn('sel-line h-8 shrink-0 px-3 text-[13px] font-medium leading-8 transition-colors [--sel-inset:0.75rem]', isActive ? 'text-tx-1' : 'text-tx-3 hover:text-tx-1')
          }
        >
          {it.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** Tên thương nhân + huy hiệu xác minh + số đơn / tỷ lệ hoàn tất 30 ngày */
export function TraderCell({ t, compact }: { t: P2PTraderDTO; compact?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/15 text-[11px] font-bold text-brand">{t.name.slice(0, 1).toUpperCase()}</span>
        <span className="truncate font-semibold">{t.name}</span>
        {t.verified && (
          <span title="Thương nhân đã xác minh" className="inline-flex shrink-0 text-brand">
            <BadgeCheck size={15} />
          </span>
        )}
      </div>
      {!compact && (
        <div className="mt-0.5 text-[11px] text-tx-3">
          {t.orders30d} đơn · hoàn tất {fmtRate(t.completionRate30d)}
          {t.avgReleaseSec != null && <> · nhả coin TB {fmtDuration(t.avgReleaseSec)}</>}
        </div>
      )}
    </div>
  );
}

const STATUS_TONE: Record<P2POrderStatus, string> = {
  PENDING_PAYMENT: 'bg-ref/15 text-ref',
  PAID: 'bg-info/15 text-info',
  APPEAL: 'bg-down/15 text-down',
  COMPLETED: 'bg-up/15 text-up',
  CANCELLED: 'bg-bg-3 text-tx-3',
};

export function OrderStatusChip({ status }: { status: P2POrderStatus }) {
  return <span className={cn('chip', STATUS_TONE[status])}>{P2P_ORDER_STATUS_LABEL[status]}</span>;
}

/** Sao chép nhanh (số tài khoản, số tiền, nội dung chuyển khoản) */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Sao chép ${label}`}
      title={`Sao chép ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
      className="rounded p-1 text-tx-3 hover:bg-bg-3 hover:text-tx-1"
    >
      {done ? <Check size={13} className="text-up" /> : <Copy size={13} />}
    </button>
  );
}

/** Đếm ngược tới hạn (mm:ss); hết hạn trả về null */
export function countdown(deadline: string | null | undefined, now: number): string | null {
  if (!deadline) return null;
  const ms = new Date(deadline).getTime() - now;
  if (ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
