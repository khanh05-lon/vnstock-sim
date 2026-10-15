import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Exchange, StockRow } from '@vss/shared';
import { Tabs } from '../components/common/ui';
import { IndexBar } from '../components/layout/IndexBar';
import { Heatmap } from '../components/market/Heatmap';
import { IndexChart } from '../components/market/IndexChart';
import { cn, fmtBillion, fmtPct, fmtPrice, fmtSigned, fmtVol, priceTone, signTone, toneText } from '../lib/format';
import { useMarket } from '../store/market';

/** Ảnh chụp bảng giá cập nhật mỗi 2 giây cho các thống kê nặng */
function useThrottledRows(ms = 2000): StockRow[] {
  const [rows, setRows] = useState<StockRow[]>(() => Object.values(useMarket.getState().rows));
  useEffect(() => {
    const pull = () => setRows(Object.values(useMarket.getState().rows));
    pull();
    const t = setInterval(pull, ms);
    return () => clearInterval(t);
  }, [ms]);
  return rows;
}

const price = (r: StockRow) => (r.volume ? r.last : r.ref);

function TopList({ title, rows, metric }: { title: string; rows: StockRow[]; metric: (r: StockRow) => { text: string; cls?: string } }) {
  const nav = useNavigate();
  return (
    <section className="panel overflow-hidden">
      <h3 className="border-b border-line px-4 py-2.5 text-[13px] font-semibold">{title}</h3>
      <ul className="num">
        {rows.map((r, i) => {
          const tone = r.volume ? priceTone(r.last, r.ref, r.ceil, r.floor) : 'ref';
          const m = metric(r);
          return (
            <li key={r.symbol}>
              <button onClick={() => nav(`/trade/${r.symbol}`)} className="grid h-9 w-full grid-cols-[20px_1fr_auto_auto] items-center gap-3 px-4 text-left text-[12px] hover:bg-bg-2">
                <span className="text-tx-3">{i + 1}</span>
                <span className="min-w-0">
                  <b>{r.symbol}</b> <span className="text-[10px] text-tx-3">{r.exchange}</span>
                </span>
                <span className={cn('font-medium', toneText[tone])}>{fmtPrice(price(r))}</span>
                <span className={cn('w-24 text-right font-semibold', m.cls)}>{m.text}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Breadth({ rows, exchange }: { rows: StockRow[]; exchange: Exchange }) {
  const list = rows.filter((r) => r.exchange === exchange);
  const c = { ceil: 0, up: 0, ref: 0, down: 0, floor: 0 };
  let value = 0;
  for (const r of list) {
    value += r.value;
    if (!r.volume || r.last === r.ref) c.ref++;
    else if (r.last >= r.ceil) c.ceil++;
    else if (r.last <= r.floor) c.floor++;
    else if (r.last > r.ref) c.up++;
    else c.down++;
  }
  const n = list.length || 1;
  const seg: [keyof typeof c, string][] = [
    ['ceil', 'bg-ceil'],
    ['up', 'bg-up'],
    ['ref', 'bg-ref'],
    ['down', 'bg-down'],
    ['floor', 'bg-floor'],
  ];
  return (
    <div className="panel p-4">
      <div className="flex items-baseline justify-between">
        <span className="font-semibold">{exchange}</span>
        <span className="num text-[12px] text-tx-3">GTGD {fmtBillion(value)} tỷ</span>
      </div>
      <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-bg-3">
        {seg.map(([k, cls]) => (
          <div key={k} className={cls} style={{ width: `${(c[k] / n) * 100}%` }} />
        ))}
      </div>
      <div className="num mt-2 flex justify-between text-[12px]">
        <span className="text-ceil">Trần {c.ceil}</span>
        <span className="text-up">Tăng {c.up}</span>
        <span className="text-ref">Đứng {c.ref}</span>
        <span className="text-down">Giảm {c.down}</span>
        <span className="text-floor">Sàn {c.floor}</span>
      </div>
    </div>
  );
}

const RANGES = [
  { value: 'intraday', label: 'Trong ngày' },
  { value: '3m', label: '3 tháng' },
  { value: '1y', label: '1 năm' },
  { value: 'all', label: 'Tất cả' },
] as const;

export default function MarketPage() {
  const rows = useThrottledRows();
  const indices = useMarket((s) => s.indices);
  const [code, setCode] = useState('VNINDEX');
  const [range, setRange] = useState<(typeof RANGES)[number]['value']>('intraday');
  const [scope, setScope] = useState<'ALL' | Exchange>('HOSE');

  const scoped = useMemo(() => (scope === 'ALL' ? rows : rows.filter((r) => r.exchange === scope)), [rows, scope]);
  const traded = useMemo(() => scoped.filter((r) => r.volume > 0), [scoped]);
  const gainers = useMemo(() => [...traded].sort((a, b) => b.changePct - a.changePct).slice(0, 8), [traded]);
  const losers = useMemo(() => [...traded].sort((a, b) => a.changePct - b.changePct).slice(0, 8), [traded]);
  const active = useMemo(() => [...traded].sort((a, b) => b.value - a.value).slice(0, 8), [traded]);
  const foreign = useMemo(() => [...traded].sort((a, b) => (b.foreignBuy - b.foreignSell) * price(b) - (a.foreignBuy - a.foreignSell) * price(a)).slice(0, 8), [traded]);

  const industries = useMemo(() => {
    const m = new Map<string, { name: string; n: number; up: number; down: number; capRef: number; capChg: number; value: number; fnet: number }>();
    for (const r of scoped) {
      const g = m.get(r.industry) ?? { name: r.industry, n: 0, up: 0, down: 0, capRef: 0, capChg: 0, value: 0, fnet: 0 };
      g.n++;
      if (r.volume && r.last > r.ref) g.up++;
      if (r.volume && r.last < r.ref) g.down++;
      g.capRef += r.ref * r.listedShares;
      g.capChg += r.volume ? (r.last - r.ref) * r.listedShares : 0;
      g.value += r.value;
      g.fnet += (r.foreignBuy - r.foreignSell) * price(r);
      m.set(r.industry, g);
    }
    return [...m.values()].map((g) => ({ ...g, pct: (g.capChg / g.capRef) * 100 })).sort((a, b) => b.pct - a.pct);
  }, [scoped]);

  const ix = indices.find((i) => i.code === code);
  const tf = range === 'intraday' ? '1m' : '1D';
  const rangeN = range === '3m' ? 63 : range === '1y' ? 250 : 0;

  return (
    <div className="flex flex-col">
      <IndexBar />
      <div className="mx-auto w-full max-w-[1600px] space-y-3 px-3 pb-3">
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <section className="panel flex min-h-[380px] flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
              <Tabs size="sm" value={code} onChange={setCode} items={indices.map((i) => ({ value: i.code, label: i.name }))} />
              <Tabs size="sm" className="ml-auto" value={range} onChange={setRange} items={RANGES.map((r) => ({ value: r.value, label: r.label }))} />
            </div>
            {ix && (
              <div className="num flex flex-wrap items-baseline gap-x-4 px-4 pt-3">
                <span className={cn('text-[26px] font-bold', toneText[signTone(ix.change)])}>{ix.value.toFixed(2)}</span>
                <span className={cn('text-[14px] font-medium', toneText[signTone(ix.change)])}>
                  {fmtSigned(ix.change)} ({fmtPct(ix.changePct)})
                </span>
                <span className="text-[12px] text-tx-3">
                  Tham chiếu {ix.prevClose.toFixed(2)} · KL {fmtVol(ix.volume)} · GT {fmtBillion(ix.totalValue)} tỷ
                </span>
              </div>
            )}
            <div className="min-h-0 flex-1 p-2">
              <IndexChart code={code} tf={tf} range={rangeN} />
            </div>
          </section>
          <div className="grid content-start gap-3">
            <Breadth rows={rows} exchange="HOSE" />
            <Breadth rows={rows} exchange="HNX" />
            <Breadth rows={rows} exchange="UPCOM" />
          </div>
        </div>

        <section className="panel">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
            <h2 className="font-semibold">Bản đồ nhiệt thị trường</h2>
            <span className="text-[12px] text-tx-3">Kích thước theo vốn hoá · màu theo % thay đổi</span>
            <Tabs
              size="sm"
              className="ml-auto"
              value={scope}
              onChange={setScope}
              items={[
                { value: 'HOSE', label: 'HOSE' },
                { value: 'HNX', label: 'HNX' },
                { value: 'UPCOM', label: 'UPCOM' },
                { value: 'ALL', label: 'Toàn thị trường' },
              ]}
            />
          </div>
          <div className="p-2">
            <Heatmap rows={scoped} />
          </div>
        </section>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <TopList title="Tăng mạnh nhất" rows={gainers} metric={(r) => ({ text: fmtPct(r.changePct), cls: toneText[r.volume ? priceTone(r.last, r.ref, r.ceil, r.floor) : 'ref'] })} />
          <TopList title="Giảm mạnh nhất" rows={losers} metric={(r) => ({ text: fmtPct(r.changePct), cls: toneText[r.volume ? priceTone(r.last, r.ref, r.ceil, r.floor) : 'ref'] })} />
          <TopList title="Giá trị giao dịch lớn nhất" rows={active} metric={(r) => ({ text: `${fmtBillion(r.value)} tỷ`, cls: 'text-tx-1' })} />
          <TopList
            title="Khối ngoại mua ròng"
            rows={foreign}
            metric={(r) => {
              const v = (r.foreignBuy - r.foreignSell) * price(r);
              return { text: `${v >= 0 ? '+' : ''}${fmtBillion(v)} tỷ`, cls: toneText[signTone(v)] };
            }}
          />
        </div>

        <section className="panel overflow-hidden">
          <h2 className="border-b border-line px-4 py-2.5 font-semibold">Hiệu suất theo ngành</h2>
          <div className="overflow-x-auto">
            <table className="tbl num w-full min-w-[720px] text-[12px]">
              <thead>
                <tr className="h-9 text-left">
                  <th className="px-4">Ngành</th>
                  <th className="px-2 text-right">Số mã</th>
                  <th className="px-2 text-right">% thay đổi</th>
                  <th className="px-2">Tăng / Giảm</th>
                  <th className="px-2 text-right">GTGD (tỷ)</th>
                  <th className="px-4 text-right">NN ròng (tỷ)</th>
                </tr>
              </thead>
              <tbody>
                {industries.map((g) => (
                  <tr key={g.name} className="h-9 border-t border-line hover:bg-bg-2">
                    <td className="px-4 font-medium">{g.name}</td>
                    <td className="px-2 text-right text-tx-2">{g.n}</td>
                    <td className={cn('px-2 text-right font-semibold', toneText[signTone(Math.round(g.pct * 100))])}>{fmtPct(g.pct)}</td>
                    <td className="px-2">
                      <div className="flex items-center gap-2">
                        <div className="flex h-1.5 w-28 overflow-hidden rounded-full bg-ref/60">
                          <div className="bg-up" style={{ width: `${(g.up / g.n) * 100}%` }} />
                          <div className="ml-auto bg-down" style={{ width: `${(g.down / g.n) * 100}%` }} />
                        </div>
                        <span className="text-up">{g.up}</span>/<span className="text-down">{g.down}</span>
                      </div>
                    </td>
                    <td className="px-2 text-right">{fmtBillion(g.value)}</td>
                    <td className={cn('px-4 text-right', toneText[signTone(g.fnet)])}>
                      {g.fnet >= 0 ? '+' : ''}
                      {fmtBillion(g.fnet)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
