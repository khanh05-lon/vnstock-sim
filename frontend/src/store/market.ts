import { create } from 'zustand';
import type { IndexSnapshot, SessionInfo, StockRow, StockSnapshot } from '@vss/shared';

interface MarketState {
  rows: Record<string, StockRow>;
  symbols: string[];
  indices: IndexSnapshot[];
  session: SessionInfo | null;
  connected: boolean;
  loaded: boolean;
  /** độ lệch đồng hồ server - client (ms) */
  clockSkew: number;
  setInitial(rows: StockRow[]): void;
  applyBoard(list: StockSnapshot[]): void;
  setIndices(list: IndexSnapshot[]): void;
  setSession(s: SessionInfo): void;
  setConnected(v: boolean): void;
}

export const useMarket = create<MarketState>((set) => ({
  rows: {},
  symbols: [],
  indices: [],
  session: null,
  connected: false,
  loaded: false,
  clockSkew: 0,
  setInitial(list) {
    const rows: Record<string, StockRow> = {};
    for (const r of list) rows[r.symbol] = r;
    set({ rows, symbols: list.map((r) => r.symbol).sort(), loaded: true });
  },
  applyBoard(list) {
    set((st) => {
      if (!st.loaded) return st;
      const rows = { ...st.rows };
      for (const u of list) {
        const old = rows[u.symbol];
        if (old) rows[u.symbol] = { ...old, ...u };
      }
      return { rows };
    });
  },
  setIndices(indices) {
    set({ indices });
  },
  setSession(session) {
    set({ session, clockSkew: session.serverTime - Date.now() });
  },
  setConnected(connected) {
    set({ connected });
  },
}));

export const useStock = (symbol: string | undefined) => useMarket((s) => (symbol ? s.rows[symbol] : undefined));
