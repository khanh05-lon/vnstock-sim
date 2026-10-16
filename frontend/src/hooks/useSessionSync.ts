import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { UserDTO } from '@vss/shared';
import { api } from '../lib/api';
import { useAuth } from '../store/auth';

/** Làm mới thông tin người dùng (xác thực email, 2FA, tuỳ chọn) từ máy chủ khi mở app / đổi phiên */
export function useSessionSync() {
  const token = useAuth((s) => s.token);
  const { data } = useQuery({
    queryKey: ['me', token],
    queryFn: () => api<{ user: UserDTO }>('/auth/me'),
    enabled: !!token,
    staleTime: 60_000,
  });
  useEffect(() => {
    const st = useAuth.getState();
    if (data?.user && st.token === token) st.setUser(data.user);
  }, [data, token]);
}
