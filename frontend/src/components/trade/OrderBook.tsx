import { useEffect, useState } from 'react';
import type { TradeTick } from '@vss/shared';
import { useSymbolFeed } from '../../hooks/useSymbolFeed';
import { cn, fmtChange, fmtPrice, fmtTimeVN, fmtVol, priceTone, toneText } from '../../lib/format';
import { useStockDetail } from '../../lib/queries';
import { useStock } from '../../store/market';
import { useTicket } from '../../store/ui';
import { Empty, useFlash } from '../common/ui';

export function OrderBook({ symbol }: { symbol: string }) {
  const r = useStock(symbol);
  const pickPrice = useTicket((s) => s.pickPrice);
  const lastFlash = useFlash(r?.last);
  if (!r) return null;
  const asks = [...r.asks].reverse();
  const max = Math.max(1, ...r.bids.map((l) => l.v), ...r.asks.map((l) => l.v));
  const totBid = r.bids.reduce((a, l) => a + l.v, 0);
  const totAsk = r.asks.reduce((a, l) => a + l.v, 0);
  const bidPct = totBid + totAsk ? Math.round((totBid / (totBid + totAsk)) * 100) : 50;
  const traded = r.volume > 0;
  const tone = traded ? priceTone(r.last, r.ref, r.ceil, r.floor) : 'ref';

  const level = (p: number, v: number, side: 'bid' | 'ask') => {
    const t = priceTone(p, r.ref, r.ceil, r.floor);
    return (
      <button
        key={`${side}${p}`}
        onClick={() => pickPrice(p, side === 'ask' ? 'BUY' : 'SELL')}
        className="relative grid h-7 w-full grid-cols-2 items-center px-3 text-[12px] hover:bg-bg-3"
        title={side === 'ask' ? 'Bấm để đặt MUA tại giá này' : 'Bấm để đặt BÁN tại giá này'}
      >
        <span
          className={cn('absolute inset-y-0.5 right-0', side === 'bid' ? 'bg-up/12' : 'bg-down/12')}
          style={{ width: `${(v / max) * 100}%` }}
        />
        <span className={cn('relative text-left font-medium', toneText[t])}>{fmtPrice(p)}</span>
        <span className="relative text-right text-tx-1">{fmtVol(v)}</span>
      </button>
    );
  };

  return (
    <div className="num">
      <div className="grid grid-cols-2 px-3 py-1.5 text-[11px] text-tx-3">
        <span>Giá</span>
        <span className="text-right">Khối lượng</span>
      </div>
      <div className="flex min-h-[84px] flex-col justify-end">
        {asks.length ? asks.map((l) => level(l.p, l.v, 'ask')) : <div className="px-3 py-2 text-center text-[11px] text-tx-3">Hết dư bán</div>}
      </div>
      <div className="my-1 flex items-center justify-between border-y border-line bg-bg-2 px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className={cn('rounded px-1 text-[20px] font-bold', toneText[tone], lastFlash)}>{fmtPrice(traded ? r.last : r.ref)}</span>
          <span className={cn('text-[12px] font-medium', toneText[tone])}>
            {traded ? `${fmtChange(r.change)} (${r.changePct.toFixed(2)}%)` : 'Chưa khớp'}
          </span>
        </div>
        <span className="text-[11px] text-tx-3">TC {fmtPrice(r.ref)}</span>
      </div>
      <div className="min-h-[84px]">
        {r.bids.length ? r.bids.map((l) => level(l.p, l.v, 'bid')) : <div className="px-3 py-2 text-center text-[11px] text-tx-3">Hết dư mua</div>}
      </div>
      <div className="px-3 pb-3 pt-2">
        <div className="flex h-1.5 overflow-hidden rounded-full bg-down/70">
          <div className="bg-up" style={{ width: `${bidPct}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-[11px]">
          <span className="text-up">Dư mua {bidPct}%</span>
          <span className="text-down">Dư bán {100 - bidPct}%</span>
        </div>
      </div>
    </div>
  );
}

export function TradeTape({ symbol }: { symbol: string }) {
  const { data } = useStockDetail(symbol);
  const r = useStock(symbol);
  const [ticks, setTicks] = useState<TradeTick[]>([]);

  useEffect(() => {
    setTicks(data?.symbol === symbol ? data.trades : []);
  }, [data, symbol]);

  useSymbolFeed(symbol, {
    onTrades: (list) => setTicks((prev) => [...[...list].reverse(), ...prev].slice(0, 80)),
  });

  if (!r) return null;
  return (
    <div className="num flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-[64px_1fr_1fr_24px] px-3 py-1.5 text-[11px] text-tx-3">
        <span>Thời gian</span>
        <span className="text-right">Giá</span>
        <span className="text-right">KL</span>
        <span className="text-right">M/B</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {ticks.length === 0 ? (
          <Empty title="Chưa có giao dịch" />
        ) : (
          ticks.map((t, i) => (
            <div key={`${t.time}-${i}`} className="grid h-6 grid-cols-[64px_1fr_1fr_24px] items-center px-3 text-[12px] hover:bg-bg-3">
              <span className="text-tx-3">{fmtTimeVN(t.time)}</span>
              <span className={cn('text-right font-medium', toneText[priceTone(t.price, r.ref, r.ceil, r.floor)])}>{fmtPrice(t.price)}</span>
              <span className="text-right text-tx-1">{fmtVol(t.vol)}</span>
              <span className={cn('text-right font-semibold', t.side === 'B' ? 'text-up' : 'text-down')}>{t.side === 'B' ? 'M' : 'B'}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
