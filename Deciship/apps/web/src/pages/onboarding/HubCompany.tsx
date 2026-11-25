import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { HUB_COMPANY_PATH, countryLabel, timeZoneLabel, type CompanyFacts } from './company';

// Firma bilgileri Merkez'de kurulur; sihirbaz yalnız gösterir ve Merkez'e götürür (tuval "Merkez ve Araç Kurulumu" 2-3).
// Merkez ayrı uygulama: bağlantılar tam sayfa gezintidir (`<a href>`).

/** Adım listesinin başında, sayılmayan satır. Tıklanmaz: değiştirmek Merkez'de. */
export function HubCompanyRow({ confirmed }: { confirmed: boolean }) {
  const { t } = useTranslation('onboarding');
  return (
    <li>
      <div className={`ob-step ob-hub st-${confirmed ? 'ok' : 'wait'}`}>
        <span className="ob-dot" aria-hidden="true">
          {confirmed ? <Icon name="check" size={14} /> : '!'}
        </span>
        <span className="ob-step-t">
          <b>{t('hub.row')}</b>
          <span className="ob-step-s">{t(confirmed ? 'hub.rowDone' : 'hub.rowWaiting')}</span>
        </span>
      </div>
    </li>
  );
}

/** Onaylı firmada her adımın üstünde: Merkez'den gelen bilgiler tek satırda. */
export function HubCompanyStrip({ facts, admin }: { facts: CompanyFacts; admin: boolean }) {
  const { t, i18n } = useTranslation('onboarding');
  const parts = [facts.name, countryLabel(facts.country, i18n.language), facts.currency, timeZoneLabel(facts.timeZone)].filter(Boolean);
  return (
    <div className="notif info ob-hub-strip" role="note">
      <Icon name="check" />
      <span>
        {t('hub.doneStrip')} <b>{parts.join(' · ')}</b>
      </span>
      {admin && (
        <a className="act ob-hub-link" href={HUB_COMPANY_PATH}>
          {t('hub.change')} <Icon name="external" />
        </a>
      )}
    </div>
  );
}

/** Onaysız firmada sihirbazın tek gövdesi: DeciShip adımları onaydan sonra açılır (para birimi tarifeler için gerekir). */
export function CompanyGate({ facts, admin, confirmHref }: { facts: CompanyFacts; admin: boolean; confirmHref: string }) {
  const { t } = useTranslation('onboarding');
  const pending = (v: string) => (v ? t('hub.pending', { value: v }) : '—');
  return (
    <div className="ob-body">
      <div className="notif warn" role="status">
        <Icon name="warn" />
        <span>{t('hub.gateWarn')}</span>
      </div>
      <dl className="kvs ob-hub-kvs">
        <dt className="k">{t('hub.name')}</dt>
        <dd>{facts.name || '—'}</dd>
        <dt className="k">{t('hub.currency')}</dt>
        <dd>{pending(facts.currency)}</dd>
        <dt className="k">{t('hub.timeZone')}</dt>
        <dd>{pending(timeZoneLabel(facts.timeZone))}</dd>
      </dl>
      {admin ? (
        <>
          <div className="ob-hub-acts">
            <a className="btn btn-primary" href={confirmHref}>
              {t('hub.confirm')} <Icon name="external" />
            </a>
          </div>
          <p className="s13 t3 mt8">{t('hub.returnNote')}</p>
        </>
      ) : (
        <p className="t2 mt16">{t('hub.askAdmin')}</p>
      )}
    </div>
  );
}
