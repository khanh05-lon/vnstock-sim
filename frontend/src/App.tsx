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
import { MarketsPage } from './pages/MarketsPage';
import { useAuth } from './store/auth';
import { useUi } from './store/ui';

const TradePage = lazy(() => import('./pages/TradePage'));
const WalletPage = lazy(() => import('./pages/WalletPage'));
const HistoryPage = lazy(() => import('./pages/HistoryPage'));
const AuthPage = lazy(() => import('./pages/AuthPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const LegalPage = lazy(() => import('./pages/LegalPage'));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'));
const VerifyEmailPage = lazy(() => import('./pages/VerifyEmailPage'));
const LeaderboardPage = lazy(() => import('./pages/LeaderboardPage'));
const LandingPage = lazy(() => import('./pages/LandingPage'));
const SupportPage = lazy(() => import('./pages/SupportPage'));
const LockedSupportPage = lazy(() => import('./pages/SupportPage').then((m) => ({ default: m.LockedSupportPage })));
const SupportDeskPage = lazy(() => import('./pages/SupportDeskPage'));
const P2PPage = lazy(() => import('./pages/P2PPage'));
const P2POrdersPage = lazy(() => import('./pages/P2POrdersPage'));
const P2POrderPage = lazy(() => import('./pages/P2POrderPage'));
const MerchantCenterPage = lazy(() => import('./pages/MerchantCenterPage'));
const BankPage = lazy(() => import('./pages/BankPage'));
const KycPage = lazy(() => import('./pages/KycPage'));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000 } },
});

function RequireAuth({ children }: { children: ReactNode }) {
  const token = useAuth((s) => s.token);
  const loc = useLocation();
  if (!token) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

/** Trang chủ: khách chưa đăng nhập xem trang giới thiệu, người đã đăng nhập xem thị trường (thị trường luôn có ở /thi-truong) */
function Home() {
  const token = useAuth((s) => s.token);
  return token ? <AppShell /> : <LandingPage />;
}

function Realtime() {
  useRealtime();
  useSessionSync();
  // Biểu phí do quản trị viên chỉnh → dùng để tính trước trên giao diện
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
            <Route path="/gioi-thieu" element={<LandingPage />} />
            <Route path="/login" element={<AuthPage mode="login" />} />
            <Route path="/register" element={<AuthPage mode="register" />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/verify-email" element={<VerifyEmailPage />} />
            {/* Tài khoản bị khoá nhắn CSKH bằng vé hỗ trợ (không cần phiên đăng nhập) */}
            <Route path="/ho-tro-khoa" element={<LockedSupportPage />} />
            <Route path="/" element={<Home />}>
              <Route index element={<MarketsPage />} />
            </Route>
            <Route element={<AppShell />}>
              <Route path="thi-truong" element={<MarketsPage />} />
              <Route path="trade" element={<TradePage />} />
              <Route path="trade/:symbol" element={<TradePage />} />
              <Route path="xep-hang" element={<LeaderboardPage />} />
              {/* Chợ P2P: xem quảng cáo không cần đăng nhập */}
              <Route path="p2p" element={<P2PPage />} />
              <Route
                path="p2p/don"
                element={
                  <RequireAuth>
                    <P2POrdersPage />
                  </RequireAuth>
                }
              />
              <Route
                path="p2p/don/:id"
                element={
                  <RequireAuth>
                    <P2POrderPage />
                  </RequireAuth>
                }
              />
              <Route
                path="p2p/thuong-nhan"
                element={
                  <RequireAuth>
                    <MerchantCenterPage />
                  </RequireAuth>
                }
              />
              <Route
                path="xac-minh"
                element={
                  <RequireAuth>
                    <KycPage />
                  </RequireAuth>
                }
              />
              <Route
                path="ngan-hang"
                element={
                  <RequireAuth>
                    <BankPage />
                  </RequireAuth>
                }
              />
              <Route
                path="vi"
                element={
                  <RequireAuth>
                    <WalletPage />
                  </RequireAuth>
                }
              />
              <Route
                path="lich-su"
                element={
                  <RequireAuth>
                    <HistoryPage />
                  </RequireAuth>
                }
              />
              {/* Đường dẫn cũ của sàn chứng khoán */}
              <Route path="bang-gia" element={<Navigate to="/thi-truong" replace />} />
              <Route path="market" element={<Navigate to="/thi-truong" replace />} />
              <Route path="bo-loc" element={<Navigate to="/thi-truong" replace />} />
              <Route path="portfolio" element={<Navigate to="/vi" replace />} />
              <Route path="history" element={<Navigate to="/lich-su" replace />} />
              <Route
                path="ho-tro"
                element={
                  <RequireAuth>
                    <SupportPage />
                  </RequireAuth>
                }
              />
              <Route path="cskh" element={<SupportDeskPage />} />
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
