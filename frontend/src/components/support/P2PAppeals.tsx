import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { APPEAL_REASON_LABEL } from '@vss/shared';
import { useAdminAction } from '../../lib/admin';
import { cleanDecimal, cn, fmtDateTime } from '../../lib/format';
import { fmtCoin, fmtVndNum, useAppealDetail, useAppeals } from '../../lib/p2p';
import { Empty, Spinner } from '../common/ui';
import { OrderStatusChip } from '../p2p/common';
import { OrderChat } from '../p2p/OrderChat';

/**
 * Khiếu nại P2P (quyền p2p.appeal): đối chiếu chat + sao kê chuyển khoản giữa hai bên rồi phân xử.
 * Nhả coin = bên bán sai (đã nhận tiền); trả coin = người mua sai (chưa trả tiền). Chỉ trừ cọc được khi bên sai là thương nhân.
 */
export function P2PAppeals() {
  const [scope, setScope] = useState<'open' | 'resolved'>('open');
  const { data, isLoading } = useAppeals(scope);
  const [sel, setSel] = useState<number | null>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className="shrink-0 overflow-auto border-b border-line md:w-80 md:border-b-0 md:border-r">
        <div className="flex gap-1 border-b border-line p-2">
          {(['open', 'resolved'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={cn('h-7 rounded-md px-2.5 text-[12px] font-medium', scope === s ? 'bg-brand/12 text-brand' : 'text-tx-2 hover:bg-bg-3')}
            >
              {s === 'open' ? 'Chờ phân xử' : 'Đã xử lý'}
            </button>
          ))}
        </div>
        {isLoading ? (
          <Spinner className="m-4" />
        ) : !data?.length ? (
          <Empty title={scope === 'open' ? 'Không có khiếu nại chờ xử lý' : 'Chưa có khiếu nại'} />
        ) : (
          data.map((o) => (
            <button
              key={o.id}
              onClick={() => setSel(o.id)}
              className={cn('block w-full border-b border-line px-3 py-2.5 text-left text-[13px] hover:bg-bg-2', sel === o.id && 'bg-bg-2')}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">Đơn #{o.id}</span>
                <OrderStatusChip status={o.status} />
              </div>
              <div className="mt-0.5 text-[12px] text-tx-2">
                {fmtCoin(o.qty)} {o.asset} · {fmtVndNum(o.fiatAmount)} ₫
              </div>
              {o.appeal && (
                <div className="mt-0.5 text-[11px] text-tx-3">
                  {o.appeal.by === 'BUYER' ? 'Người mua' : 'Bên bán'}: {APPEAL_REASON_LABEL[o.appeal.reason]} · {fmtDateTime(o.appeal.at)}
                </div>
              )}
            </button>
          ))
        )}
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">{sel ? <Detail id={sel} /> : <Empty title="Chọn một khiếu nại để xem" />}</div>
    </div>
  );
}

function Detail({ id }: { id: number }) {
  const { data, isLoading, refetch } = useAppealDetail(id);
  const act = useAdminAction();
  const qc = useQueryClient();
  const [outcome, setOutcome] = useState<'RELEASE' | 'RETURN' | null>(null);
  const [note, setNote] = useState('');
  const [penalty, setPenalty] = useState('');

  if (isLoading || !data) return <Spinner className="m-6" />;
  const { order: o, transfers, buyer, seller } = data;
  // Bên có lỗi theo hướng phân xử; trừ cọc chỉ khi bên đó là thương nhân
  const faultyIsMaker = outcome === 'RELEASE' ? o.seller.id === o.maker.userId : outcome === 'RETURN' ? o.buyer.id === o.maker.userId : false;
  const paidTotal = transfers.filter((t) => t.direction === 'OUT').reduce((s, t) => s + Number(t.amount), 0);

  const resolve = async () => {
    if (!outcome) return;
    const r = await act(
      `/support-desk/p2p/orders/${o.id}/resolve`,
      'POST',
      { outcome, note, ...(penalty && faultyIsMaker && { penaltyUsdt: penalty }) },
      outcome === 'RELEASE' ? 'Đã nhả coin cho người mua' : 'Đã trả coin về bên bán',
    );
    if (r) {
      setOutcome(null);
      setNote('');
      setPenalty('');
      void qc.invalidateQueries({ queryKey: ['desk-p2p'] });
    }
  };

  return (
    <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-4">
        <section className="panel p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[16px] font-semibold">Đơn #{o.id}</h2>
            <OrderStatusChip status={o.status} />
            <span className="text-[12px] text-tx-3">tạo {fmtDateTime(o.createdAt)}</span>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4">
            <div>
              <dt className="label">Số lượng</dt>
              <dd className="num">
                {fmtCoin(o.qty)} {o.asset}
              </dd>
            </div>
            <div>
              <dt className="label">Số tiền phải trả</dt>
              <dd className="num font-semibold">{fmtVndNum(o.fiatAmount)} ₫</dd>
            </div>
            <div>
              <dt className="label">Báo thanh toán</dt>
              <dd>{o.paidAt ? fmtDateTime(o.paidAt) : '—'}</dd>
            </div>
            <div>
              <dt className="label">Thương nhân</dt>
              <dd>{o.maker.name}</dd>
            </div>
          </dl>
          <div className="mt-3 grid gap-3 border-t border-line pt-3 text-[13px] sm:grid-cols-2">
            <div>
              <div className="label">Người mua {o.buyer.id === o.maker.userId && '(thương nhân)'}</div>
              <div className="font-medium">{o.buyer.name}</div>
              <div className="text-[12px] text-tx-3">
                {buyer.email} · TK {buyer.accountNo ?? '—'}
              </div>
            </div>
            <div>
              <div className="label">Bên bán {o.seller.id === o.maker.userId && '(thương nhân)'}</div>
              <div className="font-medium">{o.seller.name}</div>
              <div className="text-[12px] text-tx-3">
                {seller.email} · nhận tiền {o.paymentMethod.bankName} {o.paymentMethod.accountNo}
              </div>
            </div>
          </div>
          {o.appeal && (
            <div className="mt-3 rounded-md bg-down/8 px-3 py-2 text-[13px]">
              <b>{o.appeal.by === 'BUYER' ? 'Người mua' : 'Bên bán'} khiếu nại</b> · {APPEAL_REASON_LABEL[o.appeal.reason]} · {fmtDateTime(o.appeal.at)}
              <p className="mt-1 text-tx-2">{o.appeal.description}</p>
              {o.appeal.resolution && (
                <p className="mt-1 text-[12px] text-tx-3">
                  Đã phân xử ({o.appeal.resolution === 'RELEASED' ? 'nhả coin' : 'trả coin'}) bởi {o.appeal.resolvedBy}: {o.appeal.note}
                </p>
              )}
            </div>
          )}
        </section>

        <section className="panel p-4">
          <h3 className="text-[14px] font-semibold">Sao kê chuyển khoản giữa hai bên (từ 1 giờ trước khi tạo đơn)</h3>
          {!transfers.length ? (
            <p className="mt-2 text-[13px] text-down">Không có lệnh chuyển khoản nào giữa người mua và bên bán.</p>
          ) : (
            <>
              <ul className="mt-2 divide-y divide-line text-[13px]">
                {transfers.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="flex items-center gap-2">
                      {t.direction === 'OUT' ? <ArrowUpRight size={14} className="text-up" /> : <ArrowDownLeft size={14} className="text-down" />}
                      {t.direction === 'OUT' ? 'Người mua → bên bán' : 'Bên bán → người mua'} · {fmtDateTime(t.createdAt)} · “{t.memo || 'không ghi nội dung'}”
                    </span>
                    <span className="num font-semibold">{fmtVndNum(t.amount)} ₫</span>
                  </li>
                ))}
              </ul>
              <p className={cn('mt-2 text-[12px]', paidTotal >= Number(o.fiatAmount) ? 'text-up' : 'text-down')}>
                Người mua đã chuyển tổng {fmtVndNum(paidTotal)} ₫ / cần {fmtVndNum(o.fiatAmount)} ₫
              </p>
            </>
          )}
        </section>

        {o.status === 'APPEAL' && (
          <section className="panel p-4">
            <h3 className="text-[14px] font-semibold">Phân xử</h3>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {(
                [
                  ['RELEASE', 'Nhả coin cho người mua', 'Người mua đã trả đủ tiền, bên bán không nhả coin'],
                  ['RETURN', 'Trả coin về bên bán, huỷ đơn', 'Người mua chưa trả / trả không đủ tiền'],
                ] as const
              ).map(([v, t, d]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setOutcome(v)}
                  className={cn('rounded-lg border p-3 text-left text-[13px]', outcome === v ? 'border-brand bg-brand/8' : 'border-line hover:bg-bg-2')}
                >
                  <div className="font-semibold">{t}</div>
                  <div className="text-[12px] text-tx-3">{d}</div>
                </button>
              ))}
            </div>
            <label className="mt-3 block text-[13px]">
              <span className="label">Căn cứ phân xử (ghi vào đơn và nhật ký quản trị)</span>
              <textarea className="input mt-1 h-20 py-2" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
            </label>
            {outcome && (
              <label className="mt-3 block text-[13px]">
                <span className="label">Trừ tiền cọc thương nhân để bồi thường bên kia (USDT, tuỳ chọn)</span>
                <input
                  className="input num mt-1"
                  disabled={!faultyIsMaker}
                  placeholder={faultyIsMaker ? '0' : 'Bên có lỗi không phải thương nhân'}
                  value={penalty}
                  onChange={(e) => setPenalty(cleanDecimal(e.target.value))}
                />
              </label>
            )}
            <div className="mt-3 flex justify-end">
              <button className="btn btn-brand" disabled={!outcome || note.trim().length < 5} onClick={() => void resolve()}>
                Xác nhận phân xử
              </button>
            </div>
          </section>
        )}
      </div>
      <aside className="panel flex min-h-[420px] flex-col overflow-hidden xl:max-h-[720px]">
        <div className="border-b border-line px-3 py-2 text-[13px] font-semibold">Chat trong đơn</div>
        <OrderChat
          staffView
          messages={data.messages}
          viewerId={null}
          postPath={`/support-desk/p2p/orders/${o.id}/messages`}
          onSent={() => void refetch()}
        />
      </aside>
    </div>
  );
}
