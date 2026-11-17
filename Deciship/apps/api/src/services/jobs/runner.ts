/**
 * İş kuyruğunun çalıştırıcısı (Mesaj 7, plan §4.4–§4.6). Süreç içinde, DeciShip API'nin yanında çalışır.
 *
 * - Sahiplenme, kalp atışı, kira bırakma, geçici hatada kuyruğa geri koyma ve deneme hakkı biten işlerin ADAY listesi
 *   `withJobScope` içinde (iş kapsamı satırı yalnız QUEUED ya da RUNNING bırakabilir; migration 20261114120000).
 * - İşin kendisi, ilerleme, kaldığı yer ve bitiş yazımı (JOB_ABANDONED dahil) işin kendi firma bağlamında:
 *   `withCompany(row.companyId, …)`; firma her zaman satırın sütunundan alınır, `input`'tan değil.
 * - Sahiplik: her sahiplenme yeni bir `lockedBy` belirteci alır (süreç kimliği + rastgele). Her yazım
 *   `WHERE id AND "lockedBy" = belirteç AND status = 'RUNNING'` taşır; 0 satır = kira kaybı, sonuç atılır. Aynı süreç kendi
 *   kirası dolmuş işini yeniden sahiplense bile eski çalıştırma yeni belirteci taşımadığı için yazamaz.
 * - `fence(tx)` ayrıca kiranın dolmadığını ister: devralma (`lockedUntil < now`) ile kilitli satırdaki çit yazımı birbirini dışlar.
 *
 * Kipler (`JOB_RUNNER`): `on` → `startJobRunner` döngüsü (main.ts); `off` → bu süreç iş almaz; `inline` → `runJobInline`,
 * başlatan istek işi sonuna kadar çalıştırır (testler). Üç kip de aynı `launch` yolundan geçer.
 */
import { AsyncResource } from 'node:async_hooks';
import crypto from 'node:crypto';
import os from 'node:os';
import { normalizeLocale } from '@deciship/core';
import { Prisma, prisma, withCompany, withJobScope, type Tx } from '../../db.ts';
import { env } from '../../env.ts';
import { AppError, isDbConnectionError } from '../../errors.ts';
import { m, withLocale } from '../../i18n/index.ts';
import { runInJobScope } from './jobScope.ts';
import { jobMaxRunMs, jobSpec, laneKinds } from './registry.ts';
import { JobCancelled, JobYield, type ClaimedJob, type JobContext, type JobError, type JobKind, type JobLane, type JobStatus } from './types.ts';

export type JobLog = { info(o: unknown, msg: string): void; warn(o: unknown, msg: string): void; error?(o: unknown, msg: string): void };
export type JobRunner = { wake(): void; stop(): Promise<void> };
export type JobRunnerOptions = {
  pollMs: number;
  leaseMs: number;
  slots: Record<JobLane, number>;
  /** kapanışta süren işlere tanınan süre (varsayılan `JOB_SHUTDOWN_GRACE_MS`) */
  graceMs: number;
  /** durdurma isteğinden sonra sinyale uymayan işleyiciye tanınan süre (varsayılan `JOB_CANCEL_GRACE_MS`) */
  cancelGraceMs: number;
  /** Y57: bir çalıştırmanın payı; dolunca başka firma bekliyorsa yuva bırakılır (varsayılan `JOB_FAIR_SLICE_MS`) */
  fairSliceMs: number;
  /** Y57: bekleyen başka firma sorgusunun en kısa aralığı (varsayılan `JOB_FAIR_CHECK_MS`) */
  fairCheckMs: number;
};

const LANES: readonly JobLane[] = ['ai', 'recalc'];
/** Süreç kimliği: belirtecin ön eki (günlükte hangi kopyanın aldığı görünsün). */
const PROCESS_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
/** Geçici hatada bekleme: 10 sn × deneme (plan §4.5). */
export const JOB_RETRY_STEP_MS = 10_000;
/** İlerleme yazımı en çok bu aralıkla (aşama değişimi beklemez). */
const PROGRESS_MIN_INTERVAL_MS = 1_000;
const ABANDON_BATCH = 50;
/** Kapanışta kira bırakıldıktan sonra bitiş yazımı süren çalıştırmaya tanınan ek süre. */
const FINISH_SETTLE_MS = 1_000;
/**
 * Durdurma isteğinden sonra sinyale uymayan işleyiciye tanınan süre; dolunca iş CANCELLED yazılır, kira bırakılır. Süren
 * yapay zekâ çağrısı durdurmayla sağlayıcıda kesilir (KALANLAR 6.5, `jobCancelSignal`); bu süre onu beklemez.
 */
export const JOB_CANCEL_GRACE_MS = 30_000;
/** Kapanışta deneme hakkı iş başına en çok bu kadar kez geri sayılır (ardışık kapanışlar sonsuz döngü açmasın). */
export const MAX_SHUTDOWN_REFUNDS = 2;
/** Bırakılan (dönmeyen) işleyicinin temizlik kancası en çok bu kadar bekler. */
const DETACHED_CLEANUP_WAIT_MS = 60_000;
/**
 * Y57 (adil paylaşım): aynı gruptan başka firmanın bekleyen işi varsa bir çalıştırma en az bu kadar sürer, sonra kaldığı
 * yerden sürebilen iş (toplu uygulama) yuvasını bırakıp kuyruğun sonuna döner. Bir firmanın saatlerce süren toplu hesabı
 * ötekilerin hesabını o kadar bekletmesin (`JOB_SLOTS_RECALC` varsayılan 1).
 */
export const JOB_FAIR_SLICE_MS = 60_000;
/** Y57: "başka firma bekliyor mu" sorgusu bir çalıştırmada en çok bu aralıkla (arada önceki cevap kullanılır). */
export const JOB_FAIR_CHECK_MS = 5_000;

const NOW = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

/** Kira bu çalıştırmada değil (kalp atışı ya da çit 0 satır): işleyici durur, sonuç yazılmaz. */
export class JobLeaseLost extends Error {
  constructor() {
    super('job lease lost');
  }
}

/** Sinyalin kesilme nedeni (`signal.reason`). */
export class JobAbort extends Error {
  constructor(public cause: 'cancel' | 'lost' | 'shutdown' | 'timeout') {
    super(`job aborted: ${cause}`);
  }
}

/**
 * KALANLAR 6.5: işin sinyalinden yalnız kullanıcının durdurmasıyla (`cancel`) kesilen sinyal; süren yapay zekâ çağrısına
 * verilir (`aiJobContext`). Kapanış, kira kaybı ve süre aşımı çağrıyı kesmez: iş yeniden denenir ve süren çağrının sonucu
 * önbelleğe girip yeniden denemede ücretsiz alınır (kesmek ödenmiş sonucu atardı).
 */
export function jobCancelSignal(signal: AbortSignal): AbortSignal {
  const isCancel = () => signal.reason instanceof JobAbort && signal.reason.cause === 'cancel';
  if (signal.aborted) return isCancel() ? AbortSignal.abort(signal.reason) : new AbortController().signal;
  const c = new AbortController();
  signal.addEventListener(
    'abort',
    () => {
      if (isCancel()) c.abort(signal.reason);
    },
    { once: true },
  );
  return c.signal;
}

const quietLog: JobLog = {
  info: () => undefined,
  warn: (o, msg) => {
    if (process.env.NODE_ENV !== 'test') console.warn(msg, o);
  },
  error: (o, msg) => {
    if (process.env.NODE_ENV !== 'test') console.error(msg, o);
  },
};

// ---------- Sahiplenme ----------

type ClaimRow = ClaimedJob & { maxAttempts: number };

const asInput = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function toClaimed(r: ClaimRow): ClaimRow {
  return {
    id: r.id,
    companyId: r.companyId,
    kind: r.kind,
    input: asInput(r.input),
    checkpoint: r.checkpoint ?? null,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.maxAttempts),
    createdById: r.createdById ?? null,
    createdAt: new Date(r.createdAt),
    cancelRequestedAt: r.cancelRequestedAt ? new Date(r.cancelRequestedAt) : null,
  };
}

const RETURNING = Prisma.sql`t."id", t."companyId", t."kind"::text AS "kind", t."input", t."checkpoint", t."attempts", t."maxAttempts",
  t."createdById", t."createdAt", t."cancelRequestedAt"`;

const claimSet = (token: string, leaseMs: number) => Prisma.sql`"status" = 'RUNNING', "lockedBy" = ${token},
  "lockedUntil" = ${NOW} + (${leaseMs}::int * interval '1 millisecond'), "heartbeatAt" = ${NOW}, "attempts" = t."attempts" + 1,
  "startedAt" = COALESCE(t."startedAt", ${NOW}), "updatedAt" = ${NOW}`;

/**
 * Kapalı firmanın işi alınmaz: QUEUED kalır, deneme hakkı harcanmaz, firma geri açılınca sırasıyla çalışır.
 * Kirası dolmuş RUNNING işi de devralınmaz. İş kapsamı firma satırını yalnız okur (`jobs_company_read`, migration
 * 20261125090000). İlke yoksa satır görünmez ve hiçbir iş alınmaz: açılış denetimi (`lib/schemaCheck.ts`) ilkeyi arar.
 */
const OPEN_COMPANY = Prisma.sql`EXISTS (SELECT 1 FROM "Company" c WHERE c."id" = j."companyId" AND c."closedAt" IS NULL)`;

/**
 * Grubun sıradaki işini sahiplenir (plan §4.4 sorgusu, tek ifade, `SKIP LOCKED`). Firma başına grup başına 1: o firmanın
 * aynı gruptan kirası geçerli bir işi varsa diğerleri bekler. Kirası dolmuş RUNNING iş devralınır (deneme +1).
 */
async function claimNext(kinds: JobKind[], token: string, leaseMs: number): Promise<ClaimRow | null> {
  if (!kinds.length) return null;
  const list = Prisma.join(kinds);
  const rows = await withJobScope(
    () => prisma.$queryRaw<ClaimRow[]>`
      WITH next AS (
        SELECT j."id" FROM "Job" j
        WHERE j."kind"::text IN (${list})
          AND j."attempts" < j."maxAttempts"
          AND ((j."status" = 'QUEUED' AND j."runAfter" <= ${NOW})
            OR (j."status" = 'RUNNING' AND j."lockedUntil" < ${NOW}))
          AND ${OPEN_COMPANY}
          AND NOT EXISTS (SELECT 1 FROM "Job" r
            WHERE r."companyId" = j."companyId" AND r."kind"::text IN (${list}) AND r."id" <> j."id"
              AND r."status" = 'RUNNING' AND r."lockedUntil" >= ${NOW})
        ORDER BY j."runAfter", j."createdAt", j."id"
        LIMIT 1
        FOR UPDATE OF j SKIP LOCKED)
      UPDATE "Job" t SET ${claimSet(token, leaseMs)}
      FROM next WHERE t."id" = next."id"
      RETURNING ${RETURNING}`,
  );
  return rows[0] ? toClaimed(rows[0]) : null;
}

/**
 * Y57: aynı gruptan BAŞKA bir firmanın şimdi sahiplenilebilir işi var mı (`claimNext` ile aynı koşul: deneme hakkı var,
 * zamanı gelmiş QUEUED ya da kirası dolmuş RUNNING, o firmanın grubunda kirası geçerli iş yok). İş kapsamında okunur.
 */
async function otherCompanyWaiting(kinds: JobKind[], companyId: string): Promise<boolean> {
  if (!kinds.length) return false;
  const list = Prisma.join(kinds);
  const rows = await withJobScope(
    () => prisma.$queryRaw<{ one: number }[]>`
      SELECT 1 AS "one" FROM "Job" j
      WHERE j."kind"::text IN (${list}) AND j."companyId" <> ${companyId}
        AND j."attempts" < j."maxAttempts"
        AND ((j."status" = 'QUEUED' AND j."runAfter" <= ${NOW})
          OR (j."status" = 'RUNNING' AND j."lockedUntil" < ${NOW}))
        AND ${OPEN_COMPANY}
        AND NOT EXISTS (SELECT 1 FROM "Job" r
          WHERE r."companyId" = j."companyId" AND r."kind"::text IN (${list}) AND r."id" <> j."id"
            AND r."status" = 'RUNNING' AND r."lockedUntil" >= ${NOW})
      LIMIT 1`,
  );
  return rows.length > 0;
}

/**
 * Satır içi kip: o işi kimliğiyle sahiplenir. `runAfter` beklenmez ("şimdi çalıştır" çağrısı) ve firma başına grup sınırı
 * uygulanmaz (döngü yok; bekleyen iş hiç çalışmazdı). Kirası geçerli RUNNING iş ve bitmiş iş alınmaz.
 */
async function claimById(jobId: string, token: string, leaseMs: number): Promise<ClaimRow | null> {
  const rows = await withJobScope(
    () => prisma.$queryRaw<ClaimRow[]>`
      WITH next AS (
        SELECT j."id" FROM "Job" j
        WHERE j."id" = ${jobId}
          AND j."attempts" < j."maxAttempts"
          AND (j."status" = 'QUEUED' OR (j."status" = 'RUNNING' AND j."lockedUntil" < ${NOW}))
          AND ${OPEN_COMPANY}
        FOR UPDATE OF j SKIP LOCKED)
      UPDATE "Job" t SET ${claimSet(token, leaseMs)}
      FROM next WHERE t."id" = next."id"
      RETURNING ${RETURNING}`,
  );
  return rows[0] ? toClaimed(rows[0]) : null;
}

// ---------- Hata sınıflandırması ----------

/**
 * Geçici hata: veritabanı bağlantısı, dosya havuzu dolu, yapay zekâ firma yuvası dolu (429). `jobRetry: true` işaretli hata da:
 * sağlayıcının ücretsiz geçici hatası (`AiTransientError`, `services/ai.ts`: aşırı yük, ulaşılamadı, bağlantı zaman aşımı,
 * sayaç sigortası; 07-B2).
 */
export function isTransientJobError(err: unknown): boolean {
  if (isDbConnectionError(err)) return true;
  if ((err as { jobRetry?: unknown } | null)?.jobRetry === true) return true;
  if (err instanceof AppError) return err.code === 'FILE_BUSY' || (err.statusCode === 429 && err.code === 'TOO_MANY_REQUESTS');
  return false;
}

/** Sağlayıcının geçici hatası mı (`AiTransientError`; çalıştırıcı `ai.ts`'i içe aktarmaz, işarete bakar). */
const isAiTransient = (err: unknown): err is AppError => err instanceof AppError && (err as { aiTransient?: unknown }).aiTransient === true;

/**
 * 07-B2: sağlayıcının geçici hatasında bekleme denemeye göre artar (kısa kesinti işi düşürmesin, sağlayıcıya yığılma olmasın):
 * 1. denemeden sonra 30 sn, sonra 2 dk, 5 dk, 10 dk. Sağlayıcı daha uzun süre söylediyse (`retry-after`) o, en çok
 * `AI_RETRY_AFTER_MAX_MS`. Basamak ±%20 rastgele kaydırılır (`AI_RETRY_JITTER`): kesintide düşen işler sağlayıcı açılınca
 * hep birden dönmesin. Deneme hakkı (`JOB_MAX_ATTEMPTS`, varsayılan 5) bitince iş son hatanın kendisiyle `FAILED` olur.
 */
export const AI_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 300_000, 600_000];
export const AI_RETRY_AFTER_MAX_MS = 15 * 60_000;
export const AI_RETRY_JITTER = 0.2;

/** `random`: [0, 1) (testte verilir). */
export function retryDelayMs(err: unknown, attempts: number, random: () => number = Math.random): number {
  const after = Number((err as { retryAfter?: unknown } | null)?.retryAfter);
  const hinted = Number.isFinite(after) && after > 0 ? after * 1000 : 0;
  if (isAiTransient(err)) {
    const step = AI_RETRY_DELAYS_MS[Math.min(Math.max(1, attempts), AI_RETRY_DELAYS_MS.length) - 1]!;
    const r = Math.min(1, Math.max(0, random()));
    const jittered = Math.round(step * (1 - AI_RETRY_JITTER + 2 * AI_RETRY_JITTER * r));
    return Math.max(jittered, Math.min(hinted, AI_RETRY_AFTER_MAX_MS));
  }
  return Math.max(JOB_RETRY_STEP_MS * Math.max(1, attempts), hinted);
}

const errorOf = (err: AppError): JobError => ({
  statusCode: err.statusCode,
  code: err.code,
  message: err.message,
  ...(err.details !== undefined ? { details: err.details } : {}),
});
const internalError = (): JobError => ({ statusCode: 500, code: 'INTERNAL', message: m('job.internal'), messageKey: 'job.internal' });
const abandonedError = (): JobError => ({ statusCode: 500, code: 'JOB_ABANDONED', message: m('job.abandoned'), messageKey: 'job.abandoned' });

/** Prisma'ya JSON: tarih metne, `undefined` düşer; boşsa veritabanı NULL. */
function toJson(v: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (v === undefined || v === null) return Prisma.DbNull;
  const plain = JSON.parse(JSON.stringify(v)) as unknown;
  return plain === null ? Prisma.DbNull : (plain as Prisma.InputJsonValue);
}

// ---------- Temizlik kancası ----------

/** Türün temizlik kancası, firma bağlamında; hata günlüğe yazılır, akışı bozmaz. */
export async function runJobCleanup(job: ClaimedJob, outcome: 'FAILED' | 'CANCELLED', log: JobLog = quietLog): Promise<void> {
  const cleanup = jobSpec(job.kind).cleanup;
  if (!cleanup) return;
  try {
    await withCompany(job.companyId, () => withLocale(normalizeLocale(job.input.locale as string | undefined), () => cleanup(job, outcome)));
  } catch (err) {
    log.warn({ err, jobId: job.id, kind: job.kind }, 'job cleanup failed');
  }
}

// ---------- Tek çalıştırma ----------

type ActiveRun = {
  job: ClaimedJob;
  token: string;
  /**
   * Çalıştırma bitince çözülür (asla reddedilmez): işleyici dönüp bitiş yazıldığında ya da işleyici bırakıldığında (kapanış,
   * süre aşımı, zorla durdurma, kira kaybı). Bırakılan işleyici arkada sürebilir; yuvayı tutmaz, sonucu yazılamaz.
   */
  done: Promise<void>;
  abort(cause: JobAbort['cause']): void;
  /** kapanış: kirayı bırakır (QUEUED; deneme iş başına en çok `MAX_SHUTDOWN_REFUNDS` kez geri sayılır) */
  release(): Promise<void>;
};

/** `fair`: Y57 adil paylaşım (döngü); satır içi kipte yok (`shouldYield` hep false). */
type LaunchOptions = { leaseMs: number; cancelGraceMs: number; fair?: { sliceMs: number; checkMs: number } };

/** Bu süreçteki bütün çalıştırmalar (döngü ve satır içi): aynı süreçteki durdurma isteği sinyali hemen keser. */
const localRuns = new Map<string, ActiveRun>();

/** Aynı süreçte çalışan işin sinyalini keser (durdurma isteği). Başka kopyadaki iş kalp atışında görür. */
export function abortLocalRun(jobId: string): void {
  localRuns.get(jobId)?.abort('cancel');
}

/**
 * Kapanışta kaç kez bırakıldı (Y89): `releases` sütunu. Geçiş: önceki sürüm sayacı yalnız `error` içinde tutuyordu
 * (`JOB_RELEASED`, `details.releases`; başka hata yazılınca sıfırlanır). Kademeli yayında iki sürüm aynı anda çalışabilir:
 * okuma ikisinin büyüğü, yazım (aşağıda `release`) ikisine birden; eski sürüm de yeni sürümün yazdığı sayacı görür.
 * Eski sürüm kalmayınca `error` içindeki kopya bırakılabilir.
 */
const LEGACY_RELEASES = Prisma.sql`(CASE WHEN "error"->>'code' = 'JOB_RELEASED' THEN COALESCE(("error"->'details'->>'releases')::int, 0) ELSE 0 END)`;
const RELEASES = Prisma.sql`GREATEST("releases", ${LEGACY_RELEASES})`;

function launch(row: ClaimRow, token: string, o: LaunchOptions, log: JobLog): ActiveRun {
  const { maxAttempts, ...job } = row;
  const spec = jobSpec(job.kind);
  const maxRunMs = jobMaxRunMs(job.kind);
  // KALANLAR 6.18: iş geri alınamaz yazımı yaptıysa (içe aktarmada fatura) durdurma onu durduramaz: işleyici sürer, sonuç yazılır
  let committed = spec.committed?.(job.checkpoint) === true;
  const locale = normalizeLocale(job.input.locale as string | undefined);
  const controller = new AbortController();
  // running: işleyici sürüyor; finishing: işleyici döndü, bitiş yazılıyor; detached: işleyici bırakıldı; lost: kira kaybı
  let state: 'running' | 'finishing' | 'detached' | 'lost' = 'running';
  let cause: JobAbort['cause'] | null = null;
  const jobLog = {
    info: (o: unknown, msg: string) => log.info({ jobId: job.id, kind: job.kind, detail: o }, msg),
    warn: (o: unknown, msg: string) => log.warn({ jobId: job.id, kind: job.kind, detail: o }, msg),
  };

  // Zamanlayıcılar çalıştırmanın kurulduğu bağlamda açılır (döngüde kök bağlam); durdurma isteğinin bağlamını devralmaz.
  const timers: NodeJS.Timeout[] = [];
  const later = AsyncResource.bind((fn: () => void, ms: number, repeat = false) => {
    const t = repeat ? setInterval(fn, ms) : setTimeout(fn, ms);
    t.unref();
    timers.push(t);
  });
  const stopTimers = () => {
    for (const t of timers.splice(0)) clearInterval(t);
  };

  let detachedWrite: Promise<void> = Promise.resolve();
  let onDetach!: () => void;
  const detachedSignal = new Promise<void>((resolve) => (onDetach = resolve));
  /** İşleyici dönene kadar (bırakılan işin temizliği işleyicinin son yazımıyla yarışmasın diye ona bağlanır). */
  let handlerSettled: Promise<void> = Promise.resolve();

  const abort = (c: JobAbort['cause']) => {
    if (controller.signal.aborted) return;
    cause = c;
    controller.abort(new JobAbort(c));
    // Sinyale uymayan işleyici: süre dolunca iş CANCELLED yazılır ve kira bırakılır (yalnız iş satırına yazamaz). Süren yapay
    // zekâ çağrısı yalnız durdurmada kesilir (`jobCancelSignal`); kapanış, kira kaybı ve süre aşımında arkada biter, sonucu önbelleğe girer.
    if (c === 'cancel' && state === 'running' && !committed) later(() => void forceCancel(), o.cancelGraceMs);
  };

  /** İşleyiciyi bırakır: çalıştırma `write` ile biter; işleyici sürse de sonucu ve ara yazımları reddedilir. */
  const detach = (c: JobAbort['cause'], write: () => Promise<void>): Promise<void> => {
    if (state !== 'running') return detachedWrite;
    state = 'detached';
    stopTimers();
    abort(c);
    detachedWrite = withLocale(locale, write).catch((err: unknown) => jobLog.warn({ err }, 'job detach write failed'));
    onDetach();
    return detachedWrite;
  };

  const lose = () => {
    if (state !== 'running') return;
    state = 'lost';
    stopTimers();
    abort('lost');
    onDetach();
  };

  // Kalp atışı: yapay zekâ çağrısından bağımsız zamanlayıcı. 0 satır = kira kaybı; durdurma isteği varsa sinyal kesilir.
  const beat = async () => {
    if (state !== 'running') return;
    try {
      const rows = await withJobScope(
        () => prisma.$queryRaw<{ cancelRequestedAt: Date | null }[]>`
          UPDATE "Job" SET "lockedUntil" = ${NOW} + (${o.leaseMs}::int * interval '1 millisecond'), "heartbeatAt" = ${NOW}
          WHERE "id" = ${job.id} AND "lockedBy" = ${token} AND "status" = 'RUNNING'
          RETURNING "cancelRequestedAt"`,
      );
      if (state !== 'running') return;
      if (!rows.length) {
        jobLog.warn({}, 'job lease lost');
        lose();
      } else if (rows[0]!.cancelRequestedAt && !committed) abort('cancel');
    } catch (err) {
      jobLog.warn({ err }, 'job heartbeat write failed');
    }
  };
  later(() => void beat(), Math.max(10, Math.floor(o.leaseMs / 4)), true);

  // ---------- işleyicinin bağlamı ----------
  const fenced = { id: job.id, lockedBy: token, status: 'RUNNING' as const };
  const pending: { progressDone?: number; progressTotal?: number | null; stage?: string; counters?: Record<string, number> } = {};
  let lastProgressAt = 0;
  let lastStage: string | undefined;

  const writeFenced = async (data: Prisma.JobUpdateManyMutationInput) => {
    if (state !== 'running') throw new JobLeaseLost();
    const r = await withCompany(job.companyId, () => prisma.job.updateMany({ where: fenced, data }));
    if (r.count !== 1) {
      lose();
      throw new JobLeaseLost();
    }
  };

  const flushProgress = async () => {
    if (!Object.keys(pending).length) return;
    const data: Prisma.JobUpdateManyMutationInput = {};
    if (pending.progressDone !== undefined) data.progressDone = pending.progressDone;
    if (pending.progressTotal !== undefined) data.progressTotal = pending.progressTotal;
    if (pending.stage !== undefined) data.stage = pending.stage;
    if (pending.counters !== undefined) data.counters = toJson(pending.counters);
    for (const k of Object.keys(pending)) delete pending[k as keyof typeof pending];
    lastProgressAt = Date.now();
    await writeFenced(data);
  };

  // Y57: payın başı bu çalıştırmanın başı; sorgu en çok `checkMs`'de bir, arada son cevap.
  const runStartedAt = Date.now();
  let fairCheckedAt = 0;
  let fairAnswer = false;
  const shouldYield = async (): Promise<boolean> => {
    const fair = o.fair;
    if (!fair || state !== 'running' || controller.signal.aborted) return false;
    if (Date.now() - runStartedAt < fair.sliceMs) return false;
    if (Date.now() - fairCheckedAt < fair.checkMs) return fairAnswer;
    fairCheckedAt = Date.now();
    try {
      fairAnswer = await otherCompanyWaiting(laneKinds(spec.lane), job.companyId);
    } catch (err) {
      // sorgu düşerse yuva bırakılmaz (iş sürer)
      jobLog.warn({ err }, 'job fair-share check failed');
      fairAnswer = false;
    }
    return fairAnswer;
  };

  const ctx: JobContext = {
    job,
    signal: controller.signal,
    shouldYield,
    async progress(p) {
      if (p.done !== undefined) pending.progressDone = p.done;
      if (p.total !== undefined) pending.progressTotal = p.total;
      if (p.counters !== undefined) pending.counters = p.counters;
      const stageChanged = p.stage !== undefined && p.stage !== lastStage;
      if (p.stage !== undefined) {
        pending.stage = p.stage;
        lastStage = p.stage;
      }
      if (stageChanged || Date.now() - lastProgressAt >= PROGRESS_MIN_INTERVAL_MS) await flushProgress();
    },
    async saveCheckpoint(c) {
      await writeFenced({ checkpoint: toJson(c) });
    },
    async fence(tx: Tx, p) {
      if (state !== 'running') throw new JobLeaseLost();
      const counters = p.counters === undefined ? null : JSON.stringify(p.counters);
      const checkpoint = p.checkpoint === undefined ? null : JSON.stringify(p.checkpoint);
      const n = await tx.$executeRaw`
        UPDATE "Job" SET "progressDone" = COALESCE(${p.done ?? null}::int, "progressDone"),
          "counters" = COALESCE(${counters}::jsonb, "counters"), "checkpoint" = COALESCE(${checkpoint}::jsonb, "checkpoint"),
          "updatedAt" = ${NOW}
        WHERE "id" = ${job.id} AND "lockedBy" = ${token} AND "status" = 'RUNNING' AND "lockedUntil" > ${NOW}`;
      if (n !== 1) {
        lose();
        throw new JobLeaseLost();
      }
      if (p.done !== undefined) delete pending.progressDone;
      if (p.counters !== undefined) delete pending.counters;
    },
    log: jobLog,
    markCommitted() {
      committed = true;
    },
  };

  // ---------- yazımlar (hepsi belirteç + RUNNING koşullu) ----------
  type Final = Extract<JobStatus, 'SUCCEEDED' | 'FAILED' | 'CANCELLED'>;
  /** Bitiş yazımı; satır bu çalıştırmada değilse false. */
  const finishWrite = async (status: Final, result: unknown, error: JobError | null) => {
    const data: Prisma.JobUpdateManyMutationInput = {
      status,
      result: toJson(result),
      error: toJson(error),
      finishedAt: new Date(),
      lockedBy: null,
      lockedUntil: null,
    };
    if (pending.progressDone !== undefined) data.progressDone = pending.progressDone;
    if (pending.progressTotal !== undefined) data.progressTotal = pending.progressTotal;
    if (pending.stage !== undefined) data.stage = pending.stage;
    if (pending.counters !== undefined) data.counters = toJson(pending.counters);
    const r = await withCompany(job.companyId, () => prisma.job.updateMany({ where: fenced, data }));
    if (r.count !== 1) jobLog.info({ status }, 'job result discarded: lease not held by this run');
    return r.count === 1;
  };
  const finish = async (status: Final, result: unknown, error: JobError | null) => {
    if ((await finishWrite(status, result, error)) && status !== 'SUCCEEDED') await runJobCleanup(job, status, log);
  };
  /**
   * Bırakılan işin bitişi. Temizlik kancası işleyici dönünce çalışır (önizleme dosyası işleyicinin son yazımıyla yarışmasın),
   * en geç `DETACHED_CLEANUP_WAIT_MS` sonra; yanıtı ve yuvayı beklemez.
   */
  const finishDetached = async (status: 'FAILED' | 'CANCELLED', error: JobError | null) => {
    if (!(await finishWrite(status, null, error))) return;
    let wait: NodeJS.Timeout | undefined;
    const bound = new Promise<void>((resolve) => {
      wait = setTimeout(resolve, DETACHED_CLEANUP_WAIT_MS);
      wait.unref();
    });
    void Promise.race([handlerSettled, bound]).then(() => {
      clearTimeout(wait);
      return runJobCleanup(job, status, log);
    });
  };

  const requeue = async (err: unknown) => {
    const delay = retryDelayMs(err, job.attempts);
    const lastError = JSON.stringify(err instanceof AppError ? errorOf(err) : { statusCode: 503, code: 'TRANSIENT', message: String((err as Error)?.message ?? err) });
    const n = await withJobScope(
      () => prisma.$executeRaw`
        UPDATE "Job" SET "status" = 'QUEUED', "lockedBy" = NULL, "lockedUntil" = NULL,
          "runAfter" = ${NOW} + (${delay}::int * interval '1 millisecond'), "error" = ${lastError}::jsonb, "updatedAt" = ${NOW}
        WHERE "id" = ${job.id} AND "lockedBy" = ${token} AND "status" = 'RUNNING'`,
    );
    if (n === 1) jobLog.info({ err: String((err as Error)?.message ?? err), delay }, 'job requeued after transient error');
  };

  /**
   * Y57: işleyici yuvayı bıraktı (`JobYield`). Bekleyen ilerleme aynı yazımda; iş QUEUED, `runAfter` = şimdi (daha önce
   * bekleyen başka firmanın işi önce alınır), deneme sayısı geri verilir (bırakmak hata değil; her çalıştırma en az bir
   * adım ilerlemeden bırakmaz, işleyicinin kuralı). Satır bu çalıştırmada değilse ya da bu arada durdurma istenmişse
   * (başka kopyadan, kalp atışı henüz görmedi) hiçbir şey yazılmaz: false (çağıran durdurmayı yazar).
   */
  const yieldSlot = async (): Promise<boolean> => {
    const counters = pending.counters === undefined ? null : JSON.stringify(pending.counters);
    const n = await withJobScope(
      () => prisma.$executeRaw`
        UPDATE "Job" SET "status" = 'QUEUED', "lockedBy" = NULL, "lockedUntil" = NULL, "runAfter" = ${NOW},
          "attempts" = GREATEST("attempts" - 1, 0),
          "progressDone" = COALESCE(${pending.progressDone ?? null}::int, "progressDone"),
          "progressTotal" = ${pending.progressTotal !== undefined ? Prisma.sql`${pending.progressTotal}::int` : Prisma.sql`"progressTotal"`},
          "stage" = COALESCE(${pending.stage ?? null}, "stage"),
          "counters" = COALESCE(${counters}::jsonb, "counters"),
          "updatedAt" = ${NOW}
        WHERE "id" = ${job.id} AND "lockedBy" = ${token} AND "status" = 'RUNNING' AND "cancelRequestedAt" IS NULL`,
    );
    if (n === 1) jobLog.info({}, 'job yielded its slot to another company');
    return n === 1;
  };

  /** Durdurma istendi, işleyici `cancelGraceMs` içinde dönmedi. */
  const forceCancel = () => {
    if (state !== 'running' || committed) return detachedWrite;
    jobLog.warn({ graceMs: o.cancelGraceMs }, 'job ignored cancel signal: marked cancelled');
    return detach('cancel', () => finishDetached('CANCELLED', null));
  };

  // En uzun çalışma süresi: aşılırsa işleyici bırakılır, iş geçici hata gibi kuyruğa döner, hakkı bittiyse FAILED.
  later(() => {
    if (state !== 'running') return;
    jobLog.warn({ maxRunMs }, 'job exceeded max run time');
    void detach('timeout', () =>
      job.attempts >= maxAttempts ? finishDetached('FAILED', abandonedError()) : requeue(new AppError(503, 'JOB_TIMEOUT', 'job exceeded max run time')),
    );
  }, maxRunMs);

  const body = async () => {
    let outcome: { ok: true; value: unknown } | { ok: false; err: unknown };
    if (job.cancelRequestedAt && !committed) abort('cancel');
    if (controller.signal.aborted) outcome = { ok: false, err: new JobCancelled() };
    else {
      const handlerRun = (async () => {
        const handler = await spec.handler();
        return withCompany(job.companyId, () => withLocale(locale, () => runInJobScope({ jobId: job.id, createdAt: job.createdAt }, () => handler(ctx))));
      })();
      handlerSettled = handlerRun.then(
        () => undefined,
        () => undefined,
      );
      const raced = await Promise.race([
        handlerRun.then(
          (value: unknown) => ({ ok: true as const, value }),
          (err: unknown) => ({ ok: false as const, err }),
        ),
        detachedSignal.then(() => null),
      ]);
      if (raced === null) {
        if (state === 'lost') jobLog.info({}, 'job result discarded: lease lost');
        await detachedWrite;
        return;
      }
      outcome = raced;
    }
    stopTimers();
    if (state !== 'running') {
      // kira kaybı ya da bırakıldı: bu çalıştırmanın sonucu yazılmaz
      if (state === 'lost') jobLog.info({}, 'job result discarded: lease lost');
      await detachedWrite;
      return;
    }
    state = 'finishing';
    try {
      await withLocale(locale, async () => {
        if (outcome.ok) return finish('SUCCEEDED', outcome.value, null);
        const failure = outcome.err;
        if (failure instanceof JobLeaseLost) return undefined;
        // Y57: durdurma istenmişse (bu süreçte, sahiplenmede ya da başka kopyadan satırda) yuva bırakma durdurmaya döner,
        // bölüm sonucuyla. Eskiden başka kopyanın isteği kalp atışından önce gelirse iş kuyruğa dönüyor, yuva bulunca
        // sonuçsuz (null) CANCELLED oluyordu. Satır bu çalıştırmada değilse bitiş yazımı da bir şey yazmaz (çitli).
        if (failure instanceof JobYield) {
          if (cause !== 'cancel' && !job.cancelRequestedAt && (await yieldSlot())) return undefined;
          return finish('CANCELLED', failure.partial ?? null, null);
        }
        if (failure instanceof JobCancelled) return finish('CANCELLED', failure.partial, null);
        if (cause === 'cancel') return finish('CANCELLED', null, null);
        if (isTransientJobError(failure)) {
          // Deneme hakkı bitti: sağlayıcının geçici hatasında kullanıcı asıl nedeni görür ("yapay zekâ yoğun"), genel
          // "yarıda kaldı" değil. Diğer geçici hatalar (dosya havuzu, veritabanı) eskisi gibi JOB_ABANDONED.
          if (job.attempts >= maxAttempts) return finish('FAILED', null, isAiTransient(failure) ? errorOf(failure) : abandonedError());
          return requeue(failure);
        }
        if (failure instanceof AppError) return finish('FAILED', null, errorOf(failure));
        (log.error ?? log.warn)({ err: failure, jobId: job.id, kind: job.kind }, 'job failed with unexpected error');
        return finish('FAILED', null, internalError());
      });
    } catch (err) {
      // bitiş yazılamadı (veritabanı): kira dolunca iş yeniden alınır
      jobLog.warn({ err }, 'job finish write failed');
    }
  };

  const run: ActiveRun = {
    job,
    token,
    done: Promise.resolve(),
    abort,
    release: () =>
      detach('shutdown', async () => {
        // Düzgün kapanış deneme hakkı yemez, ama iş başına en çok MAX_SHUTDOWN_REFUNDS kez: ardışık kapanışlarda bitmeyen iş
        // sonsuza dek geri sayılmasın. Sayaç `releases` sütununda (Y89; hata yazımı sıfırlamaz); geçiş için `error`'a da
        // yazılır (bitmemiş işte ekrana çıkmaz). SET ifadeleri satırın eski değerlerini okur: üçü aynı sayaçtan.
        await withJobScope(
          () => prisma.$executeRaw`
            UPDATE "Job" SET "status" = 'QUEUED', "lockedBy" = NULL, "lockedUntil" = NULL, "runAfter" = ${NOW},
              "attempts" = CASE WHEN ${RELEASES} < ${MAX_SHUTDOWN_REFUNDS}::int THEN GREATEST("attempts" - 1, 0) ELSE "attempts" END,
              "releases" = ${RELEASES} + 1,
              "error" = jsonb_build_object('statusCode', 503, 'code', 'JOB_RELEASED', 'message', 'released at shutdown',
                'details', jsonb_build_object('releases', ${RELEASES} + 1)),
              "updatedAt" = ${NOW}
            WHERE "id" = ${job.id} AND "lockedBy" = ${token} AND "status" = 'RUNNING'`,
        );
      }),
  };
  localRuns.set(job.id, run);
  run.done = body().finally(() => {
    stopTimers();
    if (localRuns.get(job.id) === run) localRuns.delete(job.id);
  });
  return run;
}

// ---------- Deneme hakkı biten işler ----------

/**
 * Deneme hakkı biten işleri `FAILED`, `JOB_ABANDONED` yapar. Aday listesi iş kapsamında (QUEUED ya da kirası dolmuş RUNNING;
 * kapalı firmanınki alınmaz, temizlik kancası firma geri açılınca çalışır),
 * yazım her işin kendi firma bağlamında ve aynı koşulla (yarışta süren işe dokunulmaz), ardından türün temizlik kancası.
 */
export async function sweepAbandonedJobs(log: JobLog = quietLog): Promise<number> {
  const candidates = await withJobScope(
    () => prisma.$queryRaw<{ id: string; companyId: string }[]>`
      SELECT j."id", j."companyId" FROM "Job" j
      WHERE j."attempts" >= j."maxAttempts"
        AND (j."status" = 'QUEUED' OR (j."status" = 'RUNNING' AND j."lockedUntil" < ${NOW}))
        AND ${OPEN_COMPANY}
      ORDER BY j."createdAt" LIMIT ${ABANDON_BATCH}`,
  );
  let n = 0;
  for (const c of candidates) {
    try {
      const failed = await withCompany(c.companyId, async () => {
        const rows = await prisma.$queryRaw<{ locale: string | null }[]>`SELECT "input"->>'locale' AS "locale" FROM "Job" WHERE "id" = ${c.id}`;
        const error = JSON.stringify(withLocale(normalizeLocale(rows[0]?.locale ?? undefined), abandonedError));
        const out = await prisma.$queryRaw<ClaimRow[]>`
          UPDATE "Job" t SET "status" = 'FAILED', "error" = ${error}::jsonb, "finishedAt" = ${NOW}, "lockedBy" = NULL,
            "lockedUntil" = NULL, "updatedAt" = ${NOW}
          WHERE t."id" = ${c.id} AND t."companyId" = ${c.companyId} AND t."attempts" >= t."maxAttempts"
            AND (t."status" = 'QUEUED' OR (t."status" = 'RUNNING' AND t."lockedUntil" < ${NOW}))
          RETURNING ${RETURNING}`;
        return out[0] ? toClaimed(out[0]) : null;
      });
      if (failed) {
        n++;
        log.warn({ jobId: failed.id, kind: failed.kind, attempts: failed.attempts }, 'job attempts exhausted: JOB_ABANDONED');
        const { maxAttempts: _m, ...job } = failed;
        await runJobCleanup(job, 'FAILED', log);
      }
    } catch (err) {
      log.warn({ err, jobId: c.id }, 'could not mark abandoned job');
    }
  }
  return n;
}

// ---------- Satır içi kip ----------

const inlineRuns = new Set<ActiveRun>();

/**
 * Satır içi kip (`JOB_RUNNER=inline`): işi kimliğiyle sahiplenir ve bitene kadar bekler. Sahiplenilemezse (başka yerde
 * sürüyor, bitmiş, deneme hakkı bitmiş) hemen döner. Kalp atışı, kira ve sahiplik denetimi döngüdekiyle aynı koddan geçer.
 * `true`: bu çağrı işi çalıştırdı.
 */
export async function runJobInline(jobId: string, log: JobLog = quietLog): Promise<boolean> {
  const token = `${PROCESS_ID}:inline/${crypto.randomUUID()}`;
  const row = await claimById(jobId, token, env.jobLeaseMs);
  if (!row) return false;
  const run = launch(row, token, { leaseMs: env.jobLeaseMs, cancelGraceMs: JOB_CANCEL_GRACE_MS }, log);
  inlineRuns.add(run);
  try {
    await run.done;
  } finally {
    inlineRuns.delete(run);
  }
  return true;
}

/** `app.close()` (app.ts `onClose`): süren satır içi işlerin kirası bırakılır, zamanlayıcıları kapanır. */
export async function closeInlineJobs(): Promise<void> {
  const runs = [...inlineRuns];
  inlineRuns.clear();
  await Promise.all(runs.map((r) => r.release()));
}

// ---------- Döngü ----------

const runners = new Set<{ wake(): void }>();

/** Bu süreçteki döngüleri uyandırır (`JOB_RUNNER=on` iken `kickJob`). */
export function wakeJobRunners(): void {
  for (const r of runners) r.wake();
}

/**
 * Döngüyü başlatır (main.ts, `JOB_RUNNER=on`). Grup başına boş yuva kadar iş sahiplenir; iş yoksa `pollMs` bekler ya da
 * `wake()` ile hemen uyanır. Zamanlayıcılar `unref`: süreci açık tutmaz. `stop()`: yeni iş almaz, süren işleri `graceMs`
 * bekler, bitmeyenlerin kirasını bırakır (deneme geri sayılır, yeni süreç hemen alır).
 */
export function startJobRunner(log: JobLog, o: Partial<JobRunnerOptions> = {}): JobRunner {
  const pollMs = o.pollMs ?? env.jobPollMs;
  const leaseMs = o.leaseMs ?? env.jobLeaseMs;
  const graceMs = o.graceMs ?? env.jobShutdownGraceMs;
  const launchOptions: LaunchOptions = {
    leaseMs,
    cancelGraceMs: o.cancelGraceMs ?? JOB_CANCEL_GRACE_MS,
    fair: { sliceMs: o.fairSliceMs ?? JOB_FAIR_SLICE_MS, checkMs: o.fairCheckMs ?? JOB_FAIR_CHECK_MS },
  };
  const slots: Record<JobLane, number> = { ai: o.slots?.ai ?? env.jobSlotsAi, recalc: o.slots?.recalc ?? env.jobSlotsRecalc };
  const runnerId = `${PROCESS_ID}:${crypto.randomBytes(2).toString('hex')}`;
  const running: Record<JobLane, Set<ActiveRun>> = { ai: new Set(), recalc: new Set() };
  let timer: NodeJS.Timeout | null = null;
  let ticking: Promise<void> | null = null;
  let again = false;
  let stopping = false;
  let lastSweep = 0;

  // Zamanlayıcı döngünün başlatıldığı (kök) bağlamda kurulur: istek içinden çağrılan `wake()` o isteğin firma, dil ve
  // sorgu şeridi bağlamını döngüye ve işlere taşımaz.
  const schedule = AsyncResource.bind((ms: number) => {
    if (stopping) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, ms);
    timer.unref();
  });

  const turn = async () => {
    if (Date.now() - lastSweep >= pollMs) {
      lastSweep = Date.now();
      await sweepAbandonedJobs(log);
    }
    for (const lane of LANES) {
      while (!stopping && running[lane].size < slots[lane]) {
        const token = `${runnerId}/${crypto.randomUUID()}`;
        const row = await claimNext(laneKinds(lane), token, leaseMs);
        if (!row) break;
        const run = launch(row, token, launchOptions, log);
        running[lane].add(run);
        void run.done.then(() => {
          running[lane].delete(run);
          wake();
        });
      }
    }
  };

  const tick = (): Promise<void> => {
    if (stopping) return Promise.resolve();
    if (ticking) {
      again = true;
      return ticking;
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    ticking = turn()
      .catch((err: unknown) => log.warn({ err }, 'job runner turn failed'))
      .finally(() => {
        ticking = null;
        if (again) {
          again = false;
          schedule(0);
        } else schedule(pollMs);
      });
    return ticking;
  };

  const wake = () => {
    if (stopping) return;
    if (ticking) again = true;
    else schedule(0);
  };

  const handle = { wake };
  runners.add(handle);
  schedule(0);

  return {
    wake,
    async stop() {
      if (stopping) return;
      stopping = true;
      runners.delete(handle);
      if (timer) clearTimeout(timer);
      timer = null;
      if (ticking) await ticking;
      const active = [...running.ai, ...running.recalc];
      if (active.length) {
        let grace: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.all(active.map((r) => r.done)),
          new Promise<void>((resolve) => {
            grace = setTimeout(resolve, graceMs);
            grace.unref();
          }),
        ]);
        clearTimeout(grace);
        const left = [...running.ai, ...running.recalc];
        await Promise.all(left.map((r) => r.release()));
        // Bitiş yazımı sürmekte olan (bırakılamayan) çalıştırma kısa süre beklenir: app.close() yazımı yarıda kesmesin.
        // Bırakılan işleyici askıda kalabilir; onu beklemeyiz (sonucu zaten yazılamaz).
        let settle: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.all(left.map((r) => r.done)),
          new Promise<void>((resolve) => {
            settle = setTimeout(resolve, FINISH_SETTLE_MS);
            settle.unref();
          }),
        ]);
        clearTimeout(settle);
      }
    },
  };
}
