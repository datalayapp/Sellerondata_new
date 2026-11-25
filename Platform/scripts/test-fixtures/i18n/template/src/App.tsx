import { useTranslation } from 'react-i18next';
export function App({ k }: { k: string }) {
  const { t } = useTranslation('common');
  return <p>{t(`b.${k}`)}</p>;
}
