import { memo } from 'react';
import type { IndexSnapshot } from '@vss/shared';
import { cn, fmtSigned, fmtPct, signTone, toneText, toneVar } from '../../lib/format';
import { useMarket } from '../../store/market';
import { Sparkline } from '../common/ui';

const IndexCard = memo(function IndexCard({ ix }: { ix: IndexSnapshot }) {
  const tone = signTone(ix.change);
  const arrow = ix.change > 0 ? '▲' : ix.change < 0 ? '▼' : '■';
  return (
    <div className="flex min-w-[260px] flex-1 items-center gap-3 rounded-lg bg-bg-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[12px] font-semibold text-tx-2">{ix.name}</span>
          <span className="num text-[11px] text-tx-3">{(ix.totalValue / 1e9).toLocaleString('en-US', { maximumFractionDigits: 0 })} tỷ</span>
        </div>
        <div className="mt-0.5 flex items-baseline gap-2">
          <span className={cn('num text-[17px] font-bold', toneText[tone])}>{ix.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          <span className={cn('num text-[12px] font-medium', toneText[tone])}>
            {arrow} {fmtSigned(ix.change)} ({fmtPct(ix.changePct)})
          </span>
        </div>
        <div className="num mt-0.5 flex items-center gap-2 text-[11px]">
          <span className="text-up">
            ↑{ix.advances}
            <span className="text-ceil"> ({ix.ceilings})</span>
          </span>
          <span className="text-ref">■{ix.unchanged}</span>
          <span className="text-down">
            ↓{ix.declines}
            <span className="text-floor"> ({ix.floors})</span>
          </span>
          <span className="ml-auto text-tx-3">{(ix.volume / 1e6).toLocaleString('en-US', { maximumFractionDigits: 1 })} tr CP</span>
        </div>
      </div>
      <Sparkline data={ix.spark} baseline={ix.prevClose} color={toneVar[tone]} width={96} height={44} />
    </div>
  );
});

export function IndexBar() {
  const indices = useMarket((s) => s.indices);
  if (!indices.length) {
    return (
      <div className="flex gap-2 overflow-x-auto px-3 py-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-[70px] min-w-[260px] flex-1 animate-pulse rounded-lg bg-bg-2" />
        ))}
      </div>
    );
  }
  return (
    <div className="flex gap-2 overflow-x-auto px-3 py-2">
      {indices.map((ix) => (
        <IndexCard key={ix.code} ix={ix} />
      ))}
    </div>
  );
}
