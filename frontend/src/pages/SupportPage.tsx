import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Headset, Lock, Plus } from 'lucide-react';
import { SUPPORT_SLA_MINUTES, TICKET_CATEGORY_LABEL, type TicketCategory, type TicketDetailDTO } from '@vss/shared';
import { AuthFrame } from '../components/auth/AuthFrame';
import { TicketStatusPill } from '../components/support/SupportUi';
import { TicketConversation } from '../components/support/TicketConversation';
import { Empty, Spinner } from '../components/common/ui';
import { cn, fmtDateTime, fmtPrice, fmtQty } from '../lib/format';
import { useOrderHistory } from '../lib/queries';
import { useMyTickets, useSupportCall, useSupportPass, useSupportPassToken } from '../lib/support';
import { useAuth } from '../store/auth';

const CATEGORIES = Object.keys(TICKET_CATEGORY_LABEL) as TicketCategory[];

function NewTicket({ presetOrder, onCreated, onCancel }: { presetOrder: number | null; onCreated(id: number): void; onCancel(): void }) {
  const call = useSupportCall();
  // Tài khoản bị khoá (vé hỗ trợ) không xem được danh sách lệnh → ghi số lệnh trong nội dung
  const locked = !!useSupportPassToken();
  const { data: orders } = useOrderHistory({}, 50);
  const [category, setCategory] = useState<TicketCategory>(presetOrder ? 'ORDER' : 'OTHER');
  const [subject, setSubject] = useState(presetOrder ? `Lệnh #${presetOrder} bất thường` : '');
  const [message, setMessage] = useState('');
  const [orderId, setOrderId] = useState<number | null>(presetOrder);
  const [urgent, setUrgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const ok = subject.trim().length >= 3 && message.trim().length >= 1;

  const submit = async () => {
    setBusy(true);
    const r = await call<TicketDetailDTO>('/support/tickets', { subject: subject.trim(), category, message: message.trim(), orderId, urgent }, 'Đã gửi yêu cầu hỗ trợ');
    setBusy(false);
    if (r) onCreated(r.ticket.id);
  };

  return (
    <div className="space-y-3 p-4">
      <h2 className="text-[16px] font-semibold">Gửi yêu cầu hỗ trợ</h2>
      <p className="text-[12px] text-tx-3">
        Mô tả rõ sự việc: thời gian, cặp giao dịch, số lượng, điều bạn thấy bất thường. Yêu cầu liên quan lệnh, số dư, bảo mật được ưu tiên cao (trả lời trong khoảng{' '}
        {SUPPORT_SLA_MINUTES.HIGH} phút).
      </p>
      <label className="block">
        <span className="label">Vấn đề</span>
        <select className="input mt-1 h-9 w-full" value={category} onChange={(e) => setCategory(e.target.value as TicketCategory)}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {TICKET_CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
      </label>
      {!locked && (
        <label className="block">
          <span className="label">Lệnh liên quan (nếu có)</span>
          <select className="input mt-1 h-9 w-full" value={orderId ?? ''} onChange={(e) => setOrderId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Không gắn lệnh</option>
            {presetOrder && !(orders ?? []).some((o) => o.id === presetOrder) && <option value={presetOrder}>Lệnh #{presetOrder}</option>}
            {(orders ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                #{o.id} · {o.side === 'BUY' ? 'Mua' : 'Bán'} {o.symbol} {fmtQty(o.origQty)} {o.price ? `@ ${fmtPrice(o.price)}` : ''} · {fmtDateTime(o.createdAt)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="block">
        <span className="label">Tiêu đề</span>
        <input className="input mt-1 h-9 w-full" value={subject} maxLength={120} onChange={(e) => setSubject(e.target.value)} placeholder="Vd: Lệnh bán không khớp dù giá đã chạm" />
      </label>
      <label className="block">
        <span className="label">Nội dung</span>
        <textarea className="input mt-1 h-32 w-full resize-none py-2" value={message} maxLength={4000} onChange={(e) => setMessage(e.target.value)} />
      </label>
      <label className="flex items-center gap-2 text-[13px] text-tx-2">
        <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
        Khẩn cấp (nghi bị truy cập trái phép, mất tài sản) — trả lời trong {SUPPORT_SLA_MINUTES.URGENT} phút
      </label>
      <div className="flex justify-end gap-2">
        <button className="btn btn-ghost" onClick={onCancel}>
          Huỷ
        </button>
        <button className="btn btn-brand min-w-28" disabled={!ok || busy} onClick={() => void submit()}>
          {busy ? 'Đang gửi…' : 'Gửi yêu cầu'}
        </button>
      </div>
    </div>
  );
}

export default function SupportPage() {
  const [params, setParams] = useSearchParams();
  const { data, isLoading } = useMyTickets();
  const selected = Number(params.get('ticket')) || null;
  const creating = params.get('new') === '1';
  const presetOrder = Number(params.get('order')) || null;

  useEffect(() => {
    document.title = 'Hỗ trợ khách hàng · VNCoin';
  }, []);
  // Chưa chọn gì → mở yêu cầu mới nhất
  useEffect(() => {
    if (!selected && !creating && data?.length) setParams({ ticket: String(data[0]!.id) }, { replace: true });
  }, [selected, creating, data, setParams]);

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-[1200px] flex-1 flex-col p-3">
      <div className="mb-3 flex items-center gap-2">
        <Headset size={20} className="text-brand" />
        <h1 className="text-[20px] font-bold">Hỗ trợ khách hàng</h1>
        <button className="btn btn-brand ml-auto h-8" onClick={() => setParams({ new: '1' })}>
          <Plus size={14} /> Yêu cầu mới
        </button>
      </div>
      <div className="panel flex min-h-[560px] flex-1 overflow-hidden">
        <aside className="w-72 shrink-0 overflow-auto border-r border-line">
          {isLoading ? (
            <Spinner className="m-4" />
          ) : !data?.length ? (
            <Empty title="Chưa có yêu cầu nào" hint="Gặp lệnh bất thường, sai số dư, nghi bị truy cập trái phép? Bấm Yêu cầu mới." />
          ) : (
            data.map((t) => (
              <button
                key={t.id}
                onClick={() => setParams({ ticket: String(t.id) })}
                className={cn('block w-full border-b border-line px-3 py-2.5 text-left hover:bg-bg-2', selected === t.id && !creating && 'bg-brand/8')}
              >
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium">
                    #{t.id} {t.subject}
                  </span>
                  {t.unread > 0 && <span className="ml-auto rounded-full bg-brand px-1.5 text-[10px] font-bold text-white">{t.unread}</span>}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-tx-3">
                  <TicketStatusPill status={t.status} />
                  <span>{fmtDateTime(t.lastMessageAt)}</span>
                </div>
              </button>
            ))
          )}
        </aside>
        <section className="flex min-w-0 flex-1 flex-col">
          {creating ? (
            <NewTicket presetOrder={presetOrder} onCreated={(id) => setParams({ ticket: String(id) })} onCancel={() => setParams({})} />
          ) : selected ? (
            <TicketConversation id={selected} />
          ) : (
            <Empty title="Chọn một yêu cầu hoặc tạo yêu cầu mới" />
          )}
        </section>
      </div>
    </div>
  );
}

/** Tài khoản bị khoá: chỉ vào được mục Hỗ trợ bằng vé hỗ trợ (cấp ở trang đăng nhập / đặt lại mật khẩu) */
export function LockedSupportPage() {
  const token = useAuth((s) => s.token);
  const pass = useSupportPass((s) => s.pass);
  const clear = useSupportPass((s) => s.clear);
  const nav = useNavigate();
  if (token) return <Navigate to="/ho-tro" replace />;
  if (!pass || pass.expiresAt <= Date.now()) {
    return (
      <AuthFrame>
        <div className="mx-auto my-16 w-full max-w-md rounded-2xl border border-line bg-bg-1 p-6 text-center">
          <Lock size={28} className="mx-auto text-tx-3" />
          <h2 className="mt-3 text-[20px] font-bold">Phiên hỗ trợ đã hết hạn</h2>
          <p className="mt-2 text-tx-2">Đăng nhập lại để tiếp tục nhắn bộ phận chăm sóc khách hàng.</p>
          <Link to="/login" className="btn btn-brand mt-5 h-10 px-6">
            Đăng nhập
          </Link>
        </div>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame>
      <div className="mx-auto w-full max-w-[1200px] px-3 pt-3">
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-[13px]">
          <Lock size={16} className="shrink-0 text-down" />
          <span className="min-w-0 flex-1">
            Tài khoản <b>{pass.email}</b> đang bị khoá: không giao dịch được, nhưng bạn vẫn nhắn được bộ phận chăm sóc khách hàng để xác minh và mở khoá. Nhân viên trả lời cả
            qua email.
          </span>
          <button
            className="btn btn-ghost h-7"
            onClick={() => {
              clear();
              nav('/login', { replace: true });
            }}
          >
            Thoát
          </button>
        </div>
      </div>
      <SupportPage />
    </AuthFrame>
  );
}
