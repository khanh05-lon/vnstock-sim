import { useState } from 'react';
import { X } from 'lucide-react';
import { EMERGENCY_HALT_MIN } from '@vss/shared';
import { useAdminAction, useAdminMarket, useAdminMe } from '../../lib/admin';
import { useAuth } from '../../store/auth';
import { cn, fmtTime } from '../../lib/format';
import { Spinner } from '../common/ui';
import { KeyValue, Pill, ReasonModal, Section } from './adminUi';
import { RulesEditor } from './RulesEditor';

const LEVELS = [
  { value: 'info', label: 'Thông tin', cls: 'border-info/40 bg-info/10 text-info' },
  { value: 'warning', label: 'Cảnh báo', cls: 'border-ref/40 bg-ref/10 text-ref' },
  { value: 'critical', label: 'Khẩn cấp', cls: 'border-down/40 bg-down/10 text-down' },
] as const;

export function MarketOps() {
  const { data, isLoading } = useAdminMarket();
  const { can } = useAdminMe();
  const act = useAdminAction();
  const [haltOpen, setHaltOpen] = useState(false);
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const meId = useAuth((s) => s.user?.id);
  const [symbol, setSymbol] = useState('');
  const [text, setText] = useState('');
  const [level, setLevel] = useState<'info' | 'warning' | 'critical'>('info');

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

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      <Section
        title="Nguồn dữ liệu thị trường"
        actions={data.market.feed === 'LIVE' ? <Pill tone="good">Binance (giá thật)</Pill> : <Pill tone="warn">Giả lập</Pill>}
      >
        <KeyValue
          items={[
            ['Cấu hình', data.source === 'binance' ? 'Binance, tự chuyển giả lập khi mất kết nối' : 'Chỉ giả lập (MARKET_FEED=sim)'],
            ['Đang dùng', data.market.feed === 'LIVE' ? 'Luồng WebSocket của Binance' : 'Bộ giả lập giá'],
            ['Số cặp giao dịch', String(data.symbols.length)],
            ['Giờ máy chủ (UTC)', new Date(data.market.serverTime).toISOString().slice(11, 19)],
          ]}
        />
        <p className="mt-3 text-[12px] text-tx-3">Đổi nguồn bằng biến môi trường MARKET_FEED (binance | sim) rồi khởi động lại máy chủ. Sàn hoạt động 24/7, chốt ngày theo 00:00 UTC.</p>
      </Section>

      <Section
        title="Nhận lệnh toàn hệ thống"
        actions={st.tradingHalted ? <Pill tone="bad">Đang tạm ngừng</Pill> : <Pill tone="good">Bình thường</Pill>}
      >
        <p className="text-tx-2">
          Tạm ngừng thì người dùng không đặt / sửa được lệnh và lệnh đang chờ không được khớp; vẫn huỷ lệnh và xem thị trường được. Mọi trình duyệt thấy banner đỏ ngay lập tức.
        </p>
        {st.tradingHalted && <p className="mt-2 text-down">Lý do: {st.haltReason}</p>}
        {data.emergency && (
          <div className="mt-3 rounded-lg border border-down/40 bg-down/10 p-3 text-[13px]">
            <b className="text-down">ĐANG DỪNG KHẨN</b> — bởi {data.emergency.by} lúc {fmtTime(data.emergency.at)}. Lý do: {data.emergency.reason}.
            <div className="mt-0.5 text-tx-2">
              Tự mở lại lúc {fmtTime(data.emergency.expiresAt)} nếu không có người thứ hai xác nhận (còn{' '}
              {Math.max(0, Math.ceil((Date.parse(data.emergency.expiresAt) - Date.now()) / 60_000))} phút).
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {can('market.approve') &&
                (data.emergency.byId !== meId ? (
                  <button className="btn btn-down h-8" onClick={() => void act('/admin/market/emergency-halt/confirm', 'POST', {}, 'Đã xác nhận dừng sàn')}>
                    Xác nhận dừng
                  </button>
                ) : (
                  <span className="self-center text-[12px] text-tx-3">Chờ người khác xác nhận</span>
                ))}
              {can('market.halt') && (
                <button className="btn btn-ghost h-8" onClick={() => setCancelOpen(true)}>
                  Huỷ dừng khẩn (báo nhầm)
                </button>
              )}
            </div>
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {!st.tradingHalted && can('market.halt') && (
            <button className="btn btn-down" onClick={() => setEmergencyOpen(true)}>
              Dừng khẩn ngay
            </button>
          )}
          {!st.tradingHalted && can('market.manage') && (
            <button className="btn btn-ghost" onClick={() => setHaltOpen(true)}>
              Đề xuất tạm ngừng toàn sàn
            </button>
          )}
          {st.tradingHalted && !data.emergency && can('market.manage') && (
            <button className="btn btn-up" onClick={() => setResumeOpen(true)}>
              Đề xuất mở lại sàn
            </button>
          )}
        </div>
        <p className="mt-2 text-[12px] text-tx-3">
          Dừng khẩn: 1 người, có hiệu lực ngay, tự mở lại sau {EMERGENCY_HALT_MIN} phút nếu không có người thứ hai xác nhận. Tạm ngừng / mở lại thông thường cần người thứ hai
          duyệt. Sự cố ở 1 cặp: tạm ngừng riêng cặp đó bên dưới (có hiệu lực ngay).
        </p>
      </Section>

      <Section title="Tạm ngừng giao dịch theo cặp">
        <div className="flex gap-2">
          <input
            className="input h-9 flex-1 uppercase"
            list="admin-symbols"
            placeholder="Nhập cặp, ví dụ BTCUSDT"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
          />
          <datalist id="admin-symbols">
            {data.symbols.map((s) => (
              <option key={s.symbol} value={s.symbol}>
                {s.baseAsset}/USDT · {s.name}
              </option>
            ))}
          </datalist>
          <button
            className="btn btn-ghost h-9"
            disabled={!can('market.halt') || !symOk || st.haltedSymbols.includes(sym)}
            onClick={async () => {
              if (await act(`/admin/market/symbols/${sym}/halt`, 'POST', { halted: true }, `Đã tạm ngừng ${sym}`)) setSymbol('');
            }}
          >
            Tạm ngừng cặp
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {st.haltedSymbols.length ? (
            st.haltedSymbols.map((s) => (
              <span key={s} className="chip h-7 gap-1 bg-down/15 text-[12px] text-down">
                {s}
                <button
                  aria-label={`Mở lại ${s}`}
                  disabled={!can('market.halt')}
                  className="rounded hover:bg-down/20"
                  onClick={() => void act(`/admin/market/symbols/${s}/halt`, 'POST', { halted: false }, `Đã mở lại ${s}`)}
                >
                  <X size={13} />
                </button>
              </span>
            ))
          ) : (
            <span className="text-[12px] text-tx-3">Không có cặp nào bị tạm ngừng.</span>
          )}
        </div>
      </Section>

      <Section title="Thông báo hệ thống (banner cho mọi người dùng)">
        {st.announcement ? (
          <div className={cn('rounded-md border px-3 py-2 text-[13px]', LEVELS.find((l) => l.value === st.announcement!.level)?.cls)}>
            {st.announcement.text}
            <div className="mt-1 flex items-center justify-between text-[11px] opacity-80">
              <span>Đăng lúc {fmtTime(st.announcement.updatedAt)}</span>
              {can('system.announce') && (
                <button className="underline" onClick={() => void act('/admin/announcement', 'DELETE', undefined, 'Đã gỡ thông báo')}>
                  Gỡ thông báo
                </button>
              )}
            </div>
          </div>
        ) : (
          <p className="text-[12px] text-tx-3">Hiện không có thông báo.</p>
        )}
        {can('system.announce') && (
        <>
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
        </>
        )}
      </Section>

      <RulesEditor />

      <ReasonModal
        open={emergencyOpen}
        title="Dừng khẩn toàn sàn"
        description={`Có hiệu lực NGAY: người dùng không đặt / sửa được lệnh, lệnh chờ không khớp. Người có thẩm quyền khác nhận email để xác nhận; không ai xác nhận thì sàn tự mở lại sau ${EMERGENCY_HALT_MIN} phút.`}
        confirmLabel="Dừng khẩn"
        danger
        placeholder="Ví dụ: nguồn giá trả về giá sai, nghi bị tấn công…"
        onClose={() => setEmergencyOpen(false)}
        onConfirm={async (reason) => {
          if (await act('/admin/market/emergency-halt', 'POST', { reason }, 'Đã dừng khẩn toàn sàn')) setEmergencyOpen(false);
        }}
      />
      <ReasonModal
        open={cancelOpen}
        title="Huỷ dừng khẩn"
        description="Sàn nhận lệnh lại ngay. Chỉ dùng khi dừng khẩn là báo động nhầm."
        confirmLabel="Huỷ dừng khẩn"
        onClose={() => setCancelOpen(false)}
        onConfirm={async (reason) => {
          if (await act('/admin/market/emergency-halt/cancel', 'POST', { reason }, 'Đã huỷ dừng khẩn, sàn nhận lệnh lại')) setCancelOpen(false);
        }}
      />
      <ReasonModal
        open={resumeOpen}
        title="Đề xuất mở lại sàn"
        description="Một người khác (Vận hành thị trường hoặc Rủi ro & giám sát) duyệt thì sàn mới nhận lệnh lại."
        confirmLabel="Gửi đề xuất"
        placeholder="Ví dụ: đã khắc phục nguồn giá, đã kiểm tra số dư…"
        onClose={() => setResumeOpen(false)}
        onConfirm={async (reason) => {
          if (await act('/admin/market/halt', 'POST', { halted: false, reason }, 'Đã gửi đề xuất mở lại sàn')) setResumeOpen(false);
        }}
      />
      <ReasonModal
        open={haltOpen}
        title="Đề xuất tạm ngừng nhận lệnh toàn sàn"
        description="Một người khác (Vận hành thị trường hoặc Rủi ro & giám sát) duyệt thì sàn mới tạm ngừng. Lý do sẽ hiển thị cho mọi người dùng trên banner và trong thông báo lỗi khi đặt lệnh."
        confirmLabel="Gửi đề xuất"
        danger
        placeholder="Ví dụ: Bảo trì hệ thống, sự cố nguồn giá..."
        onClose={() => setHaltOpen(false)}
        onConfirm={async (reason) => {
          if (await act('/admin/market/halt', 'POST', { halted: true, reason }, 'Đã gửi đề xuất tạm ngừng')) setHaltOpen(false);
        }}
      />
    </div>
  );
}
