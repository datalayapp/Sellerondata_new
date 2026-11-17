import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { JobView } from '../api/types';
import { creepPercent, formatElapsed, jobElapsedMs, jobPercent, jobPhase, jobStageKey } from '../lib/jobs';
import { Icon } from './Icon';
import { Button } from './ui';

/** Saniyede bir yenilenen "şimdi"; süre sayacı sunucunun yoklama aralığından bağımsız akar. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [active]);
  return now;
}

/**
 * Süren işin görünümü (D09, mevcut `lp` sınıfları): aşama ya da başlık, geçen süre, çubuk, durum satırı, "Durdur", arka plan notu.
 * Toplam biliniyorsa gerçek çubuk; bilinmiyorsa bugünkü gibi yavaşlayan çubuk. Bitmiş işte çizilmez (sonucu çağıran ele alır).
 */
export function JobProgress({
  job,
  receivedAt,
  title,
  onStop,
  stopLabel,
  queuedText,
  backgroundText,
  slowAfterSec,
}: {
  job: JobView;
  /** `job`un yoklamadan geldiği an (`useJob().receivedAt`); süre bundan sonrası için yerelde sayılır. */
  receivedAt: number;
  /** verilmezse aşama metni (yoksa durum metni) */
  title?: string;
  /** verilirse ikincil "Durdur" düğmesi çıkar */
  onStop?: () => void;
  stopLabel?: string;
  queuedText?: string;
  backgroundText?: string;
  /** toplamı bilinmeyen işte çubuğun yavaşlama süresi (sn) */
  slowAfterSec?: number;
}) {
  const { t } = useTranslation('common');
  const phase = jobPhase(job);
  const live = phase === 'queued' || phase === 'running' || phase === 'stopping';
  const now = useNow(live);
  const elapsed = jobElapsedMs(job, receivedAt, now);
  const pct = jobPercent(job.progress);
  const barPct = phase === 'queued' ? 0 : pct ?? creepPercent(elapsed / 1000, slowAfterSec);
  const stageKey = jobStageKey(job.progress.stage);
  // büyük PDF (Mesaj 7 E1): okunan sayfa grubu `counters.from`–`counters.to`, toplam sayfa `progress.total`
  const part = job.progress.stage === 'pdfPages' && job.counters?.from && job.counters?.to && job.progress.total ? { from: job.counters.from, to: job.counters.to, pages: job.progress.total } : null;
  // grup bilgisi yoksa yer tutuculu metin gösterilmez: genel "PDF okunuyor"
  const stageText = part ? t('jobs.stage.pdfPages', part) : stageKey === 'jobs.stage.pdfPages' ? t('jobs.stage.pdfRead') : stageKey ? t(stageKey) : null;
  const total = job.progress.total;
  const step = total != null && total > 0 ? t('jobs.step', { done: job.progress.done, total }) : null;
  const statusText =
    phase === 'queued'
      ? (queuedText ?? t('jobs.queued'))
      : phase === 'stopping'
        ? t('jobs.stopping')
        : [t('jobs.running'), step].filter(Boolean).join(' · ');
  const head = title ?? (phase === 'queued' ? (queuedText ?? t('jobs.queued')) : (stageText ?? t('jobs.running')));
  const canStop = Boolean(onStop) && job.cancellable && phase !== 'stopping';

  return (
    <div className="lp" role="status" aria-live="polite" data-testid="job-progress" data-job-status={job.status}>
      <div className="lp-h">
        <Icon name="spin" className="spin" />
        <b className="grow">{head}</b>
        <span className="lp-sec num">{t('jobs.elapsed', { time: formatElapsed(elapsed) })}</span>
      </div>
      <div className="lp-bar" aria-hidden="true">
        <span style={{ width: `${barPct}%` }} />
      </div>
      <p className="lp-note">
        {statusText}
        {title && stageText && phase === 'running' ? ` · ${stageText}` : ''}
        {job.attempt > 1 ? ` · ${t('jobs.resumed')}` : ''}
      </p>
      {canStop && (
        <div className="lp-act">
          <Button kind="secondary" small icon="close" onClick={onStop}>
            {stopLabel ?? t('jobs.stop')}
          </Button>
        </div>
      )}
      <p className="lp-note">{backgroundText ?? t('jobs.background')}</p>
    </div>
  );
}
