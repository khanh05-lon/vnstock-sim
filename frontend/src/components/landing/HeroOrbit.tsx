import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'motion/react';
import type { SymbolRow, TradeTick } from '@vss/shared';
import { useSymbolFeed } from '../../hooks/useSymbolFeed';
import { cn, fmtPct, fmtPrice, signTone, toneText } from '../../lib/format';
import { useMarket } from '../../store/market';
import { CoinIcon } from '../common/CoinIcon';
import { Coin3D } from './Coin3D';

const INNER = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'];
const OUTER = ['XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'TONUSDT', 'LINKUSDT', 'AVAXUSDT'];

/** Một coin trên quỹ đạo: biểu tượng + giá + % 24h trực tiếp, nháy khi giá đổi */
function Token({ r, big }: { r: SymbolRow; big?: boolean }) {
  const [flash, setFlash] = useState(false);
  const last = useRef(r.last);
  useEffect(() => {
    if (last.current === r.last) return;
    last.current = r.last;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 500);
    return () => clearTimeout(t);
  }, [r.last]);
  return (
    <Link
      to={`/trade/${r.symbol}`}
      className={cn(
        'flex items-center gap-2 whitespace-nowrap rounded-full bg-bg-2 py-1.5 pl-1.5 pr-3 text-[12px] transition-[background-color,transform] duration-300 hover:scale-105',
        flash && 'bg-bg-4',
      )}
    >
      <CoinIcon asset={r.baseAsset} size={big ? 28 : 22} />
      <span className="flex flex-col leading-tight">
        <b className="text-tx-1">{r.baseAsset}</b>
        <span className="num text-tx-2">
          {fmtPrice(r.last, r.filters.tickSize)} <span className={toneText[signTone(r.changePct)]}>{fmtPct(r.changePct)}</span>
        </span>
      </span>
    </Link>
  );
}

function Ring({ symbols, radius, period, reverse, big }: { symbols: string[]; radius: number; period: number; reverse?: boolean; big?: boolean }) {
  const rows = useMarket((s) => s.rows);
  const list = symbols.map((s) => rows[s]).filter((r): r is SymbolRow => !!r);
  return (
    <div className={cn('orbit-ring', reverse && 'reverse')} style={{ '--r': `${radius}px`, '--period': `${period}s` } as CSSProperties}>
      <div className="orbit-path" />
      {list.map((r, i) => (
        <div key={r.symbol} className="orbit-token" style={{ '--a': `${(360 / list.length) * i}deg` } as CSSProperties}>
          <div>
            <Token r={r} big={big} />
          </div>
        </div>
      ))}
    </div>
  );
}

interface Print {
  id: number;
  side: 'BUY' | 'SELL';
  price: string;
  qty: string;
  x: number;
}

/** Lệnh khớp thật của BTC/USDT trên Binance, bay lên quanh đồng xu (tối đa 1 lệnh / 0,7 giây để đọc kịp) */
function TradePrints() {
  const [prints, setPrints] = useState<Print[]>([]);
  const lastAt = useRef(0);
  const tick = useMarket((s) => s.rows.BTCUSDT?.filters.tickSize);
  useSymbolFeed('BTCUSDT', {
    onTrades(list: TradeTick[]) {
      const now = Date.now();
      if (now - lastAt.current < 700 || !list.length) return;
      lastAt.current = now;
      const t = list[list.length - 1]!;
      setPrints((p) => [...p.slice(-5), { id: t.id, side: t.buyerMaker ? 'SELL' : 'BUY', price: t.price, qty: t.qty, x: Math.round(Math.random() * 70) }]);
    },
  });
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-[8%] h-28" aria-hidden>
      {prints.map((p) => (
        <div
          key={p.id}
          className="trade-print num absolute bottom-0 rounded-full bg-bg-1 px-2.5 py-1 text-[12px] text-tx-1"
          style={{ left: `${p.x}%` }}
          onAnimationEnd={() => setPrints((all) => all.filter((x) => x.id !== p.id))}
        >
          <b className={p.side === 'BUY' ? 'text-up' : 'text-down'}>{p.side === 'BUY' ? 'Mua' : 'Bán'}</b> {Number(p.qty).toLocaleString('en-US', { maximumFractionDigits: 5 })} BTC ·{' '}
          {fmtPrice(p.price, tick)}
        </div>
      ))}
    </div>
  );
}

/**
 * Sân khấu hero: đồng xu VNCoin quay ở giữa, hai vòng quỹ đạo các coin lớn với giá Binance trực tiếp,
 * lệnh khớp thật bay lên. Nghiêng theo con trỏ (desktop); đứng yên khi giảm chuyển động.
 */
export function HeroOrbit() {
  const reduce = useReducedMotion();
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const spring = { stiffness: 90, damping: 18, mass: 0.7 };
  const rotY = useSpring(useTransform(mx, [-0.5, 0.5], [-12, 12]), spring);
  const rotX = useSpring(useTransform(my, [-0.5, 0.5], [8, -8]), spring);
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (reduce || e.pointerType !== 'mouse') return;
    const b = e.currentTarget.getBoundingClientRect();
    mx.set((e.clientX - b.left) / b.width - 0.5);
    my.set((e.clientY - b.top) / b.height - 0.5);
  };
  return (
    <div
      className="orbit-stage relative h-[420px] w-full overflow-hidden sm:h-[540px] sm:overflow-visible lg:h-[620px]"
      onPointerMove={onMove}
      onPointerLeave={() => {
        mx.set(0);
        my.set(0);
      }}
    >
      <motion.div className="orbit-world" style={{ rotateX: rotX, rotateY: rotY }}>
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ transformStyle: 'preserve-3d' }}>
          <Coin3D size={200} thickness={18} className="sm:hidden" />
          <Coin3D size={260} thickness={22} className="hidden sm:block" />
        </div>
        <div className="absolute inset-0 hidden [transform-style:preserve-3d] sm:block">
          <Ring symbols={INNER} radius={230} period={30} big />
          <Ring symbols={OUTER} radius={330} period={48} reverse />
        </div>
      </motion.div>
      <TradePrints />
    </div>
  );
}
