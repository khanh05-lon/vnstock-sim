import { create } from 'zustand';
import type { OrderType, Side } from '@vss/shared';

export type Theme = 'dark' | 'light';

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('vss-theme');
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* bỏ qua */
  }
  return 'dark';
}

interface UiState {
  theme: Theme;
  toggleTheme(): void;
}

export const useUi = create<UiState>((set, get) => ({
  theme: readTheme(),
  toggleTheme() {
    const theme: Theme = get().theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('vss-theme', theme);
    } catch {
      /* bỏ qua */
    }
    set({ theme });
  },
}));

/** Phiếu lệnh dùng chung giữa sổ lệnh (bấm giá) và form đặt lệnh */
interface TicketState {
  side: Side;
  orderType: OrderType;
  priceText: string;
  qtyText: string;
  setSide(s: Side): void;
  setOrderType(t: OrderType): void;
  setPriceText(t: string): void;
  setQtyText(t: string): void;
  pickPrice(price: number, side?: Side): void;
}

export const useTicket = create<TicketState>((set) => ({
  side: 'BUY',
  orderType: 'LO',
  priceText: '',
  qtyText: '',
  setSide: (side) => set({ side }),
  setOrderType: (orderType) => set({ orderType }),
  setPriceText: (priceText) => set({ priceText }),
  setQtyText: (qtyText) => set({ qtyText }),
  pickPrice: (price, side) => set((s) => ({ priceText: (price / 1000).toFixed(2), orderType: 'LO', side: side ?? s.side })),
}));
