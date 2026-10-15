import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { HoldingDTO, LedgerDTO, OrderDTO } from '@vss/shared';
import { useAuth } from '../store/auth';
import { api, ApiError, errMsg } from './api';

export interface SystemStatus {
  announcement: { text: string; level: 'info' | 'warning' | 'critical'; updatedAt: string } | null;
  tradingHalted: boolean;
  haltReason: string;
  haltedSymbols: string[];
}

export interface AuditRow {
  id: number;
  admin_email: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface AdminOverview {
  tradeDate: string;
  users: { total: number; new7d: number; locked: number; admins: number; active15m: number; online: number; connections: number };
  orders: Record<string, number>;
  trades: { n: number; value: number; fee: number; tax: number };
  totalNav: number;
  topInvestors: { id: string; email: string; fullName: string; nav: number; pnl: number; pnlPct: number }[];
  bottomInvestors: { id: string; email: string; fullName: string; nav: number; pnl: number; pnlPct: number }[];
  health: {
    phase: string;
    mode: string;
    provider: string;
    feed: string;
    uptimeSec: number;
    rssBytes: number;
    heapBytes: number;
    node: string;
    dbKind: string;
    dbBytes: number;
    openOrders: number;
  };
  status: SystemStatus;
  recentAudit: AuditRow[];
}

export interface AdminUser {
  id: string;
  email: string;
  fullName: string;
  role: 'USER' | 'ADMIN';
  status: 'ACTIVE' | 'LOCKED';
  lockedReason: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  online: boolean;
  cashBalance: number;
  cashHold: number;
  nav: number;
  pnl: number;
  pnlPct: number;
  ordersCount: number;
  tradesCount: number;
}

export interface AdminUserDetail {
  user: Pick<AdminUser, 'id' | 'email' | 'fullName' | 'role' | 'status' | 'lockedReason' | 'createdAt' | 'lastSeenAt' | 'online'>;
  account: { cashBalance: number; cashHold: number; cashAvailable: number; initialCapital: number; stockValue: number; nav: number } | null;
  stats: { trades: number; realized: number; fees: number; watch: number };
  holdings: (HoldingDTO & { marketPrice: number; marketValue: number })[];
  orders: OrderDTO[];
  ledger: LedgerDTO[];
  audit: AuditRow[];
}

export type AdminOrder = OrderDTO & { userId: string; userEmail: string };

export interface AdminMarket {
  session: { mode: string; phase: string; tradeDate: string; serverTime: number };
  provider: string;
  feed: string;
  status: SystemStatus;
  holidays: { date: string; name: string }[];
  rules: {
    priceLimitPct: Record<string, number>;
    lotSize: number;
    maxOrderQty: Record<string, number>;
    feeRate: number;
    sellTaxRate: number;
    initialCapital: number;
    orderTypes: Record<string, string[]>;
    settlementDays: number;
    tickIntervalMs: number;
  };
  symbols: { symbol: string; exchange: string; name: string }[];
}

export interface AdminData {
  db: { kind: string; location: string | null; sizeBytes: number };
  tables: { name: string; group: string; desc: string; rows: number }[];
  memory: { rssBytes: number; stocks: number; openOrders: number; lockedUsers: number; logLines: number };
}

export interface LogLine {
  time: string;
  stream: 'out' | 'err';
  text: string;
}

/** Người đang đăng nhập có phải quản trị viên? (403 → không) */
export function useAdminMe() {
  const token = useAuth((s) => s.token);
  const q = useQuery({
    queryKey: ['admin', 'me', token],
    queryFn: async () => {
      try {
        await api('/admin/me');
        return true;
      } catch (e) {
        if (e instanceof ApiError && (e.status === 403 || e.status === 401)) return false;
        throw e;
      }
    },
    enabled: !!token,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return { isAdmin: !!token && q.data === true, loading: !!token && q.isLoading };
}

export function useSystemStatus() {
  return useQuery({
    queryKey: ['system'],
    queryFn: () => api<SystemStatus>('/system'),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

export const useAdminOverview = () =>
  useQuery({ queryKey: ['admin', 'overview'], queryFn: () => api<AdminOverview>('/admin/overview'), refetchInterval: 10_000 });

export const useAdminUsers = (params: { q?: string; status?: string; role?: string }) =>
  useQuery({
    queryKey: ['admin', 'users', params],
    queryFn: () => api<AdminUser[]>(`/admin/users?${new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][])}`),
  });

export const useAdminUser = (id: string | null) =>
  useQuery({ queryKey: ['admin', 'user', id], queryFn: () => api<AdminUserDetail>(`/admin/users/${id}`), enabled: !!id });

export const useAdminOrders = (params: Record<string, string | undefined>) =>
  useQuery({
    queryKey: ['admin', 'orders', params],
    queryFn: () => api<AdminOrder[]>(`/admin/orders?${new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][])}`),
    refetchInterval: 15_000,
  });

export const useAdminMarket = () => useQuery({ queryKey: ['admin', 'market'], queryFn: () => api<AdminMarket>('/admin/market') });

export const useAdminData = () => useQuery({ queryKey: ['admin', 'data'], queryFn: () => api<AdminData>('/admin/data') });

export const useAdminAudit = (action?: string) =>
  useQuery({
    queryKey: ['admin', 'audit', action],
    queryFn: () => api<AuditRow[]>(`/admin/audit?limit=300${action ? `&action=${action}` : ''}`),
    refetchInterval: 15_000,
  });

export const useAdminLogs = (live: boolean) =>
  useQuery({ queryKey: ['admin', 'logs'], queryFn: () => api<LogLine[]>('/admin/logs?limit=300'), refetchInterval: live ? 3000 : false });

/** Gọi 1 thao tác quản trị: báo kết quả + làm mới dữ liệu quản trị */
export function useAdminAction() {
  const qc = useQueryClient();
  return async <T = unknown>(path: string, method: 'POST' | 'PUT' | 'DELETE', body: unknown, success: string): Promise<T | null> => {
    try {
      const res = await api<T>(path, { method, body });
      toast.success(success);
      await qc.invalidateQueries({ queryKey: ['admin'] });
      void qc.invalidateQueries({ queryKey: ['system'] });
      return res;
    } catch (e) {
      toast.error(errMsg(e));
      return null;
    }
  };
}

/** Tải bản sao lưu JSON (cần header Authorization nên không dùng link thường) */
export async function downloadBackup() {
  const token = useAuth.getState().token;
  const res = await fetch('/api/admin/data/export', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error?.message ?? `Lỗi ${res.status}`);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'vnstock-backup.json';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return { name, size: blob.size };
}

export const AUDIT_LABEL: Record<string, string> = {
  USER_LOCK: 'Khoá tài khoản',
  USER_UNLOCK: 'Mở khoá tài khoản',
  USER_DELETE: 'Xoá tài khoản',
  USER_CREATE: 'Tạo tài khoản',
  ROLE_GRANT_ADMIN: 'Cấp quyền quản trị',
  ROLE_REVOKE_ADMIN: 'Thu quyền quản trị',
  ACCOUNT_RESET: 'Đặt lại tài khoản ảo',
  CASH_ADJUST: 'Điều chỉnh vốn ảo',
  ORDER_CANCEL: 'Huỷ lệnh hộ',
  TRADING_HALT: 'Tạm ngừng nhận lệnh',
  TRADING_RESUME: 'Mở lại nhận lệnh',
  SYMBOL_HALT: 'Tạm ngừng mã',
  SYMBOL_RESUME: 'Mở lại mã',
  ANNOUNCEMENT_SET: 'Đăng thông báo',
  ANNOUNCEMENT_CLEAR: 'Gỡ thông báo',
  HOLIDAY_ADD: 'Thêm ngày nghỉ',
  HOLIDAY_REMOVE: 'Xoá ngày nghỉ',
  DATA_EXPORT: 'Xuất bản sao lưu',
};

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function fmtDuration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} ngày ${h} giờ` : h ? `${h} giờ ${m} phút` : `${m} phút ${sec % 60} giây`;
}

/** Tóm tắt chi tiết 1 dòng nhật ký quản trị */
export function auditSummary(a: AuditRow): string {
  const d = a.detail ?? {};
  const parts: string[] = [];
  if (typeof d.email === 'string') parts.push(d.email);
  if (typeof d.amount === 'number') parts.push(`${d.amount > 0 ? '+' : ''}${d.amount.toLocaleString('en-US')}đ`);
  if (typeof d.symbol === 'string') parts.push(`${d.symbol}`);
  if (a.target_type === 'symbol' && a.target_id) parts.push(a.target_id);
  if (a.target_type === 'holiday' && a.target_id) parts.push(`${a.target_id}${typeof d.name === 'string' ? ` · ${d.name}` : ''}`);
  if (a.target_type === 'order' && a.target_id) parts.push(`lệnh #${a.target_id}`);
  if (typeof d.text === 'string') parts.push(`"${d.text}"`);
  if (typeof d.reason === 'string' && d.reason) parts.push(`lý do: ${d.reason}`);
  if (typeof d.cancelledOrders === 'number' && d.cancelledOrders) parts.push(`huỷ ${d.cancelledOrders} lệnh`);
  return parts.join(' · ');
}
