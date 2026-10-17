import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { create } from 'zustand';
import { can, type AdjustRequestDTO, type AuthEventDTO, type BalanceDTO, type FillDTO, type LedgerDTO, type OrderDTO, type OrderEventDTO, type TicketDetailDTO, type TicketDTO } from '@vss/shared';
import { useAuth } from '../store/auth';
import { api, ApiError, errMsg } from './api';

/* ------------------------------ vé hỗ trợ (tài khoản bị khoá) ------------------------------ */

const PASS_KEY = 'vss-support-pass';
/** Máy chủ cấp vé 2 giờ; phía giao diện coi hết hạn sớm hơn một chút */
const PASS_TTL_MS = 115 * 60_000;

export interface SupportPass {
  token: string;
  email: string;
  expiresAt: number;
}

function loadPass(): SupportPass | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(PASS_KEY) ?? 'null') as SupportPass | null;
    return v && typeof v.token === 'string' && v.expiresAt > Date.now() ? v : null;
  } catch {
    return null;
  }
}

/** Email trong phần payload của JWT (chỉ để hiển thị, không kiểm chữ ký) */
function emailOf(token: string): string {
  try {
    const part = token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    return String((JSON.parse(atob(part)) as { email?: unknown }).email ?? '');
  } catch {
    return '';
  }
}

/** Vé hỗ trợ: tài khoản bị khoá chỉ dùng được mục Hỗ trợ. Lưu theo tab (sessionStorage), không lưu lâu dài */
export const useSupportPass = create<{ pass: SupportPass | null; set(token: string): void; clear(): void }>((set) => ({
  pass: loadPass(),
  set(token) {
    const pass = { token, email: emailOf(token), expiresAt: Date.now() + PASS_TTL_MS };
    try {
      sessionStorage.setItem(PASS_KEY, JSON.stringify(pass));
    } catch {
      /* bỏ qua */
    }
    set({ pass });
  },
  clear() {
    try {
      sessionStorage.removeItem(PASS_KEY);
    } catch {
      /* bỏ qua */
    }
    set({ pass: null });
  },
}));

/** Vé hỗ trợ đang dùng — chỉ khi không có phiên đăng nhập (đăng nhập bình thường luôn được ưu tiên) */
export function useSupportPassToken(): string | null {
  const token = useAuth((s) => s.token);
  const pass = useSupportPass((s) => s.pass);
  return !token && pass && pass.expiresAt > Date.now() ? pass.token : null;
}

/** Vé hết hạn / bị thu hồi (vd. đã đặt lại mật khẩu) → bỏ vé */
const dropPassOn401 = (e: unknown, pass: string | null) => {
  if (pass && e instanceof ApiError && e.status === 401) useSupportPass.getState().clear();
};

/* ------------------------------ khách hàng ------------------------------ */

/** Được vào khu CSKH (nhân viên CSKH, Rủi ro & giám sát, Quản trị hệ thống) */
export const useIsStaff = () => useAuth((s) => can(s.user?.role, 'support.desk'));

export function useMyTickets() {
  const token = useAuth((s) => s.token);
  const pass = useSupportPassToken();
  return useQuery({
    queryKey: ['support', 'mine', !!pass],
    queryFn: () => api<TicketDTO[]>('/support/tickets', { token: pass ?? undefined }).catch((e: unknown) => (dropPassOn401(e, pass), Promise.reject(e))),
    enabled: !!token || !!pass,
    // Vé hỗ trợ không có kênh realtime → hỏi lại thường xuyên hơn
    refetchInterval: pass ? 15_000 : 60_000,
  });
}

export function useMyTicket(id: number | null) {
  const qc = useQueryClient();
  const pass = useSupportPassToken();
  return useQuery({
    queryKey: ['support', 'ticket', id, !!pass],
    queryFn: async () => {
      const d = await api<TicketDetailDTO>(`/support/tickets/${id}`, { token: pass ?? undefined }).catch((e: unknown) => (dropPassOn401(e, pass), Promise.reject(e)));
      // Mở yêu cầu = đã đọc → cập nhật số chưa đọc trên danh sách / menu
      void qc.invalidateQueries({ queryKey: ['support', 'mine'] });
      return d;
    },
    enabled: !!id,
    refetchInterval: pass ? 10_000 : false,
  });
}

/** Tổng tin nhắn chưa đọc của khách (hiện trên nút Hỗ trợ) */
export function useSupportUnread() {
  const { data } = useMyTickets();
  return (data ?? []).reduce((s, t) => s + t.unread, 0);
}

/** Gọi API rồi làm mới dữ liệu hỗ trợ; lỗi → thông báo và trả null */
export function useSupportCall() {
  const qc = useQueryClient();
  const pass = useSupportPassToken();
  return async <T,>(path: string, body: unknown, ok?: string, method: 'POST' | 'PUT' = 'POST'): Promise<T | null> => {
    try {
      const r = await api<T>(path, { method, body, token: pass ?? undefined });
      if (ok) toast.success(ok);
      await qc.invalidateQueries({ queryKey: ['support'] });
      await qc.invalidateQueries({ queryKey: ['desk'] });
      return r;
    } catch (e) {
      dropPassOn401(e, pass);
      toast.error(errMsg(e));
      return null;
    }
  };
}

/* ------------------------------ nhân viên CSKH ------------------------------ */

export type DeskScope = 'active' | 'mine' | 'unassigned' | 'overdue' | 'all';

export interface DeskTicketDetail extends TicketDetailDTO {
  customer: {
    account: { balances: BalanceDTO[]; totalUsdt: string; contributedUsdt: string } | null;
    openOrders: OrderDTO[];
    recentOrders: OrderDTO[];
    recentFills: FillDTO[];
    recentLedger: LedgerDTO[];
    authEvents: AuthEventDTO[];
  };
  linkedOrder: { order: OrderDTO | null; events: OrderEventDTO[]; fills: FillDTO[] } | null;
}

export interface DeskStats {
  open: number;
  unassigned: number;
  mine: number;
  unread: number;
  overdue: number;
}

export function useDeskStats() {
  const staff = useIsStaff();
  return useQuery({ queryKey: ['desk', 'stats'], queryFn: () => api<DeskStats>('/support-desk/stats'), enabled: staff, refetchInterval: 30_000 });
}

export function useDeskTickets(scope: DeskScope, q: string) {
  return useQuery({
    queryKey: ['desk', 'tickets', scope, q],
    queryFn: () => api<TicketDTO[]>(`/support-desk/tickets?scope=${scope}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
    refetchInterval: 30_000,
  });
}

export function useDeskTicket(id: number | null) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['desk', 'ticket', id],
    queryFn: async () => {
      const d = await api<DeskTicketDetail>(`/support-desk/tickets/${id}`);
      void qc.invalidateQueries({ queryKey: ['desk', 'tickets'] });
      void qc.invalidateQueries({ queryKey: ['desk', 'stats'] });
      return d;
    },
    enabled: !!id,
  });
}

export function useDeskStaff() {
  return useQuery({
    queryKey: ['desk', 'staff'],
    queryFn: () => api<{ id: string; email: string; fullName: string; role: string }[]>('/support-desk/staff'),
    staleTime: 5 * 60_000,
  });
}

/* ------------------------------ nhật ký ------------------------------ */

export function useOrderEvents(path: string | null) {
  return useQuery({
    queryKey: ['order-events', path],
    queryFn: async () => {
      const r = await api<OrderEventDTO[] | { events: OrderEventDTO[]; fills: FillDTO[] }>(path!);
      return Array.isArray(r) ? { events: r, fills: [] as FillDTO[] } : r;
    },
    enabled: !!path,
  });
}

export function useAuthActivity(enabled: boolean) {
  return useQuery({ queryKey: ['auth-activity'], queryFn: () => api<AuthEventDTO[]>('/auth/activity'), enabled });
}

export function useAdjustRequests(status: 'PENDING' | 'ALL') {
  return useQuery({ queryKey: ['admin', 'adjust-requests', status], queryFn: () => api<AdjustRequestDTO[]>(`/admin/adjust-requests?status=${status}`), refetchInterval: 30_000 });
}
