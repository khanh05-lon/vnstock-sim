import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { toast } from 'sonner';
import { api, errMsg } from '../../lib/api';
import { cn, fmtDateVN, fmtInt, fmtVnd, parseIntInput } from '../../lib/format';
import { describeAction, useCorporateActions, useEntitlements, useInvalidateTrading, usePortfolio, type Entitlement } from '../../lib/queries';
import { useMarket } from '../../store/market';
import { Empty } from '../common/ui';

const STATUS: Record<Entitlement['status'], [string, string]> = {
  PENDING: ['Chờ thanh toán', 'bg-info/15 text-info'],
  PAID: ['Đã nhận', 'bg-up/15 text-up'],
  CANCELLED: ['Đã huỷ', 'bg-bg-4 text-tx-3'],
};

/** Đăng ký mua cổ phiếu phát hành thêm theo quyền */
function Subscribe({ e }: { e: Entitlement }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidateTrading();
  const left = e.shares - e.subscribed;
  const qty = parseIntInput(text);
  const tradeDate = useMarket((s) => s.session?.tradeDate) ?? '';
  const a = e.action;
  if (a.type !== 'RIGHTS' || a.status !== 'EX_DONE' || !a.subscribeUntil || tradeDate > a.subscribeUntil || left <= 0) return null;
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <input className="input num h-7 w-24 text-[12px]" placeholder={`≤ ${fmtInt(left)}`} value={text} onChange={(x) => setText(x.target.value ? fmtInt(parseIntInput(x.target.value)) : '')} />
      <button
        className="btn btn-brand h-7 px-2 text-[12px]"
        disabled={busy || !qty || qty > left}
        onClick={async () => {
          setBusy(true);
          try {
            await api(`/corporate-actions/${a.id}/subscribe`, { method: 'POST', body: { qty } });
            toast.success(`Đã đăng ký mua ${fmtInt(qty)} ${a.symbol}`, { description: `Trừ ${fmtVnd(qty * (a.issuePrice ?? 0))}đ, cổ phiếu về ngày ${fmtDateVN(a.payDate)}` });
            setText('');
            invalidate();
          } catch (err) {
            toast.error(errMsg(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        Đăng ký mua
      </button>
      <span className="text-[11px] text-tx-3">hạn {fmtDateVN(a.subscribeUntil)}</span>
    </div>
  );
}

export function EntitlementsPanel() {
  const { data: ents } = useEntitlements();
  const { data: upcoming } = useCorporateActions({ upcoming: true });
  const { data: pf } = usePortfolio();
  const held = new Set(pf?.holdings.map((h) => h.symbol) ?? []);
  const soon = (upcoming ?? []).filter((a) => a.status === 'ANNOUNCED' && held.has(a.symbol));

  return (
    <section className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="font-semibold">Quyền & cổ tức</h2>
        <span className="text-[11px] text-tx-3">Chốt theo số cổ phiếu nắm giữ trước ngày GDKHQ</span>
      </div>
      {soon.length > 0 && (
        <ul className="divide-y divide-line border-b border-line bg-bg-2/50">
          {soon.map((a) => (
            <li key={a.id} className="flex items-center gap-2 px-4 py-2 text-[12px]">
              <CalendarClock size={14} className="shrink-0 text-brand" />
              <b>{a.symbol}</b>
              <span className="text-tx-2">{describeAction(a)}</span>
              <span className="ml-auto text-tx-3">GDKHQ {fmtDateVN(a.exDate)}</span>
            </li>
          ))}
        </ul>
      )}
      {ents?.length ? (
        <ul className="max-h-80 divide-y divide-line overflow-y-auto">
          {ents.map((e) => {
            const [label, cls] = STATUS[e.status];
            const a = e.action;
            const value =
              a.type === 'CASH_DIVIDEND'
                ? `${fmtVnd(e.cashAmount - e.taxAmount)}đ (sau thuế ${fmtVnd(e.taxAmount)}đ)`
                : a.type === 'RIGHTS'
                  ? `Được mua ${fmtInt(e.shares)} CP · đã đăng ký ${fmtInt(e.subscribed)}`
                  : `+${fmtInt(e.shares)} CP`;
            return (
              <li key={e.id} className="px-4 py-2.5 text-[12.5px]">
                <div className="flex flex-wrap items-center gap-x-2">
                  <b>{a.symbol}</b>
                  <span className="text-tx-2">{describeAction(a)}</span>
                  <span className={cn('chip ml-auto h-5 text-[10px]', cls)}>{label}</span>
                </div>
                <div className="num mt-0.5 flex flex-wrap gap-x-3 text-[11.5px] text-tx-3">
                  <span>Nắm giữ {fmtInt(e.qtyHeld)} CP</span>
                  <span className="text-tx-1">{value}</span>
                  <span>
                    GDKHQ {fmtDateVN(a.exDate)} · thanh toán {fmtDateVN(a.payDate)}
                  </span>
                </div>
                <Subscribe e={e} />
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty title="Chưa có quyền nào" hint="Cổ tức, cổ phiếu thưởng, chia tách, quyền mua của các mã bạn nắm giữ sẽ hiện ở đây." />
      )}
    </section>
  );
}
