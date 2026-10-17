import { memo, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowUp, ChevronsUpDown, Search, Star } from 'lucide-react';
import type { SymbolRow } from '@vss/shared';
import { WatchlistBar } from '../components/board/WatchlistBar';
import { CoinIcon } from '../components/common/CoinIcon';
import { ManualPriceBadge } from '../components/common/PriceModeBadge';
import { Empty, Spinner, useFlash } from '../components/common/ui';
import { useWatchlist } from '../lib/queries';
import { cn, fmtCompact, fmtPct, fmtPrice, signTone, toneText } from '../lib/format';
import { useMarket } from '../store/market';

type Tab = 'fav' | 'all' | 'gainers' | 'losers' | 'volume';
type SortKey = 'symbol' | 'last' | 'changePct' | 'quoteVolume';

const TABS: { value: Tab; label: string }[] = [
  { value: 'fav', label: 'Yêu thích' },
  { value: 'all', label: 'Tất cả USDT' },
  { value: 'gainers', label: 'Tăng mạnh' },
  { value: 'losers', label: 'Giảm mạnh' },
  { value: 'volume', label: 'Khối lượng lớn' },
];

/** Thẻ nổi bật: 3 cặp theo 1 tiêu chí */
function HighlightCard({ title, items }: { title: string; items: SymbolRow[] }) {
  return (
    <div className="rounded-xl border border-line bg-bg-1 p-4">
      <div className="mb-3 text-[13px] font-semibold text-tx-2">{title}</div>
      <ul className="space-y-2.5">
        {items.map((r) => (
          <li key={r.symbol}>
            <Link to={`/trade/${r.symbol}`} className="num grid grid-cols-[1fr_auto_64px] items-center gap-2 text-[13px] hover:text-brand">
              <span className="flex min-w-0 items-center gap-2 font-medium">
                <CoinIcon asset={r.baseAsset} size={20} />
                {r.baseAsset}
              </span>
              <span className="text-right">{fmtPrice(r.last, r.filters.tickSize)}</span>
              <span className={cn('text-right font-medium', toneText[signTone(r.changePct)])}>{fmtPct(r.changePct)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

const Row = memo(function Row({ r, fav, onFav, loggedIn }: { r: SymbolRow; fav: boolean; onFav(): void; loggedIn: boolean }) {
  const nav = useNavigate();
  const flash = useFlash(Number(r.last));
  const tone = signTone(r.changePct);
  return (
    <tr className="num h-14 cursor-pointer border-t border-line hover:bg-bg-2" onClick={() => nav(`/trade/${r.symbol}`)}>
      <td className="pl-4">
        <div className="flex items-center gap-3">
          {loggedIn && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onFav();
              }}
              className={fav ? 'text-brand' : 'text-tx-3 hover:text-tx-1'}
              aria-label={fav ? `Bỏ yêu thích ${r.symbol}` : `Yêu thích ${r.symbol}`}
            >
              <Star size={14} fill={fav ? 'currentColor' : 'none'} />
            </button>
          )}
          <CoinIcon asset={r.baseAsset} size={28} />
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-tx-1">
              {r.baseAsset}
              <span className="font-normal text-tx-3">/{r.quoteAsset}</span>
              {r.priceMode === 'MANUAL' && <ManualPriceBadge since={r.priceSince} compact className="ml-1.5 align-middle text-[10px]" />}
            </div>
            <div className="truncate text-[12px] text-tx-3">{r.name}</div>
          </div>
        </div>
      </td>
      <td className="text-right">
        <span className={cn('rounded px-1 text-[14px] font-medium text-tx-1', flash)}>{fmtPrice(r.last, r.filters.tickSize)}</span>
      </td>
      <td className={cn('text-right text-[14px] font-medium', toneText[tone])}>{fmtPct(r.changePct)}</td>
      <td className="hidden text-right text-[13px] text-tx-2 lg:table-cell">
        {fmtPrice(r.high, r.filters.tickSize)}
        <span className="text-tx-3"> / </span>
        {fmtPrice(r.low, r.filters.tickSize)}
      </td>
      <td className="hidden text-right text-[13px] text-tx-1 md:table-cell">{fmtCompact(r.quoteVolume)}</td>
      <td className="pr-4 text-right">
        <Link
          to={`/trade/${r.symbol}`}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex h-8 items-center rounded-lg bg-bg-3 px-3 text-[12px] font-semibold text-tx-1 hover:bg-brand hover:text-brand-ink"
        >
          Giao dịch
        </Link>
      </td>
    </tr>
  );
});

function SortHead({ label, k, sort, onSort, className }: { label: string; k: SortKey; sort: { key: SortKey; dir: 1 | -1 } | null; onSort(k: SortKey): void; className?: string }) {
  const active = sort?.key === k;
  return (
    <th className={cn('py-3 font-medium', className)}>
      <button onClick={() => onSort(k)} className={cn('inline-flex items-center gap-1 hover:text-tx-1', active && 'text-tx-1')}>
        {label}
        {active ? sort!.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : <ChevronsUpDown size={12} className="opacity-50" />}
      </button>
    </th>
  );
}

/** Trang Thị trường: thẻ nổi bật + bảng mọi cặp USDT (như Binance Markets) */
export function MarketsPage() {
  const rows = useMarket((s) => s.rows);
  const symbols = useMarket((s) => s.symbols);
  const loaded = useMarket((s) => s.loaded);
  const { list: favs, loggedIn, toggle } = useWatchlist();
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);

  const all = useMemo(() => symbols.map((s) => rows[s]!).filter(Boolean), [rows, symbols]);
  const highlights = useMemo(() => {
    const major = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'].map((s) => rows[s]).filter((r): r is SymbolRow => !!r);
    const byChange = [...all].sort((a, b) => b.changePct - a.changePct);
    return {
      major,
      gainers: byChange.slice(0, 3),
      losers: byChange.slice(-3).reverse(),
      volume: [...all].sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume)).slice(0, 3),
    };
  }, [all, rows]);

  const list = useMemo(() => {
    const term = q.trim().toUpperCase();
    let out = all.filter((r) => !term || r.baseAsset.includes(term) || r.name.toUpperCase().includes(term));
    if (tab === 'fav') out = out.filter((r) => favs.includes(r.symbol));
    if (tab === 'gainers') out = [...out].filter((r) => r.changePct > 0).sort((a, b) => b.changePct - a.changePct);
    if (tab === 'losers') out = [...out].filter((r) => r.changePct < 0).sort((a, b) => a.changePct - b.changePct);
    if (tab === 'volume') out = [...out].sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume));
    if (sort) {
      const v = (r: SymbolRow) => (sort.key === 'symbol' ? r.baseAsset : sort.key === 'changePct' ? r.changePct : Number(r[sort.key]));
      out = [...out].sort((a, b) => {
        const x = v(a);
        const y = v(b);
        return (typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number)) * sort.dir;
      });
    }
    return out;
  }, [all, tab, q, sort, favs]);

  const onSort = (key: SortKey) => setSort((s) => (s?.key === key ? (s.dir === -1 ? { key, dir: 1 } : null) : { key, dir: -1 }));

  if (!loaded) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
      <h1 className="text-[26px] font-bold tracking-tight">Thị trường</h1>
      <p className="mt-1 text-tx-3">Giá realtime từ Binance, cập nhật mỗi giây. Bấm vào một cặp để mở màn giao dịch.</p>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <HighlightCard title="Coin chính" items={highlights.major} />
        <HighlightCard title="Tăng mạnh nhất" items={highlights.gainers} />
        <HighlightCard title="Giảm mạnh nhất" items={highlights.losers} />
        <HighlightCard title="Khối lượng lớn nhất" items={highlights.volume} />
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1" role="tablist">
          {TABS.filter((t) => t.value !== 'fav' || loggedIn).map((t) => (
            <button
              key={t.value}
              role="tab"
              aria-selected={tab === t.value}
              onClick={() => setTab(t.value)}
              className={cn('h-9 rounded-lg px-3 text-[14px] font-medium', tab === t.value ? 'bg-bg-3 text-tx-1' : 'text-tx-3 hover:text-tx-1')}
            >
              {t.label}
            </button>
          ))}
        </div>
        <label className="ml-auto flex h-9 w-full items-center gap-2 rounded-lg border border-line bg-bg-1 px-3 sm:w-64">
          <Search size={15} className="text-tx-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm coin" className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-tx-3" aria-label="Tìm coin" />
        </label>
      </div>

      {tab === 'fav' && (
        <div className="mt-3">
          <WatchlistBar />
        </div>
      )}

      <div className="mt-3 overflow-x-auto rounded-xl border border-line bg-bg-1">
        <table className="w-full min-w-[560px]">
          <thead>
            <tr className="text-left text-[12px] text-tx-3">
              <SortHead label="Tên" k="symbol" sort={sort} onSort={onSort} className="pl-4" />
              <SortHead label="Giá" k="last" sort={sort} onSort={onSort} className="text-right" />
              <SortHead label="Thay đổi 24h" k="changePct" sort={sort} onSort={onSort} className="text-right" />
              <th className="hidden py-3 text-right font-medium lg:table-cell">Cao / thấp 24h</th>
              <SortHead label="KL 24h (USDT)" k="quoteVolume" sort={sort} onSort={onSort} className="hidden text-right md:table-cell" />
              <th className="pr-4" />
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <Row key={r.symbol} r={r} fav={favs.includes(r.symbol)} onFav={() => toggle(r.symbol)} loggedIn={loggedIn} />
            ))}
          </tbody>
        </table>
        {list.length === 0 && <Empty title={tab === 'fav' ? 'Chưa có cặp yêu thích' : 'Không tìm thấy cặp phù hợp'} hint={tab === 'fav' ? 'Bấm ngôi sao cạnh tên cặp để thêm vào danh sách yêu thích.' : undefined} />}
      </div>
    </div>
  );
}
