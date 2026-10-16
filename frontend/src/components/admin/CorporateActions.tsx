import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAdminAction } from '../../lib/admin';
import { cn, fmtDateVN, fmtInt, fmtPrice, parseIntInput, parsePriceInput } from '../../lib/format';
import { describeAction, type CaType, type CorporateAction } from '../../lib/queries';
import { useMarket } from '../../store/market';
import { Empty, Spinner } from '../common/ui';
import { Pill, ReasonModal, Section } from './adminUi';

const TYPES: { value: CaType; label: string }[] = [
  { value: 'CASH_DIVIDEND', label: 'Cổ tức bằng tiền' },
  { value: 'STOCK_DIVIDEND', label: 'Cổ tức cổ phiếu / thưởng' },
  { value: 'SPLIT', label: 'Chia tách' },
  { value: 'RIGHTS', label: 'Quyền mua phát hành thêm' },
];

const STATUS: Record<CorporateAction['status'], [string, 'info' | 'warn' | 'good' | 'muted']> = {
  ANNOUNCED: ['Đã công bố', 'info'],
  EX_DONE: ['Đã GDKHQ, chờ thanh toán', 'warn'],
  COMPLETED: ['Hoàn tất', 'good'],
  CANCELLED: ['Đã huỷ', 'muted'],
};

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

export function CorporateActions() {
  const act = useAdminAction();
  const { data, isLoading } = useQuery({ queryKey: ['admin', 'ca'], queryFn: () => api<CorporateAction[]>('/admin/corporate-actions'), refetchInterval: 30_000 });
  const tradeDate = useMarket((s) => s.session?.tradeDate) ?? new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const symbols = useMarket((s) => s.rows);
  const [f, setF] = useState({ symbol: '', type: 'CASH_DIVIDEND' as CaType, exDate: '', payDate: '', cash: '', from: '', to: '', issue: '', until: '', note: '' });
  const [cancel, setCancel] = useState<CorporateAction | null>(null);
  const set = (p: Partial<typeof f>) => setF((s) => ({ ...s, ...p }));
  const exDate = f.exDate || addDays(tradeDate, 1);
  const payDate = f.payDate || addDays(exDate, f.type === 'CASH_DIVIDEND' ? 14 : 7);
  const sym = f.symbol.trim().toUpperCase();
  const row = symbols[sym];
  const ok =
    !!row &&
    (row.type ?? 'STOCK') !== 'CW' &&
    (row.type ?? 'STOCK') !== 'BOND' &&
    exDate > tradeDate &&
    payDate >= exDate &&
    (f.type === 'CASH_DIVIDEND' ? parseIntInput(f.cash) > 0 : parseIntInput(f.from) > 0 && parseIntInput(f.to) > 0) &&
    (f.type !== 'RIGHTS' || ((parsePriceInput(f.issue) ?? 0) > 0 && !!f.until));

  const submit = async () => {
    const body = {
      symbol: sym,
      type: f.type,
      exDate,
      payDate,
      cashPerShare: f.type === 'CASH_DIVIDEND' ? parseIntInput(f.cash) : null,
      ratioFrom: f.type === 'CASH_DIVIDEND' ? null : parseIntInput(f.from),
      ratioTo: f.type === 'CASH_DIVIDEND' ? null : parseIntInput(f.to),
      issuePrice: f.type === 'RIGHTS' ? parsePriceInput(f.issue) : null,
      subscribeUntil: f.type === 'RIGHTS' ? f.until : null,
      note: f.note.trim() || undefined,
    };
    if (await act('/admin/corporate-actions', 'POST', body, `Đã công bố sự kiện quyền ${sym}`)) set({ symbol: '', cash: '', from: '', to: '', issue: '', note: '' });
  };

  return (
    <div className="space-y-3">
      <Section title="Công bố sự kiện quyền">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <label className="block">
            <span className="label">Mã</span>
            <input className="input mt-1 uppercase" list="ca-symbols" value={f.symbol} onChange={(e) => set({ symbol: e.target.value })} />
            <datalist id="ca-symbols">
              {Object.values(symbols)
                .filter((r) => (r.type ?? 'STOCK') === 'STOCK' || r.type === 'ETF')
                .map((r) => (
                  <option key={r.symbol} value={r.symbol} />
                ))}
            </datalist>
          </label>
          <label className="block md:col-span-2">
            <span className="label">Loại sự kiện</span>
            <select className="input mt-1" value={f.type} onChange={(e) => set({ type: e.target.value as CaType })}>
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Ngày GDKHQ</span>
            <input type="date" className="input mt-1" min={addDays(tradeDate, 1)} value={exDate} onChange={(e) => set({ exDate: e.target.value })} />
          </label>
          <label className="block">
            <span className="label">{f.type === 'RIGHTS' ? 'Ngày phát hành' : 'Ngày thanh toán'}</span>
            <input type="date" className="input mt-1" min={exDate} value={payDate} onChange={(e) => set({ payDate: e.target.value })} />
          </label>
          {f.type === 'CASH_DIVIDEND' ? (
            <label className="block">
              <span className="label">Cổ tức (đ / CP)</span>
              <input className="input num mt-1" placeholder="vd. 2,000" value={f.cash} onChange={(e) => set({ cash: e.target.value ? fmtInt(parseIntInput(e.target.value)) : '' })} />
            </label>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="label">{f.type === 'SPLIT' ? 'CP cũ' : 'Sở hữu'}</span>
                <input className="input num mt-1" placeholder="a" value={f.from} onChange={(e) => set({ from: e.target.value.replace(/\D/g, '') })} />
              </label>
              <label className="block">
                <span className="label">{f.type === 'SPLIT' ? 'CP mới' : f.type === 'RIGHTS' ? 'Được mua' : 'Nhận thêm'}</span>
                <input className="input num mt-1" placeholder="b" value={f.to} onChange={(e) => set({ to: e.target.value.replace(/\D/g, '') })} />
              </label>
            </div>
          )}
          {f.type === 'RIGHTS' && (
            <>
              <label className="block">
                <span className="label">Giá phát hành (x1.000đ)</span>
                <input className="input num mt-1" value={f.issue} onChange={(e) => set({ issue: e.target.value })} />
              </label>
              <label className="block">
                <span className="label">Hạn đăng ký mua</span>
                <input type="date" className="input mt-1" min={exDate} max={payDate} value={f.until} onChange={(e) => set({ until: e.target.value })} />
              </label>
            </>
          )}
          <label className="block md:col-span-2">
            <span className="label">Ghi chú</span>
            <input className="input mt-1" maxLength={300} value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder="vd. Cổ tức đợt 1 năm 2026" />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button className="btn btn-brand" disabled={!ok} onClick={() => void submit()}>
            Công bố
          </button>
          <p className="text-[12px] text-tx-3">
            Đầu phiên ngày GDKHQ: giá tham chiếu được điều chỉnh (nguồn giả lập), chốt danh sách người hưởng quyền theo số CP nắm giữ, huỷ lệnh nhiều ngày / lệnh điều kiện của mã. Ngày
            thanh toán: trả tiền (trừ thuế 5%) hoặc cổ phiếu vào tài khoản. Phần lẻ cổ phiếu bị huỷ.
          </p>
        </div>
      </Section>

      <Section title="Lịch sự kiện quyền" pad={false}>
        {isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : !data?.length ? (
          <Empty title="Chưa có sự kiện quyền" />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl num w-full min-w-[900px] text-[12.5px]">
              <thead>
                <tr className="h-9 text-left">
                  <th className="px-4">Mã</th>
                  <th className="px-2">Sự kiện</th>
                  <th className="px-2">GDKHQ</th>
                  <th className="px-2">ĐKCC</th>
                  <th className="px-2">Thanh toán</th>
                  <th className="px-2 text-right">Giá TC trước → sau</th>
                  <th className="px-2 text-right">Người hưởng</th>
                  <th className="px-2">Trạng thái</th>
                  <th className="px-4" />
                </tr>
              </thead>
              <tbody>
                {data.map((a) => (
                  <tr key={a.id} className="h-10 border-t border-line">
                    <td className="px-4 font-semibold">{a.symbol}</td>
                    <td className="px-2">
                      {describeAction(a)}
                      {a.note && <span className="block text-[11px] text-tx-3">{a.note}</span>}
                    </td>
                    <td className="px-2">{fmtDateVN(a.exDate)}</td>
                    <td className="px-2 text-tx-2">{fmtDateVN(a.recordDate)}</td>
                    <td className="px-2">{fmtDateVN(a.payDate)}</td>
                    <td className="px-2 text-right">{a.refBefore ? `${fmtPrice(a.refBefore)} → ${fmtPrice(a.refAfter)}` : '—'}</td>
                    <td className="px-2 text-right">{fmtInt(a.holders ?? 0)}</td>
                    <td className="px-2">
                      <Pill tone={STATUS[a.status][1]}>{STATUS[a.status][0]}</Pill>
                    </td>
                    <td className={cn('px-4 text-right')}>
                      {a.status === 'ANNOUNCED' && (
                        <button className="text-[12px] text-down hover:underline" onClick={() => setCancel(a)}>
                          Huỷ
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <ReasonModal
        open={!!cancel}
        title={`Huỷ sự kiện quyền ${cancel?.symbol ?? ''}`}
        description={cancel ? `${describeAction(cancel)} — GDKHQ ${fmtDateVN(cancel.exDate)}. Chỉ huỷ được trước ngày GDKHQ.` : undefined}
        confirmLabel="Huỷ sự kiện"
        danger
        requireReason={false}
        onClose={() => setCancel(null)}
        onConfirm={async () => {
          if (cancel && (await act(`/admin/corporate-actions/${cancel.id}/cancel`, 'POST', {}, 'Đã huỷ sự kiện quyền'))) setCancel(null);
        }}
      />
    </div>
  );
}
