import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { P2P_ASSETS, P2P_PAY_MINUTES, P2P_RULES, adPrice, priceInBand, type P2PAdDTO, type P2PAsset, type P2PPriceType } from '@vss/shared';
import { api, errMsg } from '../../lib/api';
import { cleanDecimal, cn } from '../../lib/format';
import { fmtCoin, fmtVndNum, useInvalidateP2P, useP2PConfig, usePaymentMethods } from '../../lib/p2p';
import { useFree } from '../../lib/queries';
import { Modal } from '../common/ui';

/** Đăng / sửa quảng cáo P2P. Sửa thì không đổi chiều, coin, tổng số lượng (như Binance: đóng và đăng lại) */
export function AdForm({ open, edit, onClose }: { open: boolean; edit: P2PAdDTO | null; onClose(): void }) {
  const invalidate = useInvalidateP2P();
  const { data: config } = useP2PConfig();
  const { data: methods } = usePaymentMethods();
  const [side, setSide] = useState<'SELL' | 'BUY'>('SELL');
  const [asset, setAsset] = useState<P2PAsset>('USDT');
  const [priceType, setPriceType] = useState<P2PPriceType>('FLOATING');
  const [fixed, setFixed] = useState('');
  const [ratio, setRatio] = useState('100.50');
  const [qty, setQty] = useState('');
  const [min, setMin] = useState('500000');
  const [max, setMax] = useState('20000000');
  const [pay, setPay] = useState<number>(15);
  const [pms, setPms] = useState<number[]>([]);
  const [terms, setTerms] = useState('');
  const [days, setDays] = useState('0');
  const [busy, setBusy] = useState(false);
  const free = useFree(asset);

  useEffect(() => {
    if (!open) return;
    if (edit) {
      setSide(edit.side as 'SELL' | 'BUY');
      setAsset(edit.asset);
      setPriceType(edit.priceType);
      setFixed(edit.fixedPrice ?? '');
      setRatio(edit.floatRatio ?? '100.50');
      setQty(edit.totalQty);
      setMin(edit.minFiat);
      setMax(edit.maxFiat);
      setPay(edit.payMinutes);
      setPms(edit.paymentMethodIds ?? []);
      setTerms(edit.terms);
      setDays(String(edit.minAccountDays));
    } else {
      setPms(methods?.[0] ? [methods[0].id] : []);
      setQty('');
      setTerms('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, edit]);

  const ref = config?.refPrices[asset] ?? null;
  const price = adPrice({ priceType, fixedPrice: fixed || null, floatRatio: ratio || null }, ref);
  const errors = useMemo(() => {
    const e: string[] = [];
    if (!price) e.push('Nhập giá');
    else if (!priceInBand(price, ref)) e.push(`Giá phải trong khoảng ±${P2P_RULES.priceBandPct}% giá tham chiếu`);
    if (priceType === 'FLOATING' && !(Number(ratio) >= P2P_RULES.floatMinPct && Number(ratio) <= P2P_RULES.floatMaxPct)) {
      e.push(`Tỷ lệ thả nổi từ ${P2P_RULES.floatMinPct}% đến ${P2P_RULES.floatMaxPct}%`);
    }
    if (!edit && !(Number(qty) > 0)) e.push('Nhập tổng số lượng');
    if (!edit && side === 'SELL' && Number(qty) * (1 + Number(P2P_RULES.makerFee)) > Number(free)) e.push(`Số dư ${asset} không đủ (cần cả phí ${Number(P2P_RULES.makerFee) * 100}%)`);
    if (Number(min) < P2P_RULES.minOrderVnd) e.push(`Hạn mức tối thiểu từ ${fmtVndNum(P2P_RULES.minOrderVnd)} ₫`);
    if (Number(max) < Number(min)) e.push('Hạn mức tối đa phải ≥ tối thiểu');
    if (!pms.length) e.push('Chọn ít nhất 1 phương thức thanh toán');
    return e;
  }, [price, ref, priceType, ratio, qty, side, free, asset, min, max, pms, edit]);

  const submit = async () => {
    setBusy(true);
    try {
      const pricing = { priceType, fixedPrice: priceType === 'FIXED' ? fixed : null, floatRatio: priceType === 'FLOATING' ? Number(ratio).toFixed(2) : null };
      const common = { ...pricing, minFiat: min, maxFiat: max, payMinutes: pay, paymentMethodIds: pms, terms, minAccountDays: Number(days) || 0 };
      if (edit) await api(`/p2p/my-ads/${edit.id}`, { method: 'PATCH', body: common });
      else await api('/p2p/my-ads', { method: 'POST', body: { ...common, side, asset, totalQty: qty, online: true } });
      toast.success(edit ? 'Đã cập nhật quảng cáo' : 'Đã đăng quảng cáo');
      invalidate();
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: number) => setPms((x) => (x.includes(id) ? x.filter((y) => y !== id) : x.length >= 5 ? x : [...x, id]));

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={600}
      title={edit ? `Sửa quảng cáo #${edit.id}` : 'Đăng quảng cáo P2P'}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn btn-brand" disabled={busy || errors.length > 0} onClick={() => void submit()}>
            {edit ? 'Lưu' : 'Đăng quảng cáo'}
          </button>
        </>
      }
    >
      <div className="grid gap-3 text-[13px] sm:grid-cols-2">
        {!edit && (
          <>
            <div>
              <span className="label">Tôi muốn</span>
              <div className="mt-1 flex rounded-md bg-bg-3 p-0.5">
                {(['SELL', 'BUY'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSide(s)}
                    className={cn('h-8 flex-1 rounded font-semibold', side === s ? (s === 'SELL' ? 'bg-down text-white' : 'bg-up text-white') : 'text-tx-2')}
                  >
                    {s === 'SELL' ? 'Bán coin' : 'Mua coin'}
                  </button>
                ))}
              </div>
            </div>
            <label>
              <span className="label">Coin</span>
              <select className="input mt-1" value={asset} onChange={(e) => setAsset(e.target.value as P2PAsset)}>
                {P2P_ASSETS.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>
          </>
        )}
        <div>
          <span className="label">Loại giá</span>
          <div className="mt-1 flex rounded-md bg-bg-3 p-0.5">
            {(['FLOATING', 'FIXED'] as const).map((t) => (
              <button key={t} type="button" onClick={() => setPriceType(t)} className={cn('h-8 flex-1 rounded font-medium', priceType === t ? 'bg-bg-1 text-tx-1' : 'text-tx-3')}>
                {t === 'FLOATING' ? 'Thả nổi' : 'Cố định'}
              </button>
            ))}
          </div>
        </div>
        {priceType === 'FIXED' ? (
          <label>
            <span className="label">Giá cố định (VNĐ / {asset})</span>
            <input className="input num mt-1" inputMode="numeric" value={fixed} onChange={(e) => setFixed(cleanDecimal(e.target.value).split('.')[0]!)} />
          </label>
        ) : (
          <label>
            <span className="label">
              Tỷ lệ thả nổi (% giá tham chiếu, {P2P_RULES.floatMinPct}–{P2P_RULES.floatMaxPct})
            </span>
            <input className="input num mt-1" inputMode="decimal" value={ratio} onChange={(e) => setRatio(cleanDecimal(e.target.value))} />
          </label>
        )}
        <div className="rounded-md bg-bg-2 px-3 py-2 text-[12px] sm:col-span-2">
          <span className="text-tx-3">Giá của bạn: </span>
          <span className="num font-semibold">{price ? `${fmtVndNum(price)} ₫` : '—'}</span>
          <span className="text-tx-3"> · tham chiếu {ref ? `${fmtVndNum(ref)} ₫` : 'chưa có'}</span>
        </div>
        {!edit && (
          <label className="sm:col-span-2">
            <span className="label">
              Tổng số lượng ({asset}){side === 'SELL' && ` · khả dụng ${fmtCoin(free)}`}
            </span>
            <input className="input num mt-1" inputMode="decimal" value={qty} onChange={(e) => setQty(cleanDecimal(e.target.value))} />
            {side === 'SELL' && <span className="mt-1 block text-[11px] text-tx-3">Số coin này (kèm phí {Number(P2P_RULES.makerFee) * 100}%) bị khoá ngay khi đăng, mở khoá khi đóng quảng cáo.</span>}
          </label>
        )}
        <label>
          <span className="label">Hạn mức tối thiểu / đơn (VNĐ)</span>
          <input className="input num mt-1" inputMode="numeric" value={min} onChange={(e) => setMin(cleanDecimal(e.target.value).split('.')[0]!)} />
        </label>
        <label>
          <span className="label">Hạn mức tối đa / đơn (VNĐ)</span>
          <input className="input num mt-1" inputMode="numeric" value={max} onChange={(e) => setMax(cleanDecimal(e.target.value).split('.')[0]!)} />
        </label>
        <label>
          <span className="label">Thời hạn thanh toán</span>
          <select className="input mt-1" value={pay} onChange={(e) => setPay(Number(e.target.value))}>
            {P2P_PAY_MINUTES.map((m) => (
              <option key={m} value={m}>
                {m} phút
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Chỉ nhận tài khoản mở từ (ngày)</span>
          <input className="input num mt-1" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, '').slice(0, 3))} />
        </label>
        <div className="sm:col-span-2">
          <span className="label">Phương thức thanh toán (tối đa 5)</span>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {(methods ?? []).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => toggle(m.id)}
                className={cn('rounded-md border px-2.5 py-1 text-[12px]', pms.includes(m.id) ? 'border-brand bg-brand/10 text-tx-1' : 'border-line text-tx-2')}
              >
                {m.bankName} · {m.accountNo}
              </button>
            ))}
            {!methods?.length && <span className="text-[12px] text-down">Chưa có phương thức thanh toán — thêm ở mục bên dưới trang.</span>}
          </div>
        </div>
        <label className="sm:col-span-2">
          <span className="label">Điều khoản giao dịch (hiện cho khách)</span>
          <textarea className="input mt-1 h-20 py-2" maxLength={500} value={terms} onChange={(e) => setTerms(e.target.value)} />
        </label>
        {errors.length > 0 && (
          <ul className="space-y-0.5 text-[12px] text-down sm:col-span-2">
            {errors.map((e) => (
              <li key={e}>• {e}</li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
