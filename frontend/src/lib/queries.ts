import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AccountDTO, Candle, ConditionalOrderDTO, HoldingDTO, LedgerDTO, OrderDTO, StockRow, TradeDTO, TradeTick } from '@vss/shared';
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

export function useConditionalOrders(scope: 'active' | 'all') {
  const loggedIn = useLoggedIn();
  return useQuery({
    queryKey: ['conditional', scope],
    queryFn: () => api<ConditionalOrderDTO[]>(`/conditional-orders?scope=${scope}`),
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
    void qc.invalidateQueries({ queryKey: ['conditional'] });
    void qc.invalidateQueries({ queryKey: ['entitlements'] });
    void qc.invalidateQueries({ queryKey: ['buying-power'] });
  };
}

export type NavRange = '1M' | '3M' | '6M' | '1Y' | 'ALL';

export interface NavHistory {
  points: { date: string; nav: number; cash: number; stock: number; debt: number; contributed: number }[];
  benchmark: { date: string; value: number }[];
}

export function useNavHistory(range: NavRange) {
  const loggedIn = useLoggedIn();
  return useQuery({
    queryKey: ['nav-history', range],
    queryFn: () => api<NavHistory>(`/portfolio/nav?range=${range}`),
    enabled: loggedIn,
    staleTime: 60_000,
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

export type CaType = 'CASH_DIVIDEND' | 'STOCK_DIVIDEND' | 'SPLIT' | 'RIGHTS';

export interface CorporateAction {
  id: number;
  symbol: string;
  type: CaType;
  label: string;
  exDate: string;
  recordDate: string;
  payDate: string;
  cashPerShare: number | null;
  ratioFrom: number | null;
  ratioTo: number | null;
  issuePrice: number | null;
  subscribeUntil: string | null;
  status: 'ANNOUNCED' | 'EX_DONE' | 'COMPLETED' | 'CANCELLED';
  refBefore: number | null;
  refAfter: number | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  holders?: number;
}

export interface Entitlement {
  id: number;
  action: CorporateAction;
  qtyHeld: number;
  cashAmount: number;
  taxAmount: number;
  shares: number;
  subscribed: number;
  status: 'PENDING' | 'PAID' | 'CANCELLED';
  paidAt: string | null;
}

export function useEntitlements() {
  const loggedIn = useLoggedIn();
  return useQuery({ queryKey: ['entitlements'], queryFn: () => api<Entitlement[]>('/entitlements'), enabled: loggedIn });
}

export function useCorporateActions(opts: { upcoming?: boolean; symbol?: string } = {}) {
  return useQuery({
    queryKey: ['corporate-actions', opts],
    queryFn: () => api<CorporateAction[]>(`/corporate-actions${qs({ upcoming: opts.upcoming ? '1' : undefined, symbol: opts.symbol })}`),
    staleTime: 60_000,
  });
}

/** Mô tả ngắn 1 sự kiện quyền: "Cổ tức 2.000đ/CP", "Chia tách 1:2", "Quyền mua 4:1 giá 10.000đ" */
export function describeAction(a: Pick<CorporateAction, 'type' | 'cashPerShare' | 'ratioFrom' | 'ratioTo' | 'issuePrice'>): string {
  const n = (v: number | null) => (v ?? 0).toLocaleString('en-US');
  if (a.type === 'CASH_DIVIDEND') return `Cổ tức tiền ${n(a.cashPerShare)}đ/CP`;
  if (a.type === 'STOCK_DIVIDEND') return `Cổ tức / thưởng cổ phiếu ${a.ratioFrom}:${a.ratioTo}`;
  if (a.type === 'SPLIT') return `Chia tách ${a.ratioFrom}:${a.ratioTo}`;
  return `Quyền mua ${a.ratioFrom}:${a.ratioTo} giá ${n(a.issuePrice)}đ`;
}

/** Tài sản ròng = tiền mặt + tiền bán chờ về + cổ phiếu + quyền chờ về − nợ ký quỹ (gốc + lãi) */
export function navOfAccount(a: AccountDTO, stockValue: number): number {
  return a.cashBalance + (a.cashPending ?? 0) + stockValue + (a.rightsValue ?? 0) - (a.loanBalance ?? 0) - (a.loanInterest ?? 0);
}

export interface BuyingPower {
  maxQty: number;
  cashOnlyQty: number;
  usesAdvance: boolean;
  usesMargin: boolean;
  loanPart: number;
  marginRatio: number;
}

export function useBuyingPower(symbol: string, price: number | null, enabled: boolean) {
  const loggedIn = useLoggedIn();
  return useQuery({
    queryKey: ['buying-power', symbol, price],
    queryFn: () => api<BuyingPower>(`/account/buying-power?symbol=${symbol}&price=${price}`),
    enabled: loggedIn && enabled && !!price && price > 0,
    staleTime: 5_000,
  });
}

export interface AdvancePreview {
  gross: number;
  fee: number;
  maxNet: number;
  items: { id: number; settleDate: string; available: number; days: number; fee: number }[];
}
