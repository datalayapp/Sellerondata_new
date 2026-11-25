/**
 * İş kuyruğunun API yüzü (Mesaj 7, plan §4.8): iş ekleme (tekillik → `joined`), başlatma (`kickJob`), okuma (`jobView`,
 * `listJobs`), durdurma (`cancelJob`) ve bakımın eski iş temizliği (`cleanupFinishedJobs`).
 *
 * Okuma ve yazma firma bağlamında; firma isteğin oturumundan (`req.auth.orgId`). İzin: uç üç izinden birini ister, işin kendi
 * türünün izni (`JOB_KINDS[kind].permission(input)`) burada denetlenir; yoksa iş yokmuş gibi 404 (varlığı sızmaz).
 * Para alanları yanıtta `app.ts` `preSerialization` kancasıyla fiyat izni olmayana gitmez (`result` içi dahil).
 */
import crypto from 'node:crypto';
import type { Locale } from '@deciship/core';
import type { FastifyRequest } from 'fastify';
import { prisma, withCompany, withMaintenanceScope, type Prisma, type Tx } from '../../db.ts';
import { env } from '../../env.ts';
import { AppError, badRequest, notFound } from '../../errors.ts';
import type { Job } from '../../generated/prisma/client.ts';
import { currentLocale, isMessageKey, m } from '../../i18n/index.ts';
import { can } from '../../lib/access.ts';
import { jobSpec } from './registry.ts';
import { abortLocalRun, runJobCleanup, runJobInline, wakeJobRunners, type JobLog } from './runner.ts';
import {
  JOB_FINISHED,
  type ClaimedJob,
  type JobError,
  type JobKind,
  type JobListQuery,
  type JobRefType,
  type JobStarted,
  type JobStatus,
  type JobView,
} from './types.ts';

/** Biten iş bu kadar sonra silinir (bakım kapsamı). Göçteki `interval '7 days'` ile aynı (test denetler). */
export const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** `GET /jobs` en çok bu kadar iş döner. */
export const JOB_LIST_LIMIT = 20;
const LIST_BATCH = 100;
const LIST_SCAN_MAX = 500;

const ACTIVE: JobStatus[] = ['QUEUED', 'RUNNING'];
const isFinished = (s: JobStatus) => (JOB_FINISHED as readonly JobStatus[]).includes(s);
const asInput = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// ---------- Ekleme ve başlatma ----------

export type EnqueueJob = {
  companyId: string;
  createdById: string | null;
  kind: JobKind;
  dedupeKey: string;
  ref?: { type: JobRefType; id: string | null };
  label?: string | null;
  /** `{ v: 1, locale }` verilmezse eklenir (dil: o anki istek dili). Dışarı verilmez; ekranın gördüğü parça `publicParams`. */
  input: Record<string, unknown>;
  /** Verilirse ekleme bu işlemde yapılır (firma bağlamı işlemin). `kickJob`'u işlem commit edildikten SONRA çağırın. */
  tx?: Tx;
};

/**
 * İş ekler. Aynı firmada aynı tür ve tekillik anahtarıyla bekleyen ya da süren iş varsa yenisi açılmaz, onun kimliği döner
 * (`joined: true`). `ON CONFLICT` hedefi kısmi dizin `Job_active_key` ile aynı (yalnız QUEUED/RUNNING arasında tekil).
 */
export async function enqueueJob(o: EnqueueJob): Promise<{ jobId: string; joined: boolean }> {
  const input = { v: 1, locale: currentLocale(), ...o.input };
  const inputJson = JSON.stringify(input);
  const run = async (db: Pick<Tx, '$queryRaw'>) => {
    // Çakışan iş tam o anda biterse ne ekleme ne okuma satır bulur: yeniden denenir.
    for (let i = 0; i < 3; i++) {
      const rows = await db.$queryRaw<{ id: string }[]>`
        INSERT INTO "Job" ("id", "companyId", "kind", "dedupeKey", "refType", "refId", "label", "input", "maxAttempts", "createdById", "updatedAt")
        VALUES (${crypto.randomUUID()}, ${o.companyId}, ${o.kind}::"JobKind", ${o.dedupeKey}, ${o.ref?.type ?? null}, ${o.ref?.id ?? null},
          ${o.label ?? null}, ${inputJson}::jsonb, ${env.jobMaxAttempts}::int, ${o.createdById}, (now() AT TIME ZONE 'UTC'))
        ON CONFLICT ("companyId", "kind", "dedupeKey") WHERE "status" IN ('QUEUED', 'RUNNING') DO NOTHING
        RETURNING "id"`;
      if (rows[0]) return { jobId: rows[0].id, joined: false };
      const active = await db.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Job"
        WHERE "companyId" = ${o.companyId} AND "kind"::text = ${o.kind} AND "dedupeKey" = ${o.dedupeKey} AND "status" IN ('QUEUED', 'RUNNING')
        LIMIT 1`;
      if (active[0]) return { jobId: active[0].id, joined: true };
    }
    throw new Error('enqueueJob: could not resolve dedupe conflict');
  };
  return o.tx ? run(o.tx) : withCompany(o.companyId, () => run(prisma));
}

/**
 * İşi başlatır. `inline`: işi bu çağrıda sonuna kadar çalıştırır (başka yerde sürüyorsa hemen döner). `on`: bu süreçteki
 * döngüyü uyandırır. `off`: hiçbir şey (başka kopya alır). Hata atmaz; yalnız sahiplenme sorgusunun bağlantı hatası çıkar.
 */
export async function kickJob(jobId: string, log?: JobLog): Promise<void> {
  const mode = env.jobRunner;
  if (mode === 'inline') await runJobInline(jobId, log);
  else if (mode === 'on') wakeJobRunners();
}

/** `?async=1` (ya da `true`): istemci arka plan yolunu istedi. */
export function asyncRequested(req: FastifyRequest): boolean {
  const q = (req.query ?? {}) as Record<string, unknown>;
  return q.async === '1' || q.async === 'true';
}

/**
 * Y83: uzun işler (PDF fatura okuma, tarife PDF'inin yapay zekâ taraması ve tablo okuması, toplu yeniden hesap) yalnız
 * arka planda yürür; eski eşzamanlı yol kaldırıldı. `?async=1` yoksa 400 `ASYNC_REQUIRED`: hiçbir şey yapılmaz (dosya
 * saklanmaz, yapay zekâ çağrılmaz, yazım yok). İstemcinin izleyemeyeceği bir iş sessizce başlatılmasın diye iş açılmaz.
 */
export function requireAsync(req: FastifyRequest): void {
  if (!asyncRequested(req)) throw badRequest('ASYNC_REQUIRED', m('job.asyncRequired'));
}

/** Bekleyen ya da süren işin kimliği (yoksa null). */
export async function findActiveJob(companyId: string, kind: JobKind, dedupeKey: string): Promise<string | null> {
  const row = await withCompany(companyId, () =>
    prisma.job.findFirst({ where: { companyId, kind, dedupeKey, status: { in: ACTIVE } }, select: { id: true } }),
  );
  return row?.id ?? null;
}

/**
 * Uçların kısayolu: isteğin firması, üyesi ve diliyle ekler, başlatır, `{ job, joined }` döner (202 gövdesi). Türün izni
 * ve kota gibi ön denetimler çağırandadır.
 */
export async function launchJob(
  req: FastifyRequest,
  o: Omit<EnqueueJob, 'companyId' | 'createdById' | 'tx'>,
): Promise<JobStarted> {
  const { jobId, joined } = await enqueueJob({ ...o, companyId: req.auth.orgId, createdById: req.auth.membershipId, input: { locale: req.locale, ...o.input } });
  await kickJob(jobId, req.log);
  return { job: await jobView(req, jobId), joined };
}

// ---------- Okuma ----------

/** Firmanın işi (satırın tamamı) ya da null. İzin denetimi YOK: çağıran denetler. */
export async function findJob(companyId: string, jobId: string): Promise<Job | null> {
  return withCompany(companyId, () => prisma.job.findFirst({ where: { id: jobId, companyId } }));
}

/**
 * `findJob` gibi, `checkpoint` olmadan: toplu işlerin planı (büyük firmada megabaytlar) görünüm, başlatma ve durdurma
 * sonrası okumada taşınmaz (K4).
 */
export async function findJobLean(companyId: string, jobId: string): Promise<Omit<Job, 'checkpoint'> | null> {
  return withCompany(companyId, () => prisma.job.findFirst({ where: { id: jobId, companyId }, omit: { checkpoint: true } }));
}

type ViewRow = Pick<
  Job,
  | 'id'
  | 'kind'
  | 'status'
  | 'progressDone'
  | 'progressTotal'
  | 'stage'
  | 'label'
  | 'refType'
  | 'refId'
  | 'input'
  | 'attempts'
  | 'cancelRequestedAt'
  | 'createdAt'
  | 'startedAt'
  | 'finishedAt'
  | 'error'
> & { result?: Job['result']; createdById?: Job['createdById']; counters?: Job['counters'] };

/** `Job.counters` → yalnız sayısal alanlar (bozuk kayıt dışarı gitmez); boşsa null. */
function viewCounters(raw: unknown): Record<string, number> | null {
  const o = asInput(raw);
  const out = Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))) as Record<string, number>;
  return Object.keys(out).length ? out : null;
}

const LIST_SELECT = {
  id: true,
  kind: true,
  status: true,
  progressDone: true,
  progressTotal: true,
  stage: true,
  counters: true,
  label: true,
  refType: true,
  refId: true,
  input: true,
  attempts: true,
  cancelRequestedAt: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  error: true,
  createdById: true,
} satisfies Prisma.JobSelect;

/** İletisi anahtarlı hata isteğin dilinde üretilir (SQL'in yazdığı JOB_ABANDONED gibi). */
function viewError(raw: unknown, locale: Locale): JobView['error'] {
  const e = asInput(raw) as Partial<JobError>;
  const message = e.messageKey && isMessageKey(e.messageKey) ? m(e.messageKey, undefined, locale) : String(e.message ?? '');
  return {
    statusCode: Number(e.statusCode ?? 500),
    code: String(e.code ?? 'INTERNAL'),
    message,
    ...(e.details !== undefined ? { details: e.details } : {}),
  };
}

/**
 * Satırı ekran biçimine çevirir. `result` yalnız SUCCEEDED ve bölüm sonuçlu CANCELLED işte, satır onu taşıyorsa (listede hiç).
 * `error` yalnız FAILED. İzin denetimi yapmaz. `viewer` verilirse `cancellable` isteği yapana göre (`mayCancelJob`); verilmezse
 * yalnız türe ve duruma göre.
 */
export function toJobView(row: ViewRow, locale: Locale, now = Date.now(), viewer?: { canCancel: boolean }): JobView {
  const spec = jobSpec(row.kind);
  const status = row.status;
  const started = (row.startedAt ?? row.createdAt).getTime();
  const end = row.finishedAt ? row.finishedAt.getTime() : now;
  const params = spec.publicParams?.(asInput(row.input));
  const view: JobView = {
    id: row.id,
    kind: row.kind,
    status,
    progress: { done: row.progressDone, total: row.progressTotal, stage: row.stage },
    ...('counters' in row ? { counters: viewCounters(row.counters) } : {}),
    label: row.label,
    ref: row.refType ? { type: row.refType as JobRefType, id: row.refId } : null,
    ...(params ? { params } : {}),
    attempt: row.attempts,
    cancellable: spec.cancellable && !isFinished(status) && (viewer?.canCancel ?? true),
    cancelRequested: row.cancelRequestedAt != null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    elapsedMs: Math.max(0, end - started),
  };
  if ('result' in row && row.result != null && (status === 'SUCCEEDED' || status === 'CANCELLED')) view.result = row.result;
  if (status === 'FAILED' && row.error != null) view.error = viewError(row.error, locale);
  return view;
}

const permitted = (req: FastifyRequest, row: Pick<Job, 'kind' | 'input'>) => can(req, jobSpec(row.kind).permission(asInput(row.input)));

/**
 * İşi durdurabilir mi: yalnız başlatan üye ya da ayar yöneticisi (`deciship.settings.manage`). Görme izni yetmez: başkasının
 * PDF okumasını durdurmak onun önizleme dosyasını da sildirirdi (`DELETE /invoices/preview/:fileId` yalnız yükleyene açık).
 */
export function mayCancelJob(req: FastifyRequest, row: { createdById?: string | null }): boolean {
  return (row.createdById != null && row.createdById === req.auth.membershipId) || can(req, 'deciship.settings.manage');
}

const viewFor = (req: FastifyRequest, row: ViewRow, now = Date.now()) => toJobView(row, req.locale, now, { canCancel: mayCancelJob(req, row) });

/** Tek iş. 404 `job.notFound`: yok, başka firmanın ya da türün izni yok (üçü ayırt edilmez). */
export async function jobView(req: FastifyRequest, jobId: string): Promise<JobView> {
  const row = await findJobLean(req.auth.orgId, jobId);
  if (!row || !permitted(req, row)) throw notFound(m('job.notFound'));
  return viewFor(req, row);
}

/** İş listesi: en yeniden eskiye, en çok 20, yalnız izinli türler, `result` yok. */
export async function listJobs(req: FastifyRequest, q: JobListQuery): Promise<{ items: JobView[] }> {
  const companyId = req.auth.orgId;
  const where: Prisma.JobWhereInput = {
    companyId,
    ...(q.active ? { status: { in: ACTIVE } } : {}),
    ...(q.kind ? { kind: q.kind } : {}),
    ...(q.refType ? { refType: q.refType } : {}),
    ...(q.refId ? { refId: q.refId } : {}),
    ...(q.mine ? { createdById: req.auth.membershipId } : {}),
  };
  const items: JobView[] = [];
  const now = Date.now();
  // İzin türe ve girdiye bağlı (toplu hesapta kapsam): izinsiz satırlar atlanır, sayfa dolana kadar okunur.
  for (let skip = 0; items.length < JOB_LIST_LIMIT && skip < LIST_SCAN_MAX; skip += LIST_BATCH) {
    const rows = await withCompany(companyId, () =>
      prisma.job.findMany({ where, select: LIST_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take: LIST_BATCH }),
    );
    for (const row of rows) {
      if (items.length >= JOB_LIST_LIMIT) break;
      if (permitted(req, row)) items.push(viewFor(req, row, now));
    }
    if (rows.length < LIST_BATCH) break;
  }
  return { items };
}

// ---------- Durdurma ----------

// Durdurmanın temizlik kancaları `checkpoint` okumaz (toplu uygulamanınki sayaçlardan): plan satırla taşınmaz (K4).
const claimedOf = (row: Omit<Job, 'checkpoint'>): ClaimedJob => ({
  id: row.id,
  companyId: row.companyId,
  kind: row.kind,
  input: asInput(row.input),
  checkpoint: null,
  attempts: row.attempts,
  createdById: row.createdById,
  createdAt: row.createdAt,
  cancelRequestedAt: row.cancelRequestedAt,
});

/**
 * Durdurma. Kuyruktaki iş hemen CANCELLED (ardından türün temizlik kancası). Süren işe `cancelRequestedAt` yazılır; aynı
 * süreçteyse sinyal hemen, başka kopyadaysa en geç bir kalp atışında kesilir; iş adım arasında durur (uymazsa
 * `JOB_CANCEL_GRACE_MS` sonra CANCELLED yazılır). 404: yok, türün izni yok ya da durdurma yetkisi yok (`mayCancelJob`; işi
 * görebilen başka üye için de 404); 409 `JOB_FINISHED`: zaten bitti; 409 `JOB_NOT_CANCELLABLE`: tür durdurulamaz.
 */
export async function cancelJob(req: FastifyRequest, jobId: string): Promise<JobView> {
  const companyId = req.auth.orgId;
  const row = await findJobLean(companyId, jobId);
  if (!row || !permitted(req, row) || !mayCancelJob(req, row)) throw notFound(m('job.notFound'));
  if (isFinished(row.status)) throw new AppError(409, 'JOB_FINISHED', m('job.finished'));
  if (!jobSpec(row.kind).cancellable) throw new AppError(409, 'JOB_NOT_CANCELLABLE', m('job.notCancellable'));
  // KALANLAR 6.18: geri alınamaz yazımı yapmış iş (içe aktarmada fatura yazıldı) durdurulmaz; iş sürer, sonucu gelir
  const committed = jobSpec(row.kind).committed;
  if (committed && committed((await findJob(companyId, jobId))?.checkpoint)) throw new AppError(409, 'JOB_NOT_CANCELLABLE', m('job.notCancellable'));

  const at = new Date();
  const queued = await withCompany(companyId, () =>
    prisma.job.updateMany({
      where: { id: jobId, companyId, status: 'QUEUED' },
      data: { status: 'CANCELLED', cancelRequestedAt: at, finishedAt: at, lockedBy: null, lockedUntil: null },
    }),
  );
  let hit = queued.count === 1;
  if (hit) await runJobCleanup(claimedOf(row), 'CANCELLED', req.log);
  else {
    const running = await withCompany(companyId, () =>
      prisma.job.updateMany({ where: { id: jobId, companyId, status: 'RUNNING', cancelRequestedAt: null }, data: { cancelRequestedAt: at } }),
    );
    hit = running.count === 1;
    abortLocalRun(jobId);
  }

  const after = await findJobLean(companyId, jobId);
  if (!after) throw notFound(m('job.notFound'));
  // Arada bitti ve durdurma hiçbir satıra yazılmadı (zaten istenmiş durdurma da sayılır: RUNNING + cancelRequestedAt)
  if (!hit && isFinished(after.status) && after.status !== 'CANCELLED') throw new AppError(409, 'JOB_FINISHED', m('job.finished'));
  return viewFor(req, after);
}

// ---------- Bakım ----------

/**
 * Bitmiş ve 7 günden eski işleri siler (bakım kapsamı; maintenance.ts çağırır). Silinen sayısını döner. Kapalı firmanınkiler
 * kalır (saklama süresinde firmanın hiçbir kaydı değişmez; bakım kapsamı firma satırını okuyabilir).
 */
export async function cleanupFinishedJobs(now = Date.now()): Promise<number> {
  const r = await withMaintenanceScope(() =>
    prisma.job.deleteMany({ where: { finishedAt: { lt: new Date(now - JOB_RETENTION_MS) }, company: { closedAt: null } } }),
  );
  return r.count;
}
