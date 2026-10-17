import { useState } from 'react';
import { Link } from 'react-router-dom';
import { History, LifeBuoy, Pencil, X } from 'lucide-react';
import { toast } from 'sonner';
import { Big, ORDER_STATUS_LABEL, ORDER_TYPE_LABEL, type OrderDTO, type OrderStatus, type SymbolRow } from '@vss/shared';
import { api, errMsg } from '../../lib/api';
import { cleanDecimal, cn, decOrNull, fmtDateTime, fmtPrice, fmtQty, fmtUsd, signTone, toneText } from '../../lib/format';
import { useAccount, useCancelOrder, useInvalidateTrading, useLoggedIn, useMyTrades, useOpenOrders, useOrderHistory } from '../../lib/queries';
import { useMarket } from '../../store/market';
import { CoinIcon } from '../common/CoinIcon';
import { Empty, Modal, Spinner } from '../common/ui';
import { OrderTimelineModal } from '../support/SupportUi';

export const STATUS_STYLE: Record<OrderStatus, string> = {
  NEW: 'bg-info/15 text-info',
  PARTIALLY_FILLED: 'bg-brand/15 text-brand',
  FILLED: 'bg-up/15 text-up',
  CANCELED: 'bg-bg-4 text-tx-3',
  EXPIRED: 'bg-bg-4 text-tx-3',
  REJECTED: 'bg-down/15 text-down',
};

export function SideChip({ side }: { side: 'BUY' | 'SELL' }) {
  return <span className={cn('font-semibold', side === 'BUY' ? 'text-up' : 'text-down')}>{side === 'BUY' ? 'Mua' : 'Bán'}</span>;
}

/** Tên loại lệnh hiển thị (OCO ghi rõ là 1 chân của OCO) */
export function typeLabel(o: Pick<OrderDTO, 'type' | 'orderListId'>) {
  return o.orderListId ? `OCO · ${ORDER_TYPE_LABEL[o.type]}` : ORDER_TYPE_LABEL[o.type];
}

/** Sửa lệnh giới hạn (huỷ và đặt lại với giá / số lượng mới) */
export function ModifyOrderModal({ order, onClose }: { order: OrderDTO | null; onClose(): void }) {
  const r = useMarket((s) => (order ? s.rows[order.symbol] : undefined));
  const invalidate = useInvalidateTrading();
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastId, setLastId] = useState<number | null>(null);
  if (order && order.id !== lastId) {
    setLastId(order.id);
    setPrice(order.price ?? '');
    setQty(new Big(order.origQty).minus(order.executedQty).toFixed());
  }
  if (!order || !r) return null;

  const save = async () => {
    const p = decOrNull(price);
    const q = decOrNull(qty);
    if (!p || !q) return toast.error('Nhập giá và số lượng');
    setBusy(true);
    try {
      await api(`/orders/${order.id}`, { method: 'PUT', body: { price: p, quantity: q } });
      toast.success(`Đã sửa lệnh ${order.symbol}`);
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
      open={!!order}
      onClose={onClose}
      title={`Sửa lệnh ${order.side === 'BUY' ? 'mua' : 'bán'} ${r.baseAsset}/${r.quoteAsset}`}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Đóng
          </button>
          <button className="btn btn-brand" disabled={busy} onClick={() => void save()}>
            Xác nhận
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="label">Giá ({r.quoteAsset})</span>
          <input className="input num mt-1" inputMode="decimal" value={price} onChange={(e) => setPrice(cleanDecimal(e.target.value))} />
        </label>
        <label className="block">
          <span className="label">Số lượng ({r.baseAsset})</span>
          <input className="input num mt-1" inputMode="decimal" value={qty} onChange={(e) => setQty(cleanDecimal(e.target.value))} />
        </label>
        <p className="text-[12px] text-tx-3">Sửa lệnh = huỷ lệnh cũ và đặt lệnh mới (mất thứ tự ưu tiên trên sổ lệnh), giống Binance.</p>
      </div>
    </Modal>
  );
}

function OpenOrders({ symbol, onlyThis }: { symbol: string; onlyThis: boolean }) {
  const { data, isLoading } = useOpenOrders(onlyThis ? symbol : undefined);
  const rows = useMarket((s) => s.rows);
  const cancel = useCancelOrder();
  const [editing, setEditing] = useState<OrderDTO | null>(null);
  const [timeline, setTimeline] = useState<number | null>(null);
  if (isLoading) return <Spinner className="m-6" />;
  if (!data?.length) return <Empty title="Không có lệnh mở" />;
  return (
    <>
      <table className="tbl num w-full text-[12px]">
        <thead>
          <tr className="text-left">
            <th className="px-3 py-2">Thời gian</th>
            <th className="px-2">Cặp</th>
            <th className="px-2">Loại</th>
            <th className="px-2">Chiều</th>
            <th className="px-2 text-right">Giá</th>
            <th className="px-2 text-right">Kích hoạt</th>
            <th className="px-2 text-right">Số lượng</th>
            <th className="px-2 text-right">Đã khớp</th>
            <th className="px-2 text-right">Tổng</th>
            <th className="px-3 text-right">Thao tác</th>
          </tr>
        </thead>
        <tbody>
          {data.map((o) => {
            const r = rows[o.symbol];
            const filledPct = Number(o.origQty) ? (Number(o.executedQty) / Number(o.origQty)) * 100 : 0;
            return (
              <tr key={o.id} className="border-t border-line hover:bg-bg-2">
                <td className="px-3 py-2 text-tx-2">{fmtDateTime(o.createdAt)}</td>
                <td className="px-2 font-medium">
                  <Link to={`/trade/${o.symbol}`} className="hover:text-brand">
                    {r ? `${r.baseAsset}/${r.quoteAsset}` : o.symbol}
                  </Link>
                </td>
                <td className="px-2 text-tx-2">
                  {typeLabel(o)}
                  {o.stopPrice && !o.isWorking && <span className="ml-1 text-[10px] text-ref">chờ kích hoạt</span>}
                </td>
                <td className="px-2">
                  <SideChip side={o.side} />
                </td>
                <td className="px-2 text-right">{o.price ? fmtPrice(o.price, r?.filters.tickSize) : 'Thị trường'}</td>
                <td className="px-2 text-right text-tx-2">{o.stopPrice ? fmtPrice(o.stopPrice, r?.filters.tickSize) : '--'}</td>
                <td className="px-2 text-right">{fmtQty(o.origQty, r?.filters.stepSize)}</td>
                <td className="px-2 text-right text-tx-2">{filledPct.toFixed(2)}%</td>
                <td className="px-2 text-right">{o.price ? fmtUsd(new Big(o.price).times(o.origQty).toFixed()) : '--'}</td>
                <td className="px-3 text-right">
                  <div className="flex justify-end gap-1">
                    <OrderMoreActions id={o.id} onTimeline={setTimeline} />
                    {o.type === 'LIMIT' && !o.orderListId && (
                      <button onClick={() => setEditing(o)} className="rounded p-1 text-tx-3 hover:bg-bg-3 hover:text-tx-1" aria-label="Sửa lệnh" title="Sửa lệnh">
                        <Pencil size={14} />
                      </button>
                    )}
                    <button onClick={() => void cancel(o)} className="rounded p-1 text-tx-3 hover:bg-bg-3 hover:text-down" aria-label="Huỷ lệnh" title={o.orderListId ? 'Huỷ cả lệnh OCO' : 'Huỷ lệnh'}>
                      <X size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ModifyOrderModal order={editing} onClose={() => setEditing(null)} />
      <OrderTimelineModal orderId={timeline} onClose={() => setTimeline(null)} />
    </>
  );
}

/** Xem nhật ký lệnh (ai đặt / sửa / huỷ, lúc nào, IP) và báo sự cố lệnh cho bộ phận hỗ trợ */
function OrderMoreActions({ id, onTimeline }: { id: number; onTimeline(id: number): void }) {
  return (
    <>
      <button onClick={() => onTimeline(id)} className="rounded p-1 text-tx-3 hover:bg-bg-3 hover:text-tx-1" aria-label={`Nhật ký lệnh ${id}`} title="Nhật ký lệnh">
        <History size={14} />
      </button>
      <Link to={`/ho-tro?new=1&order=${id}`} className="rounded p-1 text-tx-3 hover:bg-bg-3 hover:text-ref" aria-label={`Báo sự cố lệnh ${id}`} title="Báo sự cố lệnh này cho CSKH">
        <LifeBuoy size={14} />
      </Link>
    </>
  );
}

function OrderHistory({ symbol, onlyThis }: { symbol: string; onlyThis: boolean }) {
  const { data, isLoading } = useOrderHistory(onlyThis ? { symbol } : {}, 100);
  const rows = useMarket((s) => s.rows);
  const [timeline, setTimeline] = useState<number | null>(null);
  if (isLoading) return <Spinner className="m-6" />;
  const list = (data ?? []).filter((o) => o.status !== 'NEW' && o.status !== 'PARTIALLY_FILLED');
  if (!list.length) return <Empty title="Chưa có lịch sử lệnh" />;
  return (
    <>
      <table className="tbl num w-full text-[12px]">
      <thead>
        <tr className="text-left">
          <th className="px-3 py-2">Thời gian</th>
          <th className="px-2">Cặp</th>
          <th className="px-2">Loại</th>
          <th className="px-2">Chiều</th>
          <th className="px-2 text-right">Giá TB</th>
          <th className="px-2 text-right">Giá đặt</th>
          <th className="px-2 text-right">Đã khớp</th>
          <th className="px-2 text-right">Tổng</th>
          <th className="px-2 text-right">Trạng thái</th>
          <th className="px-3" />
        </tr>
      </thead>
      <tbody>
        {list.map((o) => {
          const r = rows[o.symbol];
          return (
            <tr key={o.id} className="border-t border-line hover:bg-bg-2" title={o.reason ?? undefined}>
              <td className="px-3 py-2 text-tx-2">{fmtDateTime(o.updatedAt)}</td>
              <td className="px-2 font-medium">{r ? `${r.baseAsset}/${r.quoteAsset}` : o.symbol}</td>
              <td className="px-2 text-tx-2">{typeLabel(o)}</td>
              <td className="px-2">
                <SideChip side={o.side} />
              </td>
              <td className="px-2 text-right">{o.avgPrice !== '0' ? fmtPrice(o.avgPrice, r?.filters.tickSize) : '--'}</td>
              <td className="px-2 text-right text-tx-2">{o.price ? fmtPrice(o.price, r?.filters.tickSize) : 'Thị trường'}</td>
              <td className="px-2 text-right">{fmtQty(o.executedQty, r?.filters.stepSize)}</td>
              <td className="px-2 text-right">{fmtUsd(o.cummulativeQuoteQty)}</td>
              <td className="px-2 text-right">
                <span className={cn('chip h-5 px-1.5 text-[10px]', STATUS_STYLE[o.status])}>{ORDER_STATUS_LABEL[o.status]}</span>
              </td>
              <td className="px-3">
                <div className="flex justify-end gap-1">
                  <OrderMoreActions id={o.id} onTimeline={setTimeline} />
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
      </table>
      <OrderTimelineModal orderId={timeline} onClose={() => setTimeline(null)} />
    </>
  );
}

function TradeHistory({ symbol, onlyThis }: { symbol: string; onlyThis: boolean }) {
  const { data, isLoading } = useMyTrades(onlyThis ? { symbol } : {}, 100);
  const rows = useMarket((s) => s.rows);
  if (isLoading) return <Spinner className="m-6" />;
  if (!data?.length) return <Empty title="Chưa có giao dịch khớp" />;
  return (
    <table className="tbl num w-full text-[12px]">
      <thead>
        <tr className="text-left">
          <th className="px-3 py-2">Thời gian</th>
          <th className="px-2">Cặp</th>
          <th className="px-2">Chiều</th>
          <th className="px-2 text-right">Giá</th>
          <th className="px-2 text-right">Số lượng</th>
          <th className="px-2 text-right">Tổng</th>
          <th className="px-2 text-right">Phí</th>
          <th className="px-3 text-right">Lãi/lỗ</th>
        </tr>
      </thead>
      <tbody>
        {data.map((t) => {
          const r = rows[t.symbol];
          return (
            <tr key={t.id} className="border-t border-line hover:bg-bg-2">
              <td className="px-3 py-2 text-tx-2">{fmtDateTime(t.time)}</td>
              <td className="px-2 font-medium">{r ? `${r.baseAsset}/${r.quoteAsset}` : t.symbol}</td>
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
              <td className={cn('px-3 text-right', t.realizedPnl ? toneText[signTone(t.realizedPnl)] : 'text-tx-3')}>
                {t.realizedPnl ? `${Number(t.realizedPnl) > 0 ? '+' : ''}${fmtUsd(t.realizedPnl)}` : '--'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Assets() {
  const { data, isLoading } = useAccount();
  const rows = useMarket((s) => s.rows);
  if (isLoading) return <Spinner className="m-6" />;
  const list = data?.balances ?? [];
  if (!list.length) return <Empty title="Ví trống" />;
  return (
    <table className="tbl num w-full text-[12px]">
      <thead>
        <tr className="text-left">
          <th className="px-3 py-2">Tài sản</th>
          <th className="px-2 text-right">Tổng</th>
          <th className="px-2 text-right">Khả dụng</th>
          <th className="px-2 text-right">Đang khoá</th>
          <th className="px-2 text-right">Giá vốn TB</th>
          <th className="px-2 text-right">Giá trị (USDT)</th>
          <th className="px-3 text-right">Lãi/lỗ chưa chốt</th>
        </tr>
      </thead>
      <tbody>
        {list.map((b) => {
          const r: SymbolRow | undefined = rows[`${b.asset}USDT`];
          return (
            <tr key={b.asset} className="border-t border-line hover:bg-bg-2">
              <td className="px-3 py-2">
                <span className="flex items-center gap-2 font-medium">
                  <CoinIcon asset={b.asset} size={18} />
                  {b.asset}
                </span>
              </td>
              <td className="px-2 text-right">{fmtQty(b.total, r?.filters.stepSize)}</td>
              <td className="px-2 text-right">{fmtQty(b.free, r?.filters.stepSize)}</td>
              <td className="px-2 text-right text-tx-2">{fmtQty(b.locked, r?.filters.stepSize)}</td>
              <td className="px-2 text-right text-tx-2">{b.avgCost ? fmtPrice(b.avgCost, r?.filters.tickSize) : '--'}</td>
              <td className="px-2 text-right">{fmtUsd(b.usdtValue)}</td>
              <td className={cn('px-3 text-right', b.unrealizedPnl ? toneText[signTone(b.unrealizedPnl)] : 'text-tx-3')}>
                {b.unrealizedPnl ? `${Number(b.unrealizedPnl) > 0 ? '+' : ''}${fmtUsd(b.unrealizedPnl)}` : '--'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

type Tab = 'open' | 'history' | 'trades' | 'assets';

/** Bảng dưới màn giao dịch: lệnh mở, lịch sử lệnh, lịch sử khớp, tài sản */
export function OrdersPanel({ symbol }: { symbol: string }) {
  const loggedIn = useLoggedIn();
  const [tab, setTab] = useState<Tab>('open');
  const [onlyThis, setOnlyThis] = useState(false);
  const { data: open } = useOpenOrders();
  const invalidate = useInvalidateTrading();
  const openCount = open?.length ?? 0;

  const cancelAll = async () => {
    if (!confirm(onlyThis ? `Huỷ tất cả lệnh mở của ${symbol}?` : 'Huỷ tất cả lệnh mở?')) return;
    try {
      const r = await api<{ canceled: number }>(`/openOrders${onlyThis ? `?symbol=${symbol}` : ''}`, { method: 'DELETE' });
      toast.success(`Đã huỷ ${r.canceled} lệnh`);
    } catch (e) {
      toast.error(errMsg(e));
    }
    invalidate();
  };

  const tabs: { value: Tab; label: string }[] = [
    { value: 'open', label: `Lệnh mở (${openCount})` },
    { value: 'history', label: 'Lịch sử lệnh' },
    { value: 'trades', label: 'Lịch sử khớp' },
    { value: 'assets', label: 'Tài sản' },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-line px-4">
        {tabs.map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={cn(
              'relative h-10 text-[13px] font-medium',
              tab === t.value ? 'text-tx-1 after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand' : 'text-tx-3 hover:text-tx-1',
            )}
          >
            {t.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-3 text-[12px]">
          {tab !== 'assets' && (
            <label className="flex items-center gap-1.5 text-tx-2">
              <input type="checkbox" checked={onlyThis} onChange={(e) => setOnlyThis(e.target.checked)} className="accent-[var(--brand)]" />
              Chỉ cặp này
            </label>
          )}
          {tab === 'open' && openCount > 0 && (
            <button onClick={() => void cancelAll()} className="font-medium text-brand hover:underline">
              Huỷ tất cả
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!loggedIn ? (
          <Empty
            title="Đăng nhập để xem lệnh và tài sản"
            hint={
              <Link to="/login" className="text-brand hover:underline">
                Đăng nhập
              </Link>
            }
          />
        ) : tab === 'open' ? (
          <OpenOrders symbol={symbol} onlyThis={onlyThis} />
        ) : tab === 'history' ? (
          <OrderHistory symbol={symbol} onlyThis={onlyThis} />
        ) : tab === 'trades' ? (
          <TradeHistory symbol={symbol} onlyThis={onlyThis} />
        ) : (
          <Assets />
        )}
      </div>
    </div>
  );
}
