import { useTranslation } from 'react-i18next';
export function App() {
  const { t } = useTranslation('common');
  return <p>{t('a')} {t('yok.anahtar')}</p>;
}
