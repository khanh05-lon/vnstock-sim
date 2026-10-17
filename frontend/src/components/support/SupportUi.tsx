import { useEffect, useRef, useState } from 'react';
import { Lock, Send } from 'lucide-react';
import {
  ORDER_STATUS_LABEL,
  ORDER_TYPE_LABEL,
  TICKET_PRIORITY_LABEL,
  TICKET_STATUS_LABEL,
  type OrderEventDTO,
  type TicketMessageDTO,
  type TicketPriority,
  type TicketStatus,
} from '@vss/shared';
import { cn, fmtDateTime, fmtPrice, fmtQty } from '../../lib/format';
import { useOrderEvents } from '../../lib/support';
import { Modal, Spinner } from '../common/ui';

const STATUS_STYLE: Record<TicketStatus, string> = {
  OPEN: 'bg-ref/15 text-ref',
  IN_PROGRESS: 'bg-brand/15 text-brand',
  WAITING_CUSTOMER: 'bg-info/15 text-info',
  RESOLVED: 'bg-up/15 text-up',
  CLOSED: 'bg-bg-3 text-tx-3',
};
const PRIORITY_STYLE: Record<TicketPriority, string> = {
  NORMAL: 'bg-bg-3 text-tx-2',
  HIGH: 'bg-ref/15 text-ref',
  URGENT: 'bg-down/15 text-down',
};

export function TicketStatusPill({ status }: { status: TicketStatus }) {
  return <span className={cn('chip h-5 whitespace-nowrap text-[10px]', STATUS_STYLE[status])}>{TICKET_STATUS_LABEL[status]}</span>;
}

export function PriorityPill({ priority }: { priority: TicketPriority }) {
  return <span className={cn('chip h-5 whitespace-nowrap text-[10px]', PRIORITY_STYLE[priority])}>{TICKET_PRIORITY_LABEL[priority]}</span>;
}

/** Khung tin nhắn; viewer = phía đang xem (tin của mình nằm bên phải) */
export function ChatThread({ messages, viewer }: { messages: TicketMessageDTO[]; viewer: 'CUSTOMER' | 'STAFF' }) {
  const end = useRef<HTMLDivElement>(null);
  // Thân hàm dạng khối: scrollIntoView ở trình duyệt mới trả về Promise, không được trả ra khỏi useEffect
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);
  return (
    <div className="space-y-2.5 p-3">
      {messages.map((m) => {
        if (m.authorKind === 'SYSTEM') {
          return (
            <div key={m.id} className={cn('mx-auto max-w-[85%] rounded-md px-3 py-1.5 text-center text-[11px]', m.internal ? 'bg-ref/10 text-ref' : 'bg-bg-2 text-tx-3')}>
              {m.internal && <Lock size={10} className="mr-1 inline" />}
              {m.body} · {fmtDateTime(m.createdAt)}
            </div>
          );
        }
        const mine = m.authorKind === viewer;
        return (
          <div key={m.id} className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
            <div
              className={cn(
                'max-w-[80%] rounded-lg px-3 py-2 text-[13px]',
                m.internal ? 'border border-dashed border-ref/60 bg-ref/10' : mine ? 'bg-brand/15' : 'bg-bg-2',
              )}
            >
              <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-tx-3">
                {m.internal && (
                  <span className="flex items-center gap-0.5 font-semibold text-ref">
                    <Lock size={10} /> Ghi chú nội bộ
                  </span>
                )}
                <span className="font-medium text-tx-2">{m.authorName}</span>
                <span>{fmtDateTime(m.createdAt)}</span>
              </div>
              <div className="whitespace-pre-wrap break-words">{m.body}</div>
            </div>
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}

/** Ô soạn tin: Enter gửi, Shift+Enter xuống dòng; nhân viên có thể chọn ghi chú nội bộ */
export function Composer({ onSend, allowInternal, disabled, placeholder }: { onSend(body: string, internal: boolean): Promise<unknown>; allowInternal?: boolean; disabled?: string | null; placeholder?: string }) {
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  if (disabled) return <div className="border-t border-line px-3 py-3 text-center text-[12px] text-tx-3">{disabled}</div>;
  const send = async () => {
    const b = body.trim();
    if (!b || busy) return;
    setBusy(true);
    try {
      const r = await onSend(b, internal);
      if (r) setBody('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn('border-t border-line p-2', internal && 'bg-ref/5')}>
      <div className="flex items-end gap-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          maxLength={4000}
          rows={2}
          placeholder={internal ? 'Ghi chú nội bộ — khách không thấy' : (placeholder ?? 'Nhập tin nhắn… (Enter để gửi, Shift+Enter xuống dòng)')}
          aria-label="Nội dung tin nhắn"
          className="input min-h-[44px] flex-1 resize-none py-2"
        />
        <button onClick={() => void send()} disabled={busy || !body.trim()} className="btn btn-brand h-10 w-10 p-0" aria-label="Gửi tin nhắn">
          <Send size={16} />
        </button>
      </div>
      {allowInternal && (
        <label className="mt-1.5 flex items-center gap-1.5 text-[12px] text-tx-2">
          <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Ghi chú nội bộ (chỉ nhân viên thấy)
        </label>
      )}
    </div>
  );
}

const fmtDetail = (e: OrderEventDTO) => {
  const d = e.detail as Record<string, string | number | null | undefined>;
  const parts: string[] = [];
  if (d.type) parts.push(ORDER_TYPE_LABEL[d.type as keyof typeof ORDER_TYPE_LABEL] ?? String(d.type));
  if (d.side) parts.push(d.side === 'BUY' ? 'Mua' : 'Bán');
  if (d.price) parts.push(`giá ${fmtPrice(String(d.price))}`);
  if (d.stopPrice) parts.push(`kích hoạt ${fmtPrice(String(d.stopPrice))}`);
  if (d.quantity && d.quantity !== '0') parts.push(`KL ${fmtQty(String(d.quantity))}`);
  if (d.newOrderId) parts.push(`→ lệnh mới #${d.newOrderId} (giá ${d.newPrice ?? '?'}, KL ${d.newQuantity ?? '?'})`);
  if (d.replacesOrderId) parts.push(`thay cho lệnh #${d.replacesOrderId}`);
  if (d.lastPrice) parts.push(`giá thị trường ${fmtPrice(String(d.lastPrice))}`);
  if (d.status) parts.push(`trạng thái: ${ORDER_STATUS_LABEL[d.status as keyof typeof ORDER_STATUS_LABEL] ?? d.status}`);
  if (d.reason) parts.push(`lý do: ${d.reason}`);
  return parts.join(' · ');
};

/** Dòng thời gian của 1 lệnh: ai đặt / sửa / huỷ, lúc nào, từ IP nào + các lần khớp */
export function OrderTimeline({ path }: { path: string }) {
  const { data, isLoading } = useOrderEvents(path);
  if (isLoading) return <Spinner className="m-4" />;
  const rows = [
    ...(data?.events ?? []).map((e) => ({ t: e.createdAt, key: `e${e.id}`, title: e.label, who: e.actor, ip: e.ip, text: fmtDetail(e) })),
    ...(data?.fills ?? []).map((f) => ({
      t: f.time,
      key: `f${f.id}`,
      title: 'Khớp lệnh',
      who: f.isMaker ? 'Bên chờ (maker)' : 'Bên khớp ngay (taker)',
      ip: null,
      text: `${fmtQty(f.qty)} @ ${fmtPrice(f.price)} · phí ${f.commission} ${f.commissionAsset}`,
    })),
  ].sort((a, b) => a.t.localeCompare(b.t));
  if (!rows.length) return <div className="p-4 text-[12px] text-tx-3">Lệnh này chưa có nhật ký (lệnh đặt trước khi hệ thống ghi nhật ký lệnh).</div>;
  return (
    <ol className="space-y-2 p-1">
      {rows.map((r) => (
        <li key={r.key} className="rounded-md bg-bg-2 px-3 py-2 text-[12px]">
          <div className="flex flex-wrap items-center gap-x-2">
            <span className="font-semibold">{r.title}</span>
            <span className="text-tx-3">{fmtDateTime(r.t)}</span>
            <span className="text-tx-2">bởi {r.who}</span>
            {r.ip && <span className="text-tx-3">IP {r.ip}</span>}
          </div>
          {r.text && <div className="mt-0.5 text-tx-2">{r.text}</div>}
        </li>
      ))}
    </ol>
  );
}

export function OrderTimelineModal({ orderId, path, onClose }: { orderId: number | null; path?: string; onClose(): void }) {
  return (
    <Modal open={orderId != null} onClose={onClose} title={`Nhật ký lệnh #${orderId ?? ''}`} width={560}>
      {orderId != null && <OrderTimeline path={path ?? `/orders/${orderId}/events`} />}
    </Modal>
  );
}
