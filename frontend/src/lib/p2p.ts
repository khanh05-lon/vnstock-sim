import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BankAccountDTO,
  BankTransferDTO,
  MerchantAdminDTO,
  MerchantStatus,
  MyMerchantDTO,
  P2PAdDTO,
  P2PAsset,
  P2PConfigDTO,
  P2PMessageDTO,
  P2POrderDTO,
  P2PRules,
  P2PRulesPatch,
  PaymentMethodDTO,
} from '@vss/shared';
import { api } from './api';
import { useLoggedIn } from './queries';

/* Truy vấn chợ P2P, trung tâm thương nhân, ngân hàng giả lập. Sự kiện realtime 'p2p' làm mới ['p2p'] và ['bank'] */

export function useP2PConfig() {
  return useQuery({ queryKey: ['p2p', 'config'], queryFn: () => api<P2PConfigDTO>('/p2p/config'), staleTime: 30_000, refetchInterval: 60_000 });
}

export function useP2PAds(f: { side: 'BUY' | 'SELL'; asset: P2PAsset; fiatAmount?: string; bank?: string }) {
  const qs = new URLSearchParams({ side: f.side, asset: f.asset });
  if (f.fiatAmount) qs.set('fiatAmount', f.fiatAmount);
  if (f.bank) qs.set('bank', f.bank);
  return useQuery({ queryKey: ['p2p', 'ads', f], queryFn: () => api<P2PAdDTO[]>(`/p2p/ads?${qs}`), refetchInterval: 15_000, staleTime: 5_000 });
}

export function useMyMerchant() {
  const loggedIn = useLoggedIn();
  return useQuery({ queryKey: ['p2p', 'merchant'], queryFn: () => api<MyMerchantDTO>('/p2p/merchant'), enabled: loggedIn });
}

export function usePaymentMethods() {
  const loggedIn = useLoggedIn();
  return useQuery({ queryKey: ['p2p', 'payment-methods'], queryFn: () => api<PaymentMethodDTO[]>('/p2p/payment-methods'), enabled: loggedIn });
}

export function useMyAds(enabled = true) {
  const loggedIn = useLoggedIn();
  return useQuery({ queryKey: ['p2p', 'my-ads'], queryFn: () => api<P2PAdDTO[]>('/p2p/my-ads'), enabled: loggedIn && enabled });
}

export function useP2POrders(scope: 'open' | 'done' | 'all') {
  const loggedIn = useLoggedIn();
  return useQuery({ queryKey: ['p2p', 'orders', scope], queryFn: () => api<P2POrderDTO[]>(`/p2p/orders?scope=${scope}`), enabled: loggedIn });
}

export function useP2POrder(id: number | null) {
  return useQuery({
    queryKey: ['p2p', 'order', id],
    queryFn: () => api<P2POrderDTO>(`/p2p/orders/${id}`),
    enabled: !!id,
    // Dự phòng khi mất realtime: đơn đang chạy làm mới 10 giây / lần
    refetchInterval: (q) => (q.state.data && ['PENDING_PAYMENT', 'PAID', 'APPEAL'].includes(q.state.data.status) ? 10_000 : false),
  });
}

export function useP2PMessages(id: number | null) {
  return useQuery({ queryKey: ['p2p', 'messages', id], queryFn: () => api<P2PMessageDTO[]>(`/p2p/orders/${id}/messages`), enabled: !!id, refetchInterval: 15_000 });
}

export function useBank() {
  const loggedIn = useLoggedIn();
  return useQuery({ queryKey: ['bank', 'account'], queryFn: () => api<BankAccountDTO>('/bank'), enabled: loggedIn });
}

export function useBankStatement() {
  const loggedIn = useLoggedIn();
  return useQuery({ queryKey: ['bank', 'statement'], queryFn: () => api<BankTransferDTO[]>('/bank/statement'), enabled: loggedIn });
}

/** Làm mới mọi dữ liệu P2P + ngân hàng + ví sau một thao tác */
export function useInvalidateP2P() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['p2p'] });
    void qc.invalidateQueries({ queryKey: ['bank'] });
    void qc.invalidateQueries({ queryKey: ['account'] });
  };
}

/* ---------------- quản trị & CSKH ---------------- */

export function useAdminMerchants(status: MerchantStatus | 'ALL', enabled = true) {
  return useQuery({
    queryKey: ['admin', 'p2p', 'merchants', status],
    queryFn: () => api<MerchantAdminDTO[]>(`/admin/p2p/merchants?status=${status}`),
    enabled,
  });
}

export function useAdminP2POrders(status: string, enabled = true) {
  return useQuery({ queryKey: ['admin', 'p2p', 'orders', status], queryFn: () => api<P2POrderDTO[]>(`/admin/p2p/orders?status=${status}`), enabled });
}

export interface P2PRulesView {
  rules: P2PRules;
  defaults: P2PRules;
  overrides: P2PRulesPatch;
}

export function useAdminP2PRules() {
  return useQuery({ queryKey: ['admin', 'p2p', 'rules'], queryFn: () => api<P2PRulesView>('/admin/p2p/rules') });
}

export function useAppeals(scope: 'open' | 'resolved') {
  return useQuery({ queryKey: ['desk-p2p', 'appeals', scope], queryFn: () => api<P2POrderDTO[]>(`/support-desk/p2p/appeals?scope=${scope}`), refetchInterval: 30_000 });
}

export interface AppealDetail {
  order: P2POrderDTO;
  messages: P2PMessageDTO[];
  transfers: BankTransferDTO[];
  buyer: { email: string; accountNo: string | null };
  seller: { email: string; accountNo: string | null };
}

export function useAppealDetail(id: number | null) {
  return useQuery({ queryKey: ['desk-p2p', 'order', id], queryFn: () => api<AppealDetail>(`/support-desk/p2p/orders/${id}`), enabled: !!id });
}

/* ---------------- hiển thị ---------------- */

/** 1234567 → "1.234.567" (VNĐ, không ký hiệu) */
export const fmtVndNum = (v: string | number | null | undefined) => (v == null || v === '' ? '' : Math.round(Number(v)).toLocaleString('vi-VN'));

/** Số coin trên chợ P2P: bỏ số 0 thừa */
export const fmtCoin = (v: string | number, dp = 8) => Number(v).toLocaleString('en-US', { maximumFractionDigits: dp });

/** Giây → "2 phút 05 giây" / "45 giây" */
export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null) return '—';
  if (sec < 60) return `${Math.round(sec)} giây`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} phút`;
  return `${Math.floor(m / 60)} giờ ${m % 60} phút`;
}

export const fmtRate = (r: number | null | undefined) => (r == null ? '—' : `${(r * 100).toFixed(r === 1 ? 0 : 1)}%`);
