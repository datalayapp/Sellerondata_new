import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { isOrgAdmin } from '../lib/permissions';
import { Field } from './ui';
import { Icon } from './Icon';

/** Merkez'den yönetilen alanın notu: yöneticiye bağlantı, diğerlerine kime başvuracağı. */
function HubManagedHelp({ text }: { text: string }) {
  const { t } = useTranslation('platform');
  const { person } = useAuth();
  return (
    <>
      {text}{' '}
      {isOrgAdmin(person) ? (
        // Merkez ayrı uygulama: tam sayfa gezinti
        <a href="/account/company">
          {t('company.changeInHub')} <Icon name="arrow" />
        </a>
      ) : (
        t('company.askAdmin')
      )}
    </>
  );
}

/** Şirket adı Merkez'den gelir ve burada salt okunurdur (ARCHITECTURE §4). Kurulum ve Ayarlar aynı alanı kullanır. */
export function CompanyNameField({ id }: { id: string }) {
  const { t } = useTranslation('platform');
  const { person } = useAuth();
  return (
    <Field label={t('company.name')} htmlFor={id} help={<HubManagedHelp text={t('company.managedInHub')} />}>
      <input id={id} className="inp w-lg" readOnly aria-readonly="true" value={person?.activeOrg?.name ?? ''} />
    </Field>
  );
}
