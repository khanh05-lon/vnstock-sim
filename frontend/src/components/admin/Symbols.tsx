import { useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { isValidTick, tickSize, type Exchange, type InstrumentType } from '@vss/shared';
import { useAdminAction, useAdminSymbols, type AdminSymbol } from '../../lib/admin';
import { cn, fmtDateVN, fmtInt, fmtPrice, fmtVnd, parseIntInput, parsePriceInput } from '../../lib/format';
import { Empty, Modal, Spinner } from '../common/ui';
import { Pill, ReasonModal } from './adminUi';

const TYPE_LABEL: Record<InstrumentType, string> = { STOCK: 'Cổ phiếu', ETF: 'ETF', CW: 'Chứng quyền', BOND: 'Trái phiếu' };
const LEVELS = [
  { label: 'Thấp', liq: 0.2, vol: 0.014 },
  { label: 'Vừa', liq: 0.5, vol: 0.02 },
  { label: 'Cao', liq: 0.85, vol: 0.028 },
];

function ListSymbolModal({ open, onClose, industries }: { open: boolean; onClose(): void; industries: string[] }) {
  const act = useAdminAction();
  const [f, setF] = useState({
    symbol: '',
    exchange: 'HOSE' as Exchange,
    type: 'STOCK' as 'STOCK' | 'ETF',
    name: '',
    industry: '',
    sharesM: '',
    ref: '',
    eps: '',
    bvps: '',
    isVn30: false,
    marginPct: '0',
    level: 1,
    withHistory: true,
  });
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof f>) => setF((s) => ({ ...s, ...patch }));
  const ref = parsePriceInput(f.ref) ?? 0;
  const venue = { exchange: f.exchange, type: f.type };
  const refErr = f.ref && (!ref || !isValidTick(venue, ref)) ? `Bước giá ${fmtInt(tickSize(venue, ref || 10_000))}đ` : '';
  const ok = /^[A-Z0-9]{3,10}$/.test(f.symbol) && f.name.trim().length >= 3 && f.industry.trim().length >= 2 && Number(f.sharesM) >= 1 && ref > 0 && !refErr;

  const submit = async () => {
    setBusy(true);
    const lv = LEVELS[f.level];
    const r = await act(
      '/admin/symbols',
      'POST',
      {
        symbol: f.symbol,
        exchange: f.exchange,
        type: f.type,
        name: f.name.trim(),
        industry: f.industry.trim(),
        listedShares: Math.round(Number(f.sharesM) * 1e6),
        ref,
        eps: parseIntInput(f.eps) * (f.eps.trim().startsWith('-') ? -1 : 1),
        bvps: parseIntInput(f.bvps) || 10_000,
        isVn30: f.isVn30,
        marginRatio: Math.min(80, Math.max(0, Number(f.marginPct) || 0)) / 100,
        liquidity: lv.liq,
        volatility: lv.vol,
        withHistory: f.withHistory,
      },
      `Đã niêm yết ${f.symbol}`,
    );
    setBusy(false);
    if (r) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="Niêm yết mã mới"
      width={560}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Huỷ
          </button>
          <button className="btn btn-brand" disabled={!ok || busy} onClick={() => void submit()}>
            {busy ? 'Đang niêm yết…' : 'Niêm yết'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="label">Mã chứng khoán</span>
          <input className="input mt-1 uppercase" maxLength={10} value={f.symbol} onChange={(e) => set({ symbol: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="label">Sàn</span>
            <select className="input mt-1" value={f.exchange} onChange={(e) => set({ exchange: e.target.value as Exchange, isVn30: false })}>
              <option>HOSE</option>
              <option>HNX</option>
              <option>UPCOM</option>
            </select>
          </label>
          <label className="block">
            <span className="label">Loại</span>
            <select className="input mt-1" value={f.type} onChange={(e) => set({ type: e.target.value as 'STOCK' | 'ETF', isVn30: false })}>
              <option value="STOCK">Cổ phiếu</option>
              <option value="ETF">ETF</option>
            </select>
          </label>
        </div>
        <label className="col-span-2 block">
          <span className="label">Tên tổ chức phát hành / quỹ</span>
          <input className="input mt-1" value={f.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="block">
          <span className="label">Ngành</span>
          <input className="input mt-1" list="admin-industries" value={f.industry} onChange={(e) => set({ industry: e.target.value })} />
          <datalist id="admin-industries">
            {industries.map((i) => (
              <option key={i} value={i} />
            ))}
          </datalist>
        </label>
        <label className="block">
          <span className="label">KL niêm yết (triệu CP)</span>
          <input className="input num mt-1" inputMode="decimal" value={f.sharesM} onChange={(e) => set({ sharesM: e.target.value.replace(/[^\d.]/g, '') })} />
        </label>
        <label className="block">
          <span className="label">Giá tham chiếu phiên đầu (nghìn đ)</span>
          <input className="input num mt-1" inputMode="decimal" placeholder="vd. 20.05" value={f.ref} onChange={(e) => set({ ref: e.target.value })} />
          {refErr ? <span className="text-[11px] text-down">{refErr}</span> : ref > 0 && <span className="text-[11px] text-tx-3">{fmtVnd(ref)}đ</span>}
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="label">EPS (đ)</span>
            <input className="input num mt-1" value={f.eps} onChange={(e) => set({ eps: e.target.value })} />
          </label>
          <label className="block">
            <span className="label">BVPS (đ)</span>
            <input className="input num mt-1" value={f.bvps} onChange={(e) => set({ bvps: e.target.value })} />
          </label>
        </div>
        <label className="block">
          <span className="label">Tỷ lệ cho vay ký quỹ (%)</span>
          <input className="input num mt-1" inputMode="decimal" value={f.marginPct} onChange={(e) => set({ marginPct: e.target.value.replace(/[^\d.]/g, '') })} />
        </label>
        <label className="block">
          <span className="label">Thanh khoản / biến động giả lập</span>
          <select className="input mt-1" value={f.level} onChange={(e) => set({ level: Number(e.target.value) })}>
            {LEVELS.map((l, i) => (
              <option key={l.label} value={i}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label className="col-span-2 flex items-center gap-2 text-[13px]">
          <input type="checkbox" className="accent-[var(--brand)]" checked={f.isVn30} disabled={f.exchange !== 'HOSE' || f.type !== 'STOCK'} onChange={(e) => set({ isVn30: e.target.checked })} />
          Đưa vào rổ VN30 (chỉ số không bị nhảy — hệ thống tự điều chỉnh hệ số chia)
        </label>
        <label className="col-span-2 flex items-center gap-2 text-[13px]">
          <input type="checkbox" className="accent-[var(--brand)]" checked={f.withHistory} onChange={(e) => set({ withHistory: e.target.checked })} />
          Sinh 250 phiên lịch sử giá giả lập (bỏ chọn = mã mới lên sàn, chưa có biểu đồ ngày)
        </label>
      </div>
    </Modal>
  );
}

function EditSymbolModal({ s, onClose }: { s: AdminSymbol | null; onClose(): void }) {
  const act = useAdminAction();
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [sharesM, setSharesM] = useState('');
  const [marginPct, setMarginPct] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState<string | null>(null);
  if (s && loaded !== s.symbol) {
    setLoaded(s.symbol);
    setName(s.name);
    setIndustry(s.industry);
    setSharesM(String(s.listedShares / 1e6));
    setMarginPct(String(Math.round(s.marginRatio * 100)));
  }
  if (!s) return null;
  const patch: Record<string, unknown> = {};
  if (name.trim() !== s.name) patch.name = name.trim();
  if (industry.trim() !== s.industry) patch.industry = industry.trim();
  const shares = Math.round(Number(sharesM) * 1e6);
  if (shares && shares !== s.listedShares) patch.listedShares = shares;
  const mr = Math.min(80, Math.max(0, Number(marginPct) || 0)) / 100;
  if (Math.abs(mr - s.marginRatio) > 1e-6) patch.marginRatio = mr;

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title={`Sửa thông tin ${s.symbol}`}
      width={460}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Huỷ
          </button>
          <button
            className="btn btn-brand"
            disabled={!Object.keys(patch).length || busy}
            onClick={async () => {
              setBusy(true);
              const r = await act(`/admin/symbols/${s.symbol}`, 'PATCH', patch, `Đã cập nhật ${s.symbol}`);
              setBusy(false);
              if (r) onClose();
            }}
          >
            Lưu
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="label">Tên</span>
          <input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">Ngành</span>
          <input className="input mt-1" value={industry} onChange={(e) => setIndustry(e.target.value)} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="label">KL niêm yết (triệu CP)</span>
            <input className="input num mt-1" value={sharesM} onChange={(e) => setSharesM(e.target.value.replace(/[^\d.]/g, ''))} />
          </label>
          <label className="block">
            <span className="label">Tỷ lệ cho vay ký quỹ (%)</span>
            <input className="input num mt-1" value={marginPct} onChange={(e) => setMarginPct(e.target.value.replace(/[^\d.]/g, ''))} />
          </label>
        </div>
        <p className="text-[12px] text-tx-3">Đổi KL niêm yết (vd. sau phát hành thêm) làm thay đổi vốn hoá — chỉ số được điều chỉnh để không bị nhảy.</p>
      </div>
    </Modal>
  );
}

export function Symbols() {
  const { data, isLoading } = useAdminSymbols();
  const act = useAdminAction();
  const [q, setQ] = useState('');
  const [ex, setEx] = useState('');
  const [status, setStatus] = useState<'ACTIVE' | 'DELISTED' | ''>('ACTIVE');
  const [listing, setListing] = useState(false);
  const [editing, setEditing] = useState<AdminSymbol | null>(null);
  const [delisting, setDelisting] = useState<AdminSymbol | null>(null);
  const [payout, setPayout] = useState('');

  const industries = useMemo(() => [...new Set((data ?? []).map((s) => s.industry))].sort(), [data]);
  const rows = useMemo(() => {
    const k = q.trim().toUpperCase();
    return (data ?? []).filter(
      (s) => (!status || s.status === status) && (!ex || s.exchange === ex) && (!k || s.symbol.includes(k) || s.name.toUpperCase().includes(k)),
    );
  }, [data, q, ex, status]);
  const vn30 = (data ?? []).filter((s) => s.isVn30 && s.status === 'ACTIVE').length;

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="mr-auto font-semibold">
          Danh mục mã {data ? `(${rows.length})` : ''} <span className="ml-2 text-[12px] font-normal text-tx-3">Rổ VN30 hiện có {vn30} mã</span>
        </h2>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tx-3" />
          <input className="input h-8 w-48 pl-8" placeholder="Tìm mã hoặc tên" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="input h-8 w-28" value={ex} onChange={(e) => setEx(e.target.value)} aria-label="Lọc sàn">
          <option value="">Mọi sàn</option>
          <option>HOSE</option>
          <option>HNX</option>
          <option>UPCOM</option>
        </select>
        <select className="input h-8 w-36" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Lọc trạng thái">
          <option value="ACTIVE">Đang niêm yết</option>
          <option value="DELISTED">Đã huỷ niêm yết</option>
          <option value="">Tất cả</option>
        </select>
        <button className="btn btn-brand h-8" onClick={() => setListing(true)}>
          <Plus size={14} /> Niêm yết mã mới
        </button>
      </div>
      <div className="overflow-x-auto">
        {isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : !rows.length ? (
          <Empty title="Không có mã phù hợp" />
        ) : (
          <table className="tbl num w-full min-w-[1100px] text-[12.5px]">
            <thead>
              <tr className="h-9 text-left">
                <th className="px-4">Mã</th>
                <th className="px-2">Tên / ngành</th>
                <th className="px-2 text-right">Giá TC</th>
                <th className="px-2 text-right">Giá hiện tại</th>
                <th className="px-2 text-right">KL niêm yết (tr CP)</th>
                <th className="px-2 text-right">Cho vay KQ</th>
                <th className="px-2 text-center">VN30</th>
                <th className="px-2 text-right">Người nắm giữ</th>
                <th className="px-2">Trạng thái</th>
                <th className="px-4 text-right" />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.symbol} className="h-11 border-t border-line">
                  <td className="px-4">
                    <div className="font-semibold">{s.symbol}</div>
                    <div className="text-[11px] text-tx-3">
                      {s.exchange} · {TYPE_LABEL[s.type]}
                    </div>
                  </td>
                  <td className="max-w-[260px] px-2">
                    <div className="truncate">{s.name}</div>
                    <div className="truncate text-[11px] text-tx-3">{s.industry}</div>
                  </td>
                  <td className="px-2 text-right text-ref">{s.ref ? fmtPrice(s.ref) : '—'}</td>
                  <td className="px-2 text-right">{s.last ? fmtPrice(s.last) : '—'}</td>
                  <td className="px-2 text-right">{fmtInt(Math.round(s.listedShares / 1e6))}</td>
                  <td className="px-2 text-right">{Math.round(s.marginRatio * 100)}%</td>
                  <td className="px-2 text-center">
                    {s.status === 'ACTIVE' && s.exchange === 'HOSE' && s.type === 'STOCK' ? (
                      <button
                        className={cn('chip h-6 px-2 text-[11px]', s.isVn30 ? 'bg-brand/15 text-brand' : 'border border-line text-tx-3 hover:text-tx-1')}
                        title={s.isVn30 ? 'Bấm để đưa khỏi rổ VN30' : 'Bấm để thêm vào rổ VN30'}
                        onClick={() => void act(`/admin/symbols/${s.symbol}`, 'PATCH', { isVn30: !s.isVn30 }, s.isVn30 ? `Đã đưa ${s.symbol} khỏi VN30` : `Đã thêm ${s.symbol} vào VN30`)}
                      >
                        {s.isVn30 ? 'VN30' : '+ VN30'}
                      </button>
                    ) : (
                      <span className="text-tx-3">—</span>
                    )}
                  </td>
                  <td className="px-2 text-right">
                    {fmtInt(s.holders)}
                    {s.openOrders > 0 && <span className="text-tx-3"> · {s.openOrders} lệnh chờ</span>}
                  </td>
                  <td className="px-2">
                    {s.status === 'DELISTED' ? (
                      <span title={s.delistReason ?? ''}>
                        <Pill tone="muted">Huỷ NY {s.delistedAt ? fmtDateVN(s.delistedAt) : ''}</Pill>
                      </span>
                    ) : s.halted ? (
                      <Pill tone="bad">Tạm ngừng</Pill>
                    ) : (
                      <Pill tone="good">Niêm yết</Pill>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 text-right">
                    {s.status === 'ACTIVE' && (
                      <>
                        <button className="text-[12px] text-brand hover:underline" onClick={() => setEditing(s)}>
                          Sửa
                        </button>
                        <button
                          className="ml-3 text-[12px] text-down hover:underline"
                          onClick={() => {
                            setPayout(s.last ? String(s.last / 1000) : '');
                            setDelisting(s);
                          }}
                        >
                          Huỷ niêm yết
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ListSymbolModal open={listing} onClose={() => setListing(false)} industries={industries} />
      <EditSymbolModal s={editing} onClose={() => setEditing(null)} />
      <ReasonModal
        open={!!delisting}
        title={`Huỷ niêm yết ${delisting?.symbol ?? ''}`}
        danger
        confirmLabel="Huỷ niêm yết"
        description={
          delisting && (
            <span>
              Mã bị gỡ khỏi bảng giá và rổ chỉ số; <b>{delisting.openOrders}</b> lệnh chờ bị huỷ; <b>{delisting.holders}</b> nhà đầu tư đang nắm giữ được thanh toán bằng tiền
              theo giá dưới đây (ghi sao kê loại "Huỷ niêm yết"). Không hoàn tác được.
            </span>
          )
        }
        canConfirm={(parsePriceInput(payout) ?? 0) > 0}
        extra={
          <label className="block">
            <span className="label">Giá thanh toán mỗi cổ phiếu (nghìn đ)</span>
            <input className="input num mt-1" value={payout} onChange={(e) => setPayout(e.target.value)} />
          </label>
        }
        placeholder="Ví dụ: Chuyển sang sàn khác, vi phạm công bố thông tin, sáp nhập…"
        onClose={() => setDelisting(null)}
        onConfirm={async (reason) => {
          const price = parsePriceInput(payout);
          if (delisting && price && (await act(`/admin/symbols/${delisting.symbol}/delist`, 'POST', { reason, payoutPrice: price }, `Đã huỷ niêm yết ${delisting.symbol}`))) {
            setDelisting(null);
          }
        }}
      />
    </section>
  );
}
