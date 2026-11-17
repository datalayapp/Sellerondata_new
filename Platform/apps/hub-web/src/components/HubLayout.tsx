import { useMemo, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { supportMailto, type MeResponse } from '@sellerondata/contracts';
import { AppShell, Empty, ErrorState, PageHeader, Skel, Tag, toast, useMe, useSessionActions, type LinkRenderProps, type ProductNavGroup, type ShellProduct } from '@sellerondata/shell';
import { analyticsProducts, canSeeActivity, dataProducts, isOrgAdmin } from '../lib/access.ts';
import { apiMessage } from '../lib/hooks.ts';
import { useLogoutAction } from '../lib/logout.ts';
import { isHubPath } from '../lib/nav.ts';
import { useReopenedNotice } from '../pages/account/CloseOrg.tsx';
import { NoCompanyScreen } from '../pages/account/CreateOrg.tsx';

function renderLink({ href, children, ...rest }: LinkRenderProps) {
  return (
    <Link to={href} {...rest}>
      {children}
    </Link>
  );
}

export function pageKey(pathname: string): string | null {
  if (pathname.startsWith('/home')) return 'nav.home';
  if (pathname.startsWith('/analytics')) return 'nav.analytics';
  if (pathname.startsWith('/data')) return 'nav.data';
  if (pathname.startsWith('/activity')) return 'nav.activity';
  if (pathname.startsWith('/account/team')) return 'nav.team';
  if (pathname.startsWith('/account/company/new')) return 'createOrg.title';
  if (pathname.startsWith('/account/company/closed')) return 'closeOrg.pageTitle';
  if (pathname.startsWith('/account/company')) return 'nav.company';
  if (pathname.startsWith('/account/billing')) return 'nav.billing';
  if (pathname.startsWith('/account/profile')) return 'nav.profile';
  if (pathname.startsWith('/account/security')) return 'nav.security';
  if (pathname.startsWith('/account/firms')) return 'nav.firms';
  return null;
}

/**
 * Bant menüsü (GB-D09): Genel Bakış, Analiz, Veriler, Etkinlik, Ekip ve yetkiler, Abonelik.
 * Firma ayarları firma seçicide, Hesabım (Profil, Güvenlik, Firmalarım) avatar menüsünde (kabuk): menüde tekrar edilmez.
 */
function useHubNav(me: MeResponse | null): ProductNavGroup[] {
  const { t } = useTranslation();
  return useMemo(
    () => [
      {
        items: [
          { href: '/home', label: t('nav.home'), icon: 'home' as const },
          ...(analyticsProducts(me).length ? [{ href: '/analytics', label: t('nav.analytics'), icon: 'chart' as const }] : []),
          ...(dataProducts(me).length ? [{ href: '/data', label: t('nav.data'), icon: 'table' as const }] : []),
          ...(canSeeActivity(me) ? [{ href: '/activity', label: t('nav.activity'), icon: 'pulse' as const }] : []),
          ...(isOrgAdmin(me)
            ? [
                { href: '/account/team', label: t('nav.team'), icon: 'users' as const },
                { href: '/account/billing', label: t('nav.billing'), icon: 'card' as const },
              ]
            : []),
        ],
      },
    ],
    [me, t],
  );
}

/** Kabuğun Merkez'e bağlanmış hali. Oturum yoksa kaldığı yeri hatırlayarak girişe gönderir. */
export function ShellFrame({
  currentProduct = 'hub',
  pageTitle,
  withNav = true,
  children,
}: {
  currentProduct?: ShellProduct;
  pageTitle?: string | null;
  withNav?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { me, isPending, isPlaceholderData, isError, error, refetch } = useMe();
  const { switchOrg, changeLocale } = useSessionActions();
  const onLogout = useLogoutAction();
  const loc = useLocation();
  const productNav = useHubNav(me);
  // Firma geri açıldıysa sayfa baştan yüklendi: başarı iletisi bir kez.
  useReopenedNotice();

  // Yalnız kesin "oturum yok" girişe gönderir (me: null). Hesap'a ulaşılamadıysa kişi burada kalır.
  if (!me && !isPending && !isPlaceholderData && !isError) {
    return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  }
  // Etkin firma yok: tam ekran "Firma oluştur". Kişinin kendi hesabı ve kapattığı firmanın "geri aç" ekranı açık kalır.
  if (me && !me.activeOrg && !isPlaceholderData && !/^\/account\/(profile|security|firms|company\/closed\/)/.test(loc.pathname)) return <NoCompanyScreen />;
  const mock = import.meta.env.DEV && import.meta.env.VITE_MOCK === '1';
  return (
    <AppShell
      currentProduct={currentProduct}
      productNav={withNav ? productNav : undefined}
      pageTitle={pageTitle ?? null}
      currentPath={loc.pathname}
      me={me}
      renderLink={renderLink}
      isLocalHref={isHubPath}
      headerSlot={
        mock ? (
          <span className="hub-sample" title={t('common.sampleHint')}>
            <Tag tone="yellow" small>
              {t('common.sample')}
            </Tag>
          </span>
        ) : undefined
      }
      supportHref={supportMailto([t('support.subject', { ns: 'shell' }), me?.activeOrg?.name, pageTitle ?? document.title])}
      onLogout={onLogout}
      onSwitchOrg={async (id) => {
        try {
          await switchOrg(id);
        } catch (e) {
          toast.err(t('org.switchFailed', { ns: 'shell' }), apiMessage(e, t('common.unexpected')), { always: true });
        }
      }}
      onChangeLocale={(l) => changeLocale(l)}
    >
      {me ? (
        children
      ) : isError ? (
        <div className="hub-page hub-wrap is-short">
          <ErrorState error={error} onRetry={() => refetch()} />
        </div>
      ) : (
        <PageSkeleton />
      )}
    </AppShell>
  );
}

export function HubLayout() {
  const { t } = useTranslation();
  const loc = useLocation();
  const key = pageKey(loc.pathname);
  return (
    <ShellFrame pageTitle={key ? t(key) : t('nav.notFound')}>
      <Outlet />
    </ShellFrame>
  );
}

export function PageSkeleton() {
  return (
    <div className="hub-page hub-wrap is-short" aria-busy="true">
      <Skel h={260} />
      <Skel h={200} />
    </div>
  );
}

/** Sayfa düzeyinde görünürlük. Yetkisiz kişi menüde görmez; adresi yazsa da nedenini okur. */
export function RequireAccess({ allow }: { allow: (me: MeResponse | null) => boolean }) {
  const { t } = useTranslation();
  const { me } = useMe();
  const loc = useLocation();
  if (!me) return <PageSkeleton />;
  if (!allow(me)) {
    const key = pageKey(loc.pathname);
    return (
      <>
        <PageHeader title={key ? t(key) : t('access.title')} />
        <div className="hub-page hub-wrap is-short">
          <section className="hub-panel">
            <Empty
              icon="lock"
              title={t('access.title')}
              actions={
                <Link className="btn btn-secondary" to="/home">
                  {t('access.back')}
                </Link>
              }
            >
              {t('access.body')}
            </Empty>
          </section>
        </div>
      </>
    );
  }
  return <Outlet />;
}
