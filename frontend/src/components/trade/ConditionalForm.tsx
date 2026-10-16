import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { CONDITIONAL_MAX_DAYS, RULES, isValidTick, tickSize, type ConditionalKind, type ConditionalOrderDTO, type Side } from '@vss/shared';
import { api, errMsg } from '../../lib/api';
import { cn, fmtInt, fmtPrice, fmtVnd, parseIntInput, parsePriceInput } from '../../lib/format';
import { useInvalidateTrading, useLoggedIn, usePortfolio } from '../../lib/queries';
import { useMarket, useStock } from '../../store/market';

type Preset = 'STOP_LOSS' | 'TAKE_PROFIT' | 'OCO' | 'TRAILING' | 'BUY_STOP' | 'BUY_DIP';

const PRESETS: Record<Preset, { label: string; side: Side; kind: ConditionalKind; hint: string }> = {
  STOP_LOSS: { label: 'Cắt lỗ', side: 'SELL', kind: 'STOP', hint: 'Bán khi giá khớp giảm xuống bằng hoặc thấp hơn giá kích hoạt — hạn chế thua lỗ.' },
  TAKE_PROFIT: { label: 'Chốt lời', side: 'SELL', kind: 'LIMIT_IF_TOUCHED', hint: 'Bán khi giá khớp tăng lên bằng hoặc cao hơn giá kích hoạt — khoá lợi nhuận.' },
  OCO: { label: 'Chốt lời + cắt lỗ', side: 'SELL', kind: 'STOP', hint: 'Cặp OCO: đặt cùng lúc 2 ngưỡng, 1 lệnh kích hoạt thì lệnh còn lại tự huỷ.' },
  TRAILING: { label: 'Trailing stop', side: 'SELL', kind: 'TRAILING', hint: 'Ngưỡng cắt lỗ tự dời lên theo giá cao nhất; bán khi giá giảm X% từ đỉnh.' },
  BUY_STOP: { label: 'Mua khi vượt', side: 'BUY', kind: 'STOP', hint: 'Mua khi giá khớp tăng vượt giá kích hoạt (mua theo xu hướng / phá đỉnh).' },
  BUY_DIP: { label: 'Mua khi giảm về', side: 'BUY', kind: 'LIMIT_IF_TOUCHED', hint: 'Mua khi giá khớp giảm về bằng hoặc thấp hơn giá kích hoạt.' },
};

const addDaysISO = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

function PriceField({ label, value, onChange, error, placeholder }: { label: string; value: string; onChange(v: string): void; error?: string | null; placeholder?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input className={cn('input num mt-1 h-9', error && 'border-down')} inputMode="decimal" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      {error && <span className="mt-0.5 block text-[11px] text-down">{error}</span>}
    </label>
  );
}

export function ConditionalForm({ symbol }: { symbol: string }) {
  const r = useStock(symbol);
  const loggedIn = useLoggedIn();
  const { data: pf } = usePortfolio();
  const invalidate = useInvalidateTrading();
  const tradeDate = useMarket((s) => s.session?.tradeDate) ?? new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const [preset, setPreset] = useState<Preset>('STOP_LOSS');
  const [trigger, setTrigger] = useState('');
  const [trail, setTrail] = useState('5');
  const [market, setMarket] = useState(true);
  const [limit, setLimit] = useState('');
  const [tp, setTp] = useState('');
  const [qtyText, setQtyText] = useState('');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  const p = PRESETS[preset];
  const holding = pf?.holdings.find((h) => h.symbol === symbol);
  const cur = r ? (r.volume ? r.last : r.ref) : 0;

  // Đổi mã / kiểu lệnh → gợi ý ngưỡng ±5% quanh giá hiện tại, KL = số đang nắm giữ (lệnh bán)
  useEffect(() => {
    if (!r || !cur) return;
    const step = (pct: number) => {
      const raw = cur * (1 + pct / 100);
      const t = tickSize(r, raw);
      return ((Math.round(raw / t) * t) / 1000).toFixed(2);
    };
    const below = step(-5);
    const above = step(5);
    setTrigger(p.kind === 'STOP' ? (p.side === 'SELL' ? below : above) : p.side === 'SELL' ? above : below);
    setTp(step(8));
    setLimit('');
    if (p.side === 'SELL' && holding) setQtyText(fmtInt(holding.qtyTotal));
    setTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, preset, !!r]);

  if (!r) return null;
  const qty = parseIntInput(qtyText);
  const trig = parsePriceInput(trigger);
  const lim = parsePriceInput(limit);
  const tpPrice = parsePriceInput(tp);
  const trailPct = Number(trail.replace(',', '.'));
  const validUntil = until || addDaysISO(tradeDate, 7);
  const maxDate = addDaysISO(tradeDate, CONDITIONAL_MAX_DAYS);

  const tickErr = (v: number | null) => (v && !isValidTick(r, v) ? `Bước giá ${fmtInt(tickSize(r, v))}đ` : null);
  const errs: Record<string, string | null> = {
    trigger: p.kind !== 'TRAILING' ? (!trig ? 'Nhập giá kích hoạt' : tickErr(trig)) : null,
    trail: p.kind === 'TRAILING' && !(trailPct >= 0.5 && trailPct <= 50) ? 'Từ 0,5% đến 50%' : null,
    limit: !market ? (!lim ? 'Nhập giá đặt' : tickErr(lim)) : null,
    tp: preset === 'OCO' ? (!tpPrice ? 'Nhập giá chốt lời' : tickErr(tpPrice)) : null,
    qty: !qty ? 'Nhập khối lượng' : qty >= RULES.lotSize && qty % RULES.lotSize ? `Bội số ${RULES.lotSize} hoặc lô lẻ dưới ${RULES.lotSize}` : null,
    until: validUntil < tradeDate || validUntil > maxDate ? `Tối đa ${CONDITIONAL_MAX_DAYS} ngày` : null,
  };
  const hasErr = Object.values(errs).some(Boolean);
  const show = (k: string) => (touched ? errs[k] : null);
  const est = (market ? (p.side === 'BUY' ? r.ceil : trig ?? cur) : lim ?? 0) * qty;

  const submit = async () => {
    setTouched(true);
    if (hasErr) return;
    setBusy(true);
    try {
      const rows = await api<ConditionalOrderDTO[]>('/conditional-orders', {
        method: 'POST',
        body: {
          symbol,
          side: p.side,
          qty,
          validUntil,
          kind: p.kind,
          triggerPrice: p.kind === 'TRAILING' ? null : trig,
          trailPct: p.kind === 'TRAILING' ? trailPct : null,
          orderType: market ? 'MARKET' : 'LO',
          limitPrice: market ? null : lim,
          takeProfit: preset === 'OCO' ? { triggerPrice: tpPrice, orderType: 'MARKET' } : null,
        },
      });
      toast.success(`Đã đặt ${p.label.toLowerCase()} ${symbol}`, { description: `${rows.length} lệnh điều kiện đang chờ kích hoạt, hiệu lực tới ${validUntil.split('-').reverse().join('/')}` });
      setTouched(false);
      invalidate();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="grid grid-cols-3 gap-1">
        {(Object.keys(PRESETS) as Preset[]).map((k) => (
          <button
            key={k}
            onClick={() => setPreset(k)}
            className={cn(
              'h-8 rounded-md border px-1 text-[11.5px] font-semibold transition-colors',
              preset === k ? (PRESETS[k].side === 'BUY' ? 'border-up bg-up/10 text-up' : 'border-down bg-down/10 text-down') : 'border-line text-tx-2 hover:border-line-2',
            )}
          >
            {PRESETS[k].label}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-tx-3">
        {p.hint} Giá hiện tại <b className="num text-tx-1">{fmtPrice(cur)}</b>.
      </p>

      {p.kind === 'TRAILING' ? (
        <label className="block">
          <span className="label">Biên trailing (% giảm từ đỉnh)</span>
          <input className={cn('input num mt-1 h-9', show('trail') && 'border-down')} inputMode="decimal" value={trail} onChange={(e) => setTrail(e.target.value)} />
          {show('trail') ? (
            <span className="text-[11px] text-down">{show('trail')}</span>
          ) : (
            <span className="text-[11px] text-tx-3">Ngưỡng bán hiện tại ≈ {fmtPrice(Math.round(cur * (1 - (trailPct || 0) / 100)))}</span>
          )}
        </label>
      ) : (
        <PriceField label={preset === 'OCO' ? 'Giá cắt lỗ (x1.000đ)' : 'Giá kích hoạt (x1.000đ)'} value={trigger} onChange={setTrigger} error={show('trigger')} />
      )}
      {preset === 'OCO' && <PriceField label="Giá chốt lời (x1.000đ)" value={tp} onChange={setTp} error={show('tp')} />}

      <div>
        <span className="label">Khi kích hoạt đặt lệnh</span>
        <div className="mt-1 grid grid-cols-2 gap-1">
          {[true, false].map((m) => (
            <button
              key={String(m)}
              onClick={() => setMarket(m)}
              className={cn('h-8 rounded-md border text-[12px] font-semibold', market === m ? 'border-brand bg-brand/10 text-brand' : 'border-line text-tx-2')}
            >
              {m ? 'Giá thị trường' : 'Giá giới hạn (LO)'}
            </button>
          ))}
        </div>
        <span className="mt-1 block text-[11px] text-tx-3">
          {market ? (r.exchange === 'UPCOM' ? 'UPCOM không có MP: đặt LO giá trần (mua) / giá sàn (bán) để khớp ngay.' : 'Lệnh MP khớp ngay với giá tốt nhất.') : 'Lệnh LO tại giá bạn chọn (tự giới hạn trong trần/sàn của phiên).'}
        </span>
      </div>
      {!market && <PriceField label="Giá đặt (x1.000đ)" value={limit} onChange={setLimit} error={show('limit')} />}

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="label">Khối lượng</span>
          <input className={cn('input num mt-1 h-9', show('qty') && 'border-down')} value={qtyText} onChange={(e) => setQtyText(e.target.value ? fmtInt(parseIntInput(e.target.value)) : '')} />
          {show('qty') ? (
            <span className="text-[11px] text-down">{show('qty')}</span>
          ) : (
            p.side === 'SELL' && <span className="text-[11px] text-tx-3">Đang nắm giữ {fmtInt(holding?.qtyTotal ?? 0)}</span>
          )}
        </label>
        <label className="block">
          <span className="label">Hiệu lực đến</span>
          <input type="date" className={cn('input mt-1 h-9', show('until') && 'border-down')} min={tradeDate} max={maxDate} value={validUntil} onChange={(e) => setUntil(e.target.value)} />
        </label>
      </div>

      <div className="rounded-md bg-bg-2 p-2.5 text-[12px] text-tx-2">
        Giá trị ước tính khi kích hoạt: <b className="num text-tx-1">{fmtVnd(est)}đ</b>. Sức mua / cổ phiếu được kiểm tra lúc kích hoạt; thiếu thì lệnh điều kiện báo lỗi và không đặt.
      </div>

      {loggedIn ? (
        <button className={cn('btn h-10', p.side === 'BUY' ? 'btn-up' : 'btn-down')} disabled={busy} onClick={() => void submit()}>
          {busy ? 'Đang gửi…' : `Đặt ${p.label.toLowerCase()} ${symbol}`}
        </button>
      ) : (
        <Link to="/login" state={{ from: `/trade/${symbol}` }} className="btn btn-ghost h-10">
          Đăng nhập để đặt lệnh điều kiện
        </Link>
      )}
    </div>
  );
}
