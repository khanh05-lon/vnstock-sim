import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '../../lib/format';
import { Modal } from '../common/ui';

export function Section({ title, actions, children, className, pad = true }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cn('panel overflow-hidden', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="font-semibold">{title}</h2>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className={pad ? 'p-4' : undefined}>{children}</div>
    </section>
  );
}

export function Kpi({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="panel p-4">
      <div className="label">{label}</div>
      <div className={cn('num mt-1 text-[22px] font-bold', tone)}>{value}</div>
      {sub && <div className="num mt-0.5 text-[12px] text-tx-3">{sub}</div>}
    </div>
  );
}

export function Pill({ tone, children }: { tone: 'good' | 'warn' | 'bad' | 'info' | 'muted' | 'brand'; children: ReactNode }) {
  const cls = {
    good: 'bg-up/15 text-up',
    warn: 'bg-ref/15 text-ref',
    bad: 'bg-down/15 text-down',
    info: 'bg-info/15 text-info',
    muted: 'bg-bg-4 text-tx-3',
    brand: 'bg-brand/15 text-brand',
  }[tone];
  return <span className={cn('chip h-5 px-1.5 text-[10px]', cls)}>{children}</span>;
}

export function KeyValue({ items, cols = 2 }: { items: [ReactNode, ReactNode][]; cols?: 1 | 2 }) {
  return (
    <dl className={cn('num grid grid-cols-1 gap-x-6 gap-y-2', cols === 2 && 'sm:grid-cols-2')}>
      {items.map(([k, v], i) => (
        <div key={i} className="flex justify-between gap-3 border-b border-line/60 pb-1.5 text-[12.5px]">
          <dt className="text-tx-3">{k}</dt>
          <dd className="truncate text-right font-medium">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Hộp xác nhận có ô lý do (mọi thao tác quản trị quan trọng đều phải ghi lý do vào nhật ký) */
export function ReasonModal({
  open,
  title,
  description,
  confirmLabel,
  danger,
  requireReason = true,
  placeholder,
  extra,
  canConfirm = true,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  requireReason?: boolean;
  placeholder?: string;
  extra?: ReactNode;
  canConfirm?: boolean;
  onClose(): void;
  onConfirm(reason: string): Promise<unknown> | void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const ok = canConfirm && (!requireReason || reason.trim().length >= 3);
  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title={title}
      width={460}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Huỷ
          </button>
          <button
            className={cn('btn min-w-28', danger ? 'btn-down' : 'btn-brand')}
            disabled={!ok || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(reason.trim());
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Đang xử lý…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {description && <div className="text-tx-2">{description}</div>}
        {extra}
        {requireReason && (
          <label className="block">
            <span className="label">Lý do (ghi vào nhật ký quản trị, tối thiểu 3 ký tự)</span>
            <textarea
              className="input mt-1 h-20 resize-none py-2"
              value={reason}
              placeholder={placeholder}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        )}
      </div>
    </Modal>
  );
}

export const fmtAgo = (iso: string | null) => {
  if (!iso) return 'chưa có';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'vừa xong';
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  return `${Math.floor(s / 86400)} ngày trước`;
};
