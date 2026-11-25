/**
 * FedEx Pak / Zarf (ambalaj türü), veritabanlı: göç sonrası varsayılanlar, ölçümün ambalajı (oluştur, düzelt, eski mobil
 * gövdesi), fatura satırının ambalajı, tarifenin Pak / Zarf satırları ve indirimleri, sürüm özetinin değişmezliği, Pak ölçüm +
 * kendi ambalajıyla faturalanan satırda PACKAGING farkı ve itiraz tutarı, ambalaj düzeltilince yeniden karşılaştırma.
 * Veritabanısız özet ve içe aktarma kuralları `tariffPackaging.test.ts`'te.
 */
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, Prisma } from '../src/db.ts';
import { createWorker, getApp, inCompany, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';

const API = '/api/deciship';
type Auth = { authorization: string };

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

/** Yalnız rakam: normalleştirme numarayı değiştirmez. */
const trackingNo = () => `7948${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;

/**
 * Basit FedEx tarifesi (TRY, indirim ve yakıt yok, tek bölge, 0,5 kg basamak). Kendi ambalajı 0,5–10 kg; Pak 0,5–2,5 kg;
 * Zarf 0,5 kg. 1,2 kg'lık gönderi: kendi ambalajında 1,5 kg → 200, Pak'ta 1,5 kg → 80.
 */
function fedexTariff(carrierId: string, over: Record<string, unknown> = {}) {
  const own = Array.from({ length: 20 }, (_, i) => ({ zone: 'A', weightUpto: (i + 1) / 2, price: 100 + i * 50 }));
  const pak = [0.5, 1, 1.5, 2, 2.5].map((w, i) => ({ zone: 'A', weightUpto: w, price: 60 + i * 10, packaging: 'PAK' }));
  return {
    carrierId,
    name: uniq('FedEx Pak '),
    currency: 'TRY',
    divisor: 5000,
    edgeRounding: 'CEIL_CM',
    weightSteps: [{ upto: null, step: 0.5 }],
    discountPct: 0,
    fuelPct: 0,
    fuelVariable: false,
    active: true,
    isDefault: true,
    zones: [{ country: '*', zone: 'A' }],
    rates: [...own, ...pak, { zone: 'A', weightUpto: 0.5, price: 40, packaging: 'ENVELOPE' }],
    overflow: [],
    surcharges: [],
    ...over,
  };
}

async function fedexFirm() {
  const admin = await registerCompany(app, uniq('Pak '));
  const worker = await createWorker(app, admin.auth);
  const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'fedex', name: uniq('FedEx ') } });
  expect(c.statusCode, c.body).toBe(201);
  const carrierId = c.json().carrier.id as string;
  const t = await app.inject({ method: 'POST', url: `${API}/tariffs`, headers: admin.auth, payload: fedexTariff(carrierId) });
  expect(t.statusCode, t.body).toBe(201);
  return { admin, worker, carrierId, tariffId: t.json().tariff.id as string };
}

async function measure(auth: Auth, over: Record<string, unknown>) {
  const p = measurementPayload(over);
  const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...auth, ...p.headers }, payload: p.payload });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().measurement as { id: string; trackingNo: string; packaging: string; version: number };
}

/** FedEx kalıbında ambalaj sütunlu fatura: her satır `[takip no, gerçek kg, ücretli kg, ambalaj, tutar]`. */
async function packagingInvoice(auth: Auth, carrierId: string, rows: [string, number, number, string, number][]) {
  const csv = ['Takip No;Gerçek Ağırlık;Ücretli Ağırlık;Paketleme;Tutar', ...rows.map((r) => r.map((v) => String(v).replace('.', ',')).join(';'))].join('\n');
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
  ]);
  const preview = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...auth, ...form.headers }, payload: form.payload });
  expect(preview.statusCode, preview.body).toBe(200);
  const inv = await app.inject({
    method: 'POST',
    url: `${API}/invoices`,
    headers: auth,
    payload: {
      fileId: preview.json().fileId,
      carrierId,
      invoiceNo: uniq('F'),
      invoiceDate: new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10),
      currency: 'TRY',
      mapping: { trackingNo: 'Takip No', actualKg: 'Gerçek Ağırlık', billedKg: 'Ücretli Ağırlık', packaging: 'Paketleme', netAmount: 'Tutar' },
      acknowledgeIssues: true,
    },
  });
  expect(inv.statusCode, inv.body).toBe(201);
  return inv.json().invoice.id as string;
}

type Line = {
  id: string;
  trackingNo: string;
  status: string;
  diffTypes: string[];
  expectedAmount: number | null;
  diffAmount: number | null;
  netAmount: number;
  confidence: string;
  packaging: string | null;
  measurement: { id: string; packaging: string } | null;
};

async function lineOf(auth: Auth, invoiceId: string, tracking: string): Promise<Line> {
  const r = await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/lines?pageSize=100`, headers: auth });
  expect(r.statusCode, r.body).toBe(200);
  const line = (r.json().items as Line[]).find((l) => l.trackingNo === tracking);
  expect(line, tracking).toBeDefined();
  return line!;
}

describe('ölçümün ambalajı', () => {
  it('eski mobil gövdesi (alan yok) kendi ambalajı; Pak / Zarf kaydedilir, okumada döner; geçersiz değer 400', async () => {
    const f = await fedexFirm();
    const old = await measure(f.worker.auth, {});
    expect(old.packaging).toBe('OWN');
    const pak = await measure(f.worker.auth, { packaging: 'PAK' });
    expect(pak.packaging).toBe('PAK');
    const env = await measure(f.worker.auth, { packaging: 'ENVELOPE', weightKg: 0.3, lengthCm: 30, widthCm: 20, heightCm: 1 });
    expect(env.packaging).toBe('ENVELOPE');

    const one = await app.inject({ method: 'GET', url: `${API}/measurements/${pak.id}`, headers: f.worker.auth });
    expect(one.json().measurement.packaging).toBe('PAK');
    const list = await app.inject({ method: 'GET', url: `${API}/measurements?pageSize=50`, headers: f.admin.auth });
    const byId = new Map((list.json().items as { id: string; packaging: string }[]).map((m) => [m.id, m.packaging]));
    expect([byId.get(old.id), byId.get(pak.id), byId.get(env.id)]).toEqual(['OWN', 'PAK', 'ENVELOPE']);
    const check = await app.inject({ method: 'GET', url: `${API}/measurements/check?tracking=${pak.trackingNo}`, headers: f.worker.auth });
    expect(check.json().last.packaging).toBe('PAK');

    const p = measurementPayload({ packaging: 'BOX' });
    const bad = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...f.worker.auth, ...p.headers }, payload: p.payload });
    expect(bad.statusCode).toBe(400);
  });

  it('ambalaj düzeltmesi yeni sürüm açar, öbür alanlar korunur; aynı ambalajı yeniden göndermek sürüm açmaz', async () => {
    const f = await fedexFirm();
    const m = await measure(f.worker.auth, { lengthCm: 30, widthCm: 20, heightCm: 5, weightKg: 1.2 });
    const same = await app.inject({ method: 'PATCH', url: `${API}/measurements/${m.id}`, headers: f.worker.auth, payload: { packaging: 'OWN' } });
    expect(same.statusCode, same.body).toBe(200);
    expect(same.json().measurement).toMatchObject({ id: m.id, version: 1, packaging: 'OWN' });

    const r = await app.inject({ method: 'PATCH', url: `${API}/measurements/${m.id}`, headers: f.worker.auth, payload: { packaging: 'PAK' } });
    expect(r.statusCode, r.body).toBe(200);
    const next = r.json().measurement;
    expect(next.id).not.toBe(m.id);
    expect(next).toMatchObject({ version: 2, packaging: 'PAK', lengthCm: 30, widthCm: 20, heightCm: 5, weightKg: 1.2, dimMethod: 'MANUAL' });
    expect(next.history.map((h: { packaging: string }) => h.packaging)).toEqual(['OWN']);

    // ölçü düzeltmesi ambalajı korur
    const dims = await app.inject({ method: 'PATCH', url: `${API}/measurements/${next.id}`, headers: f.worker.auth, payload: { heightCm: 6 } });
    expect(dims.json().measurement).toMatchObject({ version: 3, packaging: 'PAK', heightCm: 6 });
  });

  it('göç sonrası varsayılanlar: sütunu yazılmamış ölçüm kendi ambalajı, fatura satırı boş, tarife satırı kendi ambalajı', async () => {
    const f = await fedexFirm();
    const m = await measure(f.worker.auth, {});
    const row = await inCompany(f.admin.auth, () =>
      prisma.$queryRaw<{ m: string; r: string; d: string | null }[]>`
        SELECT
          (SELECT column_default FROM information_schema.columns WHERE table_schema = 'deciship' AND table_name = 'Measurement' AND column_name = 'packaging') AS m,
          (SELECT column_default FROM information_schema.columns WHERE table_schema = 'deciship' AND table_name = 'TariffRate' AND column_name = 'packaging') AS r,
          (SELECT column_default FROM information_schema.columns WHERE table_schema = 'deciship' AND table_name = 'InvoiceLine' AND column_name = 'packaging') AS d`,
    );
    expect(row[0]!.m).toContain('OWN');
    expect(row[0]!.r).toContain('OWN');
    expect(row[0]!.d).toBeNull();
    const stored = await inCompany(f.admin.auth, () => prisma.measurement.findFirstOrThrow({ where: { id: m.id }, select: { packaging: true } }));
    expect(stored.packaging).toBe('OWN');
    const t = await inCompany(f.admin.auth, () => prisma.tariff.findFirstOrThrow({ where: { id: f.tariffId }, select: { pakDiscountPct: true, envelopeDiscountPct: true } }));
    expect(t).toEqual({ pakDiscountPct: null, envelopeDiscountPct: null });
  });
});

describe('tarifenin Pak / Zarf fiyatları', () => {
  it('kayıt, okuma ve güncelleme: satır ambalajı ve iki indirim; alanı göndermeyen düzenleme indirimi silmez', async () => {
    const f = await fedexFirm();
    const get = async () => (await app.inject({ method: 'GET', url: `${API}/tariffs/${f.tariffId}`, headers: f.admin.auth })).json().tariff;
    const t0 = await get();
    expect(t0.pakDiscountPct).toBeNull();
    expect(t0.envelopeDiscountPct).toBeNull();
    expect(t0.rates.filter((r: { packaging: string }) => r.packaging === 'PAK')).toHaveLength(5);
    expect(t0.rates.filter((r: { packaging: string }) => r.packaging === 'ENVELOPE')).toEqual([{ zone: 'A', weightUpto: 0.5, price: 40, perKg: false, packaging: 'ENVELOPE' }]);
    // kendi ambalaj satırları önce
    expect(t0.rates[0].packaging).toBe('OWN');

    const put = await app.inject({ method: 'PUT', url: `${API}/tariffs/${f.tariffId}`, headers: f.admin.auth, payload: fedexTariff(f.carrierId, { name: t0.name, pakDiscountPct: 12.5, envelopeDiscountPct: 5 }) });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().tariff).toMatchObject({ pakDiscountPct: 12.5, envelopeDiscountPct: 5 });
    const keep = await app.inject({ method: 'PUT', url: `${API}/tariffs/${f.tariffId}`, headers: f.admin.auth, payload: fedexTariff(f.carrierId, { name: t0.name }) });
    expect(keep.json().tariff).toMatchObject({ pakDiscountPct: 12.5, envelopeDiscountPct: 5 });
    const clear = await app.inject({ method: 'PUT', url: `${API}/tariffs/${f.tariffId}`, headers: f.admin.auth, payload: fedexTariff(f.carrierId, { name: t0.name, pakDiscountPct: null }) });
    expect(clear.json().tariff).toMatchObject({ pakDiscountPct: null, envelopeDiscountPct: 5 });

    // aynı bölge + ağırlıkta aynı ambalajda iki fiyat 400; Pak ile kendi ambalajı yan yana olur (yukarıda)
    const dup = fedexTariff(f.carrierId);
    const bad = await app.inject({ method: 'PUT', url: `${API}/tariffs/${f.tariffId}`, headers: f.admin.auth, payload: { ...dup, rates: [...dup.rates, { zone: 'A', weightUpto: 1, price: 1, packaging: 'PAK' }] } });
    expect(bad.statusCode).toBe(400);
  });

  it('sürüm özeti: kendi ambalaj satırlı tarifede açık OWN ve boş indirim yeni sürüm açmaz; Pak satırı ve indirim açar', async () => {
    const f = await fedexFirm();
    const ownOnly = (over: Record<string, unknown> = {}) => {
      const b = fedexTariff(f.carrierId, { name: 'Koli', isDefault: false, ...over });
      return { ...b, rates: b.rates.filter((r) => !('packaging' in r)) };
    };
    const created = await app.inject({ method: 'POST', url: `${API}/tariffs`, headers: f.admin.auth, payload: ownOnly() });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().tariff.id as string;
    const rev = () => inCompany(f.admin.auth, () => prisma.tariff.findFirstOrThrow({ where: { id }, select: { currentRevisionId: true, currentRevision: { select: { contentHash: true } } } }));
    const r0 = await rev();

    // bugünkü istemcinin gövdesi: her satırda packaging 'OWN', indirimler null
    const explicit = ownOnly({ pakDiscountPct: null, envelopeDiscountPct: null });
    const same = await app.inject({ method: 'PUT', url: `${API}/tariffs/${id}`, headers: f.admin.auth, payload: { ...explicit, rates: explicit.rates.map((r) => ({ ...r, packaging: 'OWN' })) } });
    expect(same.statusCode, same.body).toBe(200);
    expect(await rev()).toEqual(r0);

    // ambalaj öncesi yazılmış sürüm (anlık görüntüde alan yok): özet bugünkü kuralla aynı, sürüm açılmaz
    await inCompany(f.admin.auth, async () => {
      const r = await prisma.tariffRevision.findFirstOrThrow({ where: { id: r0.currentRevisionId! }, select: { snapshot: true } });
      const s = r.snapshot as { rates: Record<string, unknown>[]; pakDiscountPct?: unknown; envelopeDiscountPct?: unknown };
      const { pakDiscountPct: _p, envelopeDiscountPct: _e, ...rest } = s;
      const legacy = { ...rest, rates: s.rates.map(({ packaging: _x, ...row }) => row) };
      await prisma.tariffRevision.updateMany({ where: { id: r0.currentRevisionId! }, data: { snapshot: legacy as Prisma.InputJsonValue, contentHash: null } });
    });
    const again = await app.inject({ method: 'PUT', url: `${API}/tariffs/${id}`, headers: f.admin.auth, payload: ownOnly() });
    expect(again.statusCode, again.body).toBe(200);
    expect(await rev()).toEqual(r0);

    const withPak = await app.inject({ method: 'PUT', url: `${API}/tariffs/${id}`, headers: f.admin.auth, payload: fedexTariff(f.carrierId, { name: 'Koli', isDefault: false }) });
    expect(withPak.statusCode, withPak.body).toBe(200);
    const r1 = await rev();
    expect(r1.currentRevisionId).not.toBe(r0.currentRevisionId);
    const disc = await app.inject({ method: 'PUT', url: `${API}/tariffs/${id}`, headers: f.admin.auth, payload: fedexTariff(f.carrierId, { name: 'Koli', isDefault: false, pakDiscountPct: 10 }) });
    expect(disc.statusCode, disc.body).toBe(200);
    expect((await rev()).currentRevisionId).not.toBe(r1.currentRevisionId);
  });
});

describe('fatura satırının ambalajı ve PACKAGING farkı', () => {
  it('satır faturadaki ambalajı ve eşleşen ölçümün ambalajını taşır; Pak ölçüm + kendi ambalajıyla faturalanan satır kesin fark, beklenen Pak fiyatı', async () => {
    const f = await fedexFirm();
    const pak = await measure(f.worker.auth, { trackingRaw: trackingNo(), lengthCm: 30, widthCm: 20, heightCm: 5, weightKg: 1.2, packaging: 'PAK' });
    const own = await measure(f.worker.auth, { trackingRaw: trackingNo(), lengthCm: 30, widthCm: 20, heightCm: 5, weightKg: 1.2 });
    const billedPak = await measure(f.worker.auth, { trackingRaw: trackingNo(), lengthCm: 30, widthCm: 20, heightCm: 5, weightKg: 1.2, packaging: 'PAK' });
    const invoiceId = await packagingInvoice(f.admin.auth, f.carrierId, [
      [pak.trackingNo, 1.2, 1.5, 'Your Packaging', 200],
      [own.trackingNo, 1.2, 1.5, 'Your Packaging', 200],
      [billedPak.trackingNo, 1.2, 1.5, 'FedEx Pak', 80],
    ]);

    const a = await lineOf(f.admin.auth, invoiceId, pak.trackingNo);
    expect(a).toMatchObject({ packaging: 'OWN', measurement: { id: pak.id, packaging: 'PAK' }, status: 'DIFF', expectedAmount: 80, diffAmount: 120, confidence: 'HIGH' });
    expect(a.diffTypes).toContain('PACKAGING');

    const b = await lineOf(f.admin.auth, invoiceId, own.trackingNo);
    expect(b).toMatchObject({ packaging: 'OWN', measurement: { packaging: 'OWN' }, status: 'MATCH', expectedAmount: 200 });
    const c = await lineOf(f.admin.auth, invoiceId, billedPak.trackingNo);
    expect(c).toMatchObject({ packaging: 'PAK', measurement: { packaging: 'PAK' }, status: 'MATCH', expectedAmount: 80 });

    // süzgeç: fark türü PACKAGING
    const filtered = await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/lines?diffType=PACKAGING`, headers: f.admin.auth });
    expect(filtered.statusCode, filtered.body).toBe(200);
    expect(filtered.json().items.map((l: Line) => l.trackingNo)).toEqual([pak.trackingNo]);

    // itiraz: satır listeye alınınca talep tutarı farkın kendisi (kuruşu kuruşuna)
    const v = await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${a.id}`, headers: f.admin.auth, payload: { decision: 'VERIFIED' } });
    expect(v.statusCode, v.body).toBe(200);
    const text = await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/dispute`, headers: f.admin.auth });
    expect(text.statusCode, text.body).toBe(200);
    expect(text.json()).toMatchObject({ lineCount: 1, total: 120 });
    const detail = await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}`, headers: f.admin.auth });
    expect(detail.json().invoice.dispute).toMatchObject({ sendableLineCount: 1, sendableAmount: 120 });
    const zip = await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/dispute/evidence.zip`, headers: f.admin.auth });
    expect(zip.statusCode, zip.body.slice(0, 300)).toBe(200);
  });

  it('ambalaj düzeltilince satır yeniden karşılaştırılır: kendi ambalajı → Pak olunca PACKAGING farkı, geri alınınca uyumlu', async () => {
    const f = await fedexFirm();
    const m = await measure(f.worker.auth, { trackingRaw: trackingNo(), lengthCm: 30, widthCm: 20, heightCm: 5, weightKg: 1.2 });
    const invoiceId = await packagingInvoice(f.admin.auth, f.carrierId, [[m.trackingNo, 1.2, 1.5, 'Your Packaging', 200]]);
    expect(await lineOf(f.admin.auth, invoiceId, m.trackingNo)).toMatchObject({ status: 'MATCH', expectedAmount: 200 });

    const r = await app.inject({ method: 'PATCH', url: `${API}/measurements/${m.id}`, headers: f.worker.auth, payload: { packaging: 'PAK' } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().measurement.recomparePending).toBe(false);
    const pakId = r.json().measurement.id as string;
    const after = await lineOf(f.admin.auth, invoiceId, m.trackingNo);
    expect(after).toMatchObject({ status: 'DIFF', expectedAmount: 80, diffAmount: 120, measurement: { id: pakId, packaging: 'PAK' } });
    expect(after.diffTypes).toContain('PACKAGING');

    const back = await app.inject({ method: 'PATCH', url: `${API}/measurements/${pakId}`, headers: f.worker.auth, payload: { packaging: 'OWN' } });
    expect(back.statusCode, back.body).toBe(200);
    expect(await lineOf(f.admin.auth, invoiceId, m.trackingNo)).toMatchObject({ status: 'MATCH', expectedAmount: 200, measurement: { packaging: 'OWN' } });
  });

  it('tarifede Pak fiyatı yoksa Pak satırı eskisi gibi kapsam dışı sayılır', async () => {
    const f = await fedexFirm();
    const b = fedexTariff(f.carrierId);
    const put = await app.inject({ method: 'PUT', url: `${API}/tariffs/${f.tariffId}`, headers: f.admin.auth, payload: { ...b, rates: b.rates.filter((r) => !('packaging' in r)) } });
    expect(put.statusCode, put.body).toBe(200);
    const m = await measure(f.worker.auth, { trackingRaw: trackingNo(), lengthCm: 30, widthCm: 20, heightCm: 5, weightKg: 1.2, packaging: 'PAK' });
    const invoiceId = await packagingInvoice(f.admin.auth, f.carrierId, [[m.trackingNo, 1.2, 1.5, 'FedEx Pak', 80]]);
    const line = await lineOf(f.admin.auth, invoiceId, m.trackingNo);
    expect(line.status).not.toBe('DIFF');
    expect(line.expectedAmount).toBeNull();
    const inv = await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}`, headers: f.admin.auth });
    const totals = inv.json().invoice.totals as { pakUnmatched: number; pakNoTariff: number };
    expect(totals.pakUnmatched + totals.pakNoTariff).toBe(1);
  });
});

describe('taşıyıcının poşet / zarf sınırları', () => {
  it('okuma: ayar yok, etkin sınır taşıyıcı kodunun varsayılanı; güncelleme ayarı yazar, null varsayılana döner, geçersiz biçim 400', async () => {
    const f = await fedexFirm();
    const list = await app.inject({ method: 'GET', url: `${API}/carriers`, headers: f.admin.auth });
    const c0 = (list.json().items as { id: string; packagingLimits: unknown; effectivePackagingLimits: { PAK?: { maxKg: number } | null } }[]).find((c) => c.id === f.carrierId)!;
    expect(c0.packagingLimits).toBeNull();
    expect(c0.effectivePackagingLimits.PAK?.maxKg).toBe(2.5);

    const patch = (packagingLimits: unknown) => app.inject({ method: 'PATCH', url: `${API}/carriers/${f.carrierId}`, headers: f.admin.auth, payload: { packagingLimits } });
    const set = await patch({ PAK: { maxKg: 3, maxVolumeCm3: 20000 } });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().carrier.packagingLimits).toEqual({ PAK: { maxKg: 3, maxVolumeCm3: 20000 } });
    expect(set.json().carrier.effectivePackagingLimits.PAK).toMatchObject({ maxKg: 3 });

    // zarfın kenar sınırı: üç pozitif sayı ya da null
    const edges = await patch({ ENVELOPE: { maxKg: 0.5, maxEdgesCm: [40, 30, 2] } });
    expect(edges.statusCode, edges.body).toBe(200);
    expect(edges.json().carrier.packagingLimits).toEqual({ ENVELOPE: { maxKg: 0.5, maxEdgesCm: [40, 30, 2] } });
    expect(edges.json().carrier.effectivePackagingLimits.ENVELOPE).toMatchObject({ maxKg: 0.5, maxEdgesCm: [40, 30, 2] });
    expect((await patch({ ENVELOPE: { maxKg: 0.5, maxEdgesCm: null } })).statusCode).toBe(200);

    for (const bad of [
      { PAK: { maxKg: -1 } },
      { PAK: { maxKg: 1 }, BOX: {} },
      { ENVELOPE: { maxKg: 'a' } },
      { ENVELOPE: { maxKg: 0.5, maxEdgesCm: [40, 30] } },
      { ENVELOPE: { maxKg: 0.5, maxEdgesCm: [40, 30, 0] } },
      { ENVELOPE: { maxKg: 0.5, maxEdgesCm: [40, 30, 2, 1] } },
      { ENVELOPE: { maxKg: 0.5, maxEdgesCm: '40x30x2' } },
    ]) {
      const r = await patch(bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    const reset = await patch(null);
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json().carrier.packagingLimits).toBeNull();
    expect(reset.json().carrier.effectivePackagingLimits.PAK?.maxKg).toBe(2.5);
  });

  it('karşılaştırma faturanın taşıyıcısının sınırını kullanır: poşet sınırı düşürülünce yeniden karşılaştırmada fark kalkar', async () => {
    const f = await fedexFirm();
    const m = await measure(f.worker.auth, { trackingRaw: trackingNo(), lengthCm: 30, widthCm: 20, heightCm: 5, weightKg: 1.2, packaging: 'PAK' });
    const invoiceId = await packagingInvoice(f.admin.auth, f.carrierId, [[m.trackingNo, 1.2, 1.5, 'Your Packaging', 200]]);
    expect((await lineOf(f.admin.auth, invoiceId, m.trackingNo)).diffTypes).toContain('PACKAGING');

    // sınır değişince fatura kendiliğinden değişmez
    const set = await app.inject({ method: 'PATCH', url: `${API}/carriers/${f.carrierId}`, headers: f.admin.auth, payload: { packagingLimits: { PAK: { maxKg: 1 } } } });
    expect(set.statusCode, set.body).toBe(200);
    expect((await lineOf(f.admin.auth, invoiceId, m.trackingNo)).diffTypes).toContain('PACKAGING');

    const rc = await app.inject({ method: 'POST', url: `${API}/invoices/${invoiceId}/recompare`, headers: f.admin.auth });
    expect(rc.statusCode, rc.body).toBe(200);
    const after = await lineOf(f.admin.auth, invoiceId, m.trackingNo);
    expect(after.diffTypes).not.toContain('PACKAGING');
    expect(after).toMatchObject({ status: 'MATCH', expectedAmount: 200 });
  });

  it('ayar yanıtı mobil için etkin taşıyıcıların sınırlarını ve ana taşıyıcıyı taşır', async () => {
    const f = await fedexFirm();
    const get = async () => {
      const r = await app.inject({ method: 'GET', url: `${API}/settings`, headers: f.worker.auth });
      expect(r.statusCode, r.body).toBe(200);
      return r.json().packaging as { primaryCarrier: string | null; carriers: Record<string, { PAK?: { maxKg: number } | null }> };
    };
    const s0 = await get();
    expect(s0.primaryCarrier).toBe('fedex');
    expect(s0.carriers.fedex?.PAK?.maxKg).toBe(2.5);

    // varsayılan tarifesi olmayan ikinci taşıyıcı: ana taşıyıcı değişmez; pasif taşıyıcı listelenmez
    const ups = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: f.admin.auth, payload: { code: 'ups' } });
    expect(ups.statusCode, ups.body).toBe(201);
    const s1 = await get();
    expect(s1.primaryCarrier).toBe('fedex');
    expect(Object.keys(s1.carriers).sort()).toEqual(['fedex', 'ups']);
    await app.inject({ method: 'PATCH', url: `${API}/carriers/${f.carrierId}`, headers: f.admin.auth, payload: { active: false } });
    const s2 = await get();
    expect(Object.keys(s2.carriers)).toEqual(['ups']);
    // varsayılan tarifeli etkin taşıyıcı yok, tek etkin taşıyıcı var: o
    expect(s2.primaryCarrier).toBe('ups');
  });
});

describe('inceleme bulguları', () => {
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  /** Yalnız koli tablosu: kendi ambalajı fiyatları (fedexTariff ile aynı), isteğe bağlı İndirim % sütunu. */
  async function ownOnlyXlsx(discountPct?: number) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Fiyatlar');
    ws.addRow(['Ağırlık (kg/desi) ≤', 'A', ...(discountPct != null ? ['İndirim %'] : [])]);
    Array.from({ length: 20 }, (_, i) => ws.addRow([(i + 1) / 2, 100 + i * 50, ...(discountPct != null ? [discountPct] : [])]));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  async function importFile(auth: Auth, tariffId: string, data: Buffer) {
    const form = multipart([{ name: 'file', filename: 'koli.xlsx', contentType: XLSX_MIME, data }]);
    const pv = await app.inject({ method: 'POST', url: `${API}/tariffs/${tariffId}/import`, headers: { ...auth, ...form.headers }, payload: form.payload });
    expect(pv.statusCode, pv.body).toBe(200);
    return pv.json() as { draftId: string; checks: { code: string; severity: string }[] };
  }
  const apply = (auth: Auth, draftId: string) => app.inject({ method: 'POST', url: `${API}/tariff-imports/${draftId}/apply`, headers: auth, payload: { options: {}, acknowledged: true } });
  type Rate = { packaging: string; price: number; weightUpto: number };

  it('içe aktarma indirimi değiştirirse korunan Pak / Zarf fiyatlarının indirimi eski değerde sabitlenir; önizleme söyler', async () => {
    const f = await fedexFirm();
    const pv = await importFile(f.admin.auth, f.tariffId, await ownOnlyXlsx(35));
    expect(pv.checks.find((c) => c.code === 'PACKAGING_DISCOUNT_KEPT')).toMatchObject({ severity: 'info' });
    const ap = await apply(f.admin.auth, pv.draftId);
    expect(ap.statusCode, ap.body).toBe(200);
    const t = ap.json().tariff as { discountPct: number; pakDiscountPct: number | null; envelopeDiscountPct: number | null; rates: Rate[] };
    expect(t).toMatchObject({ discountPct: 35, pakDiscountPct: 0, envelopeDiscountPct: 0 });
    expect(t.rates.filter((r) => r.packaging === 'PAK').map((r) => r.price)).toEqual([60, 70, 80, 90, 100]);
    expect(t.rates.filter((r) => r.packaging === 'ENVELOPE').map((r) => r.price)).toEqual([40]);

    // beklenen Pak fiyatı içe aktarmadan sonra da aynı: 1,2 kg Pak ölçüm, kendi ambalajıyla faturalanmış → beklenen 80
    const m = await measure(f.worker.auth, { trackingRaw: trackingNo(), lengthCm: 30, widthCm: 20, heightCm: 5, weightKg: 1.2, packaging: 'PAK' });
    const invoiceId = await packagingInvoice(f.admin.auth, f.carrierId, [[m.trackingNo, 1.2, 1.5, 'Your Packaging', 130]]);
    expect(await lineOf(f.admin.auth, invoiceId, m.trackingNo)).toMatchObject({ expectedAmount: 80, diffAmount: 50 });
  });

  it('indirim değişmiyorsa Pak / Zarf indirimine dokunulmaz (sürüm özeti için boş kalır); fiyat kontrolü Pak fiyatını koli fiyatına karıştırmaz', async () => {
    const f = await fedexFirm();
    // her ağırlıkta çok ucuz Pak fiyatı: koli fiyatına karışsaydı "büyük fiyat değişimi" uyarısı çıkardı
    const b = fedexTariff(f.carrierId);
    const cheapPak = Array.from({ length: 20 }, (_, i) => ({ zone: 'A', weightUpto: (i + 1) / 2, price: 1, packaging: 'PAK' }));
    const put = await app.inject({ method: 'PUT', url: `${API}/tariffs/${f.tariffId}`, headers: f.admin.auth, payload: { ...b, rates: [...b.rates.filter((r) => !('packaging' in r)), ...cheapPak] } });
    expect(put.statusCode, put.body).toBe(200);
    const pv = (await importFile(f.admin.auth, f.tariffId, await ownOnlyXlsx())) as { draftId: string; checks: { code: string; severity: string }[]; comparison: { ratio: number }[] | null };
    expect(pv.checks.map((c) => c.code)).not.toContain('PACKAGING_DISCOUNT_KEPT');
    expect(pv.checks.map((c) => c.code)).not.toContain('BIG_CHANGE_VS_CURRENT');
    expect(pv.comparison?.map((c) => c.ratio)).toEqual([1]);
    const ap = await apply(f.admin.auth, pv.draftId);
    expect(ap.statusCode, ap.body).toBe(200);
    expect(ap.json().tariff).toMatchObject({ discountPct: 0, pakDiscountPct: null, envelopeDiscountPct: null });
  });

  it('eski mobil sürüm (ambalaj göndermez) yeniden ölçünce önceki güncel ölçümün ambalajı kalır; gönderilen ambalaj geçerli', async () => {
    const f = await fedexFirm();
    const no = trackingNo();
    const first = await measure(f.worker.auth, { trackingRaw: no, packaging: 'PAK' });
    const again = await measure(f.worker.auth, { trackingRaw: no });
    expect(again).toMatchObject({ version: 2, packaging: 'PAK' });
    expect(again.id).not.toBe(first.id);
    const own = await measure(f.worker.auth, { trackingRaw: no, packaging: 'OWN' });
    expect(own).toMatchObject({ version: 3, packaging: 'OWN' });
  });

  it('15 haneli FedEx Ground numarası, eskiden 22 haneli "96" barkoduyla kaydedilmiş ölçümü bulur (zincir ve denetim)', async () => {
    const f = await fedexFirm();
    const ground = `7${String(Math.floor(Math.random() * 1e14)).padStart(14, '0')}`;
    const legacy = `9612019${ground}`;
    expect(legacy).toHaveLength(22);
    const old = await measure(f.worker.auth, { trackingRaw: ground, packaging: 'PAK' });
    // extractTracking öncesi kayıt: takip no 22 haneli barkodun tamamı
    await inCompany(f.admin.auth, () => prisma.measurement.update({ where: { id: old.id }, data: { trackingNo: legacy, trackingRaw: legacy } }));

    const check = await app.inject({ method: 'GET', url: `${API}/measurements/check?tracking=${ground}`, headers: f.worker.auth });
    expect(check.statusCode, check.body).toBe(200);
    expect(check.json()).toMatchObject({ exists: true, last: { id: old.id } });
    // başka uzunlukta aynı sonla biten numara eski kayıt sayılmaz
    const other = await measure(f.worker.auth, { trackingRaw: `1${ground}` });
    expect(other.version).toBe(1);

    const next = await measure(f.worker.auth, { trackingRaw: ground });
    expect(next).toMatchObject({ version: 2, trackingNo: ground, packaging: 'PAK' });
    const stored = await inCompany(f.admin.auth, () => prisma.measurement.findFirstOrThrow({ where: { id: old.id }, select: { supersededById: true } }));
    expect(stored.supersededById).toBe(next.id);
  });
});
