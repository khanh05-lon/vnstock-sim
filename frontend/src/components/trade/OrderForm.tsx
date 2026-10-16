import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Minus, Plus } from 'lucide-react';
import { toast } from 'sonner';
import {
  Big,
  RULES,
  TIF_LABEL,
  floorStep,
  validateOrder,
  type FilterError,
  type OrderType,
  type Side,
  type SymbolRow,
  type TimeInForce,
} from '@vss/shared';
import { api, errMsg } from '../../lib/api';
import { cleanDecimal, cn, decOrNull, fmtPrice, fmtQty, fmtUsd } from '../../lib/format';
import { useAccount, useFree, useInvalidateTrading, useLoggedIn } from '../../lib/queries';
import { useSymbolRow } from '../../store/market';
import { useTicket, type TicketKind } from '../../store/ui';

const KINDS: { value: TicketKind; label: string }[] = [
  { value: 'LIMIT', label: 'Giới hạn' },
  { value: 'MARKET', label: 'Thị trường' },
  { value: 'STOP_LIMIT', label: 'Stop-limit' },
  { value: 'OCO', label: 'OCO' },
];

/** Ô nhập số có nhãn bên trái và đơn vị bên phải (kiểu Binance) */
function Field({
  label,
  unit,
  value,
  onChange,
  step,
  invalid,
  disabled,
  placeholder,
}: {
  label: string;
  unit: string;
  value: string;
  onChange(v: string): void;
  step?: string;
  invalid?: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const bump = (dir: 1 | -1) => {
    if (!step) return;
    const cur = new Big(decOrNull(value) ?? 0);
    const next = cur.plus(new Big(step).times(dir));
    onChange(next.gt(0) ? floorStep(next, step) : '');
  };
  return (
    <label
      className={cn(
        'flex h-10 items-center gap-2 rounded-lg border bg-bg-3 px-3 transition-colors focus-within:border-brand',
        invalid ? 'border-down' : 'border-transparent hover:border-line-2',
        disabled && 'opacity-60',
      )}
    >
      <span className="shrink-0 text-[12px] text-tx-3">{label}</span>
      <input
        inputMode="decimal"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(cleanDecimal(e.target.value))}
        className="num min-w-0 flex-1 bg-transparent text-right text-[14px] font-medium text-tx-1 outline-none placeholder:text-tx-3"
        aria-label={label}
        aria-invalid={invalid}
      />
      <span className="shrink-0 text-[12px] text-tx-2">{unit}</span>
      {step && !disabled && (
        <span className="-mr-1 flex flex-col">
          <button type="button" onClick={() => bump(1)} className="text-tx-3 hover:text-tx-1" aria-label={`Tăng ${label}`} tabIndex={-1}>
            <Plus size={12} />
          </button>
          <button type="button" onClick={() => bump(-1)} className="text-tx-3 hover:text-tx-1" aria-label={`Giảm ${label}`} tabIndex={-1}>
            <Minus size={12} />
          </button>
        </span>
      )}
    </label>
  );
}

/** Thanh trượt tỷ lệ số dư khả dụng 0–100% với các mốc 25/50/75/100 */
function PercentSlider({ value, onChange, side, disabled }: { value: number; onChange(v: number): void; side: Side; disabled?: boolean }) {
  return (
    <div className="pt-1">
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className={cn('w-full', side === 'BUY' ? 'accent-[var(--up)]' : 'accent-[var(--down)]')}
        aria-label="Tỷ lệ số dư khả dụng"
      />
      <div className="flex justify-between">
        {[0, 25, 50, 75, 100].map((p) => (
          <button
            key={p}
            type="button"
            disabled={disabled}
            onClick={() => onChange(p)}
            className={cn('rounded px-1 text-[11px]', value === p ? 'text-tx-1' : 'text-tx-3 hover:text-tx-1')}
          >
            {p}%
          </button>
        ))}
      </div>
    </div>
  );
}

function SidePanel({ r, side, kind }: { r: SymbolRow; side: Side; kind: TicketKind }) {
  const loggedIn = useLoggedIn();
  const invalidate = useInvalidateTrading();
  const { data: account } = useAccount();
  const picked = useTicket((s) => s.picked);
  const f = r.filters;
  const base = r.baseAsset;
  const quote = r.quoteAsset;
  const free = useFree(side === 'BUY' ? quote : base);

  const [price, setPrice] = useState('');
  const [stop, setStop] = useState('');
  const [stopLimit, setStopLimit] = useState('');
  const [qty, setQty] = useState('');
  const [total, setTotal] = useState('');
  const [pct, setPct] = useState(0);
  const [tif, setTif] = useState<TimeInForce>('GTC');
  const [postOnly, setPostOnly] = useState(false);
  const [marketBy, setMarketBy] = useState<'qty' | 'total'>(side === 'BUY' ? 'total' : 'qty');
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  // Đổi cặp / loại lệnh: điền giá hiện tại, xoá khối lượng
  useEffect(() => {
    setPrice(r.last);
    setStop('');
    setStopLimit('');
    setQty('');
    setTotal('');
    setPct(0);
    setTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.symbol, kind]);

  // Bấm giá trên sổ lệnh / lịch sử khớp
  useEffect(() => {
    if (!picked || (picked.side && picked.side !== side)) return;
    if (kind === 'STOP_LIMIT') setStopLimit(picked.price);
    else setPrice(picked.price);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked?.nonce]);

  /** Giá dùng để quy đổi khối lượng ⇄ tổng tiền */
  const refPrice = kind === 'MARKET' ? r.last : kind === 'STOP_LIMIT' ? stopLimit || r.last : kind === 'OCO' && side === 'BUY' ? maxOf(price, stopLimit) : price;

  const setQtyLinked = (v: string) => {
    setQty(v);
    setPct(0);
    const p = decOrNull(refPrice);
    const q = decOrNull(v);
    setTotal(p && q ? new Big(p).times(q).round(8, Big.roundDown).toFixed() : '');
  };
  const setTotalLinked = (v: string) => {
    setTotal(v);
    setPct(0);
    const p = decOrNull(refPrice);
    const t = decOrNull(v);
    setQty(p && t ? floorStep(new Big(t).div(p), f.stepSize) : '');
  };
  const setPctLinked = (p: number) => {
    setPct(p);
    const avail = new Big(free);
    const rp = decOrNull(refPrice);
    if (side === 'BUY') {
      // Mua: chừa phần phí không cần (phí thu bằng coin nhận về)
      const t = avail.times(p).div(100).round(8, Big.roundDown);
      setTotal(t.gt(0) ? t.toFixed() : '');
      setQty(rp && t.gt(0) ? floorStep(t.div(rp), f.stepSize) : '');
    } else {
      const q = floorStep(avail.times(p).div(100), f.stepSize);
      setQty(new Big(q).gt(0) ? q : '');
      setTotal(rp && new Big(q).gt(0) ? new Big(q).times(rp).round(8, Big.roundDown).toFixed() : '');
    }
  };

  // Giá đổi → cập nhật tổng tiền theo khối lượng đang nhập
  useEffect(() => {
    if (kind === 'MARKET') return;
    const p = decOrNull(refPrice);
    const q = decOrNull(qty);
    setTotal(p && q ? new Big(p).times(q).round(8, Big.roundDown).toFixed() : total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refPrice]);

  /** Lệnh sẽ gửi lên API + lỗi kiểm tra trước (bộ lọc của cặp, số dư) */
  const plan = useMemo(() => {
    const p = decOrNull(price);
    const q = decOrNull(qty);
    const t = decOrNull(total);
    const s = decOrNull(stop);
    const sl = decOrNull(stopLimit);
    let type: OrderType = 'LIMIT';
    let body: Record<string, unknown> | null = null;
    let path = '/orders';
    let err: FilterError | { field: string; message: string } | null = null;
    let need = '0';

    if (kind === 'LIMIT') {
      type = postOnly ? 'LIMIT_MAKER' : 'LIMIT';
      if (p && q) {
        body = { symbol: r.symbol, side, type, price: p, quantity: q, ...(postOnly ? {} : { timeInForce: tif }) };
        err = validateOrder(r, { side, type, price: p, quantity: q }, r.last);
        need = side === 'BUY' ? new Big(p).times(q).toFixed() : q;
      }
    } else if (kind === 'MARKET') {
      type = 'MARKET';
      if (marketBy === 'total' && t) {
        body = { symbol: r.symbol, side, type, quoteOrderQty: t };
        err = validateOrder(r, { side, type, quoteOrderQty: t }, r.last);
        need = side === 'BUY' ? t : new Big(t).div(r.last).toFixed(8);
      } else if (marketBy === 'qty' && q) {
        body = { symbol: r.symbol, side, type, quantity: q };
        err = validateOrder(r, { side, type, quantity: q }, r.last);
        need = side === 'BUY' ? new Big(q).times(r.last).toFixed() : q;
      }
    } else if (kind === 'STOP_LIMIT') {
      if (s && sl && q) {
        // Bán: stop dưới giá hiện tại = cắt lỗ, trên giá = chốt lời; mua thì ngược lại
        const below = new Big(s).lt(r.last);
        type = side === 'SELL' ? (below ? 'STOP_LOSS_LIMIT' : 'TAKE_PROFIT_LIMIT') : below ? 'TAKE_PROFIT_LIMIT' : 'STOP_LOSS_LIMIT';
        body = { symbol: r.symbol, side, type, stopPrice: s, price: sl, quantity: q, timeInForce: 'GTC' };
        err = validateOrder(r, { side, type, stopPrice: s, price: sl, quantity: q }, r.last);
        if (!err && new Big(s).eq(r.last)) err = { field: 'stopPrice', message: 'Giá kích hoạt phải khác giá hiện tại' };
        need = side === 'BUY' ? new Big(sl).times(q).toFixed() : q;
      }
    } else if (kind === 'OCO') {
      path = '/orders/oco';
      if (p && s && sl && q) {
        body = { symbol: r.symbol, side, quantity: q, price: p, stopPrice: s, stopLimitPrice: sl };
        const okOrder = side === 'SELL' ? new Big(p).gt(r.last) && new Big(s).lt(r.last) : new Big(p).lt(r.last) && new Big(s).gt(r.last);
        err =
          validateOrder(r, { side, type: 'LIMIT_MAKER', price: p, quantity: q }, r.last) ??
          validateOrder(r, { side, type: 'STOP_LOSS_LIMIT', stopPrice: s, price: sl, quantity: q }, r.last) ??
          (okOrder
            ? null
            : {
                field: 'price',
                message: side === 'SELL' ? 'OCO bán: giá giới hạn phải cao hơn giá hiện tại, giá kích hoạt thấp hơn' : 'OCO mua: giá giới hạn phải thấp hơn giá hiện tại, giá kích hoạt cao hơn',
              });
        need = side === 'BUY' ? new Big(maxOf(p, sl)).times(q).toFixed() : q;
      }
    }
    if (body && !err && loggedIn && new Big(need).gt(free)) {
      err = { field: 'quantity', message: `Số dư ${side === 'BUY' ? quote : base} khả dụng không đủ` };
    }
    return { body, err, type, path, need };
  }, [kind, price, qty, total, stop, stopLimit, tif, postOnly, marketBy, side, r, free, loggedIn, quote, base]);

  const submit = async () => {
    setTouched(true);
    if (!plan.body || plan.err) return;
    setBusy(true);
    try {
      await api(plan.path, { method: 'POST', body: plan.body });
      if (kind !== 'MARKET') toast.success(`Đã đặt lệnh ${side === 'BUY' ? 'mua' : 'bán'} ${base}`);
      setQty('');
      setTotal('');
      setPct(0);
      setTouched(false);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
      invalidate();
    }
  };

  const feeRate = account?.takerFee ?? RULES.takerFee;
  const estFee = plan.body ? (side === 'BUY' ? new Big(decOrNull(qty) ?? 0).times(feeRate) : new Big(decOrNull(total) ?? 0).times(feeRate)) : null;
  const showErr = touched || !!plan.body;
  const isBuy = side === 'BUY';

  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-tx-3">Khả dụng</span>
        <span className="num font-medium text-tx-1">
          {loggedIn ? (isBuy ? fmtUsd(free) : fmtQty(free, f.stepSize)) : '--'} {isBuy ? quote : base}
        </span>
      </div>

      {kind === 'STOP_LIMIT' && (
        <Field label="Kích hoạt" unit={quote} value={stop} onChange={setStop} step={f.tickSize} invalid={showErr && plan.err?.field === 'stopPrice'} />
      )}
      {kind === 'OCO' && (
        <>
          <Field label="Giới hạn" unit={quote} value={price} onChange={setPrice} step={f.tickSize} invalid={showErr && plan.err?.field === 'price'} />
          <Field label="Kích hoạt" unit={quote} value={stop} onChange={setStop} step={f.tickSize} invalid={showErr && plan.err?.field === 'stopPrice'} />
        </>
      )}
      {kind === 'LIMIT' && <Field label="Giá" unit={quote} value={price} onChange={setPrice} step={f.tickSize} invalid={showErr && plan.err?.field === 'price'} />}
      {kind === 'STOP_LIMIT' && (
        <Field label="Giá đặt" unit={quote} value={stopLimit} onChange={setStopLimit} step={f.tickSize} invalid={showErr && plan.err?.field === 'price'} />
      )}
      {kind === 'OCO' && <Field label="Giá đặt khi kích hoạt" unit={quote} value={stopLimit} onChange={setStopLimit} step={f.tickSize} />}
      {kind === 'MARKET' && (
        <div className="flex h-10 items-center justify-between rounded-lg bg-bg-3/60 px-3 text-[12px] text-tx-3">
          <span>Giá</span>
          <span>Giá thị trường tốt nhất</span>
        </div>
      )}

      {kind === 'MARKET' && (
        <div className="flex gap-1 text-[12px]">
          {(['total', 'qty'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMarketBy(m);
                setQty('');
                setTotal('');
                setPct(0);
              }}
              className={cn('rounded-md px-2.5 py-1', marketBy === m ? 'bg-bg-3 text-tx-1' : 'text-tx-3 hover:text-tx-1')}
            >
              {m === 'total' ? `Theo tổng (${quote})` : `Theo số lượng (${base})`}
            </button>
          ))}
        </div>
      )}

      {(kind !== 'MARKET' || marketBy === 'qty') && (
        <Field label="Số lượng" unit={base} value={qty} onChange={setQtyLinked} step={f.stepSize} invalid={showErr && plan.err?.field === 'quantity'} />
      )}
      <PercentSlider value={pct} onChange={setPctLinked} side={side} disabled={!loggedIn} />
      {(kind !== 'MARKET' || marketBy === 'total') && (
        <Field
          label="Tổng"
          unit={quote}
          value={total}
          onChange={setTotalLinked}
          invalid={showErr && (plan.err?.field === 'quoteOrderQty' || (plan.err?.field === 'quantity' && kind === 'MARKET'))}
          placeholder={`Tối thiểu ${f.minNotional}`}
        />
      )}

      {kind === 'LIMIT' && (
        <div className="flex items-center justify-between gap-2 text-[12px]">
          <label className="flex items-center gap-1.5 text-tx-2">
            <input type="checkbox" checked={postOnly} onChange={(e) => setPostOnly(e.target.checked)} className="accent-[var(--brand)]" />
            Post-only
          </label>
          {!postOnly && (
            <select
              value={tif}
              onChange={(e) => setTif(e.target.value as TimeInForce)}
              className="h-7 rounded-md bg-bg-3 px-2 text-[12px] text-tx-2 outline-none"
              aria-label="Hiệu lực lệnh"
              title={TIF_LABEL[tif]}
            >
              {(['GTC', 'IOC', 'FOK'] as const).map((t) => (
                <option key={t} value={t}>
                  {TIF_LABEL[t]}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {kind === 'STOP_LIMIT' && decOrNull(stop) && (
        <p className="text-[11px] leading-relaxed text-tx-3">
          Khi giá {new Big(decOrNull(stop)!).lt(r.last) ? '≤' : '≥'} {fmtPrice(stop, f.tickSize)}, đặt lệnh giới hạn {isBuy ? 'mua' : 'bán'} ở giá{' '}
          {fmtPrice(stopLimit || stop, f.tickSize)} ({plan.type === 'STOP_LOSS_LIMIT' ? 'cắt lỗ' : 'chốt lời'}).
        </p>
      )}

      {showErr && plan.err && <p className="text-[12px] text-down">{plan.err.message}</p>}
      {estFee && !plan.err && (
        <div className="flex justify-between text-[11px] text-tx-3">
          <span>Phí ước tính (taker {new Big(feeRate).times(100).toFixed()}%)</span>
          <span className="num">
            ≈ {isBuy ? fmtQty(estFee.toFixed(), '0.00000001') : fmtUsd(estFee.toFixed(), 6)} {isBuy ? base : quote}
          </span>
        </div>
      )}

      {loggedIn ? (
        <button
          type="submit"
          disabled={busy || r.status !== 'TRADING'}
          className={cn('btn h-10 w-full rounded-lg text-[14px] text-white', isBuy ? 'btn-up' : 'btn-down')}
        >
          {r.status !== 'TRADING' ? 'Tạm ngừng giao dịch' : busy ? 'Đang gửi...' : `${isBuy ? 'Mua' : 'Bán'} ${base}`}
        </button>
      ) : (
        <div className="flex h-10 items-center justify-center gap-1 rounded-lg bg-bg-3 text-[13px]">
          <Link to="/login" className="font-semibold text-brand hover:underline">
            Đăng nhập
          </Link>
          <span className="text-tx-3">hoặc</span>
          <Link to="/register" className="font-semibold text-brand hover:underline">
            Đăng ký
          </Link>
        </div>
      )}
    </form>
  );
}

function maxOf(a: string, b: string): string {
  const x = decOrNull(a);
  const y = decOrNull(b);
  if (!x) return y ?? '';
  if (!y) return x;
  return new Big(x).gte(y) ? x : y;
}

/** Form đặt lệnh Spot: tab Giới hạn / Thị trường / Stop-limit / OCO, Mua và Bán song song (màn rộng) */
export function OrderForm({ symbol }: { symbol: string }) {
  const r = useSymbolRow(symbol);
  const kind = useTicket((s) => s.kind);
  const setKind = useTicket((s) => s.setKind);
  const picked = useTicket((s) => s.picked);
  const [mobileSide, setMobileSide] = useState<Side>('BUY');

  useEffect(() => {
    if (picked?.side) setMobileSide(picked.side);
  }, [picked?.nonce, picked?.side]);

  if (!r) return null;
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-4 border-b border-line px-4" role="tablist" aria-label="Loại lệnh">
        {KINDS.map((k) => (
          <button
            key={k.value}
            role="tab"
            aria-selected={kind === k.value}
            onClick={() => setKind(k.value)}
            className={cn(
              'relative h-10 text-[13px] font-medium transition-colors',
              kind === k.value ? 'text-tx-1 after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand' : 'text-tx-3 hover:text-tx-1',
            )}
          >
            {k.label}
          </button>
        ))}
      </div>

      <div className="flex gap-1 p-3 pb-0 md:hidden" role="tablist" aria-label="Chiều lệnh">
        {(['BUY', 'SELL'] as const).map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={mobileSide === s}
            onClick={() => setMobileSide(s)}
            className={cn(
              'h-9 flex-1 rounded-lg text-[14px] font-semibold',
              mobileSide === s ? (s === 'BUY' ? 'bg-up text-white' : 'bg-down text-white') : 'bg-bg-3 text-tx-2',
            )}
          >
            {s === 'BUY' ? 'Mua' : 'Bán'}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 p-4 md:grid-cols-2">
        <div className={cn(mobileSide !== 'BUY' && 'hidden md:block')}>
          <SidePanel r={r} side="BUY" kind={kind} />
        </div>
        <div className={cn(mobileSide !== 'SELL' && 'hidden md:block')}>
          <SidePanel r={r} side="SELL" kind={kind} />
        </div>
      </div>
    </div>
  );
}
