import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, CheckCircle2, CircleX, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { BANK_NAMES, MERCHANT_STATUS_LABEL, P2P_RULES, type BankName, type P2PAdDTO } from '@vss/shared';
import { CoinIcon } from '../components/common/CoinIcon';
import { Empty, Modal, Spinner, Stat } from '../components/common/ui';
import { AdForm } from '../components/p2p/AdForm';
import { P2PNav } from '../components/p2p/common';
import { api, errMsg } from '../lib/api';
import { cn, fmtDateTime } from '../lib/format';
import { fmtCoin, fmtDuration, fmtRate, fmtVndNum, useInvalidateP2P, useMyAds, useMyMerchant, usePaymentMethods } from '../lib/p2p';
import { useAuth } from '../store/auth';

/** Trung tâm thương nhân: điều kiện & nộp đơn, quảng cáo của tôi, phương thức thanh toán */
export default function MerchantCenterPage() {
  const user = useAuth((s) => s.user);
  const { data: me, isLoading } = useMyMerchant();
  const active = me?.status === 'ACTIVE' || me?.status === 'SUSPENDED';
  const { data: ads } = useMyAds(active);
  const invalidate = useInvalidateP2P();
  const [form, setForm] = useState<{ edit: P2PAdDTO | null } | null>(null);
  const [confirm, setConfirm] = useState<'apply' | 'resign' | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = 'Trung tâm thương nhân · VNCoin';
    return () => void (document.title = 'VNCoin · Sàn giao dịch coin mô phỏng');
  }, []);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      invalidate();
      setConfirm(null);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (user?.role && user.role !== 'USER') {
    return <Empty title="Tài khoản nhân viên không dùng được P2P" hint="Tránh xung đột lợi ích khi xử lý khiếu nại. Duyệt thương nhân ở Quản trị → Thương nhân P2P." />;
  }
  if (isLoading || !me) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const deposit = Number(P2P_RULES.merchantDepositUsdt).toLocaleString('vi-VN');
  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-[26px] font-bold tracking-tight">Trung tâm thương nhân</h1>
        <P2PNav />
      </div>

      {/* Trạng thái */}
      <section className="mt-5 rounded-xl border border-line bg-bg-1 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              {me.status === 'ACTIVE' && <BadgeCheck size={20} className="text-brand" />}
              <span className="text-[17px] font-semibold">{me.status ? MERCHANT_STATUS_LABEL[me.status] : 'Chưa là thương nhân'}</span>
            </div>
            <p className="mt-1 max-w-[70ch] text-[13px] text-tx-2">
              {me.status === 'ACTIVE' && 'Bạn được đăng quảng cáo mua / bán trên chợ P2P. Giữ tỷ lệ hoàn tất cao và nhả coin nhanh để giữ huy hiệu.'}
              {me.status === 'PENDING' && `Đơn nộp lúc ${fmtDateTime(me.appliedAt!)} đang chờ bộ phận Rủi ro & giám sát duyệt. Tiền cọc ${deposit} USDT đã được khoá.`}
              {me.status === 'SUSPENDED' && `Tư cách thương nhân đang bị tạm ngừng${me.note ? `: ${me.note}` : ''}. Quảng cáo đã chuyển offline, đơn đang chạy vẫn xử lý bình thường.`}
              {me.status === 'REJECTED' && `Đơn bị từ chối${me.note ? `: ${me.note}` : ''}. Tiền cọc đã trả lại. Bạn có thể nộp lại khi đủ điều kiện.`}
              {(me.status == null || me.status === 'RESIGNED') &&
                `Thương nhân là khách hàng được sàn xác minh, đăng quảng cáo mua bán coin lấy VNĐ. Cần đặt cọc ${deposit} USDT (trả lại khi nghỉ).`}
            </p>
          </div>
          <div className="flex gap-2">
            {(me.status == null || me.status === 'REJECTED' || me.status === 'RESIGNED') && (
              <button className="btn btn-brand" disabled={!me.eligible || busy} onClick={() => setConfirm('apply')}>
                Nộp đơn làm thương nhân
              </button>
            )}
            {me.status === 'PENDING' && (
              <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirm('resign')}>
                Rút đơn
              </button>
            )}
            {me.status === 'ACTIVE' && (
              <>
                <button className="btn btn-brand" onClick={() => setForm({ edit: null })}>
                  <Plus size={15} /> Đăng quảng cáo
                </button>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirm('resign')}>
                  Nghỉ thương nhân
                </button>
              </>
            )}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4 sm:grid-cols-5">
          <Stat label="Đơn hoàn tất 30 ngày" value={me.stats.orders30d} />
          <Stat label="Tỷ lệ hoàn tất 30 ngày" value={fmtRate(me.stats.completionRate30d)} />
          <Stat label="Nhả coin trung bình" value={fmtDuration(me.stats.avgReleaseSec)} />
          <Stat label="Thanh toán trung bình" value={fmtDuration(me.stats.avgPaySec)} />
          <Stat label="Tiền cọc" value={`${fmtCoin(me.depositUsdt)} USDT`} />
        </div>
      </section>

      {/* Điều kiện */}
      {(me.status == null || me.status === 'REJECTED' || me.status === 'RESIGNED') && (
        <section className="mt-4 panel p-5">
          <h2 className="text-[15px] font-semibold">Điều kiện trở thành thương nhân</h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {me.requirements.map((r) => (
              <li key={r.key} className="flex items-start gap-2 text-[13px]">
                {r.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-up" /> : <CircleX size={16} className="mt-0.5 shrink-0 text-down" />}
                <div>
                  <div>{r.label}</div>
                  <div className="text-[12px] text-tx-3">{r.detail}</div>
                </div>
              </li>
            ))}
          </ul>
          {!me.eligible && (
            <p className="mt-3 text-[12px] text-tx-3">
              Chưa đủ số đơn? <Link to="/p2p" className="text-brand hover:underline">Giao dịch P2P với thương nhân hiện có</Link>. Bật 2FA ở Cài đặt tài khoản → Bảo mật.
            </p>
          )}
        </section>
      )}

      {/* Quảng cáo */}
      {active && (
        <section className="mt-4 panel overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-[15px] font-semibold">Quảng cáo của tôi</h2>
            <span className="text-[12px] text-tx-3">Tối đa {P2P_RULES.maxOpenAds} quảng cáo đang mở</span>
          </div>
          {!ads?.length ? (
            <Empty title="Chưa có quảng cáo" hint="Đăng quảng cáo bán hoặc mua coin để khách đặt đơn." />
          ) : (
            <div className="overflow-x-auto">
              <table className="tbl w-full min-w-[820px] text-[13px]">
                <thead>
                  <tr className="text-left">
                    <th className="px-4 py-2.5">Quảng cáo</th>
                    <th className="px-4 py-2.5 text-right">Giá</th>
                    <th className="px-4 py-2.5 text-right">Còn lại / Tổng</th>
                    <th className="px-4 py-2.5 text-right">Hạn mức</th>
                    <th className="px-4 py-2.5">Trạng thái</th>
                    <th className="px-4 py-2.5 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {ads.map((a) => (
                    <AdRow key={a.id} ad={a} busy={busy} onEdit={() => setForm({ edit: a })} run={run} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <PaymentMethods />

      <AdForm open={!!form} edit={form?.edit ?? null} onClose={() => setForm(null)} />
      <Modal
        open={confirm != null}
        onClose={() => setConfirm(null)}
        title={confirm === 'apply' ? 'Nộp đơn làm thương nhân' : me.status === 'PENDING' ? 'Rút đơn' : 'Nghỉ làm thương nhân'}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setConfirm(null)}>
              Quay lại
            </button>
            {confirm === 'apply' ? (
              <button className="btn btn-brand" disabled={busy} onClick={() => void run(() => api('/p2p/merchant/apply', { method: 'POST' }), 'Đã nộp đơn, chờ duyệt')}>
                Khoá {deposit} USDT và nộp đơn
              </button>
            ) : (
              <button className="btn btn-down" disabled={busy} onClick={() => void run(() => api('/p2p/merchant/resign', { method: 'POST' }), 'Đã trả tiền cọc')}>
                Xác nhận
              </button>
            )}
          </>
        }
      >
        <p className="text-[13px] text-tx-2">
          {confirm === 'apply'
            ? `${deposit} USDT khả dụng sẽ bị khoá làm tiền cọc. Sàn có thể trừ cọc để bồi thường khách nếu bạn vi phạm khi giao dịch (vd. đã nhận tiền mà không nhả coin).`
            : 'Mọi quảng cáo sẽ bị đóng và tiền cọc được mở khoá. Phải hoàn tất các đơn đang xử lý trước.'}
        </p>
      </Modal>
    </div>
  );
}

function AdRow({ ad, busy, onEdit, run }: { ad: P2PAdDTO; busy: boolean; onEdit(): void; run(fn: () => Promise<unknown>, ok: string): Promise<void> }) {
  const closed = ad.status === 'CLOSED';
  return (
    <tr className={cn('border-t border-line', closed && 'opacity-60')}>
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className={cn('font-semibold', ad.side === 'SELL' ? 'text-down' : 'text-up')}>{ad.side === 'SELL' ? 'Bán' : 'Mua'}</span>
          <CoinIcon asset={ad.asset} size={16} />
          {ad.asset}
          <span className="text-[11px] text-tx-3">#{ad.id}</span>
        </div>
        <div className="text-[11px] text-tx-3">
          {ad.priceType === 'FLOATING' ? `Thả nổi ${ad.floatRatio}%` : 'Giá cố định'} · {ad.banks.join(', ')} · {ad.payMinutes} phút
        </div>
      </td>
      <td className="num px-4 py-2.5 text-right">{fmtVndNum(ad.price)}</td>
      <td className="num px-4 py-2.5 text-right">
        {fmtCoin(ad.availableQty)} / {fmtCoin(ad.totalQty)}
      </td>
      <td className="num px-4 py-2.5 text-right">
        {fmtVndNum(ad.minFiat)} – {fmtVndNum(ad.maxFiat)}
      </td>
      <td className="px-4 py-2.5">
        <span className={cn('chip', ad.status === 'ONLINE' ? 'bg-up/15 text-up' : ad.status === 'OFFLINE' ? 'bg-ref/15 text-ref' : 'bg-bg-3 text-tx-3')}>
          {ad.status === 'ONLINE' ? 'Đang hiển thị' : ad.status === 'OFFLINE' ? 'Tạm ẩn' : 'Đã đóng'}
        </span>
      </td>
      <td className="px-4 py-2.5 text-right">
        {!closed && (
          <div className="flex justify-end gap-1">
            <button
              className="btn btn-ghost h-7 px-2 text-[12px]"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api(`/p2p/my-ads/${ad.id}/online`, { method: 'POST', body: { online: ad.status !== 'ONLINE' } }),
                  ad.status === 'ONLINE' ? 'Đã tạm ẩn quảng cáo' : 'Quảng cáo đã hiển thị',
                )
              }
            >
              {ad.status === 'ONLINE' ? 'Ẩn' : 'Hiện'}
            </button>
            <button className="btn btn-ghost h-7 px-2" onClick={onEdit} aria-label="Sửa quảng cáo">
              <Pencil size={13} />
            </button>
            <button className="btn btn-ghost h-7 px-2 text-down" disabled={busy} onClick={() => void run(() => api(`/p2p/my-ads/${ad.id}`, { method: 'DELETE' }), 'Đã đóng quảng cáo')} aria-label="Đóng quảng cáo">
              <Trash2 size={13} />
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

/** Tài khoản nhận tiền: nhãn ngân hàng + tài khoản ngân hàng giả lập của chính bạn */
function PaymentMethods() {
  const user = useAuth((s) => s.user);
  const { data } = usePaymentMethods();
  const invalidate = useInvalidateP2P();
  const [bank, setBank] = useState<BankName>('Vietcombank');
  const [holder, setHolder] = useState(user?.fullName ?? '');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    try {
      await api('/p2p/payment-methods', { method: 'POST', body: { bankName: bank, holderName: holder } });
      toast.success('Đã thêm phương thức thanh toán');
      invalidate();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: number) => {
    try {
      await api(`/p2p/payment-methods/${id}`, { method: 'DELETE' });
      invalidate();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  return (
    <section id="thanh-toan" className="mt-4 scroll-mt-20 panel p-5">
      <h2 className="text-[15px] font-semibold">Phương thức thanh toán</h2>
      <p className="mt-1 text-[12px] text-tx-3">
        Tài khoản nhận tiền khi bạn bán coin. Mọi phương thức đều nhận vào <Link to="/ngan-hang" className="text-brand hover:underline">tài khoản ngân hàng giả lập</Link> của bạn; tên
        ngân hàng là nhãn để khách lọc quảng cáo.
      </p>
      <ul className="mt-3 divide-y divide-line">
        {(data ?? []).map((m) => (
          <li key={m.id} className="flex items-center justify-between gap-3 py-2 text-[13px]">
            <span>
              <b>{m.bankName}</b> · <span className="num">{m.accountNo}</span> · {m.holderName}
            </span>
            <button className="rounded p-1 text-tx-3 hover:bg-bg-3 hover:text-down" onClick={() => void remove(m.id)} aria-label="Xoá phương thức">
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <select className="input w-auto" value={bank} onChange={(e) => setBank(e.target.value as BankName)} aria-label="Ngân hàng">
          {BANK_NAMES.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
        <input className="input w-64" placeholder="Tên chủ tài khoản" value={holder} onChange={(e) => setHolder(e.target.value)} aria-label="Tên chủ tài khoản" />
        <button className="btn btn-ghost" disabled={busy || holder.trim().length < 2} onClick={() => void add()}>
          <Plus size={15} /> Thêm
        </button>
      </div>
    </section>
  );
}
