import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft, Bot, ExternalLink, Headset, MessageCircle, Plus, RotateCcw, Send, Sparkles, Square, X } from 'lucide-react';
import { TICKET_CATEGORY_LABEL, isStaff, type TicketCategory, type TicketDetailDTO } from '@vss/shared';
import { transcriptOf, useAiChat, useAiStatus, useChatWidget, type ChatMsg } from '../../lib/aiChat';
import { cn, fmtDateTime } from '../../lib/format';
import { useMyTickets, useSupportCall, useSupportUnread } from '../../lib/support';
import { useAuth } from '../../store/auth';
import { Empty, Spinner } from '../common/ui';
import { TicketStatusPill } from './SupportUi';
import { TicketConversation } from './TicketConversation';

const SUGGESTIONS = ['Phí giao dịch tính thế nào?', 'Vì sao lệnh của tôi chưa khớp?', 'Lệnh OCO và stop-limit là gì?', 'Cách bật xác thực 2 lớp?'];
const CATEGORIES = Object.keys(TICKET_CATEGORY_LABEL) as TicketCategory[];

/* ------------------------------ hiển thị câu trả lời (markdown đơn giản) ------------------------------ */

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <b key={i}>{part.slice(2, -2)}</b>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
      return (
        <code key={i} className="rounded bg-bg-3 px-1 text-[12px]">
          {part.slice(1, -1)}
        </code>
      );
    return <Fragment key={i}>{part}</Fragment>;
  });
}

/** Đoạn văn, danh sách "- " / "1. ", in đậm, mã — đủ cho câu trả lời của trợ lý, không dùng HTML thô */
function RichText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join('\n'))}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? 'ol' : 'ul';
    blocks.push(
      <Tag key={blocks.length} className={cn('space-y-0.5 pl-5', list.ordered ? 'list-decimal' : 'list-disc')}>
        {list.items.map((it, i) => (
          <li key={i}>{inline(it)}</li>
        ))}
      </Tag>,
    );
    list = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const num = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || num) {
      flushPara();
      const ordered = !!num;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? num)![1]!);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.replace(/^#+\s*/, ''));
    }
  }
  flushPara();
  flushList();
  return <div className="space-y-1.5 break-words">{blocks}</div>;
}

/* ------------------------------ tab trợ lý AI ------------------------------ */

function BotAvatar() {
  return (
    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand">
      <Bot size={15} />
    </span>
  );
}

function TypingDots() {
  return (
    <span className="flex items-center gap-1 py-1" aria-label="Trợ lý đang soạn">
      {[0, 150, 300].map((d) => (
        <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-tx-3" style={{ animationDelay: `${d}ms` }} />
      ))}
    </span>
  );
}

function Bubble({ m, streaming }: { m: ChatMsg; streaming: boolean }) {
  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[82%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-brand px-3 py-2 text-[13px] text-[color:var(--brand-ink)]">{m.content}</div>
      </div>
    );
  }
  return (
    <div className="flex gap-2">
      <BotAvatar />
      <div
        className={cn(
          'max-w-[85%] rounded-2xl rounded-tl-md px-3 py-2 text-[13px] leading-relaxed',
          m.error ? 'border border-down/30 bg-down/10 text-down' : 'bg-bg-2 text-tx-1',
        )}
      >
        {m.content ? <RichText text={m.content} /> : streaming ? <TypingDots /> : null}
      </div>
    </div>
  );
}

function AiComposer() {
  const { busy, send, stop } = useAiChat();
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const submit = () => {
    if (!text.trim() || busy) return;
    void send(text);
    setText('');
  };
  return (
    <div className="flex items-end gap-2 border-t border-line p-2">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        maxLength={2000}
        placeholder="Hỏi trợ lý VNCoin…"
        aria-label="Câu hỏi cho trợ lý"
        className="input max-h-28 min-h-[40px] flex-1 resize-none py-2"
      />
      {busy ? (
        <button className="btn btn-ghost h-10 w-10 p-0" onClick={stop} aria-label="Dừng trả lời" title="Dừng trả lời">
          <Square size={14} fill="currentColor" />
        </button>
      ) : (
        <button className="btn btn-brand h-10 w-10 p-0" onClick={submit} disabled={!text.trim()} aria-label="Gửi câu hỏi">
          <Send size={16} />
        </button>
      )}
    </div>
  );
}

function AiTab() {
  const { msgs, busy, send } = useAiChat();
  const { data: status, isLoading } = useAiStatus();
  const setW = useChatWidget((s) => s.set);
  const end = useRef<HTMLDivElement>(null);
  const last = msgs[msgs.length - 1];
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [msgs.length, last?.content.length]);

  if (isLoading) return <Spinner className="m-6" />;
  if (!status?.enabled) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-2 text-tx-3">
          <Bot size={22} />
        </span>
        <div className="text-[14px] font-semibold">Trợ lý AI tạm thời chưa hoạt động</div>
        <p className="text-[12.5px] text-tx-2">Bạn vẫn nhắn trực tiếp được cho nhân viên chăm sóc khách hàng.</p>
        <button className="btn btn-brand h-9" onClick={() => setW({ tab: 'staff', handoff: true })}>
          <Headset size={15} /> Nhắn nhân viên
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <div className="flex gap-2">
          <BotAvatar />
          <div className="max-w-[85%] rounded-2xl rounded-tl-md bg-bg-2 px-3 py-2 text-[13px] leading-relaxed">
            Xin chào! Mình là <b>trợ lý AI của VNCoin</b>. Mình giải đáp về phí, loại lệnh, ví, bảo mật và xem giúp vì sao lệnh của bạn chưa khớp. Cần người thật thì bấm{' '}
            <b>Gặp nhân viên</b>.
          </div>
        </div>
        {!msgs.length && (
          <div className="flex flex-wrap gap-1.5 pl-9">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => void send(s)} className="rounded-full border border-line px-2.5 py-1 text-[12px] text-tx-2 hover:border-brand hover:text-brand">
                {s}
              </button>
            ))}
          </div>
        )}
        {msgs.map((m, i) => (
          <Bubble key={m.id} m={m} streaming={busy && i === msgs.length - 1} />
        ))}
        <div ref={end} />
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-1.5 text-[11px] text-tx-3">
        <span>AI có thể nhầm · không gửi mật khẩu, mã 2FA</span>
        <button className="flex shrink-0 items-center gap-1 font-medium text-brand hover:underline" onClick={() => setW({ tab: 'staff', handoff: true })}>
          <Headset size={13} /> Gặp nhân viên
        </button>
      </div>
      <AiComposer />
    </>
  );
}

/* ------------------------------ tab nhân viên ------------------------------ */

/** Chuyển nhân viên: tạo yêu cầu hỗ trợ, gửi kèm hội thoại với trợ lý AI (nếu có) */
function HandoffForm() {
  const msgs = useAiChat((s) => s.msgs);
  const setW = useChatWidget((s) => s.set);
  const call = useSupportCall();
  const firstQ = msgs.find((m) => m.role === 'user')?.content ?? '';
  const [category, setCategory] = useState<TicketCategory>('OTHER');
  const [note, setNote] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const transcript = transcriptOf(msgs, 3200);
  const ok = !!transcript || note.trim().length > 0;

  const submit = async () => {
    const subjectSrc = (note.trim() || firstQ).replace(/\s+/g, ' ').trim();
    const subject = subjectSrc.length >= 3 ? (subjectSrc.length > 80 ? `${subjectSrc.slice(0, 77)}…` : subjectSrc) : 'Cần nhân viên hỗ trợ';
    const message = [note.trim(), transcript && `— Hội thoại trước đó với trợ lý AI —\n${transcript}`].filter(Boolean).join('\n\n').slice(0, 4000);
    setBusy(true);
    const r = await call<TicketDetailDTO>('/support/tickets', { subject, category, message, urgent }, 'Đã chuyển cho nhân viên hỗ trợ');
    setBusy(false);
    if (r) setW({ handoff: false, ticketId: r.ticket.id });
  };

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-[13px]">
      <button className="flex items-center gap-1 text-[12px] text-tx-3 hover:text-tx-1" onClick={() => setW({ handoff: false })}>
        <ArrowLeft size={13} /> Quay lại
      </button>
      <div>
        <div className="text-[14px] font-semibold">Gặp nhân viên hỗ trợ</div>
        <p className="mt-0.5 text-[12px] text-tx-3">
          Nhân viên trả lời ngay trong hộp chat này và qua email.{transcript ? ' Hội thoại với trợ lý AI được gửi kèm để bạn không phải kể lại.' : ''}
        </p>
      </div>
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
      <label className="block">
        <span className="label">{transcript ? 'Bổ sung cho nhân viên (tuỳ chọn)' : 'Mô tả vấn đề'}</span>
        <textarea
          className="input mt-1 h-24 w-full resize-none py-2"
          value={note}
          maxLength={700}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Thời gian, cặp giao dịch, số lệnh, điều bạn thấy bất thường…"
        />
      </label>
      <label className="flex items-start gap-2 text-[12px] text-tx-2">
        <input type="checkbox" className="mt-0.5" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
        Khẩn cấp: nghi bị truy cập trái phép, mất tài sản
      </label>
      <button className="btn btn-brand h-9 w-full" disabled={!ok || busy} onClick={() => void submit()}>
        {busy ? 'Đang gửi…' : 'Gửi cho nhân viên'}
      </button>
    </div>
  );
}

function StaffTab() {
  const { ticketId, handoff, set: setW } = useChatWidget();
  const { data, isLoading } = useMyTickets();
  if (handoff) return <HandoffForm />;
  if (ticketId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <button className="flex items-center gap-1 border-b border-line px-3 py-1.5 text-[12px] text-tx-3 hover:text-tx-1" onClick={() => setW({ ticketId: null })}>
          <ArrowLeft size={13} /> Tất cả yêu cầu
        </button>
        <TicketConversation id={ticketId} compact />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <Spinner className="m-6" />
        ) : !data?.length ? (
          <Empty title="Chưa nhắn nhân viên lần nào" hint="Hỏi trợ lý AI trước cho nhanh, hoặc bấm Nhắn nhân viên bên dưới." />
        ) : (
          data.map((t) => (
            <button key={t.id} onClick={() => setW({ ticketId: t.id })} className="block w-full border-b border-line px-3 py-2.5 text-left hover:bg-bg-2">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[13px] font-medium">
                  #{t.id} {t.subject}
                </span>
                {t.unread > 0 && <span className="ml-auto rounded-full bg-brand px-1.5 text-[10px] font-bold text-[color:var(--brand-ink)]">{t.unread}</span>}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-[11px] text-tx-3">
                <TicketStatusPill status={t.status} />
                <span>{fmtDateTime(t.lastMessageAt)}</span>
              </div>
            </button>
          ))
        )}
      </div>
      <div className="border-t border-line p-2">
        <button className="btn btn-brand h-9 w-full" onClick={() => setW({ handoff: true })}>
          <Plus size={15} /> Nhắn nhân viên
        </button>
      </div>
    </div>
  );
}

/* ------------------------------ khung ------------------------------ */

const HIDDEN_ON = ['/ho-tro', '/cskh', '/admin'];

/** Hộp chat nổi góc phải: trợ lý AI trả lời ngay + nhắn nhân viên CSKH */
export function ChatWidget() {
  const user = useAuth((s) => s.user);
  const loc = useLocation();
  const { open, tab, set: setW } = useChatWidget();
  const unread = useSupportUnread();
  const bind = useAiChat((s) => s.bind);
  const reset = useAiChat((s) => s.reset);
  const hasMsgs = useAiChat((s) => s.msgs.length > 0);

  useEffect(() => {
    bind(user?.id ?? null);
  }, [user?.id, bind]);
  // Đóng bằng phím Esc
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setW({ open: false });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setW]);

  // Nhân viên dùng khu CSKH; trang hỗ trợ đầy đủ đã có khung chat riêng
  if (!user || isStaff(user.role) || HIDDEN_ON.some((p) => loc.pathname.startsWith(p))) return null;

  return (
    <>
      {open && (
        <section
          role="dialog"
          aria-label="Hỗ trợ VNCoin"
          className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-bg-1 sm:inset-auto sm:right-4 sm:bottom-24 sm:h-[min(620px,calc(100vh-140px))] sm:w-[390px] sm:rounded-2xl sm:border sm:border-line sm:shadow-2xl"
        >
          <header className="flex items-center gap-2.5 border-b border-line px-3 py-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-[color:var(--brand-ink)]">
              <Sparkles size={17} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold">Hỗ trợ VNCoin</div>
              <div className="flex items-center gap-1 text-[11px] text-tx-3">
                <span className="h-1.5 w-1.5 rounded-full bg-up" /> {tab === 'ai' ? 'Trợ lý AI · trả lời ngay' : 'Nhân viên CSKH · trả lời trong giờ làm việc'}
              </div>
            </div>
            {tab === 'ai' && hasMsgs && (
              <button className="rounded-md p-1.5 text-tx-3 hover:bg-bg-2 hover:text-tx-1" onClick={reset} title="Cuộc trò chuyện mới" aria-label="Cuộc trò chuyện mới">
                <RotateCcw size={16} />
              </button>
            )}
            <Link to="/ho-tro" className="rounded-md p-1.5 text-tx-3 hover:bg-bg-2 hover:text-tx-1" title="Mở trang hỗ trợ đầy đủ" aria-label="Mở trang hỗ trợ đầy đủ" onClick={() => setW({ open: false })}>
              <ExternalLink size={16} />
            </Link>
            <button className="rounded-md p-1.5 text-tx-3 hover:bg-bg-2 hover:text-tx-1" onClick={() => setW({ open: false })} aria-label="Đóng hộp chat">
              <X size={18} />
            </button>
          </header>
          <nav className="grid grid-cols-2 border-b border-line text-[13px]">
            {(
              [
                ['ai', 'Trợ lý AI', <Bot key="i" size={14} />],
                ['staff', 'Nhân viên', <Headset key="i" size={14} />],
              ] as const
            ).map(([id, label, icon]) => (
              <button
                key={id}
                onClick={() => setW({ tab: id })}
                className={cn('flex items-center justify-center gap-1.5 border-b-2 py-2 font-medium', tab === id ? 'border-brand text-tx-1' : 'border-transparent text-tx-3 hover:text-tx-2')}
              >
                {icon} {label}
                {id === 'staff' && unread > 0 && <span className="rounded-full bg-down px-1.5 text-[10px] font-bold text-white">{unread}</span>}
              </button>
            ))}
          </nav>
          <div className="flex min-h-0 flex-1 flex-col">{tab === 'ai' ? <AiTab /> : <StaffTab />}</div>
        </section>
      )}
      <button
        onClick={() => setW({ open: !open })}
        aria-label={open ? 'Đóng hộp chat hỗ trợ' : 'Mở hộp chat hỗ trợ'}
        className={cn(
          'fixed right-4 bottom-10 z-50 h-13 w-13 items-center justify-center rounded-full bg-brand text-[color:var(--brand-ink)] shadow-lg transition-transform hover:scale-105',
          open ? 'hidden sm:flex' : 'flex',
        )}
      >
        {open ? <X size={22} /> : <MessageCircle size={24} />}
        {!open && unread > 0 && (
          <span className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-down px-1 text-[11px] font-bold text-white">{unread}</span>
        )}
      </button>
    </>
  );
}
