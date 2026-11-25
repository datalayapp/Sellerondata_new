/**
 * 03-B4: ölçüm kaydedilir, ardından faturalarla karşılaştırma hata verirse iş kaybolmamalı.
 *
 * Hata, kur servisinin geçici olarak patlamasıyla kurulur (tarife USD, fatura TRY: karşılaştırma kur ister). Ölçüm o
 * sırada veritabanına yazılmıştır; telefon hata görüp aynı ölçümü (aynı clientId) yeniden gönderir. Düzeltme, silme ve
 * geri yüklemenin tekrar gönderimi yoktur: onları bakım işi tamamlar.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, withMaintenanceScope } from '../src/db.ts';
import { FxService, setFxService, tcmbUrl, type FxFetcher } from '../src/services/fx.ts';
import { RECOMPARE_STALE_MS, runMaintenance } from '../src/services/maintenance.ts';
import { createWorker, getApp, inCompany, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';

const API = '/api/deciship';
type Auth = { authorization: string };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deciship-recompare-'));
const fetcher: FxFetcher = async (url) => {
  if (url !== tcmbUrl('2026-10-15')) return { status: 404, text: '' };
  return {
    status: 200,
    text: '<Tarih_Date Tarih="15.10.2026"><Currency CurrencyCode="USD"><Unit>1</Unit><ForexBuying>40</ForexBuying><ForexSelling>40.1</ForexSelling></Currency></Tarih_Date>',
  };
};

/** Açılıp kapatılabilen arıza: `down` iken karşılaştırma hata verir (veritabanı yoğun, kur servisi yavaş gibi). */
class FlakyFx extends FxService {
  down = false;
  constructor() {
    super({ fetcher, cacheDir: tmp, now: () => new Date('2026-11-04T12:00:00Z') });
  }
  override async prefetch(...args: Parameters<FxService['prefetch']>) {
    if (this.down) throw new Error('kur servisi yanıt vermedi');
    return super.prefetch(...args);
  }
}
const fx = new FlakyFx();

beforeAll(() => setFxService(fx));
afterAll(() => {
  setFxService(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Yalnız rakam: normalleştirme numarayı değiştirmez, satır numarayla bulunur. */
const trackingNo = () => `7948${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;

type Line = { id: string; status: string; measurementId: string | null; ourChargeableKg: number | null };

async function usdFirmWithInvoice(app: FastifyInstance, trackingNos: string[]) {
  const admin = await registerCompany(app, uniq('Ölçüm '));
  const worker = await createWorker(app, admin.auth);
  const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'fedex', name: uniq('FedEx') } });
  const carrierId = c.json().carrier.id as string;
  const tariff = await app.inject({
    method: 'POST',
    url: `${API}/tariffs`,
    headers: admin.auth,
    payload: {
      carrierId,
      name: 'USD',
      currency: 'USD',
      divisor: 3000,
      edgeRounding: 'CEIL_CM',
      weightSteps: [{ upto: null, step: 1 }],
      discountPct: 0,
      fuelPct: 0,
      active: true,
      isDefault: true,
      zones: [{ country: '*', zone: 'A' }],
      rates: [{ zone: 'A', weightUpto: 30, price: 100 }],
      overflow: [],
      surcharges: [],
    },
  });
  expect(tariff.statusCode, tariff.body).toBe(201);
  const csv = ['Takip No;Desi;Tutar', ...trackingNos.map((t) => `${t};5;5000`)].join('\n');
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
  ]);
  const preview = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...admin.auth, ...form.headers }, payload: form.payload });
  expect(preview.statusCode, preview.body).toBe(200);
  const inv = await app.inject({
    method: 'POST',
    url: `${API}/invoices`,
    headers: admin.auth,
    payload: {
      fileId: preview.json().fileId,
      carrierId,
      invoiceNo: uniq('F'),
      invoiceDate: '2026-10-15',
      currency: 'TRY',
      mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
      acknowledgeIssues: true,
    },
  });
  expect(inv.statusCode, inv.body).toBe(201);
  return { admin, worker, invoiceId: inv.json().invoice.id as string };
}

async function lineOf(app: FastifyInstance, auth: Auth, invoiceId: string, trackingNo: string): Promise<Line> {
  const r = await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/lines?pageSize=100`, headers: auth });
  const line = (r.json().items as (Line & { trackingNo: string })[]).find((l) => l.trackingNo === trackingNo);
  expect(line, trackingNo).toBeDefined();
  return line!;
}

const pendingOf = (auth: Auth, id: string) =>
  inCompany(auth, async () => (await prisma.measurement.findFirstOrThrow({ where: { id }, select: { recomparePendingAt: true } })).recomparePendingAt);

/** Bekleyen işareti, bakım işinin "yarıda kalmış" sayacağı kadar eskiye çeker. */
const agePending = (auth: Auth, id: string) =>
  inCompany(auth, () => prisma.measurement.update({ where: { id }, data: { recomparePendingAt: new Date(Date.now() - RECOMPARE_STALE_MS - 60_000) } }));

describe('03-B4: ölçüm kaydedildi, karşılaştırma yarıda kaldı', () => {
  it('telefon aynı ölçümü yeniden gönderince karşılaştırma tamamlanır, satır ölçümle eşleşir', async () => {
    const app = await getApp();
    const tracking = trackingNo();
    const { admin, worker, invoiceId } = await usdFirmWithInvoice(app, [tracking]);
    expect((await lineOf(app, admin.auth, invoiceId, tracking)).status).toBe('UNMATCHED');

    const p = measurementPayload({ trackingRaw: tracking, lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
    fx.down = true;
    const first = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...p.headers }, payload: p.payload });
    fx.down = false;
    expect(first.statusCode).toBeGreaterThanOrEqual(500);
    // ölçüm yazıldı, satır hâlâ eşleşmedi
    const saved = await inCompany(admin.auth, () => prisma.measurement.findFirstOrThrow({ where: { clientId: p.data.clientId } }));
    expect((await lineOf(app, admin.auth, invoiceId, tracking)).status).toBe('UNMATCHED');

    const again = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...p.headers }, payload: p.payload });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().measurement.id).toBe(saved.id);

    const line = await lineOf(app, admin.auth, invoiceId, tracking);
    expect(line.measurementId).toBe(saved.id);
    // 5 desi faturalandı, 3 desi ölçüldü: fazla ödeme görünür
    expect(line.status).toBe('DIFF');
    expect(await pendingOf(admin.auth, saved.id)).toBeNull();
  });

  it('karşılaştırması bitmiş ölçümün tekrar gönderimi işaret bırakmaz', async () => {
    const app = await getApp();
    const tracking = trackingNo();
    const { admin, worker, invoiceId } = await usdFirmWithInvoice(app, [tracking]);
    const p = measurementPayload({ trackingRaw: tracking });
    const first = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...p.headers }, payload: p.payload });
    expect(first.statusCode, first.body).toBe(201);
    expect(await pendingOf(admin.auth, first.json().measurement.id)).toBeNull();
    expect((await lineOf(app, admin.auth, invoiceId, tracking)).status).toBe('DIFF');
    const again = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...p.headers }, payload: p.payload });
    expect(again.statusCode, again.body).toBe(200);
  });

  it('yarıda kalan düzeltmeyi bakım işi tamamlar; yeni bekleyene (sürmekte olabilir) dokunmaz', async () => {
    const app = await getApp();
    const [fixed, fresh] = [trackingNo(), trackingNo()];
    const { admin, worker, invoiceId } = await usdFirmWithInvoice(app, [fixed, fresh]);
    const ids: Record<string, string> = {};
    for (const t of [fixed, fresh]) {
      const p = measurementPayload({ trackingRaw: t, lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
      const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...p.headers }, payload: p.payload });
      expect(r.statusCode, r.body).toBe(201);
      ids[t] = r.json().measurement.id;
      expect((await lineOf(app, admin.auth, invoiceId, t)).ourChargeableKg).toBe(3);
    }

    // 40×30×25 / 3000 = 10 desi; karşılaştırma patlar, düzeltme kaydedilmiştir
    fx.down = true;
    const corrected: Record<string, string> = {};
    for (const t of [fixed, fresh]) {
      const r = await app.inject({ method: 'PATCH', url: `${API}/measurements/${ids[t]}`, headers: worker.auth, payload: { lengthCm: 40, widthCm: 30, heightCm: 25 } });
      expect(r.statusCode).toBeGreaterThanOrEqual(500);
      corrected[t] = await inCompany(admin.auth, async () => (await prisma.measurement.findFirstOrThrow({ where: { supersededById: null, trackingNo: t } })).id);
    }
    fx.down = false;
    expect((await lineOf(app, admin.auth, invoiceId, fixed)).ourChargeableKg).toBe(3);

    await agePending(admin.auth, corrected[fixed]!);
    // dar yol: yalnız uzun süredir bekleyen görünür, değiştirilemez
    await withMaintenanceScope(async () => {
      const seen = (await prisma.measurement.findMany({ select: { id: true } })).map((m) => m.id);
      expect(seen).toContain(corrected[fixed]);
      expect(seen).not.toContain(corrected[fresh]);
      expect(seen).not.toContain(ids[fixed]);
      expect((await prisma.measurement.updateMany({ where: { id: corrected[fixed] }, data: { note: 'x' } })).count).toBe(0);
    });
    const result = await runMaintenance();
    expect(result.recompared).toBeGreaterThanOrEqual(1);

    const line = await lineOf(app, admin.auth, invoiceId, fixed);
    expect(line.measurementId).toBe(corrected[fixed]);
    expect(line.ourChargeableKg).toBe(10);
    expect(await pendingOf(admin.auth, corrected[fixed]!)).toBeNull();
    // `RECOMPARE_STALE_MS`'den (2 dk) yeni işaret: bakım işi görmez (ilk istek hâlâ çalışıyor olabilir). Satırı aynı faturada olduğu için
    // yukarıdaki karşılaştırmayla zaten güncellendi; işareti ise yalnız kendi karşılaştırması kaldırır.
    expect(await pendingOf(admin.auth, corrected[fresh]!)).not.toBeNull();
  });

  it('yarıda kalan silme ve geri yükleme de bakım işiyle tamamlanır', async () => {
    const app = await getApp();
    const tracking = trackingNo();
    const { admin, worker, invoiceId } = await usdFirmWithInvoice(app, [tracking]);
    const p = measurementPayload({ trackingRaw: tracking });
    const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...p.headers }, payload: p.payload });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().measurement.id as string;
    expect((await lineOf(app, admin.auth, invoiceId, tracking)).status).toBe('DIFF');

    fx.down = true;
    const del = await app.inject({ method: 'DELETE', url: `${API}/measurements/${id}`, headers: worker.auth });
    fx.down = false;
    expect(del.statusCode).toBeGreaterThanOrEqual(500);
    expect((await lineOf(app, admin.auth, invoiceId, tracking)).status).toBe('DIFF');
    await agePending(admin.auth, id);
    await runMaintenance();
    expect((await lineOf(app, admin.auth, invoiceId, tracking)).status).toBe('UNMATCHED');

    fx.down = true;
    const restore = await app.inject({ method: 'POST', url: `${API}/measurements/${id}/restore`, headers: worker.auth });
    fx.down = false;
    expect(restore.statusCode).toBeGreaterThanOrEqual(500);
    expect((await lineOf(app, admin.auth, invoiceId, tracking)).status).toBe('UNMATCHED');
    await agePending(admin.auth, id);
    await runMaintenance();
    expect((await lineOf(app, admin.auth, invoiceId, tracking)).status).toBe('DIFF');
    expect(await pendingOf(admin.auth, id)).toBeNull();
  });

  // Y93: süre 10 dk'dan 2 dk'ya indi (migration 20261119090000 ilkeyi ALTER POLICY ile değiştirir). Beklenen değer
  // bilerek değişti: ilkenin geçerli tanımı en son göçte, kod sabiti onunla aynı; veritabanındaki ilke de 2 dk.
  it('"yarıda kaldı" süresi kodda, en son göçte ve veritabanındaki ilkede aynı (2 dk)', async () => {
    const dir = path.resolve(import.meta.dirname, '../prisma/migrations');
    const defining = fs
      .readdirSync(dir)
      .filter((d) => fs.existsSync(path.join(dir, d, 'migration.sql')))
      .sort()
      .filter((d) => /POLICY maintenance_recompare_read/.test(fs.readFileSync(path.join(dir, d, 'migration.sql'), 'utf8')));
    expect(defining.at(-1)).toBe('20261119090000_measurement_recompare_stale_short');
    const sql = fs.readFileSync(path.join(dir, defining.at(-1)!, 'migration.sql'), 'utf8');
    expect(sql).toContain("interval '2 minutes'");
    expect(RECOMPARE_STALE_MS).toBe(2 * 60 * 1000);
    const [policy] = await prisma.$queryRaw<{ qual: string }[]>`SELECT qual FROM pg_policies WHERE schemaname = 'deciship' AND tablename = 'Measurement' AND policyname = 'maintenance_recompare_read'`;
    expect(policy?.qual).toMatch(/'00:02:00'::interval/);
  });

  it('dar yol: 2 dk sınırının iki yanı (1 dk önceki işaret görünmez, 3 dk önceki görünür)', async () => {
    const app = await getApp();
    const admin = await registerCompany(app, uniq('Y93 '));
    const worker = await createWorker(app, admin.auth);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const p = measurementPayload({ trackingRaw: uniq('Y93') });
      const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...p.headers }, payload: p.payload });
      expect(r.statusCode, r.body).toBe(201);
      ids.push(r.json().measurement.id as string);
    }
    const [young, old] = ids as [string, string];
    await inCompany(admin.auth, async () => {
      await prisma.measurement.update({ where: { id: young }, data: { recomparePendingAt: new Date(Date.now() - 60_000) } });
      await prisma.measurement.update({ where: { id: old }, data: { recomparePendingAt: new Date(Date.now() - 3 * 60_000) } });
    });
    const seen = await withMaintenanceScope(async () => (await prisma.measurement.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((m) => m.id));
    expect(seen).toEqual([old]);
  });
});
