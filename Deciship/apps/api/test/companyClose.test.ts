/**
 * Firmayı kapatma (bölüm B): `org.closed`, `org.reopened`, `org.purged`.
 * - kapalı firmada uçlar 409 ORG_CLOSED, imzalı dosya 404, JIT üye açmaz; geri açılınca her şey eskisi gibi;
 * - arka plan işleri (iş kuyruğu, yeniden hesap taraması, hatırlatma, eski iş temizliği, bakımın firma listesi) kapalı firmayı atlar;
 * - kapatma ve geri açma `closedVersion` sırasıyla (eşit ya da küçük sürüm uygulanmaz), tekrar eden olay işlenmez;
 * - kalıcı silme firmanın firma sütunlu her tablosundaki bütün satırlarını, firma satırını ve dosyalarını siler; başka firmaya
 *   dokunmaz; tekrar edilebilir; sonra gelen olay ya da JIT firmayı yeniden kurmaz; yarıda kalan silmeyi bakım tamamlar.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { PlatformEvent } from '@sellerondata/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, setTxCompany, withCompany, withEventScope, withMaintenanceScope } from '../src/db.ts';
import { env } from '../src/env.ts';
import { signFileToken } from '../src/lib/storage.ts';
import { checkPurgeTables, PURGE_TABLES, purgeCompany, settleCompanyPurges } from '../src/services/companyPurge.ts';
import { maintenanceCompanyIds } from '../src/services/fileCleanup.ts';
import { companyPurgeQueue, runCompanyPurges } from '../src/services/maintenance.ts';
import { cleanupFinishedJobs, enqueueJob, findJob } from '../src/services/jobs/queue.ts';
import { overrideJobKindForTest } from '../src/services/jobs/registry.ts';
import { closeInlineJobs, runJobInline, startJobRunner } from '../src/services/jobs/runner.ts';
import { pendingRecompareCandidates } from '../src/services/measurementQueue.ts';
import { runDisputeReminders } from '../src/services/reminders.ts';
import { companyFixture, type Fixture } from './fixtures.ts';
import { getApp, issueIdentity, registerCompany, sendEvent, uniq } from './helpers.ts';
import { testSuperDbUrl } from './testEnv.ts';

const API = '/api/deciship';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

let version = 100;
const closed = (orgId: string, v = ++version, eventId: string = crypto.randomUUID()): PlatformEvent => ({
  eventId,
  type: 'org.closed',
  orgId,
  product: 'deciship',
  closedAt: '2026-11-13T10:00:00.000Z',
  purgeAfter: '2026-12-13T10:00:00.000Z',
  version: v,
});
const reopened = (orgId: string, v = ++version): PlatformEvent => ({ eventId: crypto.randomUUID(), type: 'org.reopened', orgId, product: 'deciship', version: v });
const purged = (orgId: string, eventId: string = crypto.randomUUID()): PlatformEvent => ({ eventId, type: 'org.purged', orgId, product: 'deciship' });
const memberUpserted = (orgId: string, membershipId = crypto.randomUUID()): PlatformEvent => ({
  eventId: crypto.randomUUID(),
  type: 'member.upserted',
  orgId,
  product: 'deciship',
  membershipId,
  personId: crypto.randomUUID(),
  name: 'Geç Gelen',
  orgRole: 'MEMBER',
  role: 'AUDITOR',
  active: true,
  epoch: 1,
});

describe('firmayı kapatma', () => {
  let app: FastifyInstance;
  let sup: pg.Client;
  const code = (res: { json: () => unknown }) => (res.json() as { error?: { code?: string } }).error?.code;
  const companyRow = (id: string) => withCompany(id, () => prisma.company.findFirst({ where: { id }, select: { closedAt: true, closedVersion: true, name: true } }));
  const send = async (event: PlatformEvent) => {
    const res = await sendEvent(app, event);
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { outcome: string }).outcome;
  };
  /** Firma sütunlu gerçek tablolar (kataloğun kendisinden; görünüm sayılmaz): kalıcı silme listesi bununla karşılaştırılır. */
  const companyTables = async () =>
    (
      await sup.query(
        `SELECT c.relname::text AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'deciship' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
            AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'companyId' AND NOT a.attisdropped)
          ORDER BY 1`,
      )
    ).rows.map((r) => r.t as string);
  /**
   * Silme kaydını olay alıcısının yolundan yazar (olay kapsamı + firma bağlamı, `identity.ts`): olay işlemi commit oldu, arkadaki
   * silme başlamadan süreç düştü. `asCompany` başka firmanın bağlamı, `data` baştan dolu sütunlar (ikisi de ilke denetimi).
   */
  const recordPurge = (companyId: string, data: { createdAt?: Date; attemptedAt?: Date; completedAt?: Date } = {}, asCompany = companyId) =>
    withEventScope(() =>
      prisma.$transaction(async (tx) => {
        await setTxCompany(tx, asCompany);
        await tx.companyPurge.create({ data: { companyId, ...data } });
      }),
    );
  const counts = async (companyId: string) => {
    const out: Record<string, number> = {};
    // silme kaydı (`CompanyPurge`) bilerek kalır: ayrı denetlenir
    for (const t of (await companyTables()).filter((x) => x !== 'CompanyPurge')) out[t] = (await sup.query(`SELECT count(*)::int AS n FROM "${t}" WHERE "companyId" = $1`, [companyId])).rows[0].n;
    out.Company = (await sup.query(`SELECT count(*)::int AS n FROM "Company" WHERE "id" = $1`, [companyId])).rows[0].n;
    return out;
  };

  beforeAll(async () => {
    app = await getApp();
    sup = new pg.Client({ connectionString: testSuperDbUrl(), options: '-c search_path=deciship' });
    await sup.connect();
  });
  afterAll(async () => {
    await settleCompanyPurges();
    await sup.end();
  });

  it('kapalı firmada uçlar 409 ORG_CLOSED, imzalı dosya 404, JIT üye açmaz; başka firma etkilenmez; geri açılınca her şey eskisi gibi', async () => {
    const A = await registerCompany(app, uniq('Kapanan '));
    const B = await registerCompany(app, uniq('Açık '));
    const carrier = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: A.auth, payload: { code: 'aras', name: 'Aras' } });
    expect(carrier.statusCode, carrier.body).toBe(201);

    expect(await send(closed(A.companyId))).toBe('processed');
    expect((await companyRow(A.companyId))?.closedAt).toEqual(new Date('2026-11-13T10:00:00.000Z'));

    for (const req of [
      { method: 'GET' as const, url: `${API}/me` },
      { method: 'GET' as const, url: `${API}/carriers` },
      { method: 'GET' as const, url: `${API}/platform/overview` },
      { method: 'POST' as const, url: `${API}/carriers`, payload: { code: 'yurtici', name: 'Yurtiçi' } },
    ]) {
      const res = await app.inject({ ...req, headers: A.auth });
      expect(res.statusCode, `${req.method} ${req.url}`).toBe(409);
      expect(code(res)).toBe('ORG_CLOSED');
    }
    expect((await app.inject({ method: 'GET', url: `${API}/me`, headers: B.auth })).statusCode).toBe(200);

    // JIT: tanınmayan üye kapalı firmada açılmaz
    const late = await issueIdentity({ companyId: A.companyId, orgName: A.orgName, role: 'AUDITOR' });
    const jit = await app.inject({ method: 'GET', url: `${API}/me`, headers: late.auth });
    expect(jit.statusCode).toBe(409);
    expect(code(jit)).toBe('ORG_CLOSED');
    expect(await withCompany(A.companyId, () => prisma.member.count({ where: { id: late.userId } }))).toBe(0);

    // imzalı dosya bağlantısı oturuma uğramaz: kapalı firmada 404
    const photoFile = await withCompany(A.companyId, async () => {
      const rel = path.posix.join(A.companyId, 'test', `${crypto.randomUUID()}.jpg`);
      fs.mkdirSync(path.dirname(path.join(env.storageDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(env.storageDir, rel), 'jpeg');
      return prisma.file.create({ data: { companyId: A.companyId, kind: 'PHOTO_OTHER', mime: 'image/jpeg', size: 4, path: rel, sha256: 'x', createdById: A.userId } });
    });
    const signed = `${API}/files/${photoFile.id}?t=${signFileToken({ fileId: photoFile.id, companyId: A.companyId, membershipId: A.userId, epoch: A.epoch })}`;
    expect((await app.inject({ method: 'GET', url: signed })).statusCode).toBe(404);

    // geri açılınca: uçlar, imzalı bağlantı, JIT ve veri kapanıştan önceki gibi
    expect(await send(reopened(A.companyId))).toBe('processed');
    expect((await companyRow(A.companyId))?.closedAt).toBeNull();
    const list = await app.inject({ method: 'GET', url: `${API}/carriers`, headers: A.auth });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).toContain('Aras');
    expect((await app.inject({ method: 'GET', url: signed })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `${API}/me`, headers: late.auth })).statusCode).toBe(200);
  });

  it('sıra: eşit ya da küçük sürümlü kapatma/geri açma uygulanmaz, tekrar eden olay işlenmez; sırası bozuk olay firmayı açık kurmaz', async () => {
    const A = await registerCompany(app, uniq('Sıra '));
    const first = closed(A.companyId, 10);
    expect(await send(first)).toBe('processed');
    expect(await send(first)).toBe('duplicate');
    // gecikmiş eski geri açma: küçük sürüm auth-kit'te bayat
    expect(await send(reopened(A.companyId, 9))).toBe('stale');
    // eşit sürüm: işlenir ama uygulanmaz (sözleşme)
    expect(await send(reopened(A.companyId, 10))).toBe('processed');
    expect(await companyRow(A.companyId)).toMatchObject({ closedVersion: 10 });
    expect((await companyRow(A.companyId))?.closedAt).not.toBeNull();
    expect(await send(reopened(A.companyId, 12))).toBe('processed');
    expect(await companyRow(A.companyId)).toMatchObject({ closedAt: null, closedVersion: 12 });
    // geri açmadan önceki kapatma gecikip gelirse firmayı kapatmaz
    expect(await send(closed(A.companyId, 11))).toBe('stale');
    expect(await send(closed(A.companyId, 12))).toBe('processed');
    expect(await companyRow(A.companyId)).toMatchObject({ closedAt: null, closedVersion: 12 });
    // ad sürümü ayrı sayaçtır: kapalılık ad olayından etkilenmez, ad da kapalılıktan
    expect(await send({ eventId: crypto.randomUUID(), type: 'org.updated', orgId: A.companyId, product: 'deciship', name: 'Yeni Ad', version: 13 })).toBe('processed');
    expect(await companyRow(A.companyId)).toMatchObject({ closedAt: null, closedVersion: 12, name: 'Yeni Ad' });

    // hiç görülmemiş firma: önce kapatma gelir, sonra üye olayı → firma kapalı kalır
    const X = crypto.randomUUID();
    expect(await send(closed(X, 3))).toBe('processed');
    expect(await send(memberUpserted(X))).toBe('processed');
    expect((await companyRow(X))?.closedAt).not.toBeNull();
    // hiç görülmemiş firma: önce geri açma (v5) gelir, gecikmiş kapatma (v4) onu kapatmaz
    const Y = crypto.randomUUID();
    expect(await send(reopened(Y, 5))).toBe('processed');
    expect(await send(closed(Y, 4))).toBe('stale');
    expect(await companyRow(Y)).toMatchObject({ closedAt: null, closedVersion: 5 });
  });

  it('arka plan işleri kapalı firmayı atlar, kaydına dokunmaz; geri açılınca kaldığı yerden', async () => {
    const A = await companyFixture(app);
    const B = await registerCompany(app, uniq('İş açık '));
    const restore = overrideJobKindForTest('INVOICE_PDF_READ', { handler: async () => async () => ({ ok: true }) });
    try {
      // önceki dosyaların kalan işleri bu dosyanın çalıştırıcısına düşmesin
      await sup.query(`UPDATE "Job" SET "status" = 'CANCELLED', "finishedAt" = now() AT TIME ZONE 'UTC', "lockedBy" = NULL, "lockedUntil" = NULL WHERE "status" IN ('QUEUED', 'RUNNING')`);
      // yeniden hesap işareti, eski bitmiş iş, hatırlatma koşulları (Türkiye, sessiz saat yok sayılır)
      await sup.query(`UPDATE "Measurement" SET "recomparePendingAt" = (now() AT TIME ZONE 'UTC') - interval '1 hour' WHERE "id" = $1`, [A.measurement.id]);
      await sup.query(`UPDATE "Company" SET "settings" = "settings" || '{"country":"TR"}'::jsonb WHERE "id" = $1`, [A.companyId]);
      const oldJob = await withCompany(A.companyId, () =>
        prisma.job.create({
          data: { companyId: A.companyId, kind: 'INVOICE_PDF_READ', dedupeKey: `old:${crypto.randomUUID()}`, input: { locale: 'tr' }, status: 'SUCCEEDED', finishedAt: new Date(Date.now() - 30 * 86_400_000) },
        }),
      );

      expect(await send(closed(A.companyId))).toBe('processed');

      const queued = await enqueueJob({ companyId: A.companyId, createdById: A.admin.userId, kind: 'INVOICE_PDF_READ', dedupeKey: uniq('k:'), input: { locale: 'tr' } });
      const open = await enqueueJob({ companyId: B.companyId, createdById: B.userId, kind: 'INVOICE_PDF_READ', dedupeKey: uniq('k:'), input: { locale: 'tr' } });
      // satır içi kip de almaz
      expect(await runJobInline(queued.jobId, silent)).toBe(false);
      // çalıştırıcı açık firmanın işini alır, kapalınınkini almaz (deneme hakkı harcanmaz)
      const runner = startJobRunner(silent, { pollMs: 20, leaseMs: 2000, graceMs: 300 });
      try {
        const until = Date.now() + 10_000;
        while ((await findJob(B.companyId, open.jobId))?.status !== 'SUCCEEDED' && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
        expect((await findJob(B.companyId, open.jobId))?.status).toBe('SUCCEEDED');
        await new Promise((r) => setTimeout(r, 150));
        expect(await findJob(A.companyId, queued.jobId)).toMatchObject({ status: 'QUEUED', attempts: 0 });
      } finally {
        await runner.stop();
      }

      const candidates = await pendingRecompareCandidates(Date.now(), 10_000);
      expect(candidates.measurements.map((m) => m.id)).not.toContain(A.measurement.id);
      expect(await maintenanceCompanyIds()).not.toContain(A.companyId);
      expect(await maintenanceCompanyIds()).toContain(B.companyId);
      await cleanupFinishedJobs();
      expect(await findJob(A.companyId, oldJob.id)).not.toBeNull();
      const reminders = await runDisputeReminders(new Date(), { companyId: A.companyId, dryRun: true, ignoreQuietHours: true });
      expect(reminders.companies).toBe(0);

      // geri açılınca
      expect(await send(reopened(A.companyId))).toBe('processed');
      expect(await runJobInline(queued.jobId, silent)).toBe(true);
      expect((await findJob(A.companyId, queued.jobId))?.status).toBe('SUCCEEDED');
      expect((await pendingRecompareCandidates(Date.now(), 10_000)).measurements.map((m) => m.id)).toContain(A.measurement.id);
      expect(await maintenanceCompanyIds()).toContain(A.companyId);
      expect((await runDisputeReminders(new Date(), { companyId: A.companyId, dryRun: true, ignoreQuietHours: true })).companies).toBe(1);
      await cleanupFinishedJobs();
      expect(await findJob(A.companyId, oldJob.id)).toBeNull();
    } finally {
      restore();
      await closeInlineJobs();
      await sup.query(`UPDATE "Measurement" SET "recomparePendingAt" = NULL WHERE "id" = $1`, [A.measurement.id]);
    }
  });

  describe('kalıcı silme', () => {
    let A: Fixture;
    let B: Fixture;
    let before: Record<string, number>;
    let bBefore: Record<string, number>;
    const disk = (rel: string) => path.join(env.storageDir, rel);
    let aPaths: string[];
    let bPaths: string[];

    beforeAll(async () => {
      A = await companyFixture(app);
      B = await companyFixture(app);
      // fikstürde olmayan firma tabloları da dolu olsun (rls.test.ts ile aynı)
      for (const f of [A, B]) {
        await withCompany(f.companyId, async () => {
          await prisma.tariffRevision.create({ data: { companyId: f.companyId, tariffId: f.tariffId, tariffName: 'Fikstür', snapshot: {}, currency: 'TRY' } });
          await prisma.aiUsage.create({
            data: { companyId: f.companyId, memberId: f.admin.userId, kind: 'SCALE_READ', status: 'OK', period: '2026-11', model: 'claude-sonnet-5-5', inputTokens: 10, outputTokens: 5, cost: '0.007000', priceVersion: 'fixture', durationMs: 100 },
          });
          await prisma.aiCreditEntry.create({ data: { companyId: f.companyId, kind: 'GRANT', amount: '10.00', period: '2026-11', operator: 'fixture' } });
          await prisma.aiResultCache.create({
            data: { companyId: f.companyId, kind: 'INVOICE_MAPPING', cacheKey: crypto.randomUUID(), model: 'claude-sonnet-5-5', result: {}, expiresAt: new Date(Date.now() + 86_400_000) },
          });
          await prisma.job.create({ data: { companyId: f.companyId, kind: 'INVOICE_PDF_READ', dedupeKey: `fixture:${crypto.randomUUID()}`, input: { v: 1, locale: 'tr' }, createdById: f.admin.userId } });
          await prisma.invoiceRecheck.create({ data: { invoiceId: f.invoiceId, companyId: f.companyId, pendingAt: new Date() } });
        });
      }
      const paths = async (id: string) => (await sup.query(`SELECT path FROM "File" WHERE "companyId" = $1`, [id])).rows.map((r) => r.path as string);
      aPaths = await paths(A.companyId);
      bPaths = await paths(B.companyId);
      // kaydı olmayan (yetim) dosya da firmanın klasöründe: klasörle gider
      fs.mkdirSync(disk(path.join(A.companyId, 'yetim')), { recursive: true });
      fs.writeFileSync(disk(path.join(A.companyId, 'yetim', 'x.bin')), 'x');
      before = await counts(A.companyId);
      bBefore = await counts(B.companyId);
    });

    it('silme listesi firma sütunlu bütün tabloları kapsar; fikstür her tabloda satır açar', async () => {
      const tables = (await companyTables()).filter((t) => t !== 'CompanyPurge');
      expect([...PURGE_TABLES].sort()).toEqual([...tables].sort());
      for (const [t, n] of Object.entries(before)) expect(n, `${t}: fikstürde satır yok, silme kanıtlanmaz`).toBeGreaterThan(0);
      expect(aPaths.length).toBeGreaterThan(0);
      for (const rel of [...aPaths, ...bPaths]) expect(fs.existsSync(disk(rel)), rel).toBe(true);
    });

    it('silme listesi kataloğa uyar: gerçek tablolar ve sütunları, uygulama rolünün silme yetkisi, firma sütunsuz çocuğun anahtarı, sıra', async () => {
      // uygulama rolünün bağlantısıyla (yetki o rolün)
      expect(await checkPurgeTables()).toEqual([]);
    });

    it('katalog denetimi bozuk listeyi bulur: sıra, eksik ve olmayan tablo, CASCADE olmadan bağlı çocuk ve torun, silme yetkisi ve ilkesi; görünüm ve SET NULL sayılmaz', async () => {
      const list = [...PURGE_TABLES] as string[];
      // çocuk (Invoice) silmeyi engelleyen bağla (RESTRICT, kaynak dosya) ebeveyninden (File) sonra
      const swapped = list.filter((t) => t !== 'Invoice');
      swapped.splice(swapped.indexOf('File') + 1, 0, 'Invoice');
      expect(await checkPurgeTables({ tables: swapped })).toEqual([{ table: 'Invoice', issue: 'order', detail: expect.stringContaining('File') }]);
      // dosya tablosu ebeveyniyle CASCADE gider (TariffDocument → Carrier): satırların yolları diske ulaşmaz
      const cascaded = list.filter((t) => t !== 'TariffDocument');
      cascaded.splice(cascaded.indexOf('Carrier') + 1, 0, 'TariffDocument');
      expect(await checkPurgeTables({ tables: cascaded })).toEqual([{ table: 'TariffDocument', issue: 'cascade-returning', detail: expect.stringContaining('Carrier') }]);
      // eksik tablo ve şemada olmayan tablo
      expect(await checkPurgeTables({ tables: [...list.filter((t) => t !== 'BoxPreset'), 'Yok'] })).toEqual([
        { table: 'BoxPreset', issue: 'not-listed', detail: expect.any(String) },
        { table: 'Yok', issue: 'missing-table', detail: expect.any(String) },
      ]);
      // Süper kullanıcının geri alınan işleminde geçici nesneler: firma sütunsuz çocuk (CASCADE'li, CASCADE'siz, SET NULL), CASCADE'li
      // çocuğa CASCADE'siz bağlı torun, uygulama rolünün silemediği firma tablosu, RLS'li ama firma bağlamında silme ilkesi olmayan
      // firma tablosu, firma sütunlu görünüm. Denetim uygulama rolünün yetkisine ve ilkesine bakar.
      await sup.query('BEGIN');
      try {
        await sup.query(`CREATE TABLE "PurgeProbeChild" ("id" text PRIMARY KEY, "presetId" text REFERENCES "BoxPreset"("id"))`);
        await sup.query(`CREATE TABLE "PurgeProbeCascade" ("id" text PRIMARY KEY, "presetId" text REFERENCES "BoxPreset"("id") ON DELETE CASCADE)`);
        await sup.query(`CREATE TABLE "PurgeProbeLeaf" ("id" text PRIMARY KEY, "cascadeId" text REFERENCES "PurgeProbeCascade"("id"))`);
        await sup.query(`CREATE TABLE "PurgeProbeSetNull" ("id" text PRIMARY KEY, "presetId" text REFERENCES "BoxPreset"("id") ON DELETE SET NULL)`);
        await sup.query(`CREATE TABLE "PurgeProbeOwn" ("id" text PRIMARY KEY, "companyId" text NOT NULL)`);
        await sup.query(`CREATE TABLE "PurgeProbeNoPolicy" ("id" text PRIMARY KEY, "companyId" text NOT NULL)`);
        await sup.query(`ALTER TABLE "PurgeProbeNoPolicy" ENABLE ROW LEVEL SECURITY`);
        await sup.query(`ALTER TABLE "PurgeProbeNoPolicy" FORCE ROW LEVEL SECURITY`);
        await sup.query(`CREATE POLICY company_read ON "PurgeProbeNoPolicy" FOR SELECT USING ("companyId" = current_setting('app.company_id', true))`);
        await sup.query(`GRANT SELECT, DELETE ON "PurgeProbeNoPolicy" TO sod_deciship`);
        await sup.query(`CREATE VIEW "PurgeProbeView" AS SELECT "id", "companyId" FROM "BoxPreset"`);
        const probe = await checkPurgeTables({
          tables: [...list.slice(0, -1), 'PurgeProbeOwn', 'PurgeProbeNoPolicy', 'Member'],
          query: async (sql, params) => (await sup.query(sql, params)).rows,
          role: 'sod_deciship',
        });
        expect(probe).toEqual([
          { table: 'PurgeProbeOwn', issue: 'no-delete-privilege', detail: expect.any(String) },
          { table: 'PurgeProbeNoPolicy', issue: 'no-delete-policy', detail: expect.any(String) },
          { table: 'PurgeProbeChild', issue: 'blocking-reference', detail: expect.stringContaining('BoxPreset') },
          { table: 'PurgeProbeLeaf', issue: 'blocking-reference', detail: expect.stringContaining('PurgeProbeCascade') },
        ]);
      } finally {
        await sup.query('ROLLBACK');
      }
    });

    it('silme kaydının ilkeleri: yalnız olay alıcısı bitmemiş kayıt ekler; deneme anı firma bağlamında; bitiş bir kez dolar, geri alınmaz; bakım yazmaz; silinmez', async () => {
      const id = crypto.randomUUID();
      const other = crypto.randomUUID();
      const row = async () => (await sup.query(`SELECT "completedAt", "attemptedAt", "createdAt" FROM "CompanyPurge" WHERE "companyId" = $1`, [id])).rows[0];
      const denied = /42501/;
      // ekleme: firma bağlamı tek başına yazamaz (olay kapsamı yok); olay kapsamı başka firmanın bağlamıyla yazamaz; kayıt baştan
      // "bitti" ya da "denendi" eklenemez
      await expect(withCompany(id, () => prisma.companyPurge.create({ data: { companyId: id } }))).rejects.toThrow(denied);
      await expect(withEventScope(() => prisma.companyPurge.create({ data: { companyId: id } }))).rejects.toThrow(denied);
      await expect(recordPurge(id, {}, other)).rejects.toThrow(denied);
      await expect(recordPurge(id, { completedAt: new Date() })).rejects.toThrow(denied);
      await expect(recordPurge(id, { attemptedAt: new Date() })).rejects.toThrow(denied);
      expect(await row()).toBeUndefined();
      await recordPurge(id);
      expect(await row()).toMatchObject({ completedAt: null, attemptedAt: null });
      // başka firmanın bağlamı görmez, yazamaz
      expect(await withCompany(other, () => prisma.companyPurge.findFirst({ where: { companyId: id } }))).toBeNull();
      expect((await withCompany(other, () => prisma.companyPurge.updateMany({ where: { companyId: id }, data: { completedAt: new Date() } }))).count).toBe(0);
      expect((await withCompany(other, () => prisma.companyPurge.updateMany({ where: { companyId: id }, data: { attemptedAt: new Date() } }))).count).toBe(0);

      // deneme anı: firma bağlamında bitmemiş kayıtta yazılır (kayıt bitmemiş kalır); bakım kapsamı hiçbir şey yazmaz
      expect((await withCompany(id, () => prisma.companyPurge.updateMany({ where: { companyId: id }, data: { attemptedAt: new Date() } }))).count).toBe(1);
      expect((await row()).attemptedAt).toBeInstanceOf(Date);
      expect((await withMaintenanceScope(() => prisma.companyPurge.updateMany({ where: { companyId: id }, data: { attemptedAt: new Date(0) } }))).count).toBe(0);
      expect((await withMaintenanceScope(() => prisma.companyPurge.updateMany({ where: { companyId: id }, data: { completedAt: new Date() } }))).count).toBe(0);
      expect((await row()).completedAt).toBeNull();
      // kimlik ve açılış anı hiçbir kapsamda değişmez (sütun yetkisi)
      await expect(withMaintenanceScope(() => prisma.companyPurge.updateMany({ where: { companyId: id }, data: { createdAt: new Date(0) } }))).rejects.toThrow(denied);
      await expect(withCompany(id, () => prisma.companyPurge.updateMany({ where: { companyId: id }, data: { createdAt: new Date(0) } }))).rejects.toThrow(denied);
      await expect(withCompany(id, () => prisma.companyPurge.updateMany({ where: { companyId: id }, data: { companyId: other, completedAt: new Date() } }))).rejects.toThrow(denied);

      // bitiş: firma bağlamında bir kez; sonra ne boşaltılır ne değişir; deneme anı da bitmiş kayda yazılmaz
      expect((await withCompany(id, () => prisma.companyPurge.updateMany({ where: { companyId: id }, data: { completedAt: new Date() } }))).count).toBe(1);
      const done = await row();
      expect(done.completedAt).toBeInstanceOf(Date);
      expect((await withCompany(id, () => prisma.companyPurge.updateMany({ where: { companyId: id }, data: { completedAt: null } }))).count).toBe(0);
      expect((await withCompany(id, () => prisma.companyPurge.updateMany({ where: { companyId: id }, data: { completedAt: new Date(0) } }))).count).toBe(0);
      expect((await withCompany(id, () => prisma.companyPurge.updateMany({ where: { companyId: id }, data: { attemptedAt: new Date(0) } }))).count).toBe(0);
      expect((await withMaintenanceScope(() => prisma.companyPurge.updateMany({ where: { companyId: id }, data: { attemptedAt: new Date(0) } }))).count).toBe(0);

      // silme yok: hiçbir kapsamda
      const remove = () => prisma.companyPurge.deleteMany({ where: { companyId: id } });
      await expect(withCompany(id, remove)).rejects.toThrow(denied);
      await expect(withMaintenanceScope(remove)).rejects.toThrow(denied);
      await expect(withEventScope(remove)).rejects.toThrow(denied);
      expect(await row()).toEqual(done);
    });

    it('silinemeyen satır turu boşa döndürmez: hata günlüğe yazılır, in-progress; engel kalkınca silme biter', async () => {
      const G = await registerCompany(app, uniq('Engelli '));
      await withCompany(G.companyId, () => prisma.boxPreset.create({ data: { companyId: G.companyId, name: 'Engel', lengthCm: 10, widthCm: 10, heightCm: 10 } }));
      expect(await send(closed(G.companyId))).toBe('processed');
      await recordPurge(G.companyId);
      // dosyalar sırayla koşar (vitest.config `fileParallelism: false`): geçici ilke yalnız bu firmanın kolilerinin silinmesini engeller
      await sup.query(`CREATE POLICY purge_probe_block ON "BoxPreset" AS RESTRICTIVE FOR DELETE USING ("companyId" <> '${G.companyId}')`);
      const errors: unknown[] = [];
      try {
        const r = await purgeCompany(G.companyId, { warn: () => undefined, error: (obj) => errors.push(obj) });
        expect(r.state).toBe('in-progress');
        expect(errors).toEqual([expect.objectContaining({ companyId: G.companyId, table: 'BoxPreset' })]);
        const left = await counts(G.companyId);
        expect(left.BoxPreset).toBeGreaterThan(0);
        expect(left.Company).toBe(1);
      } finally {
        await sup.query(`DROP POLICY purge_probe_block ON "BoxPreset"`);
      }
      expect((await purgeCompany(G.companyId, silent)).state).toBe('completed');
      for (const [t, n] of Object.entries(await counts(G.companyId))) expect(n, t).toBe(0);
    });

    it('silme kaydı yoksa hiçbir şey silinmez', async () => {
      expect(await purgeCompany(B.companyId, silent)).toEqual({ state: 'not-requested' });
      expect(await counts(B.companyId)).toEqual(bBefore);
    });

    it('org.purged: firmanın bütün satırları, firma satırı ve dosyaları gider; olmayan dosya sorun değil; başka firma aynen kalır', async () => {
      // kaydı duran ama diskte olmayan dosya
      fs.rmSync(disk(aPaths[0]!), { force: true });
      const event = purged(A.companyId);
      expect(await send(event)).toBe('processed');
      await settleCompanyPurges();

      const after = await counts(A.companyId);
      for (const [t, n] of Object.entries(after)) expect(n, t).toBe(0);
      for (const rel of aPaths) expect(fs.existsSync(disk(rel)), rel).toBe(false);
      expect(fs.existsSync(disk(A.companyId))).toBe(false);
      const purge = await withCompany(A.companyId, () => prisma.companyPurge.findFirst({ where: { companyId: A.companyId } }));
      expect(purge?.completedAt).toBeInstanceOf(Date);

      expect(await counts(B.companyId)).toEqual(bBefore);
      for (const rel of bPaths) expect(fs.existsSync(disk(rel)), rel).toBe(true);
      expect((await app.inject({ method: 'GET', url: `${API}/me`, headers: B.admin.auth })).statusCode).toBe(200);
      const carriers = await app.inject({ method: 'GET', url: `${API}/carriers`, headers: B.admin.auth });
      expect(JSON.stringify(carriers.json())).toContain('Aras');

      // tekrar: aynı olay işlenmez, yeni kimlikli silme olayı zararsız
      expect(await send(event)).toBe('duplicate');
      expect(await send(purged(A.companyId))).toBe('processed');
      await settleCompanyPurges();
      const again = await withCompany(A.companyId, () => prisma.companyPurge.findFirst({ where: { companyId: A.companyId } }));
      expect(again?.completedAt).toEqual(purge?.completedAt);
      expect(await counts(B.companyId)).toEqual(bBefore);
    });

    it('silinen firmayı gecikmiş olay ya da JIT yeniden kurmaz', async () => {
      for (const event of [
        memberUpserted(A.companyId),
        { eventId: crypto.randomUUID(), type: 'member.removed', orgId: A.companyId, product: 'deciship', membershipId: crypto.randomUUID(), epoch: 3 } as PlatformEvent,
        { eventId: crypto.randomUUID(), type: 'org.updated', orgId: A.companyId, product: 'deciship', name: 'Hayalet', version: 999 } as PlatformEvent,
        closed(A.companyId),
        reopened(A.companyId),
      ]) {
        expect(await send(event), event.type).toBe('processed');
      }
      const jit = await app.inject({ method: 'GET', url: `${API}/me`, headers: A.admin.auth });
      expect(jit.statusCode).toBe(409);
      expect(code(jit)).toBe('ORG_CLOSED');
      const fresh = await issueIdentity({ companyId: A.companyId, orgName: 'Hayalet', role: 'ADMIN' });
      expect(code(await app.inject({ method: 'GET', url: `${API}/me`, headers: fresh.auth }))).toBe('ORG_CLOSED');
      const after = await counts(A.companyId);
      for (const [t, n] of Object.entries(after)) expect(n, t).toBe(0);
    });

    it('hiç görülmemiş firmanın silme olayı: kayıt kalır, sonra gelen olay firmayı kurmaz', async () => {
      const Z = crypto.randomUUID();
      expect(await send(purged(Z))).toBe('processed');
      await settleCompanyPurges();
      expect(await send(memberUpserted(Z))).toBe('processed');
      expect((await counts(Z)).Company).toBe(0);
      expect((await counts(Z)).Member).toBe(0);
      expect((await withCompany(Z, () => prisma.companyPurge.findFirst({ where: { companyId: Z } })))?.completedAt).toBeInstanceOf(Date);
    });

    it('yarıda kalan silmeyi saatlik bakım tamamlar (silme kaydı var, firma duruyor)', async () => {
      const C = await registerCompany(app, uniq('Yarım '));
      await app.inject({ method: 'POST', url: `${API}/carriers`, headers: C.auth, payload: { code: 'aras', name: 'Aras' } });
      // olay işlemi commit oldu, arkadaki silme başlamadan süreç düştü
      await recordPurge(C.companyId);
      expect(await runCompanyPurges(silent)).toBeGreaterThanOrEqual(1);
      const after = await counts(C.companyId);
      for (const [t, n] of Object.entries(after)) expect(n, t).toBe(0);
      expect(await counts(B.companyId)).toEqual(bBefore);
    });

    it('büyük firma parça parça silinir: yarıda kesilen silme sonraki turlarda kaldığı yerden biter; başka firma aynen; tekrar zararsız', async () => {
      const D = await companyFixture(app);
      const dPaths = (await sup.query(`SELECT path FROM "File" WHERE "companyId" = $1`, [D.companyId])).rows.map((r) => r.path as string);
      expect(dPaths.length).toBeGreaterThan(0);
      const sum = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
      const dBefore = await counts(D.companyId);
      // olay işleminin yazdığı durum (kapalı + silme kaydı); arkadaki silme başlamadan süreç düştü
      expect(await send(closed(D.companyId))).toBe('processed');
      await recordPurge(D.companyId);

      // turun süresi dolmuşsa hiçbir firmaya başlanmaz
      expect(await runCompanyPurges(silent, { runBudgetMs: 0 })).toBe(0);
      expect(await counts(D.companyId)).toEqual(dBefore);

      // 1. çağrı: 4 parça × 2 satır, sonra durur (süre/parça sınırı)
      const first = await purgeCompany(D.companyId, silent, { batchSize: 2, maxBatches: 4 });
      expect(first.state).toBe('in-progress');
      const mid = await counts(D.companyId);
      const deleted = sum(dBefore) - sum(mid);
      expect(deleted).toBeGreaterThan(0);
      expect(deleted).toBeLessThanOrEqual(8);
      expect(first.state === 'in-progress' && sum(first.rows)).toBe(deleted);
      // firma satırı en son: hâlâ duruyor, üyeler de (listede son tablo)
      expect(mid.Company).toBe(1);
      expect(mid.Member).toBe(dBefore.Member);
      expect((await withCompany(D.companyId, () => prisma.companyPurge.findFirst({ where: { companyId: D.companyId } })))?.completedAt).toBeNull();
      expect(await counts(B.companyId)).toEqual(bBefore);

      // silme sürerken gelen olay ya da JIT firmayı açmaz, satır eklemez
      for (const event of [memberUpserted(D.companyId), reopened(D.companyId)]) expect(await send(event), event.type).toBe('processed');
      expect((await companyRow(D.companyId))?.closedAt).not.toBeNull();
      expect(code(await app.inject({ method: 'GET', url: `${API}/me`, headers: D.admin.auth }))).toBe('ORG_CLOSED');
      const fresh = await issueIdentity({ companyId: D.companyId, orgName: D.admin.orgName, role: 'ADMIN' });
      expect(code(await app.inject({ method: 'GET', url: `${API}/me`, headers: fresh.auth }))).toBe('ORG_CLOSED');
      expect(await counts(D.companyId)).toEqual(mid);
      // silmeden önce başlamış bir işin geç yazımı: ilk tablo (boşalmış olabilir) yeniden dolar; sonraki turlar onu da siler
      await withCompany(D.companyId, () =>
        prisma.job.create({ data: { companyId: D.companyId, kind: 'INVOICE_PDF_READ', dedupeKey: `late:${crypto.randomUUID()}`, input: { v: 1, locale: 'tr' } } }),
      );

      // 2. bakım turu: firma başına parça sınırı yine dolar, kaldığı yerden ilerler, bitmez
      await runCompanyPurges(silent, { batchSize: 2, maxBatches: 6 });
      const later = await counts(D.companyId);
      expect(sum(later)).toBeLessThan(sum(mid) + 1);
      expect(later.Company).toBe(1);
      expect(await counts(B.companyId)).toEqual(bBefore);

      // 3. bakım turu: sınırsız parça, küçük parçalarla biter
      expect(await runCompanyPurges(silent, { batchSize: 3 })).toBeGreaterThanOrEqual(1);
      for (const [t, n] of Object.entries(await counts(D.companyId))) expect(n, t).toBe(0);
      for (const rel of dPaths) expect(fs.existsSync(disk(rel)), rel).toBe(false);
      expect(fs.existsSync(disk(D.companyId))).toBe(false);
      const purge = await withCompany(D.companyId, () => prisma.companyPurge.findFirst({ where: { companyId: D.companyId } }));
      expect(purge?.completedAt).toBeInstanceOf(Date);

      // tekrar: zararsız, bitiş anı değişmez, başka firma aynen
      const again = await purgeCompany(D.companyId, silent, { batchSize: 1 });
      expect(again.state).toBe('completed');
      expect(again.state === 'completed' && sum(again.rows)).toBe(0);
      await runCompanyPurges(silent);
      expect((await withCompany(D.companyId, () => prisma.companyPurge.findFirst({ where: { companyId: D.companyId } })))?.completedAt).toEqual(purge?.completedAt);
      expect(await counts(B.companyId)).toEqual(bBefore);
      for (const rel of bPaths) expect(fs.existsSync(disk(rel)), rel).toBe(true);
    });

    it('her firma tablosunda firma sütunuyla başlayan dizin var: parçalı silme ve firma satırının silinmesi tabloyu baştan taramaz', async () => {
      const indexed = new Set(
        (
          await sup.query(
            `SELECT DISTINCT t.relname::text AS t
               FROM pg_index i
               JOIN pg_class t ON t.oid = i.indrelid
               JOIN pg_namespace n ON n.oid = t.relnamespace
               JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
              WHERE n.nspname = 'deciship' AND a.attname = 'companyId'`,
          )
        ).rows.map((r) => r.t as string),
      );
      const missing = (await companyTables()).filter((t) => !indexed.has(t));
      expect(missing).toEqual([]);
    });

    it('hep düşen silme sırayı tutmaz: bakım önce hiç denenmemiş ya da en uzun süredir denenmemiş silmeyi alır', async () => {
      const E = await registerCompany(app, uniq('Düşen '));
      const F = await registerCompany(app, uniq('Yeni '));
      for (const c of [E, F]) expect(await send(closed(c.companyId))).toBe('processed');
      // E eski kayıt, son turda denendi (ve düştü); F sonra geldi, hiç denenmedi
      await recordPurge(E.companyId, { createdAt: new Date(Date.now() - 3_600_000) });
      await withCompany(E.companyId, () => prisma.companyPurge.updateMany({ where: { companyId: E.companyId }, data: { attemptedAt: new Date() } }));
      await recordPurge(F.companyId);
      const queue = await companyPurgeQueue();
      expect(queue.indexOf(F.companyId)).toBeGreaterThanOrEqual(0);
      expect(queue.indexOf(F.companyId)).toBeLessThan(queue.indexOf(E.companyId));

      // her deneme anını yazar (yarıda kalsa ya da düşse de): sıradaki tur başkasından başlar
      await purgeCompany(F.companyId, silent, { maxBatches: 1 });
      const fRow = await withCompany(F.companyId, () => prisma.companyPurge.findFirst({ where: { companyId: F.companyId } }));
      expect(fRow?.attemptedAt).toBeInstanceOf(Date);
      const next = await companyPurgeQueue();
      expect(next.indexOf(E.companyId)).toBeLessThan(next.indexOf(F.companyId));
      // ikisini de bitir: sonraki testler temiz kuyruk görsün
      for (const c of [E, F]) expect((await purgeCompany(c.companyId, silent)).state).toBe('completed');
    });
  });
});
