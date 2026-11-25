/**
 * `TARIFF_IMPORT_REVIEW` (KALANLAR 6.18): tarife içe aktarma taslağının yapay zekâ incelemesi.
 *
 * Uç (`POST /tariff-imports/:draftId/review`) yalnız `?async=1` ile işi açar (Y83 kuralı: yapay zekâ çağrısı istek içinde
 * değil); gövde `routes/tariffs.ts` `runTariffReview`. Sonuç bugünkü inceleme yanıtıdır; inceleme taslağa yazılır, uygulama
 * oradan okur.
 *
 * Çift ücret olmaz: çağrı işe özgü önbellekle yapılır ve inceleme işin kimliğiyle taslağa yazılır; yeniden deneme (devralma,
 * kapanış, süreç ölümü) önbellekten ya da taslaktan alır, sağlayıcıyı yeniden ücretlendirmez. Başlarken başlatanın hâlâ
 * etkin ve tarife düzenleme yetkili olduğu denetlenir (`starter.ts`). Durdurma süren çağrıyı keser (`jobCancelSignal`, KALANLAR 6.5);
 * çağrı bittikten sonra gelen durdurmada inceleme taslakta kalır, iş `CANCELLED`.
 */
import type { Locale } from '@deciship/core';
import { notFound } from '../../../errors.ts';
import { currentLocale, m as msg, withLocale } from '../../../i18n/index.ts';
import { runTariffReview, type TariffReviewJobInput } from '../../../routes/tariffs.ts';
import { aiJobContext } from '../../aiMeter.ts';
import { importOptionsSchema } from '../../tariffImport.ts';
import { jobCancelSignal } from '../runner.ts';
import { assertStarterMayRun } from '../starter.ts';
import { JobCancelled, type ClaimedJob, type JobHandler } from '../types.ts';
import { meterLogOf } from './invoicePdf.ts';

function inputOf(job: ClaimedJob): TariffReviewJobInput {
  const i = job.input as Partial<TariffReviewJobInput>;
  const options = importOptionsSchema.safeParse(i.options ?? {});
  if (i.v !== 1 || typeof i.draftId !== 'string' || !i.draftId || !options.success) throw notFound(msg('tariff.draftNotFound'));
  return { v: 1, locale: (i.locale === 'en' ? 'en' : 'tr') as Locale, aiLimits: i.aiLimits ?? {}, draftId: i.draftId, options: options.data };
}

export const tariffReviewHandler: JobHandler = async (ctx) => {
  const { job } = ctx;
  const input = inputOf(job);
  // kuyrukta beklerken başlatan çıkarıldıysa ya da yetkisi alındıysa ücretli çağrı yapılmaz
  await assertStarterMayRun(job, 'deciship.tariffs.edit');
  await ctx.progress({ stage: 'tariffReview' });
  const run = () =>
    runTariffReview({
      companyId: job.companyId,
      userId: job.createdById,
      draftId: input.draftId,
      options: input.options,
      jobId: job.id,
      ai: aiJobContext(job, 'TARIFF_REVIEW', { type: 'TariffImportDraft', id: input.draftId }, meterLogOf(ctx.log), jobCancelSignal(ctx.signal)),
    });
  const review = await (currentLocale() === input.locale ? run() : withLocale(input.locale, run));
  if (ctx.signal.aborted) throw new JobCancelled();
  return review;
};
