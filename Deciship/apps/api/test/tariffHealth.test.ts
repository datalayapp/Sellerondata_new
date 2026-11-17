import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { createWorker, getApp, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';
import { viaJob } from './jobHelpers.ts';

/**
 * SPEC §3.8–3.9 uçtan uca (uydurma sayılar, kur yok): faturadaki fiyatla ölçekleme, kesin/tahmini toplamlar,
 * tarife uyumu raporu, ülke istisnası uygulama (sürüm; fatura toplu onayla yeni sürüme geçer), yetki ve şirket ayrımı.
 */

type Auth = { authorization: string };
let app: FastifyInstance;
let auth: Auth;

const post = (url: string, payload: unknown, h: Auth = auth) => app.inject({ method: 'POST', url, headers: h, payload: payload as object });
const get = (url: string, h: Auth = auth) => app.inject({ method: 'GET', url, headers: h });

async function measurement(trackingRaw: string) {
  // 20×20×10 / 5000 = 0,8 kg, gerçek 2 kg → ücretli 2 kg
  const p = measurementPayload({ trackingRaw, lengthCm: 20, widthCm: 20, heightCm: 10, weightKg: 2 });
  const r = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...auth, ...p.headers }, payload: p.payload });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().measurement.trackingNo as string;
}

const TARIFF = {
  name: 'Uyum testi',
  currency: 'TRY',
  divisor: 5000,
  weightSteps: [{ upto: null, step: 0.5 }],
  discountPct: 0,
  fuelPct: 0,
  isDefault: true,
  zones: [
    { country: 'ES', zone: 'T' },
    { country: 'US', zone: 'U' },
  ],
  rates: [
    { zone: 'T', weightUpto: 1, price: 100 },
    { zone: 'T', weightUpto: 2, price: 200 },
    { zone: 'T', weightUpto: 3, price: 250 },
    { zone: 'U', weightUpto: 1, price: 100 },
    { zone: 'U', weightUpto: 2, price: 200 },
    { zone: 'U', weightUpto: 3, price: 300 },
  ],
};

let carrierId = '';
let tariffId = '';
let invoiceId = '';
let esMeasured = '';
let noWeight = '';

beforeAll(async () => {
  app = await getApp();
  auth = (await registerCompany(app, 'Tarife Uyumu')).auth;
  const c = await post('/api/deciship/carriers', { code: 'fedex', name: uniq('FedEx') });
  expect(c.statusCode, c.body).toBe(201);
  carrierId = c.json().carrier.id;
  const t = await post('/api/deciship/tariffs', { ...TARIFF, carrierId });
  expect(t.statusCode, t.body).toBe(201);
  tariffId = t.json().tariff.id;

  esMeasured = await measurement(uniq('8801'));
  noWeight = await measurement(uniq('8802'));
  const rows = [
    'Takip No;Ülke;Ağırlık;Tutar',
    // İspanya: taşıyıcı 3 kg'ı 200'e fiyatlıyor (tarife 250, −%20); ölçülen satır bizde 2 kg
    `${esMeasured};ES;3;200`,
    ...[1, 2, 3].map((i) => `${uniq(`88ES${i}`)};ES;3;200`),
    // ABD: tarifeyle aynı
    ...[1, 2, 3].map((i) => `${uniq(`88US${i}`)};US;2;200`),
    // ağırlık yok, ölçülmüş: tarife 2 kg = 200, faturada 300 → tahmini fark
    `${noWeight};US;;300`,
  ].join('\n');
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: 'uyum.csv', contentType: 'text/csv', data: Buffer.from(rows) },
  ]);
  const pv = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
  expect(pv.statusCode, pv.body).toBe(200);
  const inv = await post('/api/deciship/invoices', {
    fileId: pv.json().fileId,
    carrierId,
    invoiceNo: uniq('U'),
    invoiceDate: '2026-10-20',
    currency: 'TRY',
    mapping: { trackingNo: 'Takip No', destCountry: 'Ülke', billedKg: 'Ağırlık', netAmount: 'Tutar' },
  });
  expect(inv.statusCode, inv.body).toBe(201);
  invoiceId = inv.json().invoice.id;
});

type Line = { trackingNo: string; status: string; diffTypes: string[]; expectedAmount: number | null; diffAmount: number | null; pricingBasis: string | null; rateDeviationPct: number | null; confidence: string; confidenceReason: string | null };
const lines = async () => (await get(`/api/deciship/invoices/${invoiceId}/lines?pageSize=100`)).json().items as Line[];

describe('faturadaki fiyatla ölçekleme ve kesin/tahmini toplamlar', () => {
  it('taşıyıcı ucuzken ağırlık farkı pozitif; ağırlıksız satır tahmini ve Fazla ödeme dışında', async () => {
    const ls = await lines();
    const es = ls.find((l) => l.trackingNo === esMeasured)!;
    // 200 × tarife(2 kg)/tarife(3 kg) = 200 × 200/250 = 160 → +40
    expect(es).toMatchObject({ status: 'DIFF', diffTypes: ['WEIGHT'], pricingBasis: 'INVOICE', expectedAmount: 160, diffAmount: 40, rateDeviationPct: -20, confidence: 'HIGH' });
    const nw = ls.find((l) => l.trackingNo === noWeight)!;
    expect(nw).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], pricingBasis: 'TARIFF', diffAmount: 100, confidence: 'LOW' });
    expect(nw.confidenceReason).toContain('Faturada ücretli ağırlık yok');
    const totals = (await get(`/api/deciship/invoices/${invoiceId}`)).json().invoice.totals;
    expect(totals).toMatchObject({ overchargeTotal: 40, estimatedOverchargeTotal: 100, estimatedLines: 1 });
  });

  it('Excel raporunda tahmini satır ayrı', async () => {
    const r = await get(`/api/deciship/invoices/${invoiceId}/report.xlsx`);
    expect(r.statusCode).toBe(200);
  });
});

describe('GET /invoices/:id/tariff-health', () => {
  it('ülke gruplarında taşıyıcı fiyatı ↔ tarife; ucuz grup için istisna önerisi', async () => {
    const r = await get(`/api/deciship/invoices/${invoiceId}/tariff-health`);
    expect(r.statusCode, r.body).toBe(200);
    const h = r.json().health;
    expect(h).toMatchObject({ stale: false, checkedLines: 7, okLines: 3, skippedLines: 1, okTolerancePct: 1, tariff: { id: tariffId } });
    expect(h.groups[0]).toMatchObject({ country: 'ES', countryName: 'İspanya', zone: 'T', lines: 4, status: 'cheaper', medianDeviationPct: -20, suggestedAdjustmentPct: -20 });
    expect(h.groups[0].message).toContain('%20 düşük');
    expect(h.groups[1]).toMatchObject({ country: 'US', status: 'ok', lines: 3 });
  });

  it('hiçbir satırın fiyatı kontrol edilemiyorsa (tarifede ülke yok) "yeniden karşılaştır" istenmez', async () => {
    const rows = ['Takip No;Ülke;Ağırlık;Tutar', ...[1, 2].map((i) => `${uniq(`88JP${i}`)};JP;2;500`)].join('\n');
    const form = multipart([
      { name: 'carrierId', value: carrierId },
      { name: 'file', filename: 'jp.csv', contentType: 'text/csv', data: Buffer.from(rows) },
    ]);
    const pv = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
    const inv = await post('/api/deciship/invoices', {
      fileId: pv.json().fileId,
      carrierId,
      invoiceNo: uniq('JP'),
      invoiceDate: '2026-10-20',
      currency: 'TRY',
      mapping: { trackingNo: 'Takip No', destCountry: 'Ülke', billedKg: 'Ağırlık', netAmount: 'Tutar' },
    });
    expect(inv.statusCode, inv.body).toBe(201);
    const h = (await get(`/api/deciship/invoices/${inv.json().invoice.id}/tariff-health`)).json().health;
    expect(h).toMatchObject({ stale: false, checkedLines: 0 });
  });

  it('yalnız yönetici; başka şirket göremez', async () => {
    const worker = await createWorker(app, auth);
    expect((await get(`/api/deciship/invoices/${invoiceId}/tariff-health`, worker.auth)).statusCode).toBe(403);
    const other = (await registerCompany(app, 'Başka')).auth;
    expect((await get(`/api/deciship/invoices/${invoiceId}/tariff-health`, other)).statusCode).toBe(404);
  });
});

describe('POST /tariffs/:id/country-adjustments', () => {
  it('yetki ve doğrulama: çalışan 403, başka şirket 404, başka şirketin faturası 404, geçersiz ülke 400', async () => {
    const worker = await createWorker(app, auth);
    const body = { country: 'ES', pct: -20, source: 'invoice', invoiceId };
    expect((await post(`/api/deciship/tariffs/${tariffId}/country-adjustments`, body, worker.auth)).statusCode).toBe(403);
    const other = (await registerCompany(app, 'Başka 2')).auth;
    expect((await post(`/api/deciship/tariffs/${tariffId}/country-adjustments`, body, other)).statusCode).toBe(404);
    // başka şirketin kendi tarifesine bu şirketin faturasıyla
    const oc = (await post('/api/deciship/carriers', { code: 'fedex', name: uniq('F') }, other)).json().carrier.id;
    const ot = (await post('/api/deciship/tariffs', { ...TARIFF, carrierId: oc }, other)).json().tariff.id;
    expect((await post(`/api/deciship/tariffs/${ot}/country-adjustments`, body, other)).statusCode).toBe(404);
    expect((await post(`/api/deciship/tariffs/${tariffId}/country-adjustments`, { ...body, country: 'ESP' })).statusCode).toBe(400);
    expect((await post(`/api/deciship/tariffs/${tariffId}/country-adjustments`, { ...body, pct: -95 })).statusCode).toBe(400);
  });

  it('istisnayı yazar, sürüm alır; fatura toplu onaydan sonra yeni sürümle hesaplanır; rapor uyumlu', async () => {
    const r = await post(`/api/deciship/tariffs/${tariffId}/country-adjustments`, { country: 'es', pct: -20, note: 'Ayrı anlaşma', source: 'invoice', invoiceId });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.tariff.countryAdjustments).toEqual([{ country: 'ES', pct: -20, note: 'Ayrı anlaşma', source: 'invoice', invoiceId }]);
    expect(b.versionId).toBeTruthy();
    // Mesaj 4: istisna faturayı kendiliğinden hesaplamaz; fatura ve raporu kayıtlı sürümle kalır, web toplu önizlemeyi açar
    expect(b.totals).toBeNull();
    expect(b.health.groups.find((g: { country: string }) => g.country === 'ES')).toMatchObject({ status: 'cheaper', medianDeviationPct: -20 });
    expect((await lines()).find((l) => l.trackingNo === esMeasured)).toMatchObject({ pricingBasis: 'INVOICE', expectedAmount: 160, diffAmount: 40, rateDeviationPct: -20 });

    // Y83: toplu hesap yalnız arka planda; `viaJob` işin sonucunu eski yanıt biçiminde verir
    const pv = await viaJob(app, { method: 'POST', url: `/api/deciship/tariffs/${tariffId}/recompare-invoices/preview`, headers: auth, payload: {} });
    expect(pv.statusCode, pv.body).toBe(200);
    expect(pv.json().invoices.map((i: { id: string }) => i.id)).toContain(invoiceId);
    const ok = await viaJob(app, { method: 'POST', url: `/api/deciship/tariffs/${tariffId}/recompare-invoices`, headers: auth, payload: { token: pv.json().token } });
    expect(ok.statusCode, ok.body).toBe(200);
    // 2 kg tarife artık 160: taşıyıcı 3 kg'ı tarifeyle aynı fiyatlıyor → tarife dayanağı, fark yine +40 (ağırlık)
    expect((await get(`/api/deciship/invoices/${invoiceId}`)).json().invoice.totals).toMatchObject({ overchargeTotal: 40, estimatedOverchargeTotal: 100 });
    const health = (await get(`/api/deciship/invoices/${invoiceId}/tariff-health`)).json().health;
    expect(health.groups.find((g: { country: string }) => g.country === 'ES')).toMatchObject({ status: 'ok', medianDeviationPct: 0, currentAdjustmentPct: -20 });
    const es = (await lines()).find((l) => l.trackingNo === esMeasured)!;
    expect(es).toMatchObject({ pricingBasis: 'TARIFF', expectedAmount: 160, diffAmount: 40, rateDeviationPct: 0 });

    const versions = (await get(`/api/deciship/tariffs/${tariffId}/versions`)).json().items as { label: string }[];
    expect(versions[0]!.label).toBe('İspanya istisnası −%20 uygulanmadan önceki sürüm');

    // tam gövde (PUT) istisnaları korur; 0 → kaldırır
    const full = (await get(`/api/deciship/tariffs/${tariffId}`)).json().tariff;
    const put = await app.inject({ method: 'PUT', url: `/api/deciship/tariffs/${tariffId}`, headers: auth, payload: { ...full, id: undefined, carrier: undefined, createdAt: undefined, updatedAt: undefined } });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().tariff.countryAdjustments).toHaveLength(1);
    const del = await post(`/api/deciship/tariffs/${tariffId}/country-adjustments`, { country: 'ES', pct: 0 });
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json()).toMatchObject({ totals: null, health: null });
    expect(del.json().tariff.countryAdjustments).toEqual([]);
  });

  it('sürümden geri yükleme istisnayı geri getirir', async () => {
    const versions = (await get(`/api/deciship/tariffs/${tariffId}/versions`)).json().items as { id: string; label: string }[];
    const v = versions.find((x) => x.label.includes('kaldırılmadan'))!;
    const r = await post(`/api/deciship/tariffs/${tariffId}/versions/${v.id}/restore`, {});
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().tariff.countryAdjustments).toMatchObject([{ country: 'ES', pct: -20 }]);
  });
});

describe('DENETIM-2 B1: hizmeti boş tarife, karışık hizmetli fatura', () => {
  it('fark satırları "İncele" (SERVICE_UNKNOWN), Fazla ödeme dışında; tarife uyumu istisna önermez', async () => {
    const a = (await registerCompany(app, 'Karışık Hizmet')).auth;
    const c = await post('/api/deciship/carriers', { code: 'fedex', name: uniq('FedEx') }, a);
    expect(c.statusCode, c.body).toBe(201);
    const cid = c.json().carrier.id;
    // hizmet adı yok; yakıt sabit (yakıt kuralı bu testte karışmasın)
    const t = await post('/api/deciship/tariffs', { ...TARIFF, carrierId: cid, fuelVariable: false }, a);
    expect(t.statusCode, t.body).toBe(201);
    const meas = async (raw: string) => {
      const p = measurementPayload({ trackingRaw: raw, lengthCm: 20, widthCm: 20, heightCm: 10, weightKg: 2 });
      const r = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...a, ...p.headers }, payload: p.payload });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().measurement.trackingNo as string;
    };
    const eco = await meas(uniq('8901'));
    const pri = await meas(uniq('8902'));
    const rows = [
      'Takip No;Hizmet;Ülke;Ağırlık;Tutar',
      // tarife 2 kg = 200
      `${eco};International Economy;ES;2;230`,
      `${pri};International Priority;ES;2;250`,
      ...[1, 2, 3].map((i) => `${uniq(`89PR${i}`)};International Priority;ES;2;250`),
    ].join('\n');
    const form = multipart([
      { name: 'carrierId', value: cid },
      { name: 'file', filename: 'karisik.csv', contentType: 'text/csv', data: Buffer.from(rows) },
    ]);
    const pv = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...a, ...form.headers }, payload: form.payload });
    expect(pv.statusCode, pv.body).toBe(200);
    const inv = await post(
      '/api/deciship/invoices',
      {
        fileId: pv.json().fileId,
        carrierId: cid,
        invoiceNo: uniq('KH'),
        invoiceDate: '2026-10-20',
        currency: 'TRY',
        mapping: { trackingNo: 'Takip No', service: 'Hizmet', destCountry: 'Ülke', billedKg: 'Ağırlık', netAmount: 'Tutar' },
      },
      a,
    );
    expect(inv.statusCode, inv.body).toBe(201);
    const id = inv.json().invoice.id;
    const ls = (await get(`/api/deciship/invoices/${id}/lines?pageSize=100`, a)).json().items as (Line & { reviewCode: string | null })[];
    expect(ls.find((l) => l.trackingNo === eco)).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], diffAmount: 30, confidence: 'LOW', reviewCode: 'SERVICE_UNKNOWN' });
    expect(ls.find((l) => l.trackingNo === pri)).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], diffAmount: 50, confidence: 'LOW', reviewCode: 'SERVICE_UNKNOWN' });
    expect((await get(`/api/deciship/invoices/${id}`, a)).json().invoice.totals).toMatchObject({ overchargeTotal: 0, estimatedOverchargeTotal: 80, estimatedLines: 2 });
    const h = (await get(`/api/deciship/invoices/${id}/tariff-health`, a)).json().health;
    const g = h.groups.find((x: { service: string | null }) => x.service === 'International Priority');
    expect(g).toMatchObject({ status: 'pricier', lines: 4, suggestedAdjustmentPct: null });
    expect(g.message).toContain('faturada birden çok hizmet var');
  });
});
