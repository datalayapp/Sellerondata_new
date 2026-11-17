import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { measurements } from '../../api/endpoints';
import type { MeasurementDetail } from '../../api/types';
import { Icon } from '../../components/Icon';
import { toast } from '../../components/Toast';
import { Button, Modal, ModalAction } from '../../components/ui';
import { invalidateAfterMeasurementChange } from './shared';

/**
 * Silinmiş ölçümün kalıcı silinmesi (kullanıcı kararı 2026-11-13; API `POST /measurements/:id/purge`, SPEC §10.1).
 * Panelin "Geri yükle" kipinde ikincil çöp kutusu; tek birincil eylem "Geri yükle" kalır. Sunucu korumayı söylerse
 * (`purge.allowed: false`) düğme devre dışı, nedeni panelde görünür metin (`PurgeBlockedNote`). Onay penceresi geri
 * alınamadığını ve takip no'yu söyler; penceredeki tek eylem kırmızı "Kalıcı olarak sil".
 */
export function PurgeMeasurementButton({ m, onPurged }: { m: MeasurementDetail; onPurged: () => void }) {
  const { t } = useTranslation('measurements');
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const allowed = m.purge?.allowed === true;
  const purge = useMutation({
    mutationFn: () => measurements.purge(m.id),
    onSuccess: () => {
      toast.ok(t('toast.purged'), t('toast.recompare'));
      invalidateAfterMeasurementChange(qc);
      setConfirm(false);
      onPurged();
    },
    // Hata iletisini genel bildirim gösterir (koruma nedeni sunucudan); kayıt yeniden okunur, düğme güncel nedene döner.
    onError: () => {
      setConfirm(false);
      void qc.invalidateQueries({ queryKey: ['measurement', m.id] });
    },
  });
  if (!m.purge) return null;
  const label = allowed ? t('panel.purgeAria') : blockedText(t, m.purge.reason);
  return (
    <>
      <Button
        kind="secondary"
        icon="trash"
        className="pn-del"
        aria-label={t('panel.purgeAria')}
        title={label}
        disabled={!allowed}
        onClick={() => setConfirm(true)}
      />
      {confirm && (
        <Modal
          busy={purge.isPending}
          label={m.trackingNo}
          title={t('purge.title')}
          onClose={() => setConfirm(false)}
          actions={
            <>
              <ModalAction kind="dark" onClick={() => setConfirm(false)}>
                {t('actions.cancel')}
              </ModalAction>
              <ModalAction kind="danger" icon="trash" loading={purge.isPending} onClick={() => purge.mutate()}>
                {t('purge.confirm')}
              </ModalAction>
            </>
          }
        >
          <p>
            <Trans ns="measurements" i18nKey="purge.text" values={{ trackingNo: m.trackingNo }} components={{ b: <b />, mono: <span className="mono" /> }} />
          </p>
        </Modal>
      )}
    </>
  );
}

/** Koruma nedeninin metni (anahtarlar açık yazılı: sözlük denetimi görsün). */
function blockedText(t: (k: 'panel.purgeBlocked.DECIDED_LINE' | 'panel.purgeBlocked.DISPUTE') => string, reason: string | null) {
  return reason === 'DECIDED_LINE' ? t('panel.purgeBlocked.DECIDED_LINE') : t('panel.purgeBlocked.DISPUTE');
}

/** Kalıcı silme kapalıysa nedeni (görünür metin); açıksa ya da bilgi yoksa hiçbir şey. */
export function PurgeBlockedNote({ m }: { m: MeasurementDetail }) {
  const { t } = useTranslation('measurements');
  if (!m.purge || m.purge.allowed) return null;
  return (
    <p className="muted s12 row center-y" style={{ gap: 6, marginTop: -8, marginBottom: 16 }}>
      <Icon name="info" />
      <span>{blockedText(t, m.purge.reason)}</span>
    </p>
  );
}
