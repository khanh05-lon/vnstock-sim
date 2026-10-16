import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Minus, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { GTD_MAX_DAYS, ORDER_TYPE_HINT, RULES, calcFee, calcSellTax, isValidTick, stepPrice, tickSize, type OrderDTO, type OrderType } from '@vss/shared';
import { api, errMsg } from '../../lib/api';
import { cn, fmtInt, fmtPrice, fmtVnd, parseIntInput, parsePriceInput } from '../../lib/format';
import { useBuyingPower, useInvalidateTrading, useLoggedIn, usePortfolio } from '../../lib/queries';
import { useMarket, useStock } from '../../store/market';
import { useTicket } from '../../store/ui';
import { Modal, Tabs } from '../common/ui';
import { ConditionalForm } from './ConditionalForm';

/** YYYY-MM-DD cộng n ngày */
export const addDaysISO = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

const TYPE_HINT = ORDER_TYPE_HINT;

function Stepper({
  label,
  value,
  onChange,
  onStep,
  error,
  disabled,
  placeholder,
  suffix,
  inputMode,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  onStep(dir: 1 | -1): void;
  error?: string | null;
  disabled?: boolean;
  placeholder?: string;
  suffix?: ReactNode;
  inputMode: 'decimal' | 'numeric';
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="label">{label}</span>
        {suffix}
      </div>
      <div className={cn('flex h-10 items-center rounded-md border bg-bg-3', error ? 'border-down' : 'border-transparent focus-within:border-brand')}>
        <button type="button" disabled={disabled} onClick={() => onStep(-1)} className="flex h-full w-9 items-center justify-center text-tx-3 hover:text-tx-1 disabled:opacity-30" aria-label={`Giảm ${label}`}>
          <Minus size={15} />
        </button>
        <input
          value={disabled ? '' : value}
          disabled={disabled}
          placeholder={placeholder}
          inputMode={inputMode}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              onStep(1);
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              onStep(-1);
            }
          }}
          aria-label={label}
          aria-invalid={!!error}
          className="num h-full min-w-0 flex-1 bg-transparent text-center text-[15px] font-semibold outline-none placeholder:text-[13px] placeholder:font-normal placeholder:text-tx-3"
        />
        <button type="button" disabled={disabled} onClick={() => onStep(1)} className="flex h-full w-9 items-center justify-center text-tx-3 hover:text-tx-1 disabled:opacity-30" aria-label={`Tăng ${label}`}>
          <Plus size={15} />
        </button>
      </div>
      {error && <div className="mt-1 text-[11px] text-down">{error}</div>}
    </div>
  );
}

function Line({ label, value, strong, className }: { label: ReactNode; value: ReactNode; strong?: boolean; className?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[12px]">
      <span className="text-tx-3">{label}</span>
      <span className={cn('num', strong ? 'font-semibold text-tx-1' : 'text-tx-2', className)}>{value}</span>
    </div>
  );
}

/** Khung đặt lệnh: lệnh thường hoặc lệnh điều kiện */
export function OrderForm({ symbol }: { symbol: string }) {
  const [mode, setMode] = useState<'normal' | 'conditional'>('normal');
  return (
    <div className="flex flex-col">
      <Tabs
        size="sm"
        className="px-3 pt-3"
        value={mode}
        onChange={setMode}
        items={[
          { value: 'normal', label: 'Lệnh thường' },
          { value: 'conditional', label: 'Lệnh điều kiện' },
        ]}
      />
      {mode === 'normal' ? <NormalOrderForm symbol={symbol} /> : <ConditionalForm symbol={symbol} />}
    </div>
  );
}

function NormalOrderForm({ symbol }: { symbol: string }) {
  const r = useStock(symbol);
  const mode = useMarket((s) => s.session?.mode);
  const loggedIn = useLoggedIn();
  const { data: pf } = usePortfolio();
  const invalidate = useInvalidateTrading();
  const t = useTicket();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const tradeDate = useMarket((s) => s.session?.tradeDate) ?? new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const [gtd, setGtd] = useState(false);
  const [validUntil, setValidUntil] = useState('');

  // Đổi mã → điền sẵn giá hiện tại
  useEffect(() => {
    const row = useMarket.getState().rows[symbol];
    const st = useTicket.getState();
    if (row) {
      st.setPriceText((((row.volume ? row.last : row.ref) || row.ref) / 1000).toFixed(2));
      if (!RULES.orderTypes[row.exchange].includes(st.orderType)) st.setOrderType('LO');
    }
    st.setQtyText('');
    setTouched(false);
  }, [symbol, !!r]);

  // Sức mua tính trên máy chủ: tiền mặt + ứng trước tiền bán + vay ký quỹ (theo tỷ lệ cho vay của mã)
  const bpPrice = r ? (t.orderType === 'LO' ? parsePriceInput(t.priceText) : t.side === 'BUY' ? r.ceil : r.floor) : null;
  const { data: bp } = useBuyingPower(symbol, bpPrice, t.side === 'BUY');

  if (!r) return null;
  const ex = r.exchange;
  const isBuy = t.side === 'BUY';
  const types = RULES.orderTypes[ex];
  const isLO = t.orderType === 'LO';
  const price = isLO ? parsePriceInput(t.priceText) : null;
  const qty = parseIntInput(t.qtyText);
  const marketRef = r.volume ? r.last : r.ref;
  const lot = RULES.lotSize;
  const odd = qty > 0 && qty < lot;
  const gtdOn = gtd && isLO;
  const maxValid = addDaysISO(tradeDate, GTD_MAX_DAYS);
  const until = validUntil || addDaysISO(tradeDate, 7);

  let priceErr: string | null = null;
  if (isLO && touched) {
    if (!price) priceErr = 'Vui lòng nhập giá';
    else if (!isValidTick(r, price)) priceErr = `Sai bước giá — bước giá ${fmtInt(tickSize(r, price))}đ`;
    else if (price > r.ceil) priceErr = `Vượt giá trần ${fmtPrice(r.ceil)}`;
    else if (price < r.floor) priceErr = `Thấp hơn giá sàn ${fmtPrice(r.floor)}`;
  }
  let qtyErr: string | null = null;
  if (touched) {
    if (!qty) qtyErr = 'Vui lòng nhập khối lượng';
    else if (odd && r.type === 'BOND') qtyErr = `Trái phiếu giao dịch theo lô ${lot}`;
    else if (odd && !isLO) qtyErr = 'Lô lẻ (dưới 100 CP) chỉ đặt lệnh LO';
    else if (!odd && qty % lot) qtyErr = `Lô chẵn là bội số của ${lot} — phần lẻ ${qty % lot} CP đặt thành lệnh riêng`;
    else if (qty > RULES.maxOrderQty[ex]) qtyErr = `Tối đa ${fmtInt(RULES.maxOrderQty[ex])} CP/lệnh`;
  }
  const validErr = gtdOn && touched && (until <= tradeDate || until > maxValid) ? `Chọn ngày từ ${addDaysISO(tradeDate, 1)} tới ${maxValid}` : null;

  const holdPrice = price ?? (isBuy ? r.ceil : r.floor);
  const estPrice = price ?? marketRef;
  const cashAvail = pf?.account.cashAvailable ?? 0;
  const holding = pf?.holdings.find((h) => h.symbol === symbol);
  const maxBuy =
    bp?.maxQty ?? (holdPrice > 0 ? Math.min(RULES.maxOrderQty[ex], Math.floor(cashAvail / (holdPrice * (1 + RULES.feeRate)) / RULES.lotSize) * RULES.lotSize) : 0);
  const maxSell = holding?.qtyAvailable ?? 0;
  const maxQty = isBuy ? maxBuy : Math.min(maxSell - (maxSell % RULES.lotSize), RULES.maxOrderQty[ex]);
  const oddAvail = isBuy ? 0 : maxSell % RULES.lotSize;
  const value = estPrice * qty;
  const fee = calcFee(value);
  const tax = isBuy ? 0 : calcSellTax(value);
  const total = isBuy ? value + fee : value - fee - tax;
  const overMax = loggedIn && qty > 0 && qty > maxQty;

  const stepPriceBy = (dir: 1 | -1) => {
    const base = price ?? marketRef;
    let next = isValidTick(r, base) ? stepPrice(r, base, dir) : base - (base % tickSize(r, base)) + (dir === 1 ? tickSize(r, base) : 0);
    next = Math.min(r.ceil, Math.max(r.floor, next));
    t.setPriceText((next / 1000).toFixed(2));
  };
  const stepQty = (dir: 1 | -1) => t.setQtyText(fmtInt(Math.max(0, qty - (qty % RULES.lotSize) + dir * RULES.lotSize)));
  const setPct = (pct: number) => t.setQtyText(fmtInt(Math.floor((maxQty * pct) / 100 / RULES.lotSize) * RULES.lotSize));

  const typeDisabled = (ot: OrderType) => mode === 'SIMULATED_24_7' && (ot === 'ATO' || ot === 'ATC');

  const submit = () => {
    setTouched(true);
    const pErr = isLO && (!price || !isValidTick(r, price) || price > r.ceil || price < r.floor);
    const qErr = !qty || (odd ? !isLO || r.type === 'BOND' : qty % lot !== 0) || qty > RULES.maxOrderQty[ex];
    const vErr = gtdOn && (until <= tradeDate || until > maxValid);
    if (pErr || qErr || vErr) return;
    if (overMax) {
      toast.error(isBuy ? 'Sức mua không đủ cho khối lượng này' : 'Không đủ cổ phiếu khả dụng để bán');
      return;
    }
    setConfirm(true);
  };

  const place = async () => {
    setBusy(true);
    try {
      const o = await api<OrderDTO>('/orders', {
        method: 'POST',
        body: { symbol, side: t.side, orderType: t.orderType, price: isLO ? price : null, qty, ...(gtdOn ? { validUntil: until } : {}) },
      });
      const label = `${isBuy ? 'MUA' : 'BÁN'} ${fmtInt(qty)} ${symbol}`;
      if (o.status === 'FILLED') toast.success(`Lệnh #${o.id} ${label} đã khớp toàn bộ`, { description: `Giá khớp TB ${fmtPrice(o.avgFillPrice)}` });
      else if (o.status === 'PARTIAL') toast.success(`Lệnh #${o.id} ${label} khớp ${fmtInt(o.filledQty)} CP`, { description: 'Phần còn lại đang chờ khớp' });
      else if (o.status === 'PENDING') toast.success(`Đặt lệnh #${o.id} ${label} thành công`, { description: 'Lệnh đang chờ khớp' });
      setConfirm(false);
      setTouched(false);
      t.setQtyText('');
      invalidate();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex flex-col gap-3 p-3">
      <div className="grid grid-cols-2 rounded-lg bg-bg-3 p-1" role="tablist" aria-label="Chiều lệnh">
        {(['BUY', 'SELL'] as const).map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={t.side === s}
            onClick={() => t.setSide(s)}
            className={cn(
              'h-9 rounded-md text-[14px] font-bold transition-colors',
              t.side === s ? (s === 'BUY' ? 'bg-up text-white' : 'bg-down text-white') : 'text-tx-3 hover:text-tx-1',
            )}
          >
            {s === 'BUY' ? 'MUA' : 'BÁN'}
          </button>
        ))}
      </div>

      <div>
        <div className="mb-1 label">Loại lệnh</div>
        <div className="flex gap-1">
          {/* Mỗi sàn một bộ lệnh: HOSE LO/MP/ATO/ATC, HNX LO/MTL/MOK/MAK/ATC, UPCOM chỉ LO */}
          {types.map((ot) => {
            const disabled = typeDisabled(ot);
            return (
              <button
                key={ot}
                disabled={disabled}
                onClick={() => t.setOrderType(ot)}
                title={typeDisabled(ot) ? 'Chế độ 24/7 không có phiên ATO/ATC' : TYPE_HINT[ot]}
                className={cn(
                  'h-8 flex-1 rounded-md border text-[12px] font-semibold transition-colors',
                  t.orderType === ot ? 'border-brand bg-brand/10 text-brand' : 'border-line text-tx-2 hover:border-line-2',
                  disabled && 'opacity-30',
                )}
              >
                {ot}
              </button>
            );
          })}
        </div>
        <div className="mt-1 text-[11px] text-tx-3">{TYPE_HINT[t.orderType]}</div>
      </div>

      <Stepper
        label="Giá (x1.000đ)"
        value={t.priceText}
        onChange={t.setPriceText}
        onStep={stepPriceBy}
        error={priceErr}
        disabled={!isLO}
        placeholder={isLO ? 'Nhập giá' : t.orderType}
        inputMode="decimal"
        suffix={
          <span className="num flex gap-2 text-[11px]">
            {(
              [
                ['Trần', r.ceil, 'text-ceil'],
                ['TC', r.ref, 'text-ref'],
                ['Sàn', r.floor, 'text-floor'],
              ] as const
            ).map(([l, v, c]) => (
              <button key={l} disabled={!isLO} onClick={() => t.setPriceText((v / 1000).toFixed(2))} className={cn(c, 'hover:underline disabled:opacity-40')}>
                {l} {fmtPrice(v)}
              </button>
            ))}
          </span>
        }
      />

      <Stepper
        label="Khối lượng (CP)"
        value={t.qtyText}
        onChange={(v) => t.setQtyText(v ? fmtInt(parseIntInput(v)) : '')}
        onStep={stepQty}
        error={qtyErr ?? (overMax ? (isBuy ? 'Vượt sức mua' : 'Vượt KL khả dụng') : null)}
        placeholder={`Bội số ${RULES.lotSize}`}
        inputMode="numeric"
        suffix={
          loggedIn && (
            <span className="num text-[11px] text-tx-3">
              {isBuy ? 'Mua tối đa' : 'Bán tối đa'} <b className="text-tx-1">{fmtInt(Math.max(0, maxQty))}</b>
            </span>
          )
        }
      />

      <div className="grid grid-cols-4 gap-1">
        {[25, 50, 75, 100].map((p) => (
          <button key={p} disabled={!loggedIn || maxQty <= 0} onClick={() => setPct(p)} className="h-7 rounded border border-line text-[11px] font-medium text-tx-2 hover:border-brand hover:text-brand disabled:opacity-30">
            {p === 100 ? 'Tối đa' : `${p}%`}
          </button>
        ))}
      </div>

      {(odd || oddAvail > 0) && (
        <div className="rounded-md border border-info/30 bg-info/10 px-2.5 py-1.5 text-[11px] text-info">
          {odd ? (
            <>Lô lẻ: chỉ lệnh LO, khớp trên bảng lô lẻ riêng (không theo sổ lệnh lô chẵn).</>
          ) : (
            <>
              Bạn có {fmtInt(oddAvail)} CP lô lẻ —{' '}
              <button
                className="font-semibold underline-offset-2 hover:underline"
                onClick={() => {
                  t.setOrderType('LO');
                  t.setQtyText(fmtInt(oddAvail));
                }}
              >
                bán phần lẻ
              </button>
            </>
          )}
        </div>
      )}

      {isLO && (
        <div className="flex items-center gap-2 text-[12px]">
          <span className="label">Hiệu lực</span>
          <select className="input h-8 w-32" value={gtd ? 'GTD' : 'DAY'} onChange={(e) => setGtd(e.target.value === 'GTD')} aria-label="Hiệu lực lệnh">
            <option value="DAY">Trong ngày</option>
            <option value="GTD">Nhiều ngày</option>
          </select>
          {gtd && (
            <input
              type="date"
              className={cn('input h-8 min-w-0 flex-1', validErr && 'border-down')}
              min={addDaysISO(tradeDate, 1)}
              max={maxValid}
              value={until}
              onChange={(e) => setValidUntil(e.target.value)}
              aria-label="Hiệu lực đến ngày"
              title={validErr ?? 'Lệnh chưa khớp được chuyển sang phiên sau tới hết ngày này (giá phải nằm trong biên độ phiên mới)'}
            />
          )}
        </div>
      )}

      <div className="space-y-1.5 rounded-md bg-bg-2 p-2.5">
        {loggedIn &&
          (isBuy ? (
            <>
              <Line label="Tiền mặt khả dụng" value={`${fmtVnd(cashAvail)}đ`} />
              {!!pf?.account.advanceable && pf.account.autoAdvance && <Line label="Có thể ứng trước" value={`${fmtVnd(pf.account.advanceable)}đ`} />}
              {pf?.account.marginEnabled && (
                <Line
                  label={`Vay ký quỹ (mã cho vay ${Math.round((r.marginRatio ?? 0) * 100)}%)`}
                  value={bp?.usesMargin ? `tới ${fmtVnd(bp.loanPart)}đ` : r.marginRatio ? 'sẵn sàng' : 'không cho vay'}
                />
              )}
            </>
          ) : (
            <Line label="KL khả dụng" value={`${fmtInt(maxSell)} CP${holding?.qtyPending ? ` (+${fmtInt(holding.qtyPending)} chờ về)` : ''}`} />
          ))}
        <Line label={`Giá trị lệnh${isLO ? '' : ' (ước tính)'}`} value={`${fmtVnd(value)}đ`} />
        <Line label={`Phí giao dịch (${(RULES.feeRate * 100).toFixed(2)}%)`} value={`${fmtVnd(fee)}đ`} />
        {!isBuy && <Line label={`Thuế TNCN (${(RULES.sellTaxRate * 100).toFixed(1)}%)`} value={`${fmtVnd(tax)}đ`} />}
        <div className="h-px bg-line" />
        <Line label={isBuy ? 'Tổng thanh toán' : 'Thực nhận ước tính'} value={`${fmtVnd(total)}đ`} strong className={isBuy ? 'text-up' : 'text-down'} />
      </div>

      {loggedIn ? (
        <button onClick={submit} className={cn('btn h-11 text-[15px]', isBuy ? 'btn-up' : 'btn-down')}>
          {isBuy ? 'Mua' : 'Bán'} {symbol}
        </button>
      ) : (
        <div className="rounded-md border border-dashed border-line-2 p-3 text-center">
          <div className="text-tx-2">Đăng nhập để giao dịch với 1 tỷ đồng vốn ảo</div>
          <div className="mt-2 flex justify-center gap-2">
            <Link to="/login" state={{ from: `/trade/${symbol}` }} className="btn btn-ghost h-8">
              Đăng nhập
            </Link>
            <Link to="/register" className="btn btn-brand h-8">
              Đăng ký
            </Link>
          </div>
        </div>
      )}

      <Modal
        open={confirm}
        onClose={() => !busy && setConfirm(false)}
        title="Xác nhận đặt lệnh"
        width={400}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setConfirm(false)} disabled={busy}>
              Huỷ
            </button>
            <button className={cn('btn min-w-32', isBuy ? 'btn-up' : 'btn-down')} onClick={() => void place()} disabled={busy}>
              {busy ? 'Đang gửi…' : `Xác nhận ${isBuy ? 'MUA' : 'BÁN'}`}
            </button>
          </>
        }
      >
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className={cn('chip text-white', isBuy ? 'bg-up' : 'bg-down')}>{isBuy ? 'MUA' : 'BÁN'}</span>
            <span className="text-[18px] font-bold">{symbol}</span>
            <span className="chip bg-bg-3 text-tx-2">{ex}</span>
          </div>
          <Line label="Loại lệnh" value={t.orderType} strong />
          <Line label="Giá đặt" value={isLO ? `${fmtVnd(price)}đ` : `${t.orderType} (giá thị trường)`} strong />
          <Line label="Khối lượng" value={`${fmtInt(qty)} CP${odd ? ' (lô lẻ)' : ''}`} strong />
          <Line label="Hiệu lực" value={gtdOn ? `Đến hết ${until.slice(8, 10)}/${until.slice(5, 7)}/${until.slice(0, 4)}` : 'Trong ngày'} />
          <Line label="Giá trị (ước tính)" value={`${fmtVnd(value)}đ`} />
          <Line label="Phí + thuế (ước tính)" value={`${fmtVnd(fee + tax)}đ`} />
          <Line label={isBuy ? 'Tổng thanh toán' : 'Thực nhận'} value={`${fmtVnd(total)}đ`} strong />
          {isBuy && !isLO && <p className="pt-1 text-[11px] text-tx-3">Lệnh {t.orderType} phong toả tạm tiền theo giá trần, phần dư được hoàn lại sau khi khớp.</p>}
        </div>
      </Modal>
    </div>
  );
}
