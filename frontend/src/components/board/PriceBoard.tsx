import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowUp, Search, Star } from 'lucide-react';
import type { BookLevel, StockRow } from '@vss/shared';
import { cn, fmtChange, fmtPrice, fmtVol, priceTone, toneBg, toneText, type Tone } from '../../lib/format';
import { useWatchlist } from '../../lib/queries';
import { WatchlistBar } from './WatchlistBar';
import { useMarket, useStock } from '../../store/market';
import { Empty, Spinner, Tabs, useFlash } from '../common/ui';

type BoardTab = 'VN30' | 'HOSE' | 'HNX' | 'UPCOM' | 'ETF' | 'CW' | 'BOND' | 'WATCH';
type SortKey = 'symbol' | 'last' | 'changePct' | 'volume' | 'value';

function Cell({ v, text, tone = 'none', className, hl }: { v: number; text: string; tone?: Tone; className?: string; hl?: boolean }) {
  const flash = useFlash(v);
  return <td className={cn('px-1.5 text-right', toneText[tone], hl && 'bg-col-hl', flash, className)}>{text}</td>;
}

function BookCells({ levels, ref_, ceil, floor, reverse }: { levels: BookLevel[]; ref_: number; ceil: number; floor: number; reverse?: boolean }) {
  const cells: ReactNode[] = [];
  const idx = reverse ? [2, 1, 0] : [0, 1, 2];
  for (const i of idx) {
    const l = levels[i];
    const tone = l ? priceTone(l.p, ref_, ceil, floor) : 'none';
    cells.push(<Cell key={`p${i}`} v={l?.p ?? 0} text={fmtPrice(l?.p)} tone={tone} />);
    cells.push(<Cell key={`v${i}`} v={l?.v ?? 0} text={fmtVol(l?.v)} tone={tone} className={i === 0 && reverse ? 'border-r border-line' : undefined} />);
  }
  return <>{cells}</>;
}

const BoardRow = memo(function BoardRow({ symbol, starred, onStar, index }: { symbol: string; starred: boolean; onStar(s: string): void; index: number }) {
  const r = useStock(symbol);
  const nav = useNavigate();
  if (!r) return null;
  const traded = r.volume > 0;
  const tone = traded ? priceTone(r.last, r.ref, r.ceil, r.floor) : 'none';
  return (
    <tr
      onClick={() => nav(`/trade/${symbol}`)}
      className={cn('h-[26px] cursor-pointer border-b border-line/60 hover:bg-bg-3', index % 2 === 1 && 'bg-row-alt')}
      title={`${r.name} · ${r.exchange} · ${r.industry}`}
    >
      <td className="pl-2 pr-0">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onStar(symbol);
          }}
          className={cn('flex items-center', starred ? 'text-brand' : 'text-tx-3 opacity-40 hover:opacity-100')}
          aria-label={starred ? `Bỏ theo dõi ${symbol}` : `Theo dõi ${symbol}`}
        >
          <Star size={13} fill={starred ? 'currentColor' : 'none'} />
        </button>
      </td>
      <td className={cn('bg-col-hl px-1.5 text-left font-semibold', toneText[tone])}>{symbol}</td>
      <td className="px-1.5 text-right text-ceil">{fmtPrice(r.ceil)}</td>
      <td className="px-1.5 text-right text-floor">{fmtPrice(r.floor)}</td>
      <td className="border-r border-line px-1.5 text-right text-ref">{fmtPrice(r.ref)}</td>
      <BookCells levels={r.bids} ref_={r.ref} ceil={r.ceil} floor={r.floor} reverse />
      <Cell v={r.last} text={traded ? fmtPrice(r.last) : ''} tone={tone} hl className="font-semibold" />
      <Cell v={r.lastVol} text={traded ? fmtVol(r.lastVol) : ''} tone={tone} hl />
      <Cell v={r.change} text={traded ? fmtChange(r.change) : ''} tone={tone} hl />
      <Cell v={r.changePct} text={traded ? `${r.changePct.toFixed(2)}%` : ''} tone={tone} hl className="border-r border-line" />
      <BookCells levels={r.asks} ref_={r.ref} ceil={r.ceil} floor={r.floor} />
      <Cell v={r.volume} text={fmtVol(r.volume)} className="border-l border-line text-tx-1" />
      <Cell v={r.high} text={fmtPrice(r.high)} tone={priceTone(r.high, r.ref, r.ceil, r.floor)} />
      <Cell v={r.low} text={fmtPrice(r.low)} tone={priceTone(r.low, r.ref, r.ceil, r.floor)} className="border-r border-line" />
      <Cell v={r.foreignBuy} text={fmtVol(r.foreignBuy)} className="text-tx-2" />
      <Cell v={r.foreignSell} text={fmtVol(r.foreignSell)} className="pr-2 text-tx-2" />
    </tr>
  );
});

function SortTh({ k, sort, setSort, children, className }: { k: SortKey; sort: { key: SortKey; dir: 1 | -1 }; setSort(s: { key: SortKey; dir: 1 | -1 }): void; children: ReactNode; className?: string }) {
  const active = sort.key === k;
  return (
    <th
      rowSpan={2}
      className={cn('cursor-pointer select-none hover:text-tx-1', active && 'text-tx-1', className)}
      onClick={() => setSort({ key: k, dir: active ? (sort.dir === 1 ? -1 : 1) : k === 'symbol' ? 1 : -1 })}
      aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
    >
      <span className="inline-flex items-center gap-0.5">
        {children}
        {active && (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </span>
    </th>
  );
}

export function PriceBoard() {
  const loaded = useMarket((s) => s.loaded);
  const { list: watch, listName, loggedIn, toggle } = useWatchlist();
  const nav = useNavigate();
  const [tab, setTab] = useState<BoardTab>('VN30');
  const [industry, setIndustry] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'symbol', dir: 1 });
  const [tick, setTick] = useState(0);

  // sắp xếp theo dữ liệu realtime: cập nhật thứ tự mỗi 3 giây để dòng không nhảy liên tục
  useEffect(() => {
    if (sort.key === 'symbol') return;
    const t = setInterval(() => setTick((x) => x + 1), 3000);
    return () => clearInterval(t);
  }, [sort.key]);

  const industries = useMemo(() => {
    if (!loaded) return [];
    return [...new Set(Object.values(useMarket.getState().rows).map((r) => r.industry))].sort((a, b) => a.localeCompare(b, 'vi'));
  }, [loaded]);

  const symbols = useMemo(() => {
    if (!loaded) return [];
    const rows = useMarket.getState().rows;
    const q = query.trim().toUpperCase();
    const watchSet = new Set(watch);
    let list: StockRow[] = Object.values(rows).filter((r) => {
      if (q) return r.symbol.startsWith(q) || r.name.toUpperCase().includes(q);
      if (tab === 'VN30' && !r.isVn30) return false;
      // Tab sàn chỉ hiện cổ phiếu; ETF, chứng quyền, trái phiếu có tab riêng như bảng điện của CTCK
      if ((tab === 'HOSE' || tab === 'HNX' || tab === 'UPCOM') && (r.exchange !== tab || (r.type ?? 'STOCK') !== 'STOCK')) return false;
      if ((tab === 'ETF' || tab === 'CW' || tab === 'BOND') && r.type !== tab) return false;
      if (tab === 'WATCH' && !watchSet.has(r.symbol)) return false;
      if (industry && r.industry !== industry) return false;
      return true;
    });
    const k = sort.key;
    list = list.sort((a, b) => {
      if (k === 'symbol') return a.symbol.localeCompare(b.symbol) * sort.dir;
      const va = k === 'last' ? (a.volume ? a.last : a.ref) : (a[k] as number);
      const vb = k === 'last' ? (b.volume ? b.last : b.ref) : (b[k] as number);
      return (va - vb) * sort.dir;
    });
    return list.map((r) => r.symbol);
  }, [loaded, tab, industry, query, watch, sort, tick]);

  const starSet = useMemo(() => new Set(watch), [watch]);
  const onStar = (s: string) => {
    if (!loggedIn) {
      nav('/login', { state: { from: '/' } });
      return;
    }
    toggle(s);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <Tabs
          value={tab}
          onChange={(v) => {
            setTab(v);
            setQuery('');
          }}
          items={[
            { value: 'VN30', label: 'VN30' },
            { value: 'HOSE', label: 'HOSE' },
            { value: 'HNX', label: 'HNX' },
            { value: 'UPCOM', label: 'UPCOM' },
            { value: 'ETF', label: 'ETF' },
            { value: 'CW', label: 'Chứng quyền' },
            { value: 'BOND', label: 'Trái phiếu' },
            {
              value: 'WATCH',
              label: (
                <span className="flex items-center gap-1">
                  <Star size={12} className="text-brand" fill="currentColor" /> {loggedIn ? listName : 'Theo dõi'}
                </span>
              ),
            },
          ]}
        />
        <select
          value={industry}
          onChange={(e) => setIndustry(e.target.value)}
          className="h-8 rounded-md border border-transparent bg-bg-3 px-2 text-[13px] text-tx-1 outline-none hover:border-line-2"
          aria-label="Lọc theo ngành"
        >
          <option value="">Tất cả ngành</option>
          {industries.map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tx-3" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && symbols[0]) nav(`/trade/${symbols[0]}`);
            }}
            placeholder="Tìm mã CK… (Enter để giao dịch)"
            className="h-8 w-56 rounded-md border border-transparent bg-bg-3 pl-8 pr-2 text-[13px] outline-none placeholder:text-tx-3 focus:border-brand"
            aria-label="Tìm mã chứng khoán"
          />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3 text-[11px] text-tx-3">
          {(
            [
              ['ceil', 'Trần'],
              ['up', 'Tăng'],
              ['ref', 'Tham chiếu'],
              ['down', 'Giảm'],
              ['floor', 'Sàn'],
            ] as [Tone, string][]
          ).map(([t, l]) => (
            <span key={t} className="flex items-center gap-1">
              <span className={cn('h-2 w-2 rounded-sm', toneBg[t])} />
              {l}
            </span>
          ))}
        </div>
      </div>
      {tab === 'WATCH' && <WatchlistBar />}

      <div className="min-h-0 flex-1 overflow-auto">
        {!loaded ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : (
          <table className="tbl num w-full min-w-[1480px] border-collapse text-[12px]">
            <thead className="text-center">
              <tr className="h-7">
                <th rowSpan={2} className="sticky top-0 z-10 w-7 bg-bg-1" />
                <SortTh k="symbol" sort={sort} setSort={setSort} className="sticky top-0 z-10 w-16 bg-bg-1 px-1.5 text-left">
                  Mã CK
                </SortTh>
                <th rowSpan={2} className="sticky top-0 z-10 w-14 bg-bg-1 text-right px-1.5">
                  Trần
                </th>
                <th rowSpan={2} className="sticky top-0 z-10 w-14 bg-bg-1 text-right px-1.5">
                  Sàn
                </th>
                <th rowSpan={2} className="sticky top-0 z-10 w-14 border-r border-line bg-bg-1 text-right px-1.5">
                  TC
                </th>
                <th colSpan={6} className="sticky top-0 z-10 border-b border-r border-line bg-bg-1">
                  Bên mua
                </th>
                <th colSpan={4} className="sticky top-0 z-10 border-b border-r border-line bg-bg-2 text-tx-2">
                  Khớp lệnh
                </th>
                <th colSpan={6} className="sticky top-0 z-10 border-b border-line bg-bg-1">
                  Bên bán
                </th>
                <SortTh k="volume" sort={sort} setSort={setSort} className="sticky top-0 z-10 w-24 border-l border-line bg-bg-1 px-1.5 text-right">
                  Tổng KL
                </SortTh>
                <th colSpan={2} className="sticky top-0 z-10 border-b border-r border-line bg-bg-1">
                  Giá
                </th>
                <th colSpan={2} className="sticky top-0 z-10 border-b border-line bg-bg-1">
                  ĐTNN
                </th>
              </tr>
              <tr className="h-7">
                {['Giá 3', 'KL 3', 'Giá 2', 'KL 2', 'Giá 1', 'KL 1'].map((h, i) => (
                  <th key={`b${h}`} className={cn('sticky top-7 z-10 bg-bg-1 px-1.5 text-right', i === 5 && 'border-r border-line')}>
                    {h}
                  </th>
                ))}
                <th
                  className="sticky top-7 z-10 cursor-pointer bg-bg-2 px-1.5 text-right hover:text-tx-1"
                  onClick={() => setSort({ key: 'last', dir: sort.key === 'last' ? (sort.dir === 1 ? -1 : 1) : -1 })}
                >
                  Giá {sort.key === 'last' && (sort.dir === 1 ? '↑' : '↓')}
                </th>
                <th className="sticky top-7 z-10 bg-bg-2 px-1.5 text-right">KL</th>
                <th className="sticky top-7 z-10 bg-bg-2 px-1.5 text-right">+/-</th>
                <th
                  className="sticky top-7 z-10 cursor-pointer border-r border-line bg-bg-2 px-1.5 text-right hover:text-tx-1"
                  onClick={() => setSort({ key: 'changePct', dir: sort.key === 'changePct' ? (sort.dir === 1 ? -1 : 1) : -1 })}
                >
                  % {sort.key === 'changePct' && (sort.dir === 1 ? '↑' : '↓')}
                </th>
                {['Giá 1', 'KL 1', 'Giá 2', 'KL 2', 'Giá 3', 'KL 3'].map((h) => (
                  <th key={`a${h}`} className="sticky top-7 z-10 bg-bg-1 px-1.5 text-right">
                    {h}
                  </th>
                ))}
                <th className="sticky top-7 z-10 bg-bg-1 px-1.5 text-right">Cao</th>
                <th className="sticky top-7 z-10 border-r border-line bg-bg-1 px-1.5 text-right">Thấp</th>
                <th className="sticky top-7 z-10 bg-bg-1 px-1.5 text-right">NN mua</th>
                <th className="sticky top-7 z-10 bg-bg-1 px-1.5 pr-2 text-right">NN bán</th>
              </tr>
            </thead>
            <tbody>
              {symbols.map((s, i) => (
                <BoardRow key={s} symbol={s} index={i} starred={starSet.has(s)} onStar={onStar} />
              ))}
            </tbody>
          </table>
        )}
        {loaded && symbols.length === 0 && (
          <Empty
            title={tab === 'WATCH' ? 'Chưa có mã nào trong danh sách theo dõi' : 'Không tìm thấy mã phù hợp'}
            hint={tab === 'WATCH' ? (loggedIn ? 'Bấm biểu tượng ☆ ở đầu mỗi dòng để thêm mã.' : 'Đăng nhập để lưu danh sách theo dõi.') : 'Thử từ khoá khác.'}
          />
        )}
      </div>
    </div>
  );
}
