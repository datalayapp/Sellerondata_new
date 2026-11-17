import { useTranslation } from 'react-i18next';
import { useQueue } from '../queue/QueueContext';
import { Banner } from './components';

/** Bu telefonda başka kişi veya firma oturumunda bekleyen ölçümler. Yalnız sayı gösterir: içerik sahibine aittir. */
export function OtherSessionsBanner() {
  const { t } = useTranslation('auth');
  const { others } = useQueue();
  if (others.total === 0) return null;
  const text = others.samePerson > 0 && others.otherPerson > 0 ? t('others.both') : others.samePerson > 0 ? t('others.samePerson') : t('others.otherPerson');
  return <Banner kind="info" icon="clock" title={t('others.title', { count: others.total })} text={text} />;
}
