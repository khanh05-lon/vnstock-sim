import { memo, useMemo, type PointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'motion/react';
import { ArrowRight } from 'lucide-react';
import { PHASE_LABEL, type IndexSnapshot, type StockRow } from '@vss/shared';
import { Sparkline, useFlash } from '../common/ui';
import { cn, fmtPct, fmtPrice, priceTone, signTone, toneText, toneVar } from '../../lib/format';
import { useMarket } from '../../store/market';

const ROWS = 6;

const fmtVolShort = (v: number) =>
  v >= 1e6 ? `${(v / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} tr` : `${(v / 1e3).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} k`;

const IndexTile = memo(function IndexTile({ ix }: { ix: IndexSnapshot }) {
  const tone = signTone(ix.change);
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-bg-2 px-4 py-3">
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-tx-3">{ix.name}</div>
        <div className={cn('num text-[20px] font-bold leading-tight', toneText[tone])}>
          {ix.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
        <div className={cn('num text-[12px] font-medium', toneText[tone])}>{fmtPct(ix.changePct)}</div>
      </div>
      <Sparkline data={ix.spark} baseline={ix.prevClose} color={toneVar[tone]} width={88} height={44} />
    </div>
  );
});

const PreviewRow = memo(function PreviewRow({ r }: { r: StockRow }) {
  const traded = r.volume > 0;
  const price = traded ? r.last : r.ref;
  const tone = traded ? priceTone(r.last, r.ref, r.ceil, r.floor) : 'ref';
  const flash = useFlash(price);
  return (
    <tr className="border-t border-line">
      <td className="py-2.5 pl-4">
        <div className="font-semibold text-tx-1">{r.symbol}</div>
        <div className="max-w-[10rem] truncate text-[11px] text-tx-3">{r.name}</div>
      </td>
      <td className="px-2 py-2.5 text-right">
        <span className={cn('num rounded-md px-1.5 py-0.5 text-[14px] font-semibold', toneText[tone], flash)}>{fmtPrice(price)}</span>
      </td>
      <td className={cn('num py-2.5 text-right text-[13px] font-medium', toneText[tone])}>{fmtPct(r.changePct)}</td>
      <td className="num hidden py-2.5 pr-4 text-right text-[13px] text-tx-2 sm:table-cell">{fmtVolShort(r.volume)}</td>
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
            <div className="ml-auto h-3.5 w-12 animate-pulse rounded bg-bg-3" />
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

/** Bảng giá thu nhỏ chạy dữ liệu thật của hệ thống: chỉ số + các mã VN30 giao dịch sôi động nhất */
export function LivePreview() {
  const rows = useMarket((s) => s.rows);
  const loaded = useMarket((s) => s.loaded);
  const indices = useMarket((s) => s.indices);
  const session = useMarket((s) => s.session);
  const connected = useMarket((s) => s.connected);
  const total = useMarket((s) => s.symbols.length);

  const top = useMemo(
    () =>
      Object.values(rows)
        .filter((r) => r.isVn30)
        .sort((a, b) => b.value - a.value)
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

  const open = session?.phase === 'CONTINUOUS' || session?.phase === 'ATO' || session?.phase === 'ATC';

  return (
    <motion.div
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      style={{ rotateX, rotateY, transformPerspective: 1400, boxShadow: 'var(--shadow)' }}
      className="relative w-full overflow-hidden rounded-2xl border border-line-2 bg-bg-1"
    >
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="font-display text-[15px] font-semibold">Bảng giá VN30</div>
        <div className="flex items-center gap-2 text-[12px] text-tx-2">
          <span className={cn('h-2 w-2 rounded-full', !connected ? 'bg-tx-3' : open ? 'bg-up pulse-dot' : 'bg-ref')} aria-hidden />
          {session ? PHASE_LABEL[session.phase] : 'Đang kết nối'}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
        {indices.length
          ? indices.slice(0, 2).map((ix) => <IndexTile key={ix.code} ix={ix} />)
          : Array.from({ length: 2 }, (_, i) => <div key={i} className="h-[84px] animate-pulse rounded-xl bg-bg-2" />)}
      </div>

      <table className="w-full border-collapse">
        <thead>
          <tr className="text-[11px] text-tx-3">
            <th className="py-2 pl-4 text-left font-medium">Mã</th>
            <th className="px-2 py-2 text-right font-medium">Giá</th>
            <th className="py-2 text-right font-medium">+/-</th>
            <th className="hidden py-2 pr-4 text-right font-medium sm:table-cell">Khối lượng</th>
          </tr>
        </thead>
        <tbody>{loaded && top.length ? top.map((r) => <PreviewRow key={r.symbol} r={r} />) : <SkeletonRows />}</tbody>
      </table>

      <Link
        to="/bang-gia"
        className="group flex items-center justify-between border-t border-line px-4 py-3 text-[13px] font-medium text-tx-2 transition-colors hover:bg-bg-2 hover:text-tx-1"
      >
        <span>Xem toàn bộ {total || ''} mã trên bảng giá</span>
        <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
      </Link>
    </motion.div>
  );
}
