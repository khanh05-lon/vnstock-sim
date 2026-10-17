import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import type { AiChatTurn, AiStatusDTO, AiStreamEvent } from '@vss/shared';
import { useAuth } from '../store/auth';
import { api, ApiError, errMsg } from './api';

/* ------------------------------ hộp chat nổi ------------------------------ */

export type ChatTab = 'ai' | 'staff';

/** Trạng thái hộp chat — chỗ khác (menu, trang lệnh) mở được hộp chat ở đúng tab */
export const useChatWidget = create<{
  open: boolean;
  tab: ChatTab;
  /** Yêu cầu hỗ trợ đang mở trong tab Nhân viên (null = danh sách) */
  ticketId: number | null;
  /** Đang điền form gặp nhân viên */
  handoff: boolean;
  show(tab?: ChatTab, ticketId?: number | null): void;
  set(p: Partial<{ open: boolean; tab: ChatTab; ticketId: number | null; handoff: boolean }>): void;
}>((set) => ({
  open: false,
  tab: 'ai',
  ticketId: null,
  handoff: false,
  show: (tab = 'ai', ticketId = null) => set({ open: true, tab, ticketId, handoff: false }),
  set: (p) => set(p),
}));

export const useAiStatus = () => {
  const token = useAuth((s) => s.token);
  return useQuery({ queryKey: ['support', 'ai-status'], queryFn: () => api<AiStatusDTO>('/support/ai'), enabled: !!token, staleTime: 5 * 60_000 });
};

/* ------------------------------ gọi trợ lý (stream NDJSON) ------------------------------ */

export async function streamAiReply(messages: AiChatTurn[], signal: AbortSignal, onText: (t: string) => void): Promise<void> {
  const token = useAuth.getState().token;
  let res: Response;
  try {
    res = await fetch('/api/support/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: JSON.stringify({ messages }),
      signal,
    });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new ApiError(0, 'NETWORK', 'Không kết nối được máy chủ');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    if (res.status === 401) useAuth.getState().logout();
    throw new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? `Lỗi ${res.status}`);
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const ev = JSON.parse(line) as AiStreamEvent;
      if ('t' in ev) onText(ev.t);
      else if ('error' in ev) throw new ApiError(502, 'AI_ERROR', ev.error);
    }
  }
}

/* ------------------------------ hội thoại với trợ lý ------------------------------ */

export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: number;
  /** Câu báo lỗi (không gửi lại cho trợ lý) */
  error?: boolean;
}

/** Hội thoại lưu theo tab trình duyệt (sessionStorage), tách theo tài khoản */
const keyOf = (uid: string) => `vss-ai-chat:${uid}`;
const newId = () => Math.random().toString(36).slice(2, 10);

function loadMsgs(uid: string | null): ChatMsg[] {
  if (!uid) return [];
  try {
    const v = JSON.parse(sessionStorage.getItem(keyOf(uid)) ?? '[]') as ChatMsg[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function saveMsgs(uid: string | null, msgs: ChatMsg[]) {
  if (!uid) return;
  try {
    sessionStorage.setItem(keyOf(uid), JSON.stringify(msgs.slice(-60)));
  } catch {
    /* bỏ qua */
  }
}

interface AiChatState {
  uid: string | null;
  msgs: ChatMsg[];
  busy: boolean;
  ctrl: AbortController | null;
  /** Đổi tài khoản → nạp hội thoại của tài khoản đó */
  bind(uid: string | null): void;
  send(text: string): Promise<void>;
  stop(): void;
  reset(): void;
}

export const useAiChat = create<AiChatState>((set, get) => ({
  uid: null,
  msgs: [],
  busy: false,
  ctrl: null,
  bind(uid) {
    if (uid === get().uid) return;
    get().ctrl?.abort();
    set({ uid, msgs: loadMsgs(uid), busy: false, ctrl: null });
  },
  async send(text) {
    const q = text.trim();
    if (!q || get().busy) return;
    const history: AiChatTurn[] = get()
      .msgs.filter((m) => !m.error && m.content)
      .map((m) => ({ role: m.role, content: m.content }));
    const user: ChatMsg = { id: newId(), role: 'user', content: q, at: Date.now() };
    const bot: ChatMsg = { id: newId(), role: 'assistant', content: '', at: Date.now() };
    const ctrl = new AbortController();
    set({ msgs: [...get().msgs, user, bot], busy: true, ctrl });
    const patch = (fn: (m: ChatMsg) => ChatMsg) => set({ msgs: get().msgs.map((m) => (m.id === bot.id ? fn(m) : m)) });
    try {
      await streamAiReply([...history, { role: 'user', content: q }], ctrl.signal, (t) => patch((m) => ({ ...m, content: m.content + t })));
    } catch (e) {
      if (!ctrl.signal.aborted) patch((m) => ({ ...m, content: errMsg(e), error: true }));
    }
    // Dừng giữa chừng khi chưa có chữ nào → bỏ khung trả lời rỗng
    if (ctrl.signal.aborted) set({ msgs: get().msgs.filter((m) => m.id !== bot.id || m.content) });
    if (get().ctrl === ctrl) set({ busy: false, ctrl: null });
    saveMsgs(get().uid, get().msgs);
  },
  stop() {
    get().ctrl?.abort();
  },
  reset() {
    get().ctrl?.abort();
    set({ msgs: [], busy: false, ctrl: null });
    saveMsgs(get().uid, []);
  },
}));

/** Đoạn hội thoại gửi kèm khi chuyển nhân viên (giữ phần mới nhất nếu quá dài) */
export function transcriptOf(msgs: ChatMsg[], max: number): string {
  const lines = msgs.filter((m) => !m.error && m.content).map((m) => `${m.role === 'user' ? 'Khách' : 'Trợ lý AI'}: ${m.content}`);
  let out = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = `${lines[i]}\n\n${out}`;
    if (next.length > max) break;
    out = next;
  }
  return out.trim();
}
