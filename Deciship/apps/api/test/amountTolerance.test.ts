/**
 * KARARLAR "Tutar toleransı" (2026-11-10): tolerans firmanın para biriminde tutulur, dövizli satırda kurla çevrilir.
 * Eskiden "5" her para biriminde 5 sayılıyordu (dolar faturada yaklaşık 200 TL'lik fark görünmüyordu).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { amountTolIn } from '../src/services/compare.ts';
import { FxService, setFxService, tcmbUrl, type FxFetcher } from '../src/services/fx.ts';
import { getApp, inCompany, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';

type Auth = { authorization: string };
const rate = (r: number) => ({ base: 'TRY', quote: 'USD', rate: r, date: '2026-10-15', source: 'TCMB' }) as never;

describe('amountTolIn', () => {
  it('aynı para biriminde ya da para birimi bilinmiyorsa dokunmaz', () => {
    expect(amountTolIn(5, 'TRY', 'TRY', null)).toBe(5);
    expect(amountTolIn(5, 'TRY', undefined, null)).toBe(5);
    expect(amountTolIn(5, undefined, 'USD', null)).toBe(5);
  });

  it('kur varsa kurla çevirir (1 TRY = 0,025 USD → 5 TL = 0,13 USD)', () => {
    expect(amountTolIn(5, 'TRY', 'USD', rate(0.025))).toBe(0.13);
    expect(amountTolIn(5, 'try', 'usd', rate(0.025))).toBe(0.13);
  });

  // Y18 (kullanıcı adına verilen karar, 2026-11-12): sabit yedek oran (5 TL ≈ 0,50 USD, yani 1 USD = 10 TL) kalktı. Eskiden
  // bu test kaba karşılığı (0,5 / 50 / 5) bekliyordu; artık kur yoksa çevrim yok (null) ve satır "kur yok" sınıfına girer.
  it('kur yoksa sabit yedek oran yok: null (USD, EUR, ters yön, bilinmeyen para birimi); sıfır tolerans kur istemez', () => {
    expect(amountTolIn(5, 'TRY', 'USD', null)).toBeNull();
    expect(amountTolIn(5, 'TRY', 'EUR', undefined)).toBeNull();
    expect(amountTolIn(5, 'USD', 'TRY', null)).toBeNull();
    expect(amountTolIn(5, 'USD', 'EUR', null)).toBeNull();
    expect(amountTolIn(5, 'TRY', 'CHF', null)).toBeNull();
    expect(amountTolIn(5, 'TRY', 'USD', rate(0))).toBeNull();
    expect(amountTolIn(0, 'TRY', 'USD', null)).toBe(0);
  });
});

describe('dövizli faturada tolerans firmanın para biriminden çevrilir (uçtan uca)', () => {
  let app: FastifyInstance;
  /** 1 USD = 40,05 TRY (orta kur) */
  const fetcher: FxFetcher = async (url) => {
    if (url !== tcmbUrl('2026-10-15')) return { status: 404, text: '' };
    return {
      status: 200,
      text: '<Tarih_Date Tarih="15.10.2026"><Currency CurrencyCode="USD"><Unit>1</Unit><ForexBuying>40</ForexBuying><ForexSelling>40.1</ForexSelling></Currency></Tarih_Date>',
    };
  };
  beforeAll(async () => {
    app = await getApp();
    setFxService(new FxService({ fetcher, cacheDir: null, now: () => new Date('2026-11-04T12:00:00Z') }));
  });
  afterAll(() => setFxService(null));

  async function importUsd(auth: Auth, carrierId: string, tracking: string, amount: number) {
    const csv = ['Takip No;Tarih;Desi;Tutar', `${tracking};15.10.2026;10;${amount}`].join('\n');
    const form = multipart([
      { name: 'carrierId', value: carrierId },
      { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
    ]);
    const p = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
    expect(p.statusCode, p.body).toBe(200);
    const res = await app.inject({
      method: 'POST',
      url: '/api/deciship/invoices',
      headers: auth,
      payload: { fileId: p.json().fileId, carrierId, invoiceNo: uniq('USD-'), invoiceDate: '2026-10-15', currency: 'USD', mapping: p.json().suggestedMapping, acknowledgeIssues: true },
    });
    expect(res.statusCode, res.body).toBe(201);
    const lines = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${res.json().invoice.id}/lines`, headers: auth });
    return (lines.json().items as { status: string; diffTypes: string[]; diffAmount: number; expectedAmount: number }[])[0]!;
  }

  it('TRY firma, USD tarife ve USD fatura: 5 TL ≈ 0,12 USD; 1 USD fazlası fiyat farkı, 0,10 USD fazlası uyumlu', async () => {
    const admin = await registerCompany(app);
    const carrier = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: admin.auth, payload: { code: 'fedex', name: 'FedEx USD' } });
    expect(carrier.statusCode, carrier.body).toBe(201);
    const carrierId = carrier.json().carrier.id as string;
    const tariff = await app.inject({
      method: 'POST',
      url: '/api/deciship/tariffs',
      headers: admin.auth,
      payload: {
        carrierId,
        name: 'USD tarife',
        currency: 'USD',
        divisor: 3000,
        edgeRounding: 'CEIL_CM',
        weightSteps: [{ upto: null, step: 1 }],
        discountPct: 0,
        fuelPct: 0,
        active: true,
        isDefault: true,
        zones: [{ country: '*', zone: 'A' }],
        rates: Array.from({ length: 30 }, (_, i) => ({ zone: 'A', weightUpto: i + 1, price: (i + 1) * 10 })),
        overflow: [],
        surcharges: [],
      },
    });
    expect(tariff.statusCode, tariff.body).toBe(201);
    const measure = async () => {
      // 40×30×25 / 3000 = 10 kg ücretli → 100 USD
      const p = measurementPayload({ trackingRaw: uniq('7948') });
      const r = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...admin.auth, ...p.headers }, payload: p.payload });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().measurement.trackingNo as string;
    };

    const over = await importUsd(admin.auth, carrierId, await measure(), 101);
    expect(over).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'] });
    expect(Number(over.expectedAmount)).toBe(100);
    expect(Number(over.diffAmount)).toBe(1);

    const within = await importUsd(admin.auth, carrierId, await measure(), 100.1);
    expect(within).toMatchObject({ status: 'MATCH', diffTypes: [] });
  });
});

/**
 * Y18 (kullanıcı adına verilen karar, 2026-11-12): tutar toleransının kuru alınamazsa sabit yedek oran (1 USD = 10 TL)
 * kullanılmaz. Saklı en yakın önceki günün kuru (en çok 7 gün) kullanılır ve satır notunda yazar; o da yoksa satır
 * "Kur alınamadı" olur, kesin fazla ödemeye girmez, "Yeniden karşılaştır" taze kurla hesaplar.
 */
describe('Y18: tolerans kuru alınamazsa sabit yedek oran yok (uçtan uca)', () => {
  let app: FastifyInstance;
  const dirs: string[] = [];
  const tmpCache = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'deciship-fx-tol-'));
    dirs.push(d);
    return d;
  };
  const NOW = () => new Date('2026-11-04T12:00:00Z');
  const bulletin = (dmy: string) =>
    `<Tarih_Date Tarih="${dmy}"><Currency CurrencyCode="USD"><Unit>1</Unit><ForexBuying>40</ForexBuying><ForexSelling>40.1</ForexSelling></Currency></Tarih_Date>`;
  /** 13.10 ve 15.10 bültenleri (1 USD = 40,05 TRY); diğer günler 404. */
  const ok: FxFetcher = async (url) => {
    if (url === tcmbUrl('2026-10-13')) return { status: 200, text: bulletin('13.10.2026') };
    if (url === tcmbUrl('2026-10-15')) return { status: 200, text: bulletin('15.10.2026') };
    return { status: 404, text: '' };
  };
  const down: FxFetcher = async () => {
    throw new Error('ECONNREFUSED');
  };
  beforeAll(async () => {
    app = await getApp();
  });
  afterAll(() => {
    setFxService(null);
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /** TRY firma, USD tarife (10 kg = 100 USD), ölçülmüş bir gönderi. */
  async function usdSetup() {
    const admin = await registerCompany(app);
    const carrier = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: admin.auth, payload: { code: 'fedex', name: 'FedEx USD' } });
    expect(carrier.statusCode, carrier.body).toBe(201);
    const carrierId = carrier.json().carrier.id as string;
    const tariff = await app.inject({
      method: 'POST',
      url: '/api/deciship/tariffs',
      headers: admin.auth,
      payload: {
        carrierId,
        name: 'USD tarife',
        currency: 'USD',
        divisor: 3000,
        edgeRounding: 'CEIL_CM',
        weightSteps: [{ upto: null, step: 1 }],
        discountPct: 0,
        fuelPct: 0,
        // Bu testler kur kuralını dener: yakıt sabit. Değişken yakıtta (fedex varsayılanı) yakıt sütunu olmayan satırın
        // fiyat farkı "İncele" olur (DENETIM-2 B2); kesin/tahmini beklentileri o zaman yakıt kuralı belirlerdi.
        fuelVariable: false,
        active: true,
        isDefault: true,
        zones: [{ country: '*', zone: 'A' }],
        rates: Array.from({ length: 30 }, (_, i) => ({ zone: 'A', weightUpto: i + 1, price: (i + 1) * 10 })),
        overflow: [],
        surcharges: [],
      },
    });
    expect(tariff.statusCode, tariff.body).toBe(201);
    const p = measurementPayload({ trackingRaw: uniq('7948') });
    const m = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...admin.auth, ...p.headers }, payload: p.payload });
    expect(m.statusCode, m.body).toBe(201);
    return { auth: admin.auth, carrierId, tracking: m.json().measurement.trackingNo as string };
  }

  /** 1 USD fazla faturalanmış USD satır (5 TL ≈ 0,12 USD toleransın üstünde). */
  async function importOver(auth: Auth, carrierId: string, tracking: string) {
    const csv = ['Takip No;Tarih;Desi;Tutar', `${tracking};15.10.2026;10;101`].join('\n');
    const form = multipart([
      { name: 'carrierId', value: carrierId },
      { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
    ]);
    const p = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
    expect(p.statusCode, p.body).toBe(200);
    const res = await app.inject({
      method: 'POST',
      url: '/api/deciship/invoices',
      headers: auth,
      payload: { fileId: p.json().fileId, carrierId, invoiceNo: uniq('USD-'), invoiceDate: '2026-10-15', currency: 'USD', mapping: p.json().suggestedMapping, acknowledgeIssues: true },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().invoice.id as string;
  }
  async function lineOf(auth: Auth, invoiceId: string) {
    const l = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${invoiceId}/lines`, headers: auth });
    expect(l.statusCode, l.body).toBe(200);
    return (l.json().items as { id: string; status: string; diffTypes: string[]; diffAmount: number | null; note: string | null }[])[0]!;
  }
  const totalsOf = async (auth: Auth, invoiceId: string) => (await app.inject({ method: 'GET', url: `/api/deciship/invoices/${invoiceId}`, headers: auth })).json().invoice.totals;

  it('TCMB kapalı, saklı kur yok: satır "Kur alınamadı (TRY→USD, …)", fazla ödemeye girmez; Yeniden karşılaştır taze kurla fark bulur', async () => {
    const s = await usdSetup();
    setFxService(new FxService({ fetcher: down, cacheDir: tmpCache(), backoffMs: [0], now: NOW, retryAfterMs: 600_000 }));
    const id = await importOver(s.auth, s.carrierId, s.tracking);
    expect(await lineOf(s.auth, id)).toMatchObject({ status: 'NO_TARIFF', diffTypes: [], diffAmount: null, note: 'Kur alınamadı (TRY→USD, 15.10.2026) — TCMB yanıt vermedi' });
    expect(await totalsOf(s.auth, id)).toMatchObject({ fxMissing: 1, overchargeTotal: 0, diff: 0, noTariff: 1 });

    setFxService(new FxService({ fetcher: ok, cacheDir: tmpCache(), now: NOW }));
    const rc = await app.inject({ method: 'POST', url: `/api/deciship/invoices/${id}/recompare`, headers: s.auth });
    expect(rc.statusCode, rc.body).toBe(200);
    expect(await lineOf(s.auth, id)).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], diffAmount: 1 });
    expect(await totalsOf(s.auth, id)).toMatchObject({ fxMissing: 0, overchargeTotal: 1 });
  });

  // İnceleme (kullanıcı adına verilen karar): bayat kurlu satır "İncele" (LOW) olur; kesin fazla ödemeye girmez, tahmini
  // kovada durur, toplamda `fxStale` sayılır. Taze kurla Yeniden karşılaştır kesinleştirir ve işareti kaldırır.
  it('TCMB kapalı, 2 gün önceki kur saklı: o kurla hesaplanır, notta tarihi yazar, "İncele" olur ve fazla ödemeye girmez', async () => {
    const s = await usdSetup();
    const cacheDir = tmpCache();
    await new FxService({ fetcher: ok, cacheDir, now: NOW }).getRate('TRY', 'USD', '2026-10-13');
    setFxService(new FxService({ fetcher: down, cacheDir, backoffMs: [0], now: NOW, retryAfterMs: 600_000 }));
    const id = await importOver(s.auth, s.carrierId, s.tracking);
    const line = await lineOf(s.auth, id);
    expect(line).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], diffAmount: 1, note: 'Kur 13.10.2026 tarihli (TCMB yanıt vermedi, saklı son kur kullanıldı)' });
    const row = await inCompany(s.auth, () => prisma.invoiceLine.findFirstOrThrow({ where: { id: line.id }, select: { pricing: true } }));
    expect(row.pricing).toMatchObject({ fxStale: '2026-10-13', confidence: 'LOW', reviewCode: 'FX_STALE' });
    expect(await totalsOf(s.auth, id)).toMatchObject({ fxMissing: 0, fxStale: 1, overchargeTotal: 0, estimatedOverchargeTotal: 1, estimatedLines: 1 });

    setFxService(new FxService({ fetcher: ok, cacheDir: tmpCache(), now: NOW }));
    const rc = await app.inject({ method: 'POST', url: `/api/deciship/invoices/${id}/recompare`, headers: s.auth });
    expect(rc.statusCode, rc.body).toBe(200);
    const fresh = await lineOf(s.auth, id);
    expect(fresh).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], diffAmount: 1 });
    expect(fresh.note ?? '').not.toContain('tarihli');
    const totals = await totalsOf(s.auth, id);
    expect(totals).toMatchObject({ fxMissing: 0, overchargeTotal: 1, estimatedOverchargeTotal: 0 });
    expect(totals.fxStale).toBeUndefined();
  });

  const accept = async (auth: Auth, lineId: string) => {
    const r = await app.inject({ method: 'PATCH', url: `/api/deciship/invoice-lines/${lineId}`, headers: auth, payload: { decision: 'ACCEPTED', reason: 'anlaşma' } });
    expect(r.statusCode, r.body).toBe(200);
  };
  const lineRow = (auth: Auth, id: string) =>
    inCompany(auth, () => prisma.invoiceLine.findFirstOrThrow({ where: { id }, select: { status: true, diffAmount: true, decision: true, recalcPending: true, note: true, pricing: true } }));

  it('inceleme: kararı verilmiş satır, yalnız tolerans kuru alınamadı diye "yeniden hesap bekliyor" işareti almaz', async () => {
    const s = await usdSetup();
    setFxService(new FxService({ fetcher: ok, cacheDir: tmpCache(), now: NOW }));
    const id = await importOver(s.auth, s.carrierId, s.tracking);
    const line = await lineOf(s.auth, id);
    expect(line).toMatchObject({ status: 'DIFF', diffAmount: 1 });
    await accept(s.auth, line.id);
    setFxService(new FxService({ fetcher: down, cacheDir: tmpCache(), backoffMs: [0], now: NOW, retryAfterMs: 600_000 }));
    const rc = await app.inject({ method: 'POST', url: `/api/deciship/invoices/${id}/recompare`, headers: s.auth });
    expect(rc.statusCode, rc.body).toBe(200);
    expect(await lineRow(s.auth, line.id)).toMatchObject({ status: 'DIFF', decision: 'ACCEPTED', recalcPending: null });
  });

  it('inceleme: kararı verilmiş bayat kurlu satırda taze kur aynı rakamı verince bayat not ve işaret kalkar, karar kalır', async () => {
    const s = await usdSetup();
    const cacheDir = tmpCache();
    await new FxService({ fetcher: ok, cacheDir, now: NOW }).getRate('TRY', 'USD', '2026-10-13');
    setFxService(new FxService({ fetcher: down, cacheDir, backoffMs: [0], now: NOW, retryAfterMs: 600_000 }));
    const id = await importOver(s.auth, s.carrierId, s.tracking);
    const line = await lineOf(s.auth, id);
    expect(line.note).toContain('tarihli');
    await accept(s.auth, line.id);
    setFxService(new FxService({ fetcher: ok, cacheDir: tmpCache(), now: NOW }));
    const rc = await app.inject({ method: 'POST', url: `/api/deciship/invoices/${id}/recompare`, headers: s.auth });
    expect(rc.statusCode, rc.body).toBe(200);
    const row = await lineRow(s.auth, line.id);
    expect(row).toMatchObject({ status: 'DIFF', decision: 'ACCEPTED', recalcPending: null });
    expect(Number(row.diffAmount)).toBe(1);
    expect(row.note ?? '').not.toContain('tarihli');
    expect(row.pricing).toMatchObject({ confidence: 'HIGH' });
    expect((row.pricing as { fxStale?: string }).fxStale).toBeUndefined();
    expect((await totalsOf(s.auth, id)).fxStale).toBeUndefined();
  });
});
