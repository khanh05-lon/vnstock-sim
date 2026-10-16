import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bell, BellRing, X } from 'lucide-react';
import { MAX_ACTIVE_ALERTS, PRICE_ALERT_LABEL, PRICE_ALERT_STATUS_LABEL, type PriceAlertDTO, type PriceAlertKind } from '@vss/shared';
import { errMsg } from '../../lib/api';
import { cleanDecimal, cn, decOrNull, fmtPrice } from '../../lib/format';
import { useAlertActions, useAlerts, useLoggedIn } from '../../lib/queries';
import { useMarket, useSymbolRow } from '../../store/market';
import { Empty, Modal, Spinner } from '../common/ui';

const KINDS: PriceAlertKind[] = ['PRICE_ABOVE', 'PRICE_BELOW', 'CHANGE_UP', 'CHANGE_DOWN'];

/** "Giá ≥ 82,000.00", "Tăng 24h ≥ 3.5%" */
export function describeAlert(a: Pick<PriceAlertDTO, 'kind' | 'value'>, tick?: string): string {
  if (a.kind === 'PRICE_ABOVE') return `Giá ≥ ${fmtPrice(a.value, tick)}`;
  if (a.kind === 'PRICE_BELOW') return `Giá ≤ ${fmtPrice(a.value, tick)}`;
  if (a.kind === 'CHANGE_UP') return `Tăng 24h ≥ ${a.value}%`;
  return `Giảm 24h ≥ ${a.value}%`;
}

const STATUS_STYLE: Record<PriceAlertDTO['status'], string> = {
  ACTIVE: 'bg-brand/15 text-brand',
  TRIGGERED: 'bg-up/15 text-up',
  CANCELLED: 'bg-bg-3 text-tx-3',
};

const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '--';

/** Nút chuông trên header mã: mở hộp tạo cảnh báo giá */
export function AlertButton({ symbol }: { symbol: string }) {
  const loggedIn = useLoggedIn();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const { data } = useAlerts(symbol);
  const active = (data ?? []).filter((a) => a.status === 'ACTIVE').length;
  return (
    <>
      <button
        onClick={() => (loggedIn ? setOpen(true) : nav('/login', { state: { from: `/trade/${symbol}` } }))}
        className={cn('relative rounded p-1', active ? 'text-brand' : 'text-tx-3 hover:text-tx-1')}
        aria-label={`Cảnh báo giá ${symbol}`}
        title={active ? `${active} cảnh báo đang theo dõi` : 'Tạo cảnh báo giá'}
      >
        {active ? <BellRing size={18} /> : <Bell size={18} />}
        {active > 0 && <span className="absolute -right-0.5 -top-0.5 rounded-full bg-brand px-1 text-[9px] font-bold leading-[14px] text-white">{active}</span>}
      </button>
      {open && <AlertModal symbol={symbol} onClose={() => setOpen(false)} />}
    </>
  );
}

function AlertModal({ symbol, onClose }: { symbol: string; onClose(): void }) {
  const r = useSymbolRow(symbol);
  const { data, isLoading } = useAlerts(symbol);
  const { create, cancel } = useAlertActions();
  const [kind, setKind] = useState<PriceAlertKind>('PRICE_ABOVE');
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [email, setEmail] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const isPrice = kind === 'PRICE_ABOVE' || kind === 'PRICE_BELOW';
  const value = decOrNull(text);
  const tick = r?.filters.tickSize;

  const submit = async () => {
    setErr('');
    if (!value) {
      setErr(isPrice ? 'Nhập giá' : 'Nhập phần trăm (vd 3.5)');
      return;
    }
    setBusy(true);
    try {
      await create({ symbol, kind, value, note: note.trim() || undefined, notifyEmail: email });
      setText('');
      setNote('');
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const list = data ?? [];
  return (
    <Modal open onClose={onClose} title={`Cảnh báo giá ${r ? `${r.baseAsset}/${r.quoteAsset}` : symbol}`} width={520}>
      <div className="space-y-3">
        {r && (
          <div className="flex gap-4 rounded-md bg-bg-2 px-3 py-2 text-[12px] text-tx-2">
            <span>
              Giá hiện tại <b className="num text-tx-1">{fmtPrice(r.last, tick)}</b>
            </span>
            <span>
              Thay đổi 24h <b className={r.changePct >= 0 ? 'text-up' : 'text-down'}>{r.changePct.toFixed(2)}%</b>
            </span>
          </div>
        )}
        <div className="grid grid-cols-[1fr_140px] gap-2">
          <label className="block">
            <span className="label mb-1 block">Điều kiện</span>
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as PriceAlertKind);
                setText('');
                setErr('');
              }}
              className="input h-9 w-full"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {PRICE_ALERT_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label mb-1 block">{isPrice ? `Giá (${r?.quoteAsset ?? 'USDT'})` : 'Phần trăm (%)'}</span>
            <input
              value={text}
              onChange={(e) => setText(cleanDecimal(e.target.value))}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
              inputMode="decimal"
              placeholder={isPrice ? r?.last : '3.5'}
              className="input h-9 w-full text-right"
              aria-label="Giá trị cảnh báo"
            />
          </label>
        </div>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={100} placeholder="Ghi chú (tuỳ chọn), vd: vùng chốt lời" className="input h-9 w-full" />
        <label className="flex items-center gap-2 text-[13px] text-tx-2">
          <input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} />
          Gửi thêm email khi cảnh báo kích hoạt
        </label>
        {err && <div className="rounded-md bg-down/10 px-3 py-2 text-[12px] text-down">{err}</div>}
        <button onClick={() => void submit()} disabled={busy} className="btn btn-brand h-9 w-full">
          {busy ? 'Đang tạo…' : 'Tạo cảnh báo'}
        </button>
        <p className="text-[11px] text-tx-3">
          Cảnh báo báo 1 lần rồi dừng (thông báo trong ứng dụng{email ? ' + email' : ''}). Tối đa {MAX_ACTIVE_ALERTS} cảnh báo đang theo dõi.
        </p>

        <div className="border-t border-line pt-3">
          <div className="label mb-2">Cảnh báo của cặp {symbol}</div>
          {isLoading ? (
            <Spinner />
          ) : !list.length ? (
            <div className="text-[12px] text-tx-3">Chưa có cảnh báo nào.</div>
          ) : (
            <ul className="max-h-48 space-y-1 overflow-auto">
              {list.map((a) => (
                <li key={a.id} className="flex items-center gap-2 rounded-md bg-bg-2 px-3 py-1.5 text-[12px]">
                  <span className="num font-medium">{describeAlert(a, tick)}</span>
                  {a.note && <span className="truncate text-tx-3">· {a.note}</span>}
                  <span className={cn('chip ml-auto h-5 text-[10px]', STATUS_STYLE[a.status])}>{PRICE_ALERT_STATUS_LABEL[a.status]}</span>
                  {a.status === 'ACTIVE' && (
                    <button onClick={() => void cancel(a.id)} className="rounded p-0.5 text-tx-3 hover:text-down" aria-label={`Huỷ cảnh báo ${describeAlert(a)}`}>
                      <X size={14} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Bảng mọi cảnh báo giá của người dùng (tab trong khu sổ lệnh) */
export function AlertsTable() {
  const { data, isLoading } = useAlerts();
  const { cancel } = useAlertActions();
  const rows = useMarket((s) => s.rows);
  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }
  const list = data ?? [];
  if (!list.length) return <Empty title="Chưa có cảnh báo giá" hint="Bấm biểu tượng chuông cạnh tên cặp để tạo cảnh báo theo giá hoặc % thay đổi 24h." />;
  return (
    <table className="tbl w-full text-[12px]">
      <thead>
        <tr className="h-8 text-left text-tx-3">
          <th className="px-3">Cặp</th>
          <th className="px-3">Điều kiện</th>
          <th className="px-3">Ghi chú</th>
          <th className="px-3">Email</th>
          <th className="px-3">Trạng thái</th>
          <th className="px-3 text-right">Giá lúc báo</th>
          <th className="px-3">Thời gian</th>
          <th className="px-3" />
        </tr>
      </thead>
      <tbody>
        {list.map((a) => (
          <tr key={a.id} className="h-8 border-t border-line">
            <td className="px-3 font-semibold">
              <Link to={`/trade/${a.symbol}`} className="hover:text-brand">
                {a.symbol}
              </Link>
            </td>
            <td className="num px-3">{describeAlert(a, rows[a.symbol]?.filters.tickSize)}</td>
            <td className="max-w-[180px] truncate px-3 text-tx-3">{a.note ?? ''}</td>
            <td className="px-3 text-tx-3">{a.notifyEmail ? 'Có' : '--'}</td>
            <td className="px-3">
              <span className={cn('chip h-5 text-[10px]', STATUS_STYLE[a.status])}>{PRICE_ALERT_STATUS_LABEL[a.status]}</span>
            </td>
            <td className="num px-3 text-right">{a.triggeredPrice ? fmtPrice(a.triggeredPrice, rows[a.symbol]?.filters.tickSize) : '--'}</td>
            <td className="px-3 text-tx-3">{fmtTime(a.triggeredAt ?? a.createdAt)}</td>
            <td className="px-3 text-right">
              {a.status === 'ACTIVE' && (
                <button onClick={() => void cancel(a.id)} className="rounded p-1 text-tx-3 hover:bg-bg-3 hover:text-down" aria-label={`Huỷ cảnh báo ${a.symbol}`} title="Huỷ cảnh báo">
                  <X size={14} />
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
