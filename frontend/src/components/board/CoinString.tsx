import type React from 'react';
import { Link } from 'react-router-dom';
import type { SymbolRow } from '@vss/shared';
import { cn, fmtPct, signTone } from '../../lib/format';

/** Độ đậm của màu theo biên độ: 0% → gần nền, ≥ 6% → màu đầy */
const intensity = (pct: number) => Math.round(18 + Math.min(Math.abs(pct) / 6, 1) * 82);

function fillOf(pct: number) {
  const tone = signTone(pct);
  if (tone === 'flat') return 'var(--bg-4)';
  return `color-mix(in srgb, var(--${tone === 'up' ? 'up' : 'down'}) ${intensity(pct)}%, var(--bg-3))`;
}

/** Một đồng xu lỗ vuông; sợi dây chạy qua lỗ */
export function Coin({ pct }: { pct: number }) {
  return (
    <svg viewBox="0 0 32 32" className="relative h-9 w-9 xl:h-[34px] xl:w-[34px]" aria-hidden>
      <path fillRule="evenodd" d="M16 1a15 15 0 1 1 0 30a15 15 0 1 1 0-30zM12.5 12.5v7h7v-7z" fill={fillOf(pct)} />
      <circle cx="16" cy="16" r="11.6" fill="none" stroke="var(--bg-0)" strokeOpacity="0.35" strokeWidth="1" />
    </svg>
  );
}

/**
 * "Xâu tiền": mọi cặp là một đồng xu xâu trên một sợi dây (như quan tiền ngày xưa), xếp từ tăng mạnh nhất tới giảm mạnh nhất,
 * màu đậm theo biên độ 24h. Nhìn một lượt là biết độ rộng của thị trường; bấm một đồng để mở màn giao dịch.
 */
export function CoinString({ rows }: { rows: SymbolRow[] }) {
  const sorted = [...rows].sort((a, b) => b.changePct - a.changePct);
  return (
    // Màn rộng: cả xâu trên một sợi dây; nhỏ hơn: hàng 10 / 6 đồng (30 cặp chia đều, không có hàng lửng)
    <ol
      className="grid grid-cols-6 gap-y-4 sm:grid-cols-10 xl:[grid-template-columns:repeat(var(--n),minmax(0,1fr))]"
      style={{ '--n': sorted.length } as React.CSSProperties}
      aria-label="Các cặp xếp theo thay đổi 24 giờ"
    >
      {sorted.map((r) => (
        <li key={r.symbol} className="relative">
          {/* đoạn dây của ô này: các ô liền nhau nối thành một sợi */}
          <span aria-hidden className="absolute inset-x-0 top-[18px] h-px bg-line-2 xl:top-[17px]" />
          <Link
            to={`/trade/${r.symbol}`}
            className="group relative flex flex-col items-center gap-1 rounded-md pb-1 outline-offset-0"
            title={`${r.baseAsset}/${r.quoteAsset} ${fmtPct(r.changePct)}`}
          >
            <span className="transition-transform group-hover:-translate-y-0.5">
              <Coin pct={r.changePct} />
            </span>
            <span className="text-[11px] font-semibold leading-none text-tx-1">{r.baseAsset}</span>
            <span className={cn('num text-[11px] leading-none', r.changePct > 0 ? 'text-up' : r.changePct < 0 ? 'text-down' : 'text-tx-3')}>{fmtPct(r.changePct, 1)}</span>
          </Link>
        </li>
      ))}
    </ol>
  );
}
