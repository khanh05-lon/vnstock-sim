import { useQuery } from '@tanstack/react-query';
import type { PrivacyRequestDTO, VipStatusDTO } from '@vss/shared';
import { api } from './api';
import { useLoggedIn } from './queries';

/** "0.00025" → "0,025%" (biểu phí hiển thị tới 3 chữ số lẻ như Binance) */
export const fmtFeePct = (v: string | number) => `${(Number(v) * 100).toLocaleString('vi-VN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}%`;

export function useFeeSchedule() {
  return useQuery({
    queryKey: ['fees'],
    queryFn: () => api<{ scale: number; bnbDiscount: string; tiers: VipStatusDTO['tiers'] }>('/fees'),
    staleTime: 60_000,
  });
}

export function useMyVip() {
  const loggedIn = useLoggedIn();
  return useQuery({ queryKey: ['vip'], queryFn: () => api<VipStatusDTO>('/vip'), enabled: loggedIn });
}

export function useMyPrivacyRequests() {
  const loggedIn = useLoggedIn();
  return useQuery({ queryKey: ['privacy'], queryFn: () => api<PrivacyRequestDTO[]>('/privacy/requests'), enabled: loggedIn });
}
