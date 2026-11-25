/**
 * Mesaj 7 P5 (plan §4.10, §4.11, §5 "P5"): toplu yeniden hesap arka plan işi ve ölçüm karşılaştırmasının yanıttan sonra
 * yapılması.
 *  - `POST /tariffs/:id/recompare-invoices[/preview]?async=1`, `POST /settings/recompare-invoices[/preview]?async=1` → 202
 *    `{ job, joined }`; iş `services/jobs/handlers/bulkRecompare.ts`, yazım hâlâ yalnız `applyRecompare`.
 *  - Kira kaybı ve devralma: kaldığı yerden sürer, hiçbir fatura iki kez yazılmaz (denetim kaydı = fatura).
 *  - Mesaj 4 kuralları: `all` kipinde karar verilmiş satır kararıyla yazılır; etkin itirazlı (donmuş satırlı) fatura bütünüyle
 *    atlanır, iş sürerken itiraza giren de; bayat özet hiçbir şey yazmaz; durdurmada yazılanlar kalır.
 *  - Ölçüm: `JOB_RUNNER=on` iken kayıt karşılaştırmayı beklemez, işaret sonra boşalır; düşerse işaret kalır, bakım tamamlar.
 *
 * Testler satır içi kipte koşar (`vitest.config.ts`); çalıştırıcı döngüsü açılmaz. Kira kaybı ve iş ortasındaki olaylar
 * gerçek işleyiciyi saran test işleyicisiyle kurulur (`overrideJobKindForTest`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => ({ hidePrices: false }));
// Bugünkü rollerde toplu hesap izni olan herkes fiyat da görüyor: fiyat izni olmayan kişiyi `can` üzerinden taklit ederiz.
vi.mock('../src/lib/access.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/lib/access.ts')>();
  return {
    ...mod,
    can: (req: Parameters<typeof mod.can>[0], p: Parameters<typeof mod.can>[1]) =>
      flags.hidePrices && p === 'deciship.prices.view' ? false : mod.can(req, p),
  };
});

import pg from 'pg';
import { prisma, withCompany, withJobScope } from '../src/db.ts';
import { recompareInvoice } from '../src/services/compare.ts';
import { FxService, setFxService, tcmbUrl, type FxFetcher } from '../src/services/fx.ts';
import { bulkApplyCleanup, bulkApplyHandler, bulkPreviewHandler } from '../src/services/jobs/handlers/bulkRecompare.ts';
import { findJob, kickJob } from '../src/services/jobs/queue.ts';
import { overrideJobKindForTest } from '../src/services/jobs/registry.ts';
import { closeInlineJobs, runJobInline, startJobRunner, type JobRunner } from '../src/services/jobs/runner.ts';
import { viaJob } from './jobHelpers.ts';
import type { ClaimedJob, JobContext, JobKindSpec } from '../src/services/jobs/types.ts';
import { RECOMPARE_STALE_MS, runMaintenance } from '../src/services/maintenance.ts';
import { drainMeasurementQueue, measurementQueueState, startMeasurementSweep } from '../src/services/measurementQueue.ts';
import { digestOf, trDay } from './disputeHelpers.ts';
import { createMember, createWorker, findMoneyKeys, getApp, inCompany, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';
import { testSuperDbUrl } from './testEnv.ts';

const API = '/api/deciship';
type Auth = { authorization: string };
const APPLY = 'BULK_RECOMPARE_APPLY' as const;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => Promise<boolean> | boolean, timeoutMs = 8000, label = 'koşul') {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(20);
  }
  throw new Error(`${label} ${timeoutMs} ms içinde gerçekleşmedi`);
}

const trackingNo = () => `7948${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;

/** Desi başına `perKg` TL; yakıt ve ek ücret yok: 3 desi → 3 × perKg. */
const tariffOf = (carrierId: string, perKg: number, over: Record<string, unknown> = {}) => ({
  carrierId,
  name: 'Sabit',
  currency: 'TRY',
  divisor: 3000,
  edgeRounding: 'CEIL_CM',
  weightSteps: [{ upto: null, step: 1 }],
  discountPct: 0,
  fuelPct: 0,
  active: true,
  isDefault: true,
  zones: [{ country: '*', zone: 'TR' }],
  rates: Array.from({ length: 30 }, (_, i) => ({ zone: 'TR', weightUpto: i + 1, price: (i + 1) * perKg })),
  overflow: [],
  surcharges: [],
  ...over,
});

type Firm = { app: FastifyInstance; auth: Auth; worker: Auth; companyId: string; carrierId: string; tariffId: string };

async function firm(app: FastifyInstance): Promise<Firm> {
  const admin = await registerCompany(app, uniq('Toplu iş '));
  const worker = await createWorker(app, admin.auth);
  const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'aras', name: uniq('Aras ') } });
  expect(c.statusCode, c.body).toBe(201);
  const carrierId = c.json().carrier.id as string;
  const t = await app.inject({ method: 'POST', url: `${API}/tariffs`, headers: admin.auth, payload: tariffOf(carrierId, 10) });
  expect(t.statusCode, t.body).toBe(201);
  return { app, auth: admin.auth, worker: worker.auth, companyId: admin.companyId, carrierId, tariffId: t.json().tariff.id as string };
}

const putTariff = async (f: Firm, perKg: number) => {
  const r = await f.app.inject({ method: 'PUT', url: `${API}/tariffs/${f.tariffId}`, headers: f.auth, payload: tariffOf(f.carrierId, perKg) });
  expect(r.statusCode, r.body).toBe(200);
};

/** 30×20×15 cm, 2 kg = 3 desi. */
async function measure(f: Firm, tracking: string) {
  const p = measurementPayload({ trackingRaw: tracking, lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
  const r = await f.app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...f.worker, ...p.headers }, payload: p.payload });
  expect(r.statusCode, r.body).toBe(201);
}

/** Düzeltme: 26×25×16 → 4 desi (satır ölçüm karşılaştırmasıyla yeniden yazılır). */
async function correct(f: Firm, tracking: string) {
  const head = await inCompany(f.auth, () => prisma.measurement.findFirstOrThrow({ where: { trackingNo: tracking, supersededById: null, deletedAt: null } }));
  const r = await f.app.inject({ method: 'PATCH', url: `${API}/measurements/${head.id}`, headers: f.worker, payload: { lengthCm: 26, widthCm: 25, heightCm: 16 } });
  expect(r.statusCode, r.body).toBe(200);
}

/** Ölçülmüş satırlarla fatura (her satır 5 desi, 50 TL): 10 TL/desi tarifeyle beklenen 30, fark 20. */
async function invoice(f: Firm, measured = 1) {
  const tracking = Array.from({ length: measured }, trackingNo);
  for (const t of tracking) await measure(f, t);
  const csv = ['Takip No;Desi;Tutar', ...tracking.map((t) => `${t};5;50`)].join('\n');
  const form = multipart([
    { name: 'carrierId', value: f.carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
  ]);
  const preview = await f.app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...f.auth, ...form.headers }, payload: form.payload });
  expect(preview.statusCode, preview.body).toBe(200);
  const inv = await f.app.inject({
    method: 'POST',
    url: `${API}/invoices`,
    headers: f.auth,
    payload: {
      fileId: preview.json().fileId,
      carrierId: f.carrierId,
      invoiceNo: uniq('F'),
      invoiceDate: '2026-10-15',
      currency: 'TRY',
      mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
      acknowledgeIssues: true,
    },
  });
  expect(inv.statusCode, inv.body).toBe(201);
  const id = inv.json().invoice.id as string;
  await inCompany(f.auth, () => recompareInvoice(id));
  return { id, tracking };
}

const invoiceRow = (f: Firm, id: string) => inCompany(f.auth, () => prisma.invoice.findFirstOrThrow({ where: { id } }));
const lineRows = (f: Firm, invoiceId: string) => inCompany(f.auth, () => prisma.invoiceLine.findMany({ where: { invoiceId }, orderBy: { rowIndex: 'asc' } }));
const money = (l: { status: string; expectedAmount: unknown; diffAmount: unknown }) => [l.status, l.expectedAmount == null ? null : Number(l.expectedAmount), l.diffAmount == null ? null : Number(l.diffAmount)];
const moneyOf = async (f: Firm, id: string) => (await lineRows(f, id)).map(money);
const currentRevision = async (f: Firm) => (await inCompany(f.auth, () => prisma.tariff.findFirstOrThrow({ where: { id: f.tariffId } }))).currentRevisionId;

/** Fatura ve satırları yazıldı mı: değişme anları, dayanak, tutarlar. */
async function fingerprint(f: Firm, id: string) {
  const inv = await invoiceRow(f, id);
  const lines = await lineRows(f, id);
  return {
    invoice: [+inv.updatedAt, inv.tariffRevisionId, JSON.stringify(inv.compareSettings), JSON.stringify(inv.totals), +(inv.calculatedAt ?? 0)],
    lines: lines.map((l) => [l.id, +l.updatedAt, ...money(l), l.tariffRevisionId, l.recalcPending, JSON.stringify(l.prevResult)]),
  };
}

/** K4: atlanan faturanın sonuçtaki kısa kaydı. */
const shortOf = async (f: Firm, id: string) => {
  const inv = await inCompany(f.auth, () => prisma.invoice.findFirstOrThrow({ where: { id }, select: { id: true, invoiceNo: true, carrier: { select: { name: true } } } }));
  return { id: inv.id, invoiceNo: inv.invoiceNo, carrierName: inv.carrier.name };
};

const recalcAudits = async (f: Firm) =>
  (await inCompany(f.auth, () => prisma.auditLog.findMany({ where: { companyId: f.companyId, action: 'invoice.recalculate' }, select: { entityId: true } }))).map((x) => x.entityId!);
const countBy = (ids: string[]) => ids.reduce<Record<string, number>>((acc, id) => ({ ...acc, [id]: (acc[id] ?? 0) + 1 }), {});

const tariffUrl = (f: Firm) => `${API}/tariffs/${f.tariffId}/recompare-invoices`;
const SETTINGS_URL = `${API}/settings/recompare-invoices`;

/**
 * Önizlemenin sonucunu hemen alır. Eski eşzamanlı yol kuyruk kipinden bağımsızdı; Y83'te yol kalkınca önizleme de iş oldu.
 * Testin kuyruğu kapattığı (`JOB_RUNNER=off`) yerde de sonuç gelsin diye bu çağrı satır içi koşar (süren aynı anahtarlı
 * önizlemeye bağlanırsa onu bitirir), ardından testin kipi geri yüklenir.
 */
async function syncPreview(f: Firm, url: string) {
  const mode = process.env.JOB_RUNNER;
  process.env.JOB_RUNNER = 'inline';
  try {
    const r = await viaJob(f.app, { method: 'POST', url: `${url}/preview`, headers: f.auth, payload: {} });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { token: string; changedInvoices: number; skippedInDispute: number; invoices: { id: string }[] };
  } finally {
    if (mode === undefined) delete process.env.JOB_RUNNER;
    else process.env.JOB_RUNNER = mode;
  }
}
const asyncPreview = (f: Firm, url: string, auth: Auth = f.auth) => f.app.inject({ method: 'POST', url: `${url}/preview?async=1`, headers: auth, payload: {} });
const asyncApply = (f: Firm, url: string, token: string, auth: Auth = f.auth) => f.app.inject({ method: 'POST', url: `${url}?async=1`, headers: auth, payload: { token } });
const getJob = (f: Firm, id: string, auth: Auth = f.auth) => f.app.inject({ method: 'GET', url: `${API}/jobs/${id}`, headers: auth });
const jobRow = async (f: Firm, id: string) => (await findJob(f.companyId, id))!;

const restores: (() => void)[] = [];
/** Gerçek uygulama işleyicisini saran test işleyicisi: bağlamın bir parçasını değiştirir. */
const wrapApply = (wrap: (ctx: JobContext) => JobContext) =>
  restores.push(overrideJobKindForTest(APPLY, { handler: async () => async (ctx: JobContext) => bulkApplyHandler(wrap(ctx)) } satisfies Partial<JobKindSpec>));

afterEach(async () => {
  await closeInlineJobs();
  for (const r of restores.splice(0)) r();
  flags.hidePrices = false;
  vi.unstubAllEnvs();
});

describe('toplu yeniden hesap işi', () => {
  it('önizleme ve uygulama iş olarak: 202, sonuç eşzamanlı yolla aynı, aşama ve sayaçlar, denetim kaydı; izin kapsamdan', async () => {
    const app = await getApp();
    const f = await firm(app);
    const one = await invoice(f);
    const two = await invoice(f);
    const rev1 = await currentRevision(f);
    await putTariff(f, 8);
    const rev2 = await currentRevision(f);
    const sync = await syncPreview(f, tariffUrl(f));
    const before = await Promise.all([one, two].map((x) => fingerprint(f, x.id)));

    const pr = await asyncPreview(f, tariffUrl(f));
    expect(pr.statusCode, pr.body).toBe(202);
    const pv = pr.json();
    expect(pv.joined).toBe(false);
    expect(pv.job).toMatchObject({
      kind: 'BULK_RECOMPARE_PREVIEW',
      status: 'SUCCEEDED',
      ref: { type: 'Tariff', id: f.tariffId },
      label: 'Sabit',
      progress: { done: 2, total: 2, stage: 'bulkCheck' },
      attempt: 1,
    });
    // sonuç eşzamanlı önizlemenin aynısı (aynı özet), hiçbir şey yazılmaz
    expect(pv.job.result).toEqual(sync);
    expect(await Promise.all([one, two].map((x) => fingerprint(f, x.id)))).toEqual(before);

    const ar = await asyncApply(f, tariffUrl(f), sync.token);
    expect(ar.statusCode, ar.body).toBe(202);
    const job = ar.json().job;
    expect(job).toMatchObject({ kind: APPLY, status: 'SUCCEEDED', progress: { done: 2, total: 2, stage: 'bulkWrite' } });
    expect(job.result).toEqual({ invoices: 2, lines: 2, skipped: { inDispute: 0, stale: 0 }, stopped: 0 });
    expect(job.counters).toEqual({ invoices: 2, lines: 2, inDispute: 0, stale: 0 });
    expect(pv.job.counters).toBeNull();
    const row = await jobRow(f, job.id);
    expect(row.counters).toEqual({ invoices: 2, lines: 2, inDispute: 0, stale: 0 });
    expect(row.checkpoint).toMatchObject({ v: 1, token: sync.token, planned: [[one.id, expect.any(String)], [two.id, expect.any(String)]], skippedInDispute: 0 });
    for (const inv of [one, two]) {
      expect((await invoiceRow(f, inv.id)).tariffRevisionId).toBe(rev2);
      expect(await moneyOf(f, inv.id)).toEqual([['DIFF', 24, 26]]);
      expect((await lineRows(f, inv.id))[0]!.prevResult).toMatchObject({ expectedAmount: 30, tariffRevisionId: rev1, cause: 'TARIFF' });
    }
    // her fatura için bir kayıt; kapsamın kaydı bugünkü alanlarla, işi başlatanın adıyla
    expect(countBy(await recalcAudits(f))).toEqual({ [one.id]: 1, [two.id]: 1 });
    const scopeLogs = await inCompany(f.auth, () => prisma.auditLog.findMany({ where: { companyId: f.companyId, action: 'tariff.recompare' } }));
    expect(scopeLogs.map((x) => [x.entityId, x.userId, x.data])).toEqual([[f.tariffId, row.createdById, { invoices: 2, lines: 2, skipped: { inDispute: 0, stale: 0 }, jobId: job.id }]]);

    // ayar kapsamı: aynı yol; denetleyici (tarife izni var, ayar izni yok) tarife işini görür, ayar işini görmez
    expect((await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: f.auth, payload: { amountTol: 25 } })).statusCode).toBe(200);
    const sp = await asyncPreview(f, SETTINGS_URL);
    expect(sp.statusCode, sp.body).toBe(202);
    expect(sp.json().job).toMatchObject({ status: 'SUCCEEDED', ref: { type: 'Company', id: f.companyId }, label: null });
    const settingsPreview = sp.json().job.result as { token: string; changedInvoices: number };
    expect(settingsPreview.changedInvoices).toBe(2);
    const sa = await asyncApply(f, SETTINGS_URL, settingsPreview.token);
    expect(sa.statusCode, sa.body).toBe(202);
    expect(sa.json().job).toMatchObject({ status: 'SUCCEEDED', result: { invoices: 2, stopped: 0 } });
    expect(((await invoiceRow(f, one.id)).compareSettings as { amountTol: number }).amountTol).toBe(25);
    const auditor = await createMember(app, f.auth, 'AUDITOR');
    expect((await getJob(f, job.id, auditor.auth)).statusCode).toBe(200);
    expect((await getJob(f, sa.json().job.id, auditor.auth)).statusCode).toBe(404);
    expect((await asyncPreview(f, SETTINGS_URL, auditor.auth)).statusCode).toBe(403);
  });

  it('k. faturadan sonra kira kaybı ve devralma: kalanlar yazılır, hiçbir fatura iki kez yazılmaz; genel özet yeniden denetlenmez, yeni fatura taşınmaz', async () => {
    const app = await getApp();
    const f = await firm(app);
    const a = await invoice(f);
    const b = await invoice(f);
    const c = await invoice(f);
    await putTariff(f, 8);
    const rev2 = await currentRevision(f);
    const p = await syncPreview(f, tariffUrl(f));
    expect(p.invoices.map((i) => i.id)).toEqual([a.id, b.id, c.id]);

    // ilk denemede 2. faturanın yazımı sırasında kira doluyor (çit 0 satır → faturanın işlemi geri alınır)
    wrapApply((ctx) => ({
      ...ctx,
      fence: async (tx, x) => {
        if (ctx.job.attempts === 1 && x.done === 2) {
          await withJobScope(() => prisma.job.updateMany({ where: { id: ctx.job.id }, data: { lockedUntil: new Date(Date.now() - 1000) } }));
        }
        return ctx.fence(tx, x);
      },
    }));
    const r1 = await asyncApply(f, tariffUrl(f), p.token);
    expect(r1.statusCode, r1.body).toBe(202);
    const jobId = r1.json().job.id as string;
    expect(r1.json().job).toMatchObject({ status: 'RUNNING', attempt: 1, progress: { done: 1, total: 3, stage: 'bulkWrite' } });
    const lost = await jobRow(f, jobId);
    expect(lost).toMatchObject({ status: 'RUNNING', progressDone: 1, counters: { invoices: 1, lines: 1, inDispute: 0, stale: 0 }, result: null });
    expect((await invoiceRow(f, a.id)).tariffRevisionId).toBe(rev2);
    expect((await invoiceRow(f, b.id)).tariffRevisionId).not.toBe(rev2);
    const aAfterFirst = await fingerprint(f, a.id);

    // denemeler arasında: c'nin ölçümü düzeltilir (c'nin kendi özeti bozulur; genel özet de artık tutmaz) ve dayanağı
    // yazılmamış yeni bir fatura kapsama girer
    await correct(f, c.tracking[0]!);
    const d = await invoice(f);
    await inCompany(f.auth, () => prisma.invoice.update({ where: { id: d.id }, data: { tariffRevisionId: null } }));
    const dBefore = await fingerprint(f, d.id);
    const cBefore = await fingerprint(f, c.id);

    // devralma: yeni sahiplenme kaldığı yerden sürer
    await kickJob(jobId);
    const done = await jobRow(f, jobId);
    expect(done).toMatchObject({ status: 'SUCCEEDED', attempts: 2, progressDone: 3 });
    // c (bayat) ve d (sonradan kapsama girdi) hâlâ eski dayanakta: `remaining` (yeni önizleme onları gösterir)
    expect(done.result).toEqual({ invoices: 2, lines: 2, skipped: { inDispute: 0, stale: 1 }, stopped: 0, staleInvoices: [await shortOf(f, c.id)], remaining: 2 });
    expect((await getJob(f, jobId)).json()).toMatchObject({ attempt: 2, result: { invoices: 2 } });
    // a ilk denemede yazıldı ve bir daha yazılmadı; b ikincide yazıldı; c bayat, yazılmadı; d plana girmedi
    expect(await fingerprint(f, a.id)).toEqual(aAfterFirst);
    expect((await invoiceRow(f, b.id)).tariffRevisionId).toBe(rev2);
    expect(await fingerprint(f, c.id)).toEqual(cBefore);
    expect(await fingerprint(f, d.id)).toEqual(dBefore);
    // denetim kaydı sayısı = yazılan fatura sayısı; kapsamın kaydı bir kez
    expect(countBy(await recalcAudits(f))).toEqual({ [a.id]: 1, [b.id]: 1 });
    const scopeLogs = await inCompany(f.auth, () => prisma.auditLog.findMany({ where: { companyId: f.companyId, action: 'tariff.recompare' } }));
    expect(scopeLogs.map((x) => x.data)).toEqual([{ invoices: 2, lines: 2, skipped: { inDispute: 0, stale: 1 }, jobId }]);
    // kalan iki fatura yeni önizlemede
    expect((await syncPreview(f, tariffUrl(f))).invoices.map((i) => i.id).sort()).toEqual([c.id, d.id].sort());
  });

  it('karar verilmiş satır kararıyla yazılır (all); iş sürerken itiraza giren fatura atlanır (inDispute), satırlarına dokunulmaz', async () => {
    const app = await getApp();
    const f = await firm(app);
    const decided = await invoice(f, 2);
    const disputed = await invoice(f, 2);
    const free = await invoice(f);
    for (const inv of [decided, disputed]) {
      const [first] = await lineRows(f, inv.id);
      const v = await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${first!.id}`, headers: f.auth, payload: { decision: 'VERIFIED' } });
      expect(v.statusCode, v.body).toBe(200);
    }
    const rev1 = await currentRevision(f);
    await putTariff(f, 8);
    const rev2 = await currentRevision(f);
    const p = await syncPreview(f, tariffUrl(f));
    expect(p).toMatchObject({ changedInvoices: 3, skippedInDispute: 0 });

    // plan doğrulandı, yazım başlamadan: ikinci faturanın itirazı gönderilir
    let sent = 0;
    wrapApply((ctx) => ({
      ...ctx,
      progress: async (x) => {
        if (x.stage === 'bulkWrite' && x.done === 0 && !sent) {
          const r = await app.inject({ method: 'POST', url: `${API}/invoices/${disputed.id}/disputes`, headers: f.auth, payload: { sentOn: trDay(0), channel: 'EMAIL', selectionDigest: await digestOf(app, f.auth, disputed.id) } });
          expect(r.statusCode, r.body).toBe(201);
          sent++;
        }
        return ctx.progress(x);
      },
    }));
    const r = await asyncApply(f, tariffUrl(f), p.token);
    expect(r.statusCode, r.body).toBe(202);
    expect(sent).toBe(1);
    expect(r.json().job).toMatchObject({ status: 'SUCCEEDED', result: { invoices: 2, lines: 3, skipped: { inDispute: 1, stale: 0 }, stopped: 0 } });
    expect((await jobRow(f, r.json().job.id)).counters).toEqual({ invoices: 2, lines: 3, inDispute: 1, stale: 0 });

    // SPEC §3 (`all` kipi): karar verilmiş satır da yeni sürümle yazılır, kararı değişmez. Donmuş (etkin itirazdaki) satır
    // toplu geçişte hiç yazılmaz: itirazlı fatura bütünüyle atlanır (aşağıda).
    const [kept, open] = await lineRows(f, decided.id);
    expect([...money(kept!), kept!.decision, kept!.recalcPending]).toEqual(['DIFF', 24, 26, 'VERIFIED', null]);
    expect(kept!.prevResult).toMatchObject({ expectedAmount: 30, diffAmount: 20, cause: 'TARIFF' });
    expect([...money(open!), open!.decision, open!.recalcPending]).toEqual(['DIFF', 24, 26, 'OPEN', null]);
    expect((await invoiceRow(f, decided.id)).tariffRevisionId).toBe(rev2);
    // itiraza giren fatura yerinde
    expect(await moneyOf(f, disputed.id)).toEqual([
      ['DIFF', 30, 20],
      ['DIFF', 30, 20],
    ]);
    expect((await invoiceRow(f, disputed.id)).tariffRevisionId).toBe(rev1);
    expect((await lineRows(f, disputed.id)).map((l) => [l.decision, l.recalcPending, l.tariffRevisionId])).toEqual([
      ['VERIFIED', null, rev1],
      ['OPEN', null, rev1],
    ]);
    expect(await moneyOf(f, free.id)).toEqual([['DIFF', 24, 26]]);
    expect(Object.keys(countBy(await recalcAudits(f))).sort()).toEqual([decided.id, free.id].sort());
  });

  it('bayat genel özet: iş FAILED PREVIEW_STALE (409), hiçbir fatura yazılmaz, plan kaydedilmez', async () => {
    const app = await getApp();
    const f = await firm(app);
    const one = await invoice(f);
    await putTariff(f, 8);
    const p = await syncPreview(f, tariffUrl(f));
    await putTariff(f, 9);
    const before = await fingerprint(f, one.id);
    const r = await asyncApply(f, tariffUrl(f), p.token);
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json().job).toMatchObject({ status: 'FAILED', error: { statusCode: 409, code: 'PREVIEW_STALE', message: expect.any(String) } });
    expect(r.json().job.result).toBeUndefined();
    expect(await fingerprint(f, one.id)).toEqual(before);
    expect((await jobRow(f, r.json().job.id)).checkpoint).toBeNull();
    expect(await recalcAudits(f)).toEqual([]);
    // özetsiz istek iş açmadan 400
    expect((await f.app.inject({ method: 'POST', url: `${tariffUrl(f)}?async=1`, headers: f.auth, payload: {} })).statusCode).toBe(400);
  });

  it('durdurma: yazılan fatura yeni hâlinde kalır, kalanlar denenmez; CANCELLED, bölüm sonucu stopped ile', async () => {
    const app = await getApp();
    const f = await firm(app);
    const invs = [await invoice(f), await invoice(f), await invoice(f)];
    await putTariff(f, 8);
    const rev2 = await currentRevision(f);
    const p = await syncPreview(f, tariffUrl(f));
    const rest = await Promise.all(invs.slice(1).map((x) => fingerprint(f, x.id)));

    let cancelStatus = 0;
    wrapApply((ctx) => ({
      ...ctx,
      progress: async (x) => {
        await ctx.progress(x);
        if (x.stage === 'bulkWrite' && x.done === 1 && !cancelStatus) {
          cancelStatus = (await app.inject({ method: 'POST', url: `${API}/jobs/${ctx.job.id}/cancel`, headers: f.auth, payload: {} })).statusCode;
        }
      },
    }));
    const r = await asyncApply(f, tariffUrl(f), p.token);
    expect(r.statusCode, r.body).toBe(202);
    expect(cancelStatus).toBe(200);
    const stopped = { invoices: 1, lines: 1, skipped: { inDispute: 0, stale: 0 }, stopped: 2 };
    expect(r.json().job).toMatchObject({ status: 'CANCELLED', cancelRequested: true, cancellable: false, result: stopped });
    expect((await invoiceRow(f, invs[0]!.id)).tariffRevisionId).toBe(rev2);
    expect(await Promise.all(invs.slice(1).map((x) => fingerprint(f, x.id)))).toEqual(rest);
    expect(await recalcAudits(f)).toEqual([invs[0]!.id]);
    const scopeLogs = await inCompany(f.auth, () => prisma.auditLog.findMany({ where: { companyId: f.companyId, action: 'tariff.recompare' } }));
    expect(scopeLogs.map((x) => x.data)).toEqual([{ invoices: 1, lines: 1, skipped: { inDispute: 0, stale: 0 }, stopped: 2, jobId: r.json().job.id }]);
  });

  it('ikinci "Uygula": aynı özetle süren işe bağlanır (joined), farklı özetle 409 JOB_ACTIVE; önizleme de bağlanır', async () => {
    const app = await getApp();
    const f = await firm(app);
    const one = await invoice(f);
    await putTariff(f, 8);
    const p = await syncPreview(f, tariffUrl(f));

    vi.stubEnv('JOB_RUNNER', 'off');
    const first = await asyncApply(f, tariffUrl(f), p.token);
    expect(first.statusCode, first.body).toBe(202);
    expect(first.json()).toMatchObject({ joined: false, job: { status: 'QUEUED', kind: APPLY, cancellable: true } });
    const id = first.json().job.id as string;
    const again = await asyncApply(f, tariffUrl(f), p.token);
    expect(again.statusCode, again.body).toBe(202);
    expect(again.json()).toMatchObject({ joined: true, job: { id } });
    const other = await asyncApply(f, tariffUrl(f), 'c'.repeat(64));
    expect(other.statusCode, other.body).toBe(409);
    expect(other.json().error).toMatchObject({ code: 'JOB_ACTIVE', message: expect.any(String), details: { job: { id, kind: APPLY, status: 'QUEUED' } } });
    const pv1 = await asyncPreview(f, tariffUrl(f));
    const pv2 = await asyncPreview(f, tariffUrl(f));
    expect([pv1.json().joined, pv2.json().joined, pv2.json().job.id]).toEqual([false, true, pv1.json().job.id]);
    // önizleme işi uygulama işinden ayrı: aynı kapsam anahtarı, farklı tür
    expect(pv1.json().job.id).not.toBe(id);

    vi.stubEnv('JOB_RUNNER', 'inline');
    await kickJob(id);
    await kickJob(pv1.json().job.id);
    expect(await jobRow(f, id)).toMatchObject({ status: 'SUCCEEDED', result: { invoices: 1, stopped: 0 } });
    expect(await moneyOf(f, one.id)).toEqual([['DIFF', 24, 26]]);
    // iş bitti: aynı anahtarla yeni iş açılır (özet artık tutmaz)
    const late = await asyncApply(f, tariffUrl(f), p.token);
    expect(late.json()).toMatchObject({ joined: false, job: { status: 'FAILED', error: { code: 'PREVIEW_STALE' } } });
    expect(countBy(await recalcAudits(f))).toEqual({ [one.id]: 1 });
  });

  it('fiyat izni olmayana iş sonucunda tutar gitmez', async () => {
    const app = await getApp();
    const f = await firm(app);
    await invoice(f);
    await putTariff(f, 8);
    const r = await asyncPreview(f, tariffUrl(f));
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json().job.result.totalsByCurrency[0].before.overchargeTotal).toBe(20);
    flags.hidePrices = true;
    const hidden = await getJob(f, r.json().job.id);
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json().result).toMatchObject({ changedInvoices: 1, skippedInDispute: 0 });
    expect(findMoneyKeys(hidden.json())).toEqual([]);
    const started = await asyncPreview(f, tariffUrl(f));
    expect(findMoneyKeys(started.json())).toEqual([]);
  });

  it('KALANLAR 6.18: kuyrukta beklerken başlatan çıkarıldıysa ya da yetkisi alındıysa önizleme ve uygulama 403 JOB_STARTER_FORBIDDEN ile düşer, hiçbir şey yazılmaz', async () => {
    const app = await getApp();
    const f = await firm(app);
    const one = await invoice(f);
    await putTariff(f, 8);
    const sync = await syncPreview(f, tariffUrl(f));
    const before = await fingerprint(f, one.id);
    vi.stubEnv('JOB_RUNNER', 'off');
    const leaver = await createMember(app, f.auth, 'ADMIN', 'Ayrılan Test');
    const demoted = await createMember(app, f.auth, 'ADMIN', 'Rolü Değişen Test');

    // uygulama: başlatan kuyrukta beklerken çıkarıldı (pasif)
    const ar = await asyncApply(f, tariffUrl(f), sync.token, leaver.auth);
    expect(ar.statusCode, ar.body).toBe(202);
    expect(ar.json().job.status).toBe('QUEUED');
    // önizleme (ayar kapsamı): başlatanın rolü ayar yönetimi izni olmayan role indi
    const sp = await asyncPreview(f, SETTINGS_URL, demoted.auth);
    expect(sp.statusCode, sp.body).toBe(202);
    expect(sp.json().job.status).toBe('QUEUED');
    await inCompany(f.auth, async () => {
      await prisma.member.update({ where: { id: leaver.userId }, data: { active: false } });
      await prisma.$executeRaw`UPDATE "Member" SET "role" = 'AUDITOR', "permissions" = NULL WHERE "id" = ${demoted.userId}`;
    });

    for (const id of [ar.json().job.id as string, sp.json().job.id as string]) {
      expect(await runJobInline(id)).toBe(true);
      const job = (await getJob(f, id)).json();
      expect(job.status, id).toBe('FAILED');
      expect(job.error).toMatchObject({ statusCode: 403, code: 'JOB_STARTER_FORBIDDEN', message: expect.stringContaining('yetkisi kalmadı') });
      expect(job.progress?.done ?? 0).toBe(0);
    }
    // hiçbir fatura yazılmadı, kapsam kaydı ve plan yok
    expect(await fingerprint(f, one.id)).toEqual(before);
    expect(await recalcAudits(f)).toEqual([]);
    expect(await scopeLogsOf(f)).toEqual([]);
    expect((await jobRow(f, ar.json().job.id)).checkpoint).toBeNull();
    expect((await jobRow(f, sp.json().job.id)).checkpoint).toBeNull();
  });
});

// ---------- R2 bulguları: yarım biten uygulamanın kaydı, önizleme anahtarı ----------

const scopeLogsOf = (f: Firm) =>
  inCompany(f.auth, () => prisma.auditLog.findMany({ where: { companyId: f.companyId, action: 'tariff.recompare' }, select: { data: true } })).then((r) => r.map((x) => x.data));
const claimedOf = (row: NonNullable<Awaited<ReturnType<typeof findJob>>>): ClaimedJob => ({
  id: row.id,
  companyId: row.companyId,
  kind: row.kind,
  input: row.input as Record<string, unknown>,
  checkpoint: row.checkpoint,
  attempts: row.attempts,
  createdById: row.createdById,
  createdAt: row.createdAt,
  cancelRequestedAt: row.cancelRequestedAt,
});

describe('toplu uygulama: yarım biten işin sayaçları ve kapsam kaydı (R2-1), önizleme anahtarı (R2-4)', () => {
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const runners: JobRunner[] = [];
  let sup: pg.Client;
  // açık döngü bu dosyanın dışındaki bekleyen işleri almasın (jobs.test.ts ile aynı yol)
  const closeLeftovers = () =>
    sup.query(`UPDATE "Job" SET "status" = 'CANCELLED', "finishedAt" = now() AT TIME ZONE 'UTC', "lockedBy" = NULL, "lockedUntil" = NULL WHERE "status" IN ('QUEUED', 'RUNNING')`);
  beforeAll(async () => {
    sup = new pg.Client({ connectionString: testSuperDbUrl(), options: '-c search_path=deciship' });
    await sup.connect();
  });
  afterEach(async () => {
    await Promise.all(runners.splice(0).map((r) => r.stop()));
  });
  afterAll(async () => {
    await closeLeftovers();
    await sup.end();
  });

  it('zorla durdurma (işleyici çitte asılı): CANCELLED, sayaçlar görünür, kapsam kaydı tam bir kez; asılı fatura yazılmaz', async () => {
    const app = await getApp();
    const f = await firm(app);
    const invs = [await invoice(f), await invoice(f), await invoice(f)];
    await putTariff(f, 8);
    const rev2 = await currentRevision(f);
    const p = await syncPreview(f, tariffUrl(f));
    await closeLeftovers();

    let reached!: () => void;
    const atFence = new Promise<void>((r) => (reached = r));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    wrapApply((ctx) => ({
      ...ctx,
      fence: async (tx, x) => {
        if (x.done === 2) {
          reached();
          await gate; // sinyale bakmayan işleyici: 2. faturanın işlemi açık bekler
        }
        return ctx.fence(tx, x);
      },
    }));
    vi.stubEnv('JOB_RUNNER', 'off');
    const started = await asyncApply(f, tariffUrl(f), p.token);
    expect(started.statusCode, started.body).toBe(202);
    const jobId = started.json().job.id as string;
    runners.push(startJobRunner(silent, { pollMs: 20, leaseMs: 2000, graceMs: 300, cancelGraceMs: 50, slots: { ai: 0, recalc: 1 } }));
    await atFence;
    expect((await f.app.inject({ method: 'POST', url: `${API}/jobs/${jobId}/cancel`, headers: f.auth, payload: {} })).statusCode).toBe(200);
    await until(async () => (await jobRow(f, jobId)).status === 'CANCELLED', 5000, 'zorla durdurma');
    const view = (await getJob(f, jobId)).json();
    expect(view).toMatchObject({ status: 'CANCELLED', counters: { invoices: 1, lines: 1, inDispute: 0, stale: 0 }, progress: { done: 1, total: 3 } });
    expect(view.result).toBeUndefined();

    // asılı işleyici döner: kirası yok, 2. faturanın işlemi geri alınır; temizlik kancası kaydı yazar
    open();
    await until(async () => (await scopeLogsOf(f)).length > 0, 5000, 'kapsam kaydı');
    await sleep(200);
    expect(await scopeLogsOf(f)).toEqual([{ invoices: 1, lines: 1, skipped: { inDispute: 0, stale: 0 }, stopped: 2, jobId }]);
    expect((await invoiceRow(f, invs[0]!.id)).tariffRevisionId).toBe(rev2);
    for (const inv of invs.slice(1)) expect((await invoiceRow(f, inv.id)).tariffRevisionId).not.toBe(rev2);
    expect(await recalcAudits(f)).toEqual([invs[0]!.id]);
    // kanca ikinci kez çağrılsa da kayıt ikilenmez
    const row = await jobRow(f, jobId);
    await withCompany(f.companyId, () => bulkApplyCleanup(claimedOf(row), 'CANCELLED'));
    expect(await scopeLogsOf(f)).toHaveLength(1);
  });

  it('fatura yazdıktan sonra başarısız iş (INTERNAL): FAILED, sayaçlar görünür (fiyat izni olmasa da), kayıt failed işaretiyle bir kez', async () => {
    const app = await getApp();
    const f = await firm(app);
    const invs = [await invoice(f), await invoice(f), await invoice(f)];
    await putTariff(f, 8);
    const p = await syncPreview(f, tariffUrl(f));
    wrapApply((ctx) => ({
      ...ctx,
      fence: async (tx, x) => {
        if (x.done === 2) throw new Error('unexpected failure');
        return ctx.fence(tx, x);
      },
    }));
    const r = await asyncApply(f, tariffUrl(f), p.token);
    expect(r.statusCode, r.body).toBe(202);
    const jobId = r.json().job.id as string;
    expect(r.json().job).toMatchObject({ status: 'FAILED', error: { code: 'INTERNAL' }, counters: { invoices: 1, lines: 1, inDispute: 0, stale: 0 } });
    expect(await scopeLogsOf(f)).toEqual([{ invoices: 1, lines: 1, skipped: { inDispute: 0, stale: 0 }, stopped: 2, failed: true, jobId }]);
    expect(await recalcAudits(f)).toEqual([invs[0]!.id]);
    flags.hidePrices = true;
    expect((await getJob(f, jobId)).json().counters).toEqual({ invoices: 1, lines: 1, inDispute: 0, stale: 0 });
    const list = await f.app.inject({ method: 'GET', url: `${API}/jobs?kind=${APPLY}`, headers: f.auth });
    expect(list.json().items.find((j: { id: string }) => j.id === jobId).counters).toEqual({ invoices: 1, lines: 1, inDispute: 0, stale: 0 });
    await withCompany(f.companyId, async () => bulkApplyCleanup(claimedOf(await jobRow(f, jobId)), 'FAILED'));
    expect(await scopeLogsOf(f)).toHaveLength(1);
  });

  it('kapsam kaydı yazıldıktan sonra bitiş yazımı düşerse sonraki deneme kaydı ikinci kez yazmaz', async () => {
    const app = await getApp();
    const f = await firm(app);
    const invs = [await invoice(f), await invoice(f)];
    await putTariff(f, 8);
    const p = await syncPreview(f, tariffUrl(f));
    restores.push(
      overrideJobKindForTest(APPLY, {
        handler: async () => async (ctx: JobContext) => {
          const out = await bulkApplyHandler(ctx);
          // ilk deneme: kayıt yazıldı, bitiş yazımından hemen önce kira el değiştirdi (bitiş 0 satır, sonuç atılır)
          if (ctx.job.attempts === 1) await withJobScope(() => prisma.job.updateMany({ where: { id: ctx.job.id }, data: { lockedBy: 'thief/x', lockedUntil: new Date(Date.now() - 1000) } }));
          return out;
        },
      }),
    );
    const r = await asyncApply(f, tariffUrl(f), p.token);
    const jobId = r.json().job.id as string;
    expect(r.json().job.status).toBe('RUNNING');
    expect(await scopeLogsOf(f)).toHaveLength(1);
    await kickJob(jobId);
    expect(await jobRow(f, jobId)).toMatchObject({ status: 'SUCCEEDED', attempts: 2, result: { invoices: 2, lines: 2, stopped: 0 } });
    expect(await scopeLogsOf(f)).toEqual([{ invoices: 2, lines: 2, skipped: { inDispute: 0, stale: 0 }, jobId }]);
    expect(countBy(await recalcAudits(f))).toEqual({ [invs[0]!.id]: 1, [invs[1]!.id]: 1 });
  });

  it('önizleme işi değişiklikten önce başlamış önizlemeye bağlanmaz: anahtar tarife sürümünü / ayar özetini taşır; uygulama anahtarı değişmez', async () => {
    const app = await getApp();
    const f = await firm(app);
    await invoice(f);
    await putTariff(f, 8);
    vi.stubEnv('JOB_RUNNER', 'off');
    const a1 = await asyncPreview(f, tariffUrl(f));
    const a2 = await asyncPreview(f, tariffUrl(f));
    expect([a1.json().joined, a2.json().joined, a2.json().job.id]).toEqual([false, true, a1.json().job.id]);
    // tarife yeniden kaydedildi (yeni sürüm): yeni önizleme
    await putTariff(f, 9);
    const b = await asyncPreview(f, tariffUrl(f));
    expect(b.json().joined).toBe(false);
    expect(b.json().job.id).not.toBe(a1.json().job.id);
    const keys = await inCompany(f.auth, () => prisma.job.findMany({ where: { companyId: f.companyId, kind: 'BULK_RECOMPARE_PREVIEW' }, select: { dedupeKey: true } }));
    expect(new Set(keys.map((k) => k.dedupeKey)).size).toBe(2);
    expect(keys.every((k) => k.dedupeKey.startsWith(`tariff:${f.tariffId}:`))).toBe(true);

    // ayar kapsamı: aynı ayarla bağlanır, ayar değişince yeni önizleme
    const s1 = await asyncPreview(f, SETTINGS_URL);
    expect((await asyncPreview(f, SETTINGS_URL)).json()).toMatchObject({ joined: true, job: { id: s1.json().job.id } });
    expect((await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: f.auth, payload: { amountTol: 25 } })).statusCode).toBe(200);
    expect((await asyncPreview(f, SETTINGS_URL)).json().joined).toBe(false);

    // uygulama anahtarı kapsam başına: farklı özetle ikinci onay yine JOB_ACTIVE
    const p = await syncPreview(f, tariffUrl(f));
    const apply = await asyncApply(f, tariffUrl(f), p.token);
    expect(apply.statusCode).toBe(202);
    expect((await jobRow(f, apply.json().job.id)).dedupeKey).toBe(`tariff:${f.tariffId}`);
    expect((await asyncApply(f, tariffUrl(f), 'd'.repeat(64))).statusCode).toBe(409);
    await closeLeftovers();
  });
});

// ---------- K4: önizlemeden sonra değişen fatura atlanır ve listelenir; plan önizleme işinden ----------

describe('toplu uygulama: önizlemenin planı ve değişen faturalar (K4)', () => {
  const previewRow = (f: Firm) =>
    inCompany(f.auth, () =>
      prisma.job.findFirstOrThrow({ where: { companyId: f.companyId, kind: 'BULK_RECOMPARE_PREVIEW', status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' } }),
    );
  /** Uygulama işinin bildirdiği aşamalar (hesap aşaması `bulkCheck` plan yeniden kurulunca görünür). */
  const recordStages = () => {
    const stages = new Set<string>();
    wrapApply((ctx) => ({
      ...ctx,
      progress: async (x) => {
        if (x.stage) stages.add(x.stage);
        return ctx.progress(x);
      },
    }));
    return stages;
  };

  it('plan önizleme işinden okunur (hesap aşaması yok); değişen fatura atlanır ve listelenir, kalanı yazılır; sonradan kapsama giren taşınmaz; aynı önizleme ikinci kez uygulanmaz', async () => {
    const app = await getApp();
    const f = await firm(app);
    const a = await invoice(f);
    const b = await invoice(f);
    const c = await invoice(f);
    await putTariff(f, 8);
    const rev2 = await currentRevision(f);
    const p = await syncPreview(f, tariffUrl(f));
    expect(p.invoices.map((i) => i.id)).toEqual([a.id, b.id, c.id]);

    // önizleme işi planı kendi kaydında tutar; sonuçta ve iş görünümünde plan yok
    const pv = await previewRow(f);
    expect(pv.checkpoint).toMatchObject({ v: 1, token: p.token, planned: [[a.id, expect.any(String)], [b.id, expect.any(String)], [c.id, expect.any(String)]], skipped: [] });
    expect(Object.keys(pv.result as object).sort()).toEqual(['changedInvoices', 'invoices', 'skippedInDispute', 'token', 'totalsByCurrency']);
    expect((await getJob(f, pv.id)).json()).not.toHaveProperty('checkpoint');

    // önizlemeden sonra: b'nin ölçümü düzeltilir (kendi özeti bozulur), dayanağı yazılmamış yeni bir fatura kapsama girer
    await correct(f, b.tracking[0]!);
    const d = await invoice(f);
    await inCompany(f.auth, () => prisma.invoice.update({ where: { id: d.id }, data: { tariffRevisionId: null } }));
    const bBefore = await fingerprint(f, b.id);
    const dBefore = await fingerprint(f, d.id);

    const stages = recordStages();
    const r = await asyncApply(f, tariffUrl(f), p.token);
    expect(r.statusCode, r.body).toBe(202);
    const job = r.json().job;
    expect(job).toMatchObject({ status: 'SUCCEEDED', progress: { done: 3, total: 3, stage: 'bulkWrite' } });
    expect(job.result).toEqual({ invoices: 2, lines: 2, skipped: { inDispute: 0, stale: 1 }, stopped: 0, staleInvoices: [await shortOf(f, b.id)], remaining: 2 });
    expect([...stages]).toEqual(['bulkWrite']);
    for (const id of [a.id, c.id]) expect((await invoiceRow(f, id)).tariffRevisionId).toBe(rev2);
    expect(await fingerprint(f, b.id)).toEqual(bBefore);
    expect(await fingerprint(f, d.id)).toEqual(dBefore);
    expect((await jobRow(f, job.id)).checkpoint).toMatchObject({ token: p.token, stale: [b.id] });
    expect(countBy(await recalcAudits(f))).toEqual({ [a.id]: 1, [c.id]: 1 });
    expect(await scopeLogsOf(f)).toEqual([{ invoices: 2, lines: 2, skipped: { inDispute: 0, stale: 1 }, jobId: job.id }]);
    // önizleme satırı bu uygulamayla kullanıldı diye işaretlenir (planın yanında)
    expect((await jobRow(f, pv.id)).checkpoint).toMatchObject({ token: p.token, appliedBy: job.id });

    // aynı önizleme ikinci kez uygulanmaz (yazılanlar "değişti" sayılmasın): yeni önizleme gerekir
    restores.splice(0).forEach((x) => x());
    const again = await asyncApply(f, tariffUrl(f), p.token);
    expect(again.json().job).toMatchObject({ status: 'FAILED', error: { code: 'PREVIEW_STALE' } });
    expect(countBy(await recalcAudits(f))).toEqual({ [a.id]: 1, [c.id]: 1 });
    // atlanan ve sonradan gelen fatura yeni önizlemede
    expect((await syncPreview(f, tariffUrl(f))).invoices.map((i) => i.id).sort()).toEqual([b.id, d.id].sort());
  });

  it('ilk faturadan önce durdurulan uygulamadan sonra aynı özetli yeni önizleme uygulanır (kısır döngü yok)', async () => {
    const app = await getApp();
    const f = await firm(app);
    const one = await invoice(f);
    const two = await invoice(f);
    await putTariff(f, 8);
    const rev2 = await currentRevision(f);
    const p = await syncPreview(f, tariffUrl(f));
    // aynı özetli ikinci önizleme satırı: bir uygulama aynı özetin bütün önizlemelerini kullanmış sayar
    expect((await syncPreview(f, tariffUrl(f))).token).toBe(p.token);

    // plan kaydedildi, ilk fatura yazılmadan durduruluyor
    let cancelStatus = 0;
    wrapApply((ctx) => ({
      ...ctx,
      progress: async (x) => {
        await ctx.progress(x);
        if (x.stage === 'bulkWrite' && x.done === 0 && !cancelStatus) {
          cancelStatus = (await app.inject({ method: 'POST', url: `${API}/jobs/${ctx.job.id}/cancel`, headers: f.auth, payload: {} })).statusCode;
        }
      },
    }));
    const stopped = await asyncApply(f, tariffUrl(f), p.token);
    expect(cancelStatus).toBe(200);
    expect(stopped.json().job).toMatchObject({ status: 'CANCELLED', result: { invoices: 0, stopped: 2 } });
    expect(await recalcAudits(f)).toEqual([]);
    restores.splice(0).forEach((x) => x());

    // hiçbir şey değişmedi: yeni önizlemenin özeti aynı; uygulaması başarılı
    const p2 = await syncPreview(f, tariffUrl(f));
    expect(p2.token).toBe(p.token);
    const ok = await asyncApply(f, tariffUrl(f), p2.token);
    expect(ok.json().job).toMatchObject({ status: 'SUCCEEDED', result: { invoices: 2, skipped: { inDispute: 0, stale: 0 }, stopped: 0 } });
    expect(ok.json().job.result).not.toHaveProperty('remaining');
    for (const x of [one, two]) expect((await invoiceRow(f, x.id)).tariffRevisionId).toBe(rev2);
    // eski önizlemelerin hiçbiri yeniden uygulanmaz
    const late = await asyncApply(f, tariffUrl(f), p.token);
    expect(late.json().job).toMatchObject({ status: 'FAILED', error: { code: 'PREVIEW_STALE' } });
    expect(countBy(await recalcAudits(f))).toEqual({ [one.id]: 1, [two.id]: 1 });
  });

  it('önizleme planını kaydederken aynı özetin "kullanıldı" işareti korunur (işaret plan kaydından önce gelmiş olabilir)', async () => {
    const app = await getApp();
    const f = await firm(app);
    await invoice(f);
    await putTariff(f, 8);
    const p = await syncPreview(f, tariffUrl(f));
    // ikinci önizleme sürerken satırına aynı özetle işaret düşmüş (başka bir uygulama aynı özetin önizlemelerini işaretledi)
    restores.push(
      overrideJobKindForTest('BULK_RECOMPARE_PREVIEW', {
        handler: async () => async (ctx: JobContext) => {
          await inCompany(f.auth, () => prisma.job.update({ where: { id: ctx.job.id }, data: { checkpoint: { v: 1, token: p.token, appliedBy: 'job-x' } } }));
          return bulkPreviewHandler(ctx);
        },
      } satisfies Partial<JobKindSpec>),
    );
    expect((await syncPreview(f, tariffUrl(f))).token).toBe(p.token);
    const marked = await previewRow(f);
    expect(marked.checkpoint).toMatchObject({ token: p.token, appliedBy: 'job-x', planned: [[expect.any(String), expect.any(String)]] });
  });

  it('dayanak önizlemeden sonra değişirse (ayar yeniden kaydedildi) hiçbir fatura yazılmaz: PREVIEW_STALE', async () => {
    const app = await getApp();
    const f = await firm(app);
    const one = await invoice(f);
    const two = await invoice(f);
    expect((await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: f.auth, payload: { amountTol: 25 } })).statusCode).toBe(200);
    const p = await syncPreview(f, SETTINGS_URL);
    expect(p.changedInvoices).toBe(2);
    expect((await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: f.auth, payload: { amountTol: 30 } })).statusCode).toBe(200);
    const before = await Promise.all([one, two].map((x) => fingerprint(f, x.id)));
    const r = await asyncApply(f, SETTINGS_URL, p.token);
    expect(r.json().job).toMatchObject({ status: 'FAILED', error: { statusCode: 409, code: 'PREVIEW_STALE' } });
    expect((await jobRow(f, r.json().job.id)).checkpoint).toBeNull();
    expect(await Promise.all([one, two].map((x) => fingerprint(f, x.id)))).toEqual(before);
    expect(await recalcAudits(f)).toEqual([]);
  });

  it('önizlemenin planı yoksa ya da bozuksa plan yeniden kurulur (eski kural): bozuk plan kullanılmaz, değişen fatura varsa hiçbir şey yazılmaz', async () => {
    const app = await getApp();
    const f = await firm(app);
    const one = await invoice(f);
    const two = await invoice(f);
    await putTariff(f, 8);
    const rev2 = await currentRevision(f);

    // bozuk plan (özet planı tutmuyor): kullanılmaz; yeniden kurulan plan önizlemeyle aynı, iki fatura da yazılır
    const p1 = await syncPreview(f, tariffUrl(f));
    const pv1 = await previewRow(f);
    const cp = pv1.checkpoint as { planned: [string, string][] };
    const tampered = { ...cp, planned: cp.planned.map(([id]) => [id, 'e'.repeat(64)]) };
    await inCompany(f.auth, () => prisma.job.update({ where: { id: pv1.id }, data: { checkpoint: tampered } }));
    const stages = recordStages();
    const ok = await asyncApply(f, tariffUrl(f), p1.token);
    expect(ok.json().job).toMatchObject({ status: 'SUCCEEDED', result: { invoices: 2, skipped: { inDispute: 0, stale: 0 } } });
    expect(stages.has('bulkCheck')).toBe(true);
    for (const x of [one, two]) expect((await invoiceRow(f, x.id)).tariffRevisionId).toBe(rev2);

    // planı silinmiş (temizlenmiş) önizleme: değişen fatura varsa eski kural, hiçbir şey yazılmaz
    await putTariff(f, 9);
    const p2 = await syncPreview(f, tariffUrl(f));
    const pv2 = await previewRow(f);
    await inCompany(f.auth, () => prisma.job.deleteMany({ where: { id: pv2.id } }));
    await correct(f, one.tracking[0]!);
    const before = await Promise.all([one, two].map((x) => fingerprint(f, x.id)));
    const stale = await asyncApply(f, tariffUrl(f), p2.token);
    expect(stale.json().job).toMatchObject({ status: 'FAILED', error: { code: 'PREVIEW_STALE' } });
    expect(await Promise.all([one, two].map((x) => fingerprint(f, x.id)))).toEqual(before);
  });
});

// ---------- ölçüm karşılaştırması yanıttan sonra (§4.10) ----------

const fxTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deciship-bulkjob-'));
const fxFetcher: FxFetcher = async (url) =>
  url === tcmbUrl('2026-10-15')
    ? { status: 200, text: '<Tarih_Date Tarih="15.10.2026"><Currency CurrencyCode="USD"><Unit>1</Unit><ForexBuying>40</ForexBuying><ForexSelling>40.1</ForexSelling></Currency></Tarih_Date>' }
    : { status: 404, text: '' };

/** Kur servisi: `hold` açıkken karşılaştırma bekler (yavaş kur), `down` iken hata verir. */
class GatedFx extends FxService {
  down = false;
  /** bu kadar çağrı daha hata verir, sonra düzelir */
  failNext = 0;
  hold: Promise<void> | null = null;
  constructor() {
    super({ fetcher: fxFetcher, cacheDir: fxTmp, now: () => new Date('2026-11-04T12:00:00Z') });
  }
  override async prefetch(...args: Parameters<FxService['prefetch']>) {
    if (this.hold) await this.hold;
    if (this.down) throw new Error('fx service down');
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('fx service hiccup');
    }
    return super.prefetch(...args);
  }
}

describe('ölçüm kaydı karşılaştırmayı beklemez (JOB_RUNNER=on)', () => {
  const fx = new GatedFx();
  beforeAll(() => setFxService(fx));
  afterAll(async () => {
    fx.hold = null;
    fx.down = false;
    await drainMeasurementQueue(10_000);
    setFxService(null);
    fs.rmSync(fxTmp, { recursive: true, force: true });
  });

  /** USD tarife, TRY fatura: karşılaştırma kur ister. */
  async function usdFirmWithInvoice(app: FastifyInstance, tracking: string) {
    const admin = await registerCompany(app, uniq('Ölçüm sırası '));
    const worker = await createWorker(app, admin.auth);
    const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'fedex', name: uniq('FedEx') } });
    const carrierId = c.json().carrier.id as string;
    const t = await app.inject({
      method: 'POST',
      url: `${API}/tariffs`,
      headers: admin.auth,
      payload: { ...tariffOf(carrierId, 0), name: 'USD', currency: 'USD', zones: [{ country: '*', zone: 'A' }], rates: [{ zone: 'A', weightUpto: 30, price: 100 }] },
    });
    expect(t.statusCode, t.body).toBe(201);
    const form = multipart([
      { name: 'carrierId', value: carrierId },
      { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(`Takip No;Desi;Tutar\n${tracking};5;5000`) },
    ]);
    const preview = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...admin.auth, ...form.headers }, payload: form.payload });
    expect(preview.statusCode, preview.body).toBe(200);
    const inv = await app.inject({
      method: 'POST',
      url: `${API}/invoices`,
      headers: admin.auth,
      payload: {
        fileId: preview.json().fileId,
        carrierId,
        invoiceNo: uniq('F'),
        invoiceDate: '2026-10-15',
        currency: 'TRY',
        mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
        acknowledgeIssues: true,
      },
    });
    expect(inv.statusCode, inv.body).toBe(201);
    return { admin, worker, invoiceId: inv.json().invoice.id as string };
  }
  const lineOf = async (app: FastifyInstance, auth: Auth, invoiceId: string) =>
    (await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/lines?pageSize=100`, headers: auth })).json().items[0] as { status: string; measurementId: string | null };
  const pendingOf = (auth: Auth, id: string) =>
    inCompany(auth, async () => (await prisma.measurement.findFirstOrThrow({ where: { id }, select: { recomparePendingAt: true } })).recomparePendingAt);
  const idle = (ms = 8000) =>
    until(
      () => {
        const s = measurementQueueState();
        return s.running === 0 && s.waiting === 0 && s.retrying === 0;
      },
      ms,
      'ölçüm sırası',
    );
  const lineFull = async (app: FastifyInstance, auth: Auth, invoiceId: string) =>
    (await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/lines?pageSize=100`, headers: auth })).json().items[0] as { status: string; ourChargeableKg: number | null };
  /** Ölçüm kaydı (karşılaştırması bitmiş) ve kimliği. */
  async function measured(app: FastifyInstance, worker: Auth, tracking: string) {
    const p = measurementPayload({ trackingRaw: tracking, lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
    const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker, ...p.headers }, payload: p.payload });
    expect(r.statusCode, r.body).toBeLessThan(300);
    await idle();
    return r.json().measurement.id as string;
  }

  it('kayıt karşılaştırmayı beklemeden döner; karşılaştırma sonra yapılır, işaret boşalır', async () => {
    const app = await getApp();
    const tracking = trackingNo();
    const { admin, worker, invoiceId } = await usdFirmWithInvoice(app, tracking);
    expect((await lineOf(app, admin.auth, invoiceId)).status).toBe('UNMATCHED');

    vi.stubEnv('JOB_RUNNER', 'on');
    let release!: () => void;
    fx.hold = new Promise<void>((r) => (release = r));
    const p = measurementPayload({ trackingRaw: tracking, lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
    const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...p.headers }, payload: p.payload });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().measurement.id as string;
    // yanıt döndü, karşılaştırma kur bekliyor: işaret dolu, satır henüz eşleşmedi
    expect(measurementQueueState().running).toBe(1);
    expect(await pendingOf(admin.auth, id)).not.toBeNull();
    expect((await lineOf(app, admin.auth, invoiceId)).status).toBe('UNMATCHED');
    fx.hold = null;
    release();
    await idle();
    expect(await pendingOf(admin.auth, id)).toBeNull();
    expect(await lineOf(app, admin.auth, invoiceId)).toMatchObject({ status: 'DIFF', measurementId: id });
  });

  it('karşılaştırma düşerse kayıt yine 201, işaret kalır; bakım işi tamamlar', async () => {
    const app = await getApp();
    const tracking = trackingNo();
    const { admin, worker, invoiceId } = await usdFirmWithInvoice(app, tracking);
    vi.stubEnv('JOB_RUNNER', 'on');
    fx.down = true;
    const p = measurementPayload({ trackingRaw: tracking, lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
    const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...p.headers }, payload: p.payload });
    expect(r.statusCode, r.body).toBe(201);
    // ilk deneme + iki yeniden deneme (1 sn, 5 sn) düşer
    await idle(15_000);
    fx.down = false;
    const id = r.json().measurement.id as string;
    expect(await pendingOf(admin.auth, id)).not.toBeNull();
    expect((await lineOf(app, admin.auth, invoiceId)).status).toBe('UNMATCHED');

    await inCompany(admin.auth, () => prisma.measurement.update({ where: { id }, data: { recomparePendingAt: new Date(Date.now() - RECOMPARE_STALE_MS - 60_000) } }));
    expect((await runMaintenance()).recompared).toBeGreaterThanOrEqual(1);
    expect(await pendingOf(admin.auth, id)).toBeNull();
    expect(await lineOf(app, admin.auth, invoiceId)).toMatchObject({ status: 'DIFF', measurementId: id });
  });

  it('kur servisi bir kez düşüp düzelir: sıradaki yeniden deneme işareti bakım çağrılmadan boşaltır', async () => {
    const app = await getApp();
    const tracking = trackingNo();
    const { admin, worker, invoiceId } = await usdFirmWithInvoice(app, tracking);
    vi.stubEnv('JOB_RUNNER', 'on');
    fx.failNext = 1;
    const p = measurementPayload({ trackingRaw: tracking, lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
    const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...p.headers }, payload: p.payload });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().measurement.id as string;
    await until(() => measurementQueueState().retrying === 1, 3000, 'yeniden deneme');
    await idle();
    expect(fx.failNext).toBe(0);
    expect(await pendingOf(admin.auth, id)).toBeNull();
    expect(await lineOf(app, admin.auth, invoiceId)).toMatchObject({ status: 'DIFF', measurementId: id });
  });

  it('sık tarama: açılışta yarıda kalmış (RECOMPARE_STALE_MS+, 2 dk) işaretleri sıraya alır ve boşaltır; daha genç işareti dar yol göstermez', async () => {
    const app = await getApp();
    const [oldT, youngT] = [trackingNo(), trackingNo()];
    const first = await usdFirmWithInvoice(app, oldT);
    const second = await usdFirmWithInvoice(app, youngT);
    // süreç ölmüş gibi: ölçüm yazıldı, karşılaştırma yapılmadı (satır içi kipte kur düşük → istek 5xx, işaret kalır)
    const ids: string[] = [];
    fx.down = true;
    for (const [who, t] of [
      [first, oldT],
      [second, youngT],
    ] as const) {
      const p = measurementPayload({ trackingRaw: t, lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
      const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...who.worker.auth, ...p.headers }, payload: p.payload });
      expect(r.statusCode).toBeGreaterThanOrEqual(500);
      ids.push((await inCompany(who.admin.auth, () => prisma.measurement.findFirstOrThrow({ where: { clientId: p.data.clientId } }))).id);
    }
    fx.down = false;
    await inCompany(first.admin.auth, () => prisma.measurement.update({ where: { id: ids[0] }, data: { recomparePendingAt: new Date(Date.now() - RECOMPARE_STALE_MS - 60_000) } }));

    vi.stubEnv('JOB_RUNNER', 'on');
    const stop = startMeasurementSweep({ warn: () => undefined }, { intervalMs: 60_000 });
    try {
      await until(async () => (await pendingOf(first.admin.auth, ids[0]!)) === null, 8000, 'tarama');
      await idle();
    } finally {
      stop();
    }
    expect(await lineOf(app, first.admin.auth, first.invoiceId)).toMatchObject({ status: 'DIFF', measurementId: ids[0] });
    expect(await pendingOf(second.admin.auth, ids[1]!)).not.toBeNull();
    expect((await lineOf(app, second.admin.auth, second.invoiceId)).status).toBe('UNMATCHED');
  });

  it('düzeltme ve geri yükleme yanıtı güncel karşılaştırmayı taşır; kur bekletilirse 2 sn sonra recomparePending: true', async () => {
    const app = await getApp();
    const tracking = trackingNo();
    const { admin, worker, invoiceId } = await usdFirmWithInvoice(app, tracking);
    vi.stubEnv('JOB_RUNNER', 'on');
    const id = await measured(app, worker.auth, tracking);
    expect((await lineFull(app, admin.auth, invoiceId)).ourChargeableKg).toBe(3);

    // hızlı durum: 26×25×16 / 3000 → 4 desi, yanıt güncel satırı taşır
    const fast = await app.inject({ method: 'PATCH', url: `${API}/measurements/${id}`, headers: admin.auth, payload: { lengthCm: 26, widthCm: 25, heightCm: 16 } });
    expect(fast.statusCode, fast.body).toBe(200);
    expect(fast.json().measurement).toMatchObject({ recomparePending: false, invoiceLines: [{ ourChargeableKg: 4 }] });
    const v2 = fast.json().measurement.id as string;

    // kur bekletiliyor: yanıt beklemeyi bırakır, eski satırı ve işareti gösterir; karşılaştırma arkada biter
    let release!: () => void;
    fx.hold = new Promise<void>((r) => (release = r));
    const t0 = Date.now();
    const slow = await app.inject({ method: 'PATCH', url: `${API}/measurements/${v2}`, headers: admin.auth, payload: { lengthCm: 40, widthCm: 30, heightCm: 25 } });
    const waited = Date.now() - t0;
    expect(slow.statusCode, slow.body).toBe(200);
    expect(waited).toBeGreaterThanOrEqual(1900);
    expect(waited).toBeLessThan(6000);
    expect(slow.json().measurement.recomparePending).toBe(true);
    const v3 = slow.json().measurement.id as string;
    fx.hold = null;
    release();
    await idle();
    expect(await pendingOf(admin.auth, v3)).toBeNull();
    expect((await lineFull(app, admin.auth, invoiceId)).ourChargeableKg).toBe(10);

    // geri yükleme: silme arkada karşılaştırılır; geri yükleme yanıtı satırı yeniden eşleşmiş taşır
    expect((await app.inject({ method: 'DELETE', url: `${API}/measurements/${v3}`, headers: admin.auth })).statusCode).toBe(204);
    await idle();
    expect((await lineFull(app, admin.auth, invoiceId)).status).toBe('UNMATCHED');
    const restored = await app.inject({ method: 'POST', url: `${API}/measurements/${v3}/restore`, headers: admin.auth, payload: {} });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().measurement).toMatchObject({ recomparePending: false, deleted: false, invoiceLines: [{ ourChargeableKg: 10 }] });
  });
});
