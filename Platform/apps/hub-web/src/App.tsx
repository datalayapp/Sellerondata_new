import { Suspense, lazy, useMemo, type ComponentType } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { focusManager, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { hubOwnedProductKeys, type ProductKey } from '@sellerondata/contracts';
import { ApiError, ME_QUERY_KEY, SessionProvider, ToastProvider, isProductOpen, useMe } from '@sellerondata/shell';
import { isOrgClosedError } from './lib/closeOrg.ts';
import { client } from './lib/session.ts';
import { HubLayout, PageSkeleton, RequireAccess } from './components/HubLayout.tsx';
import { isOrgAdmin, analyticsProducts, dataProducts, canSeeActivity } from './lib/access.ts';
// Firma ve yeni firma ilk pakette kalır: giriş/kayıt (ülke listesi) ve firmasız ekran onları zaten içe aktarır.
import { Company } from './pages/account/Company.tsx';
// Kapalı firma ekranı firma sayfasının "Firmayı kapat" bölümüyle aynı dosyada: o da ilk pakettedir.
import { ClosedOrg } from './pages/account/CloseOrg.tsx';
import { NewCompany } from './pages/account/CreateOrg.tsx';
import { ComingSoon } from './pages/ComingSoon.tsx';
import { NotFound } from './pages/NotFound.tsx';
import { Login, Register, Join, InviteAccept, ForgotPassword, ResetPassword, VerifyEmail } from './pages/auth/Auth.tsx';

/**
 * Sayfa ayrı parça olarak yüklenir (ARCHITECTURE §8): kabuk (bant, ray) hemen çizilir, sayfanın parçası gelene kadar içerikte
 * olağan iskelet durur. Grafikler yalnız onları kullanan sayfaların (Genel Bakış, Analiz, Veriler) parçalarındadır.
 */
function lazyPage<P extends object>(load: () => Promise<ComponentType<P>>) {
  const Lazy = lazy(async () => ({ default: await load() }));
  return function Page(props: P) {
    return (
      <Suspense fallback={<PageSkeleton />}>
        <Lazy {...props} />
      </Suspense>
    );
  };
}

const Home = lazyPage(() => import('./pages/Home.tsx').then((m) => m.Home));
const Analytics = lazyPage(() => import('./pages/Analytics.tsx').then((m) => m.Analytics));
const DataPage = lazyPage(() => import('./pages/Data.tsx').then((m) => m.DataPage));
const Activity = lazyPage(() => import('./pages/Activity.tsx').then((m) => m.Activity));
const Team = lazyPage(() => import('./pages/account/Team.tsx').then((m) => m.Team));
const Billing = lazyPage(() => import('./pages/account/Billing.tsx').then((m) => m.Billing));
const AiUsagePage = lazyPage(() => import('./pages/account/AiUsage.tsx').then((m) => m.AiUsagePage));
// Hesabım: çerçeve (bant başlığı + solda ayar menüsü) ve üç bölüm; hepsi aynı ayrı parçada.
const AccountLayout = lazyPage(() => import('./pages/account/AccountLayout.tsx').then((m) => m.AccountLayout));
const ProfilePage = lazyPage(() => import('./pages/account/Profile.tsx').then((m) => m.ProfilePage));
const SecurityPage = lazyPage(() => import('./pages/account/Security.tsx').then((m) => m.SecurityPage));
const FirmsPage = lazyPage(() => import('./pages/account/Firms.tsx').then((m) => m.FirmsPage));
const ToolAccess = lazyPage(() => import('./pages/ToolAccess.tsx').then((m) => m.ToolAccess));

/** `/account/profile#firmalar` (eski Profil › Firmalarım bağlantısı) Firmalarım'a gider; başka her şey Profil'dir. */
function ProfileRoute() {
  const { hash, search } = useLocation();
  if (hash === '#firmalar') return <Navigate to={`/account/firms${search}`} replace />;
  return <ProfilePage />;
}

/** Web'i olmayan aracın yolu Merkez'indir: bu firmada açıksa Merkez'de o araca süzülmüş Genel Bakış, değilse "Yakında". */
function HubOwnedTool({ product }: { product: ProductKey }) {
  const { me } = useMe();
  if (me && isProductOpen(me, product)) return <Navigate to={`/home?tool=${product}`} replace />;
  return <ComingSoon product={product} />;
}

// Kütüphane yalnız sekme görünürlüğünü dinler; yan yana pencereden dönmek de odak dönüşüdür.
// Yalnız `refetchOnWindowFocus` açık sorgular etkilenir, varsayılan kapalı.
focusManager.setEventListener((onFocus) => {
  const notify = () => onFocus();
  window.addEventListener('visibilitychange', notify);
  window.addEventListener('focus', notify);
  return () => {
    window.removeEventListener('visibilitychange', notify);
    window.removeEventListener('focus', notify);
  };
});

export function App() {
  const qc = useMemo(() => {
    const meKey = JSON.stringify(ME_QUERY_KEY);
    const queryClient: QueryClient = new QueryClient({
      // Firma kapatılmış (`409 ORG_CLOSED`, ör. araç kapanışı jetondan önce öğrendi): kişi yeniden okunur. Kapalı firma `/me`'de etkin
      // olmaz; kabuk firmasız ekrana ya da "firma değişti" uyarısına düşer, sahip orada "Firmayı geri aç"ı görür. `/me` bu kodu dönmez.
      queryCache: new QueryCache({
        onError: (e, query) => {
          if (isOrgClosedError(e) && JSON.stringify(query.queryKey) !== meKey)
            void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }, { cancelRefetch: false });
        },
      }),
      defaultOptions: {
        queries: {
          refetchOnWindowFocus: false,
          staleTime: 30_000,
          retry: (count, e) => !(e instanceof ApiError && e.status < 500) && count < 1,
        },
      },
    });
    return queryClient;
  }, []);
  return (
    <QueryClientProvider client={qc}>
      <SessionProvider client={client}>
        <ToastProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<Navigate to="/home" replace />} />
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route path="/join" element={<Join />} />
              <Route path="/invite/:token" element={<InviteAccept />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password/:token" element={<ResetPassword />} />
              <Route path="/verify-email/:token" element={<VerifyEmail />} />

              {hubOwnedProductKeys().map((key) => (
                <Route key={key} path={`/${key}/*`} element={<HubOwnedTool product={key} />} />
              ))}
              <Route path="/account/tool-access/:product" element={<ToolAccess />} />

              {/* Eski Üyelikler adresi kabuğun dışında yönlenir: firmasız kişide kabuk "Firma oluştur" ekranını gösterir, yönlendirme hiç çalışmazdı. */}
              <Route path="/account/memberships" element={<Navigate to="/account/firms" replace />} />
              <Route path="/account" element={<Navigate to="/account/profile" replace />} />

              <Route element={<HubLayout />}>
                <Route path="/home" element={<Home />} />
                {/* Hesabım: Merkez'in kabuğunda; firmasız kişi de girer (ShellFrame istisnası). Üç bölüm, her biri kendi adresinde.
                    Eski `/account/profile#firmalar` bağlantısı Firmalarım'a yönlenir (ProfileRoute). */}
                <Route element={<AccountLayout />}>
                  <Route path="/account/profile" element={<ProfileRoute />} />
                  <Route path="/account/security" element={<SecurityPage />} />
                  <Route path="/account/firms" element={<FirmsPage />} />
                </Route>
                <Route element={<RequireAccess allow={(me) => analyticsProducts(me).length > 0} />}>
                  <Route path="/analytics" element={<Analytics />} />
                  <Route path="/analytics/:product" element={<Analytics />} />
                </Route>
                <Route element={<RequireAccess allow={(me) => dataProducts(me).length > 0} />}>
                  <Route path="/data" element={<DataPage />} />
                  <Route path="/data/:product" element={<DataPage />} />
                  <Route path="/data/:product/:dataset" element={<DataPage />} />
                </Route>
                <Route element={<RequireAccess allow={canSeeActivity} />}>
                  <Route path="/activity" element={<Activity />} />
                </Route>
                <Route element={<RequireAccess allow={isOrgAdmin} />}>
                  <Route path="/account/team" element={<Team />} />
                  <Route path="/account/company" element={<Company />} />
                  <Route path="/account/billing" element={<Billing />} />
                  <Route path="/account/billing/ai/:product" element={<AiUsagePage />} />
                </Route>
                <Route path="/account/company/new" element={<NewCompany />} />
                {/* Kapalı firmanın "geri aç" ekranı: firma seçicideki kapalı öğe (yalnız sahibe gelir). Etkin firma gerekmez. */}
                <Route path="/account/company/closed/:orgId" element={<ClosedOrg />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}
