import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  AccountDTO,
  FillDTO,
  Kline,
  KlineInterval,
  LedgerDTO,
  MonthlyReportDTO,
  OrderDTO,
  PriceAlertDTO,
  PriceAlertInput,
  WatchlistDTO,
} from '@vss/shared';
import { useAuth } from '../store/auth';
import { useWatchSel } from '../store/ui';
import { api, errMsg } from './api';

export interface HistoryFilter {
  from?: string;
  to?: string;
  symbol?: string;
  side?: string;
  status?: string;
  asset?: string;
}

const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const useLoggedIn = () => useAuth((s) => !!s.token);

/* ------------------------------ thị trường ------------------------------ */

export function useKlines(symbol: string, interval: KlineInterval) {
  return useQuery({
    queryKey: ['klines', symbol, interval],
    queryFn: () => api<Kline[]>(`/market/klines/${symbol}${qs({ interval, limit: 500 })}`),
    staleTime: 30_000,
    enabled: !!symbol,
  });
}

/* ------------------------------ ví & lệnh ------------------------------ */

export function useAccount() {
  const loggedIn = useLoggedIn();
  return useQuery({ queryKey: ['account'], queryFn: () => api<AccountDTO>('/account'), enabled: loggedIn, staleTime: 5_000 });
}

/** Số dư khả dụng 1 tài sản (chuỗi thập phân, "0" nếu chưa có) */
export function useFree(asset: string | undefined): string {
  const { data } = useAccount();
  if (!asset) return '0';
  return data?.balances.find((b) => b.asset === asset)?.free ?? '0';
}

export function useOpenOrders(symbol?: string) {
  const loggedIn = useLoggedIn();
  return useQuery({
    queryKey: ['orders', 'open', symbol ?? null],
    queryFn: () => api<OrderDTO[]>(`/openOrders${qs({ symbol })}`),
    enabled: loggedIn,
  });
}

export function useOrderHistory(filter: HistoryFilter = {}, limit = 500) {
  const loggedIn = useLoggedIn();
  return useQuery({
    queryKey: ['orders', 'history', filter, limit],
    queryFn: () => api<OrderDTO[]>(`/orders${qs({ ...filter, limit })}`),
    enabled: loggedIn,
  });
}

export function useMyTrades(filter: HistoryFilter = {}, limit = 500) {
  const loggedIn = useLoggedIn();
  return useQuery({
    queryKey: ['trades', filter, limit],
    queryFn: () => api<FillDTO[]>(`/myTrades${qs({ ...filter, limit })}`),
    enabled: loggedIn,
  });
}

export function useLedger(filter: HistoryFilter = {}) {
  const loggedIn = useLoggedIn();
  return useQuery({
    queryKey: ['ledger', filter],
    queryFn: () => api<LedgerDTO[]>(`/ledger${qs({ from: filter.from, to: filter.to, asset: filter.asset })}`),
    enabled: loggedIn,
  });
}

export function useInvalidateTrading() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['orders'] });
    void qc.invalidateQueries({ queryKey: ['account'] });
    void qc.invalidateQueries({ queryKey: ['trades'] });
    void qc.invalidateQueries({ queryKey: ['ledger'] });
  };
}

/** Huỷ lệnh (huỷ 1 chân OCO là huỷ cả danh sách) */
export function useCancelOrder() {
  const invalidate = useInvalidateTrading();
  return async (o: Pick<OrderDTO, 'id' | 'symbol'>) => {
    try {
      await api(`/orders/${o.id}`, { method: 'DELETE' });
      toast.success(`Đã huỷ lệnh ${o.symbol}`);
    } catch (e) {
      toast.error(errMsg(e));
    }
    invalidate();
  };
}

export type NavRange = '7D' | '1M' | '3M' | '1Y' | 'ALL';

export interface NavHistory {
  points: { date: string; nav: number; contributed: number }[];
  benchmark: { date: string; value: number }[];
}

export function useNavHistory(range: NavRange) {
  const loggedIn = useLoggedIn();
  return useQuery({
    queryKey: ['nav-history', range],
    queryFn: () => api<NavHistory>(`/account/nav?range=${range}`),
    enabled: loggedIn,
    staleTime: 60_000,
  });
}

export function useMonthlyReport(year: number) {
  const loggedIn = useLoggedIn();
  return useQuery({
    queryKey: ['monthly-report', year],
    queryFn: () => api<MonthlyReportDTO>(`/reports/monthly?year=${year}`),
    enabled: loggedIn,
  });
}

export type LeaderboardPeriod = '1W' | '1M' | '3M' | 'ALL';

export interface Leaderboard {
  period: LeaderboardPeriod;
  updatedAt: string;
  total: number;
  rows: { rank: number; name: string; returnPct: number; nav: number; trades: number; topSymbol: string | null; isMe: boolean }[];
  me: { rank: number | null; hidden: boolean; returnPct: number; nav: number; name: string } | null;
}

export function useLeaderboard(period: LeaderboardPeriod) {
  const token = useAuth((s) => s.token);
  return useQuery({
    queryKey: ['leaderboard', period, !!token],
    queryFn: () => api<Leaderboard>(`/leaderboard?period=${period}`),
    refetchInterval: 60_000,
  });
}

/* ------------------------------ danh sách theo dõi ------------------------------ */

/** Các danh sách theo dõi + danh sách đang chọn (nút ☆ thao tác trên danh sách này) */
export function useWatchlists() {
  const loggedIn = useLoggedIn();
  const qc = useQueryClient();
  const activeId = useWatchSel((s) => s.activeId);
  const setActive = useWatchSel((s) => s.setActive);
  const query = useQuery({
    queryKey: ['watchlists'],
    queryFn: () => api<WatchlistDTO[]>('/watchlists'),
    enabled: loggedIn,
  });
  const lists = query.data ?? [];
  const active = lists.find((l) => l.id === activeId) ?? lists[0] ?? null;
  const refresh = () => qc.invalidateQueries({ queryKey: ['watchlists'] });

  const toggle = useMutation({
    mutationFn: async (symbol: string) => {
      if (!active) throw new Error('Chưa tải xong danh sách theo dõi');
      const has = active.symbols.includes(symbol);
      if (has) await api(`/watchlists/${active.id}/symbols/${symbol}`, { method: 'DELETE' });
      else await api(`/watchlists/${active.id}/symbols`, { method: 'POST', body: { symbol } });
      return { symbol, added: !has, list: active.name };
    },
    onMutate: async (symbol) => {
      await qc.cancelQueries({ queryKey: ['watchlists'] });
      const prev = qc.getQueryData<WatchlistDTO[]>(['watchlists']) ?? [];
      if (active) {
        qc.setQueryData<WatchlistDTO[]>(
          ['watchlists'],
          prev.map((l) => (l.id !== active.id ? l : { ...l, symbols: l.symbols.includes(symbol) ? l.symbols.filter((s) => s !== symbol) : [...l.symbols, symbol] })),
        );
      }
      return { prev };
    },
    onError: (e, _s, ctx) => {
      if (ctx) qc.setQueryData(['watchlists'], ctx.prev);
      toast.error(errMsg(e));
    },
    onSuccess: (r) => toast.success(r.added ? `Đã thêm ${r.symbol} vào "${r.list}"` : `Đã bỏ ${r.symbol} khỏi "${r.list}"`),
    onSettled: refresh,
  });

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      const out = await fn();
      toast.success(ok);
      await refresh();
      return out;
    } catch (e) {
      toast.error(errMsg(e));
      return null;
    }
  };

  return {
    loggedIn,
    lists,
    active,
    setActive: (id: number) => setActive(id),
    toggle: (s: string) => toggle.mutate(s),
    create: async (name: string) => {
      const l = (await run(() => api<WatchlistDTO>('/watchlists', { method: 'POST', body: { name } }), `Đã tạo danh sách "${name}"`)) as WatchlistDTO | null;
      if (l) setActive(l.id);
      return l;
    },
    rename: (id: number, name: string) => run(() => api(`/watchlists/${id}`, { method: 'PATCH', body: { name } }), `Đã đổi tên thành "${name}"`),
    remove: async (id: number) => {
      const r = await run(() => api(`/watchlists/${id}`, { method: 'DELETE' }), 'Đã xoá danh sách');
      if (r && id === active?.id) setActive(lists.find((l) => l.id !== id)?.id ?? null);
    },
  };
}

/** Rút gọn cho nút ☆: cặp trong danh sách đang chọn */
export function useWatchlist() {
  const w = useWatchlists();
  return { list: w.active?.symbols ?? [], listName: w.active?.name ?? 'Yêu thích', loggedIn: w.loggedIn, toggle: w.toggle };
}

/* ------------------------------ cảnh báo giá ------------------------------ */

export function useAlerts(symbol?: string) {
  const loggedIn = useLoggedIn();
  return useQuery({
    queryKey: ['alerts', symbol ?? null],
    queryFn: () => api<PriceAlertDTO[]>(`/alerts${qs({ scope: 'all', symbol })}`),
    enabled: loggedIn,
  });
}

export function useAlertActions() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['alerts'] });
  return {
    create: async (input: PriceAlertInput) => {
      const a = await api<PriceAlertDTO>('/alerts', { method: 'POST', body: input });
      await refresh();
      return a;
    },
    cancel: async (id: number) => {
      try {
        await api(`/alerts/${id}`, { method: 'DELETE' });
        toast.success('Đã huỷ cảnh báo');
      } catch (e) {
        toast.error(errMsg(e));
      }
      await refresh();
    },
  };
}
