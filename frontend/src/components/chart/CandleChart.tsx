import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from '@vss/shared';
import { useSymbolFeed } from '../../hooks/useSymbolFeed';
import { cn, fmtInt } from '../../lib/format';
import { useCandles, type Timeframe } from '../../lib/queries';
import { useMarket, useStock } from '../../store/market';
import { useUi } from '../../store/ui';
import { Spinner } from '../common/ui';

const TFS: { value: Timeframe; label: string }[] = [
  { value: '1m', label: '1m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1h', label: '1H' },
  { value: '1D', label: '1D' },
  { value: '1W', label: '1W' },
  { value: '1M', label: '1M' },
];
const PERIOD: Partial<Record<Timeframe, number>> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600 };
const VN = 7 * 3600;
const isIntraday = (tf: Timeframe) => tf in PERIOD;

function aggregate(minutes: Candle[], period: number): Candle[] {
  const out: Candle[] = [];
  for (const c of minutes) {
    const k = Math.floor(c.time / period) * period;
    const last = out[out.length - 1];
    if (last && last.time === k) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else out.push({ ...c, time: k });
  }
  return out;
}

function sma(bars: Candle[], n: number) {
  const out: { time: number; value: number }[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= n) sum -= bars[i - n].close;
    if (i >= n - 1) out.push({ time: bars[i].time, value: sum / n / 1000 });
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
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function readTf(): Timeframe {
  try {
    const v = localStorage.getItem('vss-tf') as Timeframe | null;
    if (v && TFS.some((t) => t.value === v)) return v;
  } catch {
    /* bỏ qua */
  }
  return '1D';
}

export function CandleChart({ symbol, className }: { symbol: string; className?: string }) {
  const [tf, setTf] = useState<Timeframe>(readTf);
  const [ma20, setMa20] = useState(true);
  const [ma50, setMa50] = useState(true);
  const [hover, setHover] = useState<Candle | null>(null);
  const theme = useUi((s) => s.theme);
  const tradeDate = useMarket((s) => s.session?.tradeDate);
  const row = useStock(symbol);
  const { data: raw, isLoading } = useCandles(symbol, tf);

  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ma20Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ma50Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const refLineRef = useRef<IPriceLine | null>(null);
  const barsRef = useRef<Candle[]>([]);
  const minutesRef = useRef<Candle[]>([]);
  const baseRef = useRef<{ volAtLoad: number; lastBar: Candle | null }>({ volAtLoad: 0, lastBar: null });

  const toTime = (t: number) => (isIntraday(tf) ? t + VN : t) as UTCTimestamp;

  // Khởi tạo biểu đồ
  useEffect(() => {
    if (!boxRef.current) return;
    const chart = createChart(boxRef.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: css('--tx-3'), fontFamily: 'Inter Variable, sans-serif', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: css('--line') }, horzLines: { color: css('--line') } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: css('--line'), scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderColor: css('--line'), rightOffset: 4, barSpacing: 7 },
      localization: { locale: 'vi-VN' },
    });
    const up = css('--up');
    const down = css('--down');
    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      wickUpColor: up,
      wickDownColor: down,
      borderVisible: false,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    volRef.current = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    const lineOpts = { lineWidth: 1 as const, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
    ma20Ref.current = chart.addSeries(LineSeries, { ...lineOpts, color: '#f0b90b' });
    ma50Ref.current = chart.addSeries(LineSeries, { ...lineOpts, color: '#a855f7' });
    chart.subscribeCrosshairMove((p) => {
      if (!p.time || !candleRef.current) return setHover(null);
      const t = (p.time as number) - (isIntradayRef.current ? VN : 0);
      setHover(barsRef.current.find((b) => b.time === t) ?? null);
    });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  const isIntradayRef = useRef(isIntraday(tf));
  isIntradayRef.current = isIntraday(tf);

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

  const volPoint = (b: Candle) => ({
    time: toTime(b.time),
    value: b.volume,
    color: alpha(css(b.close >= b.open ? '--up' : '--down'), 0.45),
  });
  const candlePoint = (b: Candle) => ({ time: toTime(b.time), open: b.open / 1000, high: b.high / 1000, low: b.low / 1000, close: b.close / 1000 });

  const applyMA = (bars: Candle[]) => {
    ma20Ref.current?.setData(ma20 ? sma(bars, 20).map((p) => ({ time: toTime(p.time), value: p.value })) : []);
    ma50Ref.current?.setData(ma50 ? sma(bars, 50).map((p) => ({ time: toTime(p.time), value: p.value })) : []);
  };

  // Nạp dữ liệu khi đổi mã / khung thời gian
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !raw) return;
    const intraday = isIntraday(tf);
    let bars: Candle[];
    if (intraday) {
      minutesRef.current = raw.map((c) => ({ ...c }));
      bars = aggregate(minutesRef.current, PERIOD[tf]!);
    } else {
      bars = raw.map((c) => ({ ...c }));
      const st = useMarket.getState();
      const r = st.rows[symbol];
      const today = st.session?.tradeDate;
      const todayTime = today ? Date.parse(`${today}T00:00:00Z`) / 1000 : 0;
      const includesToday = tf === '1D' ? bars[bars.length - 1]?.time === todayTime : true;
      baseRef.current = { volAtLoad: includesToday && r ? r.volume : 0, lastBar: bars[bars.length - 1] ? { ...bars[bars.length - 1] } : null };
    }
    barsRef.current = bars;
    chart.applyOptions({ timeScale: { timeVisible: intraday, secondsVisible: false } });
    candleRef.current!.setData(bars.map(candlePoint));
    volRef.current!.setData(bars.map(volPoint));
    applyMA(bars);
    const visible = intraday ? 150 : tf === '1D' ? 160 : 120;
    if (bars.length > visible) chart.timeScale().setVisibleLogicalRange({ from: bars.length - visible, to: bars.length + 3 });
    else chart.timeScale().fitContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, tf, symbol]);

  // Bật/tắt MA
  useEffect(() => {
    applyMA(barsRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ma20, ma50]);

  // Đường tham chiếu
  useEffect(() => {
    const s = candleRef.current;
    if (!s || !row) return;
    if (refLineRef.current) s.removePriceLine(refLineRef.current);
    refLineRef.current = s.createPriceLine({
      price: row.ref / 1000,
      color: css('--ref'),
      lineStyle: LineStyle.Dashed,
      lineWidth: 1,
      axisLabelVisible: true,
      title: 'TC',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.ref, symbol, theme]);

  const pushBar = (bar: Candle) => {
    const bars = barsRef.current;
    const last = bars[bars.length - 1];
    if (last && last.time === bar.time) bars[bars.length - 1] = bar;
    else if (!last || bar.time > last.time) bars.push(bar);
    else return;
    candleRef.current?.update(candlePoint(bar));
    volRef.current?.update(volPoint(bar));
    const n = bars.length;
    const maAt = (len: number) => {
      if (n < len) return null;
      let sum = 0;
      for (let i = n - len; i < n; i++) sum += bars[i].close;
      return { time: toTime(bar.time), value: sum / len / 1000 };
    };
    const m20 = maAt(20);
    const m50 = maAt(50);
    if (ma20 && m20) ma20Ref.current?.update(m20);
    if (ma50 && m50) ma50Ref.current?.update(m50);
  };

  // Realtime: nến phút (khung trong ngày)
  useSymbolFeed(symbol, {
    onCandle: (c) => {
      if (!isIntraday(tf) || !raw) return;
      const mins = minutesRef.current;
      const last = mins[mins.length - 1];
      if (last && last.time === c.time) mins[mins.length - 1] = c;
      else if (!last || c.time > last.time) mins.push(c);
      const period = PERIOD[tf]!;
      const bucket = Math.floor(c.time / period) * period;
      const inBucket = mins.filter((m) => m.time >= bucket && m.time < bucket + period);
      const agg = aggregate(inBucket, period)[0];
      if (agg) pushBar(agg);
    },
  });

  // Realtime: nến ngày/tuần/tháng từ bảng giá
  useEffect(() => {
    if (isIntraday(tf) || !row || !row.volume || !tradeDate || !raw) return;
    const todayTime = Date.parse(`${tradeDate}T00:00:00Z`) / 1000;
    if (tf === '1D') {
      pushBar({ time: todayTime, open: row.open, high: row.high, low: row.low, close: row.last, volume: row.volume });
      return;
    }
    const base = baseRef.current.lastBar;
    if (!base) return;
    pushBar({
      time: base.time,
      open: base.open,
      high: Math.max(base.high, row.high),
      low: Math.min(base.low, row.low),
      close: row.last,
      volume: base.volume + (row.volume - baseRef.current.volAtLoad),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.last, row?.volume, tf, tradeDate]);

  const legend = hover ?? barsRef.current[barsRef.current.length - 1] ?? null;
  const prevClose = useMemo(() => {
    if (!legend) return 0;
    const i = barsRef.current.findIndex((b) => b.time === legend.time);
    return i > 0 ? barsRef.current[i - 1].close : legend.open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legend?.time, legend?.close]);
  const chg = legend && prevClose ? ((legend.close - prevClose) / prevClose) * 100 : 0;

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5">
        <div className="flex items-center gap-0.5" role="tablist" aria-label="Khung thời gian">
          {TFS.map((t) => (
            <button
              key={t.value}
              role="tab"
              aria-selected={tf === t.value}
              onClick={() => {
                setTf(t.value);
                try {
                  localStorage.setItem('vss-tf', t.value);
                } catch {
                  /* bỏ qua */
                }
              }}
              className={cn('h-6 rounded px-2 text-[12px] font-medium', tf === t.value ? 'bg-bg-3 text-brand' : 'text-tx-3 hover:text-tx-1')}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="h-4 w-px bg-line" />
        <button onClick={() => setMa20((v) => !v)} className={cn('text-[12px] font-medium', ma20 ? 'text-[#f0b90b]' : 'text-tx-3')}>
          MA20
        </button>
        <button onClick={() => setMa50((v) => !v)} className={cn('text-[12px] font-medium', ma50 ? 'text-[#a855f7]' : 'text-tx-3')}>
          MA50
        </button>
        {legend && (
          <div className="num ml-auto flex flex-wrap gap-x-2.5 text-[11px] text-tx-3">
            {(['open', 'high', 'low', 'close'] as const).map((k) => (
              <span key={k}>
                {k === 'open' ? 'O' : k === 'high' ? 'H' : k === 'low' ? 'L' : 'C'}{' '}
                <b className={cn('font-medium', legend.close >= legend.open ? 'text-up' : 'text-down')}>{(legend[k] / 1000).toFixed(2)}</b>
              </span>
            ))}
            <span className={chg >= 0 ? 'text-up' : 'text-down'}>
              {chg >= 0 ? '+' : ''}
              {chg.toFixed(2)}%
            </span>
            <span>
              KL <b className="font-medium text-tx-2">{fmtInt(legend.volume)}</b>
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
        {!isLoading && raw && raw.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-tx-3">Chưa có dữ liệu cho khung thời gian này</div>
        )}
      </div>
    </div>
  );
}
