import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HandCoins, Landmark, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { RULES, type AccountDTO } from '@vss/shared';
import { api, errMsg } from '../../lib/api';
import { cn, fmtDateVN, fmtInt, fmtVnd, parseIntInput } from '../../lib/format';
import { useInvalidateTrading, type AdvancePreview } from '../../lib/queries';
import { Modal, Spinner } from '../common/ui';

function Row({ label, value, tone, hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-[12.5px]" title={hint}>
      <span className="text-tx-3">{label}</span>
      <span className={cn('num font-medium', tone)}>{value}</span>
    </div>
  );
}

function AdvanceModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const { data, isLoading } = useQuery({ queryKey: ['advance'], queryFn: () => api<AdvancePreview>('/account/advance'), enabled: open });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidateTrading();
  const amount = parseIntInput(text);
  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="Ứng trước tiền bán"
      width={460}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Đóng
          </button>
          <button
            className="btn btn-brand"
            disabled={busy || !amount || !data || amount > data.maxNet}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api<{ gross: number; fee: number; net: number }>('/account/advance', { method: 'POST', body: { amount } });
                toast.success(`Đã ứng ${fmtVnd(r.net)}đ`, { description: `Ứng ${fmtVnd(r.gross)}đ, phí ${fmtVnd(r.fee)}đ` });
                invalidate();
                setText('');
                onClose();
              } catch (e) {
                toast.error(errMsg(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Ứng trước
          </button>
        </>
      }
    >
      {isLoading || !data ? (
        <Spinner />
      ) : (
        <div className="space-y-3 text-[13px]">
          <p className="text-tx-2">
            Nhận ngay tiền bán chứng khoán chưa về (T+2). Phí {(RULES.advanceFeeRateDaily * 100).toFixed(3)}%/ngày × số ngày còn lại tới ngày tiền về; khoản về sớm nhất được ứng trước.
          </p>
          <table className="tbl num w-full text-[12px]">
            <thead>
              <tr className="h-7 text-left">
                <th>Ngày tiền về</th>
                <th className="text-right">Có thể ứng</th>
                <th className="text-right">Số ngày</th>
                <th className="text-right">Phí nếu ứng hết</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.id} className="h-7 border-t border-line">
                  <td>{fmtDateVN(i.settleDate)}</td>
                  <td className="text-right">{fmtVnd(i.available)}</td>
                  <td className="text-right">{i.days}</td>
                  <td className="text-right">{fmtVnd(i.fee)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <label className="block">
            <span className="label">Số tiền muốn nhận (tối đa {fmtVnd(data.maxNet)}đ)</span>
            <div className="mt-1 flex gap-2">
              <input className="input num" value={text} onChange={(e) => setText(e.target.value ? fmtInt(parseIntInput(e.target.value)) : '')} />
              <button className="btn btn-ghost shrink-0" onClick={() => setText(fmtInt(data.maxNet))}>
                Tối đa
              </button>
            </div>
          </label>
        </div>
      )}
    </Modal>
  );
}

function EnableMarginModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidateTrading();
  const m = RULES.margin;
  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="Kích hoạt giao dịch ký quỹ"
      width={480}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Huỷ
          </button>
          <button
            className="btn btn-brand"
            disabled={!ok || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api('/account/margin', { method: 'POST', body: { enabled: true, acceptRisk: true } });
                toast.success('Đã kích hoạt ký quỹ');
                invalidate();
                onClose();
              } catch (e) {
                toast.error(errMsg(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Kích hoạt
          </button>
        </>
      }
    >
      <div className="space-y-3 text-[13px] text-tx-2">
        <div className="flex gap-3 rounded-md bg-down/10 p-3 text-down">
          <ShieldAlert size={20} className="shrink-0" />
          <span>Ký quỹ là vay tiền để mua chứng khoán: lãi và lỗ đều được khuếch đại. Bạn có thể mất nhiều hơn số tiền tự có.</span>
        </div>
        <ul className="list-disc space-y-1 pl-5">
          <li>Hạn mức vay mặc định {fmtVnd(m.defaultCreditLimit)}đ; mỗi mã có tỷ lệ cho vay riêng (VN30 thường 50%, mã không cho vay 0%).</li>
          <li>Lãi vay {(m.interestRateYear * 100).toFixed(1)}%/năm, tính hằng ngày trên dư nợ; tiền bán về được tự động trả nợ (lãi trước, gốc sau).</li>
          <li>
            Tỷ lệ ký quỹ ban đầu {Math.round(m.initialRatio * 100)}%, duy trì {Math.round(m.callRatio * 100)}% (cảnh báo), xử lý {Math.round(m.forceRatio * 100)}% — dưới mức
            xử lý hệ thống tự bán giải chấp, không cần hỏi ý kiến bạn.
          </li>
        </ul>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5 accent-[var(--brand)]" checked={ok} onChange={(e) => setOk(e.target.checked)} />
          <span>Tôi đã đọc và hiểu rủi ro của giao dịch ký quỹ (đây là vốn ảo phục vụ học tập).</span>
        </label>
      </div>
    </Modal>
  );
}

function RepayModal({ a, open, onClose }: { a: AccountDTO; open: boolean; onClose(): void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidateTrading();
  const debt = (a.loanBalance ?? 0) + (a.loanInterest ?? 0);
  const max = Math.min(debt, a.cashAvailable);
  const amount = parseIntInput(text);
  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="Trả nợ ký quỹ"
      width={420}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Huỷ
          </button>
          <button
            className="btn btn-brand"
            disabled={busy || !amount || amount > max}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api<{ interest: number; principal: number }>('/account/margin/repay', { method: 'POST', body: { amount } });
                toast.success('Đã trả nợ', { description: `Lãi ${fmtVnd(r.interest)}đ · gốc ${fmtVnd(r.principal)}đ` });
                invalidate();
                setText('');
                onClose();
              } catch (e) {
                toast.error(errMsg(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Trả nợ
          </button>
        </>
      }
    >
      <div className="space-y-2 text-[13px]">
        <Row label="Dư nợ gốc" value={`${fmtVnd(a.loanBalance)}đ`} />
        <Row label="Lãi chưa trả" value={`${fmtVnd(a.loanInterest)}đ`} />
        <Row label="Tiền mặt khả dụng" value={`${fmtVnd(a.cashAvailable)}đ`} />
        <label className="block pt-1">
          <span className="label">Số tiền trả (trả lãi trước, gốc sau)</span>
          <div className="mt-1 flex gap-2">
            <input className="input num" value={text} onChange={(e) => setText(e.target.value ? fmtInt(parseIntInput(e.target.value)) : '')} />
            <button className="btn btn-ghost shrink-0" onClick={() => setText(fmtInt(max))}>
              Tối đa
            </button>
          </div>
        </label>
      </div>
    </Modal>
  );
}

/** Tiền, ứng trước, ký quỹ, lãi tiền gửi */
export function CashMarginPanel({ a }: { a: AccountDTO }) {
  const [adv, setAdv] = useState(false);
  const [enable, setEnable] = useState(false);
  const [repay, setRepay] = useState(false);
  const invalidate = useInvalidateTrading();
  const m = RULES.margin;
  const debt = (a.loanBalance ?? 0) + (a.loanInterest ?? 0);
  const ratio = a.marginRatio;
  const ratioTone = ratio == null ? 'text-tx-2' : ratio < m.forceRatio ? 'text-down' : ratio < m.callRatio ? 'text-ref' : 'text-up';
  const setAuto = async (v: boolean) => {
    try {
      await api('/account/settings', { method: 'PUT', body: { autoAdvance: v } });
      invalidate();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };
  const disable = async () => {
    try {
      await api('/account/margin', { method: 'POST', body: { enabled: false } });
      toast.success('Đã tắt ký quỹ');
      invalidate();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  return (
    <section className="panel overflow-hidden">
      <div className="border-b border-line px-4 py-3">
        <h2 className="flex items-center gap-2 font-semibold">
          <HandCoins size={16} className="text-brand" /> Tiền & ký quỹ
        </h2>
      </div>
      <div className="px-4 py-2">
        <Row label="Tiền mặt" value={`${fmtVnd(a.cashBalance)}đ`} />
        <Row label="Đang phong toả cho lệnh mua" value={`${fmtVnd(a.cashHold)}đ`} />
        <Row label="Tiền bán chờ về (T+2)" value={`${fmtVnd(a.cashPending)}đ`} />
        <div className="flex items-center justify-between gap-2 py-1 text-[12.5px]">
          <span className="text-tx-3">Có thể ứng trước (sau phí)</span>
          <span className="flex items-center gap-2">
            <span className="num font-medium">{fmtVnd(a.advanceable)}đ</span>
            <button className="text-[12px] font-semibold text-brand hover:underline disabled:opacity-40" disabled={!a.advanceable} onClick={() => setAdv(true)}>
              Ứng trước
            </button>
          </span>
        </div>
        <label className="flex cursor-pointer items-center justify-between py-1 text-[12.5px]">
          <span className="text-tx-3" title="Khi mua vượt tiền mặt, hệ thống tự ứng trước tiền bán chờ về (có phí)">Tự ứng trước khi mua</span>
          <input type="checkbox" className="accent-[var(--brand)]" checked={a.autoAdvance ?? true} onChange={(e) => void setAuto(e.target.checked)} />
        </label>
        <Row label="Lãi tiền gửi tạm tính (trả đầu tháng)" value={`${fmtVnd(a.depositInterestAccrued)}đ`} hint={`${(RULES.depositRateYear * 100).toFixed(2)}%/năm trên tiền mặt nhàn rỗi`} />
        {(a.rightsValue ?? 0) > 0 && <Row label="Quyền chờ về (cổ tức, CP thưởng)" value={`${fmtVnd(a.rightsValue)}đ`} />}
      </div>

      <div className="border-t border-line px-4 py-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[13px] font-semibold">
            <Landmark size={14} /> Ký quỹ (margin)
          </span>
          {a.marginEnabled ? (
            <span className="chip h-5 bg-up/15 text-[10px] text-up">Đã kích hoạt</span>
          ) : (
            <button className="btn btn-ghost h-7 px-2 text-[12px]" onClick={() => setEnable(true)}>
              Kích hoạt
            </button>
          )}
        </div>
        {a.marginEnabled ? (
          <>
            <Row label="Hạn mức vay" value={`${fmtVnd(a.creditLimit)}đ`} />
            <Row label="Dư nợ gốc" value={`${fmtVnd(a.loanBalance)}đ`} tone={a.loanBalance ? 'text-down' : undefined} />
            <Row label="Lãi vay chưa trả" value={`${fmtVnd(a.loanInterest)}đ`} />
            <Row label="Đang giữ cho lệnh chờ" value={`${fmtVnd(a.loanHold)}đ`} />
            <Row
              label="Tỷ lệ ký quỹ thực tế"
              value={ratio == null ? 'Không có nợ' : `${(ratio * 100).toFixed(1)}%`}
              tone={ratioTone}
              hint={`Ban đầu ${Math.round(m.initialRatio * 100)}% · duy trì ${Math.round(m.callRatio * 100)}% · xử lý ${Math.round(m.forceRatio * 100)}%`}
            />
            {ratio != null && (
              <div className="relative my-1.5 h-2 rounded bg-bg-3">
                <div className={cn('h-2 rounded', ratio < m.forceRatio ? 'bg-down' : ratio < m.callRatio ? 'bg-ref' : 'bg-up')} style={{ width: `${Math.max(2, Math.min(100, ratio * 100))}%` }} />
                {[m.forceRatio, m.callRatio, m.initialRatio].map((x) => (
                  <span key={x} className="absolute top-[-3px] h-[14px] w-px bg-tx-3" style={{ left: `${x * 100}%` }} />
                ))}
              </div>
            )}
            {a.marginStatus !== 'NORMAL' && (
              <p className={cn('text-[12px]', a.marginStatus === 'FORCE' ? 'text-down' : 'text-ref')}>
                {a.marginStatus === 'FORCE' ? 'Dưới tỷ lệ xử lý — hệ thống đang bán giải chấp.' : 'Dưới tỷ lệ duy trì (margin call).'} Cần nộp thêm khoảng{' '}
                {fmtVnd(a.marginCallAmount)}đ hoặc bán bớt cổ phiếu.
              </p>
            )}
            <div className="mt-2 flex gap-2">
              <button className="btn btn-ghost h-8 flex-1" disabled={!debt} onClick={() => setRepay(true)}>
                Trả nợ
              </button>
              <button className="btn btn-ghost h-8 flex-1" disabled={!!debt || !!a.loanHold} onClick={() => void disable()}>
                Tắt ký quỹ
              </button>
            </div>
          </>
        ) : (
          <p className="text-[12px] text-tx-3">Vay thêm tiền để mua cổ phiếu được phép ký quỹ. Kích hoạt để xem chi tiết điều kiện và rủi ro.</p>
        )}
      </div>
      <AdvanceModal open={adv} onClose={() => setAdv(false)} />
      <EnableMarginModal open={enable} onClose={() => setEnable(false)} />
      <RepayModal a={a} open={repay} onClose={() => setRepay(false)} />
    </section>
  );
}
