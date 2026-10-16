import { create } from 'zustand';
import type { MarketStatus, SymbolRow, Ticker24h } from '@vss/shared';

interface MarketState {
  /** Cặp giao dịch kèm ticker 24h, theo mã cặp */
  rows: Record<string, SymbolRow>;
  /** Thứ tự hiển thị mặc định (sort_order của sàn) */
  symbols: string[];
  status: MarketStatus | null;
  connected: boolean;
  loaded: boolean;
  setInitial(rows: SymbolRow[]): void;
  applyTickers(list: Ticker24h[]): void;
  setStatus(s: MarketStatus): void;
  setConnected(v: boolean): void;
}

export const useMarket = create<MarketState>((set) => ({
  rows: {},
  symbols: [],
  status: null,
  connected: false,
  loaded: false,
  setInitial(list) {
    const rows: Record<string, SymbolRow> = {};
    for (const r of list) rows[r.symbol] = r;
    const symbols = [...list].sort((a, b) => a.sortOrder - b.sortOrder || a.symbol.localeCompare(b.symbol)).map((r) => r.symbol);
    set({ rows, symbols, loaded: true });
  },
  applyTickers(list) {
    set((st) => {
      if (!st.loaded) return st;
      const rows = { ...st.rows };
      for (const t of list) {
        const old = rows[t.symbol];
        if (old) rows[t.symbol] = { ...old, ...t };
      }
      return { rows };
    });
  },
  setStatus(status) {
    set({ status });
  },
  setConnected(connected) {
    set({ connected });
  },
}));

export const useSymbolRow = (symbol: string | undefined) => useMarket((s) => (symbol ? s.rows[symbol] : undefined));

/** Giá 1 đơn vị tài sản theo USDT (null khi không có cặp XXXUSDT) */
export function priceUsdtOf(rows: Record<string, SymbolRow>, asset: string): number | null {
  if (asset === 'USDT') return 1;
  const r = rows[`${asset}USDT`];
  return r ? Number(r.last) : null;
}
