import { memo, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { cn, fmtPrice, priceTone, toneText } from '../../lib/format';
import { useWatchlist } from '../../lib/queries';
import { useMarket, useStock } from '../../store/market';
import { Empty, Tabs, useFlash } from '../common/ui';

const Row = memo(function Row({ symbol, active }: { symbol: string; active: boolean }) {
  const r = useStock(symbol);
  const nav = useNavigate();
  const flash = useFlash(r?.last);
  if (!r) return null;
  const traded = r.volume > 0;
  const tone = traded ? priceTone(r.last, r.ref, r.ceil, r.floor) : 'ref';
  return (
    <button
      onClick={() => nav(`/trade/${symbol}`)}
      className={cn('num grid h-8 w-full grid-cols-[1fr_auto_64px] items-center gap-2 px-3 text-left text-[12px] hover:bg-bg-3', active && 'bg-bg-3')}
    >
      <span className="min-w-0">
        <span className={cn('font-semibold', active ? 'text-brand' : 'text-tx-1')}>{symbol}</span>
        <span className="ml-1.5 text-[10px] text-tx-3">{r.exchange}</span>
      </span>
      <span className={cn('rounded px-1 text-right font-medium', toneText[tone], flash)}>{fmtPrice(traded ? r.last : r.ref)}</span>
      <span className={cn('rounded px-1 py-0.5 text-center text-[11px] font-semibold', tone === 'none' ? 'text-tx-2' : toneText[tone])}>
        {traded ? `${r.changePct > 0 ? '+' : ''}${r.changePct.toFixed(2)}%` : '0.00%'}
      </span>
    </button>
  );
});

export function SymbolList({ current }: { current: string }) {
  const { list: watch, loggedIn } = useWatchlist();
  const loaded = useMarket((s) => s.loaded);
  const [tab, setTab] = useState<'WATCH' | 'VN30' | 'ALL'>(loggedIn ? 'WATCH' : 'VN30');
  const [q, setQ] = useState('');

  const symbols = useMemo(() => {
    if (!loaded) return [];
    const rows = useMarket.getState().rows;
    const Q = q.trim().toUpperCase();
    let list = Object.values(rows);
    if (Q) list = list.filter((r) => r.symbol.startsWith(Q));
    else if (tab === 'WATCH') list = list.filter((r) => watch.includes(r.symbol));
    else if (tab === 'VN30') list = list.filter((r) => r.isVn30);
    return list.map((r) => r.symbol).sort();
  }, [loaded, tab, watch, q]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 pt-2">
        <div className="relative flex-1">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-tx-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm mã" className="input h-8 pl-7 text-[12px]" aria-label="Tìm mã" />
        </div>
      </div>
      <Tabs
        size="sm"
        className="px-3 py-2"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'WATCH', label: 'Theo dõi', disabled: !loggedIn },
          { value: 'VN30', label: 'VN30' },
          { value: 'ALL', label: 'Tất cả' },
        ]}
      />
      <div className="grid grid-cols-[1fr_auto_64px] gap-2 px-3 pb-1 text-[11px] text-tx-3">
        <span>Mã</span>
        <span className="text-right">Giá</span>
        <span className="text-center">+/- %</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {symbols.length ? symbols.map((s) => <Row key={s} symbol={s} active={s === current} />) : <Empty title="Danh sách trống" hint={tab === 'WATCH' ? 'Bấm ☆ cạnh mã để theo dõi' : undefined} />}
      </div>
    </div>
  );
}
