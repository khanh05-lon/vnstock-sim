import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AccountDTO, AuthEventDTO, LedgerDTO, OrderDTO, RulesPatch, SymbolFilters, TradingRules, UserRole } from '@vss/shared';
import { useAuth } from '../store/auth';
import { api, ApiError, errMsg } from './api';

export interface SystemStatus {
  announcement: { text: string; level: 'info' | 'warning' | 'critical'; updatedAt: string } | null;
  tradingHalted: boolean;
  haltReason: string;
  haltedSymbols: string[];
  /** Đang bảo trì (vd. khôi phục dữ liệu) */
  maintenance: string | null;
  /** Biểu phí đang áp dụng */
  rules: TradingRules;
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
  trades: { n: number; value: number; fee: number };
  totalNav: number;
  topInvestors: { id: string; email: string; fullName: string; nav: number; pnl: number; pnlPct: number }[];
  bottomInvestors: { id: string; email: string; fullName: string; nav: number; pnl: number; pnlPct: number }[];
  health: {
    source: string;
    feed: string;
    symbols: number;
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
  role: UserRole;
  status: 'ACTIVE' | 'LOCKED' | 'DELETED';
  lockedReason: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  online: boolean;
  /** Số dư USDT (khả dụng + khoá) */
  usdt: number;
  /** Tổng tài sản quy USDT */
  nav: number;
  pnl: number;
  pnlPct: number;
  ordersCount: number;
  tradesCount: number;
}

export interface AdminUserDetail {
  user: Pick<
    AdminUser,
    'id' | 'email' | 'fullName' | 'role' | 'status' | 'lockedReason' | 'createdAt' | 'lastSeenAt' | 'online' | 'emailVerified' | 'twoFactorEnabled'
  >;
  account: AccountDTO;
  stats: { trades: number; realized: number; fees: number; watch: number };
  orders: OrderDTO[];
  ledger: LedgerDTO[];
  audit: AuditRow[];
  authEvents: AuthEventDTO[];
}

export type AdminOrder = OrderDTO & { userId: string; userEmail: string };

export interface AdminMarket {
  market: { feed: 'LIVE' | 'SIM'; source: string; serverTime: number };
  source: string;
  status: SystemStatus;
  rules: TradingRules;
  symbols: { symbol: string; baseAsset: string; name: string; status: string }[];
}

export interface AdminSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  name: string;
  status: 'TRADING' | 'HALT' | 'BREAK';
  enabled: boolean;
  sortOrder: number;
  filters: SymbolFilters;
  halted: boolean;
  holders: number;
  openOrders: number;
  last: string | null;
  changePct: number | null;
  quoteVolume: string | null;
}

export interface RulesResponse {
  rules: TradingRules;
  defaults: TradingRules;
  overrides: RulesPatch;
}

export interface RestoreReport {
  dryRun: boolean;
  meta: { version: number; exportedAt: string; exportedBy: string; tradeDate: string };
  tables: { name: string; rows: number; ignoredColumns: string[] }[];
  symbolsAdded: string[];
  warnings: string[];
  autoBackupFile?: string;
}

export interface MonitorSample {
  t: number;
  rps: number;
  p95: number;
  errors: number;
  eventLoopMs: number;
  rssMb: number;
  sockets: number;
  dbMs: number | null;
  fills: number;
}

export interface AlertRow {
  id: number;
  key: string;
  level: 'warning' | 'critical';
  title: string;
  detail: string;
  started_at?: string;
  resolved_at?: string | null;
  since?: string;
  notified?: boolean;
}

export interface AdminMonitor {
  now: {
    requests5m: number;
    rps: number;
    p50: number;
    p95: number;
    p99: number;
    errors5m: number;
    errorRate: number;
    eventLoopMs: number;
    rssMb: number;
    heapMb: number;
    sockets: number;
    dbMs: number | null;
    dbOk: boolean;
    uptimeSec: number;
    tickAgeSec: number | null;
    http: { total: number; byClass: Record<string, number> };
    orders: { placed: number; cancelled: number; fills: number; fillValue: number };
    openOrders: number;
  };
  series: MonitorSample[];
  alerts: AlertRow[];
  history: AlertRow[];
  channels: { emails: string[]; webhook: string | null };
  thresholds: { eventLoopMs: number; p95Ms: number; rssMb: number; dbSlowMs: number; errorRate: number };
  metricsEndpoint: 'token' | 'off' | 'open';
}

export const useAdminMonitor = () =>
  useQuery({ queryKey: ['admin', 'monitor'], queryFn: () => api<AdminMonitor>('/admin/monitor'), refetchInterval: 10_000 });

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
  // Máy chủ đã báo vai trò USER → không cần gọi /admin/me (tránh lỗi 403 vô ích); quyền vẫn do máy chủ kiểm tra
  const knownUser = useAuth((s) => s.user?.role === 'USER');
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
    enabled: !!token && !knownUser,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return { isAdmin: !!token && !knownUser && q.data === true, loading: !!token && !knownUser && q.isLoading };
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

export const useAdminSymbols = () =>
  useQuery({ queryKey: ['admin', 'symbols'], queryFn: () => api<AdminSymbol[]>('/admin/symbols'), refetchInterval: 15_000 });

export const useAdminRules = () => useQuery({ queryKey: ['admin', 'rules'], queryFn: () => api<RulesResponse>('/admin/rules') });

/** Gửi file sao lưu lên để khôi phục (dryRun = chỉ chạy thử, không ghi) */
export async function uploadRestore(file: File, dryRun: boolean): Promise<RestoreReport> {
  const token = useAuth.getState().token;
  const res = await fetch(`/api/admin/data/restore${dryRun ? '?dryRun=1' : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: file,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message ?? `Lỗi ${res.status}`);
  return data as RestoreReport;
}

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
  return async <T = unknown>(path: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body: unknown, success: string): Promise<T | null> => {
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
  USER_VERIFY_EMAIL: 'Xác thực email hộ',
  USER_RESET_2FA: 'Tắt 2FA hộ',
  ROLE_GRANT_ADMIN: 'Cấp quyền quản trị',
  ROLE_REVOKE_ADMIN: 'Thu quyền quản trị',
  ROLE_SET: 'Đổi vai trò',
  USER_VIEW: 'Xem hồ sơ khách',
  USER_PURGE: 'Xoá hẳn tài khoản thử',
  BALANCE_ADJUST_REQUEST: 'Đề xuất điều chỉnh số dư',
  BALANCE_ADJUST_APPROVE: 'Duyệt điều chỉnh số dư',
  BALANCE_ADJUST_REJECT: 'Từ chối điều chỉnh số dư',
  ACCOUNT_RESET: 'Đặt lại tài khoản ảo',
  CASH_ADJUST: 'Điều chỉnh vốn ảo',
  BALANCE_ADJUST: 'Điều chỉnh số dư',
  ORDER_CANCEL: 'Huỷ lệnh hộ',
  TRADING_HALT: 'Tạm ngừng nhận lệnh',
  TRADING_RESUME: 'Mở lại nhận lệnh',
  SYMBOL_HALT: 'Tạm ngừng cặp',
  SYMBOL_RESUME: 'Mở lại cặp',
  ANNOUNCEMENT_SET: 'Đăng thông báo',
  ANNOUNCEMENT_CLEAR: 'Gỡ thông báo',
  HOLIDAY_ADD: 'Thêm ngày nghỉ',
  HOLIDAY_REMOVE: 'Xoá ngày nghỉ',
  DATA_EXPORT: 'Xuất bản sao lưu',
  DATA_RESTORE: 'Khôi phục dữ liệu',
  ALERT_TEST: 'Gửi thử cảnh báo',
  CA_CREATE: 'Công bố sự kiện quyền',
  CA_CANCEL: 'Huỷ sự kiện quyền',
  CREDIT_LIMIT: 'Đổi hạn mức vay ký quỹ',
  RULES_UPDATE: 'Đổi biểu phí',
  RULES_RESET: 'Khôi phục biểu phí mặc định',
  SYMBOL_LIST: 'Thêm cặp giao dịch',
  SYMBOL_UPDATE: 'Sửa thông tin cặp',
  SYMBOL_DELIST: 'Gỡ cặp khỏi sàn',
  VN30_ADD: 'Thêm vào VN30',
  VN30_REMOVE: 'Đưa khỏi VN30',
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
  if (typeof d.amount === 'number') parts.push(`${d.amount > 0 ? '+' : ''}${d.amount.toLocaleString('en-US')}`);
  if (typeof d.amount === 'string' && typeof d.asset === 'string') parts.push(`${d.amount.startsWith('-') ? '' : '+'}${d.amount} ${d.asset}`);
  if (typeof d.symbol === 'string') parts.push(`${d.symbol}`);
  if (a.target_type === 'symbol' && a.target_id) parts.push(a.target_id);
  if (a.action === 'RULES_UPDATE' && d.patch && typeof d.patch === 'object') parts.push(Object.keys(d.patch as object).join(', '));
  if (a.target_type === 'holiday' && a.target_id) parts.push(`${a.target_id}${typeof d.name === 'string' ? ` · ${d.name}` : ''}`);
  if (a.target_type === 'order' && a.target_id) parts.push(`lệnh #${a.target_id}`);
  if (typeof d.text === 'string') parts.push(`"${d.text}"`);
  if (typeof d.reason === 'string' && d.reason) parts.push(`lý do: ${d.reason}`);
  if (typeof d.cancelledOrders === 'number' && d.cancelledOrders) parts.push(`huỷ ${d.cancelledOrders} lệnh`);
  if (typeof d.canceledOrders === 'number' && d.canceledOrders) parts.push(`huỷ ${d.canceledOrders} lệnh`);
  return parts.join(' · ');
}
