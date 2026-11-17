/**
 * Y57: ağır işler firmalar arasında adil paylaşılır.
 *  - Toplu yeniden hesabın başlatılması (`?async=1`) ağır yazma yuvasını yalnız iş eklenirken tutar: bir firmanın toplu
 *    hesabı sürerken başka firmanın fatura yüklemesi 503 "meşgul" almaz (Y83'ten beri hesap istekte değil, kuyrukta).
 *  - Kuyrukta aynı gruptan (toplu hesap, `JOB_SLOTS_RECALC` varsayılan 1) başka firma bekliyorsa uzun toplu uygulama
 *    payını (`JOB_FAIR_SLICE_MS`) doldurunca fatura arasında yuvayı bırakır ve kuyruğun sonuna döner; kaldığı yerden
 *    sürer, hiçbir fatura iki kez yazılmaz, sonuç ve denetim kaydı bırakmasaydı nasılsa öyle.
 */
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db.ts';
import { heavyInUse, resetRateLimits } from '../src/lib/rateLimit.ts';
import { recompareInvoice } from '../src/services/compare.ts';
import { findJob } from '../src/services/jobs/queue.ts';
import { closeInlineJobs, startJobRunner, type JobRunner } from '../src/services/jobs/runner.ts';
import { viaJob } from './jobHelpers.ts';
import { createWorker, getApp, inCompany, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';
import { testSuperDbUrl } from './testEnv.ts';

const API = '/api/deciship';
type Auth = { authorization: string };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => Promise<boolean> | boolean, timeoutMs = 20_000, label = 'koşul') {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error(`${label} ${timeoutMs} ms içinde gerçekleşmedi`);
}
const trackingNo = () => `7948${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;

const tariffOf = (carrierId: string, perKg: number) => ({
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
});

type Firm = { app: FastifyInstance; auth: Auth; worker: Auth; companyId: string; carrierId: string; tariffId: string };

async function firm(app: FastifyInstance): Promise<Firm> {
  const admin = await registerCompany(app, uniq('Adil '));
  const worker = await createWorker(app, admin.auth);
  const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'aras', name: uniq('Aras ') } });
  expect(c.statusCode, c.body).toBe(201);
  const carrierId = c.json().carrier.id as string;
  const t = await app.inject({ method: 'POST', url: `${API}/tariffs`, headers: admin.auth, payload: tariffOf(carrierId, 10) });
  expect(t.statusCode, t.body).toBe(201);
  return { app, auth: admin.auth, worker: worker.auth, companyId: admin.companyId, carrierId, tariffId: t.json().tariff.id as string };
}

/** Bir ölçülmüş satırlı fatura (5 desi, 50 TL; ölçüm 3 desi). */
async function invoice(f: Firm): Promise<string> {
  const tracking = trackingNo();
  const p = measurementPayload({ trackingRaw: tracking, lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
  expect((await f.app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...f.worker, ...p.headers }, payload: p.payload })).statusCode).toBe(201);
  const form = multipart([
    { name: 'carrierId', value: f.carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(`Takip No;Desi;Tutar\n${tracking};5;50`) },
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
  return id;
}

const putTariff = async (f: Firm, perKg: number) => {
  const r = await f.app.inject({ method: 'PUT', url: `${API}/tariffs/${f.tariffId}`, headers: f.auth, payload: tariffOf(f.carrierId, perKg) });
  expect(r.statusCode, r.body).toBe(200);
};
const tariffUrl = (f: Firm) => `${API}/tariffs/${f.tariffId}/recompare-invoices`;

/** Önizleme satır içi (sonuç hemen), testin kipi geri yüklenir. */
async function syncPreview(f: Firm) {
  const mode = process.env.JOB_RUNNER;
  process.env.JOB_RUNNER = 'inline';
  try {
    const r = await viaJob(f.app, { method: 'POST', url: `${tariffUrl(f)}/preview`, headers: f.auth, payload: {} });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { token: string; changedInvoices: number };
  } finally {
    if (mode === undefined) delete process.env.JOB_RUNNER;
    else process.env.JOB_RUNNER = mode;
  }
}
const asyncApply = (f: Firm, token: string) => f.app.inject({ method: 'POST', url: `${tariffUrl(f)}?async=1`, headers: f.auth, payload: { token } });

const recalcAudits = async (f: Firm) =>
  (await inCompany(f.auth, () => prisma.auditLog.findMany({ where: { companyId: f.companyId, action: 'invoice.recalculate' }, select: { entityId: true } }))).map((x) => x.entityId!);
const scopeAudits = (f: Firm) => inCompany(f.auth, () => prisma.auditLog.findMany({ where: { companyId: f.companyId, action: 'tariff.recompare' }, select: { data: true } }));
const revisionOf = async (f: Firm, id: string) => (await inCompany(f.auth, () => prisma.invoice.findFirstOrThrow({ where: { id } }))).tariffRevisionId;
const currentRevision = async (f: Firm) => (await inCompany(f.auth, () => prisma.tariff.findFirstOrThrow({ where: { id: f.tariffId } }))).currentRevisionId;

describe('Y57: ağır işlerde firmalar arası adil paylaşım', () => {
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const runners: JobRunner[] = [];
  let sup: pg.Client;
  // açık döngü bu dosyanın dışındaki bekleyen işleri almasın (bulkJob.test.ts ile aynı yol)
  const closeLeftovers = () =>
    sup.query(`UPDATE "Job" SET "status" = 'CANCELLED', "finishedAt" = now() AT TIME ZONE 'UTC', "lockedBy" = NULL, "lockedUntil" = NULL WHERE "status" IN ('QUEUED', 'RUNNING')`);
  beforeAll(async () => {
    sup = new pg.Client({ connectionString: testSuperDbUrl(), options: '-c search_path=deciship' });
    await sup.connect();
  });
  afterEach(async () => {
    await Promise.all(runners.splice(0).map((r) => r.stop()));
    await closeInlineJobs();
    vi.unstubAllEnvs();
    resetRateLimits();
  });
  afterAll(async () => {
    await closeLeftovers();
    await sup.end();
  });

  it('toplu hesabın başlatılması ağır yuvayı tutmaz: iş kuyruktayken başka firmanın fatura yüklemesi meşgul almaz', async () => {
    const app = await getApp();
    const a = await firm(app);
    const b = await firm(app);
    await invoice(a);
    await putTariff(a, 8);
    const p = await syncPreview(a);
    await closeLeftovers();

    // tek ağır yuva: eskiden A'nın eşzamanlı toplu hesabı onu dakikalarca tutabiliyordu
    vi.stubEnv('API_RATE_LIMIT', 'on');
    vi.stubEnv('IMPORT_CONCURRENCY', '1');
    vi.stubEnv('JOB_RUNNER', 'off');
    const started = await asyncApply(a, p.token);
    expect(started.statusCode, started.body).toBe(202);
    expect(started.json().job.status).toBe('QUEUED');
    expect(heavyInUse()).toBe(0);
    // B'nin ağır yazması (fatura içe aktarma) A'nın işi beklerken geçer
    vi.stubEnv('JOB_RUNNER', 'inline');
    const bInvoice = await invoice(b);
    expect(bInvoice).toBeTruthy();
    expect(heavyInUse()).toBe(0);
    await closeLeftovers();
  }, 120_000);

  it('uzun toplu uygulama başka firma bekleyince yuvayı bırakır, kaldığı yerden sürer; her fatura bir kez yazılır', async () => {
    const app = await getApp();
    const a = await firm(app);
    const b = await firm(app);
    const aInvoices = [await invoice(a), await invoice(a), await invoice(a), await invoice(a)];
    const bInvoices = [await invoice(b), await invoice(b)];
    await putTariff(a, 8);
    await putTariff(b, 9);
    const pa = await syncPreview(a);
    const pb = await syncPreview(b);
    expect([pa.changedInvoices, pb.changedInvoices]).toEqual([4, 2]);
    await closeLeftovers();

    // ikisi de kuyrukta: A önce
    vi.stubEnv('JOB_RUNNER', 'off');
    const ja = (await asyncApply(a, pa.token)).json().job.id as string;
    await sleep(5);
    const jb = (await asyncApply(b, pb.token)).json().job.id as string;

    // tek toplu hesap yuvası; pay 0 (her faturadan sonra sorulur), sorgu her seferinde
    runners.push(startJobRunner(silent, { pollMs: 20, leaseMs: 5000, graceMs: 500, slots: { ai: 0, recalc: 1 }, fairSliceMs: 0, fairCheckMs: 0 }));
    await until(async () => (await findJob(a.companyId, ja))?.status === 'SUCCEEDED' && (await findJob(b.companyId, jb))?.status === 'SUCCEEDED', 30_000, 'iki iş');

    const rowA = (await findJob(a.companyId, ja))!;
    const rowB = (await findJob(b.companyId, jb))!;
    // B, A bitmeden başladı (A yuvayı bıraktı); bırakmak deneme hakkı yemez
    expect(rowB.startedAt!.getTime()).toBeLessThan(rowA.finishedAt!.getTime());
    expect(rowA.attempts).toBe(1);
    expect(rowB.attempts).toBe(1);
    // sonuç ve sayaçlar bırakmasaydı nasılsa öyle
    expect(rowA.result).toEqual({ invoices: 4, lines: 4, skipped: { inDispute: 0, stale: 0 }, stopped: 0 });
    expect(rowB.result).toEqual({ invoices: 2, lines: 2, skipped: { inDispute: 0, stale: 0 }, stopped: 0 });
    expect(rowA.counters).toEqual({ invoices: 4, lines: 4, inDispute: 0, stale: 0 });
    expect(rowA).toMatchObject({ progressDone: 4, progressTotal: 4, stage: 'bulkWrite' });
    // her fatura tam bir kez yazıldı, yeni sürümde; kapsam kaydı bir kez
    const revA = await currentRevision(a);
    const revB = await currentRevision(b);
    for (const id of aInvoices) expect(await revisionOf(a, id)).toBe(revA);
    for (const id of bInvoices) expect(await revisionOf(b, id)).toBe(revB);
    expect((await recalcAudits(a)).sort()).toEqual([...aInvoices].sort());
    expect((await recalcAudits(b)).sort()).toEqual([...bInvoices].sort());
    expect((await scopeAudits(a)).map((x) => x.data)).toEqual([{ invoices: 4, lines: 4, skipped: { inDispute: 0, stale: 0 }, jobId: ja }]);
    expect((await scopeAudits(b)).map((x) => x.data)).toEqual([{ invoices: 2, lines: 2, skipped: { inDispute: 0, stale: 0 }, jobId: jb }]);
  }, 120_000);

  it('bekleyen başka firma yoksa yuva bırakılmaz (pay dolsa da)', async () => {
    const app = await getApp();
    const a = await firm(app);
    const ids = [await invoice(a), await invoice(a), await invoice(a)];
    await putTariff(a, 8);
    const pa = await syncPreview(a);
    await closeLeftovers();
    vi.stubEnv('JOB_RUNNER', 'off');
    const ja = (await asyncApply(a, pa.token)).json().job.id as string;
    runners.push(startJobRunner(silent, { pollMs: 20, leaseMs: 5000, graceMs: 500, slots: { ai: 0, recalc: 1 }, fairSliceMs: 0, fairCheckMs: 0 }));
    await until(async () => (await findJob(a.companyId, ja))?.status === 'SUCCEEDED', 30_000, 'iş');
    const row = (await findJob(a.companyId, ja))!;
    expect(row).toMatchObject({ attempts: 1, releases: 0, result: { invoices: 3, stopped: 0 } });
    expect((await recalcAudits(a)).sort()).toEqual([...ids].sort());
  }, 120_000);

  // ---------- bağımsız inceleme (Y57): bayat faturadan sonra bırakma, başka kopyadan durdurma ----------

  const fairOpts = { pollMs: 20, leaseMs: 5000, graceMs: 500, slots: { ai: 0, recalc: 1 }, fairSliceMs: 0, fairCheckMs: 0 };
  /** İş `jobId` yuvayı bırakınca döngü durur (yeni iş almaz): ara durum okunabilir. Dönen işlev durdurmanın sözü (yoksa null). */
  function runUntilYieldOf(jobId: string): () => Promise<void> | null {
    let stopping: Promise<void> | null = null;
    const runner = startJobRunner(
      {
        ...silent,
        info: (o: unknown, msg: string) => {
          if (!stopping && msg === 'job yielded its slot to another company' && (o as { jobId?: string }).jobId === jobId) stopping = runner.stop();
        },
      },
      fairOpts,
    );
    runners.push(runner);
    return () => stopping;
  }
  it('bayat ya da silinmiş faturayı atladıktan hemen sonra yuva bırakılırsa ilerleme kaybolmaz; atlanan bir kez sayılır', async () => {
    const app = await getApp();
    const a = await firm(app);
    const b = await firm(app);
    const aInvoices = [await invoice(a), await invoice(a), await invoice(a)];
    await invoice(b);
    await invoice(b);
    await putTariff(a, 8);
    await putTariff(b, 9);
    const pa = await syncPreview(a);
    const pb = await syncPreview(b);
    expect([pa.changedInvoices, pb.changedInvoices]).toEqual([3, 2]);
    await closeLeftovers();
    vi.stubEnv('JOB_RUNNER', 'off');
    const ja = (await asyncApply(a, pa.token)).json().job.id as string;
    await sleep(5);
    const jb = (await asyncApply(b, pb.token)).json().job.id as string;

    // 1. çalıştırma: A plan + bir fatura yazar, B beklediği için bırakır
    const first = runUntilYieldOf(ja);
    await until(() => first() !== null, 30_000, 'A ilk bırakma');
    await first();
    expect(await findJob(a.companyId, ja)).toMatchObject({ status: 'QUEUED', progressDone: 1, attempts: 0, counters: { invoices: 1, lines: 1, inDispute: 0, stale: 0 } });
    const revA = await currentRevision(a);
    const written: string[] = [];
    for (const id of aInvoices) if ((await revisionOf(a, id)) === revA) written.push(id);
    expect(written).toHaveLength(1);
    const [toEdit, toDelete] = aInvoices.filter((id) => id !== written[0]);
    // kalan iki fatura bu arada değişir: birinin tarihi düzeltilir (kendi özeti bayat: PREVIEW_STALE), öbürü silinir
    // (bulunamaz); ikisi de `stale`. (Satır kararı `scope: 'all'` özetine girmez: bayat saymaz.)
    const patch = { invoiceDate: '2026-10-16' };
    const editPreview = await app.inject({ method: 'POST', url: `${API}/invoices/${toEdit}/recalculate/preview`, headers: a.auth, payload: { basis: 'pinned', patch } });
    expect(editPreview.statusCode, editPreview.body).toBe(200);
    const edit = await app.inject({ method: 'PATCH', url: `${API}/invoices/${toEdit}`, headers: a.auth, payload: { ...patch, token: editPreview.json().token } });
    expect(edit.statusCode, edit.body).toBe(200);
    const del = await app.inject({ method: 'DELETE', url: `${API}/invoices/${toDelete}`, headers: a.auth });
    expect(del.statusCode, del.body).toBe(204);

    // 2. çalıştırma: önce B (daha önce bekliyordu), sonra A kaldığı yerden; A ilk faturayı atlar ve hemen bırakır
    const second = runUntilYieldOf(ja);
    await until(() => second() !== null, 30_000, 'A ikinci bırakma');
    await second();
    // atlanan faturanın ilerlemesi ve sayacı bırakmayla kalıcı: sonraki çalıştırma onu yeniden denemez, iki kez saymaz
    expect(await findJob(a.companyId, ja)).toMatchObject({ status: 'QUEUED', progressDone: 2, attempts: 0, counters: { invoices: 1, lines: 1, inDispute: 0, stale: 1 } });

    runners.push(startJobRunner(silent, fairOpts));
    await until(async () => (await findJob(a.companyId, ja))?.status === 'SUCCEEDED' && (await findJob(b.companyId, jb))?.status === 'SUCCEEDED', 30_000, 'iki iş');
    const rowA = (await findJob(a.companyId, ja))!;
    expect(rowA).toMatchObject({ attempts: 1, progressDone: 3, progressTotal: 3, counters: { invoices: 1, lines: 1, inDispute: 0, stale: 2 } });
    // K4: atlananların kimlikleri bırakmalar boyunca iş kaydında kalır; silinen de listelenir (işaretli). Düzeltilen fatura
    // hâlâ eski dayanakta (`remaining`), silinen sayılmaz.
    expect(rowA.checkpoint).toMatchObject({ stale: [toEdit, toDelete] });
    const short = (id: string) => inCompany(a.auth, () => prisma.invoice.findFirstOrThrow({ where: { id }, select: { invoiceNo: true, carrier: { select: { name: true } } } }));
    const [edited, removed] = [await short(toEdit!), await short(toDelete!)];
    expect(rowA.result).toEqual({
      invoices: 1,
      lines: 1,
      skipped: { inDispute: 0, stale: 2 },
      stopped: 0,
      staleInvoices: [
        { id: toEdit, invoiceNo: edited.invoiceNo, carrierName: edited.carrier.name },
        { id: toDelete, invoiceNo: removed.invoiceNo, carrierName: removed.carrier.name, deleted: true },
      ],
      remaining: 1,
    });
    expect((await findJob(b.companyId, jb))!.result).toEqual({ invoices: 2, lines: 2, skipped: { inDispute: 0, stale: 0 }, stopped: 0 });
    // bayat ve silinmiş fatura yazılmadı; yazılan bir kez (tarih düzeltmesinin kendi `invoice.recalculate` kaydı hariç)
    expect((await recalcAudits(a)).filter((id) => id !== toEdit)).toEqual(written);
    expect(await revisionOf(a, toEdit!)).not.toBe(revA);
    expect((await scopeAudits(a)).map((x) => x.data)).toEqual([{ invoices: 1, lines: 1, skipped: { inDispute: 0, stale: 2 }, jobId: ja }]);
  }, 120_000);

  it('başka kopyadan gelen durdurma kalp atışından önce yuva bırakmaya denk gelirse iş kuyruğa dönmez: bölüm sonucuyla CANCELLED', async () => {
    const app = await getApp();
    const a = await firm(app);
    const b = await firm(app);
    await invoice(a);
    await invoice(a);
    await invoice(a);
    await invoice(b);
    await putTariff(a, 8);
    await putTariff(b, 9);
    const pa = await syncPreview(a);
    const pb = await syncPreview(b);
    await closeLeftovers();
    vi.stubEnv('JOB_RUNNER', 'off');
    const ja = (await asyncApply(a, pa.token)).json().job.id as string;
    await sleep(5);
    const jb = (await asyncApply(b, pb.token)).json().job.id as string;

    // Başka kopyanın durdurma ucu yalnız satıra yazar (`cancelJob`: bu süreçte sinyal yok); kalp atışı (kira/4 = 15 sn)
    // görmeden önce. "Başka firma bekliyor mu" sorgusunun hemen öncesine yerleştirilir: A ilk faturayı yazmış, bırakmak üzere.
    const proto = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
    const orig = proto.query;
    let armed = true;
    proto.query = function (this: unknown, ...args: unknown[]) {
      const first = args[0] as { text?: string } | string | undefined;
      const text = typeof first === 'string' ? first : (first?.text ?? '');
      if (armed && /AS "one" FROM "Job" j/.test(text)) {
        armed = false;
        return sup.query(`UPDATE "Job" SET "cancelRequestedAt" = now() AT TIME ZONE 'UTC' WHERE "id" = $1`, [ja]).then(() => orig.apply(this, args));
      }
      return orig.apply(this, args);
    };
    try {
      runners.push(startJobRunner(silent, { ...fairOpts, leaseMs: 60_000 }));
      await until(async () => (await findJob(a.companyId, ja))?.status === 'CANCELLED' && (await findJob(b.companyId, jb))?.status === 'SUCCEEDED', 30_000, 'iki iş');
    } finally {
      proto.query = orig;
    }
    expect(armed).toBe(false);
    const rowA = (await findJob(a.companyId, ja))!;
    // bölüm sonucu yazıldı (eskiden kuyruğa dönüp sonuçsuz CANCELLED oluyordu); deneme bir kez
    expect(rowA).toMatchObject({ attempts: 1, progressDone: 1, progressTotal: 3 });
    expect(rowA.result).toEqual({ invoices: 1, lines: 1, skipped: { inDispute: 0, stale: 0 }, stopped: 2 });
    expect(await recalcAudits(a)).toHaveLength(1);
    expect((await scopeAudits(a)).map((x) => x.data)).toEqual([{ invoices: 1, lines: 1, skipped: { inDispute: 0, stale: 0 }, stopped: 2, jobId: ja }]);
  }, 120_000);
});
