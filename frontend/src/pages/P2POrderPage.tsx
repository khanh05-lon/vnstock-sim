import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, CheckCircle2, Clock, Gavel, Landmark, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { APPEAL_REASON_LABEL, type AppealReason, type P2POrderDTO } from '@vss/shared';
import { CoinIcon } from '../components/common/CoinIcon';
import { Empty, Modal, Spinner } from '../components/common/ui';
import { CopyButton, OrderStatusChip, TraderCell, countdown } from '../components/p2p/common';
import { OrderChat } from '../components/p2p/OrderChat';
import { TransferDialog } from '../components/p2p/TransferDialog';
import { api, errMsg } from '../lib/api';
import { cn, fmtDateTime } from '../lib/format';
import { fmtCoin, fmtVndNum, useInvalidateP2P, useP2PMessages, useP2POrder } from '../lib/p2p';
import { useAuth } from '../store/auth';

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const STEPS = ['Đặt đơn', 'Thanh toán', 'Nhả coin', 'Hoàn tất'];

function stepOf(o: P2POrderDTO) {
  if (o.status === 'COMPLETED') return 4;
  if (o.status === 'PAID' || o.status === 'APPEAL') return 2;
  return 1;
}

/** Chi tiết đơn P2P cho người mua và bên bán */
export default function P2POrderPage() {
  const id = Number(useParams().id) || null;
  const me = useAuth((s) => s.user);
  const { data: o, isLoading, error, refetch } = useP2POrder(id);
  const { data: messages, refetch: refetchMsgs } = useP2PMessages(id);
  const invalidate = useInvalidateP2P();
  const now = useNow();
  const [transfer, setTransfer] = useState(false);
  const [confirm, setConfirm] = useState<'paid' | 'release' | 'cancel' | null>(null);
  const [appeal, setAppeal] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (o) document.title = `Đơn P2P #${o.id} · VNCoin`;
    return () => void (document.title = 'VNCoin · Sàn giao dịch coin mô phỏng');
  }, [o?.id, o]);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (error || !o) return <Empty title="Không tìm thấy đơn P2P" hint={(error as Error | null)?.message} />;

  const buyer = o.side === 'BUY';
  const counterparty = buyer ? o.seller : o.buyer;
  const left = o.status === 'PENDING_PAYMENT' ? countdown(o.payDeadline, now) : null;
  const canAppeal = o.status === 'PAID' && !!o.appealAvailableAt && new Date(o.appealAvailableAt).getTime() <= now;
  const appealIn = o.status === 'PAID' && o.appealAvailableAt ? countdown(o.appealAvailableAt, now) : null;
  const open = ['PENDING_PAYMENT', 'PAID', 'APPEAL'].includes(o.status);
  const memo = `P2P ${o.id}`;

  const act = async (path: string, body?: unknown, ok?: string) => {
    setBusy(true);
    try {
      await api(`/p2p/orders/${o.id}/${path}`, { method: 'POST', body: body ?? {} });
      if (ok) toast.success(ok);
      invalidate();
      void refetch();
      void refetchMsgs();
      setConfirm(null);
      setAppeal(false);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 sm:px-6">
      <Link to="/p2p/don" className="inline-flex items-center gap-1 text-[13px] text-tx-3 hover:text-tx-1">
        <ArrowLeft size={14} /> Đơn P2P của tôi
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <CoinIcon asset={o.asset} size={28} />
        <h1 className="text-[22px] font-bold tracking-tight">
          <span className={buyer ? 'text-up' : 'text-down'}>{buyer ? 'Mua' : 'Bán'}</span> {fmtCoin(o.qty)} {o.asset}
        </h1>
        <OrderStatusChip status={o.status} />
        <span className="text-[12px] text-tx-3">
          Đơn #{o.id} · {fmtDateTime(o.createdAt)}
        </span>
      </div>

      <ol className="mt-5 grid grid-cols-4 gap-2" aria-label="Tiến trình đơn">
        {STEPS.map((s, i) => {
          const done = o.status !== 'CANCELLED' && stepOf(o) > i;
          const cur = o.status !== 'CANCELLED' && stepOf(o) === i;
          return (
            <li key={s} className="flex flex-col gap-1.5">
              <span className={cn('h-1 rounded-full', done ? 'bg-brand' : cur ? 'bg-brand/40' : 'bg-bg-3')} />
              <span className={cn('text-[12px]', done || cur ? 'text-tx-1' : 'text-tx-3')}>{s}</span>
            </li>
          );
        })}
      </ol>

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
        <div className="space-y-4">
          {/* Trạng thái + việc cần làm */}
          <section className="panel p-4">
            {o.status === 'PENDING_PAYMENT' && (
              <div className="flex items-start gap-3">
                <Clock size={20} className="mt-0.5 shrink-0 text-ref" />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">
                    {buyer ? 'Chuyển khoản cho bên bán' : 'Chờ người mua thanh toán'}
                    {left && <span className="num ml-2 rounded bg-ref/15 px-2 py-0.5 text-ref">{left}</span>}
                  </div>
                  <p className="mt-1 text-[13px] text-tx-2">
                    {buyer
                      ? `Chuyển đúng ${fmtVndNum(o.fiatAmount)} ₫ trong ${o.payMinutes} phút, nội dung "${memo}". Chuyển xong mới bấm "Tôi đã thanh toán".`
                      : `${fmtCoin(o.qty)} ${o.asset} của bạn đang được sàn giữ ký quỹ. Không nhả coin trước khi thấy tiền về tài khoản.`}
                  </p>
                </div>
              </div>
            )}
            {o.status === 'PAID' && (
              <div className="flex items-start gap-3">
                <Landmark size={20} className="mt-0.5 shrink-0 text-info" />
                <div>
                  <div className="font-semibold">{buyer ? 'Đã báo thanh toán, chờ bên bán nhả coin' : 'Người mua báo đã chuyển tiền'}</div>
                  <p className="mt-1 text-[13px] text-tx-2">
                    {buyer
                      ? 'Bên bán đang kiểm tra tiền về. Nếu quá lâu, nhắn bên bán hoặc khiếu nại.'
                      : (
                        <>
                          Mở{' '}
                          <Link to="/ngan-hang" className="font-semibold text-brand hover:underline">
                            sao kê ngân hàng
                          </Link>{' '}
                          kiểm tra đã nhận đủ {fmtVndNum(o.fiatAmount)} ₫ từ {o.buyer.name}, rồi mới nhả coin.
                        </>
                      )}
                  </p>
                  {appealIn && <p className="mt-1 text-[12px] text-tx-3">Có thể khiếu nại sau {appealIn}</p>}
                </div>
              </div>
            )}
            {o.status === 'APPEAL' && o.appeal && (
              <div className="flex items-start gap-3">
                <Gavel size={20} className="mt-0.5 shrink-0 text-down" />
                <div>
                  <div className="font-semibold">Đang khiếu nại · {APPEAL_REASON_LABEL[o.appeal.reason]}</div>
                  <p className="mt-1 text-[13px] text-tx-2">
                    {o.appeal.by === 'BUYER' ? 'Người mua' : 'Bên bán'} khiếu nại lúc {fmtDateTime(o.appeal.at)}: “{o.appeal.description}”. Coin tiếp tục được sàn giữ
                    tới khi nhân viên phân xử. Gửi bằng chứng trong khung chat.
                  </p>
                </div>
              </div>
            )}
            {o.status === 'COMPLETED' && (
              <div className="flex items-start gap-3">
                <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-up" />
                <div>
                  <div className="font-semibold">Đơn hoàn tất</div>
                  <p className="mt-1 text-[13px] text-tx-2">
                    {buyer ? `${fmtCoin(o.qty)} ${o.asset} đã vào ví Spot của bạn.` : `Đã nhả ${fmtCoin(o.qty)} ${o.asset} cho người mua.`}
                    {o.appeal?.resolution && ` Khiếu nại đã được phân xử: ${o.appeal.note ?? ''}`}
                  </p>
                </div>
              </div>
            )}
            {o.status === 'CANCELLED' && (
              <div className="flex items-start gap-3">
                <AlertTriangle size={20} className="mt-0.5 shrink-0 text-tx-3" />
                <div>
                  <div className="font-semibold">Đơn đã huỷ</div>
                  <p className="mt-1 text-[13px] text-tx-2">
                    {o.cancelReason}. Coin đã trả về bên bán.
                    {buyer && ' Nếu bạn đã chuyển tiền, nhắn bên bán hoàn tiền hoặc liên hệ CSKH.'}
                  </p>
                </div>
              </div>
            )}

            {open && (
              <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
                {buyer && o.status === 'PENDING_PAYMENT' && (
                  <>
                    <button className="btn btn-ghost" onClick={() => setTransfer(true)}>
                      <Landmark size={15} /> Chuyển khoản
                    </button>
                    <button className="btn btn-brand" disabled={busy} onClick={() => setConfirm('paid')}>
                      Tôi đã thanh toán
                    </button>
                  </>
                )}
                {!buyer && (
                  <button className="btn btn-up" disabled={busy} onClick={() => setConfirm('release')}>
                    <ShieldCheck size={15} /> Xác nhận đã nhận tiền và nhả coin
                  </button>
                )}
                {buyer && (o.status === 'PENDING_PAYMENT' || o.status === 'PAID') && (
                  <button className="btn btn-ghost text-down" disabled={busy} onClick={() => setConfirm('cancel')}>
                    Huỷ đơn
                  </button>
                )}
                {o.status === 'PAID' && (
                  <button className="btn btn-ghost" disabled={!canAppeal || busy} onClick={() => setAppeal(true)} title={canAppeal ? '' : 'Chưa tới thời gian được khiếu nại'}>
                    <Gavel size={15} /> Khiếu nại
                  </button>
                )}
              </div>
            )}
          </section>

          {/* Thông tin đơn */}
          <section className="panel p-4">
            <h2 className="text-[14px] font-semibold">Thông tin đơn</h2>
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4">
              <div>
                <dt className="label">Số tiền</dt>
                <dd className={cn('num mt-0.5 text-[16px] font-semibold', buyer ? 'text-up' : 'text-down')}>{fmtVndNum(o.fiatAmount)} ₫</dd>
              </div>
              <div>
                <dt className="label">Giá</dt>
                <dd className="num mt-0.5">{fmtVndNum(o.price)} ₫</dd>
              </div>
              <div>
                <dt className="label">Số lượng</dt>
                <dd className="num mt-0.5">
                  {fmtCoin(o.qty)} {o.asset}
                </dd>
              </div>
              <div>
                <dt className="label">{o.role === 'MAKER' ? 'Phí thương nhân' : 'Phí'}</dt>
                <dd className="num mt-0.5">{o.role === 'MAKER' ? `${fmtCoin(o.fee)} ${o.asset}` : 'Miễn phí'}</dd>
              </div>
            </dl>
          </section>

          {/* Tài khoản nhận tiền */}
          <section className="panel p-4">
            <h2 className="text-[14px] font-semibold">{buyer ? 'Chuyển khoản tới' : 'Tài khoản nhận tiền của bạn'}</h2>
            <dl className="mt-3 space-y-2 text-[13px]">
              {[
                ['Ngân hàng', o.paymentMethod.bankName, null],
                ['Chủ tài khoản', o.paymentMethod.holderName, o.paymentMethod.holderName],
                ['Số tài khoản', o.paymentMethod.accountNo, o.paymentMethod.accountNo],
                ['Số tiền', `${fmtVndNum(o.fiatAmount)} ₫`, o.fiatAmount],
                ['Nội dung', memo, memo],
              ].map(([k, v, copy]) => (
                <div key={k} className="flex items-center justify-between gap-3">
                  <dt className="text-tx-3">{k}</dt>
                  <dd className="num flex items-center gap-1 font-medium">
                    {v}
                    {copy && <CopyButton value={copy} label={k!.toLowerCase()} />}
                  </dd>
                </div>
              ))}
            </dl>
            {o.terms && <p className="mt-3 border-t border-line pt-3 text-[12px] text-tx-2">Điều khoản của thương nhân: {o.terms}</p>}
          </section>
        </div>

        <aside className="panel flex min-h-0 flex-col overflow-hidden lg:max-h-[640px]">
          <div className="border-b border-line p-3">
            {o.role === 'TAKER' ? <TraderCell t={o.maker} /> : <div className="font-semibold">{counterparty.name}</div>}
            <div className="mt-1 text-[11px] text-tx-3">Chỉ trao đổi trong khung chat này. Không giao dịch ngoài sàn, không gửi mật khẩu hay mã xác thực.</div>
          </div>
          <OrderChat
            messages={messages}
            viewerId={me?.id ?? null}
            postPath={`/p2p/orders/${o.id}/messages`}
            onSent={() => void refetchMsgs()}
            disabled={!open && Date.now() - new Date(o.updatedAt).getTime() > 7 * 86_400_000}
          />
        </aside>
      </div>

      <TransferDialog
        open={transfer}
        preset={{ toAccountNo: o.paymentMethod.accountNo, amount: o.fiatAmount, memo, holderName: o.paymentMethod.holderName }}
        onClose={() => setTransfer(false)}
      />

      <Modal
        open={confirm != null}
        onClose={() => setConfirm(null)}
        title={confirm === 'paid' ? 'Xác nhận đã thanh toán' : confirm === 'release' ? 'Nhả coin cho người mua' : 'Huỷ đơn'}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setConfirm(null)}>
              Quay lại
            </button>
            {confirm === 'paid' && (
              <button className="btn btn-brand" disabled={busy} onClick={() => void act('paid', undefined, 'Đã báo bên bán')}>
                Tôi đã chuyển khoản
              </button>
            )}
            {confirm === 'release' && (
              <button className="btn btn-up" disabled={busy} onClick={() => void act('release', undefined, 'Đã nhả coin, đơn hoàn tất')}>
                Đã nhận đủ tiền, nhả coin
              </button>
            )}
            {confirm === 'cancel' && (
              <button className="btn btn-down" disabled={busy} onClick={() => void act('cancel', { reason: 'Người mua huỷ đơn' }, 'Đã huỷ đơn')}>
                Huỷ đơn
              </button>
            )}
          </>
        }
      >
        <p className="text-[13px] text-tx-2">
          {confirm === 'paid' &&
            `Bạn đã chuyển ${fmtVndNum(o.fiatAmount)} ₫ tới ${o.paymentMethod.holderName} (${o.paymentMethod.accountNo})? Báo thanh toán khi chưa chuyển tiền là vi phạm, tài khoản có thể bị khoá P2P.`}
          {confirm === 'release' &&
            `Nhả coin là KHÔNG hoàn tác được. Chỉ xác nhận khi sao kê ngân hàng đã có ${fmtVndNum(o.fiatAmount)} ₫ từ người mua. Đừng tin ảnh chụp màn hình chuyển khoản.`}
          {confirm === 'cancel' &&
            (o.status === 'PAID'
              ? 'Bạn đã báo thanh toán. Huỷ đơn bây giờ thì coin trả về bên bán; nếu đã chuyển tiền, bạn phải tự liên hệ bên bán để nhận lại. Vẫn huỷ?'
              : 'Huỷ quá 3 đơn trong ngày (tính cả đơn hết hạn) sẽ bị khoá P2P tới 00:00 UTC.')}
        </p>
      </Modal>

      <AppealModal open={appeal} buyer={buyer} busy={busy} onClose={() => setAppeal(false)} onSubmit={(reason, description) => void act('appeal', { reason, description }, 'Đã gửi khiếu nại')} />
    </div>
  );
}

function AppealModal({ open, buyer, busy, onClose, onSubmit }: { open: boolean; buyer: boolean; busy: boolean; onClose(): void; onSubmit(r: AppealReason, d: string): void }) {
  const reasons: AppealReason[] = buyer ? ['NOT_RELEASED', 'OTHER'] : ['NOT_RECEIVED', 'WRONG_AMOUNT', 'OTHER'];
  const [reason, setReason] = useState<AppealReason>(reasons[0]!);
  const [desc, setDesc] = useState('');
  useEffect(() => {
    if (open) {
      setReason(reasons[0]!);
      setDesc('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Khiếu nại đơn P2P"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn btn-down" disabled={busy || desc.trim().length < 10} onClick={() => onSubmit(reason, desc.trim())}>
            Gửi khiếu nại
          </button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        <p className="text-tx-2">Nhân viên sẽ xem chat và sao kê chuyển khoản giữa hai bên để phân xử. Khiếu nại sai sự thật có thể bị khoá P2P.</p>
        <label className="block">
          <span className="label">Lý do</span>
          <select className="input mt-1" value={reason} onChange={(e) => setReason(e.target.value as AppealReason)}>
            {reasons.map((r) => (
              <option key={r} value={r}>
                {APPEAL_REASON_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">Mô tả (tối thiểu 10 ký tự)</span>
          <textarea className="input mt-1 h-24 py-2" maxLength={1000} value={desc} onChange={(e) => setDesc(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}
