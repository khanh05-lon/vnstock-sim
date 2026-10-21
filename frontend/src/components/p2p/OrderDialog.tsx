import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Big, fiatForQty, qtyForFiat, validateP2POrderAmount, type P2PAdDTO, type P2POrderDTO } from '@vss/shared';
import { api, errMsg } from '../../lib/api';
import { cleanDecimal, cn } from '../../lib/format';
import { fmtCoin, fmtVndNum, useInvalidateP2P, usePaymentMethods } from '../../lib/p2p';
import { useFree } from '../../lib/queries';
import { useAuth } from '../../store/auth';
import { Modal } from '../common/ui';
import { TraderCell } from './common';

/**
 * Đặt đơn vào 1 quảng cáo. `ad.side` theo góc nhìn thương nhân: SELL → khách mua (trả VNĐ), BUY → khách bán (giao coin).
 * Nhập theo VNĐ hoặc theo số coin; kiểm tra hạn mức ngay khi nhập bằng hàm dùng chung với máy chủ.
 */
export function OrderDialog({ ad, onClose }: { ad: P2PAdDTO | null; onClose(): void }) {
  return <Modal open={!!ad} onClose={onClose} title={ad ? `${ad.side === 'SELL' ? 'Mua' : 'Bán'} ${ad.asset}` : ''} width={520}>{ad && <Body ad={ad} onClose={onClose} />}</Modal>;
}

function Body({ ad, onClose }: { ad: P2PAdDTO; onClose(): void }) {
  const kycLevel = useAuth((s) => s.user?.kycLevel ?? 0);
  if (!kycLevel) {
    return (
      <div className="space-y-3 text-[13px]">
        <p className="text-tx-2">Giao dịch P2P cần xác minh danh tính (KYC cấp 1), như quy định chống rửa tiền của các sàn thật.</p>
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose}>
            Để sau
          </button>
          <Link to="/xac-minh" className="btn btn-brand" onClick={onClose}>
            Xác minh danh tính
          </Link>
        </div>
      </div>
    );
  }
  return <OrderForm ad={ad} onClose={onClose} />;
}

function OrderForm({ ad, onClose }: { ad: P2PAdDTO; onClose(): void }) {
  const nav = useNavigate();
  const invalidate = useInvalidateP2P();
  const takerBuys = ad.side === 'SELL';
  const [mode, setMode] = useState<'fiat' | 'qty'>('fiat');
  const [value, setValue] = useState('');
  const [pmId, setPmId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const free = useFree(ad.asset);
  const { data: methods } = usePaymentMethods();
  const usable = (methods ?? []).filter((m) => ad.banks.includes(m.bankName));
  const price = ad.price ?? '0';

  const calc = useMemo(() => {
    const v = cleanDecimal(value).replace(/\.$/, '');
    if (!v || Number(v) <= 0) return null;
    const fiat = mode === 'fiat' ? String(Math.floor(Number(v))) : fiatForQty(v, price);
    const qty = mode === 'fiat' ? qtyForFiat(fiat, price, ad.asset) : v;
    const err =
      validateP2POrderAmount(fiat, qty, { minFiat: ad.limitMin, maxFiat: ad.limitMax, availableQty: ad.availableQty }, price) ??
      (!takerBuys && new Big(qty).gt(free || '0') ? `Số dư ${ad.asset} khả dụng không đủ (${fmtCoin(free || '0')})` : null);
    return { fiat, qty, err };
  }, [value, mode, price, ad, takerBuys, free]);

  const submit = async () => {
    if (!calc || calc.err) return;
    const methodId = takerBuys ? undefined : (pmId ?? usable[0]?.id);
    if (!takerBuys && !methodId) {
      toast.error('Thêm tài khoản nhận tiền thuộc ngân hàng quảng cáo chấp nhận');
      return;
    }
    setBusy(true);
    try {
      const o = await api<P2POrderDTO>('/p2p/orders', {
        method: 'POST',
        body: { adId: ad.id, ...(mode === 'fiat' ? { fiatAmount: calc.fiat } : { qty: calc.qty }), ...(methodId && { paymentMethodId: methodId }) },
      });
      invalidate();
      onClose();
      nav(`/p2p/don/${o.id}`);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 text-[13px]">
      <div className="rounded-lg bg-bg-2 p-3">
        <TraderCell t={ad.merchant} />
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
          <dt className="text-tx-3">Giá</dt>
          <dd className={cn('num text-right font-semibold', takerBuys ? 'text-up' : 'text-down')}>{fmtVndNum(price)} ₫</dd>
          <dt className="text-tx-3">Khả dụng</dt>
          <dd className="num text-right">
            {fmtCoin(ad.availableQty)} {ad.asset}
          </dd>
          <dt className="text-tx-3">Hạn mức</dt>
          <dd className="num text-right">
            {fmtVndNum(ad.limitMin)} – {fmtVndNum(ad.limitMax)} ₫
          </dd>
          <dt className="text-tx-3">Thời hạn thanh toán</dt>
          <dd className="text-right">{ad.payMinutes} phút</dd>
          <dt className="text-tx-3">Ngân hàng</dt>
          <dd className="text-right">{ad.banks.join(', ')}</dd>
        </dl>
        {ad.terms && <p className="mt-3 border-t border-line pt-2 text-[12px] text-tx-2">Điều khoản của thương nhân: {ad.terms}</p>}
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="label">{takerBuys ? 'Tôi muốn trả' : 'Tôi muốn bán'}</span>
          <div className="flex gap-1">
            {(['fiat', 'qty'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m);
                  setValue('');
                }}
                className={cn('sel-line h-6 px-2 text-[11px] font-medium [--sel-inset:0.5rem]', mode === m ? 'is-active text-tx-1' : 'text-tx-3 hover:text-tx-1')}
              >
                Theo {m === 'fiat' ? 'VNĐ' : ad.asset}
              </button>
            ))}
          </div>
        </div>
        <div className="relative">
          <input
            autoFocus
            inputMode="decimal"
            className="input num h-11 pr-28 text-[15px]"
            placeholder={mode === 'fiat' ? `${fmtVndNum(ad.limitMin)} – ${fmtVndNum(ad.limitMax)}` : '0'}
            value={value}
            aria-invalid={!!calc?.err}
            onChange={(e) => setValue(cleanDecimal(e.target.value))}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-2">
            <button
              type="button"
              className="text-[12px] font-semibold text-brand"
              onClick={() => {
                if (mode === 'fiat') setValue(ad.limitMax);
                else setValue(takerBuys ? qtyForFiat(ad.limitMax, price, ad.asset) : new Big(free || '0').lt(qtyForFiat(ad.limitMax, price, ad.asset)) ? free || '0' : qtyForFiat(ad.limitMax, price, ad.asset));
              }}
            >
              Tối đa
            </button>
            <span className="text-tx-3">{mode === 'fiat' ? 'VNĐ' : ad.asset}</span>
          </div>
        </div>
        {calc?.err && <p className="mt-1 text-[12px] text-down">{calc.err}</p>}
        <div className="mt-2 flex justify-between text-[12px]">
          <span className="text-tx-3">{takerBuys ? 'Tôi sẽ nhận' : 'Tôi sẽ nhận (VNĐ)'}</span>
          <span className="num font-semibold">
            {calc ? (takerBuys ? (mode === 'fiat' ? `${fmtCoin(calc.qty)} ${ad.asset}` : `trả ${fmtVndNum(calc.fiat)} ₫`) : `${fmtVndNum(calc.fiat)} ₫`) : '—'}
          </span>
        </div>
        {!takerBuys && (
          <div className="mt-1 flex justify-between text-[12px]">
            <span className="text-tx-3">Khả dụng</span>
            <span className="num">
              {fmtCoin(free || '0')} {ad.asset}
            </span>
          </div>
        )}
      </div>

      {!takerBuys && (
        <div>
          <span className="label">Tài khoản nhận tiền của bạn</span>
          {usable.length ? (
            <select className="input mt-1.5" value={pmId ?? usable[0]!.id} onChange={(e) => setPmId(Number(e.target.value))}>
              {usable.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.bankName} · {m.accountNo} · {m.holderName}
                </option>
              ))}
            </select>
          ) : (
            <p className="mt-1.5 rounded-md bg-ref/10 px-3 py-2 text-[12px] text-ref">
              Quảng cáo chỉ thanh toán qua {ad.banks.join(', ')}.{' '}
              <Link to="/p2p/thuong-nhan#thanh-toan" className="font-semibold underline" onClick={onClose}>
                Thêm phương thức thanh toán
              </Link>
            </p>
          )}
        </div>
      )}

      <p className="text-[11px] text-tx-3">
        {takerBuys
          ? `Sau khi đặt, ${ad.asset} của thương nhân được sàn giữ ký quỹ. Bạn có ${ad.payMinutes} phút để chuyển khoản và bấm "Tôi đã thanh toán". Khách huỷ quá 3 đơn / ngày bị khoá P2P tới 00:00 UTC.`
          : `Sau khi đặt, ${ad.asset} của bạn được sàn giữ ký quỹ. Chỉ nhả coin khi đã thấy đủ tiền về tài khoản ngân hàng.`}
      </p>
      <div className="flex justify-end gap-2">
        <button className="btn btn-ghost" onClick={onClose}>
          Huỷ
        </button>
        <button className={cn('btn', takerBuys ? 'btn-up' : 'btn-down')} disabled={!calc || !!calc.err || busy} onClick={() => void submit()}>
          {takerBuys ? `Mua ${ad.asset}` : `Bán ${ad.asset}`}
        </button>
      </div>
    </div>
  );
}
