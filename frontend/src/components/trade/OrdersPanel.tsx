import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Pencil, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  CONDITIONAL_STATUS_LABEL,
  ORDER_STATUS_LABEL,
  RULES,
  conditionalLabel,
  isValidTick,
  tickSize,
  type ConditionalOrderDTO,
  type ConditionalStatus,
  type OrderDTO,
  type OrderStatus,
} from '@vss/shared';
import { api, errMsg } from '../../lib/api';
import { cn, fmtBillion, fmtInt, fmtPrice, fmtTimeVN, fmtVnd, parseIntInput, parsePriceInput, priceTone, signTone, toneText } from '../../lib/format';
import { useAlerts, useCandles, useConditionalOrders, useInvalidateTrading, useLoggedIn, useOrders, usePortfolio } from '../../lib/queries';
import { useMarket, useStock } from '../../store/market';
import { Empty, Modal, Spinner, UnderlineTabs } from '../common/ui';
import { AlertsTable } from './PriceAlerts';

export const STATUS_STYLE: Record<OrderStatus, string> = {
  PENDING: 'bg-info/15 text-info',
  PARTIAL: 'bg-brand/15 text-brand',
  FILLED: 'bg-up/15 text-up',
  CANCELLED: 'bg-bg-4 text-tx-3',
  EXPIRED: 'bg-bg-4 text-tx-3',
  REJECTED: 'bg-down/15 text-down',
};

export function SideChip({ side }: { side: 'BUY' | 'SELL' }) {
  return <span className={cn('chip h-5 px-1.5 text-[10px]', side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down')}>{side === 'BUY' ? 'MUA' : 'BÁN'}</span>;
}

export function ModifyOrderModal({ order, onClose }: { order: OrderDTO | null; onClose(): void }) {
  const r = useStock(order?.symbol);
  const [priceText, setPriceText] = useState('');
  const [qtyText, setQtyText] = useState('');
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidateTrading();
  const [lastId, setLastId] = useState<number | null>(null);
  if (order && order.id !== lastId) {
    setLastId(order.id);
    setPriceText(order.price ? (order.price / 1000).toFixed(2) : '');
    setQtyText(fmtInt(order.qty));
  }
  if (!order || !r) return null;
  const price = parsePriceInput(priceText);
  const qty = parseIntInput(qtyText);
  let err: string | null = null;
  if (!price) err = 'Nhập giá';
  else if (!isValidTick(r, price)) err = `Sai bước giá (${tickSize(r, price)}đ)`;
  else if (price > r.ceil || price < r.floor) err = `Giá phải trong khoảng ${fmtPrice(r.floor)} – ${fmtPrice(r.ceil)}`;
  else if (!qty) err = 'Nhập khối lượng';
  else if (order.qty < RULES.lotSize ? qty >= RULES.lotSize : qty % RULES.lotSize) {
    err = order.qty < RULES.lotSize ? `Lệnh lô lẻ giữ khối lượng dưới ${RULES.lotSize}` : `Khối lượng là bội số của ${RULES.lotSize}`;
  }
  else if (qty <= order.filledQty) err = `Khối lượng phải lớn hơn KL đã khớp (${fmtInt(order.filledQty)})`;

  const save = async () => {
    setBusy(true);
    try {
      const body: { price?: number; qty?: number } = {};
      if (price !== order.price) body.price = price!;
      if (qty !== order.qty) body.qty = qty;
      await api(`/orders/${order.id}`, { method: 'PATCH', body });
      toast.success(`Đã sửa lệnh #${order.id}`);
      invalidate();
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Sửa lệnh #${order.id}`}
      width={380}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Đóng
          </button>
          <button className="btn btn-brand" disabled={!!err || busy} onClick={() => void save()}>
            Lưu thay đổi
          </button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <SideChip side={order.side} />
        <b className="text-[16px]">{order.symbol}</b>
        <span className="text-tx-3">
          Đã khớp {fmtInt(order.filledQty)}/{fmtInt(order.qty)}
        </span>
      </div>
      <label className="block">
        <span className="label">Giá mới (x1.000đ)</span>
        <input className="input num mt-1" value={priceText} onChange={(e) => setPriceText(e.target.value)} aria-invalid={!!err && !price} />
      </label>
      <label className="mt-3 block">
        <span className="label">Khối lượng mới</span>
        <input className="input num mt-1" value={qtyText} onChange={(e) => setQtyText(e.target.value ? fmtInt(parseIntInput(e.target.value)) : '')} />
      </label>
      {err && <div className="mt-2 text-[12px] text-down">{err}</div>}
    </Modal>
  );
}

const fmtDM = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

/** Loại lệnh + nhãn: lô lẻ, nhiều ngày, từ lệnh điều kiện, bán giải chấp */
export function OrderTypeCell({ o }: { o: OrderDTO }) {
  return (
    <span className="inline-flex items-center gap-1">
      {o.orderType}
      {o.qty < RULES.lotSize && <span className="chip h-4 bg-info/15 px-1 text-[9px] text-info">Lẻ</span>}
      {o.validUntil && (
        <span className="chip h-4 bg-brand/15 px-1 text-[9px] text-brand" title={`Lệnh nhiều ngày, hiệu lực tới hết ${fmtDM(o.validUntil)}`}>
          →{fmtDM(o.validUntil)}
        </span>
      )}
      {o.source === 'CONDITIONAL' && (
        <span className="chip h-4 bg-ceil/15 px-1 text-[9px] text-ceil" title="Đặt tự động khi lệnh điều kiện kích hoạt">
          ĐK
        </span>
      )}
      {o.source === 'FORCE_SELL' && (
        <span className="chip h-4 bg-down/15 px-1 text-[9px] text-down" title="Hệ thống bán giải chấp ký quỹ">
          Giải chấp
        </span>
      )}
    </span>
  );
}

const COND_STYLE: Record<ConditionalStatus, string> = {
  ACTIVE: 'bg-info/15 text-info',
  TRIGGERED: 'bg-up/15 text-up',
  CANCELLED: 'bg-bg-4 text-tx-3',
  EXPIRED: 'bg-bg-4 text-tx-3',
  FAILED: 'bg-down/15 text-down',
};

/** Danh sách lệnh điều kiện */
export function ConditionalTable({ rows, actions = true }: { rows: ConditionalOrderDTO[]; actions?: boolean }) {
  const invalidate = useInvalidateTrading();
  const nav = useNavigate();
  const cancel = async (c: ConditionalOrderDTO) => {
    try {
      await api(`/conditional-orders/${c.id}`, { method: 'DELETE' });
      toast.success(c.ocoGroup ? 'Đã huỷ cặp lệnh OCO' : 'Đã huỷ lệnh điều kiện');
      invalidate();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };
  return (
    <table className="tbl num w-full text-[12px]">
      <thead className="sticky top-0 z-[1] bg-bg-1">
        <tr className="h-8 text-left">
          <th className="px-3">Mã</th>
          <th className="px-2">Loại</th>
          <th className="px-2 text-right">Điều kiện</th>
          <th className="px-2 text-right">Lệnh khi kích hoạt</th>
          <th className="px-2 text-right">KL</th>
          <th className="px-2">Hiệu lực</th>
          <th className="px-2">Trạng thái</th>
          {actions && <th className="px-3 text-right" />}
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => {
          const cond =
            c.kind === 'TRAILING'
              ? `Giảm ${c.trailPct}% từ ${c.peakPrice ? fmtPrice(c.peakPrice) : '—'}`.replace('Giảm', c.side === 'SELL' ? 'Giảm' : 'Tăng')
              : `${(c.kind === 'STOP') === (c.side === 'SELL') ? '≤' : '≥'} ${fmtPrice(c.triggerPrice)}`;
          return (
            <tr key={c.id} className="h-9 border-t border-line hover:bg-bg-2">
              <td className="px-3">
                <button className="font-semibold hover:text-brand" onClick={() => nav(`/trade/${c.symbol}`)}>
                  {c.symbol}
                </button>
              </td>
              <td className="px-2">
                <span className={cn('font-medium', c.side === 'BUY' ? 'text-up' : 'text-down')}>{conditionalLabel(c.kind, c.side)}</span>
                {c.ocoGroup && <span className="chip ml-1 h-4 bg-bg-3 px-1 text-[9px] text-tx-2">OCO</span>}
              </td>
              <td className="px-2 text-right">{cond}</td>
              <td className="px-2 text-right">{c.orderType === 'MARKET' ? 'Thị trường' : `LO ${fmtPrice(c.limitPrice)}`}</td>
              <td className="px-2 text-right">{fmtInt(c.qty)}</td>
              <td className="px-2 text-tx-2">{fmtDM(c.validUntil)}</td>
              <td className="px-2">
                <span className={cn('chip h-5 text-[10px]', COND_STYLE[c.status])} title={c.message ?? undefined}>
                  {CONDITIONAL_STATUS_LABEL[c.status]}
                  {c.orderId ? ` · #${c.orderId}` : ''}
                </span>
              </td>
              {actions && (
                <td className="px-3 text-right">
                  {c.status === 'ACTIVE' && (
                    <button onClick={() => void cancel(c)} className="rounded p-1 text-tx-3 hover:bg-bg-3 hover:text-down" aria-label={`Huỷ lệnh điều kiện ${c.id}`} title="Huỷ">
                      <X size={15} />
                    </button>
                  )}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function OrdersTable({ orders, actions = true, showDate = false }: { orders: OrderDTO[]; actions?: boolean; showDate?: boolean }) {
  const [editing, setEditing] = useState<OrderDTO | null>(null);
  const invalidate = useInvalidateTrading();
  const nav = useNavigate();
  const cancel = async (o: OrderDTO) => {
    try {
      await api(`/orders/${o.id}`, { method: 'DELETE' });
      toast.success(`Đã huỷ lệnh #${o.id}`);
      invalidate();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };
  return (
    <>
      <table className="tbl num w-full text-[12px]">
        <thead className="sticky top-0 z-[1] bg-bg-1">
          <tr className="h-8 text-left">
            <th className="px-3">Số hiệu</th>
            <th className="px-2">{showDate ? 'Thời gian' : 'Giờ'}</th>
            <th className="px-2">Mã</th>
            <th className="px-2">Lệnh</th>
            <th className="px-2">Loại</th>
            <th className="px-2 text-right">Giá đặt</th>
            <th className="px-2 text-right">KL đặt</th>
            <th className="px-2 text-right">KL khớp</th>
            <th className="px-2 text-right">Giá khớp TB</th>
            <th className="px-2">Trạng thái</th>
            {actions && <th className="px-3 text-right">Thao tác</th>}
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const open = o.status === 'PENDING' || o.status === 'PARTIAL';
            return (
              <tr key={o.id} className="h-9 border-t border-line hover:bg-bg-2">
                <td className="px-3 text-tx-3">#{o.id}</td>
                <td className="px-2 text-tx-2">{showDate ? `${o.createdAt.slice(8, 10)}/${o.createdAt.slice(5, 7)} ${fmtTimeVN(o.createdAt).slice(0, 5)}` : fmtTimeVN(o.createdAt)}</td>
                <td className="px-2">
                  <button className="font-semibold hover:text-brand" onClick={() => nav(`/trade/${o.symbol}`)}>
                    {o.symbol}
                  </button>
                </td>
                <td className="px-2">
                  <SideChip side={o.side} />
                </td>
                <td className="px-2 text-tx-2">
                  <OrderTypeCell o={o} />
                </td>
                <td className="px-2 text-right">{o.price ? fmtPrice(o.price) : o.orderType}</td>
                <td className="px-2 text-right">{fmtInt(o.qty)}</td>
                <td className="px-2 text-right">{fmtInt(o.filledQty)}</td>
                <td className="px-2 text-right">{o.avgFillPrice ? fmtPrice(o.avgFillPrice) : '—'}</td>
                <td className="px-2">
                  <span className={cn('chip h-5 text-[10px]', STATUS_STYLE[o.status])} title={o.rejectReason ?? undefined}>
                    {ORDER_STATUS_LABEL[o.status]}
                  </span>
                </td>
                {actions && (
                  <td className="px-3 text-right">
                    {open && (
                      <span className="inline-flex gap-1">
                        {/* LO, hoặc phần còn lại của MP / MTL đã chuyển thành LO (có giá) */}
                        {(o.orderType === 'LO' || ((o.orderType === 'MP' || o.orderType === 'MTL') && o.price != null)) && (
                          <button onClick={() => setEditing(o)} className="rounded p-1 text-tx-3 hover:bg-bg-3 hover:text-brand" aria-label={`Sửa lệnh ${o.id}`} title="Sửa lệnh">
                            <Pencil size={14} />
                          </button>
                        )}
                        <button onClick={() => void cancel(o)} className="rounded p-1 text-tx-3 hover:bg-bg-3 hover:text-down" aria-label={`Huỷ lệnh ${o.id}`} title="Huỷ lệnh">
                          <X size={15} />
                        </button>
                      </span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <ModifyOrderModal order={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function PositionsMini() {
  const { data, isLoading } = usePortfolio();
  const rows = useMarket((s) => s.rows);
  const nav = useNavigate();
  if (isLoading) return <Spinner className="m-6" />;
  if (!data?.holdings.length) return <Empty title="Chưa nắm giữ cổ phiếu nào" />;
  return (
    <table className="tbl num w-full text-[12px]">
      <thead className="sticky top-0 bg-bg-1">
        <tr className="h-8 text-left">
          <th className="px-3">Mã</th>
          <th className="px-2 text-right">Tổng KL</th>
          <th className="px-2 text-right">Khả dụng</th>
          <th className="px-2 text-right">Chờ về</th>
          <th className="px-2 text-right">Giá vốn</th>
          <th className="px-2 text-right">Giá TT</th>
          <th className="px-2 text-right">Giá trị TT</th>
          <th className="px-3 text-right">Lãi/lỗ</th>
        </tr>
      </thead>
      <tbody>
        {data.holdings.map((h) => {
          const r = rows[h.symbol];
          const mp = r ? (r.volume ? r.last : r.ref) : h.marketPrice;
          const pnl = mp * h.qtyTotal - h.totalCost;
          const pct = h.totalCost ? (pnl / h.totalCost) * 100 : 0;
          return (
            <tr key={h.symbol} className="h-9 cursor-pointer border-t border-line hover:bg-bg-2" onClick={() => nav(`/trade/${h.symbol}`)}>
              <td className="px-3 font-semibold">{h.symbol}</td>
              <td className="px-2 text-right">{fmtInt(h.qtyTotal)}</td>
              <td className="px-2 text-right">{fmtInt(h.qtyAvailable)}</td>
              <td className="px-2 text-right text-tx-3">{fmtInt(h.qtyPending)}</td>
              <td className="px-2 text-right">{fmtPrice(h.avgCost)}</td>
              <td className={cn('px-2 text-right', r && toneText[priceTone(mp, r.ref, r.ceil, r.floor)])}>{fmtPrice(mp)}</td>
              <td className="px-2 text-right">{fmtVnd(mp * h.qtyTotal)}</td>
              <td className={cn('px-3 text-right font-medium', toneText[signTone(pnl)])}>
                {pnl > 0 ? '+' : ''}
                {fmtVnd(pnl)} ({pct > 0 ? '+' : ''}
                {pct.toFixed(2)}%)
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CompanyInfo({ symbol }: { symbol: string }) {
  const r = useStock(symbol);
  const { data: daily } = useCandles(symbol, '1D');
  const stats = useMemo(() => {
    if (!daily?.length) return null;
    const year = daily.slice(-250);
    const vol20 = daily.slice(-20);
    return {
      hi52: Math.max(...year.map((c) => c.high)),
      lo52: Math.min(...year.map((c) => c.low)),
      avgVol20: Math.round(vol20.reduce((a, c) => a + c.volume, 0) / vol20.length),
      ret1y: year.length > 1 ? ((year[year.length - 1].close - year[0].close) / year[0].close) * 100 : 0,
    };
  }, [daily]);
  if (!r) return null;
  const price = r.volume ? r.last : r.ref;
  const cap = price * r.listedShares;
  const items: [string, string, string?][] = [
    ['Tên doanh nghiệp', r.name],
    ['Sàn niêm yết', r.exchange + (r.isVn30 ? ' · VN30' : '')],
    ['Ngành', r.industry],
    ['KL niêm yết', `${fmtInt(r.listedShares)} CP`],
    ['Vốn hoá', `${fmtBillion(cap)} tỷ`],
    ['EPS (4 quý)', `${fmtInt(r.eps)}đ`],
    ['P/E', r.eps > 0 ? (price / r.eps).toFixed(2) : 'n/a'],
    ['BVPS', `${fmtInt(r.bvps)}đ`],
    ['P/B', r.bvps > 0 ? (price / r.bvps).toFixed(2) : 'n/a'],
    ['Cao nhất 52 tuần', stats ? fmtPrice(stats.hi52) : '—'],
    ['Thấp nhất 52 tuần', stats ? fmtPrice(stats.lo52) : '—'],
    ['KLGD TB 20 phiên', stats ? fmtInt(stats.avgVol20) : '—'],
    ['Biến động 1 năm', stats ? `${stats.ret1y > 0 ? '+' : ''}${stats.ret1y.toFixed(2)}%` : '—', stats ? toneText[signTone(stats.ret1y)] : undefined],
  ];
  return (
    <div className="p-3">
      <dl className="num grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(([k, v, c]) => (
          <div key={k} className="flex justify-between gap-3 border-b border-line/60 pb-1.5 text-[12px]">
            <dt className="text-tx-3">{k}</dt>
            <dd className={cn('truncate text-right font-medium', c)}>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[11px] text-tx-3">Thông tin cơ bản là số liệu mô phỏng phục vụ học tập, không phản ánh báo cáo tài chính thực tế.</p>
    </div>
  );
}

type PanelTab = 'open' | 'conditional' | 'alerts' | 'today' | 'positions' | 'company';

export function OrdersPanel({ symbol }: { symbol: string }) {
  const loggedIn = useLoggedIn();
  const [tab, setTab] = useState<PanelTab>(loggedIn ? 'open' : 'company');
  const { data: open } = useOrders('open');
  const { data: today, isLoading } = useOrders('today');
  const { data: conds } = useConditionalOrders('all');
  const activeConds = (conds ?? []).filter((c) => c.status === 'ACTIVE').length;
  const { data: alerts } = useAlerts();
  const activeAlerts = (alerts ?? []).filter((a) => a.status === 'ACTIVE').length;
  const invalidate = useInvalidateTrading();

  const cancelAll = async () => {
    if (!open?.length) return;
    let ok = 0;
    for (const o of open) {
      try {
        await api(`/orders/${o.id}`, { method: 'DELETE' });
        ok++;
      } catch {
        /* bỏ qua lệnh vừa khớp */
      }
    }
    toast.success(`Đã huỷ ${ok} lệnh`);
    invalidate();
  };

  const needLogin = !loggedIn && tab !== 'company';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center">
        <UnderlineTabs
          className="flex-1"
          value={tab}
          onChange={setTab}
          items={[
            { value: 'open', label: `Lệnh chờ khớp${open?.length ? ` (${open.length})` : ''}` },
            { value: 'conditional', label: `Lệnh điều kiện${activeConds ? ` (${activeConds})` : ''}` },
            { value: 'alerts', label: `Cảnh báo giá${activeAlerts ? ` (${activeAlerts})` : ''}` },
            { value: 'today', label: 'Sổ lệnh trong ngày' },
            { value: 'positions', label: 'Danh mục' },
            { value: 'company', label: 'Hồ sơ doanh nghiệp' },
          ]}
        />
        {tab === 'open' && !!open?.length && (
          <button onClick={() => void cancelAll()} className="mr-3 border-b border-line text-[12px] text-down hover:underline">
            Huỷ tất cả
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {needLogin ? (
          <Empty
            title="Đăng nhập để xem lệnh và danh mục"
            hint={
              <Link to="/login" className="text-brand hover:underline">
                Đăng nhập ngay
              </Link>
            }
          />
        ) : tab === 'company' ? (
          <CompanyInfo symbol={symbol} />
        ) : tab === 'conditional' ? (
          conds?.length ? <ConditionalTable rows={conds.slice(0, 100)} /> : <Empty title="Chưa có lệnh điều kiện" hint="Dùng tab Lệnh điều kiện ở khung đặt lệnh để cài cắt lỗ / chốt lời." />
        ) : tab === 'alerts' ? (
          <AlertsTable />
        ) : tab === 'positions' ? (
          <PositionsMini />
        ) : tab === 'open' ? (
          open?.length ? <OrdersTable orders={open} /> : <Empty title="Không có lệnh chờ khớp" />
        ) : isLoading ? (
          <Spinner className="m-6" />
        ) : today?.length ? (
          <OrdersTable orders={today} />
        ) : (
          <Empty title="Chưa có lệnh nào trong phiên hôm nay" />
        )}
      </div>
    </div>
  );
}
