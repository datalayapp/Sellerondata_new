/**
 * KALANLAR 6.18: büyük CSV/Excel fatura içe aktarma arka planda (`INVOICE_IMPORT`, SPEC §5.13).
 *
 * - Dosyanın veri satırı `INVOICE_IMPORT_QUEUE_ROWS`'u (varsayılan 5.000) aşarsa `POST /invoices?async=1` → 202
 *   `{ job, joined }`; sonuç `GET /jobs/:id` `result` = bugünkü 201 gövdesi (`fileUrl` yok). `async` yoksa 400
 *   `ASYNC_REQUIRED`: hiçbir şey yazılmaz. Eşik ve altı bugünkü gibi hemen 201.
 * - Para hesabı aynı: kuyruktan geçen içe aktarma satır içi içe aktarmayla birebir aynı faturayı, aynı rakamlarla yazar.
 * - Kapı hataları (okuma kontrolü, çakışma, ağırlık biçimi) işin hatasıdır (`job.error`, aynı kod ve ayrıntı).
 * - Tek iş: aynı dosyanın süren içe aktarmasına aynı gövdeyle bağlanılır, başka gövdeyle 409 `JOB_ACTIVE`; sıradaki iş
 *   durdurulur (fatura yazılmaz); yeniden deneme yazılmış faturayı ikinci kez yazmaz; başka firma işi göremez.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma, Prisma } from '../src/db.ts';
import { invoiceImportHandler } from '../src/services/jobs/handlers/invoiceImport.ts';
import { overrideJobKindForTest } from '../src/services/jobs/registry.ts';
import { runJobInline } from '../src/services/jobs/runner.ts';
import { tariffPayload } from './fixtures.ts';
import { createMember, createWorker, getApp, inCompany, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';

const API = '/api/deciship';
type Auth = { authorization: string };
let app: FastifyInstance;

beforeAll(async () => {
  app = await getApp();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** İki firmada aynı ölçümler ve tarife: aynı dosyanın iki yoldan içe aktarılması karşılaştırılabilsin. */
async function firm(trackings: string[]) {
  const admin = await registerCompany(app, uniq('İçe aktarma '));
  const worker = await createWorker(app, admin.auth);
  const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'aras', name: 'Aras' } });
  const carrierId = c.json().carrier.id as string;
  const t = await app.inject({ method: 'POST', url: `${API}/tariffs`, headers: admin.auth, payload: tariffPayload(carrierId, { name: 'Ana tarife' }) });
  expect(t.statusCode, t.body).toBe(201);
  // ölçülen kolilerin bir kısmı faturadakinden büyük (fark çıkar), bir kısmı küçük
  for (const [i, trackingRaw] of trackings.entries()) {
    const p = measurementPayload({ trackingRaw, lengthCm: 30 + i * 5, widthCm: 20, heightCm: 15, weightKg: 2 + i });
    const m = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...p.headers }, payload: p.payload });
    expect(m.statusCode, m.body).toBe(201);
  }
  return { admin, auth: admin.auth, carrierId };
}

/** Ölçülmüş, ölçülmemiş, dosya içinde yinelenen ve okunamayan satırlar; ek ücret sütunuyla. */
function csvOf(measured: string[], extra: number) {
  const rows = [
    'Takip No;Desi;Tutar;Ek ucret',
    ...measured.map((tr, i) => `${tr};${2 + (i % 3)};${(40 + i * 7.35).toFixed(2).replace('.', ',')};${i % 2 ? '5,50' : ''}`),
    `${measured[0]};2;40,00;`, // dosya içinde yinelenen gönderi ("Mükerrer")
    'XYZ-ABC;3;70,00;', // takip no okunamaz: faturaya alınmaz, raporda
    ...Array.from({ length: extra }, (_, i) => `88${String(i).padStart(8, '0')};${1 + (i % 9)};${(25 + (i % 13) * 3.1).toFixed(2).replace('.', ',')};`),
  ];
  return rows.join('\n');
}

async function previewOf(auth: Auth, carrierId: string, csv: string) {
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: 'buyuk.csv', contentType: 'text/csv', data: Buffer.from(csv) },
  ]);
  const p = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...auth, ...form.headers }, payload: form.payload });
  expect(p.statusCode, p.body).toBe(200);
  return p.json() as { fileId: string; rowCount: number };
}

const MAPPING = { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar', surchargeColumns: [{ header: 'Ek ucret', code: 'EK' }] };
const bodyOf = (fileId: string, carrierId: string, over: Record<string, unknown> = {}) => ({
  fileId,
  carrierId,
  invoiceNo: 'F-6-18',
  invoiceDate: '2026-10-15',
  currency: 'TRY',
  mapping: MAPPING,
  acknowledgeIssues: true,
  ...over,
});

const post = (auth: Auth, payload: object, query = '?async=1') => app.inject({ method: 'POST', url: `${API}/invoices${query}`, headers: auth, payload });
const getJob = (auth: Auth, id: string) => app.inject({ method: 'GET', url: `${API}/jobs/${id}`, headers: auth });
const invoiceCount = (auth: Auth) => inCompany(auth, () => prisma.invoice.count());

/** Faturanın kimliksiz görüntüsü: başlık, toplamlar, rapor ve bütün satırlar (kimlik, firma, zaman ve kayıt bağları hariç). */
async function snapshotOf(auth: Auth, invoiceId: string) {
  return inCompany(auth, async () => {
    const inv = await prisma.invoice.findFirstOrThrow({ where: { id: invoiceId } });
    const lines = await prisma.invoiceLine.findMany({ where: { invoiceId }, orderBy: { rowIndex: 'asc' } });
    const strip = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
    const ID_KEYS = [
      'id',
      'companyId',
      'invoiceId',
      'carrierId',
      'tariffId',
      'tariffRevisionId',
      'measurementId',
      'sourceFileId',
      'createdAt',
      'updatedAt',
      'calculatedAt',
      'decidedAt',
      'decidedById',
    ];
    return {
      invoice: strip(JSON.parse(JSON.stringify(inv)), ID_KEYS),
      lines: lines.map((l) => strip(JSON.parse(JSON.stringify(l)), ID_KEYS)),
    };
  });
}

describe('büyük CSV içe aktarma arka planda (INVOICE_IMPORT)', () => {
  it('eşiği aşan dosya kuyruğa gider: ?async=1 → 202 { job, joined }, sonuç bugünkü 201 gövdesi; async yoksa 400 ASYNC_REQUIRED ve hiçbir şey yazılmaz', async () => {
    vi.stubEnv('INVOICE_IMPORT_QUEUE_ROWS', '5');
    const f = await firm([uniq('7948'), uniq('7948')]);
    const { fileId } = await previewOf(f.auth, f.carrierId, csvOf([uniq('7948'), uniq('7948')], 4)); // 8 veri satırı

    const old = await post(f.auth, bodyOf(fileId, f.carrierId), '');
    expect(old.statusCode, old.body).toBe(400);
    expect(old.json().error.code).toBe('ASYNC_REQUIRED');
    expect(await invoiceCount(f.auth)).toBe(0);

    const r = await post(f.auth, bodyOf(fileId, f.carrierId));
    expect(r.statusCode, r.body).toBe(202);
    const started = r.json();
    expect(started.joined).toBe(false);
    expect(started.job).toMatchObject({ kind: 'INVOICE_IMPORT', ref: { type: 'File', id: fileId }, label: 'buyuk.csv', cancellable: expect.any(Boolean) });
    const job = (await getJob(f.auth, started.job.id)).json();
    expect(job.status, JSON.stringify(job.error)).toBe('SUCCEEDED');
    const result = job.result as {
      invoice: { id: string; invoiceNo: string; totals: { lines: number } };
      errors: { code: string }[];
      importReport: { linesImported: number; skippedCount: number };
    };
    expect(result.invoice).toMatchObject({ invoiceNo: 'F-6-18', totals: { lines: 7 } });
    expect(result.invoice).not.toHaveProperty('fileUrl');
    expect(result.errors.map((e) => e.code)).toEqual(['BAD_TRACKING']);
    expect(result.importReport).toMatchObject({ linesImported: 7, skippedCount: 1 });
    expect(await inCompany(f.auth, () => prisma.invoiceLine.count({ where: { invoiceId: result.invoice.id } }))).toBe(7);
    const file = await inCompany(f.auth, () => prisma.file.findFirstOrThrow({ where: { id: fileId } }));
    expect(file.invoiceId).toBe(result.invoice.id);
  });

  it('eşik ve altı bugünkü gibi hemen 201 (async verilse de)', async () => {
    vi.stubEnv('INVOICE_IMPORT_QUEUE_ROWS', '8');
    const f = await firm([]);
    const { fileId } = await previewOf(f.auth, f.carrierId, csvOf([uniq('7948'), uniq('7948')], 4)); // tam 8 veri satırı
    const r = await post(f.auth, bodyOf(fileId, f.carrierId));
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().invoice).toMatchObject({ invoiceNo: 'F-6-18', fileUrl: expect.any(String) });
    const noAsync = await previewOf(f.auth, f.carrierId, csvOf([uniq('7948')], 2));
    expect((await post(f.auth, bodyOf(noAsync.fileId, f.carrierId, { invoiceNo: 'F-2', confirmOverlap: true }), '')).statusCode).toBe(201);
  });

  it('para hesabı değişmez: kuyruktan geçen içe aktarma satır içi içe aktarmayla aynı faturayı aynı rakamlarla yazar', async () => {
    const measured = [uniq('7948'), uniq('7948'), uniq('7948'), uniq('7948')];
    const csv = csvOf(measured, 30);
    const inline = await firm(measured);
    const queued = await firm(measured);

    vi.stubEnv('INVOICE_IMPORT_QUEUE_ROWS', '100000');
    const a = await previewOf(inline.auth, inline.carrierId, csv);
    const ra = await post(inline.auth, bodyOf(a.fileId, inline.carrierId));
    expect(ra.statusCode, ra.body).toBe(201);

    vi.stubEnv('INVOICE_IMPORT_QUEUE_ROWS', '10');
    const b = await previewOf(queued.auth, queued.carrierId, csv);
    const rb = await post(queued.auth, bodyOf(b.fileId, queued.carrierId));
    expect(rb.statusCode, rb.body).toBe(202);
    const job = (await getJob(queued.auth, rb.json().job.id)).json();
    expect(job.status, JSON.stringify(job.error)).toBe('SUCCEEDED');

    const sa = await snapshotOf(inline.auth, ra.json().invoice.id);
    const sb = await snapshotOf(queued.auth, job.result.invoice.id);
    // anlamlı bir fatura: farklı, uyumlu, eşleşmeyen ve mükerrer satırlar var
    const statuses = new Set(sa.lines.map((l) => l.status));
    expect(statuses.has('DIFF') || statuses.has('MATCH')).toBe(true);
    expect(statuses.has('UNMATCHED')).toBe(true);
    expect(sa.lines.some((l) => (l.diffTypes as string[] | undefined)?.includes('DUPLICATE'))).toBe(true);
    expect(sb).toEqual(sa);
    // yanıt gövdesi de aynı (dosya bağlantısı ve kimlikler dışında)
    const { fileUrl: _u, id: _i, createdAt: _c, carrier: _ca, tariff: _t, tariffId: _ti, sourceFileId: _s, ...headA } = ra.json().invoice;
    const { id: _j, createdAt: _d, carrier: _cb, tariff: _tb, tariffId: _tj, sourceFileId: _sb, ...headB } = job.result.invoice;
    expect(headB).toEqual(headA);
    expect(job.result.importReport).toEqual(ra.json().importReport);
    expect(job.result.errors).toEqual(ra.json().errors);
  });

  it('kapı hatası işin hatasıdır: onaysız okuma kontrolü → FAILED 409 MAPPING_UNVERIFIED (ayrıntısıyla), fatura yazılmaz; onayla yeniden başlar', async () => {
    vi.stubEnv('INVOICE_IMPORT_QUEUE_ROWS', '5');
    const f = await firm([]);
    const { fileId } = await previewOf(f.auth, f.carrierId, csvOf([uniq('7948'), uniq('7948')], 6));
    const r = await post(f.auth, bodyOf(fileId, f.carrierId, { acknowledgeIssues: false }));
    expect(r.statusCode, r.body).toBe(202);
    const job = (await getJob(f.auth, r.json().job.id)).json();
    expect(job.status).toBe('FAILED');
    expect(job.error).toMatchObject({ statusCode: 409, code: 'MAPPING_UNVERIFIED', details: { issues: expect.any(Array) } });
    expect(await invoiceCount(f.auth)).toBe(0);
    const again = await post(f.auth, bodyOf(fileId, f.carrierId));
    expect(again.statusCode).toBe(202);
    expect(again.json().job.id).not.toBe(r.json().job.id);
    expect((await getJob(f.auth, again.json().job.id)).json().status).toBe('SUCCEEDED');
    expect(await invoiceCount(f.auth)).toBe(1);
  });

  it('tek iş: süren içe aktarmaya aynı gövdeyle bağlanılır, başka gövdeyle 409 JOB_ACTIVE; sıradaki iş durdurulur, fatura yazılmaz; başka firma işi göremez', async () => {
    vi.stubEnv('INVOICE_IMPORT_QUEUE_ROWS', '5');
    vi.stubEnv('JOB_RUNNER', 'off');
    const f = await firm([]);
    const other = await registerCompany(app, uniq('Başka '));
    const { fileId } = await previewOf(f.auth, f.carrierId, csvOf([uniq('7948'), uniq('7948')], 6));
    const first = await post(f.auth, bodyOf(fileId, f.carrierId));
    expect(first.statusCode, first.body).toBe(202);
    expect(first.json().job.status).toBe('QUEUED');
    const same = await post(f.auth, bodyOf(fileId, f.carrierId));
    expect(same.statusCode).toBe(202);
    expect(same.json()).toMatchObject({ joined: true, job: { id: first.json().job.id } });
    const diff = await post(f.auth, bodyOf(fileId, f.carrierId, { invoiceNo: 'F-BASKA' }));
    expect(diff.statusCode, diff.body).toBe(409);
    expect(diff.json().error).toMatchObject({ code: 'JOB_ACTIVE', details: { job: { id: first.json().job.id } } });
    expect((await getJob(other.auth, first.json().job.id)).statusCode).toBe(404);

    const stop = await app.inject({ method: 'POST', url: `${API}/jobs/${first.json().job.id}/cancel`, headers: f.auth, payload: {} });
    expect(stop.statusCode, stop.body).toBe(200);
    expect(stop.json().status).toBe('CANCELLED');
    expect(await invoiceCount(f.auth)).toBe(0);

    // dosya yerinde: yeni içe aktarma başlar ve (çalıştırıcı alınca) faturayı yazar
    const next = await post(f.auth, bodyOf(fileId, f.carrierId, { invoiceNo: 'F-BASKA' }));
    expect(next.statusCode).toBe(202);
    expect(await runJobInline(next.json().job.id)).toBe(true);
    expect((await getJob(f.auth, next.json().job.id)).json().status).toBe('SUCCEEDED');
    expect(await invoiceCount(f.auth)).toBe(1);
  });

  it('yazım işleminde durdurma isteği görülürse işlem geri alınır: fatura ve dosya bağı yazılmaz, iş CANCELLED', async () => {
    vi.stubEnv('INVOICE_IMPORT_QUEUE_ROWS', '5');
    vi.stubEnv('JOB_RUNNER', 'off');
    const f = await firm([]);
    const { fileId } = await previewOf(f.auth, f.carrierId, csvOf([uniq('7948'), uniq('7948')], 6));
    const r = await post(f.auth, bodyOf(fileId, f.carrierId));
    expect(r.json().job.status).toBe('QUEUED');
    // başka kopyadan gelen durdurma: satırda var, bu çalıştırıcının sinyali henüz görmedi (kalp atışından önce)
    const restore = overrideJobKindForTest('INVOICE_IMPORT', {
      handler: async () => async (ctx) => {
        await prisma.job.update({ where: { id: ctx.job.id }, data: { cancelRequestedAt: new Date() } });
        return invoiceImportHandler(ctx);
      },
    });
    try {
      expect(await runJobInline(r.json().job.id)).toBe(true);
    } finally {
      restore();
    }
    expect((await getJob(f.auth, r.json().job.id)).json().status).toBe('CANCELLED');
    expect(await invoiceCount(f.auth)).toBe(0);
    expect((await inCompany(f.auth, () => prisma.file.findFirstOrThrow({ where: { id: fileId } }))).invoiceId).toBeNull();
    expect(await inCompany(f.auth, () => prisma.auditLog.count({ where: { action: 'invoice.import' } }))).toBe(0);
  });

  it('inceleme 1: yazımdan sonra yeniden denenen iş yarım kalan tazelemeyi tamamlar; denetim kaydı faturayla aynı işlemde, tam bir kez', async () => {
    vi.stubEnv('INVOICE_IMPORT_QUEUE_ROWS', '5');
    const measured = [uniq('7948'), uniq('7948')];
    const f = await firm(measured);
    const { fileId } = await previewOf(f.auth, f.carrierId, csvOf(measured, 6));
    const r = await post(f.auth, bodyOf(fileId, f.carrierId));
    const jobId = r.json().job.id as string;
    const done = (await getJob(f.auth, jobId)).json();
    expect(done.status).toBe('SUCCEEDED');
    const invoiceId = done.result.invoice.id as string;
    const before = await snapshotOf(f.auth, invoiceId);
    // yazım işlendi, tazeleme ve bitiş yazılmadan süreç öldü: satırlar eski hesapta kaldı, kayıtta "bitmedi"
    await inCompany(f.auth, async () => {
      await prisma.invoiceLine.updateMany({ where: { invoiceId }, data: { expectedAmount: 1, diffAmount: 1 } });
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'QUEUED',
          result: Prisma.DbNull,
          finishedAt: null,
          lockedBy: null,
          lockedUntil: null,
          checkpoint: { invoiceId, errors: [], recompare: 'DUPLICATE', settled: false },
        },
      });
    });
    expect(await runJobInline(jobId)).toBe(true);
    const again = (await getJob(f.auth, jobId)).json();
    expect(again.status).toBe('SUCCEEDED');
    expect(again.result.invoice.id).toBe(invoiceId);
    const after = await snapshotOf(f.auth, invoiceId);
    expect(after.lines.map((l) => [l.expectedAmount, l.diffAmount])).toEqual(before.lines.map((l) => [l.expectedAmount, l.diffAmount]));
    expect(await invoiceCount(f.auth)).toBe(1);
    const audits = await inCompany(f.auth, () => prisma.auditLog.count({ where: { action: 'invoice.import', entityId: invoiceId } }));
    expect(audits).toBe(1);
    const cp = await inCompany(f.auth, () => prisma.job.findFirstOrThrow({ where: { id: jobId }, select: { checkpoint: true } }));
    expect(cp.checkpoint).toMatchObject({ invoiceId, settled: true });
  });

  it('inceleme 2: fatura yazılmış işte durdurma reddedilir (409 JOB_NOT_CANCELLABLE); satırdaki durdurma isteği işi durdurmaz, iş SUCCEEDED', async () => {
    vi.stubEnv('INVOICE_IMPORT_QUEUE_ROWS', '5');
    const f = await firm([]);
    const { fileId } = await previewOf(f.auth, f.carrierId, csvOf([uniq('7948'), uniq('7948')], 6));
    const r = await post(f.auth, bodyOf(fileId, f.carrierId));
    const jobId = r.json().job.id as string;
    const done = (await getJob(f.auth, jobId)).json();
    const invoiceId = done.result.invoice.id as string;
    await inCompany(f.auth, () =>
      prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'QUEUED',
          result: Prisma.DbNull,
          finishedAt: null,
          lockedBy: null,
          lockedUntil: null,
          checkpoint: { invoiceId, errors: [], recompare: null, settled: true },
        },
      }),
    );
    const stop = await app.inject({ method: 'POST', url: `${API}/jobs/${jobId}/cancel`, headers: f.auth, payload: {} });
    expect(stop.statusCode, stop.body).toBe(409);
    expect(stop.json().error.code).toBe('JOB_NOT_CANCELLABLE');
    // başka kopyadan gelmiş durdurma isteği satırda: yeniden deneme yine sonucu yazar
    await inCompany(f.auth, () => prisma.job.update({ where: { id: jobId }, data: { cancelRequestedAt: new Date() } }));
    expect(await runJobInline(jobId)).toBe(true);
    const again = (await getJob(f.auth, jobId)).json();
    expect(again.status).toBe('SUCCEEDED');
    expect(again.result.invoice.id).toBe(invoiceId);
  });

  it('inceleme 7: kuyrukta beklerken başlatan çıkarıldıysa ya da yetkisi alındıysa iş 403 JOB_STARTER_FORBIDDEN ile düşer, fatura yazılmaz', async () => {
    vi.stubEnv('INVOICE_IMPORT_QUEUE_ROWS', '5');
    vi.stubEnv('JOB_RUNNER', 'off');
    const f = await firm([]);
    const member = await createMember(app, f.auth, 'ADMIN', 'Yükleyen Test');
    const { fileId } = await previewOf(member.auth, f.carrierId, csvOf([uniq('7948'), uniq('7948')], 6));
    const r = await post(member.auth, bodyOf(fileId, f.carrierId));
    expect(r.statusCode, r.body).toBe(202);
    await inCompany(f.auth, () => prisma.member.update({ where: { id: member.userId }, data: { active: false } }));
    expect(await runJobInline(r.json().job.id)).toBe(true);
    const job = (await getJob(f.auth, r.json().job.id)).json();
    expect(job.status).toBe('FAILED');
    expect(job.error).toMatchObject({ statusCode: 403, code: 'JOB_STARTER_FORBIDDEN' });
    expect(await invoiceCount(f.auth)).toBe(0);
  });

  it('yeniden deneme yazılmış faturayı ikinci kez yazmaz: yazımla aynı işlemde işe bağlanan fatura sonucu olur', async () => {
    vi.stubEnv('INVOICE_IMPORT_QUEUE_ROWS', '5');
    const f = await firm([]);
    const { fileId } = await previewOf(f.auth, f.carrierId, csvOf([uniq('7948'), uniq('7948')], 6));
    const r = await post(f.auth, bodyOf(fileId, f.carrierId));
    const jobId = r.json().job.id as string;
    const done = (await getJob(f.auth, jobId)).json();
    expect(done.status).toBe('SUCCEEDED');
    // bitiş yazılmadan süreç ölmüş gibi: iş yeniden kuyrukta, işin kaydı (checkpoint) duruyor
    await inCompany(f.auth, () =>
      prisma.job.update({ where: { id: jobId }, data: { status: 'QUEUED', result: Prisma.DbNull, finishedAt: null, lockedBy: null, lockedUntil: null } }),
    );
    expect(await runJobInline(jobId)).toBe(true);
    const again = (await getJob(f.auth, jobId)).json();
    expect(again.status).toBe('SUCCEEDED');
    expect(again.result.invoice.id).toBe(done.result.invoice.id);
    expect(again.result.invoice.totals).toEqual(done.result.invoice.totals);
    expect(await invoiceCount(f.auth)).toBe(1);
  });
});
