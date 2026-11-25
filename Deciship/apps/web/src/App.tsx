import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, Outlet, RouterProvider } from 'react-router';
import type { Permission } from '@sellerondata/contracts';
import { ME_QUERY_KEY, SessionProvider } from '@sellerondata/shell';
import { i18n } from './i18n';
import { ApiError } from './api/client';
import { sessionClient } from './api/session';
import { AuthProvider, isSessionQuery, PRODUCT_ME_KEY, useAuth } from './auth/AuthContext';
import { LANDING_ORDER, NAV, Shell } from './components/Shell';
import { ToastProvider, toast } from './components/Toast';
import { sessionLostState } from './lib/sessionLost';
import { errorMessage } from './components/ui';
import { DashboardPage } from './pages/Dashboard';
import { OnboardingPage } from './pages/onboarding/Onboarding';
import { APP_BASE } from './lib/base';
import { onboardingRedirected } from './lib/onboarding';
import { clearTypedFields } from './lib/unsavedChanges';
import { hasPermission, holdsPermission } from './lib/permissions';
import { MeasurementsPage } from './pages/Measurements';
import { InvoicesPage } from './pages/Invoices';
import { InvoiceUploadPage } from './pages/InvoiceUpload';
import { InvoiceDetailPage } from './pages/InvoiceDetail';
import { DisputesPage } from './pages/Disputes';
import { TariffsPage } from './pages/Tariffs';
import { TariffEditorPage } from './pages/TariffEditor';
import { SettingsPage } from './pages/Settings';
import { NotFoundPage } from './pages/NotFound';
import { RouteError } from './pages/RouteError';
import type { ReactNode } from 'react';
import { ForbiddenPage, TariffEditDeniedPage } from './pages/AccessPages';
import { UpdateBanner } from './components/UpdateBanner';

const tr = (key: string) => i18n.t(key, { ns: 'platform' });
const statusOf = (e: unknown) => (e as { status?: unknown } | null)?.status;

/** Aynı hata art arda gelse de oturum bu aralıkta en çok bir kez okunur. */
const ACCESS_REFRESH_GAP_MS = 5_000;
let lastAccessRefresh = 0;

/** İzin veya abonelik sunucuda değişmiş olabilir: kabuk yeniden okusun, sayfa da yeni duruma geçsin. */
function reactToAccessError(e: unknown) {
  if (!(e instanceof ApiError)) return;
  if (e.code === 'NO_PRODUCT_ACCESS' || e.code === 'ORG_REQUIRED' || e.code === 'READ_ONLY' || e.code === 'FORBIDDEN') {
    const now = Date.now();
    if (now - lastAccessRefresh < ACCESS_REFRESH_GAP_MS) return;
    lastAccessRefresh = now;
    void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: PRODUCT_ME_KEY });
  }
}

const queryClient: QueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // 4xx tekrar denenmez; "Sunucu meşgul" (DB_UNAVAILABLE) GET'i client.ts zaten bir kez yeniden denedi
      retry: (count, e) => {
        const status = statusOf(e);
        if (typeof status === 'number' && status > 0 && status < 500) return false;
        if (e instanceof ApiError && e.code === 'DB_UNAVAILABLE') return false;
        return count < 2;
      },
    },
  },
  queryCache: new QueryCache({
    onError: (e, q) => {
      // Oturum sorguları kendi hatasında kendini geçersizlemez: aksi sunucuyu döven döngüdür. `/me` kendi yenilemesini `AuthContext`te yapar.
      if (!isSessionQuery(q.queryKey)) reactToAccessError(e);
      const code = (e as { code?: unknown }).code;
      if (q.meta?.silent || q.queryKey[0] === 'sod' || statusOf(e) === 401 || code === 'ORG_MISMATCH' || code === 'NETWORK_UNAVAILABLE') return;
      if (q.state.data !== undefined) toast.err(tr('toast.refreshFailed'), errorMessage(e));
    },
  }),
  mutationCache: new MutationCache({
    // kayıt başarılı: açık formdaki yazılar artık kaydedilmemiş sayılmaz
    onSuccess: () => clearTypedFields(),
    onError: (e, _v, _c, m) => {
      reactToAccessError(e);
      if (m.meta?.silent || statusOf(e) === 401 || (e as { code?: unknown }).code === 'ORG_MISMATCH') return;
      toast.err(tr(e instanceof ApiError && e.code === 'READ_ONLY' ? 'readOnly.title' : 'toast.actionFailed'), errorMessage(e));
    },
  }),
});

/**
 * Pano. Kurulum tamamlanmamış ve şirketin hiç taşıyıcısı yoksa (yeni şirket, sıfırlanmış sistem) oturumda bir kez
 * /setup'a yönlendirir; kullanıcı menüden Pano'ya dönerse zorlanmaz (bant gösterilir).
 */
function HomeRoute() {
  const { me, person } = useAuth();
  // işaret kurulum sayfası açılınca konur (render sırasında yan etki yok: StrictMode iki kez render eder)
  if (me?.onboarding?.required && hasPermission(person, 'deciship.settings.manage') && !onboardingRedirected()) return <Navigate to="/setup" replace />;
  if (!holdsPermission(person, 'deciship.reports.view')) return <LandingRedirect />;
  return <DashboardPage />;
}

/** Pano izni olmayan kişi açabildiği ilk sayfaya gider. */
function LandingRedirect() {
  const { person } = useAuth();
  const first = LANDING_ORDER.map((to) => NAV.find((n) => n.to === to)!).find((n) => n.anyOf.some((p) => holdsPermission(person, p)));
  return first ? <Navigate to={first.to} replace /> : <ForbiddenPage />;
}

/**
 * Yol koruması. İzinsiz kişi menüde görmez; adresi yazarsa nedenini okur. API yine kendisi denetler.
 * `write`: sayfa yalnız yazmak için vardır (yükleme, yeni kayıt, kurulum); salt okunur abonelikte kapanır.
 */
function Require({ anyOf, write, denied }: { anyOf: Permission[]; write?: boolean; denied?: ReactNode }) {
  const { person } = useAuth();
  const allowed = write ? hasPermission : holdsPermission;
  return anyOf.some((p) => allowed(person, p)) ? <Outlet /> : (denied ?? <ForbiddenPage />);
}

function NavGuard({ path }: { path: string }) {
  return <Require anyOf={NAV.find((n) => n.to === path)!.anyOf} />;
}

const router = createBrowserRouter(
  [
    {
      // root-level: friendly error page instead of the router's raw stack trace
      errorElement: <RouteError standalone />,
      children: [
        {
          element: <Shell />,
          children: [
            {
              // page errors keep the shell: only the content area shows the error
              errorElement: <RouteError />,
              children: [
                { index: true, element: <HomeRoute /> },
                { element: <Require write anyOf={['deciship.settings.manage']} />, children: [{ path: 'setup', element: <OnboardingPage /> }] },
                { element: <NavGuard path="/measurements" />, children: [{ path: 'measurements', element: <MeasurementsPage /> }] },
                {
                  element: <NavGuard path="/invoices" />,
                  children: [
                    { path: 'invoices', element: <InvoicesPage /> },
                    { path: 'invoices/:id', element: <InvoiceDetailPage /> },
                  ],
                },
                { element: <NavGuard path="/disputes" />, children: [{ path: 'disputes', element: <DisputesPage /> }] },
                { element: <Require write anyOf={['deciship.invoices.upload']} />, children: [{ path: 'invoices/upload', element: <InvoiceUploadPage /> }] },
                {
                  element: <NavGuard path="/tariffs" />,
                  children: [
                    { path: 'tariffs', element: <TariffsPage /> },
                    { path: 'tariffs/:id', element: <TariffEditorPage /> },
                  ],
                },
                { element: <Require write anyOf={['deciship.tariffs.edit']} denied={<TariffEditDeniedPage />} />, children: [{ path: 'tariffs/new', element: <TariffEditorPage /> }] },
                { element: <NavGuard path="/settings" />, children: [{ path: 'settings', element: <SettingsPage /> }] },
                { path: '*', element: <NotFoundPage /> },
              ],
            },
          ],
        },
      ],
    },
  ],
  { basename: APP_BASE },
);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider client={sessionClient}>
        <ToastProvider suppress={() => sessionLostState() !== 'none'} actionPlacement="stack">
          <AuthProvider>
            <UpdateBanner />
            <RouterProvider router={router} />
          </AuthProvider>
        </ToastProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}
