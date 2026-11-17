import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { PRODUCTS, productRole } from '@sellerondata/contracts';
import { currentLocale } from '@sellerondata/shell';
import { useAuth, useHoldsPermission } from '../auth/AuthContext';
import { usePageTitle } from '../components/Brand';
import { Icon, type IconName } from '../components/Icon';
import { Button, PageHeader, Skel } from '../components/ui';
import { productOf } from '../lib/permissions';

/** Kabuğun içinde, aracın işi yerine gösterilen durum sayfaları. Metin kısa, ne yapılacağı belli, Merkez'e dönüş hep tam sayfa. */
function AccessLayout({
  icon,
  title,
  children,
  actions,
  note,
  className,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  /** Eylemlerin altında küçük not. */
  note?: ReactNode;
  className?: string;
}) {
  // Sayfa adından önceliklidir: rol sayfasında sekme "Pano" demesin.
  usePageTitle(title);
  return (
    <div className={`content ds-access${className ? ` ${className}` : ''}`}>
      <section className="ds-access-card" aria-labelledby="ds-access-t">
        <span className="ds-access-ic" aria-hidden="true">
          <Icon name={icon} size={24} />
        </span>
        <h1 id="ds-access-t">{title}</h1>
        {children}
        {actions && <div className="ds-access-acts">{actions}</div>}
        {note && <p className="ds-access-note">{note}</p>}
      </section>
    </div>
  );
}

/** Rolün adı sunucudan (`roleLabel`: firmada düzenlenmiş ya da özel rol); eski sunucuda katalog adı. Rol yoksa ya da adı bilinmiyorsa undefined. */
function roleLabelOf(product: ReturnType<typeof productOf>): string | undefined {
  if (!product?.role) return undefined;
  return product.roleLabel ?? productRole('deciship', product.role)?.label[currentLocale()];
}

/** Tek birincil eylem: Merkez'e tam sayfa dönüş. */
function BackToHub() {
  const { t } = useTranslation('platform');
  return (
    <a className="btn btn-primary" href="/home">
      {t('access.backHub')}
    </a>
  );
}

/** `deciship.web.access` yok ama rol var: işi mobilde (§8). */
export function MobileRolePage() {
  const { t } = useTranslation('platform');
  const { person } = useAuth();
  const roleLabel = roleLabelOf(productOf(person));
  return (
    <AccessLayout icon="ruler" title={t('access.mobileTitle')} actions={<BackToHub />} note={t('access.mobileAppSlot')}>
      <p>{t('access.mobileBody', { role: roleLabel ?? '', tool: PRODUCTS.deciship.name })}</p>
      <ol className="ds-access-steps">
        <li>{t('access.mobileStep1')}</li>
        <li>{t('access.mobileStep2')}</li>
        <li>{t('access.mobileStep3')}</li>
      </ol>
    </AccessLayout>
  );
}

/** Bu firmada DeciShip rolü veya aboneliği yok. */
export function NoAccessPage() {
  const { t } = useTranslation('platform');
  const { person } = useAuth();
  const tool = PRODUCTS.deciship.name;
  const roleLabel = roleLabelOf(productOf(person));
  return (
    <AccessLayout icon="lock" title={t('access.noAccessTitle', { tool })} actions={<BackToHub />} note={t('access.noAccessMobile')}>
      <p>{t('access.noAccessBody')}</p>
      <dl className="ds-access-info">
        {person?.activeOrg && (
          <div>
            <dt>{t('access.infoOrg')}</dt>
            <dd>{person.activeOrg.name}</dd>
          </div>
        )}
        {person?.person.name && (
          <div>
            <dt>{t('access.infoAccount')}</dt>
            <dd>{person.person.name}</dd>
          </div>
        )}
        <div>
          <dt>{t('access.infoRole', { tool })}</dt>
          <dd>{roleLabel ?? t('access.noRole')}</dd>
        </div>
      </dl>
    </AccessLayout>
  );
}

/** Etkin firma yok (`ORG_REQUIRED`): firma seçilince sayfa yeniden açılır. */
export function OrgRequiredPage({ onSwitch }: { onSwitch: (orgId: string) => void | Promise<void> }) {
  const { t } = useTranslation('platform');
  const { person } = useAuth();
  const orgs = (person?.orgs ?? []).filter((o) => o.status === 'ACTIVE');
  // Etkin firma yok ve askıda üyelik var: kişi firmasız değil, askıda (Merkez ile aynı metin ve kural).
  const suspended = (person?.account?.suspendedOrgCount ?? (person?.orgs ?? []).filter((o) => o.status === 'SUSPENDED').length) > 0;
  if (!orgs.length && suspended) {
    return (
      <AccessLayout icon="lock" title={t('access.suspendedTitle')} actions={<BackToHub />}>
        <p>{t('access.suspendedBody')}</p>
      </AccessLayout>
    );
  }
  // Askıya alınmış, ama başka etkin firması var: "bir firma seçin" demeden önce askıda olduğu söylenir.
  const pickAfterSuspend = orgs.length > 0 && suspended;
  return (
    <AccessLayout icon="home" title={t(pickAfterSuspend ? 'access.suspendedTitle' : orgs.length ? 'access.orgTitle' : 'access.noOrgTitle')} actions={<BackToHub />}>
      <p>{t(pickAfterSuspend ? 'access.suspendedPickBody' : orgs.length ? 'access.orgBody' : 'access.noOrgBody')}</p>
      {orgs.length > 0 && (
        <ul className="ds-access-orgs">
          {orgs.map((o) => (
            <li key={o.id}>
              <Button kind="secondary" onClick={() => onSwitch(o.id)}>
                {o.name}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </AccessLayout>
  );
}

/** Sunucuya ulaşılamadı: oturum kapatılmaz, tekrar denenir. */
export function OfflinePage() {
  const { t } = useTranslation('platform');
  const { retry } = useAuth();
  const [busy, setBusy] = useState(false);
  return (
    <AccessLayout
      className="ds-offline"
      icon="err"
      title={t('offline.title')}
      actions={
        <Button
          icon="refresh"
          loading={busy}
          onClick={() => {
            setBusy(true);
            retry()
              .catch(() => undefined)
              .finally(() => setBusy(false));
          }}
        >
          {t('offline.retry')}
        </Button>
      }
    >
      <p>{t('offline.body')}</p>
    </AccessLayout>
  );
}

/** Menüde olmayan sayfanın adresini yazan kişi nedenini okur. */
export function ForbiddenPage() {
  const { t } = useTranslation('platform');
  return (
    <AccessLayout icon="lock" title={t('access.forbiddenTitle')} actions={<BackToHub />}>
      <p>{t('access.forbiddenBody')}</p>
    </AccessLayout>
  );
}

/** Tarifeleri görebilen ama değiştiremeyen kişi yeni tarife ve içe aktarma adresine gelirse: neden ve tarifelere dönüş. */
export function TariffEditDeniedPage() {
  const { t } = useTranslation('platform');
  const canView = useHoldsPermission('deciship.tariffs.view');
  const holdsEdit = useHoldsPermission('deciship.tariffs.edit');
  if (!canView) return <ForbiddenPage />;
  return (
    <AccessLayout
      icon="lock"
      title={t('access.tariffEditTitle')}
      actions={
        <Link className="btn btn-primary" to="/tariffs">
          {t('access.tariffEditBack')}
        </Link>
      }
    >
      <p>{t(holdsEdit ? 'access.tariffEditReadOnly' : 'access.tariffEditBody')}</p>
    </AccessLayout>
  );
}

/** Oturum denetlenirken: yerleşim kabukla aynı kalır, yalnız içerik yüklenir. */
export function PageSkeleton() {
  const { t } = useTranslation('platform');
  return (
    <div aria-busy="true" aria-label={t('loading')}>
      <PageHeader title={<Skel w={200} h={40} />} sub={<Skel w={280} h={12} />} />
      <div className="content col">
        <Skel h={44} />
        <Skel h={240} />
      </div>
    </div>
  );
}
