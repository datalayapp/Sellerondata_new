import { useEffect, useState } from 'react';
import { reloadDiscardingChanges } from '../lib/unsavedChanges';
import { Trans, useTranslation } from 'react-i18next';
import { i18n } from '../i18n';
import { Icon } from './Icon';

// Eski sekme koruması: demo/sunucu yeniden kurulunca açık kalan sekme eski paketle yeni API'ye
// istek atar ve çöker. /version.json'daki kimlik bu paketinkinden farklıysa kullanıcıya yenilemesini söyleriz.
const RELOAD_KEY = 'deciship.chunkReloadAt';
const POLL_MS = 5 * 60_000;

async function serverBuildId(): Promise<string | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const j = (await res.json()) as { buildId?: unknown };
    return typeof j.buildId === 'string' ? j.buildId : null;
  } catch {
    return null; // dev server (SPA fallback HTML), offline… → no banner
  }
}

/** Lazy chunk could not be loaded (old hashes are gone after a deploy) → reload once. */
export function reloadOnceForStaleChunk(): boolean {
  const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
  if (Date.now() - last < 60_000) return false;
  sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  window.location.reload();
  return true;
}
export const isChunkLoadError = (e: unknown) =>
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(
    String((e as Error | null)?.message ?? e),
  );

/** Ayarlar / tarife düzenleyicideki kaydet çubuğu "kaydedilmedi" durumundaysa yenileme değişiklikleri siler. */
function reloadNow() {
  if (!document.querySelector('.savebar.is-dirty')) return window.location.reload();
  // the page's own beforeunload prompt would ask again: one confirmation is enough
  if (window.confirm(i18n.t('update.unsaved'))) reloadDiscardingChanges();
}

export function UpdateBanner() {
  const { t } = useTranslation();
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const onPreload = (e: Event) => {
      if (reloadOnceForStaleChunk()) e.preventDefault();
    };
    window.addEventListener('vite:preloadError', onPreload);
    return () => window.removeEventListener('vite:preloadError', onPreload);
  }, []);

  useEffect(() => {
    if (!import.meta.env.PROD) return;
    let alive = true;
    const check = async () => {
      const id = await serverBuildId();
      if (alive && id && id !== __BUILD_ID__) setStale(true);
    };
    const onFocus = () => void check();
    const onVis = () => document.visibilityState === 'visible' && void check();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
    const h = setInterval(check, POLL_MS);
    void check();
    return () => {
      alive = false;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(h);
    };
  }, []);

  if (!stale) return null;
  return (
    <div className="upd" role="status" aria-live="polite">
      <Icon name="refresh" />
      <span className="grow">
        <Trans i18nKey="update.message" components={{ b: <b /> }} />
      </span>
      <button type="button" className="btn btn-primary btn-sm" onClick={reloadNow}>
        {t('update.reload')}
      </button>
      <button type="button" className="btn btn-ghost plain btn-sm btn-icon upd-x" aria-label={t('update.dismiss')} onClick={() => setStale(false)}>
        <Icon name="close" />
      </button>
    </div>
  );
}
