import { useState } from 'react';
import { Star } from 'lucide-react';
import { TICKET_CATEGORY_LABEL, isTicketActive } from '@vss/shared';
import { fmtDateTime } from '../../lib/format';
import { useMyTicket, useSupportCall } from '../../lib/support';
import { Spinner } from '../common/ui';
import { ChatThread, Composer, PriorityPill, TicketStatusPill } from './SupportUi';

function RateBox({ id, rated }: { id: number; rated: number | null }) {
  const call = useSupportCall();
  const [stars, setStars] = useState(rated ?? 0);
  const [comment, setComment] = useState('');
  if (rated) {
    return (
      <div className="border-t border-line px-3 py-2 text-[12px] text-tx-2">
        Bạn đã đánh giá {rated}/5 sao. Cảm ơn bạn!
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2 text-[12px]">
      <span className="text-tx-2">Đánh giá hỗ trợ:</span>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} onClick={() => setStars(n)} aria-label={`${n} sao`} className={n <= stars ? 'text-ref' : 'text-tx-3'}>
          <Star size={16} fill={n <= stars ? 'currentColor' : 'none'} />
        </button>
      ))}
      <input className="input h-7 min-w-0 flex-1" placeholder="Nhận xét (tuỳ chọn)" value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} />
      <button className="btn btn-brand h-7" disabled={!stars} onClick={() => void call(`/support/tickets/${id}/rate`, { rating: stars, comment: comment.trim() || undefined }, 'Đã gửi đánh giá')}>
        Gửi
      </button>
    </div>
  );
}

/** Hội thoại 1 yêu cầu hỗ trợ phía khách; compact = trong hộp chat nổi */
export function TicketConversation({ id, compact }: { id: number; compact?: boolean }) {
  const { data, isLoading } = useMyTicket(id);
  const call = useSupportCall();
  if (isLoading || !data) return <Spinner className="m-6" />;
  const t = data.ticket;
  const active = isTicketActive(t.status);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={compact ? 'border-b border-line px-3 py-2' : 'border-b border-line px-4 py-2.5'}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={compact ? 'text-[13px] font-semibold' : 'font-semibold'}>
            #{t.id} · {t.subject}
          </span>
          <TicketStatusPill status={t.status} />
          <PriorityPill priority={t.priority} />
        </div>
        <div className="mt-0.5 text-[12px] text-tx-3">
          {TICKET_CATEGORY_LABEL[t.category]}
          {t.orderId ? ` · lệnh #${t.orderId}` : ''} · gửi lúc {fmtDateTime(t.createdAt)}
          {t.assigneeEmail ? ' · đã có nhân viên tiếp nhận' : ' · đang chờ nhân viên tiếp nhận'}
        </div>
        {t.status === 'RESOLVED' && t.resolution && <div className="mt-1.5 rounded-md bg-up/10 px-2.5 py-1.5 text-[12px] text-up">Kết quả xử lý: {t.resolution}</div>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ChatThread messages={data.messages} viewer="CUSTOMER" />
      </div>
      {(t.status === 'RESOLVED' || t.status === 'CLOSED') && <RateBox id={t.id} rated={t.rating} />}
      <Composer
        disabled={t.status === 'CLOSED' ? 'Yêu cầu đã đóng — nếu còn vấn đề, hãy tạo yêu cầu mới' : null}
        placeholder={t.status === 'RESOLVED' ? 'Chưa hài lòng? Nhắn tiếp để mở lại yêu cầu…' : undefined}
        onSend={(body) => call(`/support/tickets/${t.id}/messages`, { body })}
      />
      {active && (
        <div className="border-t border-line px-3 py-1.5 text-right">
          <button className="text-[12px] text-tx-3 hover:text-down" onClick={() => void call(`/support/tickets/${t.id}/close`, {}, 'Đã đóng yêu cầu')}>
            Tôi đã được giải quyết — đóng yêu cầu
          </button>
        </div>
      )}
    </div>
  );
}
