import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { StockRow } from '@vss/shared';
import { cn, fmtPrice } from '../../lib/format';

interface Item {
  key: string;
  value: number;
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Thuật toán treemap "squarified" (Bruls et al.) */
function squarify<T extends Item>(items: T[], rect: Rect): (T & Rect)[] {
  const out: (T & Rect)[] = [];
  const list = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const total = list.reduce((a, i) => a + i.value, 0);
  if (!total || rect.w <= 0 || rect.h <= 0) return out;
  const scale = (rect.w * rect.h) / total;
  let r = { ...rect };
  let i = 0;
  const worst = (row: T[], side: number) => {
    const areas = row.map((x) => x.value * scale);
    const s = areas.reduce((a, b) => a + b, 0);
    const mx = Math.max(...areas);
    const mn = Math.min(...areas);
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  while (i < list.length) {
    const side = Math.min(r.w, r.h);
    const row = [list[i]];
    let j = i + 1;
    while (j < list.length && worst([...row, list[j]], side) <= worst(row, side)) {
      row.push(list[j]);
      j++;
    }
    const s = row.reduce((a, x) => a + x.value * scale, 0);
    if (r.w >= r.h) {
      const colW = s / r.h;
      let y = r.y;
      for (const x of row) {
        const h = (x.value * scale) / colW;
        out.push({ ...x, x: r.x, y, w: colW, h });
        y += h;
      }
      r = { x: r.x + colW, y: r.y, w: r.w - colW, h: r.h };
    } else {
      const rowH = s / r.w;
      let x0 = r.x;
      for (const x of row) {
        const w = (x.value * scale) / rowH;
        out.push({ ...x, x: x0, y: r.y, w, h: rowH });
        x0 += w;
      }
      r = { x: r.x, y: r.y + rowH, w: r.w, h: r.h - rowH };
    }
    i = j;
  }
  return out;
}

function tileColor(s: StockRow): string {
  if (!s.volume) return 'var(--bg-4)';
  if (s.last >= s.ceil) return 'var(--ceil)';
  if (s.last <= s.floor) return 'var(--floor)';
  const p = s.changePct;
  if (p === 0) return 'color-mix(in srgb, var(--ref) 55%, var(--bg-3))';
  const k = Math.min(1, Math.abs(p) / 5);
  const pct = Math.round(30 + k * 65);
  return `color-mix(in srgb, var(${p > 0 ? '--up' : '--down'}) ${pct}%, var(--bg-3))`;
}

export function Heatmap({ rows, height = 520 }: { rows: StockRow[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const nav = useNavigate();

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setWidth(Math.floor(e[0].contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => {
    if (!width) return [];
    const byInd = new Map<string, StockRow[]>();
    for (const r of rows) {
      const l = byInd.get(r.industry);
      if (l) l.push(r);
      else byInd.set(r.industry, [r]);
    }
    const capOf = (r: StockRow) => (r.volume ? r.last : r.ref) * r.listedShares;
    const groups = [...byInd.entries()].map(([key, list]) => ({ key, value: list.reduce((a, r) => a + capOf(r), 0), list }));
    return squarify(groups, { x: 0, y: 0, w: width, h: height }).map((g) => {
      const head = g.h > 40 && g.w > 60 ? 16 : 0;
      const tiles = squarify(
        g.list.map((r) => ({ key: r.symbol, value: capOf(r), row: r })),
        { x: g.x + 1, y: g.y + head + 1, w: g.w - 2, h: g.h - head - 2 },
      );
      const chg = g.list.reduce((a, r) => a + (r.volume ? (r.last - r.ref) * r.listedShares : 0), 0) / g.list.reduce((a, r) => a + r.ref * r.listedShares, 0);
      return { ...g, head, tiles, chg: chg * 100 };
    });
  }, [rows, width, height]);

  return (
    <div ref={ref} className="relative w-full overflow-hidden rounded-md bg-bg-0" style={{ height }}>
      {layout.map((g) => (
        <div key={g.key}>
          {g.head > 0 && (
            <div className="absolute flex items-center justify-between overflow-hidden px-1.5 text-[10px] font-semibold uppercase tracking-wide text-tx-2" style={{ left: g.x, top: g.y, width: g.w, height: g.head }}>
              <span className="truncate">{g.key}</span>
              <span className={cn('num ml-1 shrink-0', g.chg > 0 ? 'text-up' : g.chg < 0 ? 'text-down' : 'text-ref')}>
                {g.chg > 0 ? '+' : ''}
                {g.chg.toFixed(2)}%
              </span>
            </div>
          )}
          {g.tiles.map((t) => {
            const big = t.w > 70 && t.h > 44;
            const show = t.w > 34 && t.h > 22;
            return (
              <button
                key={t.key}
                onClick={() => nav(`/trade/${t.key}`)}
                className="absolute flex flex-col items-center justify-center overflow-hidden border border-bg-0 text-white transition-[filter] hover:z-10 hover:brightness-125"
                style={{ left: t.x, top: t.y, width: t.w, height: t.h, background: tileColor(t.row) }}
                title={`${t.row.symbol} · ${t.row.name}\nGiá ${fmtPrice(t.row.volume ? t.row.last : t.row.ref)} (${t.row.changePct > 0 ? '+' : ''}${t.row.changePct.toFixed(2)}%)`}
              >
                {show && <span className={cn('font-bold leading-none drop-shadow', big ? 'text-[14px]' : 'text-[11px]')}>{t.key}</span>}
                {show && t.h > 34 && (
                  <span className={cn('num mt-1 leading-none opacity-90', big ? 'text-[12px]' : 'text-[10px]')}>
                    {t.row.changePct > 0 ? '+' : ''}
                    {t.row.changePct.toFixed(2)}%
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
