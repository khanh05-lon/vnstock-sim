import { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { toast } from 'sonner';
import type { P2PMessageDTO } from '@vss/shared';
import { api, errMsg } from '../../lib/api';
import { cn, fmtTime } from '../../lib/format';
import { Spinner } from '../common/ui';

/** Khung chat trong đơn P2P: tin của hai bên, tin hệ thống, tin nhân viên xử lý khiếu nại */
export function OrderChat({
  messages,
  viewerId,
  postPath,
  onSent,
  disabled,
  staffView,
}: {
  messages: P2PMessageDTO[] | undefined;
  viewerId: string | null;
  /** Đường dẫn API gửi tin */
  postPath: string;
  onSent(): void;
  disabled?: boolean;
  /** Nhân viên xem: tin của nhân viên hiện bên phải */
  staffView?: boolean;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages?.length]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    try {
      await api(postPath, { method: 'POST', body: { body } });
      setText('');
      onSent();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-[360px] flex-col">
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
        {!messages ? (
          <Spinner className="m-4" />
        ) : (
          messages.map((m) => {
            if (m.kind === 'SYSTEM') {
              return (
                <div key={m.id} className="mx-auto max-w-[92%] rounded-md bg-bg-2 px-3 py-2 text-center text-[12px] text-tx-2">
                  {m.body}
                  <div className="mt-0.5 text-[10px] text-tx-3">{fmtTime(m.createdAt)}</div>
                </div>
              );
            }
            const mine = staffView ? m.kind === 'STAFF' : m.senderId === viewerId;
            return (
              <div key={m.id} className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
                <span className="mb-0.5 text-[11px] text-tx-3">
                  {m.kind === 'STAFF' ? <span className="font-semibold text-brand">{m.senderName}</span> : m.senderName} · {fmtTime(m.createdAt)}
                </span>
                <div
                  className={cn(
                    'max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-[13px]',
                    m.kind === 'STAFF' ? 'border border-brand/40 bg-brand/10' : mine ? 'bg-brand text-brand-ink' : 'bg-bg-3',
                  )}
                >
                  {m.body}
                </div>
              </div>
            );
          })
        )}
        <div ref={end} />
      </div>
      <div className="flex gap-2 border-t border-line p-2">
        <input
          className="input"
          placeholder={disabled ? 'Đơn đã kết thúc' : 'Nhập tin nhắn…'}
          value={text}
          maxLength={1000}
          disabled={disabled || busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && void send()}
          aria-label="Tin nhắn"
        />
        <button className="btn btn-brand px-3" disabled={disabled || busy || !text.trim()} onClick={() => void send()} aria-label="Gửi">
          <Send size={15} />
        </button>
      </div>
    </div>
  );
}
