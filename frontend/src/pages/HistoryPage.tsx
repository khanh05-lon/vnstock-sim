import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { LEDGER_LABEL, ORDER_STATUS_LABEL, type OrderStatus } from '@vss/shared';
import { CoinIcon } from '../components/common/CoinIcon';
import { Empty, Spinner, UnderlineTabs } from '../components/common/ui';
import { MonthlyReport } from '../components/portfolio/MonthlyReport';
import { SideChip, STATUS_STYLE, typeLabel } from '../components/trade/OrdersPanel';
import { cn, dateISO, downloadCsv, fmtDateTime, fmtPrice, fmtQty, fmtUsd, signTone, toneText } from '../lib/format';
import { useLedger, useMyTrades, useOrderHistory, type HistoryFilter } from '../lib/queries';
import { useMarket } from '../store/market';

type Tab = 'orders' | 'trades' | 'ledger' | 'report';
const PAGE = 50;

function Pager({ page, total, onChange }: { page: number; total: number; onChange(p: number): void }) {
  const pages = Math.max(1, Math.ceil(total / PAGE));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2 text-[12px] text-tx-3">
      <span>
        Trang {page + 1}/{pages}, {total} dòng
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

/** Lịch sử: lệnh, khớp lệnh, sổ cái số dư, báo cáo lãi/lỗ theo tháng */
export default function HistoryPage() {
  const rows = useMarket((s) => s.rows);
  const symbols = useMarket((s) => s.symbols);
  const [tab, setTab] = useState<Tab>('orders');
  const [from, setFrom] = useState(dateISO(30));
  const [to, setTo] = useState(dateISO(0));
  const [symbol, setSymbol] = useState('');
  const [side, setSide] = useState('');
  const [status, setStatus] = useState('');
  const [asset, setAsset] = useState('');
  const [page, setPage] = useState(0);

  const filter: HistoryFilter = useMemo(
    () => ({ from, to, symbol: symbol || undefined, side: side || undefined, status: tab === 'orders' ? status || undefined : undefined, asset: asset || undefined }),
    [from, to, symbol, side, status, tab, asset],
  );
  const orders = useOrderHistory(filter, 1000);
  const trades = useMyTrades(filter, 1000);
  const ledger = useLedger(filter);

  const summary = useMemo(() => {
    const list = trades.data ?? [];
    return list.reduce(
      (a, t) => {
        if (t.side === 'BUY') a.buy += Number(t.quoteQty);
        else a.sell += Number(t.quoteQty);
        a.pnl += Number(t.realizedPnl ?? 0);
        return a;
      },
      { buy: 0, sell: 0, pnl: 0 },
    );
  }, [trades.data]);

  const pairName = (s: string) => (rows[s] ? `${rows[s]!.baseAsset}/${rows[s]!.quoteAsset}` : s);

  const exportCsv = () => {
    if (tab === 'orders') {
      downloadCsv(
        `lich-su-lenh_${from}_${to}.csv`,
        ['Mã lệnh', 'Thời gian', 'Cặp', 'Chiều', 'Loại', 'Giá đặt', 'Giá kích hoạt', 'Số lượng', 'Đã khớp', 'Giá TB', 'Tổng (USDT)', 'Trạng thái', 'Ghi chú'],
        (orders.data ?? []).map((o) => [
          o.id,
          fmtDateTime(o.createdAt),
          o.symbol,
          o.side === 'BUY' ? 'Mua' : 'Bán',
          o.type,
          o.price,
          o.stopPrice,
          o.origQty,
          o.executedQty,
          o.avgPrice,
          o.cummulativeQuoteQty,
          ORDER_STATUS_LABEL[o.status],
          o.reason,
        ]),
      );
    } else if (tab === 'trades') {
      downloadCsv(
        `lich-su-khop_${from}_${to}.csv`,
        ['Thời gian', 'Mã lệnh', 'Cặp', 'Chiều', 'Vai trò', 'Giá', 'Số lượng', 'Tổng (USDT)', 'Phí', 'Tài sản phí', 'Lãi/lỗ (USDT)'],
        (trades.data ?? []).map((t) => [
          fmtDateTime(t.time),
          t.orderId,
          t.symbol,
          t.side === 'BUY' ? 'Mua' : 'Bán',
          t.isMaker ? 'Maker' : 'Taker',
          t.price,
          t.qty,
          t.quoteQty,
          t.commission,
          t.commissionAsset,
          t.realizedPnl,
        ]),
      );
    } else {
      downloadCsv(
        `so-cai_${from}_${to}.csv`,
        ['Thời gian', 'Tài sản', 'Loại', 'Phát sinh', 'Số dư sau', 'Mã lệnh', 'Diễn giải'],
        (ledger.data ?? []).map((l) => [fmtDateTime(l.createdAt), l.asset, LEDGER_LABEL[l.type], l.amount, l.balanceAfter, l.orderId, l.note]),
      );
    }
  };

  const assets = useMemo(() => ['USDT', ...symbols.map((s) => rows[s]?.baseAsset).filter((a): a is string => !!a)], [symbols, rows]);
  const loading = tab === 'orders' ? orders.isLoading : tab === 'trades' ? trades.isLoading : ledger.isLoading;
  const pageSlice = <T,>(list: T[] | undefined) => (list ?? []).slice(page * PAGE, page * PAGE + PAGE);

  return (
    <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
      <h1 className="text-[26px] font-bold tracking-tight">Lịch sử</h1>
      <section className="panel mt-4 overflow-hidden">
        <UnderlineTabs
          value={tab}
          onChange={(t) => {
            setTab(t);
            setPage(0);
          }}
          items={[
            { value: 'orders', label: 'Lịch sử lệnh' },
            { value: 'trades', label: 'Lịch sử khớp' },
            { value: 'ledger', label: 'Sổ cái số dư' },
            { value: 'report', label: 'Báo cáo tháng' },
          ]}
        />
        {tab === 'report' ? (
          <MonthlyReport defaultYear={new Date().getUTCFullYear()} />
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3">
              <label>
                <span className="label">Từ ngày</span>
                <input type="date" className="input mt-1 h-8 w-36" value={from} onChange={(e) => (setFrom(e.target.value), setPage(0))} />
              </label>
              <label>
                <span className="label">Đến ngày</span>
                <input type="date" className="input mt-1 h-8 w-36" value={to} onChange={(e) => (setTo(e.target.value), setPage(0))} />
              </label>
              {tab !== 'ledger' ? (
                <>
                  <label>
                    <span className="label">Cặp</span>
                    <select className="input mt-1 h-8 w-32" value={symbol} onChange={(e) => (setSymbol(e.target.value), setPage(0))}>
                      <option value="">Tất cả</option>
                      {symbols.map((s) => (
                        <option key={s} value={s}>
                          {pairName(s)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className="label">Chiều</span>
                    <select className="input mt-1 h-8 w-24" value={side} onChange={(e) => (setSide(e.target.value), setPage(0))}>
                      <option value="">Tất cả</option>
                      <option value="BUY">Mua</option>
                      <option value="SELL">Bán</option>
                    </select>
                  </label>
                </>
              ) : (
                <label>
                  <span className="label">Tài sản</span>
                  <select className="input mt-1 h-8 w-28" value={asset} onChange={(e) => (setAsset(e.target.value), setPage(0))}>
                    <option value="">Tất cả</option>
                    {assets.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {tab === 'orders' && (
                <label>
                  <span className="label">Trạng thái</span>
                  <select className="input mt-1 h-8 w-36" value={status} onChange={(e) => (setStatus(e.target.value), setPage(0))}>
                    <option value="">Tất cả</option>
                    {(Object.keys(ORDER_STATUS_LABEL) as OrderStatus[]).map((s) => (
                      <option key={s} value={s}>
                        {ORDER_STATUS_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button className="btn btn-ghost ml-auto h-8" onClick={exportCsv}>
                <Download size={14} /> Xuất CSV
              </button>
            </div>

            {tab === 'trades' && (trades.data?.length ?? 0) > 0 && (
              <div className="num flex flex-wrap gap-x-6 gap-y-1 border-b border-line px-4 py-2.5 text-[12px]">
                <span className="text-tx-3">
                  Tổng mua <b className="text-tx-1">{fmtUsd(summary.buy)}</b>
                </span>
                <span className="text-tx-3">
                  Tổng bán <b className="text-tx-1">{fmtUsd(summary.sell)}</b>
                </span>
                <span className="text-tx-3">
                  Lãi/lỗ đã thực hiện <b className={toneText[signTone(summary.pnl)]}>{`${summary.pnl > 0 ? '+' : ''}${fmtUsd(summary.pnl)}`} USDT</b>
                </span>
              </div>
            )}

            <div className="overflow-x-auto">
              {loading ? (
                <div className="flex justify-center py-12">
                  <Spinner />
                </div>
              ) : tab === 'orders' ? (
                !orders.data?.length ? (
                  <Empty title="Không có lệnh trong khoảng thời gian này" />
                ) : (
                  <table className="tbl num w-full min-w-[960px] text-[12px]">
                    <thead>
                      <tr className="text-left">
                        <th className="px-4 py-2.5">Thời gian</th>
                        <th className="px-2">Cặp</th>
                        <th className="px-2">Loại</th>
                        <th className="px-2">Chiều</th>
                        <th className="px-2 text-right">Giá đặt</th>
                        <th className="px-2 text-right">Kích hoạt</th>
                        <th className="px-2 text-right">Số lượng</th>
                        <th className="px-2 text-right">Đã khớp</th>
                        <th className="px-2 text-right">Giá TB</th>
                        <th className="px-2 text-right">Tổng (USDT)</th>
                        <th className="px-4 text-right">Trạng thái</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageSlice(orders.data).map((o) => {
                        const r = rows[o.symbol];
                        return (
                          <tr key={o.id} className="border-t border-line hover:bg-bg-2" title={o.reason ?? undefined}>
                            <td className="px-4 py-2 text-tx-2">{fmtDateTime(o.createdAt)}</td>
                            <td className="px-2 font-medium">{pairName(o.symbol)}</td>
                            <td className="px-2 text-tx-2">{typeLabel(o)}</td>
                            <td className="px-2">
                              <SideChip side={o.side} />
                            </td>
                            <td className="px-2 text-right">{o.price ? fmtPrice(o.price, r?.filters.tickSize) : 'Thị trường'}</td>
                            <td className="px-2 text-right text-tx-2">{o.stopPrice ? fmtPrice(o.stopPrice, r?.filters.tickSize) : '--'}</td>
                            <td className="px-2 text-right">{fmtQty(o.origQty, r?.filters.stepSize)}</td>
                            <td className="px-2 text-right">{fmtQty(o.executedQty, r?.filters.stepSize)}</td>
                            <td className="px-2 text-right">{o.avgPrice !== '0' ? fmtPrice(o.avgPrice, r?.filters.tickSize) : '--'}</td>
                            <td className="px-2 text-right">{fmtUsd(o.cummulativeQuoteQty)}</td>
                            <td className="px-4 text-right">
                              <span className={cn('chip h-5 px-1.5 text-[10px]', STATUS_STYLE[o.status])}>{ORDER_STATUS_LABEL[o.status]}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )
              ) : tab === 'trades' ? (
                !trades.data?.length ? (
                  <Empty title="Không có giao dịch khớp trong khoảng thời gian này" />
                ) : (
                  <table className="tbl num w-full min-w-[900px] text-[12px]">
                    <thead>
                      <tr className="text-left">
                        <th className="px-4 py-2.5">Thời gian</th>
                        <th className="px-2">Cặp</th>
                        <th className="px-2">Chiều</th>
                        <th className="px-2 text-right">Giá</th>
                        <th className="px-2 text-right">Số lượng</th>
                        <th className="px-2 text-right">Tổng (USDT)</th>
                        <th className="px-2 text-right">Phí</th>
                        <th className="px-4 text-right">Lãi/lỗ (USDT)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageSlice(trades.data).map((t) => {
                        const r = rows[t.symbol];
                        return (
                          <tr key={t.id} className="border-t border-line hover:bg-bg-2">
                            <td className="px-4 py-2 text-tx-2">{fmtDateTime(t.time)}</td>
                            <td className="px-2 font-medium">{pairName(t.symbol)}</td>
                            <td className="px-2">
                              <SideChip side={t.side} />
                              <span className="ml-1 text-[10px] text-tx-3">{t.isMaker ? 'Maker' : 'Taker'}</span>
                            </td>
                            <td className="px-2 text-right">{fmtPrice(t.price, r?.filters.tickSize)}</td>
                            <td className="px-2 text-right">{fmtQty(t.qty, r?.filters.stepSize)}</td>
                            <td className="px-2 text-right">{fmtUsd(t.quoteQty)}</td>
                            <td className="px-2 text-right text-tx-2">
                              {t.commission} {t.commissionAsset}
                            </td>
                            <td className={cn('px-4 text-right', t.realizedPnl ? toneText[signTone(t.realizedPnl)] : 'text-tx-3')}>
                              {t.realizedPnl ? `${Number(t.realizedPnl) > 0 ? '+' : ''}${fmtUsd(t.realizedPnl)}` : '--'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )
              ) : !ledger.data?.length ? (
                <Empty title="Không có biến động số dư trong khoảng thời gian này" />
              ) : (
                <table className="tbl num w-full min-w-[820px] text-[12px]">
                  <thead>
                    <tr className="text-left">
                      <th className="px-4 py-2.5">Thời gian</th>
                      <th className="px-2">Tài sản</th>
                      <th className="px-2">Loại</th>
                      <th className="px-2 text-right">Phát sinh</th>
                      <th className="px-2 text-right">Số dư sau</th>
                      <th className="px-4">Diễn giải</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageSlice(ledger.data).map((l) => (
                      <tr key={l.id} className="border-t border-line hover:bg-bg-2">
                        <td className="px-4 py-2 text-tx-2">{fmtDateTime(l.createdAt)}</td>
                        <td className="px-2">
                          <span className="flex items-center gap-1.5 font-medium">
                            <CoinIcon asset={l.asset} size={16} />
                            {l.asset}
                          </span>
                        </td>
                        <td className="px-2 text-tx-2">{LEDGER_LABEL[l.type]}</td>
                        <td className={cn('px-2 text-right font-medium', toneText[signTone(l.amount)])}>
                          {Number(l.amount) > 0 ? '+' : ''}
                          {fmtQty(l.amount)}
                        </td>
                        <td className="px-2 text-right">{fmtQty(l.balanceAfter)}</td>
                        <td className="max-w-[320px] truncate px-4 text-tx-2">{l.note ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <Pager
              page={page}
              total={(tab === 'orders' ? orders.data : tab === 'trades' ? trades.data : ledger.data)?.length ?? 0}
              onChange={setPage}
            />
          </>
        )}
      </section>
    </div>
  );
}
