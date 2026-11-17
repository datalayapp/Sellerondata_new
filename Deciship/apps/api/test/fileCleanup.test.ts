import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, withCompany, withMaintenanceScope } from '../src/db.ts';
import { env } from '../src/env.ts';
import {
  DELETED_INVOICE_FILE_TTL_MS,
  PREVIEW_FILE_TTL_MS,
  discardPreviewFile,
  isForeignKeyViolation,
  purgeInvoiceSourceFile,
  runFileCleanup,
  type FileCleanupCursor,
} from '../src/services/fileCleanup.ts';
import { JOB_RETENTION_MS } from '../src/services/jobs/queue.ts';
import { runMaintenance } from '../src/services/maintenance.ts';
import { companyFixture, type Fixture } from './fixtures.ts';
import { createMember, getApp, multipart, uniq } from './helpers.ts';
import { TEST_DB_URL, testSuperDbUrl } from './testEnv.ts';
import { setFxService } from '../src/services/fx.ts';
import { anyDayFx } from './fxFake.ts';

// Y9: bakım işi (`runMaintenance`) bütün firmalarda bekleyen ölçüm karşılaştırmasını tamamlar; önceki test dosyalarından
// kalan dövizli faturalar (USD tarife, 15.10.2026) kur ister. Gerçek TCMB'ye gidilmesin diye her güne yanıt veren sahte kur.
beforeAll(() => setFxService(anyDayFx({ USD: 40.05, EUR: 44.1, GBP: 50.2 })));
afterAll(() => setFxService(null));

const HOUR = 3_600_000;
const API = '/api/deciship';

/**
 * Mesaj 7 P4 (plan §4.12): fatura kaynak dosyalarının temizliği. Asıl soru veri kaybı: canlı faturanın dosyası, başka
 * firmanın dosyası ve ölçüm fotoğrafı hiçbir yoldan silinmemeli.
 */
describe('dosya temizliği (Mesaj 7)', () => {
  let app: FastifyInstance;
  let A: Fixture;
  let B: Fixture;
  let sup: pg.Client;

  const abs = (rel: string) => path.join(env.storageDir, rel);
  const onDisk = (rel: string) => fs.existsSync(abs(rel));
  const backdate = (table: string, column: string, id: string, interval: string) =>
    sup.query(`UPDATE "${table}" SET "${column}" = (now() AT TIME ZONE 'UTC') - $2::interval WHERE id = $1`, [id, interval]);
  const fileRow = async (id: string) =>
    (await sup.query<{ id: string; path: string; invoiceId: string | null; purgedAt: Date | null; kind: string }>(`SELECT id, path, "invoiceId", "purgedAt", kind FROM "File" WHERE id = $1`, [id])).rows[0];
  const quiet = () => {
    const warns: string[] = [];
    return { warns, log: { warn: (_o: unknown, msg: string) => void warns.push(msg) } };
  };

  /** Doğrudan önizleme satırı + diskte dosya (firmanın klasöründe, `storeBuffer` biçimi). */
  async function previewRow(f: Fixture, o: { kind?: 'INVOICE_SOURCE' | 'PHOTO_BOX'; rel?: string; dir?: boolean } = {}) {
    const rel = o.rel ?? path.posix.join(f.companyId, 'cleanup', `${crypto.randomUUID()}.csv`);
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    if (o.dir) fs.mkdirSync(abs(rel), { recursive: true });
    else if (!fs.existsSync(abs(rel))) fs.writeFileSync(abs(rel), 'Takip No;Desi;Tutar\n1;1;1\n');
    const row = await withCompany(f.companyId, () =>
      prisma.file.create({
        data: { companyId: f.companyId, kind: o.kind ?? 'INVOICE_SOURCE', mime: 'text/csv', size: 1, path: rel, sha256: 'x', createdById: f.admin.userId },
        select: { id: true },
      }),
    );
    return { id: row.id, rel };
  }

  /** Gerçek akış: CSV önizleme (dosya diske yazılır). */
  async function uploadPreview(f: Fixture, o: { rows?: number; auth?: { authorization: string } } = {}) {
    const rows = o.rows ? Array.from({ length: o.rows }, (_, i) => `${uniq('76')}${i};5;50`) : [`${uniq('77')};5;50`, `${uniq('78')};3;30`];
    const csv = ['Takip No;Desi;Tutar', ...rows].join('\n');
    const form = multipart([
      { name: 'carrierId', value: f.carrierId },
      { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
    ]);
    const res = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...(o.auth ?? f.admin.auth), ...form.headers }, payload: form.payload });
    expect(res.statusCode, res.body).toBe(200);
    const fileId = res.json().fileId as string;
    return { fileId, rel: (await fileRow(fileId))!.path };
  }

  const importFrom = (f: Fixture, fileId: string, over: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: `${API}/invoices`,
      headers: f.admin.auth,
      payload: {
        fileId,
        carrierId: f.carrierId,
        invoiceNo: uniq('T'),
        invoiceDate: '2026-10-15',
        currency: 'TRY',
        mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
        acknowledgeIssues: true,
        ...over,
      },
    });

  async function invoiceWithFile(f: Fixture) {
    const p = await uploadPreview(f);
    const res = await importFrom(f, p.fileId);
    expect(res.statusCode, res.body).toBe(201);
    return { ...p, invoiceId: res.json().invoice.id as string };
  }

  const deleteInvoice = async (f: Fixture, id: string) => {
    const res = await app.inject({ method: 'DELETE', url: `${API}/invoices/${id}`, headers: f.admin.auth });
    expect(res.statusCode, res.body).toBe(204);
  };
  const getFile = (f: Fixture, id: string) => app.inject({ method: 'GET', url: `${API}/files/${id}`, headers: f.admin.auth });
  const discardViaApi = (f: Fixture, id: string) => app.inject({ method: 'DELETE', url: `${API}/invoices/preview/${id}`, headers: f.admin.auth });

  beforeAll(async () => {
    app = await getApp();
    A = await companyFixture(app);
    B = await companyFixture(app);
    sup = new pg.Client({ connectionString: testSuperDbUrl(), options: '-c search_path=deciship' });
    await sup.connect();
  });
  afterAll(async () => {
    await sup?.end();
  });

  it('koddaki süreler migration ile aynı', () => {
    const sql = fs.readFileSync(path.resolve(import.meta.dirname, '../prisma/migrations/20261114120000_jobs_files/migration.sql'), 'utf8');
    const policy = (name: string) => sql.slice(sql.indexOf(`CREATE POLICY ${name}`), sql.indexOf(';', sql.indexOf(`CREATE POLICY ${name}`)));
    expect(policy('maintenance_preview_read')).toContain("interval '24 hours'");
    expect(PREVIEW_FILE_TTL_MS).toBe(24 * HOUR);
    expect(policy('maintenance_deleted_read')).toContain("interval '30 days'");
    expect(DELETED_INVOICE_FILE_TTL_MS).toBe(30 * 24 * HOUR);
    expect(policy('maintenance_expired_delete')).toContain("interval '7 days'");
    expect(JOB_RETENTION_MS).toBe(7 * 24 * HOUR);
  });

  it('24 saatten eski bağsız önizleme satırıyla ve diskiyle silinir; taze olan kalır', async () => {
    const old = await previewRow(A);
    const fresh = await previewRow(A);
    await backdate('File', 'updatedAt', old.id, '25 hours');
    await backdate('File', 'updatedAt', fresh.id, '23 hours');
    const { log } = quiet();
    const r = await runFileCleanup(Date.now(), log);
    expect(r.previews).toBeGreaterThanOrEqual(1);
    expect(await fileRow(old.id)).toBeUndefined();
    expect(onDisk(old.rel)).toBe(false);
    expect(await fileRow(fresh.id)).toMatchObject({ purgedAt: null });
    expect(onDisk(fresh.rel)).toBe(true);
  });

  it('saatlik bakım dosya temizliğini ve eski iş temizliğini çalıştırır, sayar', async () => {
    const old = await previewRow(B);
    await backdate('File', 'updatedAt', old.id, '25 hours');
    const finished = () =>
      withCompany(B.companyId, () =>
        prisma.job.create({ data: { companyId: B.companyId, kind: 'BULK_RECOMPARE_PREVIEW', status: 'SUCCEEDED', dedupeKey: `m:${crypto.randomUUID()}`, input: {}, finishedAt: new Date() }, select: { id: true } }),
      ).then((r) => r.id);
    const oldJob = await finished();
    const freshJob = await finished();
    await backdate('Job', 'finishedAt', oldJob, '8 days');
    await backdate('Job', 'finishedAt', freshJob, '6 days');
    const r = await runMaintenance(Date.now(), quiet().log);
    expect(r.previews).toBeGreaterThanOrEqual(1);
    expect(r).toHaveProperty('purged');
    expect(r.jobs).toBeGreaterThanOrEqual(1);
    expect(await fileRow(old.id)).toBeUndefined();
    const jobs = (await sup.query(`SELECT id FROM "Job" WHERE id = ANY($1)`, [[oldJob, freshJob]])).rows.map((x) => x.id);
    expect(jobs).toEqual([freshJob]);
  });

  it('doğrulama ve yapay zekâ eşleme önizlemeyi tazeler: kullanılan önizleme silinmez', async () => {
    const p = await uploadPreview(A);
    await backdate('File', 'updatedAt', p.fileId, '25 hours');
    const verify = await app.inject({
      method: 'POST',
      url: `${API}/invoices/preview/verify`,
      headers: A.admin.auth,
      payload: { fileId: p.fileId, carrierId: A.carrierId, mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' } },
    });
    expect(verify.statusCode, verify.body).toBe(200);
    await runFileCleanup(Date.now(), quiet().log);
    expect(await fileRow(p.fileId)).toBeDefined();
    expect(onDisk(p.rel)).toBe(true);
  });

  it('faturaya bağlı dosya, invoiceId elle boşaltılmış olsa bile silinmez (denetim ve yabancı anahtar)', async () => {
    const inv = await invoiceWithFile(A);
    await sup.query(`UPDATE "File" SET "invoiceId" = NULL WHERE id = $1`, [inv.fileId]);
    await backdate('File', 'updatedAt', inv.fileId, '40 days');
    const { warns, log } = quiet();

    // bakım listesine önizleme olarak girer, ama firma bağlamındaki denetim faturayı görür
    const seen = await withMaintenanceScope(async () => (await prisma.file.findMany({ select: { id: true } })).map((r) => r.id));
    expect(seen).toContain(inv.fileId);
    await runFileCleanup(Date.now(), log);
    expect(await discardPreviewFile(A.companyId, inv.fileId, { log })).toBe(false);
    expect((await discardViaApi(A, inv.fileId)).statusCode).toBe(204);
    expect(await fileRow(inv.fileId)).toMatchObject({ purgedAt: null });
    expect(onDisk(inv.rel)).toBe(true);
    expect(warns.some((w) => w.includes('referenced by an invoice'))).toBe(true);

    // son güvence: denetim atlansa bile veritabanı satırı silmez (RESTRICT) ve hata tanınır
    const err = await withCompany(A.companyId, () => prisma.file.deleteMany({ where: { id: inv.fileId } })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect(isForeignKeyViolation(err)).toBe(true);
    expect(await fileRow(inv.fileId)).toBeDefined();
    expect((await getFile(A, inv.fileId)).statusCode).toBe(200);
  });

  it('süren işi olan dosya kalır; işin kendi temizlik kancası (exceptJobId) siler', async () => {
    const p = await previewRow(A);
    await backdate('File', 'updatedAt', p.id, '25 hours');
    const job = await withCompany(A.companyId, () =>
      prisma.job.create({
        data: { companyId: A.companyId, kind: 'INVOICE_PDF_READ', status: 'RUNNING', dedupeKey: `t:${crypto.randomUUID()}`, refType: 'File', refId: p.id, input: {} },
        select: { id: true },
      }),
    );
    await runFileCleanup(Date.now(), quiet().log);
    expect(await discardPreviewFile(A.companyId, p.id)).toBe(false);
    expect(await fileRow(p.id)).toBeDefined();
    expect(onDisk(p.rel)).toBe(true);

    expect(await discardPreviewFile(A.companyId, p.id, { exceptJobId: job.id })).toBe(true);
    expect(await fileRow(p.id)).toBeUndefined();
    expect(onDisk(p.rel)).toBe(false);
  });

  it('aynı yolu paylaşan satır (ölçüm fotoğrafı dahil) varsa disk dosyası kalır, fotoğraf satırına dokunulmaz', async () => {
    const photo = await previewRow(A, { kind: 'PHOTO_BOX' });
    const p = await previewRow(A, { rel: photo.rel });
    await backdate('File', 'updatedAt', p.id, '25 hours');
    await backdate('File', 'updatedAt', photo.id, '400 days');
    await runFileCleanup(Date.now(), quiet().log);
    expect(await fileRow(p.id)).toBeUndefined();
    expect(onDisk(photo.rel)).toBe(true);
    expect(await fileRow(photo.id)).toMatchObject({ kind: 'PHOTO_BOX', purgedAt: null });

    // fikstürün gerçek ölçüm fotoğrafı da yerinde
    const fixturePhoto = await fileRow(A.photoId);
    expect(fixturePhoto).toMatchObject({ kind: 'PHOTO_BOX', purgedAt: null });
    expect(onDisk(fixturePhoto!.path)).toBe(true);
  });

  it('silinen fatura: 29 gün kalır, 31 gün temizlenir (satır durur, purgedAt dolu, GET /files 404)', async () => {
    const inv = await invoiceWithFile(A);
    await deleteInvoice(A, inv.invoiceId);
    const { log } = quiet();

    await backdate('Invoice', 'deletedAt', inv.invoiceId, '29 days');
    await runFileCleanup(Date.now(), log);
    expect(await fileRow(inv.fileId)).toMatchObject({ purgedAt: null, invoiceId: inv.invoiceId });
    expect(onDisk(inv.rel)).toBe(true);

    await backdate('Invoice', 'deletedAt', inv.invoiceId, '31 days');
    const r = await runFileCleanup(Date.now(), log);
    expect(r.purged).toBeGreaterThanOrEqual(1);
    const row = await fileRow(inv.fileId);
    expect(row?.purgedAt).toBeInstanceOf(Date);
    expect(row?.invoiceId).toBe(inv.invoiceId);
    expect(onDisk(inv.rel)).toBe(false);
    expect((await sup.query(`SELECT id FROM "Invoice" WHERE id = $1`, [inv.invoiceId])).rowCount).toBe(1);
    const res = await getFile(A, inv.fileId);
    expect(res.statusCode).toBe(404);
  });

  it('temizlenmiş dosya GET /files ile açılmaz (bağsız satırda da: purgedAt süzgeci)', async () => {
    const p = await previewRow(A);
    expect((await getFile(A, p.id)).statusCode).toBe(200);
    await sup.query(`UPDATE "File" SET "purgedAt" = now() WHERE id = $1`, [p.id]);
    const res = await getFile(A, p.id);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('silinmemiş faturanın dosyasına asla dokunulmaz (ne kadar eski olursa olsun, ileri saatle de)', async () => {
    const inv = await invoiceWithFile(A);
    await backdate('File', 'updatedAt', inv.fileId, '400 days');
    await backdate('File', 'createdAt', inv.fileId, '400 days');
    await backdate('Invoice', 'createdAt', inv.invoiceId, '400 days');
    const future = Date.now() + 365 * 24 * HOUR;
    const { log } = quiet();
    await runFileCleanup(future, log);
    expect(await discardPreviewFile(A.companyId, inv.fileId, { log })).toBe(false);
    expect(await purgeInvoiceSourceFile(A.companyId, inv.fileId, future, { log })).toBe(false);
    expect((await discardViaApi(A, inv.fileId)).statusCode).toBe(204);
    expect(await fileRow(inv.fileId)).toMatchObject({ purgedAt: null, invoiceId: inv.invoiceId });
    expect(onDisk(inv.rel)).toBe(true);
    expect((await getFile(A, inv.fileId)).statusCode).toBe(200);
    // fikstürün canlı faturasının dosyası da
    const fixtureFile = await fileRow(A.invoiceFileId);
    expect(fixtureFile).toMatchObject({ purgedAt: null });
    expect(onDisk(fixtureFile!.path)).toBe(true);
  });

  it('aynı dosyayı canlı bir fatura da gösteriyorsa silinen faturanın 31 günü dolsa bile temizlenmez', async () => {
    const first = await invoiceWithFile(A);
    // aynı yüklemeden ikinci fatura (API izin veriyor): dosyanın invoiceId'si ikinciye geçer
    const second = await importFrom(A, first.fileId, { confirmOverlap: true });
    expect(second.statusCode, second.body).toBe(201);
    const secondId = second.json().invoice.id as string;
    // dosyanın gösterdiği fatura silinir ve süresi dolar; diğeri canlı
    await deleteInvoice(A, secondId);
    await backdate('Invoice', 'deletedAt', secondId, '31 days');
    const { log } = quiet();
    await runFileCleanup(Date.now(), log);
    expect(await purgeInvoiceSourceFile(A.companyId, first.fileId, Date.now(), { log })).toBe(false);
    expect(await fileRow(first.fileId)).toMatchObject({ purgedAt: null });
    expect(onDisk(first.rel)).toBe(true);

    // yakında (10 gün önce) silinmiş ikinci bir gösteren de temizliği bekletir
    await deleteInvoice(A, first.invoiceId);
    await backdate('Invoice', 'deletedAt', first.invoiceId, '10 days');
    expect(await purgeInvoiceSourceFile(A.companyId, first.fileId, Date.now(), { log })).toBe(false);
    expect(onDisk(first.rel)).toBe(true);
    // ikisinin de süresi dolunca temizlenir
    await backdate('Invoice', 'deletedAt', first.invoiceId, '31 days');
    expect(await purgeInvoiceSourceFile(A.companyId, first.fileId, Date.now(), { log })).toBe(true);
    expect(onDisk(first.rel)).toBe(false);
  });

  it('başka firmanın dosyası etkilenmez (uç 404, doğrudan çağrı false)', async () => {
    const bPreview = await previewRow(B);
    await backdate('File', 'updatedAt', bPreview.id, '25 hours');
    const res = await discardViaApi(A, bPreview.id);
    expect(res.statusCode).toBe(404);
    expect(await discardPreviewFile(A.companyId, bPreview.id)).toBe(false);
    expect(await purgeInvoiceSourceFile(A.companyId, B.invoiceFileId, Date.now() + 365 * 24 * HOUR)).toBe(false);
    expect(await fileRow(bPreview.id)).toBeDefined();
    expect(onDisk(bPreview.rel)).toBe(true);
    expect(await fileRow(B.invoiceFileId)).toMatchObject({ purgedAt: null });

    // kendi firmasında uç siler; ikinci çağrı 404 (zaten silinmiş)
    const own = await previewRow(B);
    expect((await discardViaApi(B, own.id)).statusCode).toBe(204);
    expect(await fileRow(own.id)).toBeUndefined();
    expect(onDisk(own.rel)).toBe(false);
    expect((await discardViaApi(B, own.id)).statusCode).toBe(404);
  });

  it('yol firmanın klasöründe değilse satır silinir ama disk dosyasına dokunulmaz', async () => {
    // B'nin klasöründeki dosyayı gösteren A satırı (olmaması gereken durum)
    const bFile = await previewRow(B);
    const stray = await previewRow(A, { rel: bFile.rel });
    await sup.query(`DELETE FROM "File" WHERE id = $1`, [bFile.id]);
    const { warns, log } = quiet();
    expect(await discardPreviewFile(A.companyId, stray.id, { log })).toBe(true);
    expect(onDisk(bFile.rel)).toBe(true);
    expect(warns.some((w) => w.includes('outside the company folder'))).toBe(true);
  });

  it('bakım kapsamı taze satırı, canlı faturanın dosyasını ve fotoğrafı göremez', async () => {
    const fresh = await previewRow(A);
    const old = await previewRow(A);
    await backdate('File', 'updatedAt', old.id, '25 hours');
    await backdate('File', 'updatedAt', A.invoiceFileId, '400 days');
    await backdate('File', 'updatedAt', A.photoId, '400 days');
    const seen = await withMaintenanceScope(async () => (await prisma.file.findMany({ select: { id: true } })).map((r) => r.id));
    expect(seen).toContain(old.id);
    for (const id of [fresh.id, A.invoiceFileId, A.photoId]) expect(seen).not.toContain(id);
  });

  it('disk silme hatası turu düşürmez: satır işlenir, diğer adaylar sürer', async () => {
    const broken = await previewRow(A, { dir: true });
    const ok = await previewRow(A);
    await backdate('File', 'updatedAt', broken.id, '26 hours');
    await backdate('File', 'updatedAt', ok.id, '25 hours');
    const { warns, log } = quiet();
    const r = await runFileCleanup(Date.now(), log);
    expect(r.previews).toBeGreaterThanOrEqual(2);
    expect(await fileRow(broken.id)).toBeUndefined();
    expect(await fileRow(ok.id)).toBeUndefined();
    expect(onDisk(ok.rel)).toBe(false);
    expect(fs.statSync(abs(broken.rel)).isDirectory()).toBe(true);
    expect(warns.some((w) => w.includes('disk file could not be deleted'))).toBe(true);
  });

  it('iki kez çalışınca sonuç aynı', async () => {
    const p = await previewRow(B);
    await backdate('File', 'updatedAt', p.id, '25 hours');
    const inv = await invoiceWithFile(B);
    await deleteInvoice(B, inv.invoiceId);
    await backdate('Invoice', 'deletedAt', inv.invoiceId, '31 days');
    const { log } = quiet();
    await runFileCleanup(Date.now(), log);
    const purgedAt = (await fileRow(inv.fileId))?.purgedAt;
    expect(purgedAt).toBeInstanceOf(Date);
    expect(await fileRow(p.id)).toBeUndefined();

    const again = await runFileCleanup(Date.now() + HOUR, log);
    expect((await fileRow(inv.fileId))?.purgedAt).toEqual(purgedAt);
    expect(await discardPreviewFile(B.companyId, p.id)).toBe(false);
    expect(await purgeInvoiceSourceFile(B.companyId, inv.fileId)).toBe(false);
    // bu firmada ikinci turda işlenecek bir şey kalmadı
    expect(again.previews + again.purged).toBe(0);
  });

  it('içe aktarma ile tarama yarışı: içe aktarma önce kilitlerse dosya kalır', async () => {
    const p = await uploadPreview(A);
    await backdate('File', 'updatedAt', p.fileId, '25 hours');
    // içe aktarmanın yaptığını (fatura ekle + dosyaya bağla) açık bir işlemde, uygulama rolüyle yap
    const c = new pg.Client({ connectionString: TEST_DB_URL, options: '-c search_path=deciship' });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.company_id', $1, true)`, [A.companyId]);
      const invId = crypto.randomUUID();
      await c.query(
        `INSERT INTO "Invoice" (id, "companyId", "carrierId", "invoiceNo", "invoiceDate", currency, "sourceFileId", mapping, totals, "updatedAt")
         VALUES ($1, $2, $3, $4, now(), 'TRY', $5, '{}', '{}', now())`,
        [invId, A.companyId, A.carrierId, uniq('R'), p.fileId],
      );
      await c.query(`UPDATE "File" SET "invoiceId" = $1 WHERE id = $2`, [invId, p.fileId]);
      let settled = false;
      const discard = discardPreviewFile(A.companyId, p.fileId, { olderThan: new Date(Date.now() - PREVIEW_FILE_TTL_MS) }).finally(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false); // satır kilidini bekliyor
      await c.query('COMMIT');
      expect(await discard).toBe(false);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    expect(await fileRow(p.fileId)).toBeDefined();
    expect(onDisk(p.rel)).toBe(true);
  });

  it('içe aktarma ile tarama yarışı: temizlik önce biterse içe aktarma fatura yazamaz', async () => {
    const p = await uploadPreview(A);
    await backdate('File', 'updatedAt', p.fileId, '25 hours');
    await runFileCleanup(Date.now(), quiet().log);
    expect(await fileRow(p.fileId)).toBeUndefined();
    const res = await importFrom(A, p.fileId);
    expect(res.statusCode).toBe(404);
    expect((await sup.query(`SELECT 1 FROM "Invoice" WHERE "sourceFileId" = $1`, [p.fileId])).rowCount).toBe(0);
  });

  /** İçe aktarma ya 201 (dosya satırıyla, diskiyle, faturaya bağlı yerinde) ya açık 404 "yükleme bulunamadı" (fatura yok). 500 asla. */
  async function expectImportOutcome(res: Awaited<ReturnType<typeof importFrom>>, p: { fileId: string; rel: string }) {
    const invoices = (await sup.query(`SELECT id FROM "Invoice" WHERE "sourceFileId" = $1`, [p.fileId])).rows.map((r) => r.id);
    if (res.statusCode === 201) {
      expect(invoices).toEqual([res.json().invoice.id]);
      expect(await fileRow(p.fileId)).toMatchObject({ invoiceId: res.json().invoice.id, purgedAt: null });
      expect(onDisk(p.rel)).toBe(true);
      return 'imported' as const;
    }
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(invoices).toEqual([]);
    return 'gone' as const;
  }

  it('uzun içe aktarma sürerken vazgeçme (DELETE): ya 201 ve dosya yerinde, ya açık 404; 500 asla', async () => {
    const outcomes: string[] = [];
    for (const delay of [5, 30, 80, 150, 400]) {
      const p = await uploadPreview(A, { rows: 3000 });
      const imp = importFrom(A, p.fileId, { confirmOverlap: true });
      await new Promise((r) => setTimeout(r, delay));
      const del = await discardViaApi(A, p.fileId);
      // vazgeçme: önizleme sildiyse ya da içe aktarma kilitleyip bağladıysa 204; içe aktarma önce bitip... yine 204 (korundu)
      expect(del.statusCode).toBe(204);
      const outcome = await expectImportOutcome(await imp, p);
      if (outcome === 'gone') {
        expect(await fileRow(p.fileId)).toBeUndefined();
        expect(onDisk(p.rel)).toBe(false);
      }
      outcomes.push(outcome);
    }
    expect(outcomes).toHaveLength(5);
  });

  /** Dosya satırını açık bir işlemde kilitleyip (vazgeçme ya da temizlik gibi) içe aktarmayı o kilide takar. */
  async function underFileLock(f: Fixture, fileId: string, change: (c: pg.Client) => Promise<unknown>) {
    const c = new pg.Client({ connectionString: TEST_DB_URL, options: '-c search_path=deciship' });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.company_id', $1, true)`, [f.companyId]);
      await c.query(`SELECT id FROM "File" WHERE id = $1 FOR UPDATE`, [fileId]);
      let settled = false;
      const imp = importFrom(f, fileId).finally(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 600));
      expect(settled).toBe(false); // içe aktarma işlem içinde dosya kilidini bekliyor
      await change(c);
      await c.query('COMMIT');
      return await imp;
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }

  it('içe aktarma işlem içinde dosyayı yeniden denetler: kilit beklerken silinen önizleme → 404, fatura yok', async () => {
    const p = await uploadPreview(A);
    const res = await underFileLock(A, p.fileId, (c) => c.query(`DELETE FROM "File" WHERE id = $1`, [p.fileId]));
    expect(await expectImportOutcome(res, p)).toBe('gone');
  });

  it('içe aktarma işlem içinde dosyayı yeniden denetler: kilit beklerken temizlenen dosya → 404, fatura yok', async () => {
    const p = await uploadPreview(A);
    const res = await underFileLock(A, p.fileId, (c) => c.query(`UPDATE "File" SET "purgedAt" = now() WHERE id = $1`, [p.fileId]));
    expect(await expectImportOutcome(res, p)).toBe('gone');
    expect(await fileRow(p.fileId)).toMatchObject({ invoiceId: null });
  });

  it('temizlenmiş dosyadan fatura yazılmaz (tablo bellekte olsa bile): 404', async () => {
    const p = await uploadPreview(A); // önizleme tabloyu belleğe aldı
    await sup.query(`UPDATE "File" SET "purgedAt" = now() WHERE id = $1`, [p.fileId]);
    const res = await importFrom(A, p.fileId);
    expect(res.statusCode, res.body).toBe(404);
    expect((await sup.query(`SELECT 1 FROM "Invoice" WHERE "sourceFileId" = $1`, [p.fileId])).rowCount).toBe(0);
  });

  it('vazgeçme kişiye bağlı: başka üyenin açık önizlemesi 404 ve yerinde; bakım ve kanca etkilenmez', async () => {
    const auditor = await createMember(app, A.admin.auth, 'AUDITOR', 'Denetleyici Test');
    const adminPreview = await uploadPreview(A);
    const res = await app.inject({ method: 'DELETE', url: `${API}/invoices/preview/${adminPreview.fileId}`, headers: auditor.auth });
    expect(res.statusCode).toBe(404);
    expect(await fileRow(adminPreview.fileId)).toBeDefined();
    expect(onDisk(adminPreview.rel)).toBe(true);

    // kendi önizlemesini siler
    const own = await uploadPreview(A, { auth: auditor.auth });
    expect((await app.inject({ method: 'DELETE', url: `${API}/invoices/preview/${own.fileId}`, headers: auditor.auth })).statusCode).toBe(204);
    expect(await fileRow(own.fileId)).toBeUndefined();

    // bakım ve iş kancası kişiden bağımsız: yöneticinin unutulan önizlemesini siler
    expect(await discardPreviewFile(A.companyId, adminPreview.fileId)).toBe(true);
    expect(onDisk(adminPreview.rel)).toBe(false);
  });

  // Dosyanın son testi kalmalı: en sonda bütün adayları işleyen bir tur var.
  it('Y94: korunan aday tur sınırını doldurursa sonraki tur ondan sonrakine geçer (imleç); liste bitince baştan', async () => {
    const kept = await invoiceWithFile(A);
    await sup.query(`UPDATE "File" SET "invoiceId" = NULL WHERE id = $1`, [kept.fileId]);
    await backdate('File', 'updatedAt', kept.fileId, '3650 days');
    const free = await previewRow(A);
    await backdate('File', 'updatedAt', free.id, '3000 days');
    const { log } = quiet();

    // imleç yokken (eski davranış): sınır 1 ise korunan aday her turda yeniden gelir, sonraki hiç denenmez
    expect((await runFileCleanup(Date.now(), log, { batch: 1, cursor: { previews: null, purges: null } })).previews).toBe(0);
    expect(await fileRow(free.id)).toBeDefined();

    const cursor: FileCleanupCursor = { previews: null, purges: null };
    expect((await runFileCleanup(Date.now(), log, { batch: 1, cursor })).previews).toBe(0);
    expect(cursor.previews).toMatchObject({ id: kept.fileId });
    expect((await runFileCleanup(Date.now(), log, { batch: 1, cursor })).previews).toBe(1);
    expect(await fileRow(free.id)).toBeUndefined();
    expect(onDisk(free.rel)).toBe(false);
    // korunan dosya yerinde
    expect(await fileRow(kept.fileId)).toMatchObject({ purgedAt: null });
    expect(onDisk(kept.rel)).toBe(true);

    // sayfa dolmazsa liste bitmiştir: imleç sıfırlanır, sonraki tur baştan başlar
    const whole: FileCleanupCursor = { previews: null, purges: null };
    await runFileCleanup(Date.now(), log, { batch: 10_000, cursor: whole });
    expect(whole).toEqual({ previews: null, purges: null });
    expect(await fileRow(kept.fileId)).toMatchObject({ purgedAt: null });
  });
});
