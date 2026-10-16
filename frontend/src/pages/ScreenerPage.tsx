import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Filter, RotateCcw } from 'lucide-react';
import { EXCHANGES, type Exchange, type InstrumentType } from '@vss/shared';
import { Empty, Spinner } from '../components/common/ui';
import { TYPE_LABEL } from '../lib/instruments';
import { cn, downloadCsv, fmtBillion, fmtPct, fmtPrice, fmtVol, signTone, toneText } from '../lib/format';
import { EMPTY_FILTER, PRESETS, screen, type ScreenFilter, type ScreenRow } from '../lib/screener';
import { useMarket } from '../store/market';

const STORE_KEY = 'vss-screener';

function readFilter(): ScreenFilter {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...EMPTY_FILTER, ...(JSON.parse(raw) as Partial<ScreenFilter>) };
  } catch {
    /* bỏ qua */
  }
  return EMPTY_FILTER;
}

type SortKey = 'symbol' | 'price' | 'change' | 'value' | 'cap' | 'pe' | 'pb' | 'eps' | 'marginRatio';

const COLS: { key: SortKey; label: string; left?: boolean }[] = [
  { key: 'symbol', label: 'Mã', left: true },
  { key: 'price', label: 'Giá' },
  { key: 'change', label: '+/- %' },
  { key: 'value', label: 'GTGD (tỷ)' },
  { key: 'cap', label: 'Vốn hoá (tỷ)' },
  { key: 'pe', label: 'P/E' },
  { key: 'pb', label: 'P/B' },
  { key: 'eps', label: 'EPS (đ)' },
  { key: 'marginRatio', label: 'Cho vay KQ' },
];

/** Ô nhập số có thể để trống (= không lọc) */
function NumField({ label, value, onChange, step = 'any', placeholder }: { label: string; value: number | null; onChange(v: number | null): void; step?: string; placeholder?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input
        type="number"
        step={step}
        inputMode="decimal"
        className="input mt-1 h-8 w-full"
        value={value ?? ''}
        placeholder={placeholder ?? '—'}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    </label>
  );
}

export default function ScreenerPage() {
  const loaded = useMarket((s) => s.loaded);
  const nav = useNavigate();
  const [f, setF] = useState<ScreenFilter>(readFilter);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'cap', dir: -1 });
  const [tick, setTick] = useState(0);
  const set = (p: Partial<ScreenFilter>) => setF((x) => ({ ...x, ...p }));

  useEffect(() => {
    document.title = 'Bộ lọc cổ phiếu · VNStock';
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(f));
    } catch {
      /* bỏ qua */
    }
  }, [f]);
  // Giá thay đổi realtime: lọc lại mỗi 3 giây cho bảng không nhảy liên tục
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 3000);
    return () => clearInterval(t);
  }, []);

  const industries = useMemo(
    () => (loaded ? [...new Set(Object.values(useMarket.getState().rows).map((r) => r.industry))].sort((a, b) => a.localeCompare(b, 'vi')) : []),
    [loaded],
  );

  const rows = useMemo(() => {
    if (!loaded) return [];
    const out = screen(Object.values(useMarket.getState().rows), f);
    const k = sort.key;
    return out.sort((a, b) => {
      if (k === 'symbol') return a.symbol.localeCompare(b.symbol) * sort.dir;
      // P/E, P/B không có ý nghĩa (lỗ) luôn xếp cuối
      const va = a[k] as number | null;
      const vb = b[k] as number | null;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * sort.dir;
    });
  }, [loaded, f, sort, tick]);

  const total = loaded ? Object.keys(useMarket.getState().rows).length : 0;
  const activePreset = PRESETS.find((p) => Object.entries(p.filter).every(([k, v]) => f[k as keyof ScreenFilter] === v));

  const exportCsv = () =>
    downloadCsv(
      'bo-loc-co-phieu.csv',
      ['Mã', 'Tên', 'Sàn', 'Ngành', 'Giá', '+/- %', 'GTGD (đ)', 'Vốn hoá (đ)', 'P/E', 'P/B', 'EPS', 'BVPS', 'Tỷ lệ cho vay KQ'],
      rows.map((r) => [r.symbol, r.name, r.exchange, r.industry, r.price, r.change.toFixed(2), r.value, r.cap, r.pe?.toFixed(2) ?? '', r.pb?.toFixed(2) ?? '', r.eps, r.bvps, r.marginRatio]),
    );

  const cell = (r: ScreenRow, k: SortKey) => {
    switch (k) {
      case 'price':
        return <span className={toneText[signTone(r.change)]}>{fmtPrice(r.price)}</span>;
      case 'change':
        return <span className={toneText[signTone(r.change)]}>{fmtPct(r.change)}</span>;
      case 'value':
        return r.value ? fmtBillion(r.value) : '—';
      case 'cap':
        return Math.round(r.cap / 1e9).toLocaleString('en-US');
      case 'pe':
        return r.pe == null ? '—' : r.pe.toFixed(1);
      case 'pb':
        return r.pb == null ? '—' : r.pb.toFixed(2);
      case 'eps':
        return fmtVol(r.eps) || '0';
      case 'marginRatio':
        return r.marginRatio ? `${Math.round(r.marginRatio * 100)}%` : '—';
      default:
        return null;
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-3 p-3">
      <div>
        <h1 className="flex items-center gap-2 text-[20px] font-bold">
          <Filter size={20} className="text-brand" /> Bộ lọc cổ phiếu
        </h1>
        <p className="text-[12px] text-tx-3">
          Lọc theo định giá (P/E, P/B), quy mô, thanh khoản, biến động trong phiên. EPS, BVPS là số liệu mẫu của hệ thống mô phỏng — không phải khuyến nghị đầu tư.
        </p>
      </div>

      <section className="panel space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[12px] text-tx-3">Bộ lọc mẫu:</span>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              title={p.hint}
              onClick={() => setF({ ...EMPTY_FILTER, ...p.filter })}
              className={cn(
                'h-7 rounded-md border px-2.5 text-[12px] font-medium',
                activePreset?.id === p.id ? 'border-brand bg-brand/10 text-brand' : 'border-line text-tx-2 hover:border-line-2',
              )}
            >
              {p.label}
            </button>
          ))}
          <button onClick={() => setF(EMPTY_FILTER)} className="ml-auto flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-tx-3 hover:text-tx-1">
            <RotateCcw size={12} /> Xoá bộ lọc
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          <label className="block">
            <span className="label">Sàn</span>
            <select className="input mt-1 h-8 w-full" value={f.exchange} onChange={(e) => set({ exchange: e.target.value as Exchange | '' })}>
              <option value="">Tất cả</option>
              {EXCHANGES.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Loại</span>
            <select className="input mt-1 h-8 w-full" value={f.type} onChange={(e) => set({ type: e.target.value as InstrumentType | '' })}>
              <option value="">Tất cả</option>
              {(Object.keys(TYPE_LABEL) as InstrumentType[]).map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="col-span-2 block">
            <span className="label">Ngành</span>
            <select className="input mt-1 h-8 w-full" value={f.industry} onChange={(e) => set({ industry: e.target.value })}>
              <option value="">Tất cả ngành</option>
              {industries.map((i) => (
                <option key={i}>{i}</option>
              ))}
            </select>
          </label>
          <NumField label="P/E từ" value={f.peMin} onChange={(v) => set({ peMin: v })} />
          <NumField label="P/E đến" value={f.peMax} onChange={(v) => set({ peMax: v })} />
          <NumField label="P/B từ" value={f.pbMin} onChange={(v) => set({ pbMin: v })} />
          <NumField label="P/B đến" value={f.pbMax} onChange={(v) => set({ pbMax: v })} />
          <NumField label="Vốn hoá ≥ (tỷ)" value={f.capMin} onChange={(v) => set({ capMin: v })} step="1000" />
          <NumField label="GTGD phiên ≥ (tỷ)" value={f.valueMin} onChange={(v) => set({ valueMin: v })} step="10" />
          <NumField label="% thay đổi từ" value={f.changeMin} onChange={(v) => set({ changeMin: v })} step="0.5" />
          <NumField label="% thay đổi đến" value={f.changeMax} onChange={(v) => set({ changeMax: v })} step="0.5" />
          <label className="flex items-end gap-2 pb-1.5 text-[13px] text-tx-2">
            <input type="checkbox" checked={f.vn30} onChange={(e) => set({ vn30: e.target.checked })} /> Chỉ VN30
          </label>
          <label className="col-span-2 flex items-end gap-2 pb-1.5 text-[13px] text-tx-2">
            <input type="checkbox" checked={f.marginOnly} onChange={(e) => set({ marginOnly: e.target.checked })} /> Chỉ mã được cho vay ký quỹ
          </label>
        </div>
      </section>

      <section className="panel overflow-hidden">
        <div className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-[13px]">
          <span>
            <b>{rows.length}</b> / {total} mã phù hợp
          </span>
          <button className="btn btn-ghost ml-auto h-8" onClick={exportCsv} disabled={!rows.length}>
            <Download size={14} /> Xuất CSV
          </button>
        </div>
        {!loaded ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : !rows.length ? (
          <Empty title="Không có mã nào thoả bộ lọc" hint="Nới rộng điều kiện hoặc bấm Xoá bộ lọc." />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl num w-full min-w-[980px] text-[12px]">
              <thead>
                <tr className="h-9 text-right">
                  {COLS.map((c) => (
                    <th
                      key={c.key}
                      className={cn('cursor-pointer select-none px-3 hover:text-tx-1', c.left && 'text-left')}
                      onClick={() => setSort((s) => (s.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: c.key === 'symbol' ? 1 : -1 }))}
                      aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
                    >
                      {c.label}
                      {sort.key === c.key && (sort.dir === 1 ? ' ▲' : ' ▼')}
                    </th>
                  ))}
                  <th className="px-3 text-left">Ngành</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.symbol} onClick={() => nav(`/trade/${r.symbol}`)} className="h-9 cursor-pointer border-t border-line text-right hover:bg-bg-2">
                    <td className="px-3 text-left">
                      <span className="font-semibold">{r.symbol}</span> <span className="text-[10px] text-tx-3">{r.exchange}</span>
                      {r.isVn30 && <span className="chip ml-1 h-4 bg-brand/15 text-[9px] text-brand">VN30</span>}
                    </td>
                    {COLS.slice(1).map((c) => (
                      <td key={c.key} className="px-3">
                        {cell(r, c.key)}
                      </td>
                    ))}
                    <td className="max-w-[180px] truncate px-3 text-left text-tx-3">{r.industry}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
