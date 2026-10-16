import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { applyRules } from '@vss/shared';
import { Spinner } from './components/common/ui';
import { AppShell } from './components/layout/AppShell';
import { useRealtime } from './hooks/useRealtime';
import { useSessionSync } from './hooks/useSessionSync';
import { useSystemStatus } from './lib/admin';
import { BoardPage } from './pages/BoardPage';
import { useAuth } from './store/auth';
import { useUi } from './store/ui';

const TradePage = lazy(() => import('./pages/TradePage'));
const MarketPage = lazy(() => import('./pages/MarketPage'));
const PortfolioPage = lazy(() => import('./pages/PortfolioPage'));
const HistoryPage = lazy(() => import('./pages/HistoryPage'));
const AuthPage = lazy(() => import('./pages/AuthPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const LegalPage = lazy(() => import('./pages/LegalPage'));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'));
const VerifyEmailPage = lazy(() => import('./pages/VerifyEmailPage'));
const LeaderboardPage = lazy(() => import('./pages/LeaderboardPage'));
const ScreenerPage = lazy(() => import('./pages/ScreenerPage'));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000 } },
});

function RequireAuth({ children }: { children: ReactNode }) {
  const token = useAuth((s) => s.token);
  const loc = useLocation();
  if (!token) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

function Realtime() {
  useRealtime();
  useSessionSync();
  // Tham số giao dịch (phí, thuế, biên độ...) do quản trị viên chỉnh → dùng để tính trước trên giao diện
  const { data: system } = useSystemStatus();
  useEffect(() => {
    if (system?.rules) applyRules(system.rules);
  }, [system]);
  return null;
}

const fallback = (
  <div className="flex flex-1 items-center justify-center py-20">
    <Spinner />
  </div>
);

export function App() {
  const theme = useUi((s) => s.theme);
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Realtime />
        <Suspense fallback={fallback}>
          <Routes>
            <Route path="/login" element={<AuthPage mode="login" />} />
            <Route path="/register" element={<AuthPage mode="register" />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/verify-email" element={<VerifyEmailPage />} />
            <Route element={<AppShell />}>
              <Route index element={<BoardPage />} />
              <Route path="trade" element={<TradePage />} />
              <Route path="trade/:symbol" element={<TradePage />} />
              <Route path="market" element={<MarketPage />} />
              <Route path="xep-hang" element={<LeaderboardPage />} />
              <Route path="bo-loc" element={<ScreenerPage />} />
              <Route
                path="portfolio"
                element={
                  <RequireAuth>
                    <PortfolioPage />
                  </RequireAuth>
                }
              />
              <Route
                path="history"
                element={
                  <RequireAuth>
                    <HistoryPage />
                  </RequireAuth>
                }
              />
              <Route path="admin" element={<AdminPage />} />
              <Route path="dieu-khoan" element={<LegalPage kind="terms" />} />
              <Route path="chinh-sach-bao-mat" element={<LegalPage kind="privacy" />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
      <Toaster theme={theme} position="top-right" richColors closeButton duration={3500} />
    </QueryClientProvider>
  );
}
