import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/env.ts';
import { prisma, withEventScope, withMaintenanceScope } from '../src/db.ts';
import { PROCESSED_EVENT_TTL_MS, runMaintenance } from '../src/services/maintenance.ts';
import { DRAFT_TTL_MS } from '../src/services/tariffImport.ts';
import { DOCUMENT_TTL_MS } from '../src/services/tariffPdf.ts';
import { companyFixture, type Fixture } from './fixtures.ts';
import { getApp, inCompany } from './helpers.ts';
import { setFxService } from '../src/services/fx.ts';
import { anyDayFx } from './fxFake.ts';

// Y9: bakım işi (`runMaintenance`) bütün firmalarda bekleyen ölçüm karşılaştırmasını tamamlar; önceki test dosyalarından
// kalan dövizli faturalar (USD tarife, 15.10.2026) kur ister. Gerçek TCMB'ye gidilmesin diye her güne yanıt veren sahte kur.
beforeAll(() => setFxService(anyDayFx({ USD: 40.05, EUR: 44.1, GBP: 50.2 })));
afterAll(() => setFxService(null));

const HOUR = 3_600_000;

describe('bakım işi: süresi dolanlar tüm firmalarda', () => {
  let A: Fixture;
  let B: Fixture;

  const draft = (f: Fixture, ageMs: number) =>
    inCompany(f.companyId, () =>
      prisma.tariffImportDraft.create({ data: { companyId: f.companyId, carrierId: f.carrierId, fileName: 'x.csv', data: {}, createdAt: new Date(Date.now() - ageMs) } }),
    );
  const documentRow = (f: Fixture, ageMs: number, rel: string) =>
    inCompany(f.companyId, () =>
      prisma.tariffDocument.create({
        data: { companyId: f.companyId, carrierId: f.carrierId, fileName: 'x.pdf', path: rel, size: 1, sha256: 'x', pages: 1, textLayer: true, pageTexts: [], discovery: {}, createdAt: new Date(Date.now() - ageMs) },
      }),
    );
  const event = (ageMs: number) => {
    const eventId = crypto.randomUUID();
    return withEventScope(() => prisma.processedEvent.create({ data: { eventId, createdAt: new Date(Date.now() - ageMs) } })).then(() => eventId);
  };

  beforeAll(async () => {
    const app = await getApp();
    A = await companyFixture(app);
    B = await companyFixture(app);
  });

  it('A ve B firmasının süresi dolmuş taslak, PDF ve olaylarını siler; tazelere dokunmaz; dosyayı da siler', async () => {
    const oldDraftA = await draft(A, DRAFT_TTL_MS + HOUR);
    const oldDraftB = await draft(B, DRAFT_TTL_MS + HOUR);
    const freshDraft = await draft(A, DRAFT_TTL_MS - HOUR);

    const rel = path.posix.join(B.companyId, 'bakim', `${crypto.randomUUID()}.pdf`);
    const abs = path.join(env.storageDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'x');
    const oldDocB = await documentRow(B, DOCUMENT_TTL_MS + HOUR, rel);
    const freshDoc = await documentRow(A, DOCUMENT_TTL_MS - HOUR, 'yok/yok.pdf');

    const oldEvent = await event(PROCESSED_EVENT_TTL_MS + HOUR);
    const freshEvent = await event(PROCESSED_EVENT_TTL_MS - HOUR);

    const result = await runMaintenance();
    expect(result.drafts).toBeGreaterThanOrEqual(2);
    expect(result.documents).toBeGreaterThanOrEqual(1);
    expect(result.processedEvents).toBeGreaterThanOrEqual(1);
    // Mesaj 14: hatırlatma turu sonuçta; test ortamında bildirim adresi yok, tur kapalı (ayrıntı test/reminders.test.ts)
    expect(result.reminders).toMatchObject({ disabled: true, sent: 0 });

    const draftIds = async (f: Fixture) => (await inCompany(f.companyId, () => prisma.tariffImportDraft.findMany({ select: { id: true } }))).map((d) => d.id);
    expect(await draftIds(A)).toContain(freshDraft.id);
    expect(await draftIds(A)).not.toContain(oldDraftA.id);
    expect(await draftIds(A)).toContain(A.draftId);
    expect(await draftIds(B)).not.toContain(oldDraftB.id);

    const docIds = async (f: Fixture) => (await inCompany(f.companyId, () => prisma.tariffDocument.findMany({ select: { id: true } }))).map((d) => d.id);
    expect(await docIds(B)).not.toContain(oldDocB.id);
    expect(await docIds(A)).toContain(freshDoc.id);
    expect(fs.existsSync(abs)).toBe(false);

    const eventIds = (await withEventScope(() => prisma.processedEvent.findMany({ select: { eventId: true } }))).map((e) => e.eventId);
    expect(eventIds).toContain(freshEvent);
    expect(eventIds).not.toContain(oldEvent);
  });

  it('dar yol: taze satır görünmez, güncelleme ve ekleme yok, firma tabloları kapalı', async () => {
    const fresh = await draft(A, HOUR);
    const old = await draft(A, DRAFT_TTL_MS + HOUR);
    const oldId = old.id;

    await withMaintenanceScope(async () => {
      const seen = (await prisma.tariffImportDraft.findMany({ select: { id: true } })).map((d) => d.id);
      expect(seen).toContain(oldId);
      expect(seen).not.toContain(fresh.id);
      // süresi dolmuşu bile değiştiremez, yalnız silebilir
      expect((await prisma.tariffImportDraft.updateMany({ where: { id: oldId }, data: { fileName: 'degisti' } })).count).toBe(0);
      // taze satır silinemez
      expect((await prisma.tariffImportDraft.deleteMany({ where: { id: fresh.id } })).count).toBe(0);
      // firma tabloları görünmez; Mesaj 14: Company satırı yalnız okunur (hatırlatmanın firma listesi, migration
      // 20261115090000), değiştirilemez
      const companies = (await prisma.company.findMany({ select: { id: true } })).map((c) => c.id);
      expect(companies).toEqual(expect.arrayContaining([A.companyId, B.companyId]));
      expect((await prisma.company.updateMany({ where: { id: A.companyId }, data: { name: 'ele geçti' } })).count).toBe(0);
      expect(await prisma.carrier.count()).toBe(0);
      expect(await prisma.member.count()).toBe(0);
      // Mesaj 7: fatura yalnız 30 günden uzun süredir silinmişse görünür (dosya temizliğinin aday listesi, migration 20261114120000)
      const invoices = await prisma.invoice.findMany({ select: { id: true, deletedAt: true } });
      expect(invoices.map((i) => i.id)).not.toContain(A.invoiceId);
      for (const i of invoices) expect(i.deletedAt!.getTime()).toBeLessThan(Date.now() - 30 * 24 * HOUR);
      // ekleme açılmaz
      await expect(prisma.tariffImportDraft.create({ data: { companyId: A.companyId, carrierId: A.carrierId, fileName: 'x', data: {} } })).rejects.toThrow();
      await expect(prisma.processedEvent.create({ data: { eventId: crypto.randomUUID() } })).rejects.toThrow();
    });
    expect(await inCompany(A.companyId, () => prisma.tariffImportDraft.findFirst({ where: { id: oldId } }))).toMatchObject({ fileName: 'x.csv' });
  });

  it('bağlamsız ya da başka firma bağlamında süresi dolmuş satır silinemez', async () => {
    const old = await draft(A, DRAFT_TTL_MS + HOUR);
    expect((await prisma.tariffImportDraft.deleteMany({ where: { id: old.id } })).count).toBe(0);
    expect((await inCompany(B.companyId, () => prisma.tariffImportDraft.deleteMany({ where: { id: old.id } }))).count).toBe(0);
    expect(await inCompany(A.companyId, () => prisma.tariffImportDraft.findFirst({ where: { id: old.id } }))).not.toBeNull();
  });

  it('koddaki süreler migration ile aynı', () => {
    const sql = fs.readFileSync(path.resolve(import.meta.dirname, '../prisma/migrations/20261107000000_maintenance_scope/migration.sql'), 'utf8');
    expect(sql).toContain("interval '30 days'");
    expect(PROCESSED_EVENT_TTL_MS).toBe(30 * 24 * HOUR);
    expect(sql).toContain("interval '24 hours'");
    expect(DRAFT_TTL_MS).toBe(24 * HOUR);
    expect(sql).toContain("interval '7 days'");
    expect(DOCUMENT_TTL_MS).toBe(7 * 24 * HOUR);
  });
});
