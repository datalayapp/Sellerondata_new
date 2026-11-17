import { Trans, useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';

// ======================================================================
// Kısa yardım: hangi dosya yüklenmeli
// ======================================================================
export function TariffFileHelp() {
  const { t } = useTranslation('tariffImport');
  return (
    <details className="tfh">
      <summary>
        <Icon name="info" />
        <span className="grow">{t('fileHelp.title')}</span>
        <Icon name="chev" className="tfh-chev" />
      </summary>
      <div className="tfh-body">
        <p>
          <Trans t={t} i18nKey="fileHelp.p1" components={{ b: <b /> }} />
        </p>
        <p>{t('fileHelp.p2')}</p>
        <p>{t('fileHelp.p3')}</p>
      </div>
    </details>
  );
}
