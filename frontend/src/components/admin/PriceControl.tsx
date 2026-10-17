import { useEffect, useMemo, useState } from 'react';
import { History, Search } from 'lucide-react';
import {
  Big,
  PRICE_ACTION_LABEL,
  PRICE_DEFAULT_VOLATILITY_PCT,
  PRICE_LARGE_MOVE_PCT,
  PRICE_MAX_VOLATILITY_PCT,
  PRICE_MODE_LABEL,
  type AdminPriceRow,
  type PriceHistoryItem,
} from '@vss/shared';
import { useAdminAction, useAdminPrices, usePriceHistory } from '../../lib/admin';
import { cn, fmtDateTime, fmtPct, fmtPrice, signTone, toneText } from '../../lib/format';
import { CoinIcon } from '../common/CoinIcon';
import { Empty, Modal, Spinner } from '../common/ui';
import { Kpi, Pill, ReasonModal, Section } from './adminUi';

const DURATIONS: [number, string][] = [
  [0, 'Ngay lập tức'],
  [1, '1 phút'],
  [5, '5 phút'],
  [15, '15 phút'],
  [30, '30 phút'],
  [60, '1 giờ'],
  [240, '4 giờ'],
  [1440, '24 giờ'],
];

const pctOf = (from: string | null, to: string) => (from && Number(from) > 0 ? Number(new Big(to).minus(from).div(from).times(100).toFixed(2)) : null);

const minutesLeft = (endAt: number) => Math.max(0, Math.ceil((endAt - Date.now()) / 60_000));

/** Kịch bản đang chạy / đang giữ giá của cặp giá điều chỉnh */
function ScenarioCell({ r }: { r: AdminPriceRow }) {
  const c = r.control;
  if (!c) return <span className="text-tx-3">—</span>;
  const running = c.progress < 1;
  return (
    <div className="min-w-0 text-[12px]" title={`Lý do: ${c.reason}\nNgười đặt: ${c.by}`}>
      {running ? (
        <>
          <div>
            → <b>{fmtPrice(c.to, r.tickSize)}</b> · còn {minutesLeft(c.endAt)} phút
          </div>
          <div className="mt-1 h-1 w-28 overflow-hidden rounded bg-bg-3">
            <div className="h-full bg-brand" style={{ width: `${Math.round(c.progress * 100)}%` }} />
          </div>
        </>
      ) : (
        <div>
          Giữ quanh <b>{fmtPrice(c.to, r.tickSize)}</b>
        </div>
      )}
      <div className="mt-0.5 truncate text-tx-3">
        ±{c.volatilityPct}% · {c.by}
      </div>
    </div>
  );
}

/** Đặt giá ngay hoặc chạy kịch bản tới giá đích (cặp giá thực tế sẽ tự chuyển sang giá điều chỉnh) */
function SetPriceModal({ row, onClose }: { row: AdminPriceRow | null; onClose(): void }) {
  const act = useAdminAction();
  const [price, setPrice] = useState('');
  const [duration, setDuration] = useState(0);
  const [vol, setVol] = useState(String(PRICE_DEFAULT_VOLATILITY_PCT));
  const [reason, setReason] = useState('');
  const [confirmLarge, setConfirmLarge] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!row) return;
    setPrice(row.control?.to ?? row.last ?? '');
    setDuration(0);
    setVol(String(row.control?.volatilityPct ?? PRICE_DEFAULT_VOLATILITY_PCT));
    setReason('');
    setConfirmLarge(false);
  }, [row]);

  if (!row) return null;
  const valid = /^\d+(\.\d+)?$/.test(price.trim()) && Number(price) > 0;
  const volNum = Number(vol);
  const volOk = vol.trim() !== '' && volNum >= 0 && volNum <= PRICE_MAX_VOLATILITY_PCT;
  const change = valid ? pctOf(row.last, price.trim()) : null;
  const vsBinance = valid ? pctOf(row.ref, price.trim()) : null;
  const large = change != null && Math.abs(change) > PRICE_LARGE_MOVE_PCT;
  const ok = valid && volOk && reason.trim().length >= 3 && (!large || confirmLarge);

  const nudge = (pct: number) => {
    if (!row.last) return;
    const tick = Number(row.tickSize);
    const v = Math.max(tick, Math.round((Number(row.last) * (1 + pct / 100)) / tick) * tick);
    setPrice(new Big(v.toFixed(12)).toFixed());
  };

  const submit = async () => {
    setBusy(true);
    const r = await act(
      `/admin/prices/${row.symbol}/set`,
      'POST',
      { price: price.trim(), durationMin: duration, volatilityPct: volNum, reason: reason.trim() },
      duration ? `Đã bắt đầu kịch bản giá ${row.symbol}` : `Đã đặt giá ${row.symbol}`,
    );
    setBusy(false);
    if (r) onClose();
  };

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title={`Đặt giá ${row.baseAsset}/${row.quoteAsset}`}
      width={520}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Huỷ
          </button>
          <button className="btn btn-brand min-w-28" disabled={!ok || busy} onClick={() => void submit()}>
            {busy ? 'Đang xử lý…' : duration ? 'Chạy kịch bản' : 'Đặt giá'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 rounded-lg bg-bg-2 p-3 text-[13px]">
          <div>
            <div className="text-tx-3">Giá trên sàn</div>
            <div className="num font-semibold">{fmtPrice(row.last, row.tickSize)}</div>
          </div>
          <div>
            <div className="text-tx-3">Giá Binance</div>
            <div className="num font-semibold">{row.ref ? fmtPrice(row.ref, row.tickSize) : '—'}</div>
          </div>
        </div>

        <label className="block">
          <span className="label">Giá đích (bước giá {row.tickSize})</span>
          <input className="input num mt-1 h-9" value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value.replace(',', '.'))} />
        </label>
        <div className="flex flex-wrap gap-1.5">
          {[-10, -5, -1, 1, 5, 10].map((p) => (
            <button key={p} type="button" className={cn('btn h-7 px-2 text-[12px]', p < 0 ? 'btn-ghost text-down' : 'btn-ghost text-up')} onClick={() => nudge(p)}>
              {p > 0 ? '+' : ''}
              {p}%
            </button>
          ))}
          {row.ref && (
            <button type="button" className="btn btn-ghost h-7 px-2 text-[12px]" onClick={() => setPrice(row.ref!)}>
              = Giá Binance
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="label">Thời gian chạy tới giá đích</span>
            <select className="input mt-1 h-9 w-full" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {DURATIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Dao động ngẫu nhiên (± %, 0 = đứng yên)</span>
            <input className="input num mt-1 h-9" value={vol} inputMode="decimal" onChange={(e) => setVol(e.target.value.replace(',', '.'))} />
          </label>
        </div>

        {valid && change != null && (
          <div className="rounded-lg border border-line px-3 py-2 text-[13px]">
            Từ <b className="num">{fmtPrice(row.last, row.tickSize)}</b> → <b className="num">{fmtPrice(price, row.tickSize)}</b>{' '}
            <span className={toneText[signTone(change)]}>({fmtPct(change)})</span> {duration ? `trong ${DURATIONS.find((d) => d[0] === duration)?.[1]}` : 'ngay lập tức'}
            {volOk && volNum > 0 ? `, dao động ±${volNum}%` : ''}.
            {vsBinance != null && <div className="mt-0.5 text-[12px] text-tx-3">So với giá Binance: {fmtPct(vsBinance)}</div>}
          </div>
        )}
        {large && (
          <label className="flex items-start gap-2 rounded-lg bg-down/10 px-3 py-2 text-[13px] text-down">
            <input type="checkbox" className="mt-0.5" checked={confirmLarge} onChange={(e) => setConfirmLarge(e.target.checked)} />
            Thay đổi trên {PRICE_LARGE_MOVE_PCT}%: lệnh dừng và lệnh giới hạn của nhà đầu tư có thể bị khớp hàng loạt. Tôi xác nhận.
          </label>
        )}

        <label className="block">
          <span className="label">Lý do (ghi vào nhật ký quản trị, tối thiểu 3 ký tự)</span>
          <textarea className="input mt-1 h-16 resize-none py-2" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
        </label>
        <p className="text-[12px] text-tx-3">
          Lệnh của nhà đầu tư khớp theo giá này. Nhà đầu tư thấy nhãn "Giá điều chỉnh" trên bảng giá và trang giao dịch. Bấm "Về giá thực tế" bất cứ lúc nào để quay
          lại giá Binance.
        </p>
      </div>
    </Modal>
  );
}

function historyText(h: PriceHistoryItem, tick: string): string {
  const d = h.detail as Record<string, string | number | boolean | null>;
  const p = (v: unknown) => (v == null ? '—' : fmtPrice(String(v), tick));
  if (h.action === 'PRICE_SET') {
    const dur = Number(d.durationMin);
    return `${p(d.from)} → ${p(d.to)}${d.changePct != null ? ` (${fmtPct(Number(d.changePct))})` : ''} ${dur ? `trong ${dur} phút` : 'ngay lập tức'}, dao động ±${d.volatilityPct}%${d.enteredManual ? ' · chuyển từ giá thực tế' : ''}`;
  }
  if (h.action === 'PRICE_MODE_MANUAL') return `Giữ giá ${p(d.price)} (Binance ${p(d.binancePrice)})`;
  if (h.action === 'PRICE_MODE_LIVE') return `Giá điều chỉnh ${p(d.manualPrice)} → giá Binance ${p(d.binancePrice)} · đã điều chỉnh ${d.manualMinutes} phút`;
  return '';
}

function HistoryModal({ row, onClose }: { row: AdminPriceRow | null; onClose(): void }) {
  const { data, isLoading } = usePriceHistory(row?.symbol ?? null);
  if (!row) return null;
  return (
    <Modal open onClose={onClose} title={`Lịch sử chỉnh giá ${row.baseAsset}/${row.quoteAsset}`} width={640}>
      {isLoading ? (
        <Spinner className="m-6" />
      ) : !data?.length ? (
        <Empty title="Chưa có lần chỉnh giá nào" />
      ) : (
        <ul className="divide-y divide-line text-[13px]">
          {data.map((h) => (
            <li key={h.id} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                <b>{PRICE_ACTION_LABEL[h.action] ?? h.action}</b>
                <span className="text-tx-3">
                  {fmtDateTime(h.createdAt)} · {h.adminEmail}
                </span>
              </div>
              <div className="num mt-0.5">{historyText(h, row.tickSize)}</div>
              {typeof h.detail.reason === 'string' && <div className="mt-0.5 text-tx-2">Lý do: {h.detail.reason}</div>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/** Quản trị giá từng cặp: giá thực tế (Binance) hoặc giá điều chỉnh */
export function PriceControl() {
  const { data, isLoading } = useAdminPrices();
  const act = useAdminAction();
  const [q, setQ] = useState('');
  const [onlyManual, setOnlyManual] = useState(false);
  const [setting, setSetting] = useState<AdminPriceRow | null>(null);
  const [history, setHistory] = useState<AdminPriceRow | null>(null);
  const [mode, setMode] = useState<{ r: AdminPriceRow; to: 'MANUAL' | 'LIVE' } | null>(null);

  const rows = useMemo(() => {
    const term = q.trim().toUpperCase();
    return (data ?? []).filter((r) => (!onlyManual || r.mode === 'MANUAL') && (!term || r.symbol.includes(term) || r.name.toUpperCase().includes(term)));
  }, [data, q, onlyManual]);
  const manual = (data ?? []).filter((r) => r.mode === 'MANUAL').length;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="Cặp dùng giá thực tế" value={(data?.length ?? 0) - manual} sub="Bám giá Binance" />
        <Kpi label="Cặp dùng giá điều chỉnh" value={manual} tone={manual ? 'text-ref' : undefined} sub="Sàn tự sinh giá theo kịch bản" />
        <Kpi label="Nhật ký" value="Chỉ ghi thêm" sub="Mỗi lần chỉnh giá: người chỉnh, lý do, giá trước / sau" />
      </div>
      <Section
        title="Giá thị trường"
        pad={false}
        actions={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[12px] text-tx-2">
              <input type="checkbox" checked={onlyManual} onChange={(e) => setOnlyManual(e.target.checked)} />
              Chỉ cặp đang điều chỉnh
            </label>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-tx-3" />
              <input className="input h-8 w-40 pl-8" placeholder="Tìm cặp" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
        }
      >
        <p className="border-b border-line px-4 py-2 text-[12px] text-tx-3">
          <b className="text-tx-2">Giá thực tế:</b> giá, sổ lệnh, giao dịch lấy từ Binance. <b className="text-tx-2">Giá điều chỉnh:</b> sàn tự sinh giá theo giá / kịch bản quản
          trị viên đặt (bỏ qua Binance), lệnh của nhà đầu tư khớp theo giá này. Mọi thay đổi bắt buộc lý do và được ghi vào nhật ký quản trị.
        </p>
        {isLoading ? (
          <Spinner className="m-6" />
        ) : !rows.length ? (
          <Empty title={onlyManual ? 'Không có cặp nào đang dùng giá điều chỉnh' : 'Không tìm thấy cặp'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-[13px]">
              <thead className="whitespace-nowrap text-left text-[12px] text-tx-3">
                <tr>
                  <th className="px-4 py-2 font-medium">Cặp</th>
                  <th className="py-2 font-medium">Chế độ</th>
                  <th className="py-2 text-right font-medium">Giá trên sàn</th>
                  <th className="py-2 pl-4 text-right font-medium">Giá Binance</th>
                  <th className="py-2 pl-4 text-right font-medium">Chênh lệch</th>
                  <th className="py-2 pl-6 font-medium">Kịch bản</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.symbol} className={cn('border-t border-line', r.mode === 'MANUAL' && 'bg-ref/5')}>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <CoinIcon asset={r.baseAsset} size={22} />
                        <div>
                          <div className="font-semibold">
                            {r.baseAsset}
                            <span className="font-normal text-tx-3">/{r.quoteAsset}</span>
                          </div>
                          {r.status !== 'TRADING' && <div className="text-[11px] text-down">Tạm ngừng — giá đứng yên</div>}
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap" title={PRICE_MODE_LABEL[r.mode]}>
                      {r.mode === 'MANUAL' ? <Pill tone="warn">Điều chỉnh</Pill> : <Pill tone="good">Thực tế</Pill>}
                    </td>
                    <td className="num text-right font-medium">{fmtPrice(r.last, r.tickSize)}</td>
                    <td className="num pl-4 text-right text-tx-2">{r.ref ? fmtPrice(r.ref, r.tickSize) : '—'}</td>
                    <td className={cn('num pl-4 text-right', r.diffPct == null ? 'text-tx-3' : Math.abs(r.diffPct) >= 0.5 ? toneText[signTone(r.diffPct)] : 'text-tx-2')}>
                      {r.diffPct == null ? '—' : fmtPct(r.diffPct)}
                    </td>
                    <td className="max-w-[220px] py-2 pl-6">
                      <ScenarioCell r={r} />
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-1.5">
                        <button className="btn btn-brand h-7 px-2.5 text-[12px]" onClick={() => setSetting(r)}>
                          {r.mode === 'MANUAL' ? 'Đặt giá / kịch bản' : 'Đặt giá'}
                        </button>
                        {r.mode === 'MANUAL' ? (
                          <button className="btn btn-ghost h-7 px-2.5 text-[12px]" onClick={() => setMode({ r, to: 'LIVE' })}>
                            Về giá thực tế
                          </button>
                        ) : (
                          <button className="btn btn-ghost h-7 px-2.5 text-[12px]" onClick={() => setMode({ r, to: 'MANUAL' })}>
                            Chuyển sang điều chỉnh
                          </button>
                        )}
                        <button className="btn btn-ghost h-7 px-2" onClick={() => setHistory(r)} aria-label={`Lịch sử chỉnh giá ${r.symbol}`} title="Lịch sử chỉnh giá">
                          <History size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <SetPriceModal row={setting} onClose={() => setSetting(null)} />
      <HistoryModal row={history} onClose={() => setHistory(null)} />
      <ReasonModal
        open={!!mode}
        title={mode?.to === 'LIVE' ? `Về giá thực tế ${mode.r.symbol}` : `Chuyển ${mode?.r.symbol ?? ''} sang giá điều chỉnh`}
        description={
          mode?.to === 'LIVE'
            ? 'Giá trên sàn quay lại giá Binance ngay (có thể chênh so với giá điều chỉnh hiện tại): lệnh dừng / giới hạn của nhà đầu tư có thể được khớp theo giá mới.'
            : 'Sàn giữ nguyên giá hiện tại và tự sinh giá quanh mức đó (dao động mặc định ±0,2%), không theo Binance nữa. Sau đó dùng "Đặt giá / kịch bản" để điều chỉnh.'
        }
        confirmLabel={mode?.to === 'LIVE' ? 'Về giá thực tế' : 'Chuyển sang điều chỉnh'}
        onClose={() => setMode(null)}
        onConfirm={async (reason) => {
          if (!mode) return;
          const ok = await act(
            `/admin/prices/${mode.r.symbol}/${mode.to === 'LIVE' ? 'live' : 'manual'}`,
            'POST',
            { reason },
            mode.to === 'LIVE' ? `${mode.r.symbol} đã về giá thực tế` : `${mode.r.symbol} đang dùng giá điều chỉnh`,
          );
          if (ok) setMode(null);
        }}
      />
    </div>
  );
}
