import { useState } from 'react';
import { ORDER_STATUS_LABEL, type OrderStatus } from '@vss/shared';
import { useAdminAction, useAdminOrders, type AdminOrder } from '../../lib/admin';
import { cn, fmtDateTimeVN, fmtInt, fmtPrice } from '../../lib/format';
import { Empty, Spinner, Tabs } from '../common/ui';
import { STATUS_STYLE, SideChip } from '../trade/OrdersPanel';
import { ReasonModal } from './adminUi';

export function Orders({ onOpenUser }: { onOpenUser(id: string): void }) {
  const [scope, setScope] = useState<'open' | 'today' | 'all'>('open');
  const [status, setStatus] = useState('');
  const [symbol, setSymbol] = useState('');
  const [email, setEmail] = useState('');
  const [side, setSide] = useState('');
  const [target, setTarget] = useState<AdminOrder | null>(null);
  const act = useAdminAction();
  const { data, isLoading } = useAdminOrders({
    scope,
    status: status || undefined,
    symbol: symbol.trim().toUpperCase() || undefined,
    email: email.trim() || undefined,
    side: side || undefined,
  });

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="mr-2 font-semibold">Lệnh toàn hệ thống {data ? `(${data.length}${data.length === 500 ? '+' : ''})` : ''}</h2>
        <Tabs
          size="sm"
          value={scope}
          onChange={setScope}
          items={[
            { value: 'open', label: 'Đang chờ khớp' },
            { value: 'today', label: 'Hôm nay' },
            { value: 'all', label: 'Tất cả' },
          ]}
        />
        <div className="ml-auto flex flex-wrap gap-2">
          <input className="input h-8 w-24 uppercase" placeholder="Mã CK" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
          <input className="input h-8 w-48" placeholder="Email nhà đầu tư" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select className="input h-8 w-28" value={side} onChange={(e) => setSide(e.target.value)} aria-label="Chiều lệnh">
            <option value="">Mua + bán</option>
            <option value="BUY">Mua</option>
            <option value="SELL">Bán</option>
          </select>
          <select className="input h-8 w-36" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Trạng thái">
            <option value="">Mọi trạng thái</option>
            {(Object.keys(ORDER_STATUS_LABEL) as OrderStatus[]).map((s) => (
              <option key={s} value={s}>
                {ORDER_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="overflow-x-auto">
        {isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : !data?.length ? (
          <Empty title="Không có lệnh phù hợp" />
        ) : (
          <table className="tbl num w-full min-w-[1080px] text-[12.5px]">
            <thead>
              <tr className="h-9 text-left">
                <th className="px-4">Số hiệu</th>
                <th className="px-2">Thời gian</th>
                <th className="px-2">Nhà đầu tư</th>
                <th className="px-2">Mã</th>
                <th className="px-2">Lệnh</th>
                <th className="px-2 text-right">Giá đặt</th>
                <th className="px-2 text-right">KL đặt</th>
                <th className="px-2 text-right">KL khớp</th>
                <th className="px-2 text-right">Giá khớp TB</th>
                <th className="px-2">Trạng thái</th>
                <th className="px-4 text-right" />
              </tr>
            </thead>
            <tbody>
              {data.map((o) => {
                const open = o.status === 'PENDING' || o.status === 'PARTIAL';
                return (
                  <tr key={o.id} className="h-10 border-t border-line hover:bg-bg-2">
                    <td className="px-4 text-tx-3">#{o.id}</td>
                    <td className="px-2 text-tx-2">{fmtDateTimeVN(o.createdAt)}</td>
                    <td className="px-2">
                      <button className="hover:text-brand" onClick={() => onOpenUser(o.userId)}>
                        {o.userEmail}
                      </button>
                    </td>
                    <td className="px-2 font-semibold">{o.symbol}</td>
                    <td className="px-2">
                      <SideChip side={o.side} /> <span className="text-tx-3">{o.orderType}</span>
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
                    <td className="px-4 text-right">
                      {open && (
                        <button className="text-[12px] text-down hover:underline" onClick={() => setTarget(o)}>
                          Huỷ hộ
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <ReasonModal
        open={!!target}
        title={`Huỷ lệnh #${target?.id ?? ''} của ${target?.userEmail ?? ''}`}
        description={
          target && (
            <>
              {target.side === 'BUY' ? 'Mua' : 'Bán'} {fmtInt(target.qty)} {target.symbol} — phần chưa khớp được huỷ và giải phóng phong toả. Nhà đầu tư thấy lý do huỷ trong sổ lệnh.
            </>
          )
        }
        confirmLabel="Huỷ lệnh"
        danger
        placeholder="Ví dụ: Lệnh bất thường, theo yêu cầu khách hàng…"
        onClose={() => setTarget(null)}
        onConfirm={async (reason) => {
          if (target && (await act(`/admin/orders/${target.id}/cancel`, 'POST', { reason }, `Đã huỷ lệnh #${target.id}`))) setTarget(null);
        }}
      />
    </section>
  );
}
