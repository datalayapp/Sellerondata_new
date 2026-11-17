// Arka plan işleri (Mesaj 7) için saf yardımcılar: tarayıcısız sınanır (`test/jobs.test.ts`).
import type { JobStage, JobStatus, JobView } from '../api/types';

const FINISHED: readonly JobStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

/** Bitmiş durumlar değişmez: yoklama durur. */
export function isJobFinished(status: JobStatus): boolean {
  return FINISHED.includes(status);
}

/** Sözlükte (`common:jobs.stage.*`) karşılığı olan aşamalar. */
export const JOB_STAGES: readonly JobStage[] = [
  'pdfRead',
  'pdfPages',
  'pdfCheck',
  'tariffScan',
  'tariffExtract',
  'bulkCheck',
  'bulkWrite',
  'importRead',
  'importCompare',
  'importWrite',
  'tariffReview',
];

/** Aşama → `common` ad alanındaki metin anahtarı; bilinmeyen aşamada null (ekran durum metnine döner). */
export function jobStageKey(stage: string | null | undefined): string | null {
  return stage && (JOB_STAGES as readonly string[]).includes(stage) ? `jobs.stage.${stage}` : null;
}

export type JobPhase = 'queued' | 'running' | 'stopping' | 'succeeded' | 'failed' | 'stopped';

/** Ekranın tek bakışta ayırdığı hâl. `cancelRequested` iş bitmeden "Durduruluyor…" demektir. */
export function jobPhase(job: Pick<JobView, 'status' | 'cancelRequested'>): JobPhase {
  switch (job.status) {
    case 'SUCCEEDED':
      return 'succeeded';
    case 'FAILED':
      return 'failed';
    case 'CANCELLED':
      return 'stopped';
    case 'QUEUED':
      return job.cancelRequested ? 'stopping' : 'queued';
    default:
      return job.cancelRequested ? 'stopping' : 'running';
  }
}

/** Toplam biliniyorsa yüzde (0-100, tam sayı); bilinmiyorsa null (çubuk yavaş ilerler). */
export function jobPercent(progress: Pick<JobView['progress'], 'done' | 'total'>): number | null {
  const { done, total } = progress;
  if (total == null || !(total > 0)) return null;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

/** Toplam bilinmeyen iş için bugünkü gibi yavaşlayan çubuk: hiçbir zaman 96'yı geçmez. */
export function creepPercent(elapsedSec: number, slowAfterSec = 60): number {
  return Math.min(96, 100 * (1 - Math.exp(-Math.max(0, elapsedSec) / (slowAfterSec * 0.55))));
}

/** Sunucunun bildirdiği süreye yoklamadan bu yana geçeni ekler; iş bitmişse sunucu değeri olduğu gibi kalır. */
export function jobElapsedMs(job: Pick<JobView, 'status' | 'elapsedMs'>, receivedAt: number, now: number): number {
  const base = Math.max(0, job.elapsedMs);
  return isJobFinished(job.status) ? base : base + Math.max(0, now - receivedAt);
}

/** Geçen süre "d:ss" (örn. 0:07, 2:35). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Yoklama aralığı: izlemenin ilk 10 saniyesinde 1 sn, sonra 2 sn. Sayfa gizliyken seyrek (10 sn): sonuç sekmeye dönünce hazırdır.
 * `sinceMs`: izlemenin başlamasından bu yana geçen süre.
 */
export function jobPollMs(sinceMs: number, hidden = false): number {
  if (hidden) return 10_000;
  return sinceMs < 10_000 ? 1_000 : 2_000;
}

/** 202 yanıtı mı (`{ job, joined }`), yoksa eşzamanlı gövde mi? */
export function isJobStarted(r: unknown): r is { job: JobView; joined: boolean } {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return typeof o.joined === 'boolean' && typeof o.job === 'object' && o.job !== null && typeof (o.job as { id?: unknown }).id === 'string';
}
