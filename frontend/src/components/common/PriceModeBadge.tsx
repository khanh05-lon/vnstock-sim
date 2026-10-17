import { cn, fmtDateTime } from '../../lib/format';

/** Nhãn cho nhà đầu tư: cặp đang dùng giá do sàn điều chỉnh (không theo Binance) */
export function ManualPriceBadge({ since, compact, className }: { since?: number | null; compact?: boolean; className?: string }) {
  return (
    <span
      className={cn('chip bg-ref/15 text-ref', className)}
      title={`Giá cặp này đang do sàn điều chỉnh${since ? ` từ ${fmtDateTime(since)}` : ''}, không theo giá Binance. Lệnh khớp theo giá trên sàn.`}
    >
      {compact ? 'Điều chỉnh' : 'Giá điều chỉnh'}
    </span>
  );
}
