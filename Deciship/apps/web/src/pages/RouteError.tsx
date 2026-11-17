import { useEffect } from 'react';
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { useTranslation } from 'react-i18next';
import { BrandLogo, useDocumentTitle } from '../components/Brand';
import { Icon } from '../components/Icon';
import { isChunkLoadError, reloadOnceForStaleChunk } from '../components/UpdateBanner';

/** Router'ın ham "Unexpected Application Error!" ekranı yerine. `standalone`: kabuk (sidebar) yokken logo gösterilir. */
export function RouteError({ standalone = false }: { standalone?: boolean }) {
  const { t } = useTranslation();
  const error = useRouteError();
  useDocumentTitle(t('routeError.docTitle'));
  const chunk = isChunkLoadError(error);
  useEffect(() => {
    if (chunk) reloadOnceForStaleChunk();
  }, [chunk]);

  const tech = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}${error.data ? `\n${typeof error.data === 'string' ? error.data : JSON.stringify(error.data)}` : ''}`
    : error instanceof Error
      ? `${error.name}: ${error.message}${error.stack ? `\n\n${error.stack.split('\n').slice(1, 8).join('\n')}` : ''}`
      : String(error);

  return (
    <div className="rerr" role="alert">
      {standalone && (
        <a className="rerr-brand" href="/deciship/" aria-label={t('routeError.home')}>
          <BrandLogo size={32} />
        </a>
      )}
      <div className="rerr-card">
        <span className="rerr-ic" aria-hidden="true">
          <Icon name="warn" size={24} />
        </span>
        <h1 className="rerr-h">{t('routeError.title')}</h1>
        <p className="rerr-p">
          {chunk ? t('routeError.stale') : t('routeError.generic')}
        </p>
        <div className="rerr-acts">
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            <Icon name="refresh" /> {t('routeError.reload')}
          </button>
          <a className="btn btn-secondary" href="/deciship/">
            <Icon name="home" /> {t('notFound.back')}
          </a>
        </div>
        <details className="rerr-tech">
          <summary>
            <Icon name="chev" className="tfh-chev" /> {t('routeError.tech')}
          </summary>
          <pre>{tech}</pre>
        </details>
      </div>
    </div>
  );
}
