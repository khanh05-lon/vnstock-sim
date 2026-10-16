import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Star } from 'lucide-react';
import { useWatchlist } from '../../lib/queries';
import { cn, fmtPrice, signTone, toneText } from '../../lib/format';
import { useMarket } from '../../store/market';

type Tab = 'fav' | 'usdt';

/** Danh sách cặp bên phải màn giao dịch: tìm kiếm, yêu thích, giá và % 24h */
export function SymbolList({ current }: { current: string }) {
  const rows = useMarket((s) => s.rows);
  const symbols = useMarket((s) => s.symbols);
  const { list: favs, loggedIn, toggle } = useWatchlist();
  const [tab, setTab] = useState<Tab>('usdt');
  const [q, setQ] = useState('');
  const nav = useNavigate();

  const items = useMemo(() => {
    const term = q.trim().toUpperCase();
    return symbols
      .map((s) => rows[s]!)
      .filter((r) => r && (tab === 'usdt' || favs.includes(r.symbol)))
      .filter((r) => !term || r.baseAsset.includes(term) || r.name.toUpperCase().includes(term));
  }, [rows, symbols, tab, q, favs]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pt-3">
        <label className="flex h-8 items-center gap-2 rounded-lg bg-bg-3 px-2.5">
          <Search size={14} className="text-tx-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm coin" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-tx-3" aria-label="Tìm coin" />
        </label>
        <div className="mt-2 flex gap-3 text-[12px]">
          {loggedIn && (
            <button onClick={() => setTab('fav')} className={cn('flex items-center gap-1 font-medium', tab === 'fav' ? 'text-brand' : 'text-tx-3 hover:text-tx-1')}>
              <Star size={12} fill={tab === 'fav' ? 'currentColor' : 'none'} /> Yêu thích
            </button>
          )}
          <button onClick={() => setTab('usdt')} className={cn('font-medium', tab === 'usdt' ? 'text-brand' : 'text-tx-3 hover:text-tx-1')}>
            USDT
          </button>
        </div>
      </div>
      <div className="grid grid-cols-[1fr_auto_64px] gap-2 px-3 pb-1 pt-2 text-[11px] text-tx-3">
        <span>Cặp</span>
        <span className="text-right">Giá</span>
        <span className="text-right">24h</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 && <div className="px-3 py-6 text-center text-[12px] text-tx-3">{tab === 'fav' ? 'Chưa có cặp yêu thích' : 'Không tìm thấy'}</div>}
        {items.map((r) => (
          <div
            key={r.symbol}
            role="button"
            tabIndex={0}
            onClick={() => nav(`/trade/${r.symbol}`)}
            onKeyDown={(e) => e.key === 'Enter' && nav(`/trade/${r.symbol}`)}
            className={cn('num grid h-7 cursor-pointer grid-cols-[1fr_auto_64px] items-center gap-2 px-3 text-[12px] hover:bg-bg-3', r.symbol === current && 'bg-bg-2')}
          >
            <span className="flex min-w-0 items-center gap-1">
              {loggedIn && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(r.symbol);
                  }}
                  className={favs.includes(r.symbol) ? 'text-brand' : 'text-tx-3 hover:text-tx-1'}
                  aria-label={favs.includes(r.symbol) ? `Bỏ yêu thích ${r.symbol}` : `Yêu thích ${r.symbol}`}
                >
                  <Star size={11} fill={favs.includes(r.symbol) ? 'currentColor' : 'none'} />
                </button>
              )}
              <b className="truncate font-medium text-tx-1">{r.baseAsset}</b>
              <span className="text-tx-3">/{r.quoteAsset}</span>
            </span>
            <span className="text-right text-tx-1">{fmtPrice(r.last, r.filters.tickSize)}</span>
            <span className={cn('text-right', toneText[signTone(r.changePct)])}>
              {r.changePct > 0 ? '+' : ''}
              {r.changePct.toFixed(2)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
