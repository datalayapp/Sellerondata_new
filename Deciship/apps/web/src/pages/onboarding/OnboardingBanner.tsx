import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { onboarding } from '../../api/endpoints';
import { useAuth, usePermission } from '../../auth/AuthContext';
import { Icon } from '../../components/Icon';
import { toast } from '../../components/Toast';
import { errorMessage } from '../../components/ui';

/** Pano: kurulum tamamlanmadıysa kapatılabilir hatırlatma bandı. */
export function OnboardingBanner() {
  const { t } = useTranslation('onboarding');
  const { me, refreshMe } = useAuth();
  const canManage = usePermission('deciship.settings.manage');
  const [busy, setBusy] = useState(false);
  if (!canManage || !me?.onboarding?.showBanner) return null;
  return (
    <div className="notif info ob-banner" role="region" aria-label={t('banner.region')}>
      <Icon name="flag" />
      <span>
        <b>{t('banner.title')}</b> {t('banner.body')}
      </span>
      <span className="ob-banner-acts">
        <Link className="btn btn-secondary btn-sm" to="/setup">
          {t('banner.continue')} <Icon name="arrow" />
        </Link>
        <button
          type="button"
          className="icon-btn"
          aria-label={t('banner.close')}
          title={t('banner.closeTitle')}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onboarding.update({ dismissBanner: true });
              await refreshMe();
            } catch (e) {
              toast.err(t('banner.closeFailed'), errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Icon name="close" />
        </button>
      </span>
    </div>
  );
}
