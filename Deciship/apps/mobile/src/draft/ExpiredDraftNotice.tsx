import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { fmtDayTitle, fmtTime } from '../lib/format';
import { Banner, Button } from '../ui/components';
import { dismissExpiredNotices, expiredNoticeText, listExpiredNotices, onExpiredNoticesChanged, type ExpiredNotice } from './expiredNotice';
import { draftKey, DRAFT_TTL_DAYS } from './persist';

/** "Cuma, 6 Kasım 17:00": başlama anının günü ve saati. */
const when = (ms: number) => {
  const iso = new Date(ms).toISOString();
  return `${fmtDayTitle(iso)} ${fmtTime(iso)}`;
};

/**
 * Süresi dolup silinen yarım ölçümün bilgisi (11-B5). Oturumdaki kişi ve firmanın kapatılmamış bildirimleri tek kutuda;
 * "Tamam" ile kapatılınca bir daha görünmez. Kapatılmadıkça uygulama yeniden açılsa da durur.
 */
export function ExpiredDraftNotice() {
  const { t } = useTranslation('measure');
  const { scope } = useAuth();
  const owner = scope ? draftKey(scope) : null;
  const [list, setList] = useState<ExpiredNotice[]>([]);

  useEffect(() => {
    setList([]);
    if (!owner) return;
    let alive = true;
    let seq = 0;
    // Yalnız son okuma yazılır: kapatmadan önce başlamış eski okuma kutuyu geri açmaz.
    const load = () => {
      const my = ++seq;
      listExpiredNotices(owner)
        .then((l) => {
          if (alive && my === seq) setList(l);
        })
        .catch((e) => console.warn('expired draft notice', e));
    };
    load();
    const off = onExpiredNoticesChanged(load);
    return () => {
      alive = false;
      off();
    };
  }, [owner]);

  const close = useCallback(() => {
    const ids = list.map((n) => n.clientId);
    setList([]);
    dismissExpiredNotices(ids).catch((e) => console.warn('expired draft dismiss', e));
  }, [list]);

  if (!list.length) return null;
  return (
    <Banner
      kind="warn"
      title={t('draft.expiredTitle', { count: list.length })}
      text={list.map((n) => expiredNoticeText(n, t, when, DRAFT_TTL_DAYS)).join('\n')}
      action={<Button label={t('common.ok')} kind="secondary" small onPress={close} />}
    />
  );
}
