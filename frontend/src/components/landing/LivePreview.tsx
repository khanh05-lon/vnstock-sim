import { memo, useMemo, type PointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'motion/react';
import { ArrowRight } from 'lucide-react';
import type { SymbolRow } from '@vss/shared';
import { useFlash } from '../common/ui';
import { CoinIcon } from '../common/CoinIcon';
import { cn, fmtCompact, fmtPct, fmtPrice, signTone, toneText } from '../../lib/format';
import { useMarket } from '../../store/market';

const ROWS = 6;

const MajorTile = memo(function MajorTile({ r }: { r: SymbolRow }) {
  const tone = signTone(r.changePct);
  const flash = useFlash(Number(r.last));
  return (
    <div className="flex items-center gap-3 rounded-xl bg-bg-2 px-4 py-3">
      <CoinIcon asset={r.baseAsset} size={30} />
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-tx-3">{r.baseAsset}/USDT</div>
        <div className={cn('num rounded text-[19px] font-bold leading-tight', flash)}>{fmtPrice(r.last, r.filters.tickSize)}</div>
        <div className={cn('num text-[12px] font-medium', toneText[tone])}>{fmtPct(r.changePct)}</div>
      </div>
    </div>
  );
});

const PreviewRow = memo(function PreviewRow({ r }: { r: SymbolRow }) {
  const tone = signTone(r.changePct);
  const flash = useFlash(Number(r.last));
  return (
    <tr className="border-t border-line">
      <td className="py-2.5 pl-4">
        <div className="flex items-center gap-2">
          <CoinIcon asset={r.baseAsset} size={20} />
          <div>
            <div className="font-semibold text-tx-1">{r.baseAsset}</div>
            <div className="max-w-[9rem] truncate text-[11px] text-tx-3">{r.name}</div>
          </div>
        </div>
      </td>
      <td className="px-2 py-2.5 text-right">
        <span className={cn('num rounded-md px-1.5 py-0.5 text-[14px] font-semibold text-tx-1', flash)}>{fmtPrice(r.last, r.filters.tickSize)}</span>
      </td>
      <td className={cn('num py-2.5 text-right text-[13px] font-medium', toneText[tone])}>{fmtPct(r.changePct)}</td>
      <td className="num hidden py-2.5 pr-4 text-right text-[13px] text-tx-2 sm:table-cell">{fmtCompact(r.quoteVolume)}</td>
    </tr>
  );
});

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: ROWS }, (_, i) => (
        <tr key={i} className="border-t border-line">
          <td className="py-3 pl-4">
            <div className="h-3.5 w-12 animate-pulse rounded bg-bg-3" />
            <div className="mt-1.5 h-2.5 w-24 animate-pulse rounded bg-bg-3" />
          </td>
          <td className="py-3">
            <div className="ml-auto h-3.5 w-14 animate-pulse rounded bg-bg-3" />
          </td>
          <td className="py-3">
            <div className="ml-auto h-3.5 w-12 animate-pulse rounded bg-bg-3" />
          </td>
          <td className="hidden py-3 pr-4 sm:table-cell">
            <div className="ml-auto h-3.5 w-14 animate-pulse rounded bg-bg-3" />
          </td>
        </tr>
      ))}
    </>
  );
}

/** Bảng giá thu nhỏ chạy dữ liệu thật: BTC, ETH và các cặp có khối lượng lớn nhất */
export function LivePreview() {
  const rows = useMarket((s) => s.rows);
  const loaded = useMarket((s) => s.loaded);
  const status = useMarket((s) => s.status);
  const connected = useMarket((s) => s.connected);
  const total = useMarket((s) => s.symbols.length);

  const majors = useMemo(() => ['BTCUSDT', 'ETHUSDT'].map((s) => rows[s]).filter((r): r is SymbolRow => !!r), [rows]);
  const top = useMemo(
    () =>
      Object.values(rows)
        .filter((r) => r.symbol !== 'BTCUSDT' && r.symbol !== 'ETHUSDT')
        .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
        .slice(0, ROWS),
    [rows],
  );

  // Nghiêng nhẹ theo con trỏ chuột (desktop), tắt khi người dùng giảm chuyển động
  const reduce = useReducedMotion();
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const spring = { stiffness: 140, damping: 22, mass: 0.6 };
  const rotateX = useSpring(useTransform(my, [-0.5, 0.5], [4, -4]), spring);
  const rotateY = useSpring(useTransform(mx, [-0.5, 0.5], [-5, 5]), spring);
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (reduce || e.pointerType !== 'mouse') return;
    const b = e.currentTarget.getBoundingClientRect();
    mx.set((e.clientX - b.left) / b.width - 0.5);
    my.set((e.clientY - b.top) / b.height - 0.5);
  };
  const onLeave = () => {
    mx.set(0);
    my.set(0);
  };

  const live = connected && status?.feed === 'LIVE';

  return (
    <motion.div
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      style={{ rotateX, rotateY, transformPerspective: 1400, boxShadow: 'var(--shadow)' }}
      className="relative w-full overflow-hidden rounded-2xl border border-line-2 bg-bg-1"
    >
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="font-display text-[15px] font-semibold">Thị trường Spot</div>
        <div className="flex items-center gap-2 text-[12px] text-tx-2">
          <span className={cn('h-2 w-2 rounded-full', !connected ? 'bg-tx-3' : live ? 'bg-up pulse-dot' : 'bg-ref')} aria-hidden />
          {!connected ? 'Đang kết nối' : live ? 'Giá Binance' : 'Giá giả lập'}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
        {majors.length ? majors.map((r) => <MajorTile key={r.symbol} r={r} />) : Array.from({ length: 2 }, (_, i) => <div key={i} className="h-[84px] animate-pulse rounded-xl bg-bg-2" />)}
      </div>

      <table className="w-full border-collapse">
        <thead>
          <tr className="text-[11px] text-tx-3">
            <th className="py-2 pl-4 text-left font-medium">Coin</th>
            <th className="px-2 py-2 text-right font-medium">Giá (USDT)</th>
            <th className="py-2 text-right font-medium">24h</th>
            <th className="hidden py-2 pr-4 text-right font-medium sm:table-cell">KL 24h</th>
          </tr>
        </thead>
        <tbody>{loaded && top.length ? top.map((r) => <PreviewRow key={r.symbol} r={r} />) : <SkeletonRows />}</tbody>
      </table>

      <Link
        to="/thi-truong"
        className="group flex items-center justify-between border-t border-line px-4 py-3 text-[13px] font-medium text-tx-2 transition-colors hover:bg-bg-2 hover:text-tx-1"
      >
        <span>Xem toàn bộ {total || ''} cặp giao dịch</span>
        <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
      </Link>
    </motion.div>
  );
}
