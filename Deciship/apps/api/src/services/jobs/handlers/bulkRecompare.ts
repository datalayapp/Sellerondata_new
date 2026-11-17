/**
 * Toplu yeniden hesabın arka plan işleri (Mesaj 7, plan §4.2, §4.11): `BULK_RECOMPARE_PREVIEW` (önce/sonra, salt okuma) ve
 * `BULK_RECOMPARE_APPLY` (onaylanan önizlemeyi yazar, kaldığı yerden sürer).
 *
 * Uçlar (`routes/tariffs.ts`, `routes/settings.ts` `recompare-invoices`) `?async=1` ile işi `startBulkJob` üzerinden
 * kuyruğa koyar; `async` yoksa 400 `ASYNC_REQUIRED` (Y83: eski eşzamanlı yol kaldırıldı, `queue.ts` `requireAsync`). Mesaj 4 kuralları
 * (donmuş ve karar verilmiş satır, etkin itiraz, fatura özeti) değişmez: yazım hâlâ yalnız `applyRecompare` ile.
 *
 * Girdi (`Job.input`): `{ v, locale, scope: 'tariff' | 'settings', tariffId?, token? }`. İzin `scope`'tan seçilir
 * (`registry.ts`). Firma satırın sütunundan, denetim kaydının kişisi `createdById`.
 *
 * KALANLAR 6.18: iki iş de her çalıştırmanın başında (ilk deneme, devralma, sıra bırakma sonrası) başlatanın etkinliğini ve
 * kapsamın iznini denetler (`starter.ts` `assertStarterMayRun`); uymuyorsa 403 `JOB_STARTER_FORBIDDEN`, o çalıştırmada hiçbir
 * şey yazılmaz. Uygulamanın önceki çalıştırmalarda yazdığı faturalar kalır (durdurmadaki gibi; kapsam kaydı temizlik kancasında).
 */
import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { prisma, type Prisma } from '../../../db.ts';
import { AppError, conflict } from '../../../errors.ts';
import { m } from '../../../i18n/index.ts';
import { applyBulk, previewBulk, type BulkCheckpoint, type BulkCounters, type BulkHooks, type BulkPreviewPlan, type BulkScope } from '../../bulkRecalc.ts';
import { currentCompareSettings } from '../../compare.ts';
import { enqueueJob, findJobLean, jobView, kickJob } from '../queue.ts';
import { jobSpec } from '../registry.ts';
import { JobAbort } from '../runner.ts';
import { assertStarterMayRun } from '../starter.ts';
import { JobCancelled, JobYield, type ClaimedJob, type JobContext, type JobHandler, type JobStarted } from '../types.ts';

/** Başlatan hâlâ etkin ve kapsamın izni (`registry.ts` `bulkPermission`) hâlâ onda mı. */
const assertBulkStarter = (job: ClaimedJob) => assertStarterMayRun(job, jobSpec(job.kind).permission(job.input));

export type BulkJobKind = 'BULK_RECOMPARE_PREVIEW' | 'BULK_RECOMPARE_APPLY';

/** Uygulamanın tekillik anahtarı (plan §4.2): kapsam başına tek uygulama; başka özetle gelen ikinci onay `JOB_ACTIVE`. */
export const bulkDedupeKey = (scope: BulkScope) => (scope.kind === 'tariff' ? `tariff:${scope.tariffId}` : 'settings');

/**
 * Önizlemenin tekillik anahtarı: kapsam + o anki dayanak (tarifenin bugünkü sürümü; ayar kapsamında karşılaştırma ayarının
 * özeti). Değişiklikten önce başlamış önizlemeye bağlanılmaz: tarife ya da ayar yeniden kaydedilince yeni önizleme açılır.
 */
export async function bulkPreviewDedupeKey(companyId: string, scope: BulkScope): Promise<string> {
  if (scope.kind === 'tariff') {
    const t = await prisma.tariff.findFirst({ where: { id: scope.tariffId, companyId }, select: { currentRevisionId: true } });
    return `${bulkDedupeKey(scope)}:${t?.currentRevisionId ?? '-'}`;
  }
  const s = (await currentCompareSettings(companyId)) as unknown as Record<string, unknown>;
  const sorted = Object.keys(s)
    .sort()
    .map((k) => [k, s[k]]);
  return `${bulkDedupeKey(scope)}:${crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 32)}`;
}

/** Girdinin kapsamı. Tanınmayan girdi iç hatadır (uç her zaman yazar). */
export function bulkScopeOf(input: Record<string, unknown>): BulkScope {
  if (input.scope === 'tariff' && typeof input.tariffId === 'string' && input.tariffId) return { kind: 'tariff', tariffId: input.tariffId };
  if (input.scope === 'settings') return { kind: 'settings' };
  throw new Error('bulk recompare job: unknown scope in input');
}

/**
 * Uçların kısayolu: işi ekler (ya da süren işe bağlanır), başlatır, 202 gövdesini döner. Uygulamada süren iş başka bir
 * önizlemenin özetiyle açılmışsa 409 `JOB_ACTIVE` (`details.job`); aynı özetle `joined: true`. Yarışta da doğru: tekillik
 * dizini ikinci eklemeyi süren işe bağlar, özet ardından karşılaştırılır.
 */
export async function startBulkJob(req: FastifyRequest, o: { kind: BulkJobKind; scope: BulkScope; label: string | null; token?: string }): Promise<JobStarted> {
  const companyId = req.auth.orgId;
  const input: Record<string, unknown> = {
    locale: req.locale,
    scope: o.scope.kind,
    ...(o.scope.kind === 'tariff' ? { tariffId: o.scope.tariffId } : {}),
    ...(o.kind === 'BULK_RECOMPARE_APPLY' ? { token: o.token } : {}),
  };
  const { jobId, joined } = await enqueueJob({
    companyId,
    createdById: req.auth.membershipId,
    kind: o.kind,
    dedupeKey: o.kind === 'BULK_RECOMPARE_APPLY' ? bulkDedupeKey(o.scope) : await bulkPreviewDedupeKey(companyId, o.scope),
    ref: o.scope.kind === 'tariff' ? { type: 'Tariff', id: o.scope.tariffId } : { type: 'Company', id: companyId },
    label: o.label ? o.label.slice(0, 200) : null,
    input,
  });
  if (joined && o.kind === 'BULK_RECOMPARE_APPLY') {
    const row = await findJobLean(companyId, jobId);
    const active = row?.input && typeof row.input === 'object' ? (row.input as Record<string, unknown>).token : undefined;
    if (row && active !== o.token) throw new AppError(409, 'JOB_ACTIVE', m('job.active'), { job: await jobView(req, jobId) });
  }
  await kickJob(jobId, req.log);
  return { job: await jobView(req, jobId), joined };
}

const progressOf = (ctx: JobContext): NonNullable<BulkHooks['onProgress']> => (p) =>
  ctx.progress({ stage: p.stage, done: p.done, total: p.total, ...(p.counters ? { counters: p.counters } : {}) });

/**
 * Uygulamanın kancaları. Kaldığı yer: plan `Job.checkpoint`'te (sahiplenmede satırla gelir), yazımı biten fatura sayısı
 * ve sayaçlar `progressDone` / `counters`'ta (her fatura yazımıyla aynı işlemde, `fence`). Plan kaydı da çitli işlemde,
 * `done = 0` ile birlikte yazılır: hesap aşamasının ilerlemesi yazım sırası sanılmaz. K4: atlanan faturaların listesi
 * planın yanında (`checkpoint.stale`), ilerleme ve sayaçlarla aynı çitli işlemde. İlk denemenin planı önizleme işinden
 * (`loadPreviewPlan`); plan kaydıyla AYNI işlemde aynı özetli bütün önizlemeler bu işle kullanılmış diye işaretlenir
 * (`checkpoint.appliedBy`): bir önizleme bir kez uygulanır, yeni önizleme (yeni satır) her zaman uygulanabilir.
 */
function applyHooks(ctx: JobContext, scope: BulkScope): BulkHooks {
  const { id, companyId } = ctx.job;
  // bu denemede bulunan önizleme satırı (plan kaydında işaretlenir)
  let claim: { previewId: string; token: string } | null = null;
  return {
    previewPlan: {
      async load(token) {
        const r = await loadPreviewPlan(ctx, scope, token);
        claim = r.previewId ? { previewId: r.previewId, token } : null;
        return r.plan;
      },
    },
    signal: ctx.signal,
    onProgress: progressOf(ctx),
    warn: (err, msg) => ctx.log.warn({ err }, msg),
    fence: (tx, p) => ctx.fence(tx, p),
    // Y57: başka firmanın toplu işi bekliyorsa pay dolunca yuva bırakılır; kaldığı yer aşağıdaki kayıtta
    shouldPause: () => ctx.shouldYield(),
    checkpoint: {
      async load() {
        if (ctx.job.checkpoint == null) return null;
        const row = await prisma.job.findFirst({ where: { id, companyId }, select: { progressDone: true, counters: true } });
        return row ? { checkpoint: ctx.job.checkpoint, done: row.progressDone, counters: row.counters } : null;
      },
      async save(c: BulkCheckpoint, counters: BulkCounters) {
        const used = claim;
        await prisma.$transaction(async (tx) => {
          await ctx.fence(tx, { done: 0, counters });
          await tx.job.updateMany({ where: { id, companyId }, data: { checkpoint: c as unknown as Prisma.InputJsonValue } });
          if (!used) return;
          // aynı özetli bütün önizlemeler kullanıldı: eski bir kopyası ikinci kez uygulanamaz
          await tx.$executeRaw`UPDATE "Job" SET "checkpoint" = jsonb_set("checkpoint", '{appliedBy}', to_jsonb(${id}::text))
            WHERE "companyId" = ${companyId} AND "kind" = 'BULK_RECOMPARE_PREVIEW' AND "checkpoint"->>'token' = ${used.token}
              AND "checkpoint"->>'appliedBy' IS NULL`;
          const mine = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Job"
            WHERE "id" = ${used.previewId} AND "companyId" = ${companyId} AND "checkpoint"->>'appliedBy' = ${id}`;
          // arada başka uygulama kullandı (aynı kapsamda eşzamanlı uygulama olmaz; yine de): plan kaydı geri alınır
          if (mine.length !== 1) throw conflict('PREVIEW_STALE', m('recalc.bulkStale'));
        });
      },
      async saveStale(stale: string[], p: { done: number; counters: BulkCounters }) {
        // Not: jsonb_set sütunun tamamını yeniden yazar (büyük planda da); en çok `BULK_LIST_LIMIT` kez, yalnız bayat faturada
        await prisma.$transaction(async (tx) => {
          await ctx.fence(tx, p);
          await tx.$executeRaw`UPDATE "Job" SET "checkpoint" = jsonb_set("checkpoint", '{stale}', ${JSON.stringify(stale)}::jsonb)
            WHERE "id" = ${id} AND "companyId" = ${companyId} AND "checkpoint" IS NOT NULL`;
        });
      },
    },
  };
}

/**
 * K4: onaylanan önizlemenin planı (önizleme işinin `checkpoint`'i, `BulkPreviewPlan`). Aranan: bu firmanın aynı özetli,
 * dayanağı (tarife sürümü, ayar özeti) bugünküyle aynı, henüz kullanılmamış (ya da bu işte kullanılmış) başarılı önizleme
 * işi; süzme SQL'de, yalnız biri okunur. Bulunamazsa ama aynı özetli önizleme varsa (dayanak değişti ya da önizleme
 * başka uygulamada kullanıldı) `'PREVIEW_STALE'`. Hiç yoksa (7 günlük saklama, eski önizleme) null: plan yeniden kurulur.
 */
async function loadPreviewPlan(ctx: JobContext, scope: BulkScope, token: string): Promise<{ plan: unknown; previewId?: string }> {
  const { id, companyId } = ctx.job;
  const basis = await bulkPreviewDedupeKey(companyId, scope);
  const rows = await prisma.$queryRaw<{ id: string; checkpoint: unknown }[]>`SELECT "id", "checkpoint" FROM "Job"
    WHERE "companyId" = ${companyId} AND "kind" = 'BULK_RECOMPARE_PREVIEW' AND "status" = 'SUCCEEDED'
      AND "checkpoint"->>'token' = ${token} AND "checkpoint"->>'basis' = ${basis}
      AND COALESCE("checkpoint"->>'appliedBy', ${id}) = ${id}
    ORDER BY "finishedAt" DESC NULLS LAST, "id" DESC LIMIT 1`;
  if (rows[0]) return { plan: rows[0].checkpoint, previewId: rows[0].id };
  const seen = await prisma.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Job"
    WHERE "companyId" = ${companyId} AND "kind" = 'BULK_RECOMPARE_PREVIEW' AND "status" = 'SUCCEEDED' AND "checkpoint"->>'token' = ${token}
    LIMIT 1`;
  return { plan: seen.length ? 'PREVIEW_STALE' : null };
}

const cancelled = (signal: AbortSignal) => signal.reason instanceof JobAbort && signal.reason.cause === 'cancel';

/**
 * Önizleme işi: baştan hesaplar (aşama `bulkCheck`); sonuç `BulkPreview`. Durdurulursa bölüm sonucu yok. K4: planın
 * tamamı işin `checkpoint`'ine yazılır (dışarı verilmez; uygulama onu okur). Dayanak hesap sırasında değiştiyse plan
 * yazılmaz: uygulama planı yeniden kurar ve genel özet tutmaz.
 */
export const bulkPreviewHandler: JobHandler = async (ctx) => {
  const { companyId, input } = ctx.job;
  const scope = bulkScopeOf(input);
  await assertBulkStarter(ctx.job);
  const basis = await bulkPreviewDedupeKey(companyId, scope);
  return previewBulk(companyId, scope, {
    signal: ctx.signal,
    onProgress: progressOf(ctx),
    savePlan: async (p) => {
      if ((await bulkPreviewDedupeKey(companyId, scope)) !== basis) return;
      const plan = JSON.stringify({ v: 1, basis, ...p } satisfies BulkPreviewPlan);
      // Çitli yazım (`saveCheckpoint` yerine): aynı özetli önizlemeleri işaretleyen uygulama bu satıra plan kaydından önce
      // `appliedBy` yazmış olabilir (önceki denemenin planı); özet aynıysa işaret korunur, yoksa önizleme ikinci kez
      // uygulanabilirdi. Çit satırı önce kilitler: işaretleme ya önce işlenir (burada görülür) ya da sonra gelir.
      await prisma.$transaction(async (tx) => {
        await ctx.fence(tx, {});
        await tx.$executeRaw`UPDATE "Job" SET "checkpoint" = ${plan}::jsonb || CASE
            WHEN "checkpoint"->>'token' = ${p.token} AND "checkpoint"->'appliedBy' IS NOT NULL
            THEN jsonb_build_object('appliedBy', "checkpoint"->'appliedBy') ELSE '{}'::jsonb END
          WHERE "id" = ${ctx.job.id} AND "companyId" = ${companyId}`;
      });
    },
  });
};

type ScopeSummary = { invoices: number; lines: number; skipped: { inDispute: number; stale: number }; stopped?: number; failed?: true };

/**
 * Kapsamın denetim kaydı (`tariff.recompare` / `settings.recompare`), iş başına EN ÇOK BİR KEZ: kayıt `jobId` taşır; iş
 * kimliğiyle danışma kilidi altında önceden yazılmış mı bakılır. Böylece bitiş yazımı düşüp iş yeniden alınınca, ya da
 * başarı yolu ile temizlik kancası (durdurma, başarısızlık) arka arkaya gelince kayıt ikilenmez.
 */
async function writeScopeAudit(job: Pick<ClaimedJob, 'id' | 'companyId' | 'createdById' | 'input'>, summary: ScopeSummary): Promise<boolean> {
  const scope = bulkScopeOf(job.input);
  const [action, entity, entityId] =
    scope.kind === 'tariff' ? (['tariff.recompare', 'Tariff', scope.tariffId] as const) : (['settings.recompare', 'Company', job.companyId] as const);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`job-scope-audit:${job.id}`}, 0))`;
    const seen = await tx.auditLog.findFirst({ where: { companyId: job.companyId, action, entityId, data: { path: ['jobId'], equals: job.id } }, select: { id: true } });
    if (seen) return false;
    await tx.auditLog.create({ data: { companyId: job.companyId, userId: job.createdById, action, entity, entityId, data: { ...summary, jobId: job.id } } });
    return true;
  });
}

/**
 * Uygulama işi: sonuç `{ invoices, lines, skipped: { inDispute, stale }, staleInvoices?, stopped }`. Dayanak önizlemeden
 * sonra değiştiyse, önizleme zaten uygulandıysa ya da (önizleme planı yoksa) genel özet tutmuyorsa → `FAILED`
 * `PREVIEW_STALE` (409), hiçbir şey yazılmaz. K4: tek tek değişen fatura yazılmaz, `staleInvoices`'ta listelenir.
 * Durdurma → `CANCELLED`, bölüm sonucu aynı biçimde (`stopped` > 0).
 * Kapsamın denetim kaydı başarıda burada; durdurulan ya da başarısız işte (en az bir fatura yazıldıysa) temizlik kancası
 * (`bulkApplyCleanup`) yazar. İkisi de `writeScopeAudit` ile, iş başına bir kez.
 */
export const bulkApplyHandler: JobHandler = async (ctx) => {
  const { companyId, createdById, input } = ctx.job;
  const scope = bulkScopeOf(input);
  const token = typeof input.token === 'string' ? input.token : '';
  await assertBulkStarter(ctx.job);
  const outcome = await applyBulk(companyId, createdById, scope, token, applyHooks(ctx, scope));
  if (outcome === 'PREVIEW_STALE') throw conflict('PREVIEW_STALE', m('recalc.bulkStale'));
  // kira kaybı ya da kapanış: sonuç bu çalıştırmada yazılmaz, sonraki deneme kaldığı yerden sürer ve kaydı o yazar
  if (ctx.signal.aborted && !cancelled(ctx.signal)) throw ctx.signal.reason;
  // Y57: yuva başka firmaya bırakıldı; iş kuyruğa döner, sonraki çalıştırma kaldığı yerden sürer ve kaydı o yazar
  const { paused, ...r } = outcome;
  if (paused && !ctx.signal.aborted) throw new JobYield(r);
  // durduruldu: kayıt temizlik kancasında, iş satırının sayaçlarından (bitiş yazımı onları son hâline getirir)
  if (r.stopped > 0) throw new JobCancelled(r);
  try {
    await writeScopeAudit(ctx.job, { invoices: r.invoices, lines: r.lines, skipped: r.skipped });
  } catch (err) {
    ctx.log.warn({ err }, 'bulk recompare scope audit write failed');
  }
  return r;
};

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/**
 * Uygulama işinin temizlik kancası (durdurulan, başarısız ve bırakılmış iş; zorla durdurma ve kirası düşmüş işin yeniden
 * sahiplenilip durdurulması dahil). En az bir fatura yazıldıysa kapsamın denetim kaydını iş satırından yazar:
 * `counters` (yazılan fatura ve satır, atlananlar), `stopped` = plan − ilerleme (yazım aşamasındaysa), başarısızsa `failed`.
 * Hiç fatura yazılmadıysa kayıt yok (bugünkü gibi: bayat önizleme, hesapta durdurma).
 */
export async function bulkApplyCleanup(job: ClaimedJob, outcome: 'FAILED' | 'CANCELLED'): Promise<void> {
  const row = await prisma.job.findFirst({
    where: { id: job.id, companyId: job.companyId },
    select: { counters: true, progressDone: true, progressTotal: true, stage: true },
  });
  const k = (row?.counters ?? {}) as Partial<BulkCounters>;
  if (!row || !isCount(k.invoices) || k.invoices < 1) return;
  const stopped = row.stage === 'bulkWrite' && row.progressTotal != null ? Math.max(0, row.progressTotal - row.progressDone) : 0;
  await writeScopeAudit(job, {
    invoices: k.invoices,
    lines: isCount(k.lines) ? k.lines : 0,
    skipped: { inDispute: isCount(k.inDispute) ? k.inDispute : 0, stale: isCount(k.stale) ? k.stale : 0 },
    stopped,
    ...(outcome === 'FAILED' ? { failed: true as const } : {}),
  });
}
