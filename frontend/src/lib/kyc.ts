import { useQuery } from '@tanstack/react-query';
import type { AmlAlertDTO, AmlReportDTO, AmlRules, AmlRulesPatch, KycApplicationDTO, MyKycDTO, P2POrderDTO, RestrictedAccountDTO } from '@vss/shared';
import { api } from './api';
import { useLoggedIn } from './queries';

/* Xác minh danh tính (KYC) của khách và khu Tuân thủ (KYC/AML). Sự kiện realtime 'kyc' làm mới ['kyc'] và ['me'] */

export function useMyKyc() {
  const loggedIn = useLoggedIn();
  return useQuery({ queryKey: ['kyc'], queryFn: () => api<MyKycDTO>('/kyc'), enabled: loggedIn });
}

export function useKycApplications(status: string, enabled = true) {
  return useQuery({ queryKey: ['admin', 'compliance', 'kyc', status], queryFn: () => api<KycApplicationDTO[]>(`/admin/compliance/kyc?status=${status}`), enabled });
}

export function useAmlAlerts(status: string, rule: string, enabled = true) {
  const qs = new URLSearchParams({ status });
  if (rule) qs.set('rule', rule);
  return useQuery({ queryKey: ['admin', 'compliance', 'alerts', status, rule], queryFn: () => api<AmlAlertDTO[]>(`/admin/compliance/alerts?${qs}`), enabled });
}

export interface ComplianceUser {
  user: {
    id: string;
    email: string;
    accountName: string;
    kycLevel: number;
    kycName: string | null;
    createdAt: string;
    merchantStatus: string | null;
    restricted: { at: string; reason: string; by: string } | null;
  };
  p2p30d: { boughtVnd: string; soldVnd: string; orders: number; counterparties: number };
  orders: P2POrderDTO[];
}

export function useComplianceUser(id: string | null) {
  return useQuery({ queryKey: ['admin', 'compliance', 'user', id], queryFn: () => api<ComplianceUser>(`/admin/compliance/users/${id}`), enabled: !!id });
}

export function useAmlReports(enabled = true) {
  return useQuery({ queryKey: ['admin', 'compliance', 'reports'], queryFn: () => api<AmlReportDTO[]>('/admin/compliance/reports'), enabled });
}

export function useRestricted(enabled = true) {
  return useQuery({ queryKey: ['admin', 'compliance', 'restricted'], queryFn: () => api<RestrictedAccountDTO[]>('/admin/compliance/restricted'), enabled });
}

export function useAmlRulesView(enabled = true) {
  return useQuery({
    queryKey: ['admin', 'compliance', 'rules'],
    queryFn: () => api<{ rules: AmlRules; defaults: AmlRules; overrides: AmlRulesPatch }>('/admin/compliance/rules'),
    enabled,
  });
}
