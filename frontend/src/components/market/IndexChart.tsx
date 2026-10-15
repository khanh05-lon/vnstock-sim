import { useEffect, useRef } from 'react';
import { AreaSeries, ColorType, LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { useIndexHistory } from '../../lib/queries';
import { useMarket } from '../../store/market';
import { useUi } from '../../store/ui';
import { Spinner } from '../common/ui';

const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const rgba = (hex: string, a: number) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

export function IndexChart({ code, tf, range }: { code: string; tf: '1m' | '1D'; range: number }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Area'> | null>(null);
  const prevLine = useRef<IPriceLine | null>(null);
  const theme = useUi((s) => s.theme);
  const { data, isLoading } = useIndexHistory(code, tf);
  const ix = useMarket((s) => s.indices.find((i) => i.code === code));

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: css('--tx-3'), fontSize: 11, fontFamily: 'Inter Variable, sans-serif', attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: css('--line') } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
      handleScroll: false,
      handleScale: false,
    });
    series.current = c.addSeries(AreaSeries, { lineWidth: 2, priceLineVisible: false, priceFormat: { type: 'price', precision: 2, minMove: 0.01 } });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const s = series.current;
    const c = chart.current;
    if (!s || !c || !data?.length) return;
    const shift = tf === '1m' ? 7 * 3600 : 0;
    const pts = (range > 0 ? data.slice(-range) : data).map((p) => ({ time: (p.time + shift) as UTCTimestamp, value: p.value }));
    const first = pts[0]?.value ?? 0;
    const last = pts[pts.length - 1]?.value ?? 0;
    const base = tf === '1m' && ix ? ix.prevClose : first;
    const color = css(last >= base ? '--up' : '--down');
    s.applyOptions({ lineColor: color, topColor: rgba(color, 0.28), bottomColor: rgba(color, 0.02) });
    s.setData(pts);
    if (prevLine.current) s.removePriceLine(prevLine.current);
    prevLine.current = tf === '1m' && ix ? s.createPriceLine({ price: ix.prevClose, color: css('--ref'), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: 'TC' }) : null;
    c.applyOptions({
      timeScale: { timeVisible: tf === '1m' },
      layout: { textColor: css('--tx-3') },
      grid: { horzLines: { color: css('--line') } },
    });
    c.timeScale().fitContent();
    // cập nhật theo phút; không cần chạy lại mỗi tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, tf, range, theme, ix?.prevClose]);

  // Điểm cuối cùng realtime
  useEffect(() => {
    const s = series.current;
    if (!s || !ix || tf !== '1m' || !data?.length) return;
    const t = Math.floor(Date.now() / 60_000) * 60 + 7 * 3600;
    const lastT = data[data.length - 1].time + 7 * 3600;
    if (t >= lastT) s.update({ time: t as UTCTimestamp, value: ix.value });
  }, [ix?.value, tf, data]);

  return (
    <div className="relative h-full w-full">
      <div ref={box} className="absolute inset-0" />
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner />
        </div>
      )}
    </div>
  );
}
