import { Star } from 'lucide-react';
import { useWatchlist } from '../../lib/queries';
import { cn, fmtCompact, fmtPct, fmtPrice, signTone, toneText } from '../../lib/format';
import { useMarket, useSymbolRow } from '../../store/market';
import { CoinIcon } from '../common/CoinIcon';
import { useFlash } from '../common/ui';

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-tx-3">{label}</div>
      <div className="num truncate text-[13px] font-medium text-tx-1">{children}</div>
    </div>
  );
}

/** Thanh thông tin cặp: giá, thay đổi / cao / thấp / khối lượng 24h (như Binance) */
export function SymbolHeader({ symbol }: { symbol: string }) {
  const r = useSymbolRow(symbol);
  const feed = useMarket((s) => s.status?.feed);
  const { list, toggle, loggedIn, listName } = useWatchlist();
  const flash = useFlash(r ? Number(r.last) : undefined);
  if (!r) return null;
  const tone = signTone(r.changePct);
  const watched = list.includes(symbol);
  const tick = r.filters.tickSize;

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
      <div className="flex items-center gap-2.5">
        {loggedIn && (
          <button
            onClick={() => toggle(symbol)}
            className={cn('rounded p-0.5', watched ? 'text-brand' : 'text-tx-3 hover:text-tx-1')}
            aria-label={watched ? `Bỏ ${symbol} khỏi "${listName}"` : `Thêm ${symbol} vào "${listName}"`}
            title={watched ? `Bỏ khỏi "${listName}"` : `Thêm vào "${listName}"`}
          >
            <Star size={16} fill={watched ? 'currentColor' : 'none'} />
          </button>
        )}
        <CoinIcon asset={r.baseAsset} size={28} />
        <div>
          <div className="text-[17px] font-bold leading-tight">
            {r.baseAsset}
            <span className="text-tx-3">/{r.quoteAsset}</span>
          </div>
          <div className="text-[11px] text-tx-3">{r.name}</div>
        </div>
      </div>

      <div>
        <div className={cn('num rounded px-1 text-[20px] font-bold leading-tight', toneText[tone], flash)}>{fmtPrice(r.last, tick)}</div>
        <div className="num text-[11px] text-tx-3">≈ ${fmtPrice(r.last, tick)}</div>
      </div>

      <div className="grid flex-1 grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-5">
        <Stat label="Thay đổi 24h">
          <span className={toneText[tone]}>
            {fmtPrice(r.change, tick)} {fmtPct(r.changePct)}
          </span>
        </Stat>
        <Stat label="Cao nhất 24h">{fmtPrice(r.high, tick)}</Stat>
        <Stat label="Thấp nhất 24h">{fmtPrice(r.low, tick)}</Stat>
        <Stat label={`KL 24h (${r.baseAsset})`}>{fmtCompact(r.volume)}</Stat>
        <Stat label={`KL 24h (${r.quoteAsset})`}>{fmtCompact(r.quoteVolume)}</Stat>
      </div>

      {r.status !== 'TRADING' && <span className="chip bg-down/15 text-down">Tạm ngừng giao dịch</span>}
      {feed === 'SIM' && (
        <span className="chip bg-ref/15 text-ref" title="Mất kết nối Binance, giá đang chạy giả lập">
          Giá giả lập
        </span>
      )}
    </div>
  );
}
