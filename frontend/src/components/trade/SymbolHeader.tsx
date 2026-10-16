import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, Search, Star } from 'lucide-react';
import type { StockRow } from '@vss/shared';
import { cn, fmtBillion, fmtChange, fmtDateVN, fmtPrice, fmtVnd, fmtVol, priceTone, toneText } from '../../lib/format';
import { TYPE_LABEL, bondYield, warrantStats } from '../../lib/instruments';
import { useWatchlist } from '../../lib/queries';
import { useMarket, useStock } from '../../store/market';
import { useFlash } from '../common/ui';

function SymbolPicker({ symbol }: { symbol: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const nav = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const loaded = useMarket((s) => s.loaded);

  const list = useMemo(() => {
    if (!loaded) return [];
    const Q = q.trim().toUpperCase();
    return Object.values(useMarket.getState().rows)
      .filter((r) => !Q || r.symbol.startsWith(Q) || r.name.toUpperCase().includes(Q))
      .sort((a, b) => a.symbol.localeCompare(b.symbol))
      .slice(0, 50);
  }, [q, loaded]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const go = (s: string) => {
    setOpen(false);
    setQ('');
    nav(`/trade/${s}`);
  };

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-bg-3" aria-haspopup="listbox" aria-expanded={open}>
        <span className="text-[22px] font-extrabold tracking-tight">{symbol}</span>
        <ChevronDown size={16} className="text-tx-3" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-80 rounded-lg border border-line bg-bg-1 p-2" style={{ boxShadow: 'var(--shadow)' }}>
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tx-3" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && list[0] && go(list[0].symbol)}
              placeholder="Nhập mã hoặc tên công ty"
              className="input h-9 pl-8"
            />
          </div>
          <div role="listbox" className="mt-2 max-h-80 overflow-y-auto">
            {list.map((r) => (
              <button key={r.symbol} role="option" aria-selected={r.symbol === symbol} onClick={() => go(r.symbol)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-bg-3">
                <span className="w-12 font-semibold">{r.symbol}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-tx-3">{r.name}</span>
                <span className="text-[11px] text-tx-3">{r.exchange}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Thông tin riêng của chứng quyền / trái phiếu */
function InstrumentStrip({ r }: { r: StockRow }) {
  const u = useStock(r.warrant?.underlying);
  const tradeDate = useMarket((s) => s.session?.tradeDate) ?? new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const items: [string, string, string?][] = [];
  if (r.warrant) {
    const w = r.warrant;
    const up = u ? (u.volume ? u.last : u.ref) : 0;
    const st = up ? warrantStats(r, up) : null;
    items.push(
      ['CK cơ sở', `${w.underlying}${up ? ` · ${fmtPrice(up)}` : ''}`],
      ['Tỷ lệ chuyển đổi', `${w.ratio} : 1`],
      ['Giá thực hiện', fmtPrice(w.exercisePrice)],
      ['Đáo hạn', `${fmtDateVN(w.maturityDate)}${st ? ` (${st.daysLeft} ngày)` : ''}`],
      ['GD cuối cùng', fmtDateVN(w.lastTradingDate)],
    );
    if (st) {
      items.push(
        ['Giá trị nội tại', fmtPrice(Math.round(st.intrinsic)) || '0.00', st.moneyness === 'ITM' ? 'text-up' : 'text-tx-2'],
        ['Hoà vốn (giá CS)', fmtPrice(Math.round(st.breakEven))],
        ['Trạng thái', st.moneyness === 'ITM' ? 'Có lãi (ITM)' : st.moneyness === 'OTM' ? 'Chưa có lãi (OTM)' : 'Ngang giá', st.moneyness === 'ITM' ? 'text-up' : 'text-down'],
      );
    }
  } else if (r.bond) {
    const b = r.bond;
    const price = r.volume ? r.last : r.ref;
    items.push(
      ['Tổ chức phát hành', b.issuer],
      ['Mệnh giá', `${fmtVnd(b.parValue)}đ`],
      ['Lãi suất coupon', `${(b.couponRate * 100).toFixed(2)}%/năm · ${b.couponFreq} kỳ/năm`],
      ['Ngày phát hành', fmtDateVN(b.issueDate)],
      ['Đáo hạn', fmtDateVN(b.maturityDate)],
      ['Lợi suất đáo hạn (YTM)', `${(bondYield(price, b, tradeDate) * 100).toFixed(2)}%`, 'text-brand'],
    );
  } else return null;
  return (
    <div className="num flex flex-wrap gap-x-6 gap-y-1 border-t border-line px-3 py-2 text-[12px]">
      {items.map(([k, v, c]) => (
        <span key={k}>
          <span className="text-tx-3">{k}: </span>
          <b className={cn('font-medium', c ?? 'text-tx-1')}>{v}</b>
        </span>
      ))}
    </div>
  );
}

export function SymbolHeader({ symbol }: { symbol: string }) {
  const r = useStock(symbol);
  const { list, loggedIn, toggle } = useWatchlist();
  const nav = useNavigate();
  const flash = useFlash(r?.last);
  if (!r) return <div className="h-[68px]" />;
  const traded = r.volume > 0;
  const price = traded ? r.last : r.ref;
  const tone = traded ? priceTone(r.last, r.ref, r.ceil, r.floor) : 'ref';
  const starred = list.includes(symbol);
  const stats: [string, string, string?][] = [
    ['Tham chiếu', fmtPrice(r.ref), 'text-ref'],
    ['Trần', fmtPrice(r.ceil), 'text-ceil'],
    ['Sàn', fmtPrice(r.floor), 'text-floor'],
    ['Mở cửa', fmtPrice(r.open) || '—', toneText[priceTone(r.open, r.ref, r.ceil, r.floor)]],
    ['Cao nhất', fmtPrice(r.high) || '—', toneText[priceTone(r.high, r.ref, r.ceil, r.floor)]],
    ['Thấp nhất', fmtPrice(r.low) || '—', toneText[priceTone(r.low, r.ref, r.ceil, r.floor)]],
    ['Tổng KL', fmtVol(r.volume) || '0'],
    ['Giá trị (tỷ)', fmtBillion(r.value)],
    ['NN mua / bán', `${fmtVol(r.foreignBuy) || 0} / ${fmtVol(r.foreignSell) || 0}`],
  ];
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-3 py-2.5">
        <div className="flex items-center gap-3">
          <button
            onClick={() => (loggedIn ? toggle(symbol) : nav('/login', { state: { from: `/trade/${symbol}` } }))}
            className={cn('rounded p-1', starred ? 'text-brand' : 'text-tx-3 hover:text-tx-1')}
            aria-label={starred ? 'Bỏ theo dõi' : 'Theo dõi'}
          >
            <Star size={18} fill={starred ? 'currentColor' : 'none'} />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <SymbolPicker symbol={symbol} />
              <span className="chip bg-bg-3 text-tx-2">{r.exchange}</span>
              {r.type && r.type !== 'STOCK' && <span className="chip bg-info/15 text-info">{TYPE_LABEL[r.type]}</span>}
              {r.isVn30 && <span className="chip bg-brand/15 text-brand">VN30</span>}
            </div>
            <div className="max-w-[320px] truncate text-[12px] text-tx-3" title={r.name}>
              {r.name}
            </div>
          </div>
        </div>
        <div className="num">
          <div className={cn('rounded px-1 text-[26px] font-bold leading-tight', toneText[tone], flash)}>{fmtPrice(price)}</div>
          <div className={cn('px-1 text-[13px] font-medium', toneText[tone])}>{traded ? `${fmtChange(r.change)}  (${r.changePct > 0 ? '+' : ''}${r.changePct.toFixed(2)}%)` : 'Chưa có giao dịch'}</div>
        </div>
        <div className="num grid flex-1 grid-cols-3 gap-x-5 gap-y-1 sm:grid-cols-5 xl:grid-cols-9">
          {stats.map(([label, value, cls]) => (
            <div key={label} className="min-w-0">
              <div className="truncate text-[11px] text-tx-3">{label}</div>
              <div className={cn('truncate text-[13px] font-medium', cls ?? 'text-tx-1')}>{value}</div>
            </div>
          ))}
        </div>
      </div>
      <InstrumentStrip r={r} />
    </div>
  );
}
