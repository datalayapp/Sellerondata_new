import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useReturnTo } from '../lib/returnTo';
import { Icon } from './Icon';

/** Sayfa kurulum sihirbazından açıldıysa (`?donus=`) üstte "Kuruluma dön" bağlantısı; değilse hiçbir şey.
 * D09: çubuk banda binen ilk öğedir (`lift`); ardından gelen içerik ayrıca binmez, çubuğu örtmez (onboarding.css).
 */
export function ReturnBar({ hint }: { hint?: string }) {
  const { t } = useTranslation();
  const { to } = useReturnTo();
  if (!to) return null;
  return (
    <div className="notif info return-bar lift" role="note">
      <Icon name="info" />
      <span>
        <b>{t('returnBar.title')}</b> {hint ?? t('returnBar.hint')}
      </span>
      <Link className="link-btn act" to={to}>
        <Icon name="back" /> {t('returnBar.back')}
      </Link>
    </div>
  );
}
