import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  SquareCommentDTO,
  SquareConfigDTO,
  SquareFeedDTO,
  SquareMeDTO,
  SquareNotificationDTO,
  SquarePostDTO,
  SquareProfileDTO,
  SquareTrendDTO,
} from '@vss/shared';
import { api, errMsg } from './api';
import { useLoggedIn } from './queries';

/** Cộng đồng (kiểu Binance Square): hook dữ liệu. Mọi khoá query bắt đầu bằng 'square' để làm mới cùng lúc */

export type FeedTab = 'foryou' | 'latest' | 'following';
export interface FeedFilter {
  tab: FeedTab;
  coin?: string;
  tag?: string;
  author?: string;
}

const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export function useSquareConfig() {
  return useQuery({ queryKey: ['square', 'config'], queryFn: () => api<SquareConfigDTO>('/square/config'), staleTime: 60_000 });
}

export function useSquareMe() {
  const loggedIn = useLoggedIn();
  return useQuery({ queryKey: ['square', 'me'], queryFn: () => api<SquareMeDTO>('/square/me'), enabled: loggedIn });
}

export function useFeed(f: FeedFilter) {
  const loggedIn = useLoggedIn();
  return useInfiniteQuery({
    queryKey: ['square', 'feed', f, loggedIn],
    queryFn: ({ pageParam }) => api<SquareFeedDTO>(`/square/feed${qs({ tab: f.tab, coin: f.coin, tag: f.tag, author: f.author, before: pageParam ?? undefined })}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    refetchInterval: 60_000,
  });
}

export function usePost(id: number) {
  return useQuery({ queryKey: ['square', 'post', id], queryFn: () => api<SquarePostDTO>(`/square/posts/${id}`), retry: false });
}

export function useComments(id: number, enabled = true) {
  return useQuery({ queryKey: ['square', 'comments', id], queryFn: () => api<SquareCommentDTO[]>(`/square/posts/${id}/comments`), enabled });
}

export function useSquareProfile(handle: string) {
  return useQuery({ queryKey: ['square', 'profile', handle], queryFn: () => api<SquareProfileDTO>(`/square/users/${handle}`), retry: false });
}

export function useTrends(coin?: string) {
  return useQuery({
    queryKey: ['square', 'trends', coin ?? null],
    queryFn: () => api<SquareTrendDTO[]>(`/square/trends${qs({ coin })}`),
    staleTime: 60_000,
  });
}

export function useSuggestions() {
  return useQuery({
    queryKey: ['square', 'suggestions'],
    queryFn: () => api<{ handle: string; displayName: string; likes: number; followers: number }[]>('/square/suggestions'),
    staleTime: 60_000,
  });
}

export function useSquareNotifications(enabled: boolean) {
  return useQuery({ queryKey: ['square', 'notifications'], queryFn: () => api<SquareNotificationDTO[]>('/square/notifications'), enabled });
}

/** Gọi API ghi rồi làm mới mọi dữ liệu Cộng đồng; trả null khi lỗi (đã báo toast) */
export function useSquareAction() {
  const qc = useQueryClient();
  return async <T = unknown>(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown, success?: string): Promise<T | null> => {
    try {
      const res = await api<T>(path, { method, body });
      if (success) toast.success(success);
      void qc.invalidateQueries({ queryKey: ['square'] });
      return res;
    } catch (e) {
      toast.error(errMsg(e));
      return null;
    }
  };
}

/** Avatar chữ cái từ tên hiển thị (không dùng ảnh) */
export function initials(name: string) {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] ?? '?') + (w.length > 1 ? (w[w.length - 1]![0] ?? '') : '')).toUpperCase();
}

export function hueOf(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** "5 phút trước" */
export function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'vừa xong';
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86_400) return `${Math.floor(s / 3600)} giờ trước`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)} ngày trước`;
  return new Date(iso).toLocaleDateString('vi-VN');
}
