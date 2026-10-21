import { cn, fmtCompact } from '../../lib/format';

// Dải màu đồng thau từ đậm tới nhạt rồi các xám ấm: một họ màu, không cầu vồng
export const PALETTE = ['#c69653', '#e2c391', '#8f6a35', '#f0dfc2', '#6b4f27', '#bdb5a8', '#958d80', '#d8cfc0', '#6f675b', '#a89d8c', '#4c453b'];

export interface Slice {
  label: string;
  value: number;
  color: string;
}

export function AllocationDonut({ slices, total, className }: { slices: Slice[]; total: number; className?: string }) {
  const R = 70;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className={cn('flex flex-col items-center gap-4 sm:flex-row sm:items-center', className)}>
      <svg width={180} height={180} viewBox="0 0 180 180" role="img" aria-label="Biểu đồ phân bổ tài sản" className="shrink-0">
        <circle cx={90} cy={90} r={R} fill="none" stroke="var(--bg-3)" strokeWidth={22} />
        {slices.map((s) => {
          const frac = total > 0 ? s.value / total : 0;
          const len = frac * C;
          const el = (
            <circle
              key={s.label}
              cx={90}
              cy={90}
              r={R}
              fill="none"
              stroke={s.color}
              strokeWidth={22}
              strokeDasharray={`${Math.max(0, len - 1.5)} ${C}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 90 90)"
            >
              <title>
                {s.label}: {(frac * 100).toFixed(1)}%
              </title>
            </circle>
          );
          offset += len;
          return el;
        })}
        <text x={90} y={84} textAnchor="middle" fill="var(--tx-3)" fontSize={11}>
          Tổng tài sản
        </text>
        <text x={90} y={104} textAnchor="middle" fill="var(--tx-1)" fontSize={15} fontWeight={700}>
          {fmtCompact(total)}
        </text>
      </svg>
      <ul className="num grid w-full grid-cols-2 gap-x-4 gap-y-1.5 text-[12px] sm:grid-cols-1">
        {slices.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} />
            <span className="flex-1 truncate text-tx-2">{s.label}</span>
            <span className="font-medium">{total > 0 ? ((s.value / total) * 100).toFixed(1) : '0.0'}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
