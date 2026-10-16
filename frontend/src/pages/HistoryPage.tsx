import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { LEDGER_LABEL, ORDER_STATUS_LABEL, type OrderStatus } from '@vss/shared';
import { Empty, Spinner, UnderlineTabs } from '../components/common/ui';
import { OrdersTable, SideChip } from '../components/trade/OrdersPanel';
import { cn, downloadCsv, fmtDateTimeVN, fmtInt, fmtPrice, fmtVnd, signTone, toneText, vnDateISO } from '../lib/format';
import { useLedger, useOrders, useTrades, type HistoryFilter } from '../lib/queries';

type Tab = 'orders' | 'trades' | 'ledger';
const PAGE = 50;

function Pager({ page, total, onChange }: { page: number; total: number; onChange(p: number): void }) {
  const pages = Math.max(1, Math.ceil(total / PAGE));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2 text-[12px] text-tx-3">
      <span>
        Trang {page + 1}/{pages} · {fmtInt(total)} dòng
      </span>
      <button className="btn btn-ghost h-7 px-2" disabled={page === 0} onClick={() => onChange(page - 1)}>
        Trước
      </button>
      <button className="btn btn-ghost h-7 px-2" disabled={page >= pages - 1} onClick={() => onChange(page + 1)}>
        Sau
      </button>
    </div>
  );
}

export default function HistoryPage() {
  const [tab, setTab] = useState<Tab>('orders');
  const [from, setFrom] = useState(vnDateISO(30));
  const [to, setTo] = useState(vnDateISO(0));
  const [symbol, setSymbol] = useState('');
  const [side, setSide] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(0);

  const filter: HistoryFilter = useMemo(
    () => ({ from, to, symbol: symbol.trim().toUpperCase() || undefined, side: side || undefined, status: tab === 'orders' ? status || undefined : undefined }),
    [from, to, symbol, side, status, tab],
  );
  const orders = useOrders('all', filter);
  const trades = useTrades(filter);
  const ledger = useLedger(filter);

  const tradeSummary = useMemo(() => {
    const list = trades.data ?? [];
    return list.reduce(
      (a, t) => {
        if (t.side === 'BUY') a.buy += t.value;
        else a.sell += t.value;
        a.fee += t.fee;
        a.tax += t.tax;
        a.pnl += t.realizedPnl ?? 0;
        return a;
      },
      { buy: 0, sell: 0, fee: 0, tax: 0, pnl: 0 },
    );
  }, [trades.data]);

  const exportCsv = () => {
    if (tab === 'orders') {
      downloadCsv(
        `lich-su-lenh_${from}_${to}.csv`,
        ['Số hiệu', 'Thời gian', 'Mã', 'Lệnh', 'Loại', 'Giá đặt', 'KL đặt', 'KL khớp', 'Giá khớp TB', 'Trạng thái', 'Ghi chú'],
        (orders.data ?? []).map((o) => [o.id, fmtDateTimeVN(o.createdAt), o.symbol, o.side === 'BUY' ? 'Mua' : 'Bán', o.orderType, o.price, o.qty, o.filledQty, o.avgFillPrice || null, ORDER_STATUS_LABEL[o.status], o.rejectReason]),
      );
    } else if (tab === 'trades') {
      downloadCsv(
        `lich-su-khop_${from}_${to}.csv`,
        ['Thời gian', 'Số hiệu lệnh', 'Mã', 'Lệnh', 'Giá khớp', 'KL khớp', 'Giá trị', 'Phí', 'Thuế', 'Lãi/lỗ'],
        (trades.data ?? []).map((t) => [fmtDateTimeVN(t.executedAt), t.orderId, t.symbol, t.side === 'BUY' ? 'Mua' : 'Bán', t.price, t.qty, t.value, t.fee, t.tax, t.realizedPnl]),
      );
    } else {
      downloadCsv(
        `sao-ke-tien_${from}_${to}.csv`,
        ['Thời gian', 'Loại', 'Phát sinh', 'Số dư sau', 'Số hiệu lệnh', 'Diễn giải'],
        (ledger.data ?? []).map((l) => [fmtDateTimeVN(l.createdAt), LEDGER_LABEL[l.type], l.amount, l.balanceAfter, l.orderId, l.note]),
      );
    }
  };

  const active = tab === 'orders' ? orders : tab === 'trades' ? trades : ledger;
  const total = active.data?.length ?? 0;

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-3 p-3">
      <div>
        <h1 className="text-[20px] font-bold">Lịch sử giao dịch</h1>
        <p className="text-[12px] text-tx-3">Tra cứu sổ lệnh, kết quả khớp và sao kê tiền theo khoảng thời gian (giờ Việt Nam)</p>
      </div>
      <section className="panel overflow-hidden">
        <UnderlineTabs
          value={tab}
          onChange={(v) => {
            setTab(v);
            setPage(0);
          }}
          items={[
            { value: 'orders', label: 'Lịch sử lệnh' },
            { value: 'trades', label: 'Lịch sử khớp' },
            { value: 'ledger', label: 'Sao kê tiền' },
          ]}
        />
        <div className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3">
          <label>
            <span className="label">Từ ngày</span>
            <input type="date" className="input mt-1 h-8 w-40" value={from} max={to} onChange={(e) => (setFrom(e.target.value), setPage(0))} />
          </label>
          <label>
            <span className="label">Đến ngày</span>
            <input type="date" className="input mt-1 h-8 w-40" value={to} min={from} onChange={(e) => (setTo(e.target.value), setPage(0))} />
          </label>
          {tab !== 'ledger' && (
            <>
              <label>
                <span className="label">Mã CK</span>
                <input className="input mt-1 h-8 w-28 uppercase" placeholder="Tất cả" value={symbol} onChange={(e) => (setSymbol(e.target.value), setPage(0))} />
              </label>
              <label>
                <span className="label">Chiều lệnh</span>
                <select className="input mt-1 h-8 w-28" value={side} onChange={(e) => (setSide(e.target.value), setPage(0))}>
                  <option value="">Tất cả</option>
                  <option value="BUY">Mua</option>
                  <option value="SELL">Bán</option>
                </select>
              </label>
            </>
          )}
          {tab === 'orders' && (
            <label>
              <span className="label">Trạng thái</span>
              <select className="input mt-1 h-8 w-40" value={status} onChange={(e) => (setStatus(e.target.value), setPage(0))}>
                <option value="">Tất cả</option>
                {(Object.keys(ORDER_STATUS_LABEL) as OrderStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {ORDER_STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button className="btn btn-ghost ml-auto h-8" onClick={exportCsv} disabled={!total}>
            <Download size={14} /> Xuất CSV
          </button>
        </div>

        {tab === 'trades' && !!trades.data?.length && (
          <div className="num grid grid-cols-2 gap-3 border-b border-line px-4 py-3 text-[12px] sm:grid-cols-5">
            {[
              ['Tổng giá trị mua', fmtVnd(tradeSummary.buy), ''],
              ['Tổng giá trị bán', fmtVnd(tradeSummary.sell), ''],
              ['Tổng phí', fmtVnd(tradeSummary.fee), ''],
              ['Tổng thuế', fmtVnd(tradeSummary.tax), ''],
              ['Lãi/lỗ đã thực hiện', `${tradeSummary.pnl >= 0 ? '+' : ''}${fmtVnd(tradeSummary.pnl)}`, toneText[signTone(tradeSummary.pnl)]],
            ].map(([k, v, c]) => (
              <div key={k}>
                <div className="text-tx-3">{k}</div>
                <div className={cn('text-[14px] font-semibold', c)}>{v}đ</div>
              </div>
            ))}
          </div>
        )}

        <div className="overflow-x-auto">
          {active.isLoading ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : total === 0 ? (
            <Empty title="Không có dữ liệu trong khoảng thời gian đã chọn" />
          ) : tab === 'orders' ? (
            <div className="min-w-[960px]">
              <OrdersTable orders={(orders.data ?? []).slice(page * PAGE, page * PAGE + PAGE)} showDate />
            </div>
          ) : tab === 'trades' ? (
            <table className="tbl num w-full min-w-[960px] text-[12px]">
              <thead>
                <tr className="h-9 text-left">
                  <th className="px-4">Thời gian</th>
                  <th className="px-2">Lệnh gốc</th>
                  <th className="px-2">Mã</th>
                  <th className="px-2">Lệnh</th>
                  <th className="px-2 text-right">Giá khớp</th>
                  <th className="px-2 text-right">KL khớp</th>
                  <th className="px-2 text-right">Giá trị</th>
                  <th className="px-2 text-right">Phí</th>
                  <th className="px-2 text-right">Thuế</th>
                  <th className="px-4 text-right">Lãi/lỗ</th>
                </tr>
              </thead>
              <tbody>
                {(trades.data ?? []).slice(page * PAGE, page * PAGE + PAGE).map((t) => (
                  <tr key={t.id} className="h-9 border-t border-line hover:bg-bg-2">
                    <td className="px-4 text-tx-2">{fmtDateTimeVN(t.executedAt)}</td>
                    <td className="px-2 text-tx-3">#{t.orderId}</td>
                    <td className="px-2 font-semibold">{t.symbol}</td>
                    <td className="px-2">
                      <SideChip side={t.side} />
                    </td>
                    <td className="px-2 text-right">{fmtPrice(t.price)}</td>
                    <td className="px-2 text-right">{fmtInt(t.qty)}</td>
                    <td className="px-2 text-right">{fmtVnd(t.value)}</td>
                    <td className="px-2 text-right text-tx-2">{fmtVnd(t.fee)}</td>
                    <td className="px-2 text-right text-tx-2">{t.tax ? fmtVnd(t.tax) : '—'}</td>
                    <td className={cn('px-4 text-right font-medium', t.realizedPnl != null ? toneText[signTone(t.realizedPnl)] : 'text-tx-3')}>
                      {t.realizedPnl != null ? `${t.realizedPnl >= 0 ? '+' : ''}${fmtVnd(t.realizedPnl)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="tbl num w-full min-w-[860px] text-[12px]">
              <thead>
                <tr className="h-9 text-left">
                  <th className="px-4">Thời gian</th>
                  <th className="px-2">Loại</th>
                  <th className="px-2 text-right">Phát sinh</th>
                  <th className="px-2 text-right">Số dư sau</th>
                  <th className="px-4">Diễn giải</th>
                </tr>
              </thead>
              <tbody>
                {(ledger.data ?? []).slice(page * PAGE, page * PAGE + PAGE).map((l) => (
                  <tr key={l.id} className="h-9 border-t border-line hover:bg-bg-2">
                    <td className="px-4 text-tx-2">{fmtDateTimeVN(l.createdAt)}</td>
                    <td className="px-2">
                      <span className="chip h-5 bg-bg-3 text-[10px] text-tx-2">{LEDGER_LABEL[l.type]}</span>
                    </td>
                    <td className={cn('px-2 text-right font-medium', toneText[signTone(l.amount)])}>
                      {l.amount > 0 ? '+' : ''}
                      {fmtVnd(l.amount)}
                    </td>
                    <td className="px-2 text-right">{fmtVnd(l.balanceAfter)}</td>
                    <td className="px-4 text-tx-2">{l.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <Pager page={page} total={total} onChange={setPage} />
      </section>
    </div>
  );
}
