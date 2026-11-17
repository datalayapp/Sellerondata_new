import { useCallback, useEffect, useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Link, Outlet, RouterProvider, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PRODUCTS, type MeResponse } from '@sellerondata/contracts';
import {
  AppShell,
  Empty,
  PageHeader,
  SessionProvider,
  ToastProvider,
  hasWebAccess,
  toast,
  useMe,
  useSessionActions,
  type IconName,
  type LinkRenderProps,
  type ProductNavGroup,
} from '@sellerondata/shell';
import { sessionClient } from './api/session';
import { APP_BASE, TOOL, isAppHref, loginHref, toFullPath, toRouterPath, toolAccessHref } from './lib/base';

/**
 * Araç kabuğu: ray, bant, firma/dil/hesap menüsü, oturum bandı ve hata sınırı `@sellerondata/shell`'den gelir.
 * Burada yalnız aracın menüsü ve oturum durumuna göre içerik seçilir. Karşılığı: Deciship/apps/web/src/App.tsx ve
 * src/components/Shell.tsx (DeciShip ayrıca araç tarafı `/me`, kurulum yönlendirmesi, izin tablosu ve erişim sayfaları taşır).
 */

const statusOf = (e: unknown) => (e as { status?: unknown } | null)?.status;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // 4xx tekrar denenmez: sonuç değişmez, sunucu boşuna yorulur.
      retry: (count, e) => {
        const status = statusOf(e);
        if (typeof status === 'number' && status > 0 && status < 500) return false;
        return count < 2;
      },
    },
  },
});

/** Menü. Her sayfa izinle açılır (`anyOf`, kayıttaki izin anahtarları); kod rol adına bakmaz. Örnek sayfa izinsiz. */
type NavEntry = { to: string; key: string; icon: IconName; end?: boolean };
const NAV: NavEntry[] = [{ to: '/', key: 'nav.home', icon: 'home', end: true }];

function renderLink({ href, children, ...rest }: LinkRenderProps) {
  return (
    <Link to={toRouterPath(href)} {...rest}>
      {children}
    </Link>
  );
}

/**
 * Oturum kapısı. `offline`: Hesap'a ulaşılamadı, son bilinen kişi de yok (kabuğun oturum bandı "Bağlantı yok" der).
 * `no-access`: kişinin bu araçta web izni (`webAccess`) yok; Merkez'in ortak sayfasına tam sayfa gidilir.
 */
type Gate = 'loading' | 'anon' | 'offline' | 'no-org' | 'no-access' | 'ok';
function gateOf(me: MeResponse | null, pending: boolean, error: boolean): Gate {
  if (!me) return error ? 'offline' : pending ? 'loading' : 'anon';
  if (!me.activeOrg) return 'no-org';
  return hasWebAccess(me, TOOL) ? 'ok' : 'no-access';
}

function Shell() {
  const { t } = useTranslation();
  const session = useMe();
  const me = session.me;
  const { logout, switchOrg, changeLocale } = useSessionActions();
  const loc = useLocation();
  const gate = gateOf(me, session.isPending, session.isError);

  useEffect(() => {
    if (gate === 'anon') window.location.assign(loginHref(window.location.pathname, window.location.search));
    if (gate === 'no-access') window.location.replace(toolAccessHref());
  }, [gate]);

  const productNav = useMemo<ProductNavGroup[] | undefined>(() => {
    if (gate !== 'ok') return undefined;
    return [{ items: NAV.map((n) => ({ href: n.to === '/' ? `${APP_BASE}/` : toFullPath(n.to), label: t(n.key), icon: n.icon, end: n.end })) }];
  }, [gate, t]);

  const page = NAV.find((n) => (n.end ? loc.pathname === n.to : loc.pathname.startsWith(n.to)));

  const onLogout = useCallback(async () => {
    const r = await logout();
    // Sunucu oturumu kapatmadıysa kişi hâlâ içeride: girişe gitmek onu geri atar, sayfada kalınır ve söylenir.
    if (!r.serverEnded) return toast.err(t('session.logoutFailed', { ns: 'shell' }), t('session.logoutFailedBody', { ns: 'shell' }));
    window.location.assign('/login');
  }, [logout, t]);

  return (
    <AppShell
      currentProduct={TOOL}
      productNav={productNav}
      pageTitle={t(page?.key ?? 'nav.notFound')}
      currentPath={toFullPath(loc.pathname)}
      me={me}
      renderLink={renderLink}
      isLocalHref={isAppHref}
      onLogout={onLogout}
      onSwitchOrg={(id) => switchOrg(id, `${APP_BASE}/`)}
      onChangeLocale={changeLocale}
    >
      <div className="page">
        {gate === 'ok' ? (
          <Outlet />
        ) : gate === 'no-org' ? (
          <Empty
            title={t('gate.noOrgTitle')}
            actions={
              <a className="btn btn-primary" href="/home">
                {t('gate.backHub')}
              </a>
            }
          >
            {t('gate.noOrgBody')}
          </Empty>
        ) : gate === 'offline' ? (
          <Empty title={t('session.offlineTitle', { ns: 'shell' })}>{t('session.offlineBody', { ns: 'shell' })}</Empty>
        ) : null}
      </div>
    </AppShell>
  );
}

function HomePage() {
  const { t } = useTranslation();
  return <PageHeader title={PRODUCTS[TOOL].name} sub={t('home.body')} />;
}

function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <Empty
      title={t('nav.notFound')}
      actions={
        <Link className="btn btn-primary" to="/">
          {t('notFound.home')}
        </Link>
      }
    >
      {t('notFound.body')}
    </Empty>
  );
}

const router = createBrowserRouter(
  [
    {
      element: <Shell />,
      children: [
        { index: true, element: <HomePage /> },
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ],
  { basename: APP_BASE },
);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider client={sessionClient}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}
