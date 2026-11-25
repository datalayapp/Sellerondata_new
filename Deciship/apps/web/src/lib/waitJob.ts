// KALANLAR 6.18: başlatılmış arka plan işini bitene dek bekleme (fatura içe aktarma, tarife incelemesi). Tarayıcısız sınanır
// (`test/wait-job.test.ts`): yoklama işlevi ve bekleme dışarıdan verilir.
import { ApiError } from '../api/client.ts';
import type { JobView } from '../api/types';
import { isJobFinished, jobPollMs } from './jobs.ts';

/** İş durduruldu (`CANCELLED`): ekran sessizce önceki hâline döner, hata göstermez. */
export class JobStopped extends Error {
  constructor() {
    super('stopped');
    this.name = 'JobStopped';
  }
}

/** Bekleme bırakıldı (sayfadan çıkıldı ya da yeni istek): iş sunucuda sürer. İptal gibi sayılır, hata gösterilmez. */
export class JobLeft extends Error {
  constructor() {
    super('left');
    this.name = 'AbortError';
  }
}

export interface WaitJobOptions {
  /** `jobs.get` */
  get: (id: string) => Promise<JobView>;
  /** her yoklamada (ilk hâl dahil): ekran ilerlemeyi gösterir */
  onUpdate?: (job: JobView, receivedAt: number) => void;
  /** false olunca bekleme kesilir (`JobLeft`) */
  alive?: () => boolean;
  wait?: (ms: number) => Promise<void>;
  hidden?: () => boolean;
}

/** Geçici yoklama hatasında (5xx, ağ) bekleme süreleri; tükenince son hata atılır. 4xx (404 dahil) hemen atılır. */
export const WAIT_JOB_RETRY_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000];

const transient = (e: unknown) => !(e instanceof ApiError) || e.status >= 500;

/**
 * İş bitene dek yoklar. Tek bir yoklama hatası beklemeyi bitirmez: geçici hatada (5xx, ağ) `WAIT_JOB_RETRY_MS` ile geri
 * çekilerek yeniden dener (sayaç her başarılı yoklamada sıfırlanır). `SUCCEEDED` → `result`; `FAILED` → `ApiError` (işin hatasının durum kodu, kodu, iletisi ve
 * ayrıntısı: eşzamanlı yanıtın hatasıyla aynı yoldan ele alınır); `CANCELLED` → `JobStopped`.
 */
export async function waitJob(start: JobView, o: WaitJobOptions): Promise<unknown> {
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const alive = o.alive ?? (() => true);
  const hidden = o.hidden ?? (() => typeof document !== 'undefined' && document.hidden);
  let job = start;
  o.onUpdate?.(job, Date.now());
  const t0 = Date.now();
  while (!isJobFinished(job.status)) {
    if (!alive()) throw new JobLeft();
    await wait(jobPollMs(Date.now() - t0, hidden()));
    if (!alive()) throw new JobLeft();
    for (let failures = 0; ; failures++) {
      try {
        job = await o.get(job.id);
        break;
      } catch (e) {
        const delay = WAIT_JOB_RETRY_MS[failures];
        if (!transient(e) || delay === undefined) throw e;
        await wait(delay);
        if (!alive()) throw new JobLeft();
      }
    }
    o.onUpdate?.(job, Date.now());
  }
  if (job.status === 'SUCCEEDED') return job.result;
  if (job.status === 'CANCELLED') throw new JobStopped();
  const e = job.error;
  throw e ? new ApiError(e.statusCode, e.code, e.message, e.details) : new ApiError(500, 'INTERNAL', '');
}
