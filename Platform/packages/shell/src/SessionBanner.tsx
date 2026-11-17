import { useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { QueryClientContext } from '@tanstack/react-query';
import { Icon } from './icons.tsx';
import { Button } from './primitives.tsx';
import { sessionStatus } from './session/status.ts';
import { beginOrgChange } from './session/provider.tsx';

/**
 * Oturum uyarısı. Sayfanın üstünde durur, içeriğe dokunmaz: formdaki yazı yerinde kalır.
 * - Bağlantı yok: oturum düşmüş sayılmaz, "Yeniden dene".
 * - Firma başka sekmede değişti: bu sekmeden kayıt gitmez. "Sayfayı yenile" ya da bu sekmenin firmasıyla devam.
 */
export function SessionBanner({ orgName }: { orgName?: string | null }) {
  const { t } = useTranslation('shell');
  const status = useSyncExternalStore(sessionStatus.subscribe, sessionStatus.get);
  const qc = useContext(QueryClientContext);
  const [retrying, setRetrying] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeFailed, setResumeFailed] = useState(false);
  const [typed, setTyped] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);

  const retry = async () => {
    setRetrying(true);
    try {
      if (await sessionStatus.retry()) await qc?.invalidateQueries();
    } finally {
      setRetrying(false);
    }
  };

  useEffect(() => {
    // Yenilemeden önce sorulabilsin diye: formlardan birine yazıldı mı?
    const onInput = (e: Event) => {
      if ((e.target as Element | null)?.closest?.('form')) setTyped(true);
    };
    const onOffline = () => sessionStatus.update({ offline: true });
    const onOnline = () => {
      if (sessionStatus.get().offline) void retry();
    };
    document.addEventListener('input', onInput, true);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('input', onInput, true);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
    // retry kararlı olmak zorunda değil: yalnız sessionStatus ve qc'ye bakar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status.orgChange) return;
    setConfirmReload(false);
    setResumeFailed(false);
  }, [status.orgChange]);

  const reload = () => {
    if (typed && !confirmReload) {
      setConfirmReload(true);
      return;
    }
    beginOrgChange();
    window.location.reload();
  };
  const resume = async () => {
    setResuming(true);
    setResumeFailed(false);
    try {
      await sessionStatus.resumeOrg();
      // Uyarı açıkken durdurulan okumalar yeniden gider. Yazıya dokunmaz: aynı firmanın verisi aynı kalır.
      await qc?.invalidateQueries();
    } catch {
      setResumeFailed(true);
    } finally {
      setResuming(false);
    }
  };

  if (status.orgChange?.ended) {
    const next = status.orgChange.others?.[0];
    return (
      <div className="sod-status" role="alert">
        <Icon name="warn" />
        <div className="sod-status-text">
          <strong>{t(status.orgChange.suspended ? 'session.suspendedTitle' : 'session.endedTitle')}</strong>
          <span>{next ? t('session.endedBodyOther') : t('session.endedBody')}</span>
          {resumeFailed && <span>{t('session.resumeFailed')}</span>}
        </div>
        <div className="sod-status-actions">
          {next && (
            <Button
              kind="secondary"
              small
              loading={resuming}
              onClick={async () => {
                setResuming(true);
                try {
                  await sessionStatus.switchOrg(next.id);
                  beginOrgChange();
                  window.location.assign('/home');
                } catch {
                  setResumeFailed(true);
                  setResuming(false);
                }
              }}
            >
              {t('session.switchTo', { org: next.name })}
            </Button>
          )}
          <Button kind="secondary" small onClick={reload}>
            {confirmReload ? t('session.reloadAnyway') : t('session.reload')}
          </Button>
        </div>
      </div>
    );
  }
  if (status.orgChange) {
    const current = status.orgChange.current;
    const body = orgName && current?.name ? t('session.orgBody', { tab: orgName, current: current.name }) : t('session.orgBodyPlain');
    return (
      <div className="sod-status" role="alert">
        <Icon name="warn" />
        <div className="sod-status-text">
          <strong>{t('session.orgTitle')}</strong>
          <span>{body}</span>
          {confirmReload && <span>{t('session.reloadConfirm')}</span>}
          {resumeFailed && <span>{t('session.resumeFailed')}</span>}
        </div>
        <div className="sod-status-actions">
          {orgName && !resumeFailed && (
            <Button kind="secondary" small loading={resuming} onClick={resume}>
              {t('session.resume', { org: orgName })}
            </Button>
          )}
          <Button kind="secondary" small onClick={reload}>
            {confirmReload ? t('session.reloadAnyway') : t('session.reload')}
          </Button>
        </div>
      </div>
    );
  }
  if (status.offline) {
    return (
      <div className="sod-status" role="alert">
        <Icon name="warn" />
        <div className="sod-status-text">
          <strong>{t('session.offlineTitle')}</strong>
          <span>{t('session.offlineBody')}</span>
        </div>
        <div className="sod-status-actions">
          <Button kind="secondary" small loading={retrying} onClick={retry}>
            {t('common.retry')}
          </Button>
        </div>
      </div>
    );
  }
  if (status.busy) {
    return (
      <div className="sod-status is-info" role="status">
        <Icon name="info" />
        <div className="sod-status-text">
          <span>{t('session.busy')}</span>
        </div>
      </div>
    );
  }
  return null;
}
