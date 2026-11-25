import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast, useSessionActions } from '@sellerondata/shell';

/**
 * Çıkış eylemi. Sunucu oturumu bitirmediyse (ağ, 5xx) kişi hâlâ oturumdadır: sayfada kalır ve bunu söyler.
 * `hard`: girişe tam sayfa geçiş (firmasız ekran).
 */
export function useLogoutAction(opts?: { hard?: boolean }) {
  const { t } = useTranslation();
  const { logout } = useSessionActions();
  const nav = useNavigate();
  return async () => {
    const { serverEnded } = await logout();
    if (!serverEnded) {
      toast.err(t('session.logoutFailed', { ns: 'shell' }), t('session.logoutFailedBody', { ns: 'shell' }), { always: true });
      return;
    }
    if (opts?.hard) window.location.assign('/login');
    else nav('/login', { replace: true });
  };
}
