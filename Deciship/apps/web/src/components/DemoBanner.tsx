import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { demo } from '../api/endpoints';
import { useAuth, usePermission, useProductMe } from '../auth/AuthContext';
import { clearOnboardingRedirect } from '../lib/onboarding';
import { FEATURES } from '../lib/features';
import { Icon } from './Icon';
import { toast } from './Toast';
import { Button, Modal, ModalAction, errorMessage } from './ui';

/**
 * Örnek veriyle deneme bandı (MESAJ-14 §3, §4.3): deneme açıkken bütün sayfaların üstünde durur.
 * "Denemeyi bitir" yalnız ayar yetkisi olanda; bitirme örnek veriyi siler, bu yüzden önce onay istenir.
 */
export function DemoBanner() {
  const { t } = useTranslation('common');
  const me = useProductMe();
  const canManage = usePermission('deciship.settings.manage');
  const qc = useQueryClient();
  const nav = useNavigate();
  const { refreshMe } = useAuth();
  const [ask, setAsk] = useState(false);

  const end = useMutation({
    mutationFn: demo.end,
    onSuccess: async () => {
      setAsk(false);
      clearOnboardingRedirect();
      await qc.invalidateQueries();
      await refreshMe().catch(() => undefined);
      toast.ok(t('demo.ended'));
      nav('/setup');
    },
    onError: (e) => toast.err(errorMessage(e)),
  });

  if (!FEATURES.demoTour || !me.company.settings.demo) return null;
  return (
    <>
      <div className="notif info ds-readonly demo-band" role="status">
        <Icon name="info" />
        <span className="demo-band-text">{t('demo.band')}</span>
        {canManage && (
          <Button small kind="secondary" onClick={() => setAsk(true)}>
            {t('demo.end')}
          </Button>
        )}
      </div>
      {ask && (
        <Modal
          title={t('demo.endTitle')}
          busy={end.isPending}
          onClose={() => setAsk(false)}
          actions={
            <>
              <ModalAction kind="dark" onClick={() => setAsk(false)} disabled={end.isPending}>
                {t('demo.cancel')}
              </ModalAction>
              <ModalAction kind="danger" loading={end.isPending} onClick={() => end.mutate()}>
                {t('demo.endConfirm')}
              </ModalAction>
            </>
          }
        >
          <p>{t('demo.endBody')}</p>
          <p>{t('demo.endChanges')}</p>
        </Modal>
      )}
    </>
  );
}
