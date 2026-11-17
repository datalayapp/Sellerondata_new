/**
 * KALANLAR 1.8 (veritabanlı): telefonda aynı takip no ikinci kez ölçülünce (ikinci koli ya da düzeltme) yeni sürüm birinciyi
 * ezer; ölçüm zincirinde birden çok bağımsız ölçüm (farklı ölçüm anı) varsa ağırlık/ölçü farkı kesin değil, "İncele"
 * (`remeasuredMeasurements`). Düzeltme (`PATCH`) ölçüm anını korur: tek ölçüm sayılır. Aynı dosyada yinelenen takip no'nun
 * ikinci satırı kesin mükerrer değil. Hem içe aktarmada hem ölçümden sonraki yeniden karşılaştırmada.
 */
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { remeasuredMeasurements } from '../src/services/compare.ts';
import { createWorker, getApp, inCompany, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';

const API = '/api/deciship';
type Auth = { authorization: string };
type Line = { trackingNo: string; status: string; diffTypes: string[]; diffAmount: number | null; confidence?: string | null; reviewCode?: string | null };

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

/** Yurt içi tarife: 3000 bölen, n desi = n × 10 TL, ek ücret ve yakıt yok. */
async function firm() {
  const admin = await registerCompany(app, uniq('Çok koli '));
  const worker = await createWorker(app, admin.auth);
  const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'aras', name: uniq('Aras') } });
  const carrierId = c.json().carrier.id as string;
  const tariff = await app.inject({
    method: 'POST',
    url: `${API}/tariffs`,
    headers: admin.auth,
    payload: {
      carrierId,
      name: uniq('Yurt içi '),
      currency: 'TRY',
      divisor: 3000,
      edgeRounding: 'CEIL_CM',
      weightSteps: [{ upto: null, step: 1 }],
      discountPct: 0,
      fuelPct: 0,
      active: true,
      isDefault: true,
      zones: [{ country: '*', zone: 'TR' }],
      rates: Array.from({ length: 30 }, (_, i) => ({ zone: 'TR', weightUpto: i + 1, price: (i + 1) * 10 })),
      overflow: [],
      surcharges: [],
    },
  });
  expect(tariff.statusCode, tariff.body).toBe(201);
  return { admin, worker, carrierId };
}

/**
 * Ölçüm anı şimdiye göre (sunucu en çok 730 gün geriyi kabul eder, KALANLAR 6.7): 20 gün önceki günün saatinden `day` gün
 * sonrası. Sıralar ve aralıklar eski sabit tarihlerle (10 Ekim = 0, 16 Ekim = 6) aynı.
 */
const BASE_DAY = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - 20);
const at = (day: number, hm: string) => new Date(BASE_DAY + day * 86_400_000 + (Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3))) * 60_000).toISOString();

async function measure(auth: Auth, trackingRaw: string, measuredAt: string, dims = { lengthCm: 40, widthCm: 30, heightCm: 30 }) {
  const p = measurementPayload({ trackingRaw, ...dims, weightKg: 3, measuredAt });
  const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...auth, ...p.headers }, payload: p.payload });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().measurement as { id: string };
}

async function importInvoice(f: Awaited<ReturnType<typeof firm>>, rows: string[]) {
  const csv = ['Takip No;Desi;Tutar', ...rows].join('\n');
  const form = multipart([
    { name: 'carrierId', value: f.carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
  ]);
  const preview = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...f.admin.auth, ...form.headers }, payload: form.payload });
  expect(preview.statusCode, preview.body).toBe(200);
  const inv = await app.inject({
    method: 'POST',
    url: `${API}/invoices`,
    headers: f.admin.auth,
    payload: {
      fileId: preview.json().fileId,
      carrierId: f.carrierId,
      invoiceNo: uniq('F'),
      invoiceDate: '2026-10-15',
      currency: 'TRY',
      mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
      acknowledgeIssues: true,
    },
  });
  expect(inv.statusCode, inv.body).toBe(201);
  return inv.json().invoice as { id: string; totals: { overchargeTotal: number; estimatedLines: number } };
}

async function linesOf(auth: Auth, invoiceId: string): Promise<Line[]> {
  const r = await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/lines?pageSize=100`, headers: auth });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().items as Line[];
}

// yalnız rakam: satır takip no'su normalleştirilmiş (büyük harf) döner
const track = () => `7949${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;
const isWeight = (l: Line) => l.diffTypes.some((x) => x === 'WEIGHT' || x === 'DIMENSION');

describe('KALANLAR 1.8: çok koli güvenlik ağı (veritabanı)', () => {
  it('ikinci ölçüm "İncele", düzeltme ve tek ölçüm kesin; dosyada yinelenen ikinci satır kesin mükerrer değil; sonradan ölçülen de "İncele" olur', async () => {
    const f = await firm();
    const [once, twice, edited, later, unmeasured] = [track(), track(), track(), track(), track()];
    // tek koli 40×30×30 = 12 desi, 3 kg
    await measure(f.worker.auth, once, at(0, '09:00'));
    await measure(f.worker.auth, later, at(0, '09:05'));
    // aynı takip no ikinci kez ölçüldü (ikinci koli): yeni sürüm birinciyi ezer
    const t1 = await measure(f.worker.auth, twice, at(0, '09:10'));
    const t2 = await measure(f.worker.auth, twice, at(0, '09:20'));
    expect(t2.id).not.toBe(t1.id);
    // düzeltme: ölçü değişir, ölçüm anı aynı kalır (tek ölçüm)
    const e1 = await measure(f.worker.auth, edited, at(0, '09:30'), { lengthCm: 20, widthCm: 20, heightCm: 20 });
    const patch = await app.inject({ method: 'PATCH', url: `${API}/measurements/${e1.id}`, headers: f.worker.auth, payload: { lengthCm: 40, widthCm: 30, heightCm: 30 } });
    expect(patch.statusCode, patch.body).toBe(200);
    const e2 = patch.json().measurement.id as string;
    expect(e2).not.toBe(e1.id);

    const heads = await inCompany(f.admin.auth, () => remeasuredMeasurements(f.admin.companyId, [t2.id, e2]));
    expect([...heads]).toEqual([t2.id]);
    expect((await inCompany(f.admin.auth, () => remeasuredMeasurements(f.admin.companyId, []))).size).toBe(0);

    // faturada her biri 24 desi (240 TL, beklenen 12 desi = 120 TL); ölçülmemiş gönderi aynı dosyada iki satır
    const inv = await importInvoice(f, [`${once};24;240`, `${twice};24;240`, `${edited};24;240`, `${later};24;240`, `${unmeasured};5;50`, `${unmeasured};5;50`]);
    const by = new Map((await linesOf(f.admin.auth, inv.id)).map((l) => [`${l.trackingNo}`, l] as const));
    const one = by.get(once)!;
    expect(one).toMatchObject({ status: 'DIFF', diffAmount: 120, confidence: 'HIGH' });
    expect(isWeight(one)).toBe(true);
    expect(by.get(twice)).toMatchObject({ status: 'DIFF', diffAmount: 120, confidence: 'LOW', reviewCode: 'MULTI_PARCEL' });
    expect(by.get(edited)).toMatchObject({ status: 'DIFF', diffAmount: 120, confidence: 'HIGH' });
    const dupRows = (await linesOf(f.admin.auth, inv.id)).filter((l) => l.trackingNo === unmeasured);
    expect(dupRows.map((l) => [l.status, l.diffTypes, l.confidence ?? null])).toEqual([
      ['UNMATCHED', [], 'HIGH'],
      ['DIFF', ['DUPLICATE'], 'LOW'],
    ]);
    expect(dupRows[1]!.reviewCode).toBe('DUPLICATE');
    // kesin fazla ödeme: once, edited, later (3 × 120); "İncele": twice + mükerrer
    expect(inv.totals).toMatchObject({ overchargeTotal: 360, estimatedLines: 2 });

    // fatura geldikten sonra aynı takip no yeniden ölçüldü (ikinci koli): yeniden karşılaştırma "İncele" yapar
    await measure(f.worker.auth, later, at(6, '08:00'));
    const after = (await linesOf(f.admin.auth, inv.id)).find((l) => l.trackingNo === later)!;
    expect(after).toMatchObject({ status: 'DIFF', diffAmount: 120, confidence: 'LOW', reviewCode: 'MULTI_PARCEL' });
  });
});
