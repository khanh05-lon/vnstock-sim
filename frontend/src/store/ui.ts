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

/** Danh sách theo dõi đang chọn (nút ☆ thêm / bỏ mã vào danh sách này) — nhớ theo trình duyệt */
interface WatchSelState {
  activeId: number | null;
  setActive(id: number | null): void;
}

function readActiveWatch(): number | null {
  try {
    const v = Number(localStorage.getItem('vss-watchlist'));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export const useWatchSel = create<WatchSelState>((set) => ({
  activeId: readActiveWatch(),
  setActive(activeId) {
    try {
      if (activeId) localStorage.setItem('vss-watchlist', String(activeId));
      else localStorage.removeItem('vss-watchlist');
    } catch {
      /* bỏ qua */
    }
    set({ activeId });
  },
}));
