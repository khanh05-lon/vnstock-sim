import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AccountDTO, Candle, HoldingDTO, LedgerDTO, OrderDTO, StockRow, TradeDTO, TradeTick } from '@vss/shared';
import { useAuth } from '../store/auth';
import { api, errMsg } from './api';

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '1D' | '1W' | '1M';

export interface PortfolioHolding extends HoldingDTO {
  marketPrice: number;
  marketValue: number;
}

export interface PortfolioResponse {
  account: AccountDTO;
  holdings: PortfolioHolding[];
  realizedPnl: number;
  totalFees: number;
  totalTaxes: number;
}

export interface HistoryFilter {
  from?: string;
  to?: string;
  symbol?: string;
  side?: string;
  status?: string;
}

const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const useLoggedIn = () => useAuth((s) => !!s.token);

export function useStockDetail(symbol: string) {
  return useQuery({
    queryKey: ['stock', symbol],
    queryFn: () => api<StockRow & { trades: TradeTick[] }>(`/market/stocks/${symbol}`),
    staleTime: 60_000,
  });
}

export function useCandles(symbol: string, tf: Timeframe) {
  const fetchTf: Timeframe = tf === '5m' || tf === '15m' || tf === '1h' ? '1m' : tf;
  return useQuery({
    queryKey: ['candles', symbol, fetchTf],
    queryFn: () => api<Candle[]>(`/market/stocks/${symbol}/candles?tf=${fetchTf}`),
    staleTime: 30_000,
  });
}

export function useIndexHistory(code: string, tf: '1m' | '1D') {
  return useQuery({
    queryKey: ['index-history', code, tf],
    queryFn: () => api<{ time: number; value: number }[]>(`/market/indices/${code}/history?tf=${tf}`),
    refetchInterval: tf === '1m' ? 60_000 : false,
  });
}

export function usePortfolio() {
  const loggedIn = useLoggedIn();
  return useQuery({
    queryKey: ['portfolio'],
    queryFn: () => api<PortfolioResponse>('/portfolio'),
    enabled: loggedIn,
  });
}

export function useOrders(scope: 'open' | 'today' | 'all', filter: HistoryFilter = {}) {
  const loggedIn = useLoggedIn();
  return useQuery({
    queryKey: ['orders', scope, filter],
    queryFn: () => api<OrderDTO[]>(`/orders${qs({ scope, ...filter })}`),
    enabled: loggedIn,
  });
}

export function useTrades(filter: HistoryFilter = {}) {
  const loggedIn = useLoggedIn();
  return useQuery({
    queryKey: ['trades', filter],
    queryFn: () => api<TradeDTO[]>(`/trades${qs({ ...filter })}`),
    enabled: loggedIn,
  });
}

export function useLedger(filter: HistoryFilter = {}) {
  const loggedIn = useLoggedIn();
  return useQuery({
    queryKey: ['ledger', filter],
    queryFn: () => api<LedgerDTO[]>(`/ledger${qs({ from: filter.from, to: filter.to })}`),
    enabled: loggedIn,
  });
}

export function useWatchlist() {
  const loggedIn = useLoggedIn();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['watchlist'],
    queryFn: () => api<string[]>('/watchlist'),
    enabled: loggedIn,
  });
  const toggle = useMutation({
    mutationFn: async (symbol: string) => {
      const has = (qc.getQueryData<string[]>(['watchlist']) ?? []).includes(symbol);
      if (has) await api(`/watchlist/${symbol}`, { method: 'DELETE' });
      else await api('/watchlist', { method: 'POST', body: { symbol } });
      return { symbol, added: !has };
    },
    onMutate: async (symbol) => {
      await qc.cancelQueries({ queryKey: ['watchlist'] });
      const prev = qc.getQueryData<string[]>(['watchlist']) ?? [];
      qc.setQueryData(['watchlist'], prev.includes(symbol) ? prev.filter((s) => s !== symbol) : [...prev, symbol]);
      return { prev };
    },
    onError: (e, _s, ctx) => {
      if (ctx) qc.setQueryData(['watchlist'], ctx.prev);
      toast.error(errMsg(e));
    },
    onSuccess: (r) => toast.success(r.added ? `Đã thêm ${r.symbol} vào danh sách theo dõi` : `Đã bỏ ${r.symbol} khỏi danh sách theo dõi`),
  });
  return { list: query.data ?? [], loggedIn, toggle: (s: string) => toggle.mutate(s) };
}

export function useInvalidateTrading() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['orders'] });
    void qc.invalidateQueries({ queryKey: ['portfolio'] });
    void qc.invalidateQueries({ queryKey: ['trades'] });
    void qc.invalidateQueries({ queryKey: ['ledger'] });
  };
}
