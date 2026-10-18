import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CoinIcon } from '../components/common/CoinIcon';
import { Empty, Spinner, UnderlineTabs } from '../components/common/ui';
import { OrderStatusChip, P2PNav } from '../components/p2p/common';
import { cn, fmtDateTime } from '../lib/format';
import { fmtCoin, fmtVndNum, useP2POrders } from '../lib/p2p';

/** Danh sách đơn P2P của tôi */
export default function P2POrdersPage() {
  const [scope, setScope] = useState<'open' | 'done'>('open');
  const { data, isLoading } = useP2POrders(scope);

  useEffect(() => {
    document.title = 'Đơn P2P · VNCoin';
    return () => void (document.title = 'VNCoin · Sàn giao dịch coin mô phỏng');
  }, []);

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-[26px] font-bold tracking-tight">Đơn P2P của tôi</h1>
        <P2PNav />
      </div>
      <div className="panel mt-5 overflow-hidden">
        <UnderlineTabs
          value={scope}
          onChange={setScope}
          items={[
            { value: 'open', label: 'Đang xử lý' },
            { value: 'done', label: 'Đã kết thúc' },
          ]}
        />
        {isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : !data?.length ? (
          <Empty title={scope === 'open' ? 'Không có đơn đang xử lý' : 'Chưa có đơn nào'} hint={<Link to="/p2p" className="text-brand hover:underline">Vào chợ P2P</Link>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl w-full min-w-[760px] text-[13px]">
              <thead>
                <tr className="text-left">
                  <th className="px-4 py-2.5">Đơn</th>
                  <th className="px-4 py-2.5">Loại</th>
                  <th className="px-4 py-2.5 text-right">Số lượng</th>
                  <th className="px-4 py-2.5 text-right">Giá</th>
                  <th className="px-4 py-2.5 text-right">Số tiền</th>
                  <th className="px-4 py-2.5">Đối tác</th>
                  <th className="px-4 py-2.5">Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {data.map((o) => (
                  <tr key={o.id} className="border-t border-line hover:bg-bg-2">
                    <td className="px-4 py-2.5">
                      <Link to={`/p2p/don/${o.id}`} className="font-semibold text-brand hover:underline">
                        #{o.id}
                      </Link>
                      <div className="text-[11px] text-tx-3">{fmtDateTime(o.createdAt)}</div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={cn('font-semibold', o.side === 'BUY' ? 'text-up' : 'text-down')}>{o.side === 'BUY' ? 'Mua' : 'Bán'}</span>
                      <span className="ml-1.5 inline-flex items-center gap-1 align-middle">
                        <CoinIcon asset={o.asset} size={14} /> {o.asset}
                      </span>
                      {o.role === 'MAKER' && <span className="chip ml-1.5 bg-brand/12 text-brand">Thương nhân</span>}
                    </td>
                    <td className="num px-4 py-2.5 text-right">{fmtCoin(o.qty)}</td>
                    <td className="num px-4 py-2.5 text-right">{fmtVndNum(o.price)}</td>
                    <td className="num px-4 py-2.5 text-right font-semibold">{fmtVndNum(o.fiatAmount)} ₫</td>
                    <td className="px-4 py-2.5">{o.side === 'BUY' ? o.seller.name : o.buyer.name}</td>
                    <td className="px-4 py-2.5">
                      <OrderStatusChip status={o.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
