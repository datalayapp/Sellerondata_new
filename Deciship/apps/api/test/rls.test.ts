import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { prisma, setTxCompany, withCompany, withEventScope, withJobScope, withMaintenanceScope, withSupportScope } from '../src/db.ts';
import { enqueueJob, kickJob } from '../src/services/jobs/queue.ts';
import { overrideJobKindForTest } from '../src/services/jobs/registry.ts';
import { companyFixture, type Fixture } from './fixtures.ts';
import { getApp, getAuthority, registerCompany } from './helpers.ts';
import { TEST_DB_URL, testSuperDbUrl } from './testEnv.ts';

/** Veritabanına Prisma'yı atlayarak bakan istemciler: uygulama rolü ve süper kullanıcı. */
async function client(url: string) {
  const c = new pg.Client({ connectionString: url, options: '-c search_path=deciship' });
  await c.connect();
  return c;
}

const currentSetting = () => prisma.$queryRaw<{ c: string | null }[]>`SELECT current_setting('app.company_id', true) AS c`.then((r) => r[0]!.c ?? '');

describe('RLS: veritabanı düzeyi (sod_deciship)', () => {
  let app: pg.Client;
  let sup: pg.Client;
  let A: Fixture;
  let B: Fixture;
  let tables: string[];
  const revisionOf = new Map<string, string>();

  beforeAll(async () => {
    const api = await getApp();
    A = await companyFixture(api);
    B = await companyFixture(api);
    app = await client(TEST_DB_URL);
    sup = await client(testSuperDbUrl());
    await withEventScope(() => prisma.processedEvent.create({ data: { eventId: crypto.randomUUID() } }));
    // Her iki firmada da en az bir tarife sürümü olsun (tarife yazma yolu sürüm açsa da açmasa da).
    for (const f of [A, B]) {
      const revision = await withCompany(f.companyId, () =>
        prisma.tariffRevision.create({ data: { companyId: f.companyId, tariffId: f.tariffId, tariffName: 'Fikstür', snapshot: {}, currency: 'TRY' } }),
      );
      revisionOf.set(f.companyId, revision.id);
    }
    // Yapay zekâ sayacı tabloları (Mesaj 6): her firmada birer satır, kullanım satırı üyeye bağlı (bileşik anahtar).
    for (const f of [A, B]) {
      await withCompany(f.companyId, async () => {
        await prisma.aiUsage.create({
          data: { companyId: f.companyId, memberId: f.admin.userId, kind: 'SCALE_READ', status: 'OK', period: '2026-11', model: 'claude-sonnet-5-5', inputTokens: 10, outputTokens: 5, cost: '0.007000', priceVersion: 'fixture', durationMs: 100 },
        });
        await prisma.aiCreditEntry.create({ data: { companyId: f.companyId, kind: 'GRANT', amount: '10.00', period: '2026-11', operator: 'fixture' } });
        await prisma.aiResultCache.create({
          data: { companyId: f.companyId, kind: 'INVOICE_MAPPING', cacheKey: crypto.randomUUID(), model: 'claude-sonnet-5-5', result: {}, expiresAt: new Date(Date.now() + 86_400_000) },
        });
      });
    }
    // Arka plan işi (Mesaj 7): her firmada bir bekleyen iş, başlatan üyeye bağlı (bileşik anahtar).
    for (const f of [A, B]) {
      await withCompany(f.companyId, () =>
        prisma.job.create({ data: { companyId: f.companyId, kind: 'INVOICE_PDF_READ', dedupeKey: `fixture:${crypto.randomUUID()}`, input: { v: 1, locale: 'tr' }, createdById: f.admin.userId } }),
      );
    }
    // Mükerrer yeniden hesap işareti (Mesaj 4, 07-B1): her firmada faturasına bağlı birer satır (bileşik anahtar).
    for (const f of [A, B]) {
      await withCompany(f.companyId, () => prisma.invoiceRecheck.create({ data: { invoiceId: f.invoiceId, companyId: f.companyId, pendingAt: new Date() } }));
    }
    // Kalıcı silme kaydı (firmayı kapatma, migration 20261125090000): A ve B'den başka bir firmanın, bitmiş. Yalnız olay alıcısı
    // ekler (olay kapsamı + firma bağlamı, bitmemiş kayıt; migration 20261129090000); bitişi firma bağlamı yazar.
    const purgedId = crypto.randomUUID();
    await withEventScope(() =>
      prisma.$transaction(async (tx) => {
        await setTxCompany(tx, purgedId);
        await tx.companyPurge.create({ data: { companyId: purgedId } });
      }),
    );
    await withCompany(purgedId, () => prisma.companyPurge.updateMany({ where: { companyId: purgedId }, data: { completedAt: new Date() } }));
    const rows = await sup.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'deciship' AND tablename <> '_prisma_migrations' ORDER BY 1`);
    tables = rows.rows.map((r) => r.tablename as string);
  });
  afterAll(async () => {
    await app.end();
    await sup.end();
  });

  async function inTx<T>(c: pg.Client, companyId: string, work: () => Promise<T>): Promise<T> {
    await c.query('BEGIN');
    try {
      await c.query(`SELECT set_config('app.company_id', $1, true)`, [companyId]);
      return await work();
    } finally {
      await c.query('ROLLBACK');
    }
  }

  it('uygulama rolü süper kullanıcı değil, RLS atlayamaz, tablo sahibi değil', async () => {
    const me = await app.query(`SELECT current_user AS u, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user`);
    expect(me.rows[0]).toEqual({ u: 'sod_deciship', rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
    const owned = await app.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'deciship' AND tableowner = current_user`);
    expect(owned.rows[0].n).toBe(0);
  });

  it('şemadaki her tabloda RLS + FORCE ve ilke var (yeni tablo unutulursa test kırılır)', async () => {
    const rows = await sup.query(`
      SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'deciship' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'`);
    expect(rows.rows.length).toBe(tables.length);
    expect(tables.length).toBeGreaterThanOrEqual(23);
    expect(tables).toContain('TariffRevision');
    for (const t of rows.rows) expect(t, t.name).toMatchObject({ rls: true, force: true });
    // her tabloda tek ilke; bakım işinin dört tablosunda iki dar ilke (okuma + silme), Measurement'ta bir dar okuma ilkesi daha;
    // destek kapsamının üç tablosunda bir dar okuma ilkesi (Mesaj 6); Job'da çalıştırıcının okuma + güncelleme ve bakımın
    // okuma + silme ilkesi, File ve Invoice'ta dosya temizliğinin birer dar okuma ilkesi (Mesaj 7); Company'de bakım kapsamının
    // okuma ilkesi (Mesaj 14, itiraz hatırlatmasının firma listesi); InvoiceRecheck'te bakımın dar okuma ilkesi (Mesaj 4);
    // AiUsage'ta sistemin günlük tavanının son 2 günlük okuma ilkesi (ai_budget, test/aiDailyBudget.test.ts); firmayı kapatma
    // (migration 20261125090000): Company'de iş kuyruğunun okuma ilkesi, CompanyPurge'te bakımın bitmemiş silme okuması; CompanyPurge'ün
    // ayrı ilkeleri (migration 20261129090000): firma okuması, olay alıcısının eklemesi, bitiş, deneme anı
    const maintained: Record<string, number> = {
      CompanyPurge: 5,
      InvoiceRecheck: 2,
      ProcessedEvent: 3,
      TariffDocument: 3,
      TariffImportDraft: 3,
      Measurement: 2,
      AiResultCache: 3,
      AiUsage: 3,
      AiCreditEntry: 2,
      Company: 4,
      Job: 5,
      File: 2,
      Invoice: 2,
    };
    for (const t of rows.rows) expect(t.policies, t.name).toBe(maintained[t.name] ?? 1);
  });

  it('bağlamsız sorgu: her tabloda sıfır satır; süper kullanıcıya göre veri var', async () => {
    for (const t of tables) {
      const real = await sup.query(`SELECT count(*)::int AS n FROM "${t}"`);
      expect(real.rows[0].n, `${t}: tohumda satır yok, test hiçbir şey kanıtlamaz`).toBeGreaterThan(0);
      const seen = await app.query(`SELECT count(*)::int AS n FROM "${t}"`);
      expect(seen.rows[0].n, t).toBe(0);
    }
  });

  it('bağlamlı sorgu: yalnız kendi firması, satır sayısı süper kullanıcıyla aynı', async () => {
    for (const t of tables) {
      if (t === 'ProcessedEvent') continue;
      const col = t === 'Company' ? 'id' : 'companyId';
      const real = await sup.query(`SELECT count(*)::int AS n FROM "${t}" WHERE "${col}" = $1`, [A.companyId]);
      await inTx(app, A.companyId, async () => {
        const seen = await app.query(`SELECT "${col}" AS c FROM "${t}"`);
        expect(seen.rowCount, t).toBe(real.rows[0].n);
        expect(seen.rows.every((r) => r.c === A.companyId), t).toBe(true);
      });
    }
    // boş bağlam da bağlamsızdır
    await inTx(app, '', async () => expect((await app.query('SELECT count(*)::int AS n FROM "Carrier"')).rows[0].n).toBe(0));
  });

  it('SET LOCAL işlem bitince kalmaz', async () => {
    await inTx(app, A.companyId, async () => expect((await app.query('SELECT count(*)::int AS n FROM "Company"')).rows[0].n).toBe(1));
    expect((await app.query('SELECT count(*)::int AS n FROM "Company"')).rows[0].n).toBe(0);
  });

  it('başka firmaya yazılamaz: ekleme ilkeye takılır, güncelleme ve silme satır bulamaz', async () => {
    await inTx(app, A.companyId, async () => {
      await app.query('SAVEPOINT s');
      await expect(app.query(`INSERT INTO "Carrier" (id, "companyId", code, name, "updatedAt") VALUES ($1, $2, 'ups', 'x', now())`, [crypto.randomUUID(), B.companyId])).rejects.toMatchObject({ code: '42501' });
      await app.query('ROLLBACK TO SAVEPOINT s');
      expect((await app.query(`UPDATE "Carrier" SET name = 'ele geçti' WHERE id = $1`, [B.carrierId])).rowCount).toBe(0);
      expect((await app.query(`DELETE FROM "Carrier" WHERE id = $1`, [B.carrierId])).rowCount).toBe(0);
      expect((await app.query(`UPDATE "Company" SET name = 'ele geçti' WHERE id = $1`, [B.companyId])).rowCount).toBe(0);
      // kendi satırını başka firmaya taşıyamaz
      await app.query('SAVEPOINT s2');
      await expect(app.query(`UPDATE "Carrier" SET "companyId" = $1 WHERE id = $2`, [B.companyId, A.carrierId])).rejects.toMatchObject({ code: '42501' });
      await app.query('ROLLBACK TO SAVEPOINT s2');
    });
    const carrier = await sup.query(`SELECT name FROM "Carrier" WHERE id = $1`, [B.carrierId]);
    expect(carrier.rows[0].name).toBe('Aras');
  });

  it('tarife sürümü: başka firmanınki görünmez, yazılamaz, değiştirilemez; faturaya ve tarifeye bağlanamaz', async () => {
    const mine = revisionOf.get(A.companyId)!;
    const theirs = revisionOf.get(B.companyId)!;
    await inTx(app, A.companyId, async () => {
      expect((await app.query(`SELECT id FROM "TariffRevision" WHERE id = $1`, [theirs])).rowCount).toBe(0);
      expect((await app.query(`SELECT id FROM "TariffRevision" WHERE id = $1`, [mine])).rowCount).toBe(1);
      await app.query('SAVEPOINT s');
      await expect(
        app.query(`INSERT INTO "TariffRevision" (id, "companyId", "tariffName", snapshot, currency) VALUES ($1, $2, 'x', '{}', 'TRY')`, [crypto.randomUUID(), B.companyId]),
      ).rejects.toMatchObject({ code: '42501' });
      await app.query('ROLLBACK TO SAVEPOINT s');
      expect((await app.query(`UPDATE "TariffRevision" SET "tariffName" = 'ele geçti' WHERE id = $1`, [theirs])).rowCount).toBe(0);
      expect((await app.query(`DELETE FROM "TariffRevision" WHERE id = $1`, [theirs])).rowCount).toBe(0);
      // Bileşik anahtar: kendi faturası, satırı ve tarifesi başka firmanın sürümünü gösteremez (anahtar denetimi RLS'ye bakmaz).
      for (const [table, column, id] of [
        ['Invoice', 'tariffRevisionId', A.invoiceId],
        ['InvoiceLine', 'tariffRevisionId', A.lineId],
        ['Tariff', 'currentRevisionId', A.tariffId],
      ] as const) {
        await app.query('SAVEPOINT fk');
        await expect(app.query(`UPDATE "${table}" SET "${column}" = $1 WHERE id = $2`, [theirs, id]), table).rejects.toMatchObject({ code: '23503' });
        await app.query('ROLLBACK TO SAVEPOINT fk');
        expect((await app.query(`UPDATE "${table}" SET "${column}" = $1 WHERE id = $2`, [mine, id])).rowCount, table).toBe(1);
      }
    });
    const untouched = await sup.query(`SELECT "tariffName" FROM "TariffRevision" WHERE id = $1`, [theirs]);
    expect(untouched.rows[0].tariffName).toBe('Fikstür');
  });

  it('olay kapısı olmadan ProcessedEvent görünmez ve yazılamaz; firma bağlamı açmaz', async () => {
    expect((await app.query('SELECT count(*)::int AS n FROM "ProcessedEvent"')).rows[0].n).toBe(0);
    await inTx(app, A.companyId, async () => {
      expect((await app.query('SELECT count(*)::int AS n FROM "ProcessedEvent"')).rows[0].n).toBe(0);
      await app.query('SAVEPOINT s');
      await expect(app.query(`INSERT INTO "ProcessedEvent" ("eventId") VALUES ('sahte')`)).rejects.toMatchObject({ code: '42501' });
      await app.query('ROLLBACK TO SAVEPOINT s');
    });
    // olay kapısı firma tablolarını açmaz
    expect(await withEventScope(() => prisma.carrier.count())).toBe(0);
    expect(await withEventScope(() => prisma.processedEvent.count())).toBeGreaterThan(0);
  });

  it('destek kapsamı: bütün firmaların yapay zekâ kullanımı, kredisi ve adı okunur; başka tablo ve yazma kapalı', async () => {
    await withSupportScope(async () => {
      const usage = await prisma.aiUsage.findMany({ select: { companyId: true } });
      expect(usage.map((u) => u.companyId)).toEqual(expect.arrayContaining([A.companyId, B.companyId]));
      expect((await prisma.aiCreditEntry.findMany({ select: { companyId: true } })).map((c) => c.companyId)).toEqual(expect.arrayContaining([A.companyId, B.companyId]));
      expect((await prisma.company.findMany({ select: { id: true } })).map((c) => c.id)).toEqual(expect.arrayContaining([A.companyId, B.companyId]));
      // başka firma tabloları ve önbellek görünmez
      for (const count of [prisma.carrier.count(), prisma.member.count(), prisma.invoice.count(), prisma.aiResultCache.count(), prisma.auditLog.count()]) expect(await count).toBe(0);
      // yazma yok: güncelleme ve silme satır bulamaz, ekleme ilkeye takılır
      expect((await prisma.aiUsage.updateMany({ where: { companyId: A.companyId }, data: { durationMs: 1 } })).count).toBe(0);
      expect((await prisma.aiCreditEntry.deleteMany({ where: { companyId: A.companyId } })).count).toBe(0);
      expect((await prisma.company.updateMany({ where: { id: A.companyId }, data: { name: 'ele geçti' } })).count).toBe(0);
      await expect(prisma.aiCreditEntry.create({ data: { companyId: A.companyId, kind: 'GRANT', amount: '1.00', operator: 'x' } })).rejects.toThrow();
    });
    // firma bağlamı destek ilkesini açmaz: yalnız kendi satırı
    const mine = await withCompany(A.companyId, () => prisma.aiUsage.findMany({ select: { companyId: true } }));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((u) => u.companyId === A.companyId)).toBe(true);
    expect(await withCompany(A.companyId, () => prisma.aiUsage.count({ where: { durationMs: 1 } }))).toBe(0);
  });

  it('bakım kapsamı: yalnız süresi dolmuş yapay zekâ önbelleği görünür ve silinir; kullanım satırı kapalı', async () => {
    const [old, fresh] = await withCompany(A.companyId, async () => [
      await prisma.aiResultCache.create({ data: { companyId: A.companyId, kind: 'INVOICE_PDF', cacheKey: crypto.randomUUID(), model: 'm', result: {}, expiresAt: new Date(Date.now() - 60_000) } }),
      await prisma.aiResultCache.create({ data: { companyId: A.companyId, kind: 'INVOICE_PDF', cacheKey: crypto.randomUUID(), model: 'm', result: {}, expiresAt: new Date(Date.now() + 60_000) } }),
    ]);
    await withMaintenanceScope(async () => {
      const seen = (await prisma.aiResultCache.findMany({ select: { id: true } })).map((r) => r.id);
      expect(seen).toContain(old.id);
      expect(seen).not.toContain(fresh.id);
      expect((await prisma.aiResultCache.deleteMany({ where: { id: fresh.id } })).count).toBe(0);
      expect((await prisma.aiResultCache.updateMany({ where: { id: old.id }, data: { model: 'x' } })).count).toBe(0);
      expect(await prisma.aiUsage.count()).toBe(0);
      expect(await prisma.aiCreditEntry.count()).toBe(0);
      expect((await prisma.aiResultCache.deleteMany({ where: { id: old.id } })).count).toBe(1);
    });
    expect(await withCompany(A.companyId, () => prisma.aiResultCache.findFirst({ where: { id: fresh.id } }))).not.toBeNull();
  });

  /** Satırın zaman sütununu süper kullanıcıyla geriye alır (ilkeler UTC `now()` ile karşılaştırır). */
  const backdate = (table: string, column: string, id: string, interval: string) =>
    sup.query(`UPDATE "${table}" SET "${column}" = (now() AT TIME ZONE 'UTC') - $2::interval WHERE id = $1`, [id, interval]);

  it('iş kapsamı (Mesaj 7): bütün firmaların yalnız bekleyen ve süren işleri; bitmiş iş, başka tablo, ekleme ve silme kapalı', async () => {
    const job = (f: Fixture, status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED') =>
      withCompany(f.companyId, () =>
        prisma.job.create({ data: { companyId: f.companyId, kind: 'TARIFF_PDF_SCAN', status, dedupeKey: `scope:${crypto.randomUUID()}`, input: { v: 1, locale: 'tr' } }, select: { id: true } }),
      ).then((r) => r.id);
    const queuedA = await job(A, 'QUEUED');
    const runningB = await job(B, 'RUNNING');
    const doneA = await job(A, 'SUCCEEDED');
    await withJobScope(async () => {
      const seen = (await prisma.job.findMany({ select: { id: true } })).map((j) => j.id);
      expect(seen).toEqual(expect.arrayContaining([queuedA, runningB]));
      expect(seen).not.toContain(doneA);
      for (const count of [prisma.carrier.count(), prisma.file.count(), prisma.invoice.count(), prisma.member.count(), prisma.aiUsage.count()]) {
        expect(await count).toBe(0);
      }
      // firmayı kapatma (migration 20261125090000): kapalı firmanın işi alınmasın diye firma satırı yalnız okunur
      expect(await prisma.company.count({ where: { id: { in: [A.companyId, B.companyId] } } })).toBe(2);
      expect((await prisma.company.updateMany({ where: { id: A.companyId }, data: { name: 'ele geçti' } })).count).toBe(0);
      expect((await prisma.$executeRaw`DELETE FROM "Company" WHERE "id" = ${A.companyId}`)).toBe(0);
      // sahiplenme sorgusunun kilidi: FOR UPDATE, UPDATE ilkesinin USING koşulunu da ister
      const locked = await prisma.$transaction((tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Job" WHERE id = ${queuedA} FOR UPDATE SKIP LOCKED`);
      expect(locked).toEqual([{ id: queuedA }]);
      expect((await prisma.job.updateMany({ where: { id: queuedA }, data: { status: 'RUNNING', lockedBy: 'rls-test' } })).count).toBe(1);
      // kira bırakma: RUNNING → QUEUED yazılabilir
      expect((await prisma.job.updateMany({ where: { id: runningB }, data: { status: 'QUEUED', lockedBy: null } })).count).toBe(1);
      // bitmiş iş görünmez, geri açılamaz; bitmiş duruma geçiş bu kapsamda yazılamaz (firma bağlamında yapılır)
      expect((await prisma.job.updateMany({ where: { id: doneA }, data: { status: 'QUEUED' } })).count).toBe(0);
      for (const status of ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const) {
        await expect(prisma.job.updateMany({ where: { id: queuedA }, data: { status } }), status).rejects.toThrow(/42501/);
      }
      expect((await prisma.job.deleteMany({ where: { id: queuedA } })).count).toBe(0);
      await expect(prisma.job.create({ data: { companyId: A.companyId, kind: 'TARIFF_PDF_SCAN', dedupeKey: 'x', input: {} } })).rejects.toThrow();
    });
    // deneme hakkı biten işin bitiş yazımı işin firma bağlamında yapılır
    const abandoned = await withCompany(B.companyId, () =>
      prisma.job.updateMany({ where: { id: runningB, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'FAILED', finishedAt: new Date() } }),
    );
    expect(abandoned.count).toBe(1);
    const after = await sup.query(`SELECT id, status, "lockedBy" FROM "Job" WHERE id = ANY($1) ORDER BY id`, [[queuedA, runningB, doneA]]);
    expect(Object.fromEntries(after.rows.map((r) => [r.id, [r.status, r.lockedBy]]))).toEqual({ [queuedA]: ['RUNNING', 'rls-test'], [runningB]: ['FAILED', null], [doneA]: ['SUCCEEDED', null] });
    // firma bağlamı iş kapsamını açmaz: başka firmanın işi görünmez
    expect(await withCompany(A.companyId, () => prisma.job.count({ where: { id: runningB } }))).toBe(0);
  });

  it('bakım kapsamı (Mesaj 7): 7 günden eski biten iş silinir; dosya adayı yalnız 24 saatlik önizleme ve 30 günlük silinmiş faturanın dosyası', async () => {
    // işler
    const finished = () =>
      withCompany(A.companyId, () =>
        prisma.job.create({ data: { companyId: A.companyId, kind: 'BULK_RECOMPARE_PREVIEW', status: 'SUCCEEDED', dedupeKey: `m:${crypto.randomUUID()}`, input: {}, finishedAt: new Date() }, select: { id: true } }),
      ).then((r) => r.id);
    const oldJob = await finished();
    const freshJob = await finished();
    await backdate('Job', 'finishedAt', oldJob, '8 days');
    await backdate('Job', 'finishedAt', freshJob, '6 days');

    // dosyalar: bağsız önizleme (eski, taze, temizlenmiş), eski fotoğraf
    const file = (kind: 'INVOICE_SOURCE' | 'PHOTO_BOX', purged = false) =>
      withCompany(A.companyId, () =>
        prisma.file.create({
          data: { companyId: A.companyId, kind, mime: 'text/csv', size: 1, path: `rls/${crypto.randomUUID()}.csv`, sha256: 'x', createdById: A.admin.userId, purgedAt: purged ? new Date() : null },
          select: { id: true },
        }),
      ).then((r) => r.id);
    const oldPreview = await file('INVOICE_SOURCE');
    const freshPreview = await file('INVOICE_SOURCE');
    const purgedPreview = await file('INVOICE_SOURCE', true);
    const oldPhoto = await file('PHOTO_BOX');
    for (const id of [oldPreview, purgedPreview, oldPhoto]) await backdate('File', 'updatedAt', id, '25 hours');
    const bound = await sup.query(`SELECT "invoiceId" FROM "File" WHERE id = $1`, [A.invoiceFileId]);
    expect(bound.rows[0].invoiceId).toBe(A.invoiceId);
    await backdate('File', 'updatedAt', A.invoiceFileId, '40 days');

    const seen = () =>
      withMaintenanceScope(async () => ({
        jobs: (await prisma.job.findMany({ select: { id: true } })).map((r) => r.id),
        files: (await prisma.file.findMany({ select: { id: true } })).map((r) => r.id),
        invoices: (await prisma.invoice.findMany({ select: { id: true } })).map((r) => r.id),
      }));
    try {
      // canlı fatura ve dosyası görünmez, ne kadar eski olursa olsun
      const live = await seen();
      expect(live.jobs).toContain(oldJob);
      expect(live.jobs).not.toContain(freshJob);
      expect(live.files).toContain(oldPreview);
      for (const id of [freshPreview, purgedPreview, oldPhoto, A.invoiceFileId]) expect(live.files).not.toContain(id);
      expect(live.invoices).not.toContain(A.invoiceId);

      // 29 gün önce silinmiş fatura: henüz aday değil
      await backdate('Invoice', 'deletedAt', A.invoiceId, '29 days');
      expect((await seen()).files).not.toContain(A.invoiceFileId);
      // 31 gün önce silinmiş fatura: kendisi ve dosyası aday
      await backdate('Invoice', 'deletedAt', A.invoiceId, '31 days');
      const expired = await seen();
      expect(expired.invoices).toContain(A.invoiceId);
      expect(expired.files).toContain(A.invoiceFileId);

      // bakım kapsamında dosya ve fatura yalnız okunur; iş yalnız süresi dolmuşsa silinir
      await withMaintenanceScope(async () => {
        expect((await prisma.file.deleteMany({ where: { id: oldPreview } })).count).toBe(0);
        expect((await prisma.file.updateMany({ where: { id: oldPreview }, data: { purgedAt: new Date() } })).count).toBe(0);
        expect((await prisma.invoice.updateMany({ where: { id: A.invoiceId }, data: { deletedAt: null } })).count).toBe(0);
        expect((await prisma.job.updateMany({ where: { id: oldJob }, data: { label: 'x' } })).count).toBe(0);
        expect((await prisma.job.deleteMany({ where: { id: freshJob } })).count).toBe(0);
        expect((await prisma.job.deleteMany({ where: { id: oldJob } })).count).toBe(1);
      });
    } finally {
      await sup.query(`UPDATE "Invoice" SET "deletedAt" = NULL WHERE id = $1`, [A.invoiceId]);
    }
    const files = await sup.query(`SELECT count(*)::int AS n FROM "File" WHERE id = ANY($1) AND "purgedAt" IS NULL`, [[oldPreview, freshPreview, oldPhoto, A.invoiceFileId]]);
    expect(files.rows[0].n).toBe(4);
  });

  it('bakım kapsamı (Mesaj 14): bütün firmaların Company satırı yalnız okunur; canlı fatura, üye, taşıyıcı ve yazma kapalı', async () => {
    const names = await sup.query(`SELECT id, name, settings FROM "Company" WHERE id = ANY($1) ORDER BY id`, [[A.companyId, B.companyId]]);
    await withMaintenanceScope(async () => {
      const seen = await prisma.company.findMany({ select: { id: true, settings: true, nameVersion: true } });
      expect(seen.map((c) => c.id)).toEqual(expect.arrayContaining([A.companyId, B.companyId]));
      // hatırlatmanın okuduğu sütunlar gelir
      expect(seen.find((c) => c.id === A.companyId)!.settings).toEqual(names.rows.find((r) => r.id === A.companyId)!.settings);
      // fatura (canlı), satır, üye, taşıyıcı, itiraz, denetim kaydı görünmez
      expect((await prisma.invoice.findMany({ where: { id: { in: [A.invoiceId, B.invoiceId] } }, select: { id: true } })).length).toBe(0);
      for (const count of [prisma.invoiceLine.count(), prisma.member.count(), prisma.carrier.count(), prisma.dispute.count(), prisma.auditLog.count(), prisma.tariff.count()]) {
        expect(await count).toBe(0);
      }
      // yazma yok: güncelleme ve silme satır bulamaz, ekleme ilkeye takılır
      expect((await prisma.company.updateMany({ where: { id: A.companyId }, data: { name: 'ele geçti', settings: {} } })).count).toBe(0);
      expect((await prisma.company.deleteMany({ where: { id: B.companyId } })).count).toBe(0);
      await expect(prisma.company.create({ data: { id: crypto.randomUUID(), name: 'sahte', settings: {} } })).rejects.toThrow();
    });
    // ham bağlantıda da aynı: app.scope = maintenance yalnız Company okumasını açar
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.scope', 'maintenance', true)`);
      expect((await app.query(`SELECT count(*)::int AS n FROM "Company" WHERE id = ANY($1)`, [[A.companyId, B.companyId]])).rows[0].n).toBe(2);
      expect((await app.query(`UPDATE "Company" SET name = 'ele geçti' WHERE id = $1`, [A.companyId])).rowCount).toBe(0);
      expect((await app.query(`SELECT count(*)::int AS n FROM "Invoice" WHERE id = $1`, [A.invoiceId])).rows[0].n).toBe(0);
    } finally {
      await app.query('ROLLBACK');
    }
    const after = await sup.query(`SELECT id, name, settings FROM "Company" WHERE id = ANY($1) ORDER BY id`, [[A.companyId, B.companyId]]);
    expect(after.rows).toEqual(names.rows);
    // firma bağlamı bakım ilkesini açmaz: yalnız kendi satırı
    expect((await withCompany(A.companyId, () => prisma.company.findMany({ select: { id: true } }))).map((c) => c.id)).toEqual([A.companyId]);
  });

  it('bakım kapsamı yalnız arka plan işlerinden açılır: rota, uygulama ve kimlik kodunda yok; hatırlatma rotadan çağrılmaz', () => {
    const SRC = path.resolve(import.meta.dirname, '../src');
    const files = fs
      .readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.includes('generated'))
      .map((f) => f.replace(/\\/g, '/'));
    const code = (f: string) =>
      fs
        .readFileSync(path.join(SRC, f), 'utf8')
        .split(/\r?\n/)
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
    const users = files.filter((f) => f !== 'db.ts' && /\bwithMaintenanceScope\b/.test(code(f)));
    // 06-B7 (Mesaj 6): yetim/kayıp dosya raporu firma listesini bakım kapsamında okur (yalnız `Company`, yalnız okuma);
    // rapor yalnız komut satırından çalışır (aşağıda: rota ve uygulama kodu içe aktarmaz).
    expect(users.sort()).toEqual(['services/fileCleanup.ts', 'services/jobs/queue.ts', 'services/maintenance.ts', 'services/measurementQueue.ts', 'services/reminders.ts', 'services/storageOrphans.ts']);
    const orphanUsers = files.filter((f) => f !== 'services/storageOrphans.ts' && /from\s+'[^']*storageOrphans(\.ts)?'|import\(\s*'[^']*storageOrphans/.test(code(f)));
    expect(orphanUsers.sort()).toEqual(['bin/storageOrphans.ts', 'cli/storageOrphans.ts']);
    // hatırlatma turu yalnız bakım işinden ve komut satırından çalışır
    const reminderUsers = files.filter((f) => f !== 'services/reminders.ts' && /from\s+'[^']*services\/reminders(\.ts)?'|from\s+'\.\/reminders(\.ts)?'|import\(\s*'[^']*reminders/.test(code(f)));
    expect(reminderUsers.sort()).toEqual(['cli/reminders.ts', 'services/maintenance.ts']);
  });

  it('sod_deciship platform şemasına, public şemaya ve migration geçmişine erişemez, DDL yapamaz', async () => {
    await sup.query(`CREATE TABLE IF NOT EXISTS platform."Person" (id text PRIMARY KEY, secret text)`);
    await sup.query(`INSERT INTO platform."Person" VALUES ('p1', 'gizli') ON CONFLICT DO NOTHING`);
    await sup.query(`GRANT SELECT ON platform."Person" TO sod_platform`);

    const denied = async (sql: string) => expect(app.query(sql), sql).rejects.toMatchObject({ code: '42501' });
    await denied(`SELECT * FROM platform."Person"`);
    await denied(`INSERT INTO platform."Person" VALUES ('p2', 'x')`);
    await denied(`CREATE TABLE platform.x (id int)`);
    await denied(`CREATE TABLE deciship.x (id int)`);
    await denied(`CREATE TABLE public.x (id int)`);
    await denied(`ALTER TABLE "Carrier" DISABLE ROW LEVEL SECURITY`.replace('"Carrier"', 'deciship."Carrier"'));
    await denied(`DROP POLICY company_isolation ON deciship."Carrier"`);
    await denied(`SET ROLE sod_deciship_admin`);
    await denied(`SELECT * FROM deciship."_prisma_migrations"`);
    await denied(`INSERT INTO deciship."_prisma_migrations" (id, checksum, migration_name, started_at) VALUES ('x', 'x', 'x', now())`);
    await denied(`TRUNCATE deciship."Carrier"`);
  });
});

describe('RLS: Prisma 7 ile bağlam', () => {
  let a: string;
  let b: string;
  let carrierA: string;
  let carrierB: string;

  beforeAll(async () => {
    const api = await getApp();
    a = (await registerCompany(api, 'Bağlam A')).companyId;
    b = (await registerCompany(api, 'Bağlam B')).companyId;
    carrierA = (await withCompany(a, () => prisma.carrier.create({ data: { companyId: a, code: 'ups', name: 'A Kargo' } }))).id;
    carrierB = (await withCompany(b, () => prisma.carrier.create({ data: { companyId: b, code: 'ups', name: 'B Kargo' } }))).id;
  });

  it('bağlamsız: model, ham sorgu, işlem hepsi sıfır satır', async () => {
    expect(await prisma.carrier.findMany()).toEqual([]);
    expect(await prisma.carrier.count()).toBe(0);
    expect(await prisma.company.findFirst({ where: { id: a } })).toBeNull();
    expect(await prisma.$queryRaw`SELECT id FROM "Carrier"`).toEqual([]);
    expect(await prisma.$transaction(async (tx) => tx.carrier.count())).toBe(0);
    expect(await prisma.carrier.updateMany({ data: { name: 'x' } })).toEqual({ count: 0 });
    await expect(prisma.carrier.create({ data: { companyId: a, code: 'dhl', name: 'x' } })).rejects.toThrow();
  });

  it('tekil sorgu, ham sorgu, ilişki ve toplama yalnız kendi firmasını görür', async () => {
    await withCompany(a, async () => {
      expect((await prisma.carrier.findMany()).map((c) => c.id)).toEqual([carrierA]);
      expect(await prisma.carrier.findFirst({ where: { id: carrierB } })).toBeNull();
      expect(await prisma.$queryRaw`SELECT id FROM "Carrier"`).toEqual([{ id: carrierA }]);
      expect(await prisma.$executeRaw`UPDATE "Carrier" SET "name" = "name"`).toBe(1);
      expect(await currentSetting()).toBe(a);
      const c = await prisma.company.findFirstOrThrow({ where: { id: a }, include: { carriers: true, members: true, boxPresets: true } });
      expect(c.carriers).toHaveLength(1);
      expect(c.boxPresets).toHaveLength(3);
      expect(await prisma.carrier.aggregate({ _count: true })).toMatchObject({ _count: 1 });
    });
  });

  it('etkileşimli işlem: bağlam işlemin her sorgusunda, await ve zamanlayıcı sonrasında da var', async () => {
    const seen = await withCompany(a, () =>
      prisma.$transaction(async (tx) => {
        const first = await tx.carrier.count();
        await tick();
        await new Promise((r) => setTimeout(r, 5));
        const setting = await tx.$queryRaw<{ c: string }[]>`SELECT current_setting('app.company_id', true) AS c`;
        const raw = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Carrier"`;
        const other = await tx.carrier.findFirst({ where: { id: carrierB } });
        return { first, setting: setting[0]!.c, raw: raw.map((r) => r.id), other };
      }),
    );
    expect(seen).toEqual({ first: 1, setting: a, raw: [carrierA], other: null });
  });

  it('etkileşimli işlem commit ve rollback doğru: hata bağlamı ve yazıyı geri alır', async () => {
    const name = crypto.randomUUID();
    await expect(
      withCompany(a, () =>
        prisma.$transaction(async (tx) => {
          await tx.carrier.update({ where: { id: carrierA }, data: { name } });
          expect((await tx.carrier.findFirstOrThrow({ where: { id: carrierA } })).name).toBe(name);
          throw new Error('geri al');
        }),
      ),
    ).rejects.toThrow('geri al');
    expect((await withCompany(a, () => prisma.carrier.findFirstOrThrow({ where: { id: carrierA } }))).name).not.toBe(name);
    await withCompany(a, () => prisma.$transaction((tx) => tx.carrier.update({ where: { id: carrierA }, data: { name } })));
    expect((await withCompany(a, () => prisma.carrier.findFirstOrThrow({ where: { id: carrierA } }))).name).toBe(name);
  });

  it('dizi $transaction reddedilir: Prisma toplu gönderir, bağlam o tikte ilk çağıranın olur', () => {
    expect(() => prisma.$transaction([prisma.carrier.count()])).toThrow(/Dizi biçimi/);
  });

  it('kaynak kodda dizi $transaction yok', () => {
    const SRC = path.resolve(import.meta.dirname, '../src');
    const files = fs.readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts') && !f.includes('generated'));
    const found = files.filter((f) => /\$transaction\(\s*\[/.test(fs.readFileSync(path.join(SRC, f), 'utf8')));
    expect(found).toEqual([]);
  });

  it('iç içe yazma bağlamı taşır, başka firma için reddedilir', async () => {
    // iç içe yazma Prisma'nın kendi işlemini açar
    const tariff = await withCompany(a, () =>
      prisma.tariff.create({
        data: {
          companyId: a,
          carrierId: carrierA,
          name: 'İç içe',
          currency: 'TRY',
          divisor: 3000,
          weightSteps: [],
          zones: { create: [{ companyId: a, country: 'DE', zone: 'A' }] },
          rates: { create: [{ companyId: a, zone: 'A', weightUpto: 1, price: 10 }] },
        },
        include: { zones: true, rates: true },
      }),
    );
    expect(tariff.zones).toHaveLength(1);
    // başka firmanın alt satırı: işlem bütün olarak geri alınır
    await expect(
      withCompany(a, () =>
        prisma.tariff.create({
          data: { companyId: a, carrierId: carrierA, name: 'Sızan', currency: 'TRY', divisor: 3000, weightSteps: [], zones: { create: [{ companyId: b, country: 'DE', zone: 'A' }] } },
        }),
      ),
    ).rejects.toThrow();
    expect(await withCompany(a, () => prisma.tariff.count({ where: { name: 'Sızan' } }))).toBe(0);
  });

  it('eşzamanlı firmalar birbirine karışmaz: aynı tikte, paralel, işlem içi ve dışı', async () => {
    const one = (companyId: string, expected: string) =>
      withCompany(companyId, async () => {
        const rows = await Promise.all([
          prisma.carrier.findMany({ select: { id: true } }),
          prisma.$transaction(async (tx) => {
            await tick();
            return tx.carrier.findMany({ select: { id: true } });
          }),
          prisma.$transaction((tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Carrier"`),
          prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Carrier"`,
        ]);
        for (const r of rows) expect(r.map((x) => x.id)).toEqual([expected]);
      });
    const work: Promise<void>[] = [];
    for (let i = 0; i < 25; i++) work.push(one(a, carrierA), one(b, carrierB));
    await Promise.all(work);
  });

  it('aynı tikte aynı biçimli sorgular kendi firmasında çalışır (Prisma birleştirmesi findUnique ile sınırlı)', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const [companyId, carrierId] = i % 2 ? [a, carrierA] : [b, carrierB];
        return withCompany(companyId, () => prisma.carrier.findFirst({ where: { id: carrierId }, select: { id: true } })).then((r) => r?.id === carrierId);
      }),
    );
    expect(results.every(Boolean)).toBe(true);
  });

  it('kaynak kodda findUnique yok: Prisma aynı tikteki findUnique çağrılarını ilkinin bağlamında birleştirir', () => {
    const SRC = path.resolve(import.meta.dirname, '../src');
    const files = fs.readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts') && !f.includes('generated'));
    const found = files.filter((f) => /\.findUnique(OrThrow)?\(/.test(fs.readFileSync(path.join(SRC, f), 'utf8')));
    expect(found).toEqual([]);
  });

  it('bağlam bağlantıya sızmaz: havuzdaki bağlantılar yeniden kullanılınca bağlamsız sorgu yine sıfır satır', async () => {
    await Promise.all(Array.from({ length: 30 }, () => withCompany(a, () => prisma.carrier.count())));
    const counts = await Promise.all(Array.from({ length: 30 }, () => prisma.carrier.count()));
    expect(counts.every((n) => n === 0)).toBe(true);
    const settings = await Promise.all(Array.from({ length: 10 }, () => currentSetting()));
    expect(settings.every((s) => s === '')).toBe(true);
    // geri alınan işlem de sızdırmaz
    await withCompany(a, () => prisma.$transaction(async () => Promise.reject(new Error('x')))).catch(() => undefined);
    expect(await prisma.carrier.count()).toBe(0);
  });

  it('setTxCompany açık işlemin bağlamını belirler (olay alıcısının yolu), işlem bitince kalmaz', async () => {
    const seen = await prisma.$transaction(async (tx) => {
      const before = await tx.carrier.count();
      await setTxCompany(tx, a);
      return { before, after: await tx.carrier.count() };
    });
    expect(seen).toEqual({ before: 0, after: 1 });
    expect(await prisma.carrier.count()).toBe(0);
  });

  it('arka plan işi kendi firmasında çalışır: firma satırın sütunundan, çağıranın bağlamı yokken de (Mesaj 7 kuyruğu)', async () => {
    // eski bellek içi tarife PDF işinin yerine kuyruk: işleyici başlatan isteğin bağlamı dışında, satırın firmasında koşar
    const restore = overrideJobKindForTest('TARIFF_PDF_SCAN', { handler: async () => async () => prisma.carrier.findMany({ select: { id: true } }) });
    try {
      const { jobId, joined } = await enqueueJob({ companyId: a, createdById: null, kind: 'TARIFF_PDF_SCAN', dedupeKey: `rls:${crypto.randomUUID()}`, input: { locale: 'tr' } });
      expect(joined).toBe(false);
      expect(await currentSetting()).toBe('');
      await kickJob(jobId);
      const row = await withCompany(a, () => prisma.job.findFirst({ where: { id: jobId }, select: { status: true, result: true } }));
      expect(row).toEqual({ status: 'SUCCEEDED', result: [{ id: carrierA }] });
    } finally {
      restore();
    }
  });
});

describe('oturum saat dilimi', () => {
  it('uygulama bağlantısı UTC: varsayılan now() kayıt saatini kaydırmaz', async () => {
    const rows = await prisma.$queryRaw<{ TimeZone: string }[]>`SHOW TimeZone`;
    expect(['UTC', 'Etc/UTC']).toContain(rows[0]!.TimeZone);
  });
});

describe('RLS: gerçek soket üzerinden istek', () => {
  let api: FastifyInstance;
  let base: string;

  beforeAll(async () => {
    const authority = await getAuthority();
    api = await buildApp({ identity: authority.authOptions });
    // 0: işletim sistemi boş port seçer, başka ajanlarla çakışmaz
    base = await api.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(() => api.close());

  it('gövde akıştan okunduktan sonra işleyicide firma bağlamı vardır (JSON, çok parçalı, GET)', async () => {
    const inject = await getApp();
    const admin = await registerCompany(inject, 'Soket Firma');
    const headers = { ...admin.auth, 'content-type': 'application/json' };

    // büyük JSON gövde birden çok parçada gelir: içerik ayrıştırıcı akış olayıyla ilerler
    const created = await fetch(`${base}/api/deciship/carriers`, { method: 'POST', headers, body: JSON.stringify({ code: 'aras', name: 'Soket', pad: 'x'.repeat(2_000_000) }) });
    expect(created.status, await created.clone().text()).toBe(201);
    const carrier = (await created.json()) as { carrier: { id: string } };

    const list = await fetch(`${base}/api/deciship/carriers`, { headers: admin.auth });
    expect(((await list.json()) as { items: { id: string }[] }).items.map((c) => c.id)).toEqual([carrier.carrier.id]);

    const patched = await fetch(`${base}/api/deciship/settings`, { method: 'PATCH', headers, body: JSON.stringify({ desiDivisor: 4000 }) });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { desiDivisor: number }).desiDivisor).toBe(4000);

    const form = new FormData();
    form.append('carrierId', carrier.carrier.id);
    form.append('file', new Blob(['Takip No;Tutar\n1;2'], { type: 'text/csv' }), 'f.csv');
    const preview = await fetch(`${base}/api/deciship/invoices/preview`, { method: 'POST', headers: admin.auth, body: form });
    expect(preview.status, await preview.clone().text()).toBe(200);

    // paralel istekler firmalarını karıştırmaz
    const other = await registerCompany(inject, 'Soket Diğer');
    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const who = i % 2 ? admin : other;
        const r = await fetch(`${base}/api/deciship/settings`, { headers: who.auth });
        return ((await r.json()) as { name: string }).name === who.orgName;
      }),
    );
    expect(results.every(Boolean)).toBe(true);
  });

  it('kimliksiz istek gövde okunmadan 401 alır', async () => {
    const res = await fetch(`${base}/api/deciship/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{bozuk' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });
});
