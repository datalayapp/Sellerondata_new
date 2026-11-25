/**
 * `INVOICE_IMPORT` (KALANLAR 6.18): büyük CSV/Excel faturanın içe aktarılması.
 *
 * Uç (`POST /invoices`) dosyanın veri satırı `INVOICE_IMPORT_QUEUE_ROWS`'u aşınca işi açar (`?async=1` → 202); küçük
 * dosya ve PDF istek içinde kalır. İş, istekle aynı işlevi çalıştırır (`routes/invoices.ts` `runInvoiceImport`): aynı
 * denetimler, aynı karşılaştırma, aynı tek işlemli yazım. Sonuç bugünkü 201 gövdesidir (`fileUrl` yok).
 *
 * - Kapı hataları (409 `MAPPING_UNVERIFIED`, `INVOICE_OVERLAP`, `WEIGHT_FORMAT_REQUIRED`, `INVOICE_EXISTS`…) işin hatasıdır:
 *   `FAILED`, `error` = aynı kod, ileti ve ayrıntı; hiçbir şey yazılmamıştır. Kullanıcı onaylayıp yeniden başlatır.
 * - Durdurma: adım arasında (`JobCancelled`, yazım yok). Yazım işleminin sonunda işin satırı kilitlenip durdurma isteği
 *   yeniden okunur; istenmişse işlem geri alınır (fatura yazılmaz). Kilitten sonra gelen durdurma işlemi bekler, fatura
 *   yazılmış olur ve iş `SUCCEEDED` biter.
 * - Tek yazım: fatura kimliği yazımla aynı işlemde işin kaydına (`checkpoint.invoiceId`) çitle yazılır; denetim kaydı da
 *   aynı işlemdedir. Kirayı kaybeden çalıştırıcının yazımı geri alınır. Yazımdan sonra iş yeniden denenirse (kapanış,
 *   geçici hata, süre sınırı, süreç ölümü) fatura ikinci kez yazılmaz: yazım sonrası tazeleme bitmediyse
 *   (`checkpoint.settled` yok) yeniden çalıştırılır (güvenli), sonra kayıtlı faturanın sonucu döner. Ölçüm işaretleri
 *   yazımla aynı işlemde kalıcıdır; sıraya alınmaları kaldıysa tarama tamamlar.
 * - Fatura yazıldıktan sonra durdurma işi durdurmaz (`registry.ts` `committed`, `ctx.markCommitted`): `POST /jobs/:id/cancel`
 *   409 `JOB_NOT_CANCELLABLE`, iş `SUCCEEDED` biter, panel faturayı açar.
 * - Başlarken başlatanın hâlâ etkin ve yükleme yetkili olduğu denetlenir (`starter.ts`); değilse 403, yazım yok.
 */
import type { Prisma } from '../../../db.ts';
import { badRequest } from '../../../errors.ts';
import { currentLocale, m as msg, withLocale } from '../../../i18n/index.ts';
import {
  IMPORT_JOB_ERRORS_MAX,
  importedInvoiceResult,
  invoiceImportBody,
  invoiceImportJobResult,
  runInvoiceImport,
  settleImportRecompare,
  type ImportWritten,
  type InvoiceImportInput,
  type InvoiceImportOutcome,
} from '../../../routes/invoices.ts';
import { assertStarterMayRun } from '../starter.ts';
import { JobCancelled, type ClaimedJob, type JobHandler } from '../types.ts';

/** İşin kaydı: yazılmış fatura, satır hataları, yazım sonrası tazelemenin nedeni ve bitip bitmediği. */
type ImportCheckpoint = { invoiceId: string; errors: InvoiceImportOutcome['errors']; recompare: ImportWritten['recompare']; settled: boolean };

function inputOf(job: ClaimedJob): InvoiceImportInput {
  const i = job.input as Partial<InvoiceImportInput>;
  const body = invoiceImportBody.safeParse(i.body);
  if (i.v !== 1 || !body.success) throw badRequest('VALIDATION', msg('err.validation'));
  return {
    v: 1,
    locale: i.locale === 'en' ? 'en' : 'tr',
    body: body.data,
    mayRemember: i.mayRemember === true,
    digest: typeof i.digest === 'string' ? i.digest : '',
  };
}

function checkpointOf(raw: unknown): ImportCheckpoint | null {
  const c = raw && typeof raw === 'object' ? (raw as Partial<ImportCheckpoint>) : null;
  if (!c || typeof c.invoiceId !== 'string' || !c.invoiceId) return null;
  return {
    invoiceId: c.invoiceId,
    errors: Array.isArray(c.errors) ? c.errors : [],
    recompare: c.recompare === 'MEASUREMENT' || c.recompare === 'DUPLICATE' ? c.recompare : null,
    // eski biçimde bayrak yok: tazeleme yeniden çalıştırılır (güvenli)
    settled: c.settled === true,
  };
}

export const invoiceImportHandler: JobHandler = async (ctx) => {
  const { job } = ctx;
  const input = inputOf(job);
  const run = async () => {
    const done = checkpointOf(job.checkpoint);
    if (done) {
      // önceki deneme faturayı yazdı, bitişi yazamadı: fatura yeniden yazılmaz; yarım kalan tazeleme tamamlanır
      ctx.markCommitted();
      if (!done.settled) {
        if (done.recompare) await settleImportRecompare(done.invoiceId, done.recompare, ctx.log);
        await ctx.saveCheckpoint({ ...done, settled: true });
      }
      return importedInvoiceResult(job.companyId, done.invoiceId, done.errors);
    }
    await assertStarterMayRun(job, 'deciship.invoices.upload');
    let written: ImportCheckpoint | null = null;
    const r = await runInvoiceImport({
      companyId: job.companyId,
      userId: job.createdById,
      body: input.body,
      mayRemember: input.mayRemember,
      log: ctx.log,
      hooks: {
        stage: (stage) => ctx.progress({ stage }),
        checkCancel: () => {
          if (ctx.signal.aborted) throw new JobCancelled();
        },
        inWrite: async (tx: Prisma.TransactionClient, w) => {
          const checkpoint: ImportCheckpoint = {
            invoiceId: w.invoiceId,
            errors: w.errors.slice(0, IMPORT_JOB_ERRORS_MAX),
            recompare: w.recompare,
            settled: false,
          };
          // çit: kira bu çalıştırıcıda değilse atar, işlem (fatura) geri alınır; satır işlem sonuna dek kilitli
          await ctx.fence(tx, { checkpoint });
          const rows = await tx.$queryRaw<{ cancelRequestedAt: Date | null }[]>`SELECT "cancelRequestedAt" FROM "Job" WHERE "id" = ${job.id}`;
          if (rows[0]?.cancelRequestedAt || ctx.signal.aborted) throw new JobCancelled();
          written = checkpoint;
        },
        committed: () => ctx.markCommitted(),
        settled: async () => {
          if (written) await ctx.saveCheckpoint({ ...(written as ImportCheckpoint), settled: true });
        },
      },
    });
    return invoiceImportJobResult(r.invoice, r.errors, r.importReport);
  };
  // Dil arka planda: çalıştırıcı `withLocale(input.locale)` açar; açmadıysa burada.
  return currentLocale() === input.locale ? run() : withLocale(input.locale, run);
};
