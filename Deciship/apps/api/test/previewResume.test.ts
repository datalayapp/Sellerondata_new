import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, withCompany } from '../src/db.ts';
import { env } from '../src/env.ts';
import { PREVIEW_FILE_TTL_MS, discardPreviewFile, runFileCleanup, type FileCleanupCursor } from '../src/services/fileCleanup.ts';
import { scanStorageOrphans } from '../src/services/storageOrphans.ts';
import { parseOrphanArgs, runOrphansCli } from '../src/cli/storageOrphans.ts';
import { companyFixture, type Fixture } from './fixtures.ts';
import { createMember, getApp, uniq } from './helpers.ts';
import { testSuperDbUrl } from './testEnv.ts';

const API = '/api/deciship';
const HOUR = 3_600_000;

/**
 * Y80-E2 (sürdürme bandı), Y95 (açık önizlemenin tazelenmesi), Y80-E3 (örnek PDF faturanın arka plan okumasından),
 * Y80-E5 (kaydı olmayan disk dosyası raporu, silmez). Asıl soru veri kaybı: çalışılan önizleme silinmesin, terk edilen
 * yine silinsin, rapor hiçbir şeye dokunmasın.
 */
describe('önizleme sürdürme, tazeleme, örnek PDF, yetim dosya raporu', () => {
  let app: FastifyInstance;
  let A: Fixture;
  let B: Fixture;
  let sup: pg.Client;

  const abs = (rel: string) => path.join(env.storageDir, rel);
  const onDisk = (rel: string) => fs.existsSync(abs(rel));
  const backdate = (id: string, interval: string) =>
    sup.query(`UPDATE "File" SET "updatedAt" = (now() AT TIME ZONE 'UTC') - $2::interval WHERE id = $1`, [id, interval]);
  const quietLog = { warn: () => {} };
  const freshCursor = (): FileCleanupCursor => ({ previews: null, purges: null });

  /** PDF önizleme satırı + diskte dosya (yükleyen `by`, firmanın klasöründe). */
  async function pdfPreview(f: Fixture, o: { by?: string; holders?: string[]; name?: string } = {}) {
    const rel = path.posix.join(f.companyId, 'resume', `${crypto.randomUUID()}.pdf`);
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), '%PDF-1.4\n%sahte\n');
    const row = await withCompany(f.companyId, () =>
      prisma.file.create({
        data: {
          companyId: f.companyId,
          kind: 'INVOICE_SOURCE',
          mime: 'application/pdf',
          size: 16,
          path: rel,
          sha256: 'x',
          originalName: o.name ?? 'fatura.pdf',
          createdById: o.by ?? f.admin.userId,
          holders: o.holders ?? [],
        },
        select: { id: true },
      }),
    );
    return { id: row.id, rel };
  }

  /** Dosyanın okuma işi (sağlayıcı çağrılmaz: satır elle yazılır). */
  async function readJob(f: Fixture, fileId: string, status: 'SUCCEEDED' | 'RUNNING' | 'FAILED' | 'CANCELLED', result?: unknown) {
    return withCompany(f.companyId, () =>
      prisma.job.create({
        data: {
          companyId: f.companyId,
          kind: 'INVOICE_PDF_READ',
          status,
          dedupeKey: `pdf:${crypto.randomUUID()}:tr`,
          refType: 'File',
          refId: fileId,
          label: 'fatura.pdf',
          input: { v: 1, locale: 'tr', aiLimits: {}, fresh: false, fileId },
          createdById: f.admin.userId,
          ...(status === 'SUCCEEDED' ? { result: (result ?? { fileId, format: 'pdf', aiLines: [] }) as object, finishedAt: new Date() } : {}),
          ...(status === 'FAILED' || status === 'CANCELLED' ? { finishedAt: new Date() } : {}),
        },
        select: { id: true },
      }),
    );
  }

  const keep = (who: { authorization: string }, id: string) => app.inject({ method: 'POST', url: `${API}/invoices/preview/${id}/keep`, headers: who });
  const resumable = async (who: { authorization: string }) => {
    const r = await app.inject({ method: 'GET', url: `${API}/invoices/preview/resumable`, headers: who });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().items as { fileId: string; status: string; name: string; jobId: string }[];
  };
  const exists = async (f: Fixture, id: string) => (await withCompany(f.companyId, () => prisma.file.count({ where: { id } }))) > 0;

  /** Yarış testlerinde öbür taraf: satırı açık bir işlemde tutar (RLS'siz). */
  let locker: pg.Client;
  /** Uygulamanın bir bağlantısı bu veritabanında kilit beklemeye başlayana dek bekler. */
  async function untilSomeoneWaitsForLock(timeoutMs = 20_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const r = await sup.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> $1`,
        [(locker as unknown as { processID: number }).processID],
      );
      if (r.rows[0]!.n > 0) return;
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error('istek kilitte beklemeye hiç girmedi');
  }

  beforeAll(async () => {
    app = await getApp();
    A = await companyFixture(app);
    B = await companyFixture(app);
    sup = new pg.Client({ connectionString: testSuperDbUrl(), options: '-c search_path=deciship' });
    await sup.connect();
    locker = new pg.Client({ connectionString: testSuperDbUrl(), options: '-c search_path=deciship' });
    await locker.connect();
  });
  afterAll(async () => {
    await locker?.query('ROLLBACK').catch(() => undefined);
    await locker?.end();
    await sup?.end();
  });

  describe('Y95: açık önizlemenin tazelenmesi', () => {
    it('tazelenen önizleme 24 saatte silinmez; tazelenmeyen (terk edilen) yine silinir', async () => {
      const worked = await pdfPreview(A);
      const left = await pdfPreview(A);
      await backdate(worked.id, '23 hours');
      await backdate(left.id, '25 hours');
      expect((await keep(A.admin.auth, worked.id)).statusCode).toBe(204);
      // bakım: tazelenmeyen 24 saati geçti, tazelenen geçmedi
      await runFileCleanup(Date.now(), quietLog, { cursor: freshCursor() });
      expect(await exists(A, worked.id)).toBe(true);
      expect(onDisk(worked.rel)).toBe(true);
      expect(await exists(A, left.id)).toBe(false);
      expect(onDisk(left.rel)).toBe(false);
      // kullanıcı sonra hiçbir şey yapmazsa 24 saat dolunca o da silinir (bakım ilkesi veritabanı saatine bakar: satır geri alınır)
      await backdate(worked.id, `${PREVIEW_FILE_TTL_MS / HOUR + 1} hours`);
      await runFileCleanup(Date.now(), quietLog, { cursor: freshCursor() });
      expect(await exists(A, worked.id)).toBe(false);
      expect(onDisk(worked.rel)).toBe(false);
    });

    it('yalnız tutan üye tazeler: başka üye, başka firma, faturaya bağlı ve silinmiş önizleme 404; tazeleme hiçbir şey silmez', async () => {
      const p = await pdfPreview(A);
      await backdate(p.id, '20 hours');
      const other = await createMember(app, A.admin.auth, 'ADMIN', 'Öbür Kişi');
      expect((await keep(other.auth, p.id)).statusCode).toBe(404);
      expect((await keep(B.admin.auth, p.id)).statusCode).toBe(404);
      const before = (await sup.query<{ updatedAt: Date }>(`SELECT "updatedAt" FROM "File" WHERE id = $1`, [p.id])).rows[0]!.updatedAt;
      // reddedilen istekler satırı tazelemedi
      expect(Date.now() - before.getTime()).toBeGreaterThan(19 * HOUR - 60_000);
      // faturaya bağlı dosya önizleme değildir
      expect((await keep(A.admin.auth, A.invoiceFileId)).statusCode).toBe(404);
      expect((await keep(A.admin.auth, crypto.randomUUID())).statusCode).toBe(404);
      expect(await exists(A, p.id)).toBe(true);
      expect(onDisk(p.rel)).toBe(true);
    });

    it('yarış: tazeleme satırı tutarken gelen bakım silmesi bekler, kilit altında yeniden bakar ve dosyayı silmez', async () => {
      const p = await pdfPreview(A);
      await backdate(p.id, '25 hours');
      // tazeleme sürüyor: satır yazıldı, işlem henüz bitmedi
      await locker.query('BEGIN');
      await locker.query(`UPDATE "File" SET "updatedAt" = (now() AT TIME ZONE 'UTC') WHERE id = $1`, [p.id]);
      const cleanup = discardPreviewFile(A.companyId, p.id, { olderThan: new Date(Date.now() - PREVIEW_FILE_TTL_MS), log: quietLog });
      await untilSomeoneWaitsForLock();
      await locker.query('COMMIT');
      expect(await cleanup).toBe(false);
      expect(await exists(A, p.id)).toBe(true);
      expect(onDisk(p.rel)).toBe(true);
    });

    it('yarış: bakım satırı silerken gelen tazeleme bekler ve 404 alır (500 değil, dosya geri gelmez)', async () => {
      const p = await pdfPreview(A);
      // bakım silmesi sürüyor: satır kilitli ve silindi, işlem henüz bitmedi
      await locker.query('BEGIN');
      await locker.query(`SELECT id FROM "File" WHERE id = $1 FOR UPDATE`, [p.id]);
      await locker.query(`DELETE FROM "File" WHERE id = $1`, [p.id]);
      const kept = keep(A.admin.auth, p.id);
      await untilSomeoneWaitsForLock();
      await locker.query('COMMIT');
      expect((await kept).statusCode).toBe(404);
      expect(await exists(A, p.id)).toBe(false);
    });

    it('paylaşılan önizlemede listedeki üye tazeler; vazgeçmiş yükleyen tazeleyemez', async () => {
      const other = await createMember(app, A.admin.auth, 'ADMIN', 'Paylaşan');
      const p = await pdfPreview(A, { holders: [other.userId] });
      expect((await keep(other.auth, p.id)).statusCode).toBe(204);
      expect((await keep(A.admin.auth, p.id)).statusCode).toBe(404);
    });
  });

  describe('Y80-E2: sürdürme bandının listesi', () => {
    it('okunmuş (ready) ve okunmakta (reading) olanlar; başarısız, durdurulmuş, işi olmayan, eski, başkasının ve faturaya bağlı olan yok', async () => {
      const C = await companyFixture(app);
      const ready = await pdfPreview(C, { name: 'hazir.pdf' });
      await readJob(C, ready.id, 'SUCCEEDED');
      const reading = await pdfPreview(C, { name: 'okunuyor.pdf' });
      await readJob(C, reading.id, 'RUNNING');
      const failed = await pdfPreview(C);
      await readJob(C, failed.id, 'FAILED');
      const cancelled = await pdfPreview(C);
      await readJob(C, cancelled.id, 'CANCELLED');
      await pdfPreview(C); // işi yok
      const old = await pdfPreview(C);
      await readJob(C, old.id, 'SUCCEEDED');
      await backdate(old.id, '25 hours');
      const other = await createMember(app, C.admin.auth, 'ADMIN', 'Başka');
      const others = await pdfPreview(C, { by: other.userId });
      await readJob(C, others.id, 'SUCCEEDED');

      const items = await resumable(C.admin.auth);
      expect(items.map((i) => [i.fileId, i.status]).sort()).toEqual([[ready.id, 'ready'], [reading.id, 'reading']].sort());
      expect(items.find((i) => i.fileId === ready.id)?.name).toBe('hazir.pdf');
      expect((await resumable(other.auth)).map((i) => i.fileId)).toEqual([others.id]);
      expect(await resumable(B.admin.auth)).toEqual([]);
      // aynı dosyada son iş sayılır: "Yeniden oku" sürerken bant "okunuyor" der
      await readJob(C, ready.id, 'RUNNING');
      expect((await resumable(C.admin.auth)).find((i) => i.fileId === ready.id)?.status).toBe('reading');
    });

    it('ölçüm izni olan rol listeyi göremez (yükleme izni)', async () => {
      const r = await app.inject({ method: 'GET', url: `${API}/invoices/preview/resumable`, headers: A.worker.auth });
      expect(r.statusCode).toBe(403);
    });
  });

  describe('Y80-E3: kurulum örnek faturası, okunmuş PDF önizlemesinden', () => {
    const line = (i: number, tracking: string) => ({ rowIndex: i, trackingNo: tracking, billedKg: 5, netAmount: 50 + i, surcharges: [], rawHash: `h-${tracking}` });
    const sample = (who: { authorization: string }, body: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `${API}/invoices/samples`, headers: who, payload: body });

    it('satırlar işin sonucundan; dosya önizlemenin kendisi (yeniden saklanmaz) faturaya bağlanır; ikinci istek 404', async () => {
      const C = await companyFixture(app);
      const p = await pdfPreview(C, { name: 'ornek.pdf' });
      const t1 = uniq('79');
      const t2 = uniq('79');
      await readJob(C, p.id, 'SUCCEEDED', {
        fileId: p.id,
        format: 'pdf',
        aiLines: [line(0, t1), line(1, t2), line(2, t2)],
        guessedMeta: { invoiceNo: 'PDF-77', invoiceDate: '2026-10-20', currency: 'TRY' },
      });
      const filesBefore = await withCompany(C.companyId, () => prisma.file.count({ where: { companyId: C.companyId } }));
      const r = await sample(C.admin.auth, { fileId: p.id, carrierId: C.carrierId });
      expect(r.statusCode, r.body).toBe(201);
      // birebir aynı satır (aynı rawHash) bir kez
      expect(r.json().lines).toBe(2);
      expect(r.json().invoice).toMatchObject({ invoiceNo: 'PDF-77', invoiceDate: '2026-10-20', sourceFileId: p.id });
      const { inv, file, files } = await withCompany(C.companyId, async () => ({
        inv: await prisma.invoice.findUniqueOrThrow({ where: { id: r.json().invoice.id as string } }),
        file: await prisma.file.findUniqueOrThrow({ where: { id: p.id } }),
        files: await prisma.file.count({ where: { companyId: C.companyId } }),
      }));
      expect(inv.isSample).toBe(true);
      expect(file.invoiceId).toBe(inv.id);
      expect(files).toBe(filesBefore);
      expect(onDisk(p.rel)).toBe(true);
      // artık önizleme değil: ne bantta ne yeniden örnek olur; bakım da silmez
      expect(await resumable(C.admin.auth)).toEqual([]);
      expect((await sample(C.admin.auth, { fileId: p.id, carrierId: C.carrierId })).statusCode).toBe(404);
      await backdate(p.id, '30 hours');
      await runFileCleanup(Date.now(), quietLog, { cursor: freshCursor() });
      expect(onDisk(p.rel)).toBe(true);
    });

    it('okuması bitmemiş, başkasının, başka üyeyle paylaşılan ya da başka firmanın önizlemesi örnek olmaz; hiçbir şey yazılmaz', async () => {
      const C = await companyFixture(app);
      const notRead = await pdfPreview(C);
      await readJob(C, notRead.id, 'RUNNING');
      const other = await createMember(app, C.admin.auth, 'ADMIN', 'Öteki');
      const others = await pdfPreview(C, { by: other.userId });
      await readJob(C, others.id, 'SUCCEEDED', { aiLines: [line(0, uniq('79'))] });
      const shared = await pdfPreview(C, { holders: [C.admin.userId, other.userId] });
      await readJob(C, shared.id, 'SUCCEEDED', { aiLines: [line(0, uniq('79'))] });
      const invoicesBefore = await withCompany(C.companyId, () => prisma.invoice.count({ where: { companyId: C.companyId } }));

      expect((await sample(C.admin.auth, { fileId: notRead.id, carrierId: C.carrierId })).statusCode).toBe(404);
      expect((await sample(C.admin.auth, { fileId: others.id, carrierId: C.carrierId })).statusCode).toBe(404);
      const sh = await sample(C.admin.auth, { fileId: shared.id, carrierId: C.carrierId });
      expect(sh.statusCode, sh.body).toBe(409);
      expect(sh.json().error.code).toBe('PREVIEW_SHARED');
      expect((await sample(B.admin.auth, { fileId: notRead.id, carrierId: B.carrierId })).statusCode).toBe(404);
      expect((await sample(C.admin.auth, { fileId: notRead.id })).statusCode).toBe(400);
      expect(await withCompany(C.companyId, () => prisma.invoice.count({ where: { companyId: C.companyId } }))).toBe(invoicesBefore);
      for (const p of [notRead, others, shared]) expect(await exists(C, p.id)).toBe(true);
    });

    it('yarış: vazgeçme ya da bakım satırı silerken gelen örnek bekler ve 404 alır; fatura yazılmaz', async () => {
      const C = await companyFixture(app);
      const p = await pdfPreview(C);
      await readJob(C, p.id, 'SUCCEEDED', { aiLines: [line(0, uniq('79'))] });
      const invoicesBefore = await withCompany(C.companyId, () => prisma.invoice.count({ where: { companyId: C.companyId } }));
      await locker.query('BEGIN');
      await locker.query(`SELECT id FROM "File" WHERE id = $1 FOR UPDATE`, [p.id]);
      await locker.query(`DELETE FROM "File" WHERE id = $1`, [p.id]);
      const r = sample(C.admin.auth, { fileId: p.id, carrierId: C.carrierId });
      await untilSomeoneWaitsForLock();
      await locker.query('COMMIT');
      const res = await r;
      expect(res.statusCode, res.body).toBe(404);
      expect(await withCompany(C.companyId, () => prisma.invoice.count({ where: { companyId: C.companyId } }))).toBe(invoicesBefore);
    });

    it('JSON gövdesi yoksa eski kural: 415', async () => {
      const r = await app.inject({ method: 'POST', url: `${API}/invoices/samples`, headers: A.admin.auth });
      expect(r.statusCode).toBe(415);
    });
  });

  describe('Y80-E5: kaydı olmayan disk dosyası raporu (silmez)', () => {
    it('kayıtsız ve yalnız temizlenmiş satırın dosyası raporlanır; kayıtlı, yeni ve firma dışı klasör raporlanmaz; hiçbir şey silinmez', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sod-orphans-'));
      try {
        const put = (rel: string, ageH = 5) => {
          const a = path.join(root, rel);
          fs.mkdirSync(path.dirname(a), { recursive: true });
          fs.writeFileSync(a, 'x');
          const t = new Date(Date.now() - ageH * HOUR);
          fs.utimesSync(a, t, t);
          return rel;
        };
        const dir = `${A.companyId}/2026-11`;
        // kayıtlı: fatura kaynak dosyası, fotoğraf, tarife PDF'i (yolları fikstürden)
        const known = [
          ...new Set(
            await withCompany(A.companyId, async () => [
              ...(await prisma.file.findMany({ where: { companyId: A.companyId, purgedAt: null }, select: { path: true } })).map((f) => f.path),
              ...(await prisma.tariffDocument.findMany({ where: { companyId: A.companyId }, select: { path: true } })).map((d) => d.path),
            ]),
          ),
        ].filter((p) => p.startsWith(`${A.companyId}/`));
        expect(known.length).toBeGreaterThan(1);
        for (const k of known) put(k);
        const orphan = put(`${dir}/${crypto.randomUUID()}.pdf`);
        const young = put(`${dir}/${crypto.randomUUID()}.pdf`, 0);
        // yalnız temizlenmiş satırın gösterdiği dosya (disk silinemedi)
        const purgedRel = `${dir}/${crypto.randomUUID()}.csv`;
        put(purgedRel);
        await withCompany(A.companyId, () =>
          prisma.file.create({ data: { companyId: A.companyId, kind: 'INVOICE_SOURCE', mime: 'text/csv', size: 1, path: purgedRel, sha256: 'x', createdById: A.admin.userId, purgedAt: new Date() } }),
        );
        // silinmiş firmanın klasörü, firma dışı klasör, kökte dosya
        const gone = put(`${crypto.randomUUID()}/2026-01/a.pdf`);
        put('fx/2026-11-01.json');
        const loose = put('loose.bin');

        const r = await scanStorageOrphans({ root });
        const byPath = new Map(r.orphans.map((o) => [o.path, o]));
        expect([...byPath.keys()].sort()).toEqual([orphan, purgedRel, gone, loose].sort());
        expect(byPath.get(orphan)).toMatchObject({ reason: 'orphan', companyId: A.companyId, companyKnown: true });
        expect(byPath.get(purgedRel)).toMatchObject({ reason: 'purged' });
        expect(byPath.get(gone)).toMatchObject({ reason: 'orphan', companyKnown: false });
        expect(byPath.get(loose)).toMatchObject({ companyId: null });
        expect(r.young).toBe(1);
        expect(r.otherDirs).toEqual(['fx']);
        // fx klasörü taranmaz: kayıtlılar + yetim, yeni, temizlenmiş, silinmiş firmanınki, kökteki
        expect(r.scanned).toBe(known.length + 5);
        // hiçbir şey silinmedi
        for (const rel of [...known, orphan, young, purgedRel, gone, loose]) expect(fs.existsSync(path.join(root, rel))).toBe(true);
        // B firmasının satırları A'nın klasöründeki dosyayı "kayıtlı" yapmaz (firma bağlamında aranır)
        expect(byPath.has(orphan)).toBe(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('depo klasörü yoksa boş rapor; komut bayrakları', async () => {
      const r = await scanStorageOrphans({ root: path.join(os.tmpdir(), `sod-none-${crypto.randomUUID()}`) });
      expect(r).toMatchObject({ scanned: 0, orphans: [], young: 0 });
      expect(parseOrphanArgs(['--min-age-hours', '2', '--json'])).toEqual({ minAgeMs: 2 * HOUR, json: true });
      expect(() => parseOrphanArgs(['--delete'])).toThrow(/unknown argument/);
      const errs: string[] = [];
      expect(await runOrphansCli(['--min-age-hours', '-1'], { log: () => {}, error: (l) => errs.push(l) })).toBe(2);
      expect(errs.join('\n')).toContain('Nothing is deleted');
    });
  });
});
