import { create } from 'zustand';
import type { Side } from '@vss/shared';

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

/** Loại form đặt lệnh (như Binance): Giới hạn / Thị trường / Stop-limit / OCO */
export type TicketKind = 'LIMIT' | 'MARKET' | 'STOP_LIMIT' | 'OCO';

/** Phiếu lệnh dùng chung: bấm giá trên sổ lệnh / lịch sử khớp → điền giá vào form */
interface TicketState {
  kind: TicketKind;
  /** Giá vừa chọn từ sổ lệnh (đổi nonce để form nhận lại cả khi bấm cùng một giá) */
  picked: { price: string; side: Side | null; nonce: number } | null;
  setKind(k: TicketKind): void;
  pickPrice(price: string, side?: Side): void;
}

export const useTicket = create<TicketState>((set) => ({
  kind: 'LIMIT',
  picked: null,
  setKind: (kind) => set({ kind }),
  pickPrice: (price, side) => set((s) => ({ picked: { price, side: side ?? null, nonce: (s.picked?.nonce ?? 0) + 1 }, kind: s.kind === 'MARKET' ? 'LIMIT' : s.kind })),
}));

/** Danh sách theo dõi đang chọn (nút ☆ thêm / bỏ cặp vào danh sách này) — nhớ theo trình duyệt */
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
