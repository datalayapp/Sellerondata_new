/**
 * İş kuyruğu motoru (Mesaj 7 P1, plan §4.3–§4.9, §5 "P1"): ekleme ve tekillik, sahiplenme (`SKIP LOCKED`), kira ve kalp
 * atışı, sahiplik denetimi, devralma, yeniden deneme, durdurma, kapanış, satır içi kip, `/jobs` uçları ve izinler.
 *
 * Sahte işleyiciler gerçek türleri ödünç alır (`overrideJobKindForTest`; `kind` sütunu enum). Çalıştırıcı döngüleri her
 * testten sonra durdurulur; artakalan bekleyen/süren işler süper kullanıcıyla kapatılır (başka test dosyalarının işleri
 * dahil, döngü onları almasın).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const flags = vi.hoisted(() => ({ hidePrices: false }));
// Bugünkü rollerde iş izni olan herkes fiyat da görüyor: fiyat izni olmayan kişiyi `can` üzerinden taklit ederiz.
vi.mock('../src/lib/access.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/lib/access.ts')>();
  return {
    ...mod,
    can: (req: Parameters<typeof mod.can>[0], p: Parameters<typeof mod.can>[1]) =>
      flags.hidePrices && p === 'deciship.prices.view' ? false : mod.can(req, p),
  };
});

import { prisma, withCompany, withJobScope } from '../src/db.ts';
import { missingProductionEnv } from '../src/env.ts';
import { AppError } from '../src/errors.ts';
import { currentLocale, m } from '../src/i18n/index.ts';
import { cleanupFinishedJobs, enqueueJob, findJob, JOB_RETENTION_MS, kickJob } from '../src/services/jobs/queue.ts';
import { overrideJobKindForTest } from '../src/services/jobs/registry.ts';
import { closeInlineJobs, JobAbort, JobLeaseLost, startJobRunner, sweepAbandonedJobs, type JobRunner, type JobRunnerOptions } from '../src/services/jobs/runner.ts';
import { JobCancelled, type JobContext, type JobKind, type JobKindSpec } from '../src/services/jobs/types.ts';
import { createMember, findMoneyKeys, getApp, registerCompany, uniq } from './helpers.ts';
import { testSuperDbUrl } from './testEnv.ts';

const API = '/api/deciship';
const AI: JobKind = 'TARIFF_PDF_SCAN';
const AI2: JobKind = 'TARIFF_PDF_EXTRACT';
const RECALC: JobKind = 'BULK_RECOMPARE_PREVIEW';

type Company = Awaited<ReturnType<typeof registerCompany>>;

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => Promise<boolean> | boolean, timeoutMs = 8000, label = 'koşul') {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(15);
  }
  throw new Error(`${label} ${timeoutMs} ms içinde gerçekleşmedi`);
}
/** Elle tetiklenen söz: işleyiciyi test adımına kadar bekletir. */
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}
const aborted = (signal: AbortSignal) =>
  new Promise<void>((r) => (signal.aborted ? r() : signal.addEventListener('abort', () => r(), { once: true })));

describe('iş kuyruğu motoru', () => {
  let app: FastifyInstance;
  let sup: pg.Client;
  let A: Company;
  let B: Company;
  const restores: (() => void)[] = [];
  const runners: JobRunner[] = [];

  const override = (kind: JobKind, spec: Partial<JobKindSpec>) => restores.push(overrideJobKindForTest(kind, spec));
  const handle = (kind: JobKind, fn: (ctx: JobContext) => Promise<unknown>, extra: Partial<JobKindSpec> = {}) =>
    override(kind, { handler: async () => fn, ...extra });
  const start = (o: Partial<JobRunnerOptions> = {}) => {
    const r = startJobRunner(silent, { pollMs: 20, leaseMs: 2000, graceMs: 300, ...o });
    runners.push(r);
    return r;
  };
  const add = (c: Company, kind: JobKind, over: { dedupeKey?: string; input?: Record<string, unknown>; ref?: { type: 'File' | 'Tariff' | 'TariffDocument' | 'Company'; id: string } } = {}) =>
    enqueueJob({ companyId: c.companyId, createdById: c.userId, kind, dedupeKey: over.dedupeKey ?? uniq('k:'), input: { locale: 'tr', ...over.input }, ref: over.ref });
  const row = async (c: Company, id: string) => (await findJob(c.companyId, id))!;
  const jobsScopeUpdate = (id: string, data: Parameters<typeof prisma.job.updateMany>[0]['data']) =>
    withJobScope(() => prisma.job.updateMany({ where: { id }, data }));
  const get = (c: { auth: { authorization: string } }, id: string, lang = 'tr') =>
    app.inject({ method: 'GET', url: `${API}/jobs/${id}`, headers: { ...c.auth, 'accept-language': lang } });
  const cancel = (c: { auth: { authorization: string } }, id: string) =>
    app.inject({ method: 'POST', url: `${API}/jobs/${id}/cancel`, headers: c.auth, payload: {} });

  beforeAll(async () => {
    app = await getApp();
    sup = new pg.Client({ connectionString: testSuperDbUrl(), options: '-c search_path=deciship' });
    await sup.connect();
    A = await registerCompany(app, uniq('İş A '));
    B = await registerCompany(app, uniq('İş B '));
  });

  const closeLeftovers = () =>
    sup.query(`UPDATE "Job" SET "status" = 'CANCELLED', "finishedAt" = now() AT TIME ZONE 'UTC', "lockedBy" = NULL, "lockedUntil" = NULL WHERE "status" IN ('QUEUED', 'RUNNING')`);

  beforeEach(async () => {
    await closeLeftovers();
  });

  afterEach(async () => {
    await Promise.all(runners.splice(0).map((r) => r.stop()));
    await closeInlineJobs();
    for (const r of restores.splice(0)) r();
    flags.hidePrices = false;
    vi.unstubAllEnvs();
    await closeLeftovers();
  });

  afterAll(async () => {
    await sup.end();
  });

  // ---------- satır içi kip ----------

  it('satır içi kip: başlatan çağrı işi bitirir; sonuç, ilerleme, dil ve firma bağlamı satırdan', async () => {
    let seen: { locale: string; ownJobs: number; companyId: string } | null = null;
    handle(AI, async (ctx) => {
      await ctx.progress({ stage: 'tariffScan', done: 1, total: 3 });
      // firma bağlamı: RLS yalnız bu firmanın işlerini gösterir
      seen = { locale: currentLocale(), ownJobs: await prisma.job.count({ where: { companyId: { not: ctx.job.companyId } } }), companyId: ctx.job.companyId };
      await ctx.progress({ done: 3 });
      return { found: 3, text: m('job.finished') };
    });
    await add(B, AI); // başka firmanın işi: A'nın işleyicisi onu göremez
    const { jobId, joined } = await add(A, AI, { input: { locale: 'en' } });
    expect(joined).toBe(false);
    await kickJob(jobId);
    expect(seen).toEqual({ locale: 'en', ownJobs: 0, companyId: A.companyId });

    const res = await get(A, jobId);
    expect(res.statusCode, res.body).toBe(200);
    const view = res.json();
    expect(view).toMatchObject({
      id: jobId,
      kind: AI,
      status: 'SUCCEEDED',
      attempt: 1,
      cancellable: false,
      cancelRequested: false,
      result: { found: 3, text: 'This job has already finished.' },
      progress: { done: 3, total: 3, stage: 'tariffScan' },
    });
    expect(view.error).toBeUndefined();
    expect(view.finishedAt).not.toBeNull();
    expect(view.elapsedMs).toBeGreaterThanOrEqual(0);
    // girdi dışarı verilmez
    expect(view.input).toBeUndefined();
  });

  it('closeInlineJobs: süren satır içi işin kirası bırakılır, deneme geri sayılır, geç gelen sonuç yazılmaz', async () => {
    const started = gate();
    let reason: unknown;
    handle(AI, async (ctx) => {
      started.open();
      await aborted(ctx.signal);
      reason = ctx.signal.reason;
      return { late: true };
    });
    const { jobId } = await add(A, AI);
    const running = kickJob(jobId);
    await started.p;
    expect((await row(A, jobId)).status).toBe('RUNNING');
    await closeInlineJobs();
    await running;
    expect(reason).toBeInstanceOf(JobAbort);
    expect((reason as JobAbort).cause).toBe('shutdown');
    const r = await row(A, jobId);
    expect(r).toMatchObject({ status: 'QUEUED', attempts: 0, lockedBy: null, lockedUntil: null, result: null });
  });

  // ---------- ekleme ve tekillik ----------

  it('tekillik: aynı anahtarla bekleyen iş varken yenisi açılmaz (joined); bitince aynı anahtarla yenisi açılır', async () => {
    vi.stubEnv('JOB_RUNNER', 'off');
    const key = uniq('pdf:');
    const first = await add(A, AI, { dedupeKey: key });
    const second = await add(A, AI, { dedupeKey: key });
    expect(second).toEqual({ jobId: first.jobId, joined: true });
    // başka firma, başka tür: ayrı iş
    const other = await add(B, AI, { dedupeKey: key });
    const otherKind = await add(A, AI2, { dedupeKey: key });
    expect(other.joined).toBe(false);
    expect(otherKind.joined).toBe(false);
    expect(new Set([first.jobId, other.jobId, otherKind.jobId]).size).toBe(3);
    // aynı anda iki ekleme: tek iş
    const key2 = uniq('pdf:');
    const pair = await Promise.all([add(A, AI, { dedupeKey: key2 }), add(A, AI, { dedupeKey: key2 })]);
    expect(pair[0].jobId).toBe(pair[1].jobId);
    expect(pair.filter((p) => p.joined)).toHaveLength(1);

    handle(AI, async () => ({ ok: 1 }));
    vi.stubEnv('JOB_RUNNER', 'inline');
    await kickJob(first.jobId);
    expect((await row(A, first.jobId)).status).toBe('SUCCEEDED');
    const third = await add(A, AI, { dedupeKey: key });
    expect(third.joined).toBe(false);
    expect(third.jobId).not.toBe(first.jobId);
    // girdiye dil ve sürüm eklenir; çağıranın verdiği dil korunur
    expect((await row(A, third.jobId)).input).toMatchObject({ v: 1, locale: 'tr' });
  });

  // ---------- sahiplenme ----------

  it('iki çalıştırıcı aynı anda farklı işleri alır; aynı işi ikisi almaz', async () => {
    const companies = [A, B, ...(await Promise.all([1, 2, 3, 4].map(() => registerCompany(app, uniq('İş C ')))))];
    const runs: string[] = [];
    let active = 0;
    let peak = 0;
    handle(AI, async (ctx) => {
      runs.push(ctx.job.id);
      active++;
      peak = Math.max(peak, active);
      await sleep(250);
      active--;
      return { ok: true };
    });
    vi.stubEnv('JOB_RUNNER', 'off');
    const ids = (await Promise.all(companies.map((c) => add(c, AI)))).map((j) => j.jobId);
    start({ slots: { ai: 2, recalc: 1 } });
    start({ slots: { ai: 2, recalc: 1 } });
    await until(async () => {
      const rows = await Promise.all(ids.map((id, i) => row(companies[i]!, id)));
      return rows.every((r) => r.status === 'SUCCEEDED');
    }, 15_000, 'altı iş');
    expect(runs.sort()).toEqual([...ids].sort());
    // iki çalıştırıcı × 2 yuva: tek çalıştırıcının sınırı (2) aşıldı
    expect(peak).toBeGreaterThan(2);
    for (const [i, id] of ids.entries()) expect((await row(companies[i]!, id)).attempts).toBe(1);
  });

  it('firma başına grup başına 1 iş; başka firma ve başka grup beklemez', async () => {
    const log: { company: string; kind: JobKind; at: 'start' | 'end' }[] = [];
    const work = async (ctx: JobContext) => {
      log.push({ company: ctx.job.companyId, kind: ctx.job.kind, at: 'start' });
      await sleep(150);
      log.push({ company: ctx.job.companyId, kind: ctx.job.kind, at: 'end' });
      return {};
    };
    handle(AI, work);
    handle(AI2, work);
    handle(RECALC, work);
    vi.stubEnv('JOB_RUNNER', 'off');
    const jobsA = [await add(A, AI), await add(A, AI2), await add(A, AI)];
    const jobB = await add(B, AI);
    const recalcA = await add(A, RECALC, { input: { scope: 'tariff' } });
    start({ slots: { ai: 2, recalc: 1 } });
    const all = [...jobsA.map((j) => [A, j.jobId] as const), [B, jobB.jobId] as const, [A, recalcA.jobId] as const];
    await until(async () => (await Promise.all(all.map(([c, id]) => row(c, id)))).every((r) => r.status === 'SUCCEEDED'), 15_000, 'beş iş');

    const concurrency = (pick: (e: (typeof log)[number]) => boolean) => {
      let cur = 0;
      let max = 0;
      for (const e of log.filter(pick)) {
        cur += e.at === 'start' ? 1 : -1;
        max = Math.max(max, cur);
      }
      return max;
    };
    const aiKinds = new Set<JobKind>([AI, AI2]);
    expect(concurrency((e) => e.company === A.companyId && aiKinds.has(e.kind))).toBe(1);
    // B'nin işi ve A'nın toplu hesabı A'nın yapay zekâ işleriyle aynı anda çalıştı
    expect(concurrency((e) => aiKinds.has(e.kind))).toBe(2);
    expect(concurrency((e) => e.company === A.companyId)).toBe(2);
  });

  it('kira dolunca devralma: ölen sürecin işi yeniden sahiplenilir, deneme +1', async () => {
    handle(AI, async (ctx) => ({ attempts: ctx.job.attempts }));
    vi.stubEnv('JOB_RUNNER', 'off');
    const { jobId } = await add(A, AI);
    // ölen süreç: RUNNING, kirası geçmiş, 1 deneme
    await jobsScopeUpdate(jobId, { status: 'RUNNING', lockedBy: 'dead-process/x', lockedUntil: new Date(Date.now() - 5000), attempts: 1, startedAt: new Date() });
    // kirası geçerli olan devralınmaz
    const fresh = await add(B, AI);
    await jobsScopeUpdate(fresh.jobId, { status: 'RUNNING', lockedBy: 'alive/x', lockedUntil: new Date(Date.now() + 60_000), attempts: 1 });
    start();
    await until(async () => (await row(A, jobId)).status === 'SUCCEEDED', 8000, 'devralma');
    expect((await row(A, jobId)).result).toEqual({ attempts: 2 });
    expect((await get(A, jobId)).json().attempt).toBe(2);
    await sleep(100);
    expect(await row(B, fresh.jobId)).toMatchObject({ status: 'RUNNING', lockedBy: 'alive/x', attempts: 1 });
  });

  // ---------- kira, kalp atışı, sahiplik ----------

  it('kalp atışı kaybında sinyal kesilir, geç gelen sonuç yazılmaz', async () => {
    const started = gate();
    let reason: unknown;
    let returned = false;
    handle(AI, async (ctx) => {
      started.open();
      await aborted(ctx.signal);
      reason = ctx.signal.reason;
      returned = true;
      return { late: true };
    });
    vi.stubEnv('JOB_RUNNER', 'off');
    const { jobId } = await add(A, AI);
    start({ leaseMs: 400 });
    await started.p;
    // başka çalıştırıcı devraldı
    expect((await jobsScopeUpdate(jobId, { lockedBy: 'thief/x', lockedUntil: new Date(Date.now() + 60_000) })).count).toBe(1);
    await until(() => returned, 3000, 'kalp atışı');
    expect((reason as JobAbort).cause).toBe('lost');
    await sleep(150);
    expect(await row(A, jobId)).toMatchObject({ status: 'RUNNING', lockedBy: 'thief/x', result: null, finishedAt: null });
  });

  it('sahiplik denetimi: kira dolunca çit yazımı işlemi geri alır; sonraki yazımlar ve sonuç atılır', async () => {
    const out: Record<string, string> = {};
    handle(AI, async (ctx) => {
      const id = ctx.job.id;
      // kira geçerli: çit ilerlemeyi aynı işlemde yazar
      await prisma.$transaction(async (tx) => {
        await tx.job.updateMany({ where: { id }, data: { label: 'ilk' } });
        await ctx.fence(tx, { done: 5, counters: { invoices: 5 } });
      });
      // kira doldu (henüz kimse devralmadı): çit 0 satır, işlem geri alınır
      await withJobScope(() => prisma.job.updateMany({ where: { id }, data: { lockedUntil: new Date(Date.now() - 1000) } }));
      out.fence = await prisma
        .$transaction(async (tx) => {
          await tx.job.updateMany({ where: { id }, data: { label: 'ikinci' } });
          await ctx.fence(tx, { done: 9 });
        })
        .then(
          () => 'ok',
          (e: unknown) => (e as Error).constructor.name,
        );
      out.aborted = String(ctx.signal.aborted);
      out.progress = await ctx.progress({ stage: 'tariffScan', done: 10 }).then(
        () => 'ok',
        (e: unknown) => (e as Error).constructor.name,
      );
      out.checkpoint = await ctx.saveCheckpoint({ at: 10 }).then(
        () => 'ok',
        (e: unknown) => (e as Error).constructor.name,
      );
      handlerDone.open();
      return { written: true };
    });
    const handlerDone = gate();
    const { jobId } = await add(A, AI);
    // kira kaybında çalıştırma hemen biter (yuva boşalır); işleyici arkada sürer: onun bitişini bekle
    await kickJob(jobId);
    await handlerDone.p;
    await sleep(50);
    expect(out).toEqual({ fence: JobLeaseLost.name, aborted: 'true', progress: JobLeaseLost.name, checkpoint: JobLeaseLost.name });
    expect(await row(A, jobId)).toMatchObject({ status: 'RUNNING', label: 'ilk', progressDone: 5, counters: { invoices: 5 }, checkpoint: null, result: null });
  });

  it('sahiplik denetimi: belirteç değişince ilerleme yazımı 0 satır, sonuç yazılmaz', async () => {
    let progress = '';
    handle(AI, async (ctx) => {
      await withJobScope(() => prisma.job.updateMany({ where: { id: ctx.job.id }, data: { lockedBy: 'other/x' } }));
      progress = await ctx.progress({ stage: 'tariffScan' }).then(
        () => 'ok',
        (e: unknown) => (e as Error).constructor.name,
      );
      handlerDone.open();
      return { written: true };
    });
    const handlerDone = gate();
    const { jobId } = await add(A, AI);
    await kickJob(jobId);
    await handlerDone.p;
    await sleep(50);
    expect(progress).toBe(JobLeaseLost.name);
    expect(await row(A, jobId)).toMatchObject({ status: 'RUNNING', lockedBy: 'other/x', stage: null, result: null });
  });

  // ---------- durdurma ----------

  it('kuyruktayken durdurma: hemen CANCELLED, temizlik kancası çalışır; ikinci istek 409', async () => {
    const cleaned: string[] = [];
    override(AI, { cleanup: async (job, outcome) => void cleaned.push(`${job.id}:${outcome}:${job.companyId}`) });
    vi.stubEnv('JOB_RUNNER', 'off');
    const { jobId } = await add(A, AI);
    const res = await cancel(A, jobId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: jobId, status: 'CANCELLED', cancelRequested: true, cancellable: false });
    expect(res.json().finishedAt).not.toBeNull();
    expect(cleaned).toEqual([`${jobId}:CANCELLED:${A.companyId}`]);
    const again = await cancel(A, jobId);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('JOB_FINISHED');
    // durdurulmuş iş çalıştırılmaz
    vi.stubEnv('JOB_RUNNER', 'inline');
    await kickJob(jobId);
    expect((await row(A, jobId)).status).toBe('CANCELLED');
  });

  it('durdurulamayan tür: 409 JOB_NOT_CANCELLABLE, iş sürer', async () => {
    override(AI, { cancellable: false });
    vi.stubEnv('JOB_RUNNER', 'off');
    const { jobId } = await add(A, AI);
    expect((await get(A, jobId)).json().cancellable).toBe(false);
    const res = await cancel(A, jobId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('JOB_NOT_CANCELLABLE');
    expect((await row(A, jobId)).status).toBe('QUEUED');
  });

  it('çalışırken durdurma (aynı süreç): sinyal hemen kesilir, bölüm sonucu result, temizlik kancası', async () => {
    const started = gate();
    const cleaned: string[] = [];
    handle(
      AI,
      async (ctx) => {
        started.open();
        await aborted(ctx.signal);
        throw new JobCancelled({ done: 2 });
      },
      { cleanup: async (_job, outcome) => void cleaned.push(outcome) },
    );
    vi.stubEnv('JOB_RUNNER', 'off');
    const { jobId } = await add(A, AI);
    start({ leaseMs: 60_000 }); // kalp atışı bu testte gelmez: kesen aynı süreçteki istek
    await started.p;
    const res = await cancel(A, jobId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ cancelRequested: true });
    await until(async () => (await row(A, jobId)).status === 'CANCELLED', 3000, 'durdurma');
    const view = (await get(A, jobId)).json();
    expect(view).toMatchObject({ status: 'CANCELLED', result: { done: 2 }, cancellable: false });
    expect(view.error).toBeUndefined();
    expect(cleaned).toEqual(['CANCELLED']);
  });

  it('çalışırken durdurma (başka kopya): kalp atışı cancelRequestedAt görür ve sinyali keser', async () => {
    const started = gate();
    handle(AI, async (ctx) => {
      started.open();
      await aborted(ctx.signal);
      throw new Error('işleyici kesildi'); // JobCancelled atmasa da durdurma isteği CANCELLED sayılır
    });
    vi.stubEnv('JOB_RUNNER', 'off');
    const { jobId } = await add(A, AI);
    start({ leaseMs: 400 });
    await started.p;
    await withCompany(A.companyId, () => prisma.job.updateMany({ where: { id: jobId }, data: { cancelRequestedAt: new Date() } }));
    await until(async () => (await row(A, jobId)).status === 'CANCELLED', 3000, 'durdurma');
    expect(await row(A, jobId)).toMatchObject({ result: null, error: null });
  });

  // ---------- kapanış ----------

  it('kapanış: süreye sığan iş biter; sığmayanın kirası bırakılır, deneme geri sayılır, yeni süreç hemen alır', async () => {
    const slowStarted = gate();
    let slowReason: unknown;
    handle(AI, async (ctx) => {
      if (ctx.job.companyId === A.companyId) {
        await sleep(100);
        return { quick: true };
      }
      slowStarted.open();
      await aborted(ctx.signal);
      slowReason = ctx.signal.reason;
      await sleep(50);
      return { late: true };
    });
    vi.stubEnv('JOB_RUNNER', 'off');
    const quick = await add(A, AI);
    const slow = await add(B, AI);
    const runner = start({ graceMs: 400, slots: { ai: 2, recalc: 1 } });
    await slowStarted.p;
    await until(async () => (await row(A, quick.jobId)).status !== 'QUEUED', 3000, 'hızlı iş başladı');
    await runner.stop();
    expect((await row(A, quick.jobId)).status).toBe('SUCCEEDED');
    expect((slowReason as JobAbort).cause).toBe('shutdown');
    const released = await row(B, slow.jobId);
    expect(released).toMatchObject({ status: 'QUEUED', attempts: 0, lockedBy: null, lockedUntil: null });
    expect(released.runAfter.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    await sleep(100);
    expect((await row(B, slow.jobId)).result).toBeNull(); // geç dönen sonuç yazılmadı

    // yeni süreç hemen alır ve bitirir
    handle(AI, async (ctx) => ({ attempts: ctx.job.attempts }));
    start();
    await until(async () => (await row(B, slow.jobId)).status === 'SUCCEEDED', 5000, 'yeni süreç');
    expect((await row(B, slow.jobId)).result).toEqual({ attempts: 1 });
  });

  // ---------- hata ve yeniden deneme ----------

  it('geçici hata: kuyruğa döner, runAfter = şimdi + 10 sn × deneme; sonra başarır', async () => {
    let calls = 0;
    handle(AI, async () => {
      calls++;
      if (calls === 1) throw new AppError(503, 'FILE_BUSY', 'meşgul');
      if (calls === 2) throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
      return { calls };
    });
    const { jobId } = await add(A, AI);
    await kickJob(jobId);
    let r = await row(A, jobId);
    expect(r).toMatchObject({ status: 'QUEUED', attempts: 1, lockedBy: null, finishedAt: null });
    expect(r.runAfter.getTime() - r.updatedAt.getTime()).toBe(10_000);
    // runner döngüsü runAfter'ı bekler; satır içi kip "şimdi çalıştır" der
    await kickJob(jobId);
    r = await row(A, jobId);
    expect(r).toMatchObject({ status: 'QUEUED', attempts: 2 });
    expect(r.runAfter.getTime() - r.updatedAt.getTime()).toBe(20_000);
    await kickJob(jobId);
    r = await row(A, jobId);
    expect(r).toMatchObject({ status: 'SUCCEEDED', attempts: 3, result: { calls: 3 } });
    expect((await get(A, jobId)).json().error).toBeUndefined();
  });

  it('döngü runAfter gelmemiş işi almaz', async () => {
    handle(AI, async () => ({}));
    vi.stubEnv('JOB_RUNNER', 'off');
    const { jobId } = await add(A, AI);
    await withCompany(A.companyId, () => prisma.job.updateMany({ where: { id: jobId }, data: { runAfter: new Date(Date.now() + 60_000) } }));
    start();
    await sleep(200);
    expect((await row(A, jobId)).status).toBe('QUEUED');
  });

  it('kalıcı hata FAILED (AppError alanları, işin dilinde); bilinmeyen hata INTERNAL ve isteğin dilinde', async () => {
    handle(AI, async () => {
      throw new AppError(409, 'PREVIEW_STALE', m('job.active'), { token: 'x' });
    });
    handle(AI2, async () => {
      throw new TypeError('beklenmeyen');
    });
    const stale = await add(A, AI, { input: { locale: 'en' } });
    const boom = await add(A, AI2);
    await kickJob(stale.jobId);
    await kickJob(boom.jobId);
    expect((await get(A, stale.jobId, 'tr')).json()).toMatchObject({
      status: 'FAILED',
      error: { statusCode: 409, code: 'PREVIEW_STALE', message: 'This is already running.', details: { token: 'x' } },
    });
    const view = (await get(A, boom.jobId, 'en')).json();
    expect(view).toMatchObject({ status: 'FAILED', attempt: 1, error: { statusCode: 500, code: 'INTERNAL', message: m('job.internal', undefined, 'en') } });
    expect(view.result).toBeUndefined();
    // yapay zekâ hatası kendiliğinden yeniden denenmez
    expect((await row(A, stale.jobId)).attempts).toBe(1);
  });

  it('deneme hakkı bitince JOB_ABANDONED (iletisi isteğin dilinde), temizlik kancası; kirası geçerli iş dokunulmaz', async () => {
    const cleaned: string[] = [];
    override(AI, { cleanup: async (job, outcome) => void cleaned.push(`${job.id}:${outcome}`) });
    vi.stubEnv('JOB_RUNNER', 'off');
    const queued = await add(A, AI);
    const dead = await add(B, AI);
    const alive = await add(A, AI2);
    await jobsScopeUpdate(queued.jobId, { attempts: 5 });
    await jobsScopeUpdate(dead.jobId, { status: 'RUNNING', attempts: 5, lockedBy: 'dead/x', lockedUntil: new Date(Date.now() - 1000) });
    await jobsScopeUpdate(alive.jobId, { status: 'RUNNING', attempts: 5, lockedBy: 'alive/x', lockedUntil: new Date(Date.now() + 60_000) });
    expect(await sweepAbandonedJobs(silent)).toBe(2);
    for (const [c, id] of [[A, queued.jobId] as const, [B, dead.jobId] as const]) {
      const r = await row(c, id);
      expect(r).toMatchObject({ status: 'FAILED', lockedBy: null, error: { code: 'JOB_ABANDONED', messageKey: 'job.abandoned' } });
      expect(r.finishedAt).not.toBeNull();
    }
    expect((await row(A, alive.jobId)).status).toBe('RUNNING');
    expect(cleaned.sort()).toEqual([`${dead.jobId}:FAILED`, `${queued.jobId}:FAILED`].sort());
    expect((await get(A, queued.jobId, 'en')).json().error).toEqual({ statusCode: 500, code: 'JOB_ABANDONED', message: m('job.abandoned', undefined, 'en') });
    expect((await get(A, queued.jobId, 'tr')).json().error.message).toBe(m('job.abandoned', undefined, 'tr'));
    // döngü de aynı turda işaretler ve hakkı biten işi çalıştırmaz
    let ran = false;
    handle(AI, async () => {
      ran = true;
      return {};
    });
    const more = await add(A, AI);
    await jobsScopeUpdate(more.jobId, { attempts: 5 });
    start();
    await until(async () => (await row(A, more.jobId)).status === 'FAILED', 3000, 'döngü işaretlemesi');
    expect(ran).toBe(false);
  });

  it('son denemedeki geçici hata doğrudan JOB_ABANDONED', async () => {
    handle(AI, async () => {
      throw new AppError(503, 'FILE_BUSY', 'meşgul');
    });
    const { jobId } = await add(A, AI);
    await withCompany(A.companyId, () => prisma.job.updateMany({ where: { id: jobId }, data: { attempts: 4 } }));
    await kickJob(jobId);
    expect(await row(A, jobId)).toMatchObject({ status: 'FAILED', attempts: 5, error: { code: 'JOB_ABANDONED' } });
  });

  // ---------- uçlar, izin, firma ----------

  it("A firmasının işi B'ye 404 (görme, durdurma); B'nin listesinde yok", async () => {
    vi.stubEnv('JOB_RUNNER', 'off');
    const { jobId } = await add(A, AI);
    expect((await get(A, jobId)).statusCode).toBe(200);
    const seen = await get(B, jobId);
    expect(seen.statusCode).toBe(404);
    expect(seen.json().error).toMatchObject({ code: 'NOT_FOUND', message: m('job.notFound', undefined, 'tr') });
    expect((await cancel(B, jobId)).statusCode).toBe(404);
    expect((await row(A, jobId)).status).toBe('QUEUED');
    const list = await app.inject({ method: 'GET', url: `${API}/jobs`, headers: B.auth });
    expect(list.json().items.map((j: { id: string }) => j.id)).not.toContain(jobId);
    expect((await get(A, crypto.randomUUID())).statusCode).toBe(404);
  });

  it('Y86: işin firması değiştirilemez (iş kapsamı, tablo sahibi); aynı değer ve diğer sütunlar yazılır', async () => {
    vi.stubEnv('JOB_RUNNER', 'off');
    const { jobId } = await add(A, AI);
    const stored = async () => (await sup.query<{ companyId: string; stage: string | null }>(`SELECT "companyId", "stage" FROM "Job" WHERE id = $1`, [jobId])).rows[0]!;
    // iş kapsamının güncelleme ilkesi firmaya bakmaz: son güvence tetikleyici
    await expect(jobsScopeUpdate(jobId, { companyId: B.companyId })).rejects.toThrow();
    await expect(sup.query(`UPDATE "Job" SET "companyId" = $2 WHERE id = $1`, [jobId, B.companyId])).rejects.toMatchObject({ code: '23514' });
    expect(await stored()).toMatchObject({ companyId: A.companyId, stage: null });
    expect((await jobsScopeUpdate(jobId, { companyId: A.companyId, stage: 'y86' })).count).toBe(1);
    expect(await stored()).toMatchObject({ companyId: A.companyId, stage: 'y86' });
    expect((await row(A, jobId)).status).toBe('QUEUED');
  });

  it('türün izni yoksa 404: ayar kapsamlı toplu hesap ayar izni ister; izinsiz rol /jobs 403', async () => {
    vi.stubEnv('JOB_RUNNER', 'off');
    const auditor = await createMember(app, A.auth, 'AUDITOR', 'Denetleyici Test');
    const measure = await createMember(app, A.auth, 'MEASURE', 'Ölçüm Test');
    const settingsJob = await add(A, RECALC, { input: { scope: 'settings' }, ref: { type: 'Company', id: A.companyId } });
    const tariffJob = await add(A, RECALC, { input: { scope: 'tariff' }, ref: { type: 'Tariff', id: 't1' } });
    expect((await get(A, settingsJob.jobId)).statusCode).toBe(200);
    expect((await get(auditor, settingsJob.jobId)).statusCode).toBe(404);
    expect((await cancel(auditor, settingsJob.jobId)).statusCode).toBe(404);
    expect((await get(auditor, tariffJob.jobId)).statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: `${API}/jobs?kind=${RECALC}`, headers: auditor.auth });
    const ids = list.json().items.map((j: { id: string }) => j.id);
    expect(ids).toContain(tariffJob.jobId);
    expect(ids).not.toContain(settingsJob.jobId);
    expect((await app.inject({ method: 'GET', url: `${API}/jobs`, headers: measure.auth })).statusCode).toBe(403);
    expect((await get(measure, tariffJob.jobId)).statusCode).toBe(403);
    expect((await row(A, settingsJob.jobId)).status).toBe('QUEUED');
  });

  it('fiyat izni olmayana result içindeki tutar gitmez (tek iş ve liste)', async () => {
    handle(RECALC, async () => ({ invoices: 3, overchargeTotal: 12.5, lines: [{ trackingNo: 'T1', billedAmount: 40 }] }));
    const { jobId } = await add(A, RECALC, { input: { scope: 'tariff' } });
    await kickJob(jobId);
    expect((await get(A, jobId)).json().result).toEqual({ invoices: 3, overchargeTotal: 12.5, lines: [{ trackingNo: 'T1', billedAmount: 40 }] });
    flags.hidePrices = true;
    const res = await get(A, jobId);
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toEqual({ invoices: 3, lines: [{ trackingNo: 'T1' }] });
    expect(findMoneyKeys(res.json())).toEqual([]);
    const list = await app.inject({ method: 'GET', url: `${API}/jobs`, headers: A.auth });
    expect(findMoneyKeys(list.json())).toEqual([]);
  });

  it('GET /jobs: süzgeçler (active, kind, refType/refId, mine), en yeniden eskiye, result yok, en çok 20', async () => {
    vi.stubEnv('JOB_RUNNER', 'off');
    const C = await registerCompany(app, uniq('İş liste '));
    const other = await createMember(app, C.auth, 'AUDITOR', 'İkinci Üye');
    const fileRef = { type: 'File' as const, id: crypto.randomUUID() };
    const a1 = await add(C, AI, { ref: fileRef });
    handle(AI2, async () => ({ big: 'x' }));
    await sleep(5);
    const done = await add(C, AI2);
    vi.stubEnv('JOB_RUNNER', 'inline');
    await kickJob(done.jobId);
    vi.stubEnv('JOB_RUNNER', 'off');
    await sleep(5);
    const byOther = await enqueueJob({ companyId: C.companyId, createdById: other.userId, kind: AI, dedupeKey: uniq('o:'), input: {} });

    const list = async (qs: string) => {
      const res = await app.inject({ method: 'GET', url: `${API}/jobs${qs}`, headers: C.auth });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json().items as { id: string; result?: unknown; status: string }[]);
    };
    const all = await list('');
    expect(all.map((j) => j.id)).toEqual([byOther.jobId, done.jobId, a1.jobId]);
    expect(all.every((j) => j.result === undefined)).toBe(true);
    expect((await list('?active=1')).map((j) => j.id)).toEqual([byOther.jobId, a1.jobId]);
    expect((await list(`?kind=${AI2}`)).map((j) => j.id)).toEqual([done.jobId]);
    expect((await list(`?refType=File&refId=${fileRef.id}`)).map((j) => j.id)).toEqual([a1.jobId]);
    expect((await list('?mine=1')).map((j) => j.id)).toEqual([done.jobId, a1.jobId]);
    expect((await app.inject({ method: 'GET', url: `${API}/jobs?kind=NOPE`, headers: C.auth })).statusCode).toBe(400);

    for (let i = 0; i < 22; i++) await add(C, AI);
    expect(await list('')).toHaveLength(20);
  });

  // ---------- bakım ----------

  it('cleanupFinishedJobs: 7 günden eski biten işler silinir; taze ve süren iş kalır; süre göçle aynı', async () => {
    vi.stubEnv('JOB_RUNNER', 'off');
    const DAY = 24 * 3_600_000;
    const sql = fs.readFileSync(path.resolve(import.meta.dirname, '../prisma/migrations/20261114120000_jobs_files/migration.sql'), 'utf8');
    expect(sql).toContain(`"finishedAt" < (now() AT TIME ZONE 'UTC') - interval '7 days'`);
    expect(JOB_RETENTION_MS).toBe(7 * DAY);

    const oldJob = await add(A, AI);
    const freshJob = await add(A, AI2);
    const active = await add(B, AI);
    await withCompany(A.companyId, async () => {
      await prisma.job.updateMany({ where: { id: oldJob.jobId }, data: { status: 'SUCCEEDED', finishedAt: new Date(Date.now() - 8 * DAY) } });
      await prisma.job.updateMany({ where: { id: freshJob.jobId }, data: { status: 'FAILED', finishedAt: new Date(Date.now() - 6 * DAY) } });
    });
    expect(await cleanupFinishedJobs()).toBeGreaterThanOrEqual(1);
    expect(await findJob(A.companyId, oldJob.jobId)).toBeNull();
    expect(await findJob(A.companyId, freshJob.jobId)).not.toBeNull();
    expect(await findJob(B.companyId, active.jobId)).not.toBeNull();
  });

  // ---------- zamanlayıcılar ----------

  it('stop() sonrası çalıştırıcının açık zamanlayıcısı kalmaz; hepsi unref', async () => {
    type Tracked = { kind: 'timeout' | 'interval'; handle: NodeJS.Timeout; cleared: boolean; fired: boolean };
    const tracked: Tracked[] = [];
    const real = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, clearTimeout: globalThis.clearTimeout, clearInterval: globalThis.clearInterval };
    // Yalnız doğrudan runner.ts'in kurduğu zamanlayıcılar (veritabanı sürücüsünün iç zamanlayıcıları değil)
    const fromRunner = () => {
      const caller = (new Error().stack ?? '').split('\n').slice(1).find((l) => !l.includes('jobs.test.ts'));
      return !!caller && /services[\\/]jobs[\\/]runner\.ts/.test(caller);
    };
    const find = (h: unknown) => tracked.find((t) => t.handle === h);
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const t: Tracked | null = fromRunner() ? { kind: 'timeout', handle: null as unknown as NodeJS.Timeout, cleared: false, fired: false } : null;
      const h = real.setTimeout(
        (...a: unknown[]) => {
          if (t) t.fired = true;
          fn(...a);
        },
        ms,
        ...args,
      );
      if (t) tracked.push(Object.assign(t, { handle: h }));
      return h;
    }) as typeof setTimeout;
    globalThis.setInterval = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const h = real.setInterval(fn, ms, ...args);
      if (fromRunner()) tracked.push({ kind: 'interval', handle: h, cleared: false, fired: false });
      return h;
    }) as typeof setInterval;
    globalThis.clearTimeout = ((h?: NodeJS.Timeout) => {
      const t = find(h);
      if (t) t.cleared = true;
      real.clearTimeout(h);
    }) as typeof clearTimeout;
    globalThis.clearInterval = ((h?: NodeJS.Timeout) => {
      const t = find(h);
      if (t) t.cleared = true;
      real.clearInterval(h);
    }) as typeof clearInterval;
    try {
      const started = gate();
      handle(AI, async (ctx) => {
        if (ctx.job.companyId === B.companyId) {
          started.open();
          await aborted(ctx.signal); // kapanışta bırakılır
        }
        return {};
      });
      vi.stubEnv('JOB_RUNNER', 'off');
      const quick = await add(A, AI);
      await add(B, AI);
      const runner = start({ leaseMs: 200, graceMs: 100, slots: { ai: 2, recalc: 1 } });
      await started.p;
      await until(async () => (await row(A, quick.jobId)).status === 'SUCCEEDED', 3000, 'hızlı iş');
      await runner.stop();
      runners.splice(runners.indexOf(runner), 1);
      await sleep(50);
    } finally {
      Object.assign(globalThis, real);
    }
    expect(tracked.some((t) => t.kind === 'interval')).toBe(true); // kalp atışı izlendi
    expect(tracked.every((t) => t.handle.hasRef() === false)).toBe(true);
    const open = tracked.filter((t) => !t.cleared && !(t.kind === 'timeout' && t.fired));
    expect(open).toEqual([]);
  });
  // ---------- R0 bulguları ----------

  it('durdurma yetkisi: yalnız başlatan üye ya da ayar yöneticisi; başka üyeye 404, iş sürer, temizlik çalışmaz', async () => {
    const owner = await createMember(app, A.auth, 'AUDITOR', 'Başlatan Üye');
    const other = await createMember(app, A.auth, 'AUDITOR', 'Başka Üye');
    const cleaned: string[] = [];
    const started = gate();
    handle(
      AI,
      async (ctx) => {
        started.open();
        await aborted(ctx.signal);
        throw new JobCancelled({ by: 'signal' });
      },
      { cleanup: async (job, outcome) => void cleaned.push(`${job.id}:${outcome}`) },
    );
    vi.stubEnv('JOB_RUNNER', 'off');
    const mine = (dedupeKey = uniq('own:')) => enqueueJob({ companyId: A.companyId, createdById: owner.userId, kind: AI, dedupeKey, input: { locale: 'tr' } });

    // kuyruktaki iş
    const queued = await mine();
    expect((await get(other, queued.jobId)).json()).toMatchObject({ status: 'QUEUED', cancellable: false });
    expect((await get(owner, queued.jobId)).json().cancellable).toBe(true);
    expect((await get(A, queued.jobId)).json().cancellable).toBe(true); // yönetici (settings.manage)
    const listed = await app.inject({ method: 'GET', url: `${API}/jobs?active=1`, headers: other.auth });
    expect(listed.json().items.find((j: { id: string }) => j.id === queued.jobId)).toMatchObject({ cancellable: false });
    const denied = await cancel(other, queued.jobId);
    expect(denied.statusCode).toBe(404);
    expect(denied.json().error.code).toBe('NOT_FOUND');
    expect(await row(A, queued.jobId)).toMatchObject({ status: 'QUEUED', cancelRequestedAt: null });
    expect(cleaned).toEqual([]);
    // yönetici başkasının işini durdurur
    const byAdmin = await cancel(A, queued.jobId);
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);
    expect(byAdmin.json().status).toBe('CANCELLED');
    expect(cleaned).toEqual([`${queued.jobId}:CANCELLED`]);

    // süren iş: başka üyenin isteği sinyali kesmez
    const running = await mine();
    start({ leaseMs: 300 });
    await started.p;
    expect((await cancel(other, running.jobId)).statusCode).toBe(404);
    await sleep(200); // en az bir kalp atışı
    expect(await row(A, running.jobId)).toMatchObject({ status: 'RUNNING', cancelRequestedAt: null });
    // başlatan üye durdurur
    const byOwner = await cancel(owner, running.jobId);
    expect(byOwner.statusCode, byOwner.body).toBe(200);
    await until(async () => (await row(A, running.jobId)).status === 'CANCELLED', 3000, 'durdurma');
    expect(cleaned).toEqual([`${queued.jobId}:CANCELLED`, `${running.jobId}:CANCELLED`]);
  });

  it('en uzun çalışma süresi: dönmeyen işleyici bırakılır, iş kuyruğa döner (JOB_TIMEOUT), grup açılır', async () => {
    let reason: unknown;
    handle(
      AI,
      async (ctx) => {
        ctx.signal.addEventListener('abort', () => (reason = ctx.signal.reason), { once: true });
        return new Promise(() => undefined); // hiç dönmez, sinyale uymaz
      },
      { maxRunMs: 150 },
    );
    handle(AI2, async () => ({ next: true }));
    vi.stubEnv('JOB_RUNNER', 'off');
    const stuck = await add(A, AI);
    start({ leaseMs: 2000, slots: { ai: 1, recalc: 1 } });
    // Tek okuma: iki ayrı okuma yarışır (ilki alınmadan önceki QUEUED'ı, ikincisi alındıktan sonraki attempts=1'i görebilir).
    await until(async () => {
      const cur = await row(A, stuck.jobId);
      return cur.status === 'QUEUED' && cur.attempts === 1;
    }, 3000, 'süre aşımı');
    const r = await row(A, stuck.jobId);
    expect(r).toMatchObject({ lockedBy: null, lockedUntil: null, error: { code: 'JOB_TIMEOUT', statusCode: 503 }, finishedAt: null });
    expect(r.runAfter.getTime() - r.updatedAt.getTime()).toBe(10_000);
    expect((reason as JobAbort).cause).toBe('timeout');
    // tek yuvalı grup ve aynı firma: takılan işleyici yuvayı tutmuyor, sıradaki iş çalışır
    const next = await add(A, AI2);
    await until(async () => (await row(A, next.jobId)).status === 'SUCCEEDED', 3000, 'sıradaki iş');
  });

  it('en uzun çalışma süresi: hakkı biten iş FAILED (JOB_ABANDONED); temizlik işleyici dönünce', async () => {
    const order: string[] = [];
    handle(
      AI,
      async () => {
        await sleep(400); // sinyale uymaz, süreyi aşar
        order.push('handler');
        return { late: true };
      },
      { maxRunMs: 100, cleanup: async (_job, outcome) => void order.push(`cleanup:${outcome}`) },
    );
    vi.stubEnv('JOB_RUNNER', 'off');
    const { jobId } = await add(A, AI);
    await withCompany(A.companyId, () => prisma.job.updateMany({ where: { id: jobId }, data: { attempts: 4 } }));
    start();
    await until(async () => (await row(A, jobId)).status === 'FAILED', 3000, 'süre aşımı');
    expect(await row(A, jobId)).toMatchObject({ attempts: 5, result: null, error: { code: 'JOB_ABANDONED' } });
    expect(order).toEqual([]); // işleyici sürerken temizlik yok
    await until(() => order.length === 2, 3000, 'temizlik');
    expect(order).toEqual(['handler', 'cleanup:FAILED']);
    expect((await row(A, jobId)).result).toBeNull(); // geç dönen sonuç yazılmadı
  });

  it('sinyale uymayan iş durdurulunca süre dolunca CANCELLED olur, grup açılır; işleyici arkada biter (sonucu yazılmaz)', async () => {
    const started = gate();
    const order: string[] = [];
    handle(
      AI,
      async () => {
        started.open();
        await sleep(500); // süren yapay zekâ çağrısı: kesilmez, sonucu (önbellek) arkada yazılabilir
        order.push('call-finished');
        return { found: 1 };
      },
      { cleanup: async (_job, outcome) => void order.push(`cleanup:${outcome}`) },
    );
    handle(AI2, async () => ({ next: true }));
    vi.stubEnv('JOB_RUNNER', 'off');
    const stuck = await add(A, AI);
    start({ leaseMs: 2000, cancelGraceMs: 150, slots: { ai: 1, recalc: 1 } });
    await started.p;
    const res = await cancel(A, stuck.jobId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'RUNNING', cancelRequested: true });
    await until(async () => (await row(A, stuck.jobId)).status === 'CANCELLED', 2000, 'zorla durdurma');
    expect(order).toEqual([]); // çağrı sürerken CANCELLED görünür
    const r = await row(A, stuck.jobId);
    expect(r).toMatchObject({ lockedBy: null, result: null });
    expect(r.finishedAt).not.toBeNull();
    // grup açıldı
    const next = await add(A, AI2);
    await until(async () => (await row(A, next.jobId)).status === 'SUCCEEDED', 3000, 'sıradaki iş');
    // çağrı arkada bitti; temizlik ondan sonra, iş satırı değişmedi
    await until(() => order.length === 2, 3000, 'çağrının bitişi');
    expect(order).toEqual(['call-finished', 'cleanup:CANCELLED']);
    expect(await row(A, stuck.jobId)).toMatchObject({ status: 'CANCELLED', result: null });
  });

  it('ardışık kapanışlar sonsuz geri sayım yapmaz: iş başına en çok 2 kez', async () => {
    handle(AI, async (ctx) => {
      await aborted(ctx.signal);
      return {};
    });
    vi.stubEnv('JOB_RUNNER', 'off');
    const { jobId } = await add(A, AI);
    const after: number[] = [];
    for (let i = 0; i < 4; i++) {
      const runner = start({ graceMs: 30 });
      await until(async () => (await row(A, jobId)).status === 'RUNNING', 3000, `sahiplenme ${i + 1}`);
      await runner.stop();
      const r = await row(A, jobId);
      expect(r.status).toBe('QUEUED');
      after.push(r.attempts);
    }
    expect(after).toEqual([0, 0, 1, 2]);
    // Y89: sayaç kendi sütununda; geçiş için `error` içine de yazılır (eski sürüm onu okur)
    expect((await row(A, jobId)).releases).toBe(4);
    expect((await row(A, jobId)).error).toMatchObject({ code: 'JOB_RELEASED', details: { releases: 4 } });
    // bitmemiş işte bu iç sayaç ekrana çıkmaz
    expect((await get(A, jobId)).json().error).toBeUndefined();
  });

  it('Y89 geçiş: eski sürümün `error` içindeki sayacı da sayılır; geçici hata yazımı sütundaki sayacı sıfırlamaz', async () => {
    handle(AI, async (ctx) => {
      await aborted(ctx.signal);
      return {};
    });
    vi.stubEnv('JOB_RUNNER', 'off');
    // A: eski sürüm iki kez bırakmış (sayaç yalnız `error`'da, sütun göçün varsayılanı 0)
    const legacy = await add(A, AI);
    await withCompany(A.companyId, () =>
      prisma.job.updateMany({
        where: { id: legacy.jobId },
        data: { error: { statusCode: 503, code: 'JOB_RELEASED', message: 'released at shutdown', details: { releases: 2 } } },
      }),
    );
    // B: yeni sürüm iki kez bırakmış, ardından geçici hata `error`'u ezmiş (eski düzende sayaç burada sıfırlanırdı)
    const mixed = await add(B, AI);
    await withCompany(B.companyId, () =>
      prisma.job.updateMany({ where: { id: mixed.jobId }, data: { releases: 2, error: { statusCode: 503, code: 'TRANSIENT', message: 'geçici' } } }),
    );
    const runner = start({ graceMs: 30, slots: { ai: 2, recalc: 1 } });
    await until(async () => (await row(A, legacy.jobId)).status === 'RUNNING' && (await row(B, mixed.jobId)).status === 'RUNNING', 3000, 'sahiplenme');
    await runner.stop();
    // ikisinde de hak dolmuştu (2 = MAX_SHUTDOWN_REFUNDS): deneme geri sayılmaz, sayaç 3 olur, iki yere de yazılır
    for (const [c, id] of [[A, legacy.jobId], [B, mixed.jobId]] as const) {
      const r = await row(c, id);
      expect(r).toMatchObject({ status: 'QUEUED', attempts: 1, releases: 3 });
      expect(r.error).toMatchObject({ code: 'JOB_RELEASED', details: { releases: 3 } });
    }
  });

  it('üretimde JOB_RUNNER=inline reddedilir', () => {
    const full = { NODE_ENV: 'production', DATABASE_URL: 'x', ACCOUNT_JWKS_URL: 'x', ALLOWED_ORIGINS: 'x', FILE_TOKEN_SECRET: 'x', APP_BASE_URL: 'https://app.example.test' };
    expect(missingProductionEnv(full)).toEqual([]);
    expect(missingProductionEnv({ ...full, JOB_RUNNER: 'on' })).toEqual([]);
    expect(missingProductionEnv({ ...full, JOB_RUNNER: 'off' })).toEqual([]);
    expect(missingProductionEnv({ ...full, JOB_RUNNER: ' Inline ' })).toEqual(['JOB_RUNNER (inline üretimde kapalı olmalı)']);
    expect(missingProductionEnv({ NODE_ENV: 'test', JOB_RUNNER: 'inline' })).toEqual([]);
  });

  it('istek içinden wake(): döngü ve iş isteğin bağlamını devralmaz', async () => {
    const probe = new AsyncLocalStorage<string>();
    let seen: string | undefined = 'unset';
    handle(AI, async () => {
      seen = probe.getStore();
      return {};
    });
    vi.stubEnv('JOB_RUNNER', 'off');
    const runner = start({ pollMs: 60_000 });
    await sleep(50); // ilk tur boş geçti, sıradaki yoklama bir dakika sonra
    const { jobId } = await add(A, AI);
    probe.run('istek', () => runner.wake());
    await until(async () => (await row(A, jobId)).status === 'SUCCEEDED', 3000, 'uyandırma');
    expect(seen).toBeUndefined();
  });
});
