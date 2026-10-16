import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { decimalsOf, type Kline, type KlineInterval } from '@vss/shared';
import { useSymbolFeed } from '../../hooks/useSymbolFeed';
import { cn, fmtCompact, fmtPrice } from '../../lib/format';
import { useKlines } from '../../lib/queries';
import { useSymbolRow } from '../../store/market';
import { useUi } from '../../store/ui';
import { Spinner } from '../common/ui';

const INTERVALS: { value: KlineInterval; label: string }[] = [
  { value: '1m', label: '1m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1h', label: '1H' },
  { value: '4h', label: '4H' },
  { value: '1d', label: '1D' },
  { value: '1w', label: '1W' },
  { value: '1M', label: '1M' },
];
const SECONDS: Partial<Record<KlineInterval, number>> = {
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14_400,
  '1d': 86_400,
};
/** Đường trung bình như mặc định của Binance: MA(7), MA(25), MA(99) */
const MAS = [
  { n: 7, color: '#f0b90b' },
  { n: 25, color: '#e84393' },
  { n: 99, color: '#a855f7' },
] as const;

/** Lệch múi giờ của máy (giây): lightweight-charts hiển thị theo UTC nên cộng thêm cho khung trong ngày */
const TZ = -new Date().getTimezoneOffset() * 60;
const intraday = (iv: KlineInterval) => (SECONDS[iv] ?? 86_400) < 86_400;

/** Mốc mở nến của khung (giây UTC) — tuần bắt đầu thứ Hai, tháng bắt đầu ngày 1 */
function bucketOf(time: number, iv: KlineInterval): number {
  if (iv === '1M') {
    const d = new Date(time * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  }
  if (iv === '1w') {
    const day = Math.floor(time / 86_400);
    return (day - ((day + 3) % 7)) * 86_400;
  }
  const s = SECONDS[iv]!;
  return Math.floor(time / s) * s;
}

function sma(bars: Kline[], n: number) {
  const out: { time: number; value: number }[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i]!.close;
    if (i >= n) sum -= bars[i - n]!.close;
    if (i >= n - 1) out.push({ time: bars[i]!.time, value: sum / n });
  }
  return out;
}

function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** #rrggbb → rgba(r,g,b,a) (canvas của biểu đồ không hiểu color-mix) */
function alpha(hex: string, a: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function readInterval(): KlineInterval {
  try {
    const v = localStorage.getItem('vss-interval') as KlineInterval | null;
    if (v && INTERVALS.some((t) => t.value === v)) return v;
  } catch {
    /* bỏ qua */
  }
  return '15m';
}

export function CandleChart({ symbol, className }: { symbol: string; className?: string }) {
  const [iv, setIv] = useState<KlineInterval>(readInterval);
  const [showMa, setShowMa] = useState(true);
  const [hover, setHover] = useState<Kline | null>(null);
  const theme = useUi((s) => s.theme);
  const row = useSymbolRow(symbol);
  const tick = row?.filters.tickSize;
  const { data: raw, isLoading } = useKlines(symbol, iv);

  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const maRefs = useRef<ISeriesApi<'Line'>[]>([]);
  const barsRef = useRef<Kline[]>([]);
  const ivRef = useRef(iv);
  ivRef.current = iv;

  const toTime = (t: number) => (intraday(ivRef.current) ? t + TZ : t) as UTCTimestamp;

  // Khởi tạo biểu đồ
  useEffect(() => {
    if (!boxRef.current) return;
    const chart = createChart(boxRef.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: css('--tx-3'), fontFamily: 'Inter Variable, sans-serif', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: css('--line') }, horzLines: { color: css('--line') } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: css('--line'), scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderColor: css('--line'), rightOffset: 6, barSpacing: 7 },
      localization: { locale: 'vi-VN' },
    });
    const up = css('--up');
    const down = css('--down');
    candleRef.current = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false });
    volRef.current = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    maRefs.current = MAS.map((m) =>
      chart.addSeries(LineSeries, { lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, color: m.color }),
    );
    chart.subscribeCrosshairMove((p) => {
      if (!p.time) return setHover(null);
      const t = (p.time as number) - (intraday(ivRef.current) ? TZ : 0);
      setHover(barsRef.current.find((b) => b.time === t) ?? null);
    });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  // Định dạng giá theo bước giá của cặp (BTC 2 chữ số, PEPE 8 chữ số)
  useEffect(() => {
    if (!tick) return;
    const precision = decimalsOf(tick);
    candleRef.current?.applyOptions({ priceFormat: { type: 'price', precision, minMove: Number(tick) } });
    for (const s of maRefs.current) s.applyOptions({ priceFormat: { type: 'price', precision, minMove: Number(tick) } });
  }, [tick]);

  const volPoint = (b: Kline) => ({ time: toTime(b.time), value: b.volume, color: alpha(css(b.close >= b.open ? '--up' : '--down'), 0.45) });
  const candlePoint = (b: Kline) => ({ time: toTime(b.time), open: b.open, high: b.high, low: b.low, close: b.close });

  const applyMA = (bars: Kline[]) => {
    MAS.forEach((m, i) => maRefs.current[i]?.setData(showMa ? sma(bars, m.n).map((p) => ({ time: toTime(p.time), value: p.value })) : []));
  };

  // Đổi theme
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions({
      layout: { textColor: css('--tx-3') },
      grid: { vertLines: { color: css('--line') }, horzLines: { color: css('--line') } },
      rightPriceScale: { borderColor: css('--line') },
      timeScale: { borderColor: css('--line') },
    });
    const up = css('--up');
    const down = css('--down');
    candleRef.current?.applyOptions({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down });
    if (barsRef.current.length) volRef.current?.setData(barsRef.current.map(volPoint));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  // Nạp dữ liệu khi đổi cặp / khung
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !raw) return;
    const bars = raw.map((k) => ({ ...k }));
    barsRef.current = bars;
    chart.applyOptions({ timeScale: { timeVisible: intraday(iv), secondsVisible: false } });
    candleRef.current!.setData(bars.map(candlePoint));
    volRef.current!.setData(bars.map(volPoint));
    applyMA(bars);
    const visible = 140;
    if (bars.length > visible) chart.timeScale().setVisibleLogicalRange({ from: bars.length - visible, to: bars.length + 4 });
    else chart.timeScale().fitContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, iv, symbol]);

  useEffect(() => {
    applyMA(barsRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMa]);

  // Realtime: nến 1 phút đang chạy → gộp vào nến của khung đang xem
  useSymbolFeed(symbol, {
    onKline: (k) => {
      const bars = barsRef.current;
      if (!bars.length) return;
      const t = bucketOf(k.time, ivRef.current);
      const last = bars[bars.length - 1]!;
      let bar: Kline;
      if (last.time === t) {
        // Nến khung lớn: giữ open, cập nhật cao / thấp / đóng; khối lượng chỉ chính xác ở khung 1m
        bar = {
          time: t,
          open: last.open,
          high: Math.max(last.high, k.high),
          low: Math.min(last.low, k.low),
          close: k.close,
          volume: ivRef.current === '1m' ? k.volume : last.volume,
        };
        bars[bars.length - 1] = bar;
      } else if (t > last.time) {
        bar = { ...k, time: t };
        bars.push(bar);
      } else return;
      candleRef.current?.update(candlePoint(bar));
      volRef.current?.update(volPoint(bar));
      if (showMa) {
        MAS.forEach((m, i) => {
          if (bars.length < m.n) return;
          let sum = 0;
          for (let j = bars.length - m.n; j < bars.length; j++) sum += bars[j]!.close;
          maRefs.current[i]?.update({ time: toTime(bar.time), value: sum / m.n });
        });
      }
    },
  });

  const legend = hover ?? barsRef.current[barsRef.current.length - 1] ?? null;
  const chg = useMemo(() => (legend && legend.open ? ((legend.close - legend.open) / legend.open) * 100 : 0), [legend]);

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5">
        <div className="flex items-center gap-0.5" role="tablist" aria-label="Khung thời gian">
          {INTERVALS.map((t) => (
            <button
              key={t.value}
              role="tab"
              aria-selected={iv === t.value}
              onClick={() => {
                setIv(t.value);
                try {
                  localStorage.setItem('vss-interval', t.value);
                } catch {
                  /* bỏ qua */
                }
              }}
              className={cn('h-6 rounded px-2 text-[12px] font-medium', iv === t.value ? 'bg-bg-3 text-brand' : 'text-tx-3 hover:text-tx-1')}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="h-4 w-px bg-line" />
        <button onClick={() => setShowMa((v) => !v)} className={cn('flex items-center gap-2 text-[12px] font-medium', showMa ? 'text-tx-2' : 'text-tx-3')}>
          {MAS.map((m) => (
            <span key={m.n} style={{ color: showMa ? m.color : undefined }}>
              MA{m.n}
            </span>
          ))}
        </button>
        {legend && (
          <div className="num ml-auto flex flex-wrap gap-x-2.5 text-[11px] text-tx-3">
            {(['open', 'high', 'low', 'close'] as const).map((k) => (
              <span key={k}>
                {k === 'open' ? 'O' : k === 'high' ? 'H' : k === 'low' ? 'L' : 'C'}{' '}
                <b className={cn('font-medium', legend.close >= legend.open ? 'text-up' : 'text-down')}>{fmtPrice(legend[k], tick)}</b>
              </span>
            ))}
            <span className={chg >= 0 ? 'text-up' : 'text-down'}>
              {chg >= 0 ? '+' : ''}
              {chg.toFixed(2)}%
            </span>
            <span>
              Vol <b className="font-medium text-tx-2">{fmtCompact(legend.volume)}</b>
            </span>
          </div>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={boxRef} className="absolute inset-0" />
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Spinner />
          </div>
        )}
        {!isLoading && raw && raw.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-tx-3">Chưa có dữ liệu cho khung thời gian này</div>}
      </div>
    </div>
  );
}
