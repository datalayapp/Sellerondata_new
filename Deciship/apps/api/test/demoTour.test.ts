import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeTracking } from '@deciship/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Yarıda kalan başlatma: n'inci örnek fatura yüklemesi düşer (`failAt`, 0'dan sayılır). Diğer testlerde kapalı.
const failures = vi.hoisted(() => ({ failAt: null as number | null, calls: 0 }));
vi.mock('../src/services/sampleInvoices.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/services/sampleInvoices.ts')>();
  return {
    ...mod,
    importDemoInvoice: async (...args: Parameters<typeof mod.importDemoInvoice>) => {
      const n = failures.calls++;
      if (failures.failAt !== null && n >= failures.failAt) throw new Error('test: örnek fatura yüklenemedi');
      return mod.importDemoInvoice(...args);
    },
  };
});

import { API_PREFIX } from '../src/app.ts';
import { prisma } from '../src/db.ts';
import { env } from '../src/env.ts';
import { m } from '../src/i18n/index.ts';
import { DEFAULT_TIME_ZONE, zonedDate } from '../src/lib/time.ts';
import { createSampleMeasurement } from '../src/services/companyData.ts';
import { DEMO_BLOCKED, DEMO_CLIENT_ID_PREFIX, DEMO_LOADING_TTL_MS } from '../src/services/demoTour.ts';
import { lockTracking } from '../src/services/measurementLocks.ts';
import { drainMeasurementQueue } from '../src/services/measurementQueue.ts';
import { companyFixture } from './fixtures.ts';
import { createWorker, getApp, inCompany, measurementPayload, registerCompany, SAMPLES, uniq } from './helpers.ts';

const API = '/api/deciship';

/**
 * Deneme açıkken serbest kalan yazma uçları, gerekçesiyle (MESAJ-14 §4.3, inceleme R3). Taşıyıcı, tarife ya da fatura
 * EKLEYEN her uç `DEMO_BLOCKED`'da olmalı: "Denemeyi bitir" firmanın bütün taşıyıcılarını, tarifelerini ve faturalarını
 * siler. Yeni yazma ucu iki listeden birine girmeden bu test geçmez.
 */
const DEMO_ALLOWED: Record<string, string> = {
  'POST /internal/events': 'Hesap olayı: firma adı, para birimi, ülke ve üyelik yazar; taşıyıcı, tarife, fatura yazmaz',
  'POST /settings/demo': 'denemenin kendisi (boş firma denetimi kilit altında)',
  'DELETE /settings/demo': 'denemenin kendisi',
  'PATCH /settings': 'firma ayarı: deneme bitince kalır; `demo` alanını kabul etmez (strictObject)',
  'PATCH /settings/onboarding': 'kurulum ilerlemesi: bitirme kurulumu zaten baştan açar',
  'POST /settings/recompare-invoices/preview': 'yalnız var olan (örnek) faturaları hesaplar, yazmaz',
  'POST /settings/recompare-invoices': 'yalnız var olan (örnek) faturaları yeniden hesaplar; kayıt eklemez',
  'POST /box-presets': 'hazır koli: deneme bitince silinmez, örnek veriye bağlı değil',
  'PATCH /box-presets/:id': 'hazır koli: silinmez',
  'DELETE /box-presets/:id': 'hazır koli silme',
  'POST /measurements': 'gerçek ölçüm: öneksiz clientId, deneme bitince kalır',
  'PATCH /measurements/:id': 'gerçek ölçümün düzeltmesi öneksiz kalır (deneme bitince kalır); örnek ölçümünki önekli açılır (zinciriyle silinir)',
  'DELETE /measurements/:id': 'ölçüm silme işareti; satır silinmez',
  'POST /measurements/:id/restore': 'silme işaretini kaldırır',
  'POST /measurements/:id/purge': 'silinmiş ölçümü kalıcı siler; kayıt eklemez (deneme bitişi silinmiş örnek ölçümü atlar)',
  'POST /vision/scale': 'canlı ölçüm okuması, kayıt yazmaz',
  'POST /vision/reference/detect': 'canlı ölçüm okuması, kayıt yazmaz',
  'POST /vision/reference/solve': 'canlı ölçüm hesabı, kayıt yazmaz',
  'PATCH /carriers/:id': 'var olan (örnek) taşıyıcıyı düzenler, yeni taşıyıcı açmaz',
  'DELETE /carriers/:id': 'silme',
  'PUT /tariffs/:id': 'var olan (örnek) tarifeyi düzenler; denemeyle birlikte silinir (plan §4.3: zararsız)',
  'DELETE /tariffs/:id': 'silme',
  'POST /tariffs/:id/default': 'örnek tarifeyi varsayılan yapar',
  'POST /tariffs/:id/versions/:versionId/restore': 'örnek tarifenin eski hâline döner',
  'POST /tariffs/:id/recompare-invoices/preview': 'örnek faturaları hesaplar, yazmaz',
  'POST /tariffs/:id/recompare-invoices': 'örnek faturaları yeniden hesaplar; kayıt eklemez',
  'POST /tariffs/:id/country-adjustments': 'örnek tarifenin ülke istisnası',
  'POST /tariffs/:id/quote': 'fiyat hesabı, yazmaz',
  'DELETE /invoices/preview/:fileId': 'önizlemeden vazgeçme (siler)',
  'POST /invoices/preview/:fileId/keep': 'açık önizlemenin süresini tazeler; kayıt eklemez',
  'PATCH /invoices/:id': 'örnek faturanın başlığı',
  'DELETE /invoices/:id': 'silme',
  'PATCH /invoice-lines/:id': 'örnek satırın kararı',
  'POST /invoices/:id/lines/decide': 'örnek satırların toplu kararı',
  'POST /invoices/:id/recompare': 'örnek faturanın yeniden hesabı',
  'POST /invoices/:id/recalculate/preview': 'örnek faturanın önce/sonra önizlemesi',
  'POST /invoices/:id/recalculate': 'örnek faturanın yeniden hesabı',
  'POST /invoices/:id/disputes': 'örnek faturanın itirazı (faturayla birlikte silinir)',
  'POST /disputes/:id/resend': 'örnek itiraz',
  'POST /disputes/:id/withdraw': 'örnek itiraz',
  'POST /disputes/:id/results': 'örnek itiraz sonucu',
  'POST /dispute-results/:id/revert': 'örnek itiraz sonucu',
  'POST /jobs/:jobId/cancel': 'iş durdurma',
};

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const withRandomIds = (url: string) => url.replace(/:[A-Za-z]+/g, () => crypto.randomUUID());
const abs = (rel: string) => path.join(env.storageDir, rel);
const onDisk = (rel: string) => fs.existsSync(abs(rel));

/** Firma klasöründeki dosyalar (klasörler sayılmaz). */
function filesUnder(companyId: string): string[] {
  const dir = path.join(env.storageDir, companyId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => fs.statSync(path.join(dir, f)).isFile());
}

function counts(companyId: string) {
  return inCompany(companyId, async () => ({
    carriers: await prisma.carrier.count({ where: { companyId } }),
    tariffs: await prisma.tariff.count({ where: { companyId } }),
    revisions: await prisma.tariffRevision.count({ where: { companyId } }),
    invoices: await prisma.invoice.count({ where: { companyId } }),
    lines: await prisma.invoiceLine.count({ where: { companyId } }),
    files: await prisma.file.count({ where: { companyId } }),
    measurements: await prisma.measurement.count({ where: { companyId } }),
    demoMeasurements: await prisma.measurement.count({ where: { companyId, clientId: { startsWith: DEMO_CLIENT_ID_PREFIX } } }),
    documents: await prisma.tariffDocument.count({ where: { companyId } }),
    drafts: await prisma.tariffImportDraft.count({ where: { companyId } }),
    jobs: await prisma.job.count({ where: { companyId } }),
    presets: await prisma.boxPreset.count({ where: { companyId } }),
  }));
}

type Flag = { startedAt: string; byMemberId: string | null; carrierIds?: string[]; loadingSince?: string };

/** Veritabanındaki ham bayrak (`settingsFor` süzgecinden geçmeden). */
const rawFlag = (companyId: string) =>
  inCompany(companyId, async () => ((await prisma.company.findFirstOrThrow({ where: { id: companyId }, select: { settings: true } })).settings as { demo?: Flag }).demo);

/** Bayrağa alan yazar (başka kopyada süren ya da yarım kalmış yüklemeyi taklit eder). */
const patchFlag = (companyId: string, patch: Partial<Flag>) =>
  inCompany(companyId, async () => {
    const { settings } = await prisma.company.findFirstOrThrow({ where: { id: companyId }, select: { settings: true } });
    const s = settings as Record<string, unknown> & { demo: Flag };
    await prisma.company.update({ where: { id: companyId }, data: { settings: { ...s, demo: { ...s.demo, ...patch } } } });
  });

const firstSampleTracking = () => (JSON.parse(fs.readFileSync(path.join(SAMPLES, 'seed-measurements.json'), 'utf8')) as { trackingRaw: string }[])[0]!.trackingRaw;

describe('örnek veriyle deneme turu (Mesaj 14 §4.3)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await getApp();
  });
  afterEach(() => {
    failures.failAt = null;
    failures.calls = 0;
  });

  const start = (auth: { authorization: string }) => app.inject({ method: 'POST', url: `${API}/settings/demo`, headers: auth, payload: {} });
  const end = (auth: { authorization: string }) => app.inject({ method: 'DELETE', url: `${API}/settings/demo`, headers: auth });
  const onboarding = async (auth: { authorization: string }) => (await app.inject({ method: 'GET', url: `${API}/settings/onboarding`, headers: auth })).json();
  const settings = async (auth: { authorization: string }) => (await app.inject({ method: 'GET', url: `${API}/settings`, headers: auth })).json();

  it('koruma listesi: yazma yöntemli her uç ya kapalı ya da gerekçeli izin listesinde; listelerde artık olmayan uç yok', () => {
    const routes = app.routeTable.filter((r) => r.url.startsWith(API_PREFIX)).map((r) => `${r.method} ${r.url.slice(API_PREFIX.length)}`);
    const writes = routes.filter((k) => WRITE_METHODS.has(k.split(' ')[0]!));
    expect(writes.filter((k) => !DEMO_BLOCKED.has(k) && !(k in DEMO_ALLOWED)), 'koruma listesinde de izin listesinde de olmayan').toEqual([]);
    expect([...DEMO_BLOCKED].filter((k) => k in DEMO_ALLOWED), 'iki listede birden').toEqual([]);
    expect([...DEMO_BLOCKED, ...Object.keys(DEMO_ALLOWED)].filter((k) => !routes.includes(k)), 'artık var olmayan uç').toEqual([]);
    // Taşıyıcı, tarife ve fatura açan bilinen yollar kapalı.
    for (const k of ['POST /carriers', 'POST /tariffs', 'POST /tariffs/:id/duplicate', 'POST /tariff-imports/:draftId/apply', 'POST /invoices', 'POST /invoices/samples']) {
      expect(DEMO_BLOCKED.has(k), k).toBe(true);
    }
  });

  it('yalnız ayar yetkisi; boş firmada açılır, örnek veriyi yükler, kurulumu tamamlar; ikinci başlatma 409', async () => {
    const a = await registerCompany(app, uniq('Deneme A '));
    const worker = await createWorker(app, a.auth);
    expect((await start(worker.auth)).statusCode).toBe(403);
    expect((await end(worker.auth)).statusCode).toBe(403);

    expect((await onboarding(a.auth)).demo).toEqual({ active: false, available: true });
    const r = await start(a.auth);
    expect(r.statusCode, r.body).toBe(201);
    const body = r.json() as { carriers: number; tariffs: number; measurements: number; invoices: number };
    expect(body.invoices).toBe(2);
    expect(body.carriers).toBeGreaterThan(0);
    expect(body.tariffs).toBeGreaterThan(0);
    expect(body.measurements).toBeGreaterThan(0);

    const c = await counts(a.companyId);
    expect(c).toMatchObject({ carriers: body.carriers, tariffs: body.tariffs, invoices: 2, measurements: body.measurements, demoMeasurements: body.measurements });
    expect(c.lines).toBeGreaterThan(0);
    expect(c.files).toBe(2);

    // Faturalar bugüne göre: FedEx 5 gün önce (itiraz için 3 gün kalır), Aras 20 gün önce. Listede görünür (örnek değil).
    const today = zonedDate(new Date(), DEFAULT_TIME_ZONE);
    const day = (n: number) => new Date(Date.parse(`${today}T00:00:00.000Z`) - n * 86_400_000).toISOString().slice(0, 10);
    const invs = await inCompany(a.companyId, () => prisma.invoice.findMany({ where: { companyId: a.companyId }, select: { invoiceNo: true, invoiceDate: true, isSample: true } }));
    expect(Object.fromEntries(invs.map((i) => [i.invoiceNo, i.invoiceDate.toISOString().slice(0, 10)]))).toEqual({ '9-482-11735': day(5), 'ARS-2026-004871': day(20) });
    expect(invs.every((i) => !i.isSample)).toBe(true);
    expect((await app.inject({ method: 'GET', url: `${API}/invoices`, headers: a.auth })).json().items).toHaveLength(2);

    // Bant herkese: başlatanın kimliği yalnız ayar yetkisi olana.
    const s = await settings(a.auth);
    expect(s.demo).toEqual({ startedAt: expect.any(String), byMemberId: a.userId });
    const ws = await settings(worker.auth);
    expect(ws.demo).toEqual({ startedAt: s.demo.startedAt });
    expect((await app.inject({ method: 'GET', url: `${API}/me`, headers: worker.auth })).json().company.settings.demo).toEqual({ startedAt: s.demo.startedAt });
    // Bayrak ayar ucundan yazılamaz
    expect((await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: a.auth, payload: { demo: null } })).statusCode).toBe(400);

    const ob = await onboarding(a.auth);
    expect(ob).toMatchObject({ completed: true, demo: { active: true, available: false } });

    const again = await start(a.auth);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('DEMO_ACTIVE');
    expect((await counts(a.companyId)).invoices).toBe(2);

    const audits = await inCompany(a.companyId, () => prisma.auditLog.findMany({ where: { companyId: a.companyId, action: 'company.demoStart' } }));
    expect(audits).toHaveLength(1);
  }, 120_000);

  it('boş olmayan firmada açılmaz: pasif taşıyıcı, yalnız ölçüm ya da tam firma → 409 DEMO_NOT_EMPTY, bayrak yazılmaz', async () => {
    const withCarrier = await registerCompany(app, uniq('Deneme Dolu '));
    const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: withCarrier.auth, payload: { code: 'fedex' } });
    expect(c.statusCode, c.body).toBe(201);
    const off = await app.inject({ method: 'PATCH', url: `${API}/carriers/${c.json().carrier.id}`, headers: withCarrier.auth, payload: { active: false } });
    expect(off.statusCode, off.body).toBe(200);

    const withMeasurement = await registerCompany(app, uniq('Deneme Ölçüm '));
    const w = await createWorker(app, withMeasurement.auth);
    const mp = measurementPayload();
    expect((await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...w.auth, ...mp.headers }, payload: mp.payload })).statusCode).toBe(201);

    const full = await companyFixture(app);

    const firms = [
      { auth: withCarrier.auth, companyId: withCarrier.companyId },
      { auth: withMeasurement.auth, companyId: withMeasurement.companyId },
      { auth: full.admin.auth, companyId: full.companyId },
    ];
    for (const { auth, companyId } of firms) {
      expect((await onboarding(auth)).demo).toEqual({ active: false, available: false });
      const before = await counts(companyId);
      const r = await start(auth);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error.code).toBe('DEMO_NOT_EMPTY');
      expect((await settings(auth)).demo).toBeUndefined();
      expect(await counts(companyId)).toEqual(before);
    }
  }, 120_000);

  it('deneme açıkken taşıyıcı, tarife ve fatura ekleyen her uç 409 DEMO_ACTIVE; ölçüm, ayar ve hazır koli serbest; bitince açılır', async () => {
    const a = await registerCompany(app, uniq('Deneme Koruma '));
    const worker = await createWorker(app, a.auth);
    expect((await start(a.auth)).statusCode).toBe(201);
    const before = await counts(a.companyId);

    const wrong: string[] = [];
    for (const key of DEMO_BLOCKED) {
      const [method, route] = key.split(' ') as [string, string];
      const res = await app.inject({ method: method as 'POST', url: API + withRandomIds(route), headers: a.auth, payload: {} });
      if (res.statusCode !== 409 || res.json().error?.code !== 'DEMO_ACTIVE') wrong.push(`${key} → ${res.statusCode} ${res.body.slice(0, 80)}`);
    }
    expect(wrong).toEqual([]);
    // Metin isteğin dilinde
    const en = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: { ...a.auth, 'accept-language': 'en' }, payload: { code: 'ups' } });
    expect(en.json().error.message).toBe(m('err.demoActive', undefined, 'en'));
    expect(await counts(a.companyId)).toEqual(before);

    // Serbest olanlar
    expect((await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: a.auth, payload: { desiDivisor: 4000 } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `${API}/box-presets`, headers: a.auth, payload: { name: 'K9', lengthCm: 10, widthCm: 10, heightCm: 10 } })).statusCode).toBe(201);
    const mp = measurementPayload();
    expect((await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...mp.headers }, payload: mp.payload })).statusCode).toBe(201);
    await drainMeasurementQueue(30_000);

    const e = await end(a.auth);
    expect(e.statusCode, e.body).toBe(200);
    const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: a.auth, payload: { code: 'fedex' } });
    expect(c.statusCode, c.body).toBe(201);
  }, 120_000);

  it('bitirme yalnız örnek veriyi siler: gerçek ölçüm ve fotoğrafı, başka firma, ortak yol ve firma dışı dosya kalır', async () => {
    const a = await registerCompany(app, uniq('Deneme Bitir '));
    const worker = await createWorker(app, a.auth);
    const other = await companyFixture(app);
    const otherBefore = await counts(other.companyId);
    const otherPhoto = await inCompany(other.companyId, () => prisma.file.findFirstOrThrow({ where: { id: other.photoId } }));
    expect(onDisk(otherPhoto.path)).toBe(true);
    // Başka firmanın da denemesi açık: A'nın bitirmesi ona dokunmaz.
    const b = await registerCompany(app, uniq('Deneme Komşu '));
    expect((await start(b.auth)).statusCode).toBe(201);
    const bBefore = await counts(b.companyId);

    expect((await start(a.auth)).statusCode).toBe(201);
    const started = await counts(a.companyId);

    // Deneme sırasında çalışanın gerçek ölçümleri: biri yeni koli, biri örnek takip numarasını yeniden ölçer (örneğin yeni sürümü olur).
    const real1 = measurementPayload();
    const r1 = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...real1.headers }, payload: real1.payload });
    expect(r1.statusCode, r1.body).toBe(201);
    const real2 = measurementPayload({ trackingRaw: firstSampleTracking() });
    const r2 = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...real2.headers }, payload: real2.payload });
    expect(r2.statusCode, r2.body).toBe(201);
    await drainMeasurementQueue(30_000);
    const realIds = [r1.json().measurement.id as string, r2.json().measurement.id as string];
    const realPhotos = await inCompany(a.companyId, () => prisma.file.findMany({ where: { companyId: a.companyId, measurementId: { in: realIds } } }));
    expect(realPhotos).toHaveLength(2);
    for (const p of realPhotos) expect(onDisk(p.path)).toBe(true);

    const demoFiles = await inCompany(a.companyId, () => prisma.file.findMany({ where: { companyId: a.companyId, kind: 'INVOICE_SOURCE' }, orderBy: { createdAt: 'asc' } }));
    expect(demoFiles).toHaveLength(2);
    for (const f of demoFiles) expect(onDisk(f.path)).toBe(true);
    const [firstDemoFile, secondDemoFile] = demoFiles as [(typeof demoFiles)[number], (typeof demoFiles)[number]];

    // Ortak yol: gerçek ölçümün fotoğraf satırı ikinci örnek dosyanın yolunu kullanıyor → disk dosyası kalmalı.
    const sharedRow = await inCompany(a.companyId, () =>
      prisma.file.create({
        data: { companyId: a.companyId, kind: 'PHOTO_OTHER', mime: 'image/jpeg', size: 1, path: secondDemoFile.path, sha256: 'x', measurementId: realIds[0]!, createdById: worker.userId },
      }),
    );
    // Firma dışı yol: örnek dosya satırı başka firmanın fotoğrafını gösteriyor → satır gider, o dosya diskte kalır.
    const firstOwnPath = firstDemoFile.path;
    await inCompany(a.companyId, () => prisma.file.update({ where: { id: firstDemoFile.id }, data: { path: otherPhoto.path } }));

    // Arka plan işleri: örnek dosyadaki süren iş silinir; gerçek fotoğraftaki bitmiş iş kalır.
    const jobs = await inCompany(a.companyId, async () => ({
      onDemo: await prisma.job.create({ data: { companyId: a.companyId, kind: 'INVOICE_PDF_READ', status: 'QUEUED', dedupeKey: uniq('demo-'), refType: 'File', refId: secondDemoFile.id, input: { v: 1 } } }),
      onReal: await prisma.job.create({
        data: { companyId: a.companyId, kind: 'INVOICE_PDF_READ', status: 'SUCCEEDED', dedupeKey: uniq('real-'), refType: 'File', refId: realPhotos[0]!.id, input: { v: 1 }, finishedAt: new Date() },
      }),
    }));

    const e = await end(a.auth);
    expect(e.statusCode, e.body).toBe(200);
    expect(e.json().removed).toEqual({ invoices: 2, tariffs: started.tariffs, carriers: started.carriers, measurements: started.demoMeasurements });

    const after = await counts(a.companyId);
    expect(after).toMatchObject({ carriers: 0, tariffs: 0, revisions: 0, invoices: 0, lines: 0, documents: 0, drafts: 0, demoMeasurements: 0, measurements: 2, presets: started.presets });
    // Kalan dosya satırları: iki gerçek fotoğraf + ortak yollu satır
    const left = await inCompany(a.companyId, () => prisma.file.findMany({ where: { companyId: a.companyId }, select: { id: true } }));
    expect(left.map((f) => f.id).sort()).toEqual([...realPhotos.map((p) => p.id), sharedRow.id].sort());
    const realLeft = await inCompany(a.companyId, () => prisma.measurement.findMany({ where: { companyId: a.companyId }, select: { id: true, deletedAt: true, supersededById: true } }));
    expect(realLeft.map((x) => x.id).sort()).toEqual([...realIds].sort());
    expect(realLeft.every((x) => x.deletedAt === null && x.supersededById === null)).toBe(true);
    expect((await app.inject({ method: 'GET', url: `${API}/measurements/${realIds[1]}`, headers: a.auth })).statusCode).toBe(200);

    // Disk: örnek dosya silindi; gerçek fotoğraflar, ortak yol ve başka firmanın dosyası kaldı.
    expect(onDisk(firstOwnPath)).toBe(true); // satırı başka yolu gösterdiği için bu dosya hiç hedef olmadı (yetim kalır)
    expect(onDisk(secondDemoFile.path)).toBe(true);
    expect(onDisk(otherPhoto.path)).toBe(true);
    for (const p of realPhotos) expect(onDisk(p.path)).toBe(true);

    const leftJobs = await inCompany(a.companyId, () => prisma.job.findMany({ where: { companyId: a.companyId }, select: { id: true } }));
    expect(leftJobs.map((j) => j.id)).toEqual([jobs.onReal.id]);

    // Bayrak indi, kurulum baştan; korumalar kalktı
    expect((await settings(a.auth)).demo).toBeUndefined();
    expect(await onboarding(a.auth)).toMatchObject({ completed: false, required: true, demo: { active: false, available: false } });
    const again = await end(a.auth);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('DEMO_NOT_ACTIVE');
    expect(await inCompany(a.companyId, () => prisma.auditLog.count({ where: { companyId: a.companyId, action: 'company.demoEnd' } }))).toBe(1);

    // Başka firmalar
    expect(await counts(other.companyId)).toEqual(otherBefore);
    expect(await counts(b.companyId)).toEqual(bBefore);
    expect((await settings(b.auth)).demo).toBeTruthy();
  }, 180_000);

  it('bitirme örnek fatura dosyasını diskten siler; firma klasöründe örnekten dosya kalmaz', async () => {
    const a = await registerCompany(app, uniq('Deneme Disk '));
    expect((await start(a.auth)).statusCode).toBe(201);
    const files = await inCompany(a.companyId, () => prisma.file.findMany({ where: { companyId: a.companyId } }));
    expect(files).toHaveLength(2);
    for (const f of files) expect(onDisk(f.path)).toBe(true);
    expect((await end(a.auth)).statusCode).toBe(200);
    for (const f of files) expect(onDisk(f.path)).toBe(false);
    expect(filesUnder(a.companyId)).toEqual([]);
  }, 120_000);

  it('yarıda kalan başlatma: yüklenen örnek veri silinir, bayrak iner, kurulum ilerlemesi geri döner; sonra yeniden açılabilir', async () => {
    const a = await registerCompany(app, uniq('Deneme Hata '));
    const step = await app.inject({ method: 'PATCH', url: `${API}/settings/onboarding`, headers: a.auth, payload: { step: 'tasiyicilar', done: 'sirket' } });
    expect(step.statusCode).toBe(200);
    const presetsBefore = (await counts(a.companyId)).presets;

    failures.failAt = 1; // ilk fatura yüklenir, ikincisi düşer
    const r = await start(a.auth);
    expect(r.statusCode).toBe(500);
    expect(await counts(a.companyId)).toEqual({
      carriers: 0, tariffs: 0, revisions: 0, invoices: 0, lines: 0, files: 0, measurements: 0, demoMeasurements: 0, documents: 0, drafts: 0, jobs: 0, presets: presetsBefore,
    });
    expect(filesUnder(a.companyId)).toEqual([]);
    expect((await settings(a.auth)).demo).toBeUndefined();
    const ob = await onboarding(a.auth);
    expect(ob).toMatchObject({ completed: false, demo: { active: false, available: true } });
    expect(ob.state).toMatchObject({ step: 'tasiyicilar', done: ['sirket'] });

    failures.failAt = null;
    const ok = await start(a.auth);
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await counts(a.companyId)).invoices).toBe(2);
  }, 120_000);

  it('eşzamanlı istekler: iki başlatmadan biri açar; başlatma ile bitirme aynı anda gelince yarım örnek veri kalmaz', async () => {
    const a = await registerCompany(app, uniq('Deneme Yarış '));
    const [x, y] = await Promise.all([start(a.auth), start(a.auth)]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([201, 409]);
    expect((x.statusCode === 409 ? x : y).json().error.code).toBe('DEMO_ACTIVE');
    expect((await counts(a.companyId)).invoices).toBe(2);
    expect((await end(a.auth)).statusCode).toBe(200);

    const b = await registerCompany(app, uniq('Deneme Yarış B '));
    const [s, e] = await Promise.all([start(b.auth), end(b.auth)]);
    expect(s.statusCode, s.body).toBe(201);
    const c = await counts(b.companyId);
    if (e.statusCode === 200) {
      // bitirme başlatmanın ardından sıraya girdi: hepsi silindi, bayrak yok
      expect(c).toMatchObject({ carriers: 0, tariffs: 0, invoices: 0, demoMeasurements: 0 });
      expect((await settings(b.auth)).demo).toBeUndefined();
    } else {
      // bitirme önce geldi (açık deneme yoktu): deneme eksiksiz açık
      expect(e.statusCode).toBe(409);
      expect(c).toMatchObject({ invoices: 2 });
      expect(c.carriers).toBeGreaterThan(0);
      expect((await settings(b.auth)).demo).toBeTruthy();
    }
  }, 180_000);

  it('DEMO_TOUR=off: başlatma 404 ve kurulumda görünmez; açık kalmış deneme yine bitirilebilir', async () => {
    const a = await registerCompany(app, uniq('Deneme Kapalı '));
    const open = await registerCompany(app, uniq('Deneme Açık Kalan '));
    expect((await start(open.auth)).statusCode).toBe(201);
    const before = process.env.DEMO_TOUR;
    process.env.DEMO_TOUR = 'off';
    try {
      expect(env.demoTourEnabled).toBe(false);
      expect((await start(a.auth)).statusCode).toBe(404);
      expect((await onboarding(a.auth)).demo).toEqual({ active: false, available: false });
      expect((await settings(a.auth)).demo).toBeUndefined();
      // koruma bayrağa bağlı: sunucuda kapalı olsa da açık denemede ekleme kapalı
      expect((await app.inject({ method: 'POST', url: `${API}/carriers`, headers: open.auth, payload: { code: 'ups' } })).statusCode).toBe(409);
      const e = await end(open.auth);
      expect(e.statusCode, e.body).toBe(200);
      expect((await counts(open.companyId)).carriers).toBe(0);
    } finally {
      if (before === undefined) delete process.env.DEMO_TOUR;
      else process.env.DEMO_TOUR = before;
    }
  }, 120_000);

  it('bitirme yalnız bayraktaki taşıyıcıları siler: koruma dışından eklenen gerçek taşıyıcı ve denemeden önceki firma işi kalır', async () => {
    const a = await registerCompany(app, uniq('Deneme Liste '));
    const bulkJob = (dedupe: string, createdAt?: Date) =>
      inCompany(a.companyId, () =>
        prisma.job.create({
          data: { companyId: a.companyId, kind: 'BULK_RECOMPARE_APPLY', status: 'SUCCEEDED', dedupeKey: uniq(dedupe), refType: 'Company', refId: a.companyId, input: { v: 1 }, finishedAt: new Date(), ...(createdAt ? { createdAt } : {}) },
        }),
      );
    // Denemeden önce açılmış firma çapında iş: denemeye ait değil, kalır.
    const oldJob = await bulkJob('old-', new Date(Date.now() - 3_600_000));

    expect((await start(a.auth)).statusCode).toBe(201);
    const started = await counts(a.companyId);
    const flag = await rawFlag(a.companyId);
    // Bayrak açılan taşıyıcıları taşır; yükleme bitti, `loadingSince` kalktı. Bu alanlar dışarı verilmez.
    expect(flag?.loadingSince).toBeUndefined();
    const demoCarrierIds = await inCompany(a.companyId, () => prisma.carrier.findMany({ where: { companyId: a.companyId }, select: { id: true } }));
    expect([...(flag?.carrierIds ?? [])].sort()).toEqual(demoCarrierIds.map((c) => c.id).sort());
    expect(await settings(a.auth)).toMatchObject({ demo: { startedAt: flag?.startedAt, byMemberId: a.userId } });
    expect(Object.keys((await settings(a.auth)).demo).sort()).toEqual(['byMemberId', 'startedAt']);

    // Bayrak yazıldıktan sonra listede olmayan taşıyıcı (yarış ya da kaçak uç): doğrudan veritabanına, aynı kodla.
    const real = await inCompany(a.companyId, () => prisma.carrier.create({ data: { companyId: a.companyId, code: 'fedex', name: 'Gerçek FedEx' } }));
    const newJob = await bulkJob('new-');

    const e = await end(a.auth);
    expect(e.statusCode, e.body).toBe(200);
    expect(e.json().removed).toMatchObject({ carriers: started.carriers, tariffs: started.tariffs, invoices: 2 });
    const left = await inCompany(a.companyId, () => prisma.carrier.findMany({ where: { companyId: a.companyId }, select: { id: true, name: true } }));
    expect(left).toEqual([{ id: real.id, name: 'Gerçek FedEx' }]);
    expect(await counts(a.companyId)).toMatchObject({ tariffs: 0, invoices: 0, demoMeasurements: 0 });
    const jobsLeft = await inCompany(a.companyId, () => prisma.job.findMany({ where: { companyId: a.companyId }, select: { id: true } }));
    expect(jobsLeft.map((j) => j.id)).toEqual([oldJob.id]);
    expect(jobsLeft.map((j) => j.id)).not.toContain(newJob.id);
  }, 120_000);

  it('örnek ölçümün düzeltmesi önekli açılır ve bitirmede zinciriyle silinir; istemci önekli clientId gönderemez', async () => {
    const a = await registerCompany(app, uniq('Deneme Düzelt '));
    const worker = await createWorker(app, a.auth);
    // İstemci öneki seçemez (deneme açık olmasa da): 400, kayıt yazılmaz.
    const forged = measurementPayload({ clientId: `${DEMO_CLIENT_ID_PREFIX}${crypto.randomUUID()}` });
    const f = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...forged.headers }, payload: forged.payload });
    expect(f.statusCode, f.body).toBe(400);
    expect(f.json().error.code).toBe('VALIDATION');
    expect((await counts(a.companyId)).measurements).toBe(0);

    expect((await start(a.auth)).statusCode).toBe(201);
    const sample = await inCompany(a.companyId, () =>
      prisma.measurement.findFirstOrThrow({ where: { companyId: a.companyId, clientId: { startsWith: DEMO_CLIENT_ID_PREFIX }, supersededById: null, deletedAt: null }, orderBy: { measuredAt: 'asc' } }),
    );
    const p = await app.inject({ method: 'PATCH', url: `${API}/measurements/${sample.id}`, headers: a.auth, payload: { lengthCm: 26, widthCm: 25, heightCm: 16 } });
    expect(p.statusCode, p.body).toBe(200);
    const next = await inCompany(a.companyId, () => prisma.measurement.findUniqueOrThrow({ where: { id: p.json().measurement.id as string } }));
    expect(next.id).not.toBe(sample.id);
    expect(next.clientId.startsWith(DEMO_CLIENT_ID_PREFIX)).toBe(true);
    await drainMeasurementQueue(30_000);

    expect((await end(a.auth)).statusCode).toBe(200);
    const onTracking = await inCompany(a.companyId, () => prisma.measurement.count({ where: { companyId: a.companyId, trackingNo: sample.trackingNo } }));
    expect(onTracking).toBe(0);
    expect((await counts(a.companyId)).measurements).toBe(0);
  }, 120_000);

  it('yükleme sürerken (başka kopya) bitirme 409 DEMO_LOADING ve hiçbir şey silmez; süresi dolmuş yükleme temizlenir', async () => {
    const a = await registerCompany(app, uniq('Deneme Yükleniyor '));
    expect((await start(a.auth)).statusCode).toBe(201);
    const before = await counts(a.companyId);

    await patchFlag(a.companyId, { loadingSince: new Date().toISOString() });
    const busy = await end(a.auth);
    expect(busy.statusCode, busy.body).toBe(409);
    expect(busy.json().error.code).toBe('DEMO_LOADING');
    expect(busy.json().error.message).toBe(m('err.demoLoading'));
    expect(await counts(a.companyId)).toEqual(before);
    expect((await rawFlag(a.companyId))?.loadingSince).toBeTruthy();

    // Süresi dolmuş yükleme (süreç düştü): bitirme temizler.
    await patchFlag(a.companyId, { loadingSince: new Date(Date.now() - DEMO_LOADING_TTL_MS - 60_000).toISOString() });
    const e = await end(a.auth);
    expect(e.statusCode, e.body).toBe(200);
    expect(await counts(a.companyId)).toMatchObject({ carriers: 0, tariffs: 0, invoices: 0, demoMeasurements: 0 });
    expect(await rawFlag(a.companyId)).toBeUndefined();
  }, 120_000);

  it('örnek ölçüm yazımı takip numarası kilidini bekler (ölçüm ucuyla aynı sıra)', async () => {
    const a = await registerCompany(app, uniq('Deneme Kilit '));
    const trackingRaw = uniq('LOCK');
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = inCompany(a.companyId, () =>
      prisma.$transaction(
        async (tx) => {
          await lockTracking(tx, a.companyId, [normalizeTracking(trackingRaw)]);
          locked();
          await held;
        },
        { timeout: 20_000 },
      ),
    );
    await isLocked;

    let done = false;
    const sample = { trackingRaw, lengthCm: 10, widthCm: 10, heightCm: 10, weightKg: 1, dimMethod: 'MANUAL' as const, weightMethod: 'MANUAL' as const, measuredAt: new Date().toISOString() };
    const write = inCompany(a.companyId, () => createSampleMeasurement(a.companyId, a.userId, sample, [], DEMO_CLIENT_ID_PREFIX)).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(done).toBe(false);
    release();
    await holder;
    expect(await write).toBe(true);
    expect(await inCompany(a.companyId, () => prisma.measurement.count({ where: { companyId: a.companyId, trackingNo: normalizeTracking(trackingRaw) } }))).toBe(1);
  }, 60_000);
});
