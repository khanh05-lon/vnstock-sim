import { useState } from 'react';
import { X } from 'lucide-react';
import { PHASE_LABEL, type SessionPhase } from '@vss/shared';
import { useAdminAction, useAdminMarket } from '../../lib/admin';
import { cn, fmtDateVN, fmtInt, fmtTimeVN } from '../../lib/format';
import { Empty, Spinner } from '../common/ui';
import { KeyValue, Pill, ReasonModal, Section } from './adminUi';

const LEVELS = [
  { value: 'info', label: 'Thông tin', cls: 'border-info/40 bg-info/10 text-info' },
  { value: 'warning', label: 'Cảnh báo', cls: 'border-ref/40 bg-ref/10 text-ref' },
  { value: 'critical', label: 'Khẩn cấp', cls: 'border-down/40 bg-down/10 text-down' },
] as const;

export function MarketOps() {
  const { data, isLoading } = useAdminMarket();
  const act = useAdminAction();
  const [haltOpen, setHaltOpen] = useState(false);
  const [symbol, setSymbol] = useState('');
  const [text, setText] = useState('');
  const [level, setLevel] = useState<'info' | 'warning' | 'critical'>('info');
  const [hDate, setHDate] = useState('');
  const [hName, setHName] = useState('');

  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }
  const st = data.status;
  const sym = symbol.trim().toUpperCase();
  const symOk = data.symbols.some((s) => s.symbol === sym);
  const r = data.rules;

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      <Section title="Phiên giao dịch">
        <KeyValue
          items={[
            ['Trạng thái', PHASE_LABEL[data.session.phase as SessionPhase] ?? data.session.phase],
            ['Chế độ', data.session.mode === 'REAL_HOURS' ? 'Theo giờ thật (HOSE)' : 'Mô phỏng 24/7'],
            ['Ngày giao dịch', fmtDateVN(data.session.tradeDate)],
            ['Giờ máy chủ (VN)', fmtTimeVN(data.session.serverTime)],
            ['Nguồn giá', `${data.provider} · ${data.feed === 'LIVE' ? 'giá thật' : 'giả lập'}`],
            ['Chu kỳ cập nhật giá', `${r.tickIntervalMs} ms`],
          ]}
        />
        <p className="mt-3 text-[12px] text-tx-3">Chế độ, nguồn giá và chu kỳ đổi bằng biến môi trường MARKET_MODE, MARKET_PROVIDER, TICK_INTERVAL_MS rồi khởi động lại máy chủ.</p>
      </Section>

      <Section
        title="Nhận lệnh toàn hệ thống"
        actions={st.tradingHalted ? <Pill tone="bad">Đang tạm ngừng</Pill> : <Pill tone="good">Bình thường</Pill>}
      >
        <p className="text-tx-2">
          Tạm ngừng thì nhà đầu tư không đặt / sửa được lệnh và lệnh đang chờ không được khớp; vẫn huỷ lệnh và xem bảng giá được. Mọi trình duyệt thấy banner đỏ ngay lập tức.
        </p>
        {st.tradingHalted && <p className="mt-2 text-down">Lý do: {st.haltReason}</p>}
        <div className="mt-3">
          {st.tradingHalted ? (
            <button className="btn btn-up" onClick={() => void act('/admin/market/halt', 'POST', { halted: false }, 'Đã mở lại nhận lệnh')}>
              Mở lại nhận lệnh
            </button>
          ) : (
            <button className="btn btn-down" onClick={() => setHaltOpen(true)}>
              Tạm ngừng nhận lệnh
            </button>
          )}
        </div>
      </Section>

      <Section title="Tạm ngừng giao dịch theo mã">
        <div className="flex gap-2">
          <input
            className="input h-9 flex-1 uppercase"
            list="admin-symbols"
            placeholder="Nhập mã, ví dụ HPG"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
          />
          <datalist id="admin-symbols">
            {data.symbols.map((s) => (
              <option key={s.symbol} value={s.symbol}>
                {s.exchange} · {s.name}
              </option>
            ))}
          </datalist>
          <button
            className="btn btn-ghost h-9"
            disabled={!symOk || st.haltedSymbols.includes(sym)}
            onClick={async () => {
              if (await act(`/admin/market/symbols/${sym}/halt`, 'POST', { halted: true }, `Đã tạm ngừng ${sym}`)) setSymbol('');
            }}
          >
            Tạm ngừng mã
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {st.haltedSymbols.length ? (
            st.haltedSymbols.map((s) => (
              <span key={s} className="chip h-7 gap-1 bg-down/15 text-[12px] text-down">
                {s}
                <button
                  aria-label={`Mở lại ${s}`}
                  className="rounded hover:bg-down/20"
                  onClick={() => void act(`/admin/market/symbols/${s}/halt`, 'POST', { halted: false }, `Đã mở lại ${s}`)}
                >
                  <X size={13} />
                </button>
              </span>
            ))
          ) : (
            <span className="text-[12px] text-tx-3">Không có mã nào bị tạm ngừng.</span>
          )}
        </div>
      </Section>

      <Section title="Thông báo hệ thống (banner cho mọi người dùng)">
        {st.announcement ? (
          <div className={cn('rounded-md border px-3 py-2 text-[13px]', LEVELS.find((l) => l.value === st.announcement!.level)?.cls)}>
            {st.announcement.text}
            <div className="mt-1 flex items-center justify-between text-[11px] opacity-80">
              <span>Đăng lúc {fmtTimeVN(st.announcement.updatedAt)}</span>
              <button className="underline" onClick={() => void act('/admin/announcement', 'DELETE', undefined, 'Đã gỡ thông báo')}>
                Gỡ thông báo
              </button>
            </div>
          </div>
        ) : (
          <p className="text-[12px] text-tx-3">Hiện không có thông báo.</p>
        )}
        <textarea
          className="input mt-3 h-20 resize-none py-2"
          maxLength={300}
          placeholder="Ví dụ: Hệ thống bảo trì lúc 22:00 tối nay, dự kiến 15 phút."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {LEVELS.map((l) => (
            <button key={l.value} onClick={() => setLevel(l.value)} className={cn('chip h-7 border px-2.5 text-[12px]', level === l.value ? l.cls : 'border-line text-tx-3')}>
              {l.label}
            </button>
          ))}
          <span className="ml-auto text-[11px] text-tx-3">{text.length}/300</span>
          <button
            className="btn btn-brand h-8"
            disabled={text.trim().length < 3}
            onClick={async () => {
              if (await act('/admin/announcement', 'PUT', { text: text.trim(), level }, 'Đã đăng thông báo')) setText('');
            }}
          >
            Đăng thông báo
          </button>
        </div>
      </Section>

      <Section title="Ngày nghỉ lễ" pad={false}>
        <div className="flex flex-wrap gap-2 border-b border-line p-4">
          <input type="date" className="input h-9 w-44" value={hDate} onChange={(e) => setHDate(e.target.value)} aria-label="Ngày nghỉ" />
          <input className="input h-9 min-w-0 flex-1" placeholder="Tên ngày lễ" value={hName} onChange={(e) => setHName(e.target.value)} />
          <button
            className="btn btn-ghost h-9"
            disabled={!hDate || hName.trim().length < 2}
            onClick={async () => {
              if (await act('/admin/holidays', 'POST', { date: hDate, name: hName.trim() }, 'Đã thêm ngày nghỉ')) {
                setHDate('');
                setHName('');
              }
            }}
          >
            Thêm
          </button>
        </div>
        {data.holidays.length ? (
          <ul className="max-h-60 divide-y divide-line overflow-y-auto">
            {data.holidays.map((h) => (
              <li key={h.date} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                <span className="num w-24 font-medium">{fmtDateVN(h.date)}</span>
                <span className="flex-1 text-tx-2">{h.name}</span>
                <button className="text-[12px] text-down hover:underline" onClick={() => void act(`/admin/holidays/${h.date}`, 'DELETE', undefined, 'Đã xoá ngày nghỉ')}>
                  Xoá
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="Chưa khai báo ngày nghỉ" />
        )}
        <p className="border-t border-line px-4 py-2.5 text-[11px] text-tx-3">
          Áp dụng ở chế độ giờ thật: ngày lễ đóng cửa và không tính vào T+2. Danh sách mẫu cần cập nhật theo thông báo chính thức của Sở Giao dịch Chứng khoán.
        </p>
      </Section>

      <Section title="Tham số giao dịch (chỉ xem)">
        <KeyValue
          items={[
            ['Biên độ HOSE / HNX / UPCOM', `±${r.priceLimitPct.HOSE}% / ±${r.priceLimitPct.HNX}% / ±${r.priceLimitPct.UPCOM}%`],
            ['Lô chẵn', `${fmtInt(r.lotSize)} CP`],
            ['KL tối đa / lệnh HOSE', `${fmtInt(r.maxOrderQty.HOSE)} CP`],
            ['KL tối đa / lệnh HNX, UPCOM', `${fmtInt(r.maxOrderQty.HNX)} CP`],
            ['Phí giao dịch', `${(r.feeRate * 100).toFixed(2)}%`],
            ['Thuế bán', `${(r.sellTaxRate * 100).toFixed(1)}%`],
            ['Thanh toán', `T+${r.settlementDays}`],
            ['Vốn ảo khi mở tài khoản', `${fmtInt(r.initialCapital)}đ`],
          ]}
        />
        <p className="mt-3 text-[12px] text-tx-3">Quy tắc giao dịch nằm trong shared/src/index.ts, T+N trong biến SETTLEMENT_DAYS — sửa cần triển khai lại phiên bản.</p>
      </Section>

      <ReasonModal
        open={haltOpen}
        title="Tạm ngừng nhận lệnh toàn hệ thống"
        description="Lý do sẽ hiển thị cho mọi nhà đầu tư trên banner và trong thông báo lỗi khi đặt lệnh."
        confirmLabel="Tạm ngừng"
        danger
        placeholder="Ví dụ: Bảo trì hệ thống, sự cố nguồn giá…"
        onClose={() => setHaltOpen(false)}
        onConfirm={async (reason) => {
          if (await act('/admin/market/halt', 'POST', { halted: true, reason }, 'Đã tạm ngừng nhận lệnh')) setHaltOpen(false);
        }}
      />
    </div>
  );
}
