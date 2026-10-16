import { useEffect, useMemo, useState } from 'react';
import { Big, ceilStep, decimalsOf, floorStep, type BookLevel, type DepthSnapshot, type TradeTick } from '@vss/shared';
import { useSymbolFeed } from '../../hooks/useSymbolFeed';
import { api } from '../../lib/api';
import { cn, fmtCompact, fmtPrice, fmtQty, fmtTime, signTone, toneText } from '../../lib/format';
import { useSymbolRow } from '../../store/market';
import { useTicket } from '../../store/ui';
import { Empty, useFlash } from '../common/ui';

const ROWS = 12;

/** Gộp mức giá theo bội số bước giá (như Binance: 0.01 / 0.1 / 1 / 10...) — bên mua làm tròn xuống, bên bán làm tròn lên */
function group(levels: BookLevel[], step: string, side: 'bid' | 'ask'): BookLevel[] {
  const out = new Map<string, Big>();
  for (const [p, q] of levels) {
    const k = side === 'bid' ? floorStep(p, step) : ceilStep(p, step);
    out.set(k, (out.get(k) ?? new Big(0)).plus(q));
  }
  return [...out.entries()].map(([p, q]) => [p, q.toFixed()]);
}

export function OrderBook({ symbol }: { symbol: string }) {
  const r = useSymbolRow(symbol);
  const pickPrice = useTicket((s) => s.pickPrice);
  const [depth, setDepth] = useState<DepthSnapshot | null>(null);
  const [mult, setMult] = useState(1);
  const tick = r?.filters.tickSize ?? '0.01';
  const step = r?.filters.stepSize;
  const lastFlash = useFlash(r ? Number(r.last) : undefined);
  const [lastDir, setLastDir] = useState<'up' | 'down' | 'flat'>('flat');
  const [prevLast, setPrevLast] = useState<string | null>(null);

  useEffect(() => {
    setDepth(null);
    setMult(1);
    let alive = true;
    void api<DepthSnapshot>(`/market/depth/${symbol}?limit=20`)
      .then((d) => alive && setDepth(d))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [symbol]);

  useSymbolFeed(symbol, { onDepth: setDepth });

  // Mũi tên giá khớp gần nhất so với lần trước
  useEffect(() => {
    if (!r) return;
    if (prevLast && prevLast !== r.last) setLastDir(new Big(r.last).gt(prevLast) ? 'up' : 'down');
    setPrevLast(r.last);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r?.last]);

  const groupStep = useMemo(() => new Big(tick).times(mult).toFixed(), [tick, mult]);
  const { bids, asks, max } = useMemo(() => {
    if (!depth) return { bids: [], asks: [], max: 1 };
    const b = mult === 1 ? depth.bids : group(depth.bids, groupStep, 'bid');
    const a = mult === 1 ? depth.asks : group(depth.asks, groupStep, 'ask');
    const bs = b.slice(0, ROWS);
    const as = a.slice(0, ROWS);
    const m = Math.max(1e-18, ...bs.map((l) => Number(l[1])), ...as.map((l) => Number(l[1])));
    return { bids: bs, asks: as, max: m };
  }, [depth, mult, groupStep]);

  if (!r) return null;
  const bidSum = bids.reduce((s, l) => s + Number(l[1]), 0);
  const askSum = asks.reduce((s, l) => s + Number(l[1]), 0);
  const bidPct = bidSum + askSum ? Math.round((bidSum / (bidSum + askSum)) * 100) : 50;
  const showTick = mult === 1 ? tick : groupStep;
  const mults = [1, 10, 100, 1000].filter((m) => decimalsOf(new Big(tick).times(m).toFixed()) >= 0 && new Big(tick).times(m).lte(new Big(r.last).div(10)));

  const level = ([p, q]: BookLevel, side: 'bid' | 'ask') => (
    <button
      key={`${side}${p}`}
      onClick={() => pickPrice(p, side === 'ask' ? 'BUY' : 'SELL')}
      className="relative grid h-[22px] w-full grid-cols-3 items-center px-3 text-[12px] hover:bg-bg-3"
      title={side === 'ask' ? 'Bấm để điền giá vào lệnh mua' : 'Bấm để điền giá vào lệnh bán'}
    >
      <span className={cn('absolute inset-y-0 right-0', side === 'bid' ? 'bg-up/12' : 'bg-down/12')} style={{ width: `${(Number(q) / max) * 100}%` }} />
      <span className={cn('relative text-left font-medium', side === 'bid' ? 'text-up' : 'text-down')}>{fmtPrice(p, showTick)}</span>
      <span className="relative text-right text-tx-1">{fmtQty(q, step)}</span>
      <span className="relative text-right text-tx-2">{fmtCompact(Number(p) * Number(q))}</span>
    </button>
  );

  return (
    <div className="num flex min-h-0 flex-col">
      <div className="flex items-center justify-between px-3 pt-2">
        <span className="text-[13px] font-semibold">Sổ lệnh</span>
        {mults.length > 1 && (
          <select
            value={mult}
            onChange={(e) => setMult(Number(e.target.value))}
            className="h-6 rounded bg-bg-3 px-1.5 text-[11px] text-tx-2 outline-none"
            aria-label="Gộp mức giá"
          >
            {mults.map((m) => (
              <option key={m} value={m}>
                {new Big(tick).times(m).toFixed()}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="grid grid-cols-3 px-3 py-1.5 text-[11px] text-tx-3">
        <span>Giá ({r.quoteAsset})</span>
        <span className="text-right">Số lượng ({r.baseAsset})</span>
        <span className="text-right">Tổng</span>
      </div>
      <div className="flex min-h-[132px] flex-col justify-end">
        {asks.length ? [...asks].reverse().map((l) => level(l, 'ask')) : !depth ? <Empty title="Đang tải sổ lệnh" /> : null}
      </div>
      <div className="my-1 flex items-center gap-2 border-y border-line bg-bg-2 px-3 py-1.5">
        <span className={cn('rounded px-1 text-[18px] font-bold', toneText[lastDir], lastFlash)}>
          {fmtPrice(r.last, tick)}
          {lastDir !== 'flat' && <span className="ml-1 text-[13px]">{lastDir === 'up' ? '↑' : '↓'}</span>}
        </span>
        <span className={cn('text-[12px]', toneText[signTone(r.changePct)])}>{r.changePct > 0 ? '+' : ''}{r.changePct.toFixed(2)}%</span>
      </div>
      <div className="min-h-[132px]">{bids.map((l) => level(l, 'bid'))}</div>
      <div className="mt-1 flex items-center gap-2 px-3 pb-2 text-[11px]">
        <span className="text-up">M {bidPct}%</span>
        <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-down/40">
          <div className="bg-up" style={{ width: `${bidPct}%` }} />
        </div>
        <span className="text-down">{100 - bidPct}% B</span>
      </div>
    </div>
  );
}

/** Giao dịch thị trường gần nhất (như "Market Trades" của Binance) */
export function TradeTape({ symbol }: { symbol: string }) {
  const r = useSymbolRow(symbol);
  const pickPrice = useTicket((s) => s.pickPrice);
  const [ticks, setTicks] = useState<TradeTick[]>([]);

  useEffect(() => {
    setTicks([]);
    let alive = true;
    void api<TradeTick[]>(`/market/trades/${symbol}`)
      .then((t) => alive && setTicks(t))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [symbol]);

  useSymbolFeed(symbol, {
    onTrades: (list) => setTicks((prev) => [...[...list].reverse(), ...prev].slice(0, 60)),
  });

  return (
    <div className="num flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-3 px-3 py-1.5 text-[11px] text-tx-3">
        <span>Giá ({r?.quoteAsset ?? 'USDT'})</span>
        <span className="text-right">Số lượng ({r?.baseAsset ?? ''})</span>
        <span className="text-right">Thời gian</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {ticks.length === 0 && <Empty title="Chưa có giao dịch" />}
        {ticks.map((t) => (
          <button
            key={`${t.id}-${t.time}`}
            onClick={() => pickPrice(t.price)}
            className="grid h-[22px] w-full grid-cols-3 items-center px-3 text-[12px] hover:bg-bg-3"
          >
            {/* buyerMaker = bên bán chủ động → đỏ */}
            <span className={cn('text-left', t.buyerMaker ? 'text-down' : 'text-up')}>{fmtPrice(t.price, r?.filters.tickSize)}</span>
            <span className="text-right text-tx-1">{fmtQty(t.qty, r?.filters.stepSize)}</span>
            <span className="text-right text-tx-3">{fmtTime(t.time)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
