/**
 * Silinenlerin kalıcı temizliği (kullanıcı kararı 2026-11-12; `services/deletedPurge.ts`; bağımsız inceleme bulguları
 * T1–T6 dahil). Asıl soru veri kaybı: canlı kayıt, itiraz kaydı ve kanıtı (bugün bağı kopmuş olsa da), eski sürüm
 * fotoğrafı, başka firmanın verisi ve paylaşılan dosya hiçbir yoldan silinmemeli; süresi dolan silinmiş fatura ve silinmiş
 * ölçümün fotoğrafı ise açıkken gerçekten gitmeli. Saat: veritabanı saati; kayıt tarihleri geriye itilir.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, withCompany } from '../src/db.ts';
import { env, invalidEnv, parsePurgeDays } from '../src/env.ts';
import { parsePurgePreviewArgs, runPurgePreviewCli } from '../src/cli/purgePreview.ts';
import { previewDeletedPurge, purgeDeletedInvoice, purgeMeasurementPhoto, runDeletedPurge, type PurgeCursor } from '../src/services/deletedPurge.ts';
import { runFileCleanup } from '../src/services/fileCleanup.ts';
import { runMaintenance } from '../src/services/maintenance.ts';
import { drainMeasurementQueue } from '../src/services/measurementQueue.ts';
import { setFxService } from '../src/services/fx.ts';
import { companyFixture, type Fixture } from './fixtures.ts';
import { digestOf, disputeCompany, invoiceWithDiffs, trDay, type DisputeCompany } from './disputeHelpers.ts';
import { anyDayFx } from './fxFake.ts';
import { getApp, measurementPayload, multipart, uniq } from './helpers.ts';
import { testSuperDbUrl } from './testEnv.ts';

// bakım işi bütün firmalarda bekleyen karşılaştırmayı tamamlar; önceki dosyaların dövizli faturaları kur ister
beforeAll(() => setFxService(anyDayFx({ USD: 40.05, EUR: 44.1, GBP: 50.2 })));
afterAll(() => setFxService(null));

const API = '/api/deciship';
const VARS = ['DELETED_INVOICE_PURGE_DAYS', 'DELETED_MEASUREMENT_PHOTO_PURGE_DAYS'] as const;
type Auth = { authorization: string };
type Co = { companyId: string; carrierId: string; admin: Auth; worker: Auth };

/** Ortam değişkenlerini bir iş boyunca değiştirir, sonra geri koyar. */
async function withEnv<T>(values: Partial<Record<(typeof VARS)[number], string | undefined>>, work: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await work();
  } finally {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('silinenlerin kalıcı temizliği', () => {
  let app: FastifyInstance;
  let A: Fixture;
  let B: Fixture;
  let sup: pg.Client;

  const abs = (rel: string) => path.join(env.storageDir, rel);
  const onDisk = (rel: string) => fs.existsSync(abs(rel));
  const backdate = (table: string, column: string, id: string, interval: string) =>
    sup.query(`UPDATE "${table}" SET "${column}" = (now() AT TIME ZONE 'UTC') - $2::interval WHERE id = $1`, [id, interval]);
  const count = async (sql: string, params: unknown[]) => (await sup.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0]!.n;
  const fileRow = async (id: string) => (await sup.query<{ id: string; path: string; purgedAt: Date | null }>(`SELECT id, path, "purgedAt" FROM "File" WHERE id = $1`, [id])).rows[0];
  const quiet = () => {
    const warns: string[] = [];
    return { warns, log: { warn: (_o: unknown, msg: string) => void warns.push(msg) } };
  };
  const co = (f: Fixture | DisputeCompany): Co =>
    'companyId' in f ? { companyId: f.companyId, carrierId: f.carrierId, admin: f.admin.auth, worker: f.worker.auth } : { companyId: f.admin.companyId, carrierId: f.carrierId, admin: f.admin.auth, worker: f.worker.auth };
  const call = (auth: Auth, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url: `${API}${url}`, headers: auth, ...(payload === undefined ? {} : { payload: payload as object }) });

  // ---------- fatura yardımcıları ----------
  async function uploadInvoice(c: Co, trackings: string[], over: Record<string, unknown> = {}) {
    const csv = ['Takip No;Desi;Tutar', ...trackings.map((t) => `${t};5;50`)].join('\n');
    const form = multipart([
      { name: 'carrierId', value: c.carrierId },
      { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
    ]);
    const pre = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...c.admin, ...form.headers }, payload: form.payload });
    expect(pre.statusCode, pre.body).toBe(200);
    const fileId = pre.json().fileId as string;
    const res = await call(c.admin, 'POST', '/invoices', {
      fileId,
      carrierId: c.carrierId,
      invoiceNo: uniq('P'),
      invoiceDate: '2026-10-15',
      currency: 'TRY',
      mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
      acknowledgeIssues: true,
      ...over,
    });
    expect(res.statusCode, res.body).toBe(201);
    const invoiceId = res.json().invoice.id as string;
    return { invoiceId, fileId, rel: (await fileRow(fileId))!.path };
  }
  const deleteInvoice = async (c: Co, id: string) => {
    const r = await call(c.admin, 'DELETE', `/invoices/${id}`);
    expect(r.statusCode, r.body).toBe(204);
  };
  const invoiceExists = (id: string) => count(`"Invoice" WHERE id = $1`, [id]).then((n) => n === 1);
  const lineCount = (invoiceId: string) => count(`"InvoiceLine" WHERE "invoiceId" = $1`, [invoiceId]);
  const sendDispute = async (auth: Auth, invoiceId: string) => {
    const r = await call(auth, 'POST', `/invoices/${invoiceId}/disputes`, { sentOn: trDay(-2), channel: 'EMAIL', selectionDigest: await digestOf(app, auth, invoiceId) });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().dispute.active as { id: string; version: number; lines: { id: string; claimedAmount: number }[] };
  };

  // ---------- ölçüm yardımcıları ----------
  async function measure(c: Co, photos = 2, over: Record<string, unknown> = {}) {
    const p = measurementPayload(over, photos);
    const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...c.worker, ...p.headers }, payload: p.payload });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().measurement.id as string;
    return { id, trackingNo: r.json().measurement.trackingNo as string, files: await photoRows(id) };
  }
  const photoRows = async (measurementId: string) =>
    (await sup.query<{ id: string; path: string; kind: string }>(`SELECT id, path, kind FROM "File" WHERE "measurementId" = $1 ORDER BY "createdAt", id`, [measurementId])).rows;
  const lineMeasurement = async (lineId: string) => (await sup.query(`SELECT "measurementId" FROM "InvoiceLine" WHERE id = $1`, [lineId])).rows[0]!.measurementId as string | null;
  const deleteMeasurement = async (c: Co, id: string) => {
    const r = await call(c.admin, 'DELETE', `/measurements/${id}`);
    expect(r.statusCode, r.body).toBe(204);
    await drainMeasurementQueue(10_000);
  };
  type RunOpts = { log?: { warn: (o: unknown, m: string) => void }; invoiceBatch?: number; photoBatch?: number; cursor?: PurgeCursor };
  const purgeCompanies = (ids: string[], o: RunOpts = {}) =>
    runDeletedPurge(o.log ?? quiet().log, { companyIds: ids, invoiceDays: 30, photoDays: 30, invoiceBatch: o.invoiceBatch, photoBatch: o.photoBatch, cursor: o.cursor });
  const purgeCompany = (c: Co | string, o: RunOpts = {}) => purgeCompanies([typeof c === 'string' ? c : c.companyId], o);

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

  // =================================================================================================================
  describe('süre ayarı (varsayılan kapalı)', () => {
    it('boş, off ve sıfır dizileri kapalı; en az 7; bozuk değer açılışı durdurur (T5)', () => {
      for (const off of [undefined, '', ' ', 'off', 'OFF', ' false ', 'no', '0', '00', '000']) expect(parsePurgeDays(off), JSON.stringify(off)).toEqual({ ok: true, days: null });
      expect(parsePurgeDays('30')).toEqual({ ok: true, days: 30 });
      expect(parsePurgeDays(' 45 ')).toEqual({ ok: true, days: 45 });
      expect(parsePurgeDays('3')).toEqual({ ok: true, days: 7 });
      expect(parsePurgeDays('0007')).toEqual({ ok: true, days: 7 });
      for (const bad of ['30d', '-5', '2.5', 'kapalı', '1e3', '+30', '1000000']) expect(parsePurgeDays(bad).ok, bad).toBe(false);
      expect(invalidEnv({ DELETED_INVOICE_PURGE_DAYS: '30d' }).join()).toContain('DELETED_INVOICE_PURGE_DAYS');
      expect(invalidEnv({ DELETED_MEASUREMENT_PHOTO_PURGE_DAYS: 'x' }).join()).toContain('DELETED_MEASUREMENT_PHOTO_PURGE_DAYS');
      expect(invalidEnv({ DELETED_INVOICE_PURGE_DAYS: 'off', DELETED_MEASUREMENT_PHOTO_PURGE_DAYS: '60' })).toEqual([]);
      // komut satırı aynı kural
      expect(parsePurgePreviewArgs(['--invoice-days', '0', '--photo-days', '00'])).toMatchObject({ invoiceDays: null, photoDays: null });
      expect(parsePurgePreviewArgs(['--invoice-days', 'off', '--photo-days', '3'])).toMatchObject({ invoiceDays: null, photoDays: 7 });
    });

    it('değişken boşken (varsayılan) ve off iken bakım turu hiçbir şey silmez; 30 yazılınca siler', async () => {
      const c = co(await disputeCompany(app));
      const inv = await uploadInvoice(c, [uniq('81')]);
      await deleteInvoice(c, inv.invoiceId);
      await backdate('Invoice', 'deletedAt', inv.invoiceId, '400 days');
      const m = await measure(c, 1);
      await deleteMeasurement(c, m.id);
      await backdate('Measurement', 'deletedAt', m.id, '400 days');
      for (const v of [undefined, 'off']) {
        await withEnv({ DELETED_INVOICE_PURGE_DAYS: v, DELETED_MEASUREMENT_PHOTO_PURGE_DAYS: v }, async () => {
          expect(env.deletedInvoicePurgeDays).toBeNull();
          expect(await runDeletedPurge(quiet().log, { companyIds: [c.companyId] })).toEqual({ invoices: 0, photos: 0 });
          expect(await purgeDeletedInvoice(c.companyId, inv.invoiceId)).toBe(false);
          expect(await purgeMeasurementPhoto(c.companyId, m.files[0]!.id)).toBe(false);
        });
      }
      expect(await invoiceExists(inv.invoiceId)).toBe(true);
      expect(await fileRow(m.files[0]!.id)).toBeDefined();
      await withEnv({ DELETED_INVOICE_PURGE_DAYS: '30', DELETED_MEASUREMENT_PHOTO_PURGE_DAYS: '30' }, async () => {
        expect(await runDeletedPurge(quiet().log, { companyIds: [c.companyId] })).toEqual({ invoices: 1, photos: 1 });
      });
    });
  });

  // =================================================================================================================
  describe('silinen fatura', () => {
    it('30 gün dolmadan kalır; dolunca fatura, satırları, işareti ve kaynak dosyası kalıcı silinir (veritabanı saati)', async () => {
      const c = co(await disputeCompany(app));
      const inv = await uploadInvoice(c, [uniq('82'), uniq('82')]);
      expect(await lineCount(inv.invoiceId)).toBe(2);
      await deleteInvoice(c, inv.invoiceId);
      await sup.query(`INSERT INTO "InvoiceRecheck" ("invoiceId", "companyId", "pendingAt") VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`, [inv.invoiceId, c.companyId]);

      await backdate('Invoice', 'deletedAt', inv.invoiceId, '29 days 23 hours');
      expect(await purgeDeletedInvoice(c.companyId, inv.invoiceId, { days: 30 })).toBe(false);
      expect(await purgeCompany(c)).toEqual({ invoices: 0, photos: 0 });
      expect(await invoiceExists(inv.invoiceId)).toBe(true);
      expect(onDisk(inv.rel)).toBe(true);

      await backdate('Invoice', 'deletedAt', inv.invoiceId, '30 days 1 hour');
      expect(await purgeCompany(c)).toEqual({ invoices: 1, photos: 0 });
      expect(await invoiceExists(inv.invoiceId)).toBe(false);
      expect(await lineCount(inv.invoiceId)).toBe(0);
      expect(await count(`"InvoiceRecheck" WHERE "invoiceId" = $1`, [inv.invoiceId])).toBe(0);
      expect(await fileRow(inv.fileId)).toBeUndefined();
      expect(onDisk(inv.rel)).toBe(false);
      const audit = await sup.query(`SELECT "userId", data FROM "AuditLog" WHERE "entityId" = $1 AND action = 'invoice.purge'`, [inv.invoiceId]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].userId).toBeNull();
      expect(audit.rows[0].data).toMatchObject({ lines: 2, files: 1 });
      expect(await purgeCompany(c)).toEqual({ invoices: 0, photos: 0 });
    });

    it('dosyası 30 günlük dosya temizliğinde zaten diskten kalkmışsa (purgedAt) kayıt da gider', async () => {
      const c = co(await disputeCompany(app));
      const inv = await uploadInvoice(c, [uniq('83')]);
      await deleteInvoice(c, inv.invoiceId);
      await backdate('Invoice', 'deletedAt', inv.invoiceId, '31 days');
      await runFileCleanup(Date.now(), quiet().log);
      expect((await fileRow(inv.fileId))?.purgedAt).toBeInstanceOf(Date);
      expect(await purgeCompany(c)).toEqual({ invoices: 1, photos: 0 });
      expect(await fileRow(inv.fileId)).toBeUndefined();
    });

    it('itiraz kaydı olan fatura (geri çekilmiş tur dahil) kalıcı silinmez; satırları, itirazı ve dosyası kalır', async () => {
      const c = co(A);
      await deleteInvoice(c, A.invoiceId); // fikstürün turu geri çekilmiş: silme serbest
      await backdate('Invoice', 'deletedAt', A.invoiceId, '4000 days');
      const lines = await lineCount(A.invoiceId);
      expect(await purgeDeletedInvoice(A.companyId, A.invoiceId, { days: 7 })).toBe(false);
      expect(await purgeCompany(c)).toMatchObject({ invoices: 0 });
      expect(await invoiceExists(A.invoiceId)).toBe(true);
      expect(await lineCount(A.invoiceId)).toBe(lines);
      expect(await count(`"Dispute" WHERE "invoiceId" = $1`, [A.invoiceId])).toBe(1);
      expect(await count(`"DisputeResult" WHERE "disputeId" = $1`, [A.disputeId])).toBe(1);
      expect(await fileRow(A.invoiceFileId)).toBeDefined();
      const p = await previewDeletedPurge({ companyIds: [A.companyId], invoiceDays: 30, photoDays: 30 });
      expect(p.totals.invoicesKeptForDispute).toBeGreaterThanOrEqual(1);
    });

    it('etkin itirazı olan fatura silinemez; elle silinmiş işaretlense bile itiraz kaydı korur', async () => {
      const d = await disputeCompany(app);
      const inv = await invoiceWithDiffs(app, d, [80]);
      await sendDispute(d.admin.auth, inv.invoiceId);
      expect((await call(d.admin.auth, 'DELETE', `/invoices/${inv.invoiceId}`)).statusCode).toBe(409);
      await sup.query(`UPDATE "Invoice" SET "deletedAt" = (now() AT TIME ZONE 'UTC') - interval '400 days' WHERE id = $1`, [inv.invoiceId]);
      try {
        expect(await purgeCompany(co(d))).toMatchObject({ invoices: 0 });
        expect(await invoiceExists(inv.invoiceId)).toBe(true);
      } finally {
        await sup.query(`UPDATE "Invoice" SET "deletedAt" = NULL WHERE id = $1`, [inv.invoiceId]);
      }
    });

    it('canlı fatura ne kadar eski olursa olsun silinmez', async () => {
      await backdate('Invoice', 'createdAt', B.invoiceId, '4000 days');
      await backdate('Invoice', 'updatedAt', B.invoiceId, '4000 days');
      expect(await purgeDeletedInvoice(B.companyId, B.invoiceId, { days: 7 })).toBe(false);
      await runDeletedPurge(quiet().log, { companyIds: [B.companyId], invoiceDays: 7, photoDays: null });
      expect(await invoiceExists(B.invoiceId)).toBe(true);
      expect(await fileRow(B.invoiceFileId)).toMatchObject({ purgedAt: null });
      expect(onDisk((await fileRow(B.invoiceFileId))!.path)).toBe(true);
    });

    it('başka firmanın faturası etkilenmez: başka firma bağlamından çağrı false, tur yalnız kendi firmasını siler', async () => {
      const x = co(await disputeCompany(app));
      const y = co(await disputeCompany(app));
      const xi = await uploadInvoice(x, [uniq('84')]);
      const yi = await uploadInvoice(y, [uniq('84')]);
      const yLive = await uploadInvoice(y, [uniq('85')]);
      for (const [c, i] of [[x, xi], [y, yi]] as const) {
        await deleteInvoice(c, i.invoiceId);
        await backdate('Invoice', 'deletedAt', i.invoiceId, '40 days');
      }
      expect(await purgeDeletedInvoice(x.companyId, yi.invoiceId, { days: 30 })).toBe(false);
      expect(await purgeCompany(x)).toEqual({ invoices: 1, photos: 0 });
      expect(await invoiceExists(xi.invoiceId)).toBe(false);
      expect(await invoiceExists(yi.invoiceId)).toBe(true);
      expect(onDisk(yi.rel)).toBe(true);
      expect(await purgeCompanies([x.companyId, y.companyId])).toEqual({ invoices: 1, photos: 0 });
      expect(await invoiceExists(yi.invoiceId)).toBe(false);
      expect(await invoiceExists(yLive.invoiceId)).toBe(true);
      expect(onDisk(yLive.rel)).toBe(true);
    });

    it('kaynak dosyayı başka (canlı) fatura da gösteriyorsa dosya kaydı ve diski kalır, yalnız fatura gider', async () => {
      const c = co(await disputeCompany(app));
      const first = await uploadInvoice(c, [uniq('86')]);
      const second = await call(c.admin, 'POST', '/invoices', {
        fileId: first.fileId,
        carrierId: c.carrierId,
        invoiceNo: uniq('P'),
        invoiceDate: '2026-10-16',
        currency: 'TRY',
        mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
        acknowledgeIssues: true,
        confirmOverlap: true,
      });
      expect(second.statusCode, second.body).toBe(201);
      const secondId = second.json().invoice.id as string;
      await deleteInvoice(c, secondId);
      await backdate('Invoice', 'deletedAt', secondId, '40 days');
      expect(await purgeCompany(c)).toEqual({ invoices: 1, photos: 0 });
      expect(await invoiceExists(secondId)).toBe(false);
      expect(await invoiceExists(first.invoiceId)).toBe(true);
      expect(await fileRow(first.fileId)).toMatchObject({ purgedAt: null });
      expect(onDisk(first.rel)).toBe(true);
      expect((await call(c.admin, 'GET', `/files/${first.fileId}`)).statusCode).toBe(200);
    });

    it('disk dosyası işlem kapandıktan sonra silinir: disk hatası yetim dosya bırakır, veri tutarlı (T6)', async () => {
      const c = co(await disputeCompany(app));
      const inv = await uploadInvoice(c, [uniq('87')]);
      const src = (await sup.query(`SELECT "createdById" FROM "File" WHERE id = $1`, [inv.fileId])).rows[0].createdById as string;
      // faturaya bağlı ikinci kaynak dosya: diski silinemeyen klasör
      const strayRel = `${c.companyId}/2026-11/purge-${uniq('s')}.csv`;
      fs.mkdirSync(abs(strayRel), { recursive: true });
      fs.writeFileSync(path.join(abs(strayRel), 'x.txt'), 'x');
      const strayId = `purge-stray-${uniq('f')}`;
      await sup.query(
        `INSERT INTO "File" (id, "companyId", kind, mime, size, path, sha256, "invoiceId", "createdById", "createdAt", "updatedAt") VALUES ($1, $2, 'INVOICE_SOURCE', 'text/csv', 1, $3, 'x', $4, $5, now(), now())`,
        [strayId, c.companyId, strayRel, inv.invoiceId, src],
      );
      await deleteInvoice(c, inv.invoiceId);
      await backdate('Invoice', 'deletedAt', inv.invoiceId, '40 days');
      const { warns, log } = quiet();
      try {
        expect(await purgeDeletedInvoice(c.companyId, inv.invoiceId, { days: 30, log })).toBe(true);
        // veri: fatura, satırlar ve iki dosya kaydı gitti; kaynak dosyanın diski gitti; silinemeyen disk yetim kaldı
        expect(await invoiceExists(inv.invoiceId)).toBe(false);
        expect(await lineCount(inv.invoiceId)).toBe(0);
        expect(await fileRow(inv.fileId)).toBeUndefined();
        expect(await fileRow(strayId)).toBeUndefined();
        expect(onDisk(inv.rel)).toBe(false);
        expect(onDisk(strayRel)).toBe(true);
        expect(warns.some((w) => w.includes('orphan file left'))).toBe(true);
      } finally {
        fs.rmSync(abs(strayRel), { recursive: true, force: true });
      }
    });

    it('tur sınırı: bir turda en çok N fatura, kalanı sonraki turda (en eski silinen önce)', async () => {
      const c = co(await disputeCompany(app));
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const inv = await uploadInvoice(c, [uniq('88')]);
        await deleteInvoice(c, inv.invoiceId);
        await backdate('Invoice', 'deletedAt', inv.invoiceId, `${40 + i} days`);
        ids.push(inv.invoiceId);
      }
      const cursor: PurgeCursor = { invoices: null, photos: null, failed: new Set() };
      expect(await purgeCompany(c, { invoiceBatch: 2, cursor })).toEqual({ invoices: 2, photos: 0 });
      expect(await invoiceExists(ids[2]!)).toBe(false);
      expect(await invoiceExists(ids[1]!)).toBe(false);
      expect(await invoiceExists(ids[0]!)).toBe(true);
      expect(await purgeCompany(c, { invoiceBatch: 2, cursor })).toEqual({ invoices: 1, photos: 0 });
      expect(await invoiceExists(ids[0]!)).toBe(false);
    });

    it('imleç yalnız sınırın dolduğu firmada yazılır; düşen adaylar sona alınır: sonraki firma aç kalmaz (T4)', async () => {
      const x = co(await disputeCompany(app));
      const y = co(await disputeCompany(app));
      const [first, second] = [x, y].sort((p, r) => (p.companyId < r.companyId ? -1 : 1)) as [Co, Co];
      const failing: string[] = [];
      for (let i = 0; i < 2; i++) {
        const inv = await uploadInvoice(first, [uniq('93')]);
        await deleteInvoice(first, inv.invoiceId);
        await backdate('Invoice', 'deletedAt', inv.invoiceId, '40 days');
        failing.push(inv.invoiceId);
      }
      const good = await uploadInvoice(second, [uniq('93')]);
      await deleteInvoice(second, good.invoiceId);
      await backdate('Invoice', 'deletedAt', good.invoiceId, '40 days');
      // ilk firmanın adayları düşer: dosyasında süren iş var (her denemede false, satır kalır)
      for (const id of failing) {
        const fileId = (await sup.query(`SELECT "sourceFileId" FROM "Invoice" WHERE id = $1`, [id])).rows[0].sourceFileId as string;
        await withCompany(first.companyId, () =>
          prisma.job.create({ data: { companyId: first.companyId, kind: 'INVOICE_PDF_READ', status: 'RUNNING', dedupeKey: `purge:${uniq('j')}`, refType: 'File', refId: fileId, input: {} } }),
        );
      }
      const cursor: PurgeCursor = { invoices: null, photos: null, failed: new Set() };
      const ids = [first.companyId, second.companyId];
      // tur 1: sınır (2) ilk firmada doldu → imleç ilk firma; fotoğraf bütçesi dolmadığı için imleç ikinciye kaymaz
      await purgeCompanies(ids, { invoiceBatch: 2, cursor });
      expect(cursor.invoices).toBe(first.companyId);
      expect(cursor.photos).toBeNull();
      // tur 2: ikinci firmadan başlar
      expect(await purgeCompanies(ids, { invoiceBatch: 2, cursor })).toMatchObject({ invoices: 1 });
      expect(await invoiceExists(good.invoiceId)).toBe(false);
      for (const id of failing) expect(await invoiceExists(id)).toBe(true);
      await sup.query(`DELETE FROM "Job" WHERE "companyId" = $1`, [first.companyId]);
    });

    it('mükerrer sonuçları, Pano ve Merkez sayıları kalıcı silmeden sonra değişmez', async () => {
      const d = await disputeCompany(app);
      const c = co(d);
      const t = [uniq('89'), uniq('89'), uniq('89')];
      const x = await uploadInvoice(c, t);
      const y = await uploadInvoice(c, t, { confirmOverlap: true });
      const yLines = async () =>
        (
          await sup.query(
            `SELECT id, status, "diffTypes", "expectedAmount"::text, "diffAmount"::text, decision, "recalcPending", "prevResult", "measurementId" FROM "InvoiceLine" WHERE "invoiceId" = $1 ORDER BY "rowIndex"`,
            [y.invoiceId],
          )
        ).rows;
      expect((await yLines()).every((l) => (l.diffTypes as string[]).includes('DUPLICATE'))).toBe(true);
      const frozen = (await yLines())[0]!.id as string;
      const decided = await call(c.admin, 'PATCH', `/invoice-lines/${frozen}`, { decision: 'ACCEPTED', reason: 'kabul' });
      expect(decided.statusCode, decided.body).toBe(200);
      await deleteInvoice(c, x.invoiceId);
      await drainMeasurementQueue(10_000);
      await runMaintenance(Date.now(), quiet().log);
      expect(await count(`"InvoiceRecheck" WHERE "invoiceId" = $1`, [y.invoiceId])).toBe(0);
      expect(await invoiceExists(x.invoiceId)).toBe(true);

      const snap = async () => ({
        lines: await yLines(),
        invoice: (await sup.query(`SELECT totals, "calculatedAt" FROM "Invoice" WHERE id = $1`, [y.invoiceId])).rows[0],
        pano: (await call(c.admin, 'GET', '/dashboard?month=2026-10')).json(),
        hub: (await call(c.admin, 'GET', '/platform/overview')).json(),
        list: (await call(c.admin, 'GET', '/invoices')).json(),
      });
      const before = await snap();
      expect(before.lines.some((l) => (l.diffTypes as string[]).includes('DUPLICATE'))).toBe(true);
      await backdate('Invoice', 'deletedAt', x.invoiceId, '31 days');
      expect(await purgeCompany(c)).toEqual({ invoices: 1, photos: 0 });
      expect(await invoiceExists(x.invoiceId)).toBe(false);
      const after = await snap();
      expect(after.lines).toEqual(before.lines);
      expect(after.invoice).toEqual(before.invoice);
      expect(after.pano).toEqual(before.pano);
      expect(after.list).toEqual(before.list);
      const strip = (h: Record<string, unknown>) => {
        const { generatedAt: _g, asOf: _a, ...rest } = h;
        return rest;
      };
      expect(strip(after.hub)).toEqual(strip(before.hub));
      const z = await uploadInvoice(c, [t[1]!], { confirmOverlap: true });
      const zl = (await sup.query(`SELECT "diffTypes" FROM "InvoiceLine" WHERE "invoiceId" = $1`, [z.invoiceId])).rows;
      expect(zl.every((l) => (l.diffTypes as string[]).includes('DUPLICATE'))).toBe(true);
    });
  });

  // =================================================================================================================
  describe('silinen ölçümün fotoğrafları', () => {
    it('30 gün dolmadan kalır; dolunca fotoğraf kayıtları ve diskleri silinir, ölçüm kaydı kalır ve geri yüklenebilir', async () => {
      const c = co(await disputeCompany(app));
      const m = await measure(c, 2);
      await deleteMeasurement(c, m.id);
      await backdate('Measurement', 'deletedAt', m.id, '29 days 23 hours');
      expect(await purgeCompany(c)).toEqual({ invoices: 0, photos: 0 });
      for (const f of m.files) expect(onDisk(f.path)).toBe(true);

      await backdate('Measurement', 'deletedAt', m.id, '30 days 1 hour');
      expect(await purgeCompany(c)).toEqual({ invoices: 0, photos: 2 });
      expect(await photoRows(m.id)).toEqual([]);
      for (const f of m.files) expect(onDisk(f.path)).toBe(false);
      const row = (await sup.query(`SELECT "lengthCm"::text, "weightKg"::text, "deletedAt" FROM "Measurement" WHERE id = $1`, [m.id])).rows[0];
      expect(row).toMatchObject({ lengthCm: '40.0', weightKg: '4.000' });
      expect(row.deletedAt).toBeInstanceOf(Date);
      const detail = await call(c.admin, 'GET', `/measurements/${m.id}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.json().measurement).toMatchObject({ photoCount: 0, photos: [], deleted: true });
      const restored = await call(c.admin, 'POST', `/measurements/${m.id}/restore`);
      expect(restored.statusCode, restored.body).toBe(200);
      expect(restored.json().measurement).toMatchObject({ photoCount: 0, deleted: false });
    });

    it('30 gün dolmadan geri yüklenen ölçüm aday olmaktan çıkar; canlı ölçümün fotoğrafına dokunulmaz', async () => {
      const c = co(await disputeCompany(app));
      const m = await measure(c, 2);
      await deleteMeasurement(c, m.id);
      await backdate('Measurement', 'deletedAt', m.id, '20 days');
      expect((await call(c.admin, 'POST', `/measurements/${m.id}/restore`)).statusCode).toBe(200);
      await backdate('Measurement', 'createdAt', m.id, '4000 days');
      await backdate('Measurement', 'measuredAt', m.id, '4000 days');
      expect(await runDeletedPurge(quiet().log, { companyIds: [c.companyId], invoiceDays: 7, photoDays: 7 })).toEqual({ invoices: 0, photos: 0 });
      for (const f of m.files) expect(await purgeMeasurementPhoto(c.companyId, f.id, { days: 7 })).toBe(false);
      expect(await photoRows(m.id)).toHaveLength(2);
      for (const f of m.files) expect(onDisk(f.path)).toBe(true);
      expect(await purgeMeasurementPhoto(B.companyId, B.photoId, { days: 7 })).toBe(false);
      expect(await fileRow(B.photoId)).toMatchObject({ purgedAt: null });
    });

    it('eski sürümün fotoğrafı silinmez (düzeltmede kaldırılan dahil); silinen son sürümün yalnız kendi satırları gider, paylaşılan disk kalır', async () => {
      const c = co(await disputeCompany(app));
      const v1 = await measure(c, 2);
      expect(v1.files).toHaveLength(2);
      const box = v1.files.find((f) => f.kind === 'PHOTO_BOX')!;
      const scale = v1.files.find((f) => f.kind === 'PHOTO_SCALE')!;
      const r = await call(c.admin, 'PATCH', `/measurements/${v1.id}`, { weightKg: 5, removePhotoIds: [scale.id] });
      expect(r.statusCode, r.body).toBe(200);
      const v2 = r.json().measurement.id as string;
      const v2Files = await photoRows(v2);
      expect(v2Files.map((f) => f.path)).toEqual([box.path]);
      await drainMeasurementQueue(10_000);
      // eski sürüm çok eskiden yerini bıraktı: yine silinmez (ayrı karar)
      await backdate('Measurement', 'createdAt', v2, '400 days');
      await backdate('Measurement', 'createdAt', v1.id, '401 days');
      expect(await purgeCompany(c)).toEqual({ invoices: 0, photos: 0 });
      expect(await photoRows(v1.id)).toHaveLength(2);
      expect(onDisk(scale.path)).toBe(true);
      // son sürüm silinip süre dolunca: yalnız v2'nin satırı; v1 satırları ve paylaşılan kutu diski kalır
      await deleteMeasurement(c, v2);
      await backdate('Measurement', 'deletedAt', v2, '31 days');
      expect(await purgeCompany(c)).toEqual({ invoices: 0, photos: 1 });
      expect(await photoRows(v2)).toEqual([]);
      expect(await photoRows(v1.id)).toHaveLength(2);
      expect(onDisk(box.path)).toBe(true);
      expect(onDisk(scale.path)).toBe(true);
      expect(await purgeCompany(c)).toEqual({ invoices: 0, photos: 0 });
    });

    it('itiraz turundaki satırın ölçümü, itiraz listesi ve uyumlu kararlı satırın ölçümü korunur; kararsız satırınki silinir', async () => {
      const d = await disputeCompany(app);
      const c = co(d);
      const sentInv = await invoiceWithDiffs(app, d, [80]);
      const round = await sendDispute(d.admin.auth, sentInv.invoiceId);
      // itiraz satırına gönderim anındaki ölçüm yazıldı
      const mSent = (await lineMeasurement(sentInv.lines[0]!.id))!;
      expect((await sup.query(`SELECT "measurementId" FROM "DisputeLine" WHERE id = $1`, [round.lines[0]!.id])).rows[0].measurementId).toBe(mSent);
      const listed = await invoiceWithDiffs(app, d, [80, 90, 70], { verify: 1 }); // satır 1 itiraz listesinde, 2 uyumlu, 3 açık
      const accepted = await call(d.admin.auth, 'PATCH', `/invoice-lines/${listed.lines[1]!.id}`, { decision: 'ACCEPTED', reason: 'kabul' });
      expect(accepted.statusCode, accepted.body).toBe(200);
      const mListed = (await lineMeasurement(listed.lines[0]!.id))!;
      const mAccepted = (await lineMeasurement(listed.lines[1]!.id))!;
      const mOpen = (await lineMeasurement(listed.lines[2]!.id))!;
      const files = { sent: await photoRows(mSent), listed: await photoRows(mListed), accepted: await photoRows(mAccepted), open: await photoRows(mOpen) };
      for (const id of [mSent, mListed, mAccepted, mOpen]) {
        await deleteMeasurement(c, id);
        await backdate('Measurement', 'deletedAt', id, '400 days');
      }
      expect(await purgeCompany(c)).toEqual({ invoices: 0, photos: files.open.length });
      expect(await photoRows(mSent)).toEqual(files.sent);
      expect(await photoRows(mListed)).toEqual(files.listed);
      expect(await photoRows(mAccepted)).toEqual(files.accepted);
      for (const f of [...files.sent, ...files.listed, ...files.accepted]) {
        expect(onDisk(f.path)).toBe(true);
        expect(await purgeMeasurementPhoto(c.companyId, f.id, { days: 7 })).toBe(false);
      }
      expect(await photoRows(mOpen)).toEqual([]);
    });

    it('sonuçlanmış turun kanıtı: satır yeni ölçümle hesaplanıp bağı değişse de fotoğraf kalır (T1)', async () => {
      const d = await disputeCompany(app);
      const a = d.admin.auth;
      const inv = await invoiceWithDiffs(app, d, [58, 48]);
      const r1 = await sendDispute(a, inv.invoiceId);
      const rec = await call(a, 'POST', `/disputes/${r1.id}/results`, { version: r1.version, kind: 'RECOVERED', resultOn: trDay(-1), creditNoteNo: 'AD-9', lines: [{ disputeLineId: r1.lines[0]!.id, amount: r1.lines[0]!.claimedAmount }] });
      expect(rec.statusCode, rec.body).toBe(200);
      const s2 = await call(a, 'POST', `/disputes/${r1.id}/resend`, { selectionDigest: await digestOf(app, a, inv.invoiceId), version: rec.json().dispute.active.version, sentOn: trDay(0), channel: 'EMAIL' });
      expect(s2.statusCode, s2.body).toBe(200);
      const recLineId = (await sup.query(`SELECT "invoiceLineId" FROM "DisputeLine" WHERE id = $1`, [r1.lines[0]!.id])).rows[0].invoiceLineId as string;
      const mRec = (await lineMeasurement(recLineId))!;
      const photos = await photoRows(mRec);
      expect(photos.length).toBeGreaterThan(0);
      expect((await call(a, 'DELETE', `/measurements/${mRec}`)).statusCode).toBe(204);
      await drainMeasurementQueue(10_000);
      const pre = await call(a, 'POST', `/invoices/${inv.invoiceId}/recalculate/preview`, { basis: 'pinned', lineIds: [recLineId] });
      expect(pre.statusCode, pre.body).toBe(200);
      const ap = await call(a, 'POST', `/invoices/${inv.invoiceId}/recalculate`, { basis: 'pinned', lineIds: [recLineId], token: pre.json().token });
      expect(ap.statusCode, ap.body).toBe(200);
      await backdate('Measurement', 'deletedAt', mRec, '400 days');
      expect(await purgeCompany(co(d))).toMatchObject({ photos: 0 });
      expect(await photoRows(mRec)).toEqual(photos);
    });

    it('geri çekilmiş turdaki sürüm: yeniden ölçümle eski sürüm olsa da, sonra son sürüm silinse de zincirin fotoğrafları kalır (T2)', async () => {
      const d = await disputeCompany(app);
      const a = d.admin.auth;
      const c = co(d);
      const inv = await invoiceWithDiffs(app, d, [80]);
      const r1 = await sendDispute(a, inv.invoiceId);
      expect((await call(a, 'POST', `/disputes/${r1.id}/withdraw`, { version: r1.version, reason: 'yanlış' })).statusCode).toBe(200);
      const L = inv.lines[0]!.id;
      const m1 = (await lineMeasurement(L))!;
      const p1 = await photoRows(m1);
      expect((await call(a, 'PATCH', `/invoice-lines/${L}`, { decision: 'OPEN' })).statusCode).toBe(200);
      const trackingRaw = (await sup.query(`SELECT "trackingRaw" FROM "Measurement" WHERE id = $1`, [m1])).rows[0].trackingRaw as string;
      const m2 = await measure(c, 1, { trackingRaw, lengthCm: 30, widthCm: 20, heightCm: 16, weightKg: 2 });
      await drainMeasurementQueue(10_000);
      await backdate('Measurement', 'createdAt', m2.id, '31 days');
      expect(await purgeCompany(c)).toEqual({ invoices: 0, photos: 0 });
      expect(await photoRows(m1)).toEqual(p1);
      // son sürüm (m2) silinir: zincirde itiraz kanıtı var → m2'nin fotoğrafı da kalır (kuşkuda silme)
      await deleteMeasurement(c, m2.id);
      await backdate('Measurement', 'deletedAt', m2.id, '400 days');
      expect(await purgeCompany(c)).toEqual({ invoices: 0, photos: 0 });
      expect(await photoRows(m2.id)).toEqual(m2.files);
      for (const f of [...p1, ...m2.files]) expect(onDisk(f.path)).toBe(true);
    });

    it('itiraz satırının gönderim anındaki ölçümü tek başına korur (fatura satırı kararsız ve bağsız, takip no farklı)', async () => {
      const d = await disputeCompany(app);
      const inv = await invoiceWithDiffs(app, d, [80]);
      const r1 = await sendDispute(d.admin.auth, inv.invoiceId);
      const m = (await lineMeasurement(inv.lines[0]!.id))!;
      const photos = await photoRows(m);
      await sup.query(`UPDATE "DisputeLine" SET "trackingNo" = 'BASKA-NO' WHERE id = $1`, [r1.lines[0]!.id]);
      await sup.query(`UPDATE "InvoiceLine" SET "measurementId" = NULL, decision = 'OPEN' WHERE id = $1`, [inv.lines[0]!.id]);
      await sup.query(`UPDATE "Measurement" SET "deletedAt" = (now() AT TIME ZONE 'UTC') - interval '400 days' WHERE id = $1`, [m]);
      expect(await purgeCompany(co(d))).toMatchObject({ photos: 0 });
      expect(await photoRows(m)).toEqual(photos);
      // kanıt bağı da kalkarsa (olmaması gereken durum) fotoğraf aday olur: koruma gerçekten bu sütundan geliyor
      await sup.query(`UPDATE "DisputeLine" SET "measurementId" = NULL WHERE id = $1`, [r1.lines[0]!.id]);
      expect(await purgeCompany(co(d))).toMatchObject({ photos: photos.length });
    });

    it('göçün doldurması: eski itiraz satırı fatura satırının bugünkü bağından dolar, dolu olana dokunmaz', async () => {
      const d = await disputeCompany(app);
      const inv = await invoiceWithDiffs(app, d, [80]);
      const r1 = await sendDispute(d.admin.auth, inv.invoiceId);
      const m = (await lineMeasurement(inv.lines[0]!.id))!;
      await sup.query(`UPDATE "DisputeLine" SET "measurementId" = NULL WHERE id = $1`, [r1.lines[0]!.id]);
      const sql = fs.readFileSync(path.resolve(import.meta.dirname, '../prisma/migrations/20261123100000_dispute_line_measurement/migration.sql'), 'utf8');
      const update = sql.slice(sql.indexOf('UPDATE "deciship"."DisputeLine"'), sql.indexOf(';', sql.indexOf('UPDATE "deciship"."DisputeLine"')));
      await sup.query(update);
      expect((await sup.query(`SELECT "measurementId" FROM "DisputeLine" WHERE id = $1`, [r1.lines[0]!.id])).rows[0].measurementId).toBe(m);
    });

    it('bağı belirsiz eski itiraz satırı (measurementId boş) takip no eşleşmesiyle korur', async () => {
      const d = await disputeCompany(app);
      const c = co(d);
      const inv = await invoiceWithDiffs(app, d, [80]);
      const r1 = await sendDispute(d.admin.auth, inv.invoiceId);
      const m = (await lineMeasurement(inv.lines[0]!.id))!;
      const photos = await photoRows(m);
      // göç öncesi satır gibi: kanıt sütunu boş; fatura satırının bağı da koptu
      await sup.query(`UPDATE "DisputeLine" SET "measurementId" = NULL WHERE id = $1`, [r1.lines[0]!.id]);
      await sup.query(`UPDATE "InvoiceLine" SET "measurementId" = NULL WHERE id = $1`, [inv.lines[0]!.id]);
      await sup.query(`UPDATE "Measurement" SET "deletedAt" = (now() AT TIME ZONE 'UTC') - interval '400 days' WHERE id = $1`, [m]);
      expect(await purgeCompany(c)).toMatchObject({ photos: 0 });
      expect(await photoRows(m)).toEqual(photos);
    });

    it('fotoğraf olmayan bir kayıt ya da ölçüme bağlanmamış fotoğraf aynı yolu gösteriyorsa silinmez', async () => {
      const c = co(await disputeCompany(app));
      const m = await measure(c, 1);
      const photo = m.files[0]!;
      await deleteMeasurement(c, m.id);
      await backdate('Measurement', 'deletedAt', m.id, '400 days');
      const stray = await withCompany(c.companyId, async () => {
        const member = await prisma.member.findFirstOrThrow({ where: { companyId: c.companyId }, select: { id: true } });
        return prisma.file.create({ data: { companyId: c.companyId, kind: 'INVOICE_SOURCE', mime: 'text/csv', size: 1, path: photo.path, sha256: 'x', createdById: member.id }, select: { id: true } });
      });
      expect(await purgeCompany(c)).toEqual({ invoices: 0, photos: 0 });
      expect(await fileRow(photo.id)).toBeDefined();
      expect(onDisk(photo.path)).toBe(true);
      await sup.query(`DELETE FROM "File" WHERE id = $1`, [stray.id]);
      await sup.query(`UPDATE "File" SET "measurementId" = NULL WHERE id = $1`, [photo.id]);
      await backdate('File', 'createdAt', photo.id, '4000 days');
      expect(await purgeCompany(c)).toEqual({ invoices: 0, photos: 0 });
      expect(await purgeMeasurementPhoto(c.companyId, photo.id, { days: 7 })).toBe(false);
      expect(await fileRow(photo.id)).toBeDefined();
      expect(onDisk(photo.path)).toBe(true);
    });

    it('disk silme hatası: satır silinir, disk yetim kalır (veri tutarlı, uyarı yazılır)', async () => {
      const c = co(await disputeCompany(app));
      const m = await measure(c, 1);
      const photo = m.files[0]!;
      await deleteMeasurement(c, m.id);
      await backdate('Measurement', 'deletedAt', m.id, '40 days');
      fs.rmSync(abs(photo.path));
      fs.mkdirSync(abs(photo.path));
      fs.writeFileSync(path.join(abs(photo.path), 'x.txt'), 'x');
      const { warns, log } = quiet();
      try {
        expect(await purgeCompany(c, { log })).toEqual({ invoices: 0, photos: 1 });
        expect(await fileRow(photo.id)).toBeUndefined();
        expect(onDisk(photo.path)).toBe(true);
        expect(warns.some((w) => w.includes('orphan file left'))).toBe(true);
      } finally {
        fs.rmSync(abs(photo.path), { recursive: true, force: true });
      }
    });

    it('başka firmanın fotoğrafı etkilenmez', async () => {
      const x = co(await disputeCompany(app));
      const y = co(await disputeCompany(app));
      const mx = await measure(x, 1);
      const my = await measure(y, 1);
      for (const [c, m] of [[x, mx], [y, my]] as const) {
        await deleteMeasurement(c, m.id);
        await backdate('Measurement', 'deletedAt', m.id, '40 days');
      }
      expect(await purgeMeasurementPhoto(x.companyId, my.files[0]!.id, { days: 30 })).toBe(false);
      expect(await purgeCompany(x)).toEqual({ invoices: 0, photos: 1 });
      expect(await fileRow(mx.files[0]!.id)).toBeUndefined();
      expect(await fileRow(my.files[0]!.id)).toBeDefined();
      expect(onDisk(my.files[0]!.path)).toBe(true);
    });
  });

  // =================================================================================================================
  describe('kuru çalışma ve bakım', () => {
    it('kuru çalışma gerçek turla aynı kümeyi sayar: fatura silinince kalkan koruma bir sonraki tura kalır (T3)', async () => {
      const d = await disputeCompany(app);
      const c = co(d);
      const inv = await invoiceWithDiffs(app, d, [80]);
      const m = (await lineMeasurement(inv.lines[0]!.id))!;
      const photos = await photoRows(m);
      await deleteMeasurement(c, m);
      await deleteInvoice(c, inv.invoiceId);
      await backdate('Measurement', 'deletedAt', m, '40 days');
      await backdate('Invoice', 'deletedAt', inv.invoiceId, '40 days');
      const p1 = await previewDeletedPurge({ companyIds: [c.companyId], invoiceDays: 30, photoDays: 30 });
      const r1 = await purgeCompany(c);
      expect(r1).toEqual({ invoices: p1.totals.invoices, photos: p1.totals.photos });
      expect(r1).toEqual({ invoices: 1, photos: 0 }); // itiraz listesindeki satır bu turda fotoğrafı korudu
      const p2 = await previewDeletedPurge({ companyIds: [c.companyId], invoiceDays: 30, photoDays: 30 });
      const r2 = await purgeCompany(c);
      expect(r2).toEqual({ invoices: p2.totals.invoices, photos: p2.totals.photos });
      expect(r2).toEqual({ invoices: 0, photos: photos.length });
    });

    it('kuru çalışma hiçbir şey silmez; komut satırı aynı sayıyı verir', async () => {
      const c = co(await disputeCompany(app));
      const inv = await uploadInvoice(c, [uniq('90')]);
      await deleteInvoice(c, inv.invoiceId);
      await backdate('Invoice', 'deletedAt', inv.invoiceId, '40 days');
      const m = await measure(c, 2);
      await deleteMeasurement(c, m.id);
      await backdate('Measurement', 'deletedAt', m.id, '40 days');
      const rows = async () => ({
        invoices: await count(`"Invoice" WHERE "companyId" = $1`, [c.companyId]),
        lines: await count(`"InvoiceLine" WHERE "companyId" = $1`, [c.companyId]),
        files: await count(`"File" WHERE "companyId" = $1`, [c.companyId]),
        audit: await count(`"AuditLog" WHERE "companyId" = $1`, [c.companyId]),
      });
      const before = await rows();
      const p = await previewDeletedPurge({ companyIds: [c.companyId], invoiceDays: 30, photoDays: 30 });
      expect(p.companies).toHaveLength(1);
      expect(p.totals).toMatchObject({ invoices: 1, invoicesKeptForDispute: 0, photos: 2 });
      expect(p.totals.photoBytes).toBeGreaterThan(0);
      expect((await previewDeletedPurge({ companyIds: [c.companyId], invoiceDays: 45, photoDays: 45 })).totals).toMatchObject({ invoices: 0, photos: 0 });
      expect((await previewDeletedPurge({ companyIds: [c.companyId], invoiceDays: null, photoDays: null })).totals).toMatchObject({ invoices: 0, photos: 0 });

      const out: string[] = [];
      const err: string[] = [];
      // değişkenler boş (kapalı): komut kararın 30 günüyle sayar
      const code = await withEnv({}, () => runPurgePreviewCli(['--company', c.companyId, '--json'], { log: (l) => out.push(l), error: (l) => err.push(l) }));
      expect(code, err.join('\n')).toBe(0);
      expect(JSON.parse(out[0]!)).toMatchObject({ totals: { invoices: 1, photos: 2 }, enabled: { invoices: false, photos: false } });
      const text: string[] = [];
      expect(await runPurgePreviewCli(['--company', c.companyId, '--photo-days', '0'], { log: (l) => text.push(l), error: () => {} })).toBe(0);
      expect(text[0]).toMatch(/photos: not counted/);
      expect(text.at(-1)).toMatch(/^Done \(nothing deleted\): companies=1 invoices=1 keptForDispute=0 photos=0/);

      expect(await rows()).toEqual(before);
      expect(onDisk(inv.rel)).toBe(true);
      for (const f of m.files) expect(onDisk(f.path)).toBe(true);
      expect(await purgeCompany(c)).toEqual({ invoices: 1, photos: 2 });
    });

    it('komut satırı bayrakları: bozuk bayrak 2', async () => {
      for (const bad of [['--bilinmeyen'], ['--invoice-days'], ['--invoice-days', 'x'], ['--photo-days', '-3'], ['--now', '2026-11-12'], ['--company']]) {
        expect(() => parsePurgePreviewArgs(bad), bad.join(' ')).toThrow();
        const errs: string[] = [];
        expect(await runPurgePreviewCli(bad, { log: () => {}, error: (l) => errs.push(l) })).toBe(2);
        expect(errs.join('\n')).toMatch(/Usage/);
      }
    });

    it('saatlik bakım: kapalıyken dokunmaz, açıkken adımı çalıştırır ve sayar', async () => {
      const c = co(await disputeCompany(app));
      const inv = await uploadInvoice(c, [uniq('91')]);
      await deleteInvoice(c, inv.invoiceId);
      await backdate('Invoice', 'deletedAt', inv.invoiceId, '40 days');
      const m = await measure(c, 1);
      await deleteMeasurement(c, m.id);
      await backdate('Measurement', 'deletedAt', m.id, '40 days');
      const off = await withEnv({}, () => runMaintenance(Date.now(), quiet().log));
      expect(off).toMatchObject({ purgedInvoices: 0, purgedPhotos: 0 });
      expect(await invoiceExists(inv.invoiceId)).toBe(true);
      const on = await withEnv({ DELETED_INVOICE_PURGE_DAYS: '30', DELETED_MEASUREMENT_PHOTO_PURGE_DAYS: '30' }, () => runMaintenance(Date.now(), quiet().log));
      expect(on.purgedInvoices).toBeGreaterThanOrEqual(1);
      expect(on.purgedPhotos).toBeGreaterThanOrEqual(1);
      expect(await invoiceExists(inv.invoiceId)).toBe(false);
      expect(await photoRows(m.id)).toEqual([]);
      expect(await invoiceExists(B.invoiceId)).toBe(true);
      expect(await fileRow(B.photoId)).toMatchObject({ purgedAt: null });
      expect(await fileRow(B.invoiceFileId)).toMatchObject({ purgedAt: null });
    });
  });
});
