import { ApiError } from '../../api/client';
import { invoices, jobs } from '../../api/endpoints';
import type { InvoiceListItem, InvoicePreview } from '../../api/types';
import { isJobFinished, jobPollMs } from '../../lib/jobs';

/** Bekleme kesildi (sihirbaz adımından çıkıldı): okuma sunucuda sürer, sonuç fatura yükleme sayfasının bandında durur. */
export class SampleLeft extends Error {
  constructor() {
    super('left');
    this.name = 'AbortError';
  }
}

/**
 * Y80-E3: kurulum örnek faturası PDF ise arka planda okunur (`POST /invoices/preview?async=1`, Y83: uzun iş istek içinde
 * değil), iş bitene dek yoklanır, sonra okunmuş önizlemeden örnek fatura yazılır (`POST /invoices/samples` JSON). Satırlar
 * sunucudaki iş sonucundan gelir. Yazım düşerse önizleme dosyası bırakılır (silinir). `alive()` false olunca bekleme kesilir.
 */
export async function uploadSamplePdf(
  file: File,
  carrierId: string,
  alive: () => boolean,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ invoice: InvoiceListItem; lines: number }> {
  const started = await invoices.previewAsync(file, carrierId);
  if ('preview' in started) {
    // adı .pdf ama içeriği tablo: bugünkü tek adımlı yol
    await invoices.discardPreview(started.preview.fileId);
    return invoices.uploadSample(file, carrierId);
  }
  let job = started.job;
  const t0 = Date.now();
  while (!isJobFinished(job.status)) {
    if (!alive()) throw new SampleLeft();
    await wait(jobPollMs(Date.now() - t0, document.hidden));
    if (!alive()) throw new SampleLeft();
    job = await jobs.get(job.id);
  }
  if (job.status !== 'SUCCEEDED' || !job.result) {
    const e = job.error;
    throw e ? new ApiError(e.statusCode, e.code, e.message, e.details) : new ApiError(500, 'INTERNAL', '');
  }
  const fileId = (job.result as InvoicePreview).fileId;
  try {
    return await invoices.sampleFromPreview(fileId, carrierId);
  } catch (err) {
    void invoices.discardPreview(fileId);
    throw err;
  }
}
