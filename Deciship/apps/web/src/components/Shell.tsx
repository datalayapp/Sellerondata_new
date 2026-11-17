import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { supportMailto, type Locale, type Permission } from '@sellerondata/contracts';
import { AppShell, useSessionActions, type IconName, type LinkRenderProps, type ProductNavGroup } from '@sellerondata/shell';
import { useAccessRecheck, useAuth } from '../auth/AuthContext';
import { APP_BASE, isAppHref, toFullPath, toRouterPath } from '../lib/base';
import { goToLogin, leaveForLogin, sessionLostState, setSessionLost, subscribeSessionLost } from '../lib/sessionLost';
import { clearOnboardingRedirect, isSetupPending } from '../lib/onboarding';
import { currentPageTitle, setShellTitle, subscribePageTitle } from '../lib/pageTitle';
import { allowUnload, hasNumberField, hasUnsavedChanges, planLocaleChange, reloadDiscardingChanges, trackTypedFields } from '../lib/unsavedChanges';
import { hasPermission, hasWebAccess, holdsPermission, productOf, subscriptionWritable } from '../lib/permissions';
import { MobileRolePage, NoAccessPage, OfflinePage, OrgRequiredPage, PageSkeleton } from '../pages/AccessPages';
import { DemoBanner } from './DemoBanner';
import { toast } from './Toast';
import { Icon } from './Icon';
import { Button, Modal, ModalAction } from './ui';

/** Hangi sayfa hangi izinle görünür. Yol koruması (`App.tsx`) ve menü aynı tablodan okur. */
type NavEntry = { to: string; key: string; icon: IconName; end?: boolean; anyOf: Permission[] };
export const NAV: NavEntry[] = [
  { to: '/', key: 'nav.dashboard', icon: 'home', end: true, anyOf: ['deciship.reports.view'] },
  { to: '/invoices', key: 'nav.invoices', icon: 'doc', anyOf: ['deciship.invoices.view'] },
  { to: '/measurements', key: 'nav.measurements', icon: 'ruler', anyOf: ['deciship.measurements.view_all'] },
  { to: '/disputes', key: 'nav.disputes', icon: 'flag', anyOf: ['deciship.invoices.view'] },
  { to: '/tariffs', key: 'nav.tariffs', icon: 'table', anyOf: ['deciship.tariffs.view'] },
  { to: '/settings', key: 'nav.settings', icon: 'gear', anyOf: ['deciship.settings.manage'] },
];
/** Pano izni olmayan kişinin açılış sırası (menü sırasından bağımsız: depo sorumlusu önce ölçümleri görür). */
export const LANDING_ORDER = ['/measurements', '/invoices', '/disputes', '/tariffs', '/settings'];

function renderLink({ href, children, ...rest }: LinkRenderProps) {
  return (
    <Link to={toRouterPath(href)} {...rest}>
      {children}
    </Link>
  );
}

/** Sayfa adı (sekme başlığı); menüde olmayan adres null döner. */
function pageKey(pathname: string): string | null {
  if (pathname === '/') return 'nav.dashboard';
  if (pathname.startsWith('/setup')) return 'nav.setup';
  if (pathname === '/invoices/upload') return 'nav.invoiceUpload';
  if (pathname === '/tariffs/new') return 'nav.newTariff';
  return NAV.find((n) => n.to !== '/' && (pathname === n.to || pathname.startsWith(`${n.to}/`)))?.key ?? null;
}

/** Kurulum menü öğesi ilk karede zıplamasın: son bilinen durum bu sekmede tutulur. */
const SETUP_PENDING = 'deciship.setup.pending';
function readSetupPending(orgId: string | undefined) {
  try {
    return !!orgId && sessionStorage.getItem(SETUP_PENDING) === orgId;
  } catch {
    return false;
  }
}
function writeSetupPending(orgId: string | undefined, pending: boolean) {
  try {
    if (pending && orgId) sessionStorage.setItem(SETUP_PENDING, orgId);
    else sessionStorage.removeItem(SETUP_PENDING);
  } catch {
    /* depo kapalı olabilir */
  }
}

/**
 * SellerOnData kabuğu + DeciShip menüsü. Ray, başlık, firma/dil/kullanıcı menüsü kabuktan gelir; burada yalnız aracın sayfaları
 * ve oturum durumuna göre içerik seçilir. Oturum yoksa Merkez girişine tam sayfa gidilir.
 */
export function Shell() {
  const { t, i18n } = useTranslation('platform');
  const { status, person, me } = useAuth();
  const { logout, switchOrg, changeLocale } = useSessionActions();
  const loc = useLocation();
  useAccessRecheck(loc.key);
  const lost = useSyncExternalStore(subscribeSessionLost, sessionLostState);

  useEffect(() => {
    if (status === 'anon') goToLogin();
  }, [status]);

  const orgId = person?.activeOrg?.id;
  const onboarding = me?.onboarding;
  useEffect(() => {
    if (onboarding) writeSetupPending(orgId, !onboarding.completed);
  }, [onboarding, orgId]);
  const setupPending = isSetupPending(hasPermission(person, 'deciship.settings.manage'), onboarding, readSetupPending(orgId));

  const ready = status === 'authed' || status === 'loading';
  const productNav = useMemo<ProductNavGroup[] | undefined>(() => {
    if (!ready) return undefined;
    const items = NAV.filter((n) => n.anyOf.some((p) => holdsPermission(person, p))).map((n) => ({
      href: n.to === '/' ? `${APP_BASE}/` : toFullPath(n.to),
      label: t(n.key),
      icon: n.icon,
      end: n.end,
    }));
    const groups: ProductNavGroup[] = [{ items }];
    if (setupPending) {
      groups.unshift({
        items: [
          {
            href: toFullPath('/setup'),
            label: t('nav.setup'),
            icon: 'flag' as IconName,
            badge: <span className="ds-setup-tag">{t('nav.setupPending')}</span>,
          },
        ],
      });
    }
    return groups;
  }, [ready, person, setupPending, t, i18n.language]);

  const key = pageKey(loc.pathname);
  const page = key ? t(key) : t('nav.notFound');
  useEffect(() => setShellTitle(page), [page]);
  const pageTitle = useSyncExternalStore(subscribePageTitle, currentPageTitle);

  const onSwitchOrg = useCallback(
    async (id: string) => {
      if (hasUnsavedChanges() && !window.confirm(t('org.unsavedConfirm'))) return;
      clearOnboardingRedirect();
      writeSetupPending(undefined, false);
      allowUnload(true);
      try {
        await switchOrg(id, `${APP_BASE}/`);
      } catch {
        allowUnload(false);
        toast.err(t('org.switchFailed'));
      }
    },
    [switchOrg, t],
  );

  useEffect(() => trackTypedFields(), []);

  const onChangeLocale = useCallback(
    async (locale: Locale) => {
      const plan = planLocaleChange({
        unsaved: hasUnsavedChanges(),
        numberField: hasNumberField(),
        confirm: () => window.confirm(t('lang.unsavedConfirm')),
      });
      if (plan === 'cancel') return;
      await changeLocale(locale);
      if (plan === 'switch-and-reload') reloadDiscardingChanges();
    },
    [changeLocale, t],
  );

  // Konu satırı: "Destek isteği · firma · sayfa"; sayfa adı gezindikçe değişir, bağlantı her çizimde yeniden kurulur.
  const supportHref = supportMailto([t('support.subject', { ns: 'shell' }), person?.activeOrg?.name, pageTitle]);

  const onLogout = useCallback(async () => {
    const r = await logout();
    if (!r.serverEnded) {
      // Sunucu oturumu kapatmadı: kişi hâlâ içeride, girişe gitmek onu geri içeri atar. Sayfada kalınır ve dürüstçe söylenir.
      toast.err(t('session.logoutFailed', { ns: 'shell' }), t('session.logoutFailedBody', { ns: 'shell' }), { always: true });
      return;
    }
    clearOnboardingRedirect();
    writeSetupPending(undefined, false);
    window.location.assign('/login');
  }, [logout, t]);

  return (
    <AppShell
      currentProduct="deciship"
      productNav={productNav}
      pageTitle={pageTitle}
      currentPath={toFullPath(loc.pathname)}
      me={person}
      renderLink={renderLink}
      isLocalHref={isAppHref}
      onLogout={onLogout}
      onSwitchOrg={onSwitchOrg}
      onChangeLocale={onChangeLocale}
      supportHref={supportHref}
    >
      <div className="page">
        {status === 'authed' ? (
          <>
            <DemoBanner />
            {!subscriptionWritable(person) && (
              <div className="notif warn ds-readonly" role="status">
                <Icon name="lock" />
                <span>
                  <b>{t('readOnly.title')}</b> {t('readOnly.body')}
                </span>
              </div>
            )}
            {lost === 'stayed' && (
              <div className="notif warn ds-readonly ds-session-lost" role="alert">
                <Icon name="warn" />
                <span>{t('sessionLost.bar')}</span>
                <Button small onClick={leaveForLogin}>
                  {t('sessionLost.login')}
                </Button>
              </div>
            )}
            <Outlet />
          </>
        ) : status === 'offline' ? (
          <OfflinePage />
        ) : status === 'no-org' ? (
          <OrgRequiredPage onSwitch={onSwitchOrg} />
        ) : status === 'no-access' ? (
          // mobil metni yalnız rolü web izni vermeyen kişiye: bayat kayıtta rol görünse de sunucu reddettiyse erişim yoktur
          productOf(person)?.role && !hasWebAccess(person) ? <MobileRolePage /> : <NoAccessPage />
        ) : (
          <PageSkeleton />
        )}
      </div>
      {lost === 'ask' && (
        <Modal
          label={t('sessionLost.label')}
          title={t('sessionLost.title')}
          onClose={() => setSessionLost('stayed')}
          actions={
            <>
              <ModalAction kind="dark" onClick={() => setSessionLost('stayed')}>
                {t('sessionLost.stay')}
              </ModalAction>
              <ModalAction kind="prim" onClick={leaveForLogin}>
                {t('sessionLost.login')}
              </ModalAction>
            </>
          }
        >
          <p>{t('sessionLost.body')}</p>
        </Modal>
      )}
    </AppShell>
  );
}
