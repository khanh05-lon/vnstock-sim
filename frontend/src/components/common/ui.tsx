import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Inbox, Loader2, X } from 'lucide-react';
import { cn } from '../../lib/format';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('animate-spin text-tx-3', className)} size={18} />;
}

export function Empty({ title, hint, icon }: { title: string; hint?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <div className="text-tx-3">{icon ?? <Inbox size={28} strokeWidth={1.5} />}</div>
      <div className="text-tx-2 font-medium">{title}</div>
      {hint && <div className="text-tx-3 text-xs max-w-xs">{hint}</div>}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
  size = 'md',
  className,
}: {
  value: T;
  onChange(v: NoInfer<T>): void;
  items: { value: NoInfer<T>; label: ReactNode; disabled?: boolean }[];
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div role="tablist" className={cn('flex items-center gap-1', className)}>
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          aria-selected={value === it.value}
          disabled={it.disabled}
          onClick={() => onChange(it.value)}
          className={cn(
            'sel-line font-medium transition-colors whitespace-nowrap [--sel-inset:0.5rem]',
            size === 'sm' ? 'h-7 px-2 text-xs' : 'h-8 px-2 text-[13px]',
            value === it.value ? 'text-tx-1' : 'text-tx-3 hover:text-tx-1',
            it.disabled && 'opacity-40',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** Tab gạch chân kiểu Binance */
export function UnderlineTabs<T extends string>({
  value,
  onChange,
  items,
  className,
}: {
  value: T;
  onChange(v: NoInfer<T>): void;
  items: { value: NoInfer<T>; label: ReactNode }[];
  className?: string;
}) {
  return (
    <div role="tablist" className={cn('flex min-w-0 items-center gap-5 overflow-x-auto border-b border-line px-3', className)}>
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={cn(
            'sel-line h-10 shrink-0 text-[13px] font-medium transition-colors whitespace-nowrap',
            value === it.value ? 'text-tx-1' : 'text-tx-3 hover:text-tx-2',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 440,
}: {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'var(--overlay)' }} onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-full rounded-xl border border-line bg-bg-1"
        style={{ maxWidth: width, boxShadow: 'var(--shadow)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-tx-3 hover:bg-bg-3 hover:text-tx-1" aria-label="Đóng">
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Số nháy màu khi đổi giá trị */
export function useFlash(value: number | undefined): string {
  const prev = useRef(value);
  const [cls, setCls] = useState('');
  useEffect(() => {
    if (prev.current !== undefined && value !== undefined && prev.current !== value) {
      setCls(value > prev.current ? 'flash-up' : 'flash-down');
      const t = setTimeout(() => setCls(''), 900);
      prev.current = value;
      return () => clearTimeout(t);
    }
    prev.current = value;
  }, [value]);
  return cls;
}

export function Sparkline({
  data,
  color,
  width = 120,
  height = 36,
  baseline,
  className,
}: {
  data: number[];
  color: string;
  width?: number;
  height?: number;
  baseline?: number;
  className?: string;
}) {
  const id = `sg${useId().replace(/:/g, '')}`;
  if (data.length < 2) return <svg width={width} height={height} className={className} />;
  const vals = baseline != null ? [...data, baseline] : data;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i: number) => (i / (data.length - 1)) * width;
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4);
  const pts = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} preserveAspectRatio="none">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {baseline != null && (
        <line x1={0} x2={width} y1={y(baseline)} y2={y(baseline)} stroke="var(--ref)" strokeOpacity={0.5} strokeDasharray="2 3" strokeWidth={1} />
      )}
      <polygon points={`0,${height} ${pts} ${width},${height}`} fill={`url(#${id})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" />
    </svg>
  );
}

export function Stat({ label, value, sub, className }: { label: ReactNode; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="label truncate">{label}</div>
      <div className="mt-0.5 truncate font-semibold num">{value}</div>
      {sub && <div className="text-xs num">{sub}</div>}
    </div>
  );
}
