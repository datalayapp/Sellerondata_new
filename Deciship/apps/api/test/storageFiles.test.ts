import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { env } from '../src/env.ts';
import { MESSAGES } from '../src/i18n/messages.ts';
import { orientationTiff } from '../src/lib/imageMeta.ts';
import { absolutePath, sha256 } from '../src/lib/storage.ts';
import { discardPreviewFile, runFileCleanup, sharePreviewFile } from '../src/services/fileCleanup.ts';
import { invoicePdfDedupeKey } from '../src/services/jobs/handlers/invoicePdf.ts';
import { countedStorageBytes, GB_BYTES } from '../src/services/storageQuota.ts';
import { logUncleanPhotos } from '../src/routes/measurements.ts';
import { EVIDENCE_MAX_PHOTOS } from '../src/services/evidence.ts';
import { companyFixture, type Fixture } from './fixtures.ts';
import { createMember, getApp, inCompany, JPEG, measurementPayload, multipart, uniq } from './helpers.ts';
import { testSuperDbUrl } from './testEnv.ts';

/**
 * Dosyalar, depolama ve kanıt (rapor Y65, Y91, Y54, Y24). Veri kaybı ve gizlilik: kota yalnız fatura ve tarife dosyasını
 * durdurur (ölçüm fotoğrafı asla), paylaşılan önizleme birinin vazgeçmesiyle silinmez, itiraz penceresi diskte olmayan
 * fotoğrafı saymaz, saklanan fotoğrafta konum bilgisi kalmaz.
 */

const API = '/api/deciship';
const QUOTA_ENV = 'STORAGE_QUOTA_GB_PER_ORG';

describe('dosyalar ve depolama', () => {
  let app: FastifyInstance;
  let A: Fixture;
  let sup: pg.Client;
  const savedQuota = process.env[QUOTA_ENV];

  const onDisk = (rel: string) => fs.existsSync(path.join(env.storageDir, rel));
  const fileRow = async (id: string) =>
    (await sup.query<{ id: string; path: string; holders: string[]; size: number; sha256: string }>(`SELECT id, path, holders, size, sha256 FROM "File" WHERE id = $1`, [id])).rows[0];
  const quiet = { warn: () => undefined };

  function csvForm(f: Fixture, name = 'fatura.csv') {
    const csv = ['Takip No;Desi;Tutar', `${uniq('77')};5;50`, `${uniq('78')};3;30`].join('\n');
    return multipart([
      { name: 'carrierId', value: f.carrierId },
      { name: 'file', filename: name, contentType: 'text/csv', data: Buffer.from(csv) },
    ]);
  }
  const uploadCsv = (f: Fixture, auth = f.admin.auth) => {
    const form = csvForm(f);
    return app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...auth, ...form.headers }, payload: form.payload });
  };
  const fileCount = (f: Fixture) => inCompany(f.companyId, () => prisma.file.count({ where: { companyId: f.companyId } }));

  /** Kotaya sayılan, diskte olmayan dolgu satırı (yalnız boyutu önemli). */
  const ballast = (f: Fixture, size: number, o: { kind?: 'INVOICE_SOURCE' | 'PHOTO_BOX'; purged?: boolean } = {}) =>
    inCompany(f.companyId, () =>
      prisma.file.create({
        data: {
          companyId: f.companyId,
          kind: o.kind ?? 'INVOICE_SOURCE',
          mime: 'text/csv',
          size,
          path: `${f.companyId}/ballast/${crypto.randomUUID()}.csv`,
          sha256: 'x',
          createdById: f.admin.userId,
          ...(o.purged ? { purgedAt: new Date() } : {}),
        },
        select: { id: true },
      }),
    );
  /** Kota 1 GB; firma kotayı `free` bayt kalacak şekilde doldurur. */
  async function fillQuota(f: Fixture, free = 10) {
    process.env[QUOTA_ENV] = '1';
    const used = await countedStorageBytes(f.companyId);
    await ballast(f, GB_BYTES - used - free);
    expect(await countedStorageBytes(f.companyId)).toBe(GB_BYTES - free);
  }
  const quotaMessage = (limit: string) => MESSAGES['err.storageQuotaExceeded'].tr.replace('{limit}', limit);

  beforeAll(async () => {
    app = await getApp();
    A = await companyFixture(app);
    sup = new pg.Client({ connectionString: testSuperDbUrl(), options: '-c search_path=deciship' });
    await sup.connect();
  });
  afterEach(() => {
    if (savedQuota === undefined) delete process.env[QUOTA_ENV];
    else process.env[QUOTA_ENV] = savedQuota;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterAll(async () => {
    await sup?.end();
  });

  // ------------------------------------------------------------------------------------------
  describe('Y65: firma başına dosya alanı', () => {
    it('alan dolunca fatura önizlemesi 413 STORAGE_QUOTA_EXCEEDED: dosya ve kayıt yok; 0 kapalı, varsayılan 10 GB', async () => {
      const C = await companyFixture(app);
      await fillQuota(C);
      const before = await fileCount(C);
      const r = await uploadCsv(C);
      expect(r.statusCode, r.body).toBe(413);
      expect(r.json().error).toEqual({ code: 'STORAGE_QUOTA_EXCEEDED', message: quotaMessage('1'), details: { limitGb: 1 } });
      expect(await fileCount(C)).toBe(before);
      // İngilizce
      const en = await uploadCsv(C, { ...C.admin.auth, 'accept-language': 'en' } as typeof C.admin.auth);
      expect(en.json().error.message).toBe(MESSAGES['err.storageQuotaExceeded'].en.replace('{limit}', '1'));

      process.env[QUOTA_ENV] = '0';
      expect((await uploadCsv(C)).statusCode).toBe(200);
      delete process.env[QUOTA_ENV];
      expect(env.storageQuotaGbPerOrg).toBe(10);
      expect((await uploadCsv(C)).statusCode).toBe(200);
    });

    it('tam sınır sığar, bir bayt fazlası sığmaz', async () => {
      const C = await companyFixture(app);
      // sayılan dosyanın boyu (gövdenin değil)
      const csvBytes = ['Takip No;Desi;Tutar', '7700000001;5;50'].join('\n');
      const exact = multipart([
        { name: 'carrierId', value: C.carrierId },
        { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csvBytes) },
      ]);
      await fillQuota(C, Buffer.byteLength(csvBytes));
      const ok = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...C.admin.auth, ...exact.headers }, payload: exact.payload });
      expect(ok.statusCode, ok.body).toBe(200);
      // artık tam dolu: bir bayt bile sığmaz
      const again = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...C.admin.auth, ...exact.headers }, payload: exact.payload });
      expect(again.statusCode).toBe(413);
    });

    it('sayılmayan: silinmiş faturanın dosyası, temizlenmiş dosya, ölçüm fotoğrafı; sayılan: önizleme, canlı faturanın dosyası, tarife PDF\'i', async () => {
      const C = await companyFixture(app);
      const base = await countedStorageBytes(C.companyId);
      await ballast(C, 1_000_000, { kind: 'PHOTO_BOX' });
      await ballast(C, 2_000_000, { purged: true });
      expect(await countedStorageBytes(C.companyId)).toBe(base);

      // fikstürün canlı faturasının dosyası sayılır; fatura silinince sayılmaz
      const inv = await inCompany(C.companyId, () => prisma.invoice.findFirstOrThrow({ where: { id: C.invoiceId }, select: { sourceFileId: true } }));
      const src = (await fileRow(inv.sourceFileId))!;
      await sup.query(`UPDATE "File" SET size = 300000000 WHERE id = $1`, [inv.sourceFileId]);
      expect(await countedStorageBytes(C.companyId)).toBe(base - src.size + 300_000_000);
      const del = await app.inject({ method: 'DELETE', url: `${API}/invoices/${C.invoiceId}`, headers: C.admin.auth });
      expect(del.statusCode, del.body).toBe(204);
      expect(await countedStorageBytes(C.companyId)).toBe(base - src.size);

      // önizleme ve tarife PDF'i sayılır
      const p = await uploadCsv(C);
      expect(p.statusCode, p.body).toBe(200);
      const preview = (await fileRow(p.json().fileId))!;
      await inCompany(C.companyId, () =>
        prisma.tariffDocument.create({
          data: { companyId: C.companyId, carrierId: C.carrierId, fileName: 't.pdf', path: `${C.companyId}/yok/t.pdf`, size: 4_000_000, sha256: 'x', pages: 1, textLayer: true, pageTexts: [], discovery: {} },
        }),
      );
      expect(await countedStorageBytes(C.companyId)).toBe(base - src.size + preview.size + 4_000_000);
    });

    it('alan doluyken ölçüm fotoğrafı yine kaydedilir (çalışanın ölçümü reddedilmez)', async () => {
      const C = await companyFixture(app);
      await fillQuota(C, 0);
      const p = measurementPayload({}, 2);
      const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...C.worker.auth, ...p.headers }, payload: p.payload });
      expect(r.statusCode, r.body).toBe(201);
    });

    it('tarife PDF\'i ve kurulum örnek faturası da durur (okunmadan, kayıt açılmadan)', async () => {
      const C = await companyFixture(app);
      await fillQuota(C);
      const docs = () => inCompany(C.companyId, () => prisma.tariffDocument.count({ where: { companyId: C.companyId } }));
      const before = await docs();
      const pdf = multipart([{ name: 'file', filename: 'tarife.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-1.4\n%sahte\n') }]);
      const t = await app.inject({ method: 'POST', url: `${API}/tariffs/${C.tariffId}/import`, headers: { ...C.admin.auth, ...pdf.headers }, payload: pdf.payload });
      expect(t.statusCode, t.body).toBe(413);
      expect(t.json().error.code).toBe('STORAGE_QUOTA_EXCEEDED');
      expect(await docs()).toBe(before);

      const files = await fileCount(C);
      const form = csvForm(C, 'ornek.csv');
      const s = await app.inject({ method: 'POST', url: `${API}/invoices/samples`, headers: { ...C.admin.auth, ...form.headers }, payload: form.payload });
      expect(s.statusCode, s.body).toBe(413);
      expect(s.json().error.code).toBe('STORAGE_QUOTA_EXCEEDED');
      expect(await fileCount(C)).toBe(files);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('Y91: aynı PDF okumasını paylaşan önizleme', () => {
    async function invoicePdf(): Promise<Buffer> {
      const doc = await PDFDocument.create();
      const page = doc.addPage([595, 842]);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      ['FATURA 9-482-11735', '794812345305 20.10.2026 1.642,50', `ref ${uniq('t')}`].forEach((r, i) => page.drawText(r, { x: 40, y: 800 - i * 18, size: 11, font }));
      return Buffer.from(await doc.save());
    }

    /** Yükleyenin PDF önizlemesi (diskte) + onu okuyan süren iş (sağlayıcı çağrılmaz: iş elle RUNNING). */
    async function runningRead(f: Fixture, pdf: Buffer) {
      const rel = path.posix.join(f.companyId, 'y91', `${crypto.randomUUID()}.pdf`);
      fs.mkdirSync(path.dirname(absolutePath(rel)), { recursive: true });
      fs.writeFileSync(absolutePath(rel), pdf);
      const file = await inCompany(f.companyId, () =>
        prisma.file.create({
          data: { companyId: f.companyId, kind: 'INVOICE_SOURCE', mime: 'application/pdf', size: pdf.length, path: rel, sha256: sha256(pdf), originalName: 'fatura.pdf', createdById: f.admin.userId },
          select: { id: true },
        }),
      );
      const job = await inCompany(f.companyId, () =>
        prisma.job.create({
          data: {
            companyId: f.companyId,
            kind: 'INVOICE_PDF_READ',
            status: 'RUNNING',
            // 05-B10: tekillik taşıyıcıyla (aynı dosya aynı taşıyıcıyla süren işe bağlanılır)
            dedupeKey: invoicePdfDedupeKey(sha256(pdf), 'tr', false, f.carrierId),
            refType: 'File',
            refId: file.id,
            label: 'fatura.pdf',
            input: { v: 1, locale: 'tr', fileId: file.id, carrierId: f.carrierId },
            createdById: f.admin.userId,
          },
          select: { id: true },
        }),
      );
      return { fileId: file.id, rel, jobId: job.id };
    }
    const finish = (jobId: string) => sup.query(`UPDATE "Job" SET status = 'SUCCEEDED', "finishedAt" = (now() AT TIME ZONE 'UTC') WHERE id = $1`, [jobId]);
    const discard = (fileId: string, auth: { authorization: string }) => app.inject({ method: 'DELETE', url: `${API}/invoices/preview/${fileId}`, headers: auth });

    it('süren okumaya bağlanan üye önizlemeyi paylaşır; yükleyenin vazgeçmesi silmez, son kişi vazgeçince silinir', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const pdf = await invoicePdf();
      const read = await runningRead(A, pdf);
      const b = await createMember(app, A.admin.auth, 'AUDITOR', 'İkinci Yükleyen');
      const form = multipart([
        { name: 'carrierId', value: A.carrierId },
        { name: 'file', filename: 'fatura.pdf', contentType: 'application/pdf', data: pdf },
      ]);
      const r = await app.inject({ method: 'POST', url: `${API}/invoices/preview?async=1`, headers: { ...b.auth, ...form.headers }, payload: form.payload });
      expect(r.statusCode, r.body).toBe(202);
      expect(r.json()).toMatchObject({ joined: true, job: { id: read.jobId, ref: { type: 'File', id: read.fileId } } });
      expect((await fileRow(read.fileId))!.holders).toEqual([A.admin.userId, b.userId]);
      // ikinci dosya açılmadı
      expect(await inCompany(A.companyId, () => prisma.file.count({ where: { companyId: A.companyId, sha256: sha256(pdf) } }))).toBe(1);
      await finish(read.jobId);

      // yükleyen vazgeçer: dosya kalır, liste daralır; yeniden çağrı bir şey değiştirmez
      expect((await discard(read.fileId, A.admin.auth)).statusCode).toBe(204);
      expect((await fileRow(read.fileId))!.holders).toEqual([b.userId]);
      expect(onDisk(read.rel)).toBe(true);
      expect((await discard(read.fileId, A.admin.auth)).statusCode).toBe(204);
      expect((await fileRow(read.fileId))!.holders).toEqual([b.userId]);
      // bağlanan üye hâlâ açabilir
      expect((await app.inject({ method: 'GET', url: `${API}/files/${read.fileId}`, headers: b.auth })).statusCode).toBe(200);
      // tutmayan üçüncü kişi: 404 ve yerinde
      const c = await createMember(app, A.admin.auth, 'AUDITOR', 'Üçüncü Kişi');
      expect((await discard(read.fileId, c.auth)).statusCode).toBe(404);
      expect(await fileRow(read.fileId)).toBeDefined();

      // son tutan vazgeçer: satır ve disk gider
      expect((await discard(read.fileId, b.auth)).statusCode).toBe(204);
      expect(await fileRow(read.fileId)).toBeUndefined();
      expect(onDisk(read.rel)).toBe(false);
    });

    it('bağlanan önce vazgeçerse yükleyenin önizlemesi kalır; yükleyen vazgeçince silinir', async () => {
      const read = await runningRead(A, await invoicePdf());
      const b = await createMember(app, A.admin.auth, 'AUDITOR', 'İkinci Yükleyen');
      await sharePreviewFile(A.companyId, read.jobId, b.userId);
      await finish(read.jobId);
      expect((await discard(read.fileId, b.auth)).statusCode).toBe(204);
      expect((await fileRow(read.fileId))!.holders).toEqual([A.admin.userId]);
      expect(onDisk(read.rel)).toBe(true);
      // bırakan üye artık tutmuyor: 404
      expect((await discard(read.fileId, b.auth)).statusCode).toBe(404);
      expect((await discard(read.fileId, A.admin.auth)).statusCode).toBe(204);
      expect(await fileRow(read.fileId)).toBeUndefined();
      expect(onDisk(read.rel)).toBe(false);
    });

    it('paylaşma: aynı üye iki kez, yükleyenin kendisi, bitmiş ya da başka türde iş listeyi bozmaz', async () => {
      const read = await runningRead(A, await invoicePdf());
      const b = await createMember(app, A.admin.auth, 'AUDITOR', 'İkinci Yükleyen');
      await sharePreviewFile(A.companyId, read.jobId, A.admin.userId); // paylaşılmayan dosyanın yükleyeni
      expect((await fileRow(read.fileId))!.holders).toEqual([]);
      await sharePreviewFile(A.companyId, read.jobId, b.userId);
      await sharePreviewFile(A.companyId, read.jobId, b.userId);
      await Promise.all([sharePreviewFile(A.companyId, read.jobId, b.userId), sharePreviewFile(A.companyId, read.jobId, A.admin.userId)]);
      expect((await fileRow(read.fileId))!.holders).toEqual([A.admin.userId, b.userId]);
      // başka firmanın bağlamında hiçbir şey yapmaz
      const other = await companyFixture(app);
      await sharePreviewFile(other.companyId, read.jobId, other.admin.userId);
      expect((await fileRow(read.fileId))!.holders).toEqual([A.admin.userId, b.userId]);
    });

    it('bakım (24 saat) ve işin temizlik kancası paylaşılan önizlemeyi de siler: listeye bakmaz', async () => {
      const b = await createMember(app, A.admin.auth, 'AUDITOR', 'İkinci Yükleyen');
      const old = await runningRead(A, await invoicePdf());
      await sharePreviewFile(A.companyId, old.jobId, b.userId);
      await finish(old.jobId);
      await sup.query(`UPDATE "File" SET "updatedAt" = (now() AT TIME ZONE 'UTC') - interval '25 hours' WHERE id = $1`, [old.fileId]);
      // kendi imleci ve geniş tur: başka dosyaların korunan eski adayları sırayı doldurmasın
      await runFileCleanup(Date.now(), quiet, { batch: 10_000, cursor: { previews: null, purges: null } });
      expect(await fileRow(old.fileId)).toBeUndefined();
      expect(onDisk(old.rel)).toBe(false);

      const failed = await runningRead(A, await invoicePdf());
      await sharePreviewFile(A.companyId, failed.jobId, b.userId);
      expect(await discardPreviewFile(A.companyId, failed.fileId, { exceptJobId: failed.jobId, log: quiet })).toBe(true);
      expect(onDisk(failed.rel)).toBe(false);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('Y54: itiraz penceresinin fotoğraf sayısı', () => {
    it('dosyası diskte olmayan fotoğraf metinde ve sayıda yok; ZIP mektubu ile aynı metin', async () => {
      const C = await companyFixture(app);
      const line = (await app.inject({ method: 'GET', url: `${API}/invoices/${C.invoiceId}/lines`, headers: C.admin.auth })).json().items.find((l: { id: string }) => l.id === C.lineId);
      expect(line.status).toBe('DIFF');
      const v = await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${C.lineId}`, headers: C.admin.auth, payload: { decision: 'VERIFIED' } });
      expect(v.statusCode, v.body).toBe(200);
      const dispute = async () => {
        const r = await app.inject({ method: 'GET', url: `${API}/invoices/${C.invoiceId}/dispute`, headers: C.admin.auth });
        expect(r.statusCode, r.body).toBe(200);
        return r.json() as { subject: string; body: string; photoCount: number; linesWithoutPhoto: number };
      };
      expect(await dispute()).toMatchObject({ photoCount: 1, linesWithoutPhoto: 0 });

      // fotoğraf kaydı duruyor, dosya diskten kayboldu
      const photo = (await fileRow(C.photoId))!;
      fs.rmSync(absolutePath(photo.path));
      const d = await dispute();
      expect(d).toMatchObject({ photoCount: 0, linesWithoutPhoto: 1 });

      // ZIP'teki mektup itiraz penceresindeki metinle bayt bayt aynı
      const zip = await app.inject({ method: 'GET', url: `${API}/invoices/${C.invoiceId}/dispute/evidence.zip`, headers: C.admin.auth });
      expect(zip.statusCode).toBe(200);
      // ilk giriş mektup (merkez dizinden okunur; sıkıştırmasız, BOM'lu UTF-8, CRLF)
      const raw = zip.rawPayload;
      const cd = raw.readUInt32LE(raw.length - 22 + 16);
      expect(raw.readUInt32LE(cd)).toBe(0x02014b50);
      const size = raw.readUInt32LE(cd + 20);
      const local = raw.readUInt32LE(cd + 42);
      const start = local + 30 + raw.readUInt16LE(local + 26) + raw.readUInt16LE(local + 28);
      const letter = raw.subarray(start + 3, start + size).toString('utf8').replace(/\r\n/g, '\n');
      expect(letter).toBe(`${d.subject}\n\n${d.body}`);
      // ZIP'te fotoğraf yok, eksik dosya notu var
      expect(raw.readUInt16LE(raw.length - 22 + 10)).toBe(2);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('Y24: ölçüm fotoğrafının üst verisi', () => {
    const exifSeg = (tiff: Buffer) => {
      const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
      const h = Buffer.from([0xff, 0xe1, 0, 0]);
      h.writeUInt16BE(payload.length + 2, 2);
      return Buffer.concat([h, payload]);
    };
    /** IFD0: yön (isteğe bağlı) + konum metni taşıyan tek girdi. */
    function gpsTiff(orientation?: number): Buffer {
      const secret = Buffer.from('GPS-SECRET-41.0082N', 'latin1');
      const entries = orientation ? 2 : 1;
      const ifdSize = 2 + entries * 12 + 4;
      const t = Buffer.alloc(8 + ifdSize);
      t.write('MM', 0, 'latin1');
      t.writeUInt16BE(42, 2);
      t.writeUInt32BE(8, 4);
      t.writeUInt16BE(entries, 8);
      let e = 10;
      if (orientation) {
        t.writeUInt16BE(0x0112, e);
        t.writeUInt16BE(3, e + 2);
        t.writeUInt32BE(1, e + 4);
        t.writeUInt16BE(orientation, e + 8);
        e += 12;
      }
      t.writeUInt16BE(0x8825, e);
      t.writeUInt16BE(7, e + 2);
      t.writeUInt32BE(secret.length, e + 4);
      t.writeUInt32BE(8 + ifdSize, e + 8);
      return Buffer.concat([t, secret]);
    }
    const withExif = (tiff: Buffer) => Buffer.concat([JPEG.subarray(0, 2), exifSeg(tiff), JPEG.subarray(2)]);

    async function saveMeasurement(f: Fixture, photo: Buffer) {
      const data = { ...measurementPayload().data, clientId: crypto.randomUUID(), photoKinds: ['PHOTO_BOX'] };
      const form = multipart([
        { name: 'data', value: JSON.stringify(data) },
        { name: 'photos', filename: 'kutu.jpg', contentType: 'image/jpeg', data: photo },
      ]);
      const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...f.worker.auth, ...form.headers }, payload: form.payload });
      expect(r.statusCode, r.body).toBe(201);
      const id = r.json().measurement.id as string;
      return inCompany(f.companyId, () => prisma.file.findFirstOrThrow({ where: { measurementId: id }, select: { id: true, path: true, size: true, sha256: true } }));
    }

    it('konum bilgisi diskte yok; saklanan bayt, boyut ve özet temizlenmiş dosyanın; GET /files aynı baytı verir', async () => {
      const input = withExif(gpsTiff());
      expect(input.includes(Buffer.from('SECRET'))).toBe(true);
      const f = await saveMeasurement(A, input);
      const stored = fs.readFileSync(absolutePath(f.path));
      // yön yoktu: EXIF tamamen kalkar, geriye testlerin temiz örnek JPEG'i kalır
      expect(stored.equals(JPEG)).toBe(true);
      expect(f.size).toBe(stored.length);
      expect(f.sha256).toBe(sha256(stored));
      const got = await app.inject({ method: 'GET', url: `${API}/files/${f.id}`, headers: A.admin.auth });
      expect(got.statusCode).toBe(200);
      expect(got.rawPayload.equals(stored)).toBe(true);
    });

    it('yön etiketi asgari EXIF ile korunur (fotoğraf yan dönmez), konum yine yok', async () => {
      const f = await saveMeasurement(A, withExif(gpsTiff(6)));
      const stored = fs.readFileSync(absolutePath(f.path));
      expect(stored.includes(Buffer.from('SECRET'))).toBe(false);
      expect(stored.equals(Buffer.concat([JPEG.subarray(0, 2), exifSeg(orientationTiff(6)), JPEG.subarray(2)]))).toBe(true);
      expect(f.sha256).toBe(sha256(stored));
    });

    it('üst verisi olmayan fotoğraf bayt bayt aynı saklanır', async () => {
      const f = await saveMeasurement(A, JPEG);
      expect(fs.readFileSync(absolutePath(f.path)).equals(JPEG)).toBe(true);
      expect(f.sha256).toBe(sha256(JPEG));
    });

    it('B3b: temizlenemeyen fotoğraf kaydedilir ve dosya kimliğiyle günlüğe yazılır', async () => {
      const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(12), Buffer.from('GPS-SECRET', 'latin1')]);
      const data = { ...measurementPayload().data, clientId: crypto.randomUUID(), photoKinds: ['PHOTO_BOX'] };
      const form = multipart([
        { name: 'data', value: JSON.stringify(data) },
        { name: 'photos', filename: 'kutu.heic', contentType: 'image/heic', data: heic },
      ]);
      const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...A.worker.auth, ...form.headers }, payload: form.payload });
      expect(r.statusCode, r.body).toBe(201);
      const f = await inCompany(A.companyId, () => prisma.file.findFirstOrThrow({ where: { measurementId: r.json().measurement.id }, select: { id: true, path: true } }));
      // saklanan dosya olduğu gibi
      expect(fs.readFileSync(absolutePath(f.path)).equals(heic)).toBe(true);
      // günlük satırı dosya kimliğini taşır
      const warns: { obj: unknown; msg: string }[] = [];
      await inCompany(A.companyId, () =>
        logUncleanPhotos({ warn: (obj: unknown, msg?: string) => void warns.push({ obj, msg: msg ?? '' }) } as never, A.companyId, [
          { path: f.path, meta: 'unsupported', mime: 'image/heic' },
          { path: 'x/temiz.jpg', meta: 'stripped', mime: 'image/jpeg' },
        ]),
      );
      expect(warns).toEqual([{ obj: { fileId: f.id, outcome: 'unsupported', mime: 'image/heic' }, msg: 'measurement photo metadata not removed' }]);
    });

    /** Fikstürün faturasında satırı itiraz listesine alır; fotoğraf kaydı fikstürün ölçümünden. */
    async function disputeReady() {
      const C = await companyFixture(app);
      const v = await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${C.lineId}`, headers: C.admin.auth, payload: { decision: 'VERIFIED' } });
      expect(v.statusCode, v.body).toBe(200);
      return C;
    }
    const disputeOf = async (f: Fixture) => {
      const r = await app.inject({ method: 'GET', url: `${API}/invoices/${f.invoiceId}/dispute`, headers: f.admin.auth });
      expect(r.statusCode, r.body).toBe(200);
      return r.json() as { photoCount: number; linesWithoutPhoto: number };
    };
    const zipOf = async (f: Fixture) => {
      const r = await app.inject({ method: 'GET', url: `${API}/invoices/${f.invoiceId}/dispute/evidence.zip`, headers: f.admin.auth });
      expect(r.statusCode).toBe(200);
      return zipEntries(r.rawPayload);
    };

    it('B3c: değişiklikten önce saklanmış EXIF\'li fotoğraf ZIP\'e temizlenerek girer; saklanan dosya değişmez; sayı aynı', async () => {
      const C = await disputeReady();
      const photo = (await fileRow(C.photoId))!;
      const old = withExif(gpsTiff(6));
      fs.writeFileSync(absolutePath(photo.path), old);
      expect(await disputeOf(C)).toMatchObject({ photoCount: 1, linesWithoutPhoto: 0 });
      const entries = await zipOf(C);
      expect(entries.map((e) => e.name)).toHaveLength(2);
      const inZip = entries[1]!.data;
      expect(inZip.includes(Buffer.from('SECRET'))).toBe(false);
      expect(inZip.equals(Buffer.concat([JPEG.subarray(0, 2), exifSeg(orientationTiff(6)), JPEG.subarray(2)]))).toBe(true);
      expect(fs.readFileSync(absolutePath(photo.path)).equals(old)).toBe(true);
    });

    it('B3c: temizlenemeyen fotoğraf ZIP\'e girmez, iç notta ayrı nedenle; pencere de saymaz', async () => {
      const C = await disputeReady();
      const photo = (await fileRow(C.photoId))!;
      const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.from('GPS-SECRET', 'latin1')]);
      fs.writeFileSync(absolutePath(photo.path), heic);
      expect(await disputeOf(C)).toMatchObject({ photoCount: 0, linesWithoutPhoto: 1 });
      const entries = await zipOf(C);
      expect(entries.map((e) => e.name)).toEqual(['00-itiraz-metni.txt', '01-eksik-dosyalar.txt']);
      expect(entries.some((e) => e.data.includes(Buffer.from('SECRET')))).toBe(false);
      const note = entries[1]!.data.subarray(3).toString('utf8').replace(/\r\n/g, '\n');
      const safe = C.measurement.trackingNo.replace(/[^A-Za-z0-9]/g, '');
      expect(note).toBe([MESSAGES['evidence.unclean'].tr.replace('{count}', '1'), '', `1) Takip no ${C.measurement.trackingNo}: 01-${safe}-kutu-1.jpg`].join('\n'));
      expect(fs.readFileSync(absolutePath(photo.path)).equals(heic)).toBe(true);
    });

    it('B6: başka firmanın klasörünü gösteren yol sayılmaz ve ZIP\'e girmez', async () => {
      const C = await disputeReady();
      const aPhoto = (await fileRow(A.photoId))!;
      expect(onDisk(aPhoto.path)).toBe(true);
      await sup.query(`UPDATE "File" SET path = $2 WHERE id = $1`, [C.photoId, aPhoto.path]);
      expect(await disputeOf(C)).toMatchObject({ photoCount: 0, linesWithoutPhoto: 1 });
      const entries = await zipOf(C);
      expect(entries.map((e) => e.name)).toEqual(['00-itiraz-metni.txt', '01-eksik-dosyalar.txt']);
    });

    it('B6: kayıtlı fotoğraf EVIDENCE_MAX_PHOTOS\'u aşınca pencere diske bakmaz, kayıt sayısını yazar (ZIP 413)', async () => {
      const C = await disputeReady();
      const rows = Array.from({ length: EVIDENCE_MAX_PHOTOS }, () => ({
        companyId: C.companyId,
        kind: 'PHOTO_OTHER' as const,
        mime: 'image/jpeg',
        size: 1,
        path: `${C.companyId}/yok/${crypto.randomUUID()}.jpg`,
        sha256: 'x',
        measurementId: C.measurement.id,
        createdById: C.admin.userId,
      }));
      await inCompany(C.companyId, () => prisma.file.createMany({ data: rows }));
      // diskte yoklar ama taranmadı: kayıt sayısı (1 gerçek + 1.000)
      expect(await disputeOf(C)).toMatchObject({ photoCount: EVIDENCE_MAX_PHOTOS + 1 });
      const zip = await app.inject({ method: 'GET', url: `${API}/invoices/${C.invoiceId}/dispute/evidence.zip`, headers: C.admin.auth });
      expect(zip.statusCode).toBe(413);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('B5: File.holders boş olamaz', () => {
    it('sütun NOT NULL, varsayılanı boş liste; NULL yazılamaz', async () => {
      const col = (
        await sup.query<{ is_nullable: string; column_default: string | null }>(
          `SELECT is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'deciship' AND table_name = 'File' AND column_name = 'holders'`,
        )
      ).rows[0]!;
      expect(col.is_nullable).toBe('NO');
      expect(col.column_default).toContain('ARRAY[]');
      const err = await sup.query(`UPDATE "File" SET holders = NULL WHERE id = $1`, [A.photoId]).then(
        () => null,
        (e: { code?: string }) => e,
      );
      expect(err?.code).toBe('23502');
      expect((await fileRow(A.photoId))!.holders).toEqual([]);
    });
  });
});

/** Merkez dizinden ZIP girişleri (sıkıştırmasız). */
function zipEntries(buf: Buffer): { name: string; data: Buffer }[] {
  const eocd = buf.length - 22;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: { name: string; data: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('latin1');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.push({ name, data: buf.subarray(start, start + size) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
