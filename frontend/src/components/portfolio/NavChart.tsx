import { useEffect, useMemo, useRef, useState } from 'react';
import { ColorType, LineSeries, LineStyle, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { cn, fmtPct, fmtVnd, signTone, toneText } from '../../lib/format';
import { useNavHistory, type NavHistory, type NavRange } from '../../lib/queries';
import { useUi } from '../../store/ui';
import { Empty, Spinner, Tabs } from '../common/ui';

const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const toTime = (d: string) => (Date.parse(`${d}T00:00:00Z`) / 1000) as UTCTimestamp;

/**
 * Chuỗi tỷ suất lợi nhuận (%) của danh mục và VN-Index cùng kỳ, đều tính từ điểm đầu kỳ.
 * Danh mục: thay đổi NAV đã trừ vốn góp thêm trong kỳ (nạp/rút do quản trị viên điều chỉnh).
 */
export function returnSeries(h: NavHistory) {
  const pts = h.points;
  if (!pts.length) return { portfolio: [], index: [] };
  const first = pts[0];
  const portfolio = pts.map((p) => {
    const flows = p.contributed - first.contributed;
    const base = first.nav + Math.max(flows, 0);
    return { date: p.date, value: base > 0 ? ((p.nav - first.nav - flows) / base) * 100 : 0 };
  });
  const firstIdx = h.benchmark.find((b) => b.date >= first.date) ?? h.benchmark[0];
  const index = firstIdx ? h.benchmark.filter((b) => b.date >= first.date).map((b) => ({ date: b.date, value: ((b.value - firstIdx.value) / firstIdx.value) * 100 })) : [];
  return { portfolio, index };
}

export function NavChart() {
  const [range, setRange] = useState<NavRange>('3M');
  const { data, isLoading } = useNavHistory(range);
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const mine = useRef<ISeriesApi<'Line'> | null>(null);
  const bench = useRef<ISeriesApi<'Line'> | null>(null);
  const theme = useUi((s) => s.theme);
  const series = useMemo(() => (data ? returnSeries(data) : null), [data]);

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: css('--tx-3'), fontSize: 11, fontFamily: 'Inter Variable, sans-serif', attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: css('--line') } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
      localization: { priceFormatter: (v: number) => `${v.toFixed(1)}%` },
    });
    mine.current = c.addSeries(LineSeries, { lineWidth: 2, priceLineVisible: false, title: 'Danh mục' });
    bench.current = c.addSeries(LineSeries, { lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, title: 'VN-Index' });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (!series || !mine.current || !bench.current || !chart.current) return;
    mine.current.applyOptions({ color: css('--brand') });
    bench.current.applyOptions({ color: css('--tx-3') });
    mine.current.setData(series.portfolio.map((p) => ({ time: toTime(p.date), value: p.value })));
    bench.current.setData(series.index.map((p) => ({ time: toTime(p.date), value: p.value })));
    chart.current.applyOptions({ layout: { textColor: css('--tx-3') }, grid: { horzLines: { color: css('--line') } } });
    chart.current.timeScale().fitContent();
  }, [series, theme]);

  const last = series?.portfolio.at(-1)?.value ?? 0;
  const lastIdx = series?.index.at(-1)?.value ?? 0;
  const pts = data?.points ?? [];
  const nav = pts.at(-1)?.nav ?? 0;
  const peak = pts.reduce((m, p) => Math.max(m, p.nav), 0);
  // Mức sụt giảm lớn nhất từ đỉnh (max drawdown) trong kỳ
  let dd = 0;
  let hi = 0;
  for (const p of pts) {
    hi = Math.max(hi, p.nav);
    if (hi > 0) dd = Math.min(dd, (p.nav - hi) / hi);
  }

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <div>
          <h2 className="font-semibold">Hiệu quả đầu tư</h2>
          <p className="text-[11px] text-tx-3">Tỷ suất lợi nhuận danh mục so với VN-Index cùng kỳ (đã trừ vốn góp thêm)</p>
        </div>
        <Tabs
          size="sm"
          value={range}
          onChange={setRange}
          items={[
            { value: '1M', label: '1 tháng' },
            { value: '3M', label: '3 tháng' },
            { value: '6M', label: '6 tháng' },
            { value: '1Y', label: '1 năm' },
            { value: 'ALL', label: 'Tất cả' },
          ]}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 border-b border-line px-4 py-3 sm:grid-cols-4">
        <div>
          <div className="label">Danh mục trong kỳ</div>
          <div className={cn('num text-[16px] font-bold', toneText[signTone(last)])}>{fmtPct(last)}</div>
        </div>
        <div>
          <div className="label">VN-Index cùng kỳ</div>
          <div className={cn('num text-[16px] font-bold', toneText[signTone(lastIdx)])}>{fmtPct(lastIdx)}</div>
        </div>
        <div>
          <div className="label">Vượt / kém thị trường</div>
          <div className={cn('num text-[16px] font-bold', toneText[signTone(last - lastIdx)])}>{fmtPct(last - lastIdx)}</div>
        </div>
        <div>
          <div className="label">Sụt giảm lớn nhất từ đỉnh</div>
          <div className={cn('num text-[16px] font-bold', dd < 0 ? 'text-down' : 'text-tx-2')}>{fmtPct(dd * 100)}</div>
          <div className="num text-[11px] text-tx-3">Đỉnh NAV {fmtVnd(peak)}đ · hiện {fmtVnd(nav)}đ</div>
        </div>
      </div>
      <div className="relative h-[260px]">
        <div ref={box} className="absolute inset-0" />
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Spinner />
          </div>
        )}
        {!isLoading && pts.length < 2 && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg-1/80">
            <Empty title="Chưa đủ dữ liệu" hint="Biểu đồ có điểm mới mỗi ngày giao dịch — quay lại sau vài phiên." />
          </div>
        )}
      </div>
    </section>
  );
}
