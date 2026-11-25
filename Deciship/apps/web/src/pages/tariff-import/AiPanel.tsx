import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { JobProgress } from '../../components/JobProgress';
import { Tag, errorMessage } from '../../components/ui';
import { IssueList, VERDICT_TONE, fmtD, type AiState } from './shared';

// ======================================================================
// Yapay zekâ sonucu: karar + özet; ayrıntılar açılır
// ======================================================================
const TR_RE = /t[üu]rk|^tr$|turkey/i; // i18n-ok: ülke adı eşleme regex'i

export function AiPanel({
  ai,
  stale,
  onRun,
  onStop,
  onUseName,
}: {
  ai: AiState;
  stale: boolean;
  onRun: () => void;
  /** KALANLAR 6.18: süren inceleme işini durdurur */
  onStop?: () => void;
  onUseName?: (v: string) => void;
}) {
  const { t } = useTranslation('tariffImport');
  if (ai.s === 'idle') return null;
  // KALANLAR 6.18: inceleme arka plan işi; iş başlayınca ortak ilerleme görünümü (aşama, süre, "Durdur")
  if (ai.s === 'loading' && ai.job)
    return <JobProgress job={ai.job} receivedAt={ai.at ?? Date.now()} onStop={onStop} backgroundText={t('ai.loading')} slowAfterSec={40} />;
  if (ai.s === 'loading')
    return (
      <div className="iw-ai busy" role="status">
        <Icon name="spin" className="spin" />
        <span>{t('ai.loading')}</span>
      </div>
    );
  if (ai.s === 'off')
    return (
      <div className="iw-ai">
        <Icon name="info" />
        <span className="t2">{t('ai.off')}</span>
      </div>
    );
  if (ai.s === 'error')
    return (
      <div className="iw-ai">
        <Icon name="warn" />
        <span className="grow t2">
          {t('ai.failed')} {ai.e instanceof ApiError && ai.e.code === 'AI_BUSY' ? t('ai.busy') : errorMessage(ai.e)}
        </span>
        <button type="button" className="link-btn" onClick={onRun}>
          <Icon name="refresh" /> {t('ai.retry')}
        </button>
      </div>
    );
  const r = ai.r;
  const d = r.detected;
  const id = r.identity;
  const facts: { k: string; v: string; bad?: boolean }[] = [
    { k: t('ai.facts.carrier'), v: d.carrier || '—' },
    { k: t('ai.facts.service'), v: d.service || '—' },
    { k: t('ai.facts.origin'), v: d.origin || '—', bad: Boolean(d.origin && !TR_RE.test(d.origin)) },
    { k: t('ai.facts.weightUnit'), v: d.weightUnit ?? '—', bad: d.weightUnit === 'lb' },
    { k: t('ai.facts.currency'), v: d.currency || '—' },
    { k: t('ai.facts.validity'), v: d.effectiveDate ? fmtD(d.effectiveDate) : '—' },
    { k: t('ai.facts.listRate'), v: d.isListRate == null ? '—' : t(d.isListRate ? 'ai.facts.listYes' : 'ai.facts.listNo'), bad: d.isListRate === true },
  ];
  return (
    <section className={`iw-ai done ${r.verdict}`} aria-labelledby="iw-ai-h">
      <div className="iw-ai-top">
        <Icon name="spark" />
        <b id="iw-ai-h">{t('ai.title')}</b>
        <Tag tone={VERDICT_TONE[r.verdict]} small>
          {t(`ai.verdict.${r.verdict}`)}
        </Tag>
        {stale && (
          <button type="button" className="link-btn iw-ai-re" onClick={onRun}>
            <Icon name="refresh" /> {t('ai.recheck')}
          </button>
        )}
      </div>
      <p className="iw-ai-sum">{r.summary}</p>
      <details className="iw-ai-more">
        <summary>
          <Icon name="chev" className="tfh-chev" /> {t('ai.details')}
        </summary>
        {id?.description && (
          <p className="iw-ai-what">
            <b>{t('ai.whatIsThis')}</b> {id.description}
          </p>
        )}
        {id?.suggestedName && (
          <p className="iw-ai-what">
            <b>{t('ai.suggestedName')}</b> {id.suggestedName}
            {onUseName && (
              <>
                {' '}
                <button type="button" className="link-btn" onClick={() => onUseName(id.suggestedName)}>
                  {t('ai.useName')}
                </button>
              </>
            )}
          </p>
        )}
        <dl className="iw-facts">
          {facts.map((f) => (
            <div key={f.k} className={f.bad ? 'bad' : undefined}>
              <dt>{f.k}</dt>
              <dd>{f.v}</dd>
            </div>
          ))}
        </dl>
        {r.issues.length > 0 && <IssueList items={r.issues} className="mt12" />}
        <p className="iw-model">{t('ai.model', { model: r.model })}</p>
      </details>
    </section>
  );
}
