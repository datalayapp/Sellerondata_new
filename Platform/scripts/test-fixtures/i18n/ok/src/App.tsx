import { useTranslation } from 'react-i18next';
const RE = /çalışan|işçi/i;
export function App() {
  const { t } = useTranslation('common');
  console.warn('günlük: ölçüm başarısız');
  return <p>{t('a')} {t('b.c')}</p>;
}
