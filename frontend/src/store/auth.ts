import { create } from 'zustand';

export interface User {
  id: string;
  email: string;
  fullName: string;
  createdAt: string;
}

const KEY = 'vss-auth';

function load(): { token: string | null; user: User | null } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (typeof v?.token === 'string') return { token: v.token, user: v.user ?? null };
    }
  } catch {
    /* bỏ qua */
  }
  return { token: null, user: null };
}

interface AuthState {
  token: string | null;
  user: User | null;
  setAuth(token: string, user: User): void;
  setUser(user: User): void;
  logout(): void;
}

export const useAuth = create<AuthState>((set, get) => ({
  ...load(),
  setAuth(token, user) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ token, user }));
    } catch {
      /* bỏ qua */
    }
    set({ token, user });
  },
  setUser(user) {
    const { token } = get();
    if (token) get().setAuth(token, user);
  },
  logout() {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* bỏ qua */
    }
    set({ token: null, user: null });
  },
}));
