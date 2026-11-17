import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { PLAN_EARLY_ACCESS, PRODUCTS, PRODUCT_KEYS, type SubscriptionStatus } from '@sellerondata/contracts';
import { ErrorState, Icon, PageHeader, ProductMark, Skel, Tag, currentLocale, formatDate, useMe, type Tone } from '@sellerondata/shell';
import { AiUsageSection } from '../../components/AiUsageCard.tsx';
import { asList, type OrgSubscription } from '../../api/types.ts';
import { useScope } from '../../lib/hooks.ts';
import { client } from '../../lib/session.ts';

const STATUS_TONE: Record<SubscriptionStatus, Tone> = { ACTIVE: 'green', READ_ONLY: 'yellow', CANCELED: 'gray' };

/** Abonelik placeholder: ödeme yok, plan seçimi yok, deneme hiç yok (§1). Ekran yalnız bugünkü durumu gösterir. */
export function Billing() {
  const { t } = useTranslation();
  const locale = currentLocale();
  const scope = useScope();
  const subs = useQuery({ queryKey: [...scope, 'subscriptions'], queryFn: async () => asList<OrgSubscription>(await client.get('/api/account/org/subscriptions')) });
  // Hata varken ve elde veri yokken ürün listesi ve plan çizilmez: "Açık değil" yanıltır.
  const failed = subs.isError && !subs.data;
  const early = subs.data?.find((s) => s.plan === PLAN_EARLY_ACCESS);
  const { me } = useMe();
  const now = Date.now();
  /** READ_ONLY: durdurulmuş, okunur ama yazılamaz. CANCELED: `deleteAfter`'a kadar okunur (veri silinmez); tarih yoksa ya da geçtiyse yalnız "İptal edildi". */
  const statusNote = (sub: OrgSubscription, at: number) =>
    sub.status === 'CANCELED' && sub.deleteAfter && Date.parse(sub.deleteAfter) > at
      ? t('billing.canceledUntil', { date: formatDate(sub.deleteAfter, locale) })
      : t(`billing.status.${sub.status}`);
  return (
    <div className="hub-page d9">
      <PageHeader title={t('d9.billing.title')} sub={t('billing.sub')} />
      <div className="d9-wrap">
        {failed && <ErrorState error={subs.error} onRetry={() => subs.refetch()} />}
        {!failed && (
        <section className="d9-lift" aria-label={t('billing.tools')}>
          {subs.isPending ? (
            <div className="d9-prods" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="d9-prod">
                  <Skel h={48} />
                  <Skel h={20} />
                </div>
              ))}
            </div>
          ) : (
            <ul className="d9-prods">
              {PRODUCT_KEYS.map((key) => {
                const def = PRODUCTS[key];
                const sub = subs.data?.find((s) => s.product === key);
                // Açıklık firmanın durumundan (`me`); `me` gelmediyse kayıttaki varsayılan. `off`: yakında.
                const open = (me?.products.find((x) => x.key === key)?.launch ?? def.launch) !== 'off';
                return (
                  <li key={key} className={`d9-prod${open ? '' : ' is-soon'}`}>
                    <ProductMark product={key} size={48} />
                    <span className="d9-prod-t">
                      <b>{def.name}</b>
                      <span>{def.tagline[locale]}</span>
                    </span>
                    <span className="d9-prod-s">
                      {!open ? (
                        <Tag tone="gray">{t('common.soon')}</Tag>
                      ) : sub ? (
                        <>
                          <Tag tone={STATUS_TONE[sub.status]}>{t(`accountArea.memberships.status.${sub.status}`)}</Tag>
                          {sub.status !== 'ACTIVE' && <small>{statusNote(sub, now)}</small>}
                        </>
                      ) : (
                        <Tag tone="gray">{t('billing.notOpen')}</Tag>
                      )}
                    </span>
                    {open && sub?.status === 'ACTIVE' ? (
                      <a className="d9-prod-go" href={`${def.basePath}/`}>
                        {t('home.openTool', { name: def.name })}
                        <Icon name="arrow" size={16} />
                      </a>
                    ) : (
                      <span className="d9-prod-go" />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        )}

        <AiUsageSection />

        <section className="d9-sec" aria-labelledby="hub-bill-pay">
          <div className="d9-sec-h">
            <h2 id="hub-bill-pay">{t('billing.payTitle')}</h2>
          </div>
          <dl className="d9-kv">
            {/* Plan yalnız veri gelince: istek beklerken (hesap servisi kapalı, "Bağlantı yok" bandı; sorgu duraklar ve hata
                vermez) "Plan: Yakında" yazmak yanıltıyordu. */}
            {subs.data && (
              <div className="d9-kv-row">
                <dt>{t('d9.billing.plan')}</dt>
                <dd>{early ? <Tag tone="blue">{t('plan.earlyAccess')}</Tag> : (subs.data?.find((s) => s.plan !== PLAN_EARLY_ACCESS)?.plan ?? t('common.soon'))}</dd>
              </div>
            )}
            <div className="d9-kv-row">
              <dt>{t('d9.billing.payment')}</dt>
              <dd>{t('common.soon')}</dd>
            </div>
          </dl>
          <p className="d9-note">
            <Icon name="info" size={16} />
            <span>{t('billing.payNote')}</span>
          </p>
        </section>
      </div>
    </div>
  );
}
