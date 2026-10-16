import { useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { useAdminAction, useAdminSymbols, type AdminSymbol } from '../../lib/admin';
import { cn, fmtCompact, fmtPct, fmtPrice, signTone, toneText } from '../../lib/format';
import { CoinIcon } from '../common/CoinIcon';
import { Empty, Modal, Spinner } from '../common/ui';
import { Pill, ReasonModal } from './adminUi';

/** Thêm cặp mới: máy chủ lấy bộ lọc thật từ Binance exchangeInfo */
function AddSymbolModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const act = useAdminAction();
  const [base, setBase] = useState('');
  const [busy, setBusy] = useState(false);
  const symbol = `${base.trim().toUpperCase()}USDT`;
  const ok = /^[A-Z0-9]{2,15}$/.test(base.trim().toUpperCase());

  const submit = async () => {
    setBusy(true);
    const r = await act('/admin/symbols', 'POST', { symbol }, `Đã thêm cặp ${symbol}`);
    setBusy(false);
    if (r) {
      setBase('');
      onClose();
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="Thêm cặp giao dịch"
      width={440}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Huỷ
          </button>
          <button className="btn btn-brand" disabled={!ok || busy} onClick={() => void submit()}>
            {busy ? 'Đang thêm...' : 'Thêm cặp'}
          </button>
        </>
      }
    >
      <label className="block">
        <span className="label">Mã coin</span>
        <div className="mt-1 flex items-center gap-2">
          <input
            autoFocus
            className="input h-9 flex-1 uppercase"
            placeholder="Ví dụ: ADA, MATIC, RENDER"
            value={base}
            onChange={(e) => setBase(e.target.value.replace(/[^a-z0-9]/gi, ''))}
            onKeyDown={(e) => e.key === 'Enter' && ok && void submit()}
          />
          <span className="text-tx-2">/ USDT</span>
        </div>
      </label>
      <p className="mt-3 text-[12px] text-tx-3">
        Cặp phải đang giao dịch trên Binance. Bộ lọc (bước giá, bước khối lượng, giá trị tối thiểu, khoảng giá) được lấy thật từ Binance và cập nhật lại mỗi lần khởi động
        máy chủ. Cặp mới xuất hiện ngay trên trang Thị trường.
      </p>
    </Modal>
  );
}

function StatusPill({ s }: { s: AdminSymbol }) {
  if (!s.enabled) return <Pill tone="muted">Đã gỡ</Pill>;
  if (s.halted || s.status !== 'TRADING') return <Pill tone="bad">Tạm ngừng</Pill>;
  return <Pill tone="good">Đang giao dịch</Pill>;
}

export function Symbols() {
  const { data, isLoading } = useAdminSymbols();
  const act = useAdminAction();
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'enabled' | 'all'>('enabled');
  const [adding, setAdding] = useState(false);
  const [delisting, setDelisting] = useState<AdminSymbol | null>(null);

  const rows = useMemo(() => {
    const term = q.trim().toUpperCase();
    return (data ?? []).filter((s) => (show === 'all' || s.enabled) && (!term || s.symbol.includes(term) || s.name.toUpperCase().includes(term)));
  }, [data, q, show]);

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }
  const enabled = (data ?? []).filter((s) => s.enabled).length;

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="font-semibold">
          Cặp giao dịch <span className="ml-1 text-[12px] font-normal text-tx-3">{enabled} cặp đang có trên sàn</span>
        </h2>
        <label className="ml-auto flex h-8 items-center gap-2 rounded-md bg-bg-3 px-2.5">
          <Search size={14} className="text-tx-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm cặp" className="w-32 bg-transparent text-[13px] outline-none" aria-label="Tìm cặp" />
        </label>
        <select className="input h-8 w-36" value={show} onChange={(e) => setShow(e.target.value as 'enabled' | 'all')} aria-label="Lọc trạng thái">
          <option value="enabled">Đang trên sàn</option>
          <option value="all">Cả cặp đã gỡ</option>
        </select>
        <button className="btn btn-brand h-8" onClick={() => setAdding(true)}>
          <Plus size={14} /> Thêm cặp
        </button>
      </div>
      {!rows.length ? (
        <Empty title="Không có cặp phù hợp" />
      ) : (
        <div className="overflow-x-auto">
          <table className="tbl num w-full min-w-[1080px] text-[12.5px]">
            <thead>
              <tr className="text-right">
                <th className="px-4 py-2.5 text-left">Cặp</th>
                <th className="px-2 text-left">Trạng thái</th>
                <th className="px-2">Giá</th>
                <th className="px-2">24h</th>
                <th className="px-2">KL 24h (USDT)</th>
                <th className="px-2" title="Bước giá / bước khối lượng">
                  Bước giá / KL
                </th>
                <th className="px-2" title="Giá trị tối thiểu mỗi lệnh">
                  Tối thiểu
                </th>
                <th className="px-2">Người nắm giữ</th>
                <th className="px-2">Lệnh mở</th>
                <th className="px-4 text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.symbol} className={cn('border-t border-line text-right hover:bg-bg-2', !s.enabled && 'opacity-60')}>
                  <td className="px-4 py-2 text-left">
                    <span className="flex items-center gap-2">
                      <CoinIcon asset={s.baseAsset} size={22} />
                      <span>
                        <b className="block">
                          {s.baseAsset}
                          <span className="font-normal text-tx-3">/{s.quoteAsset}</span>
                        </b>
                        <span className="block text-[11px] text-tx-3">{s.name}</span>
                      </span>
                    </span>
                  </td>
                  <td className="px-2 text-left">
                    <StatusPill s={s} />
                  </td>
                  <td className="px-2">{s.last ? fmtPrice(s.last, s.filters.tickSize) : '--'}</td>
                  <td className={cn('px-2', s.changePct != null ? toneText[signTone(s.changePct)] : 'text-tx-3')}>{s.changePct != null ? fmtPct(s.changePct) : '--'}</td>
                  <td className="px-2">{s.quoteVolume ? fmtCompact(s.quoteVolume) : '--'}</td>
                  <td className="px-2 text-tx-2">
                    {s.filters.tickSize} / {s.filters.stepSize}
                  </td>
                  <td className="px-2 text-tx-2">{s.filters.minNotional} USDT</td>
                  <td className="px-2">{s.holders}</td>
                  <td className="px-2">{s.openOrders}</td>
                  <td className="px-4 text-right">
                    <div className="flex justify-end gap-3 text-[12px] font-medium">
                      {s.enabled ? (
                        <>
                          {s.halted ? (
                            <button className="text-up hover:underline" onClick={() => void act(`/admin/market/symbols/${s.symbol}/halt`, 'POST', { halted: false }, `Đã mở lại ${s.symbol}`)}>
                              Mở lại
                            </button>
                          ) : (
                            <button className="text-ref hover:underline" onClick={() => void act(`/admin/market/symbols/${s.symbol}/halt`, 'POST', { halted: true }, `Đã tạm ngừng ${s.symbol}`)}>
                              Tạm ngừng
                            </button>
                          )}
                          <button className="text-down hover:underline" onClick={() => setDelisting(s)}>
                            Gỡ khỏi sàn
                          </button>
                        </>
                      ) : (
                        <button className="text-brand hover:underline" onClick={() => void act('/admin/symbols', 'POST', { symbol: s.symbol }, `Đã đưa ${s.symbol} trở lại sàn`)}>
                          Thêm lại
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AddSymbolModal open={adding} onClose={() => setAdding(false)} />
      <ReasonModal
        open={!!delisting}
        title={`Gỡ ${delisting?.symbol ?? ''} khỏi sàn`}
        description={`Mọi lệnh đang mở của cặp này (${delisting?.openOrders ?? 0} lệnh) sẽ bị huỷ và trả lại số dư khoá. Coin người dùng đang nắm giữ vẫn ở trong ví. Có thể thêm lại sau.`}
        confirmLabel="Gỡ khỏi sàn"
        danger
        onClose={() => setDelisting(null)}
        onConfirm={async (reason) => {
          if (delisting && (await act(`/admin/symbols/${delisting.symbol}/delist`, 'POST', { reason }, `Đã gỡ ${delisting.symbol}`))) setDelisting(null);
        }}
      />
    </section>
  );
}
