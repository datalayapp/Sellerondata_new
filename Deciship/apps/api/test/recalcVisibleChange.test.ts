/**
 * Y32 (Mesaj 14): önce/sonra penceresinde "değişen satır" yalnız görünür değişiklik: durum, fark türleri ya da fazla
 * ödemeye katkı (en az 0,01). Tolerans içinde kalan uyumlu satırın küçük kayması sayılmaz ve listelenmez; satır yine
 * yazılır (yazma kuralı değişmez).
 */
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { getApp, createWorker, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';
import { applyRecalc, previewRecalc, recalculate, type RecalcPreview } from './recalcHelpers.ts';

const API = '/api/deciship';
type Auth = { authorization: string };

const trackingNo = () => `7948${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;

/** Desi başına `perKg` TL; yakıt ve ek ücret yok (recalculate.test.ts ile aynı). */
const tariffOf = (carrierId: string, perKg: number) => ({
  carrierId,
  name: 'Sabit',
  currency: 'TRY',
  divisor: 3000,
  edgeRounding: 'CEIL_CM',
  weightSteps: [{ upto: null, step: 1 }],
  discountPct: 0,
  fuelPct: 0,
  active: true,
  isDefault: true,
  zones: [{ country: '*', zone: 'TR' }],
  rates: Array.from({ length: 30 }, (_, i) => ({ zone: 'TR', weightUpto: i + 1, price: (i + 1) * perKg })),
  overflow: [],
  surcharges: [],
});

type Line = { id: string; status: string; diffTypes: string[]; expectedAmount: number | null; diffAmount: number | null };

async function lines(app: FastifyInstance, auth: Auth, invoiceId: string) {
  const r = await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/lines`, headers: auth });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().items as Line[];
}

describe('Y32: değişen satır sayımı', () => {
  it('tolerans içindeki uyumlu satırın kayması sayılmaz ve listelenmez; fark satırı sayılır; ikisi de yazılır', async () => {
    const app = await getApp();
    const admin = await registerCompany(app, uniq('Y32 '));
    const worker = await createWorker(app, admin.auth);
    const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'aras', name: uniq('Aras ') } });
    expect(c.statusCode, c.body).toBe(201);
    const carrierId = c.json().carrier.id as string;
    const t = await app.inject({ method: 'POST', url: `${API}/tariffs`, headers: admin.auth, payload: tariffOf(carrierId, 10) });
    expect(t.statusCode, t.body).toBe(201);
    const tariffId = t.json().tariff.id as string;

    // iki koli de 3 desi ölçülü: biri faturada 3 desi 31 TL (beklenen 30, fark 1: tolerans 5 içinde, uyumlu),
    // öbürü 5 desi 50 TL (beklenen 30, fark 20)
    const [tMatch, tDiff] = [trackingNo(), trackingNo()];
    for (const tr of [tMatch, tDiff]) {
      const p = measurementPayload({ trackingRaw: tr, lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
      const m = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...p.headers }, payload: p.payload });
      expect(m.statusCode, m.body).toBe(201);
    }
    const csv = ['Takip No;Desi;Tutar', `${tMatch};3;31`, `${tDiff};5;50`].join('\n');
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
    const id = inv.json().invoice.id as string;
    const [match0, diff0] = await lines(app, admin.auth, id);
    expect([match0!.status, diff0!.status]).toEqual(['MATCH', 'DIFF']);

    // tarife ucuzladı (9 TL/desi): uyumlu satırın farkı büyür ama toleransta kalır; fark satırının fazlası büyür
    const put = await app.inject({ method: 'PUT', url: `${API}/tariffs/${tariffId}`, headers: admin.auth, payload: tariffOf(carrierId, 9) });
    expect(put.statusCode, put.body).toBe(200);
    const done = await recalculate(app, admin.auth, id, { basis: 'tariff' });
    expect(done.preview.changedLines).toBe(1);
    expect(done.preview.lines.map((l) => l.id)).toEqual([diff0!.id]);

    // yazma kuralı aynı: iki satır da yeni tarifeyle yazıldı
    const [match1, diff1] = await lines(app, admin.auth, id);
    expect(match1!.status).toBe('MATCH');
    expect(match1!.diffAmount).not.toBe(match0!.diffAmount);
    expect(match1!.expectedAmount).not.toBe(match0!.expectedAmount);
    expect(diff1!.diffAmount).toBeGreaterThan(diff0!.diffAmount!);
  });

  it('görünür değişiklik yok ama yazılacak satır var: kararlı satırın ölçümü silinip aynı desiyle yeniden ölçüldü; önizleme writeLines ≥ 1, uygulanınca işaret silinir', async () => {
    const app = await getApp();
    const admin = await registerCompany(app, uniq('Y32b '));
    const worker = await createWorker(app, admin.auth);
    const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'aras', name: uniq('Aras ') } });
    expect(c.statusCode, c.body).toBe(201);
    const carrierId = c.json().carrier.id as string;
    const t = await app.inject({ method: 'POST', url: `${API}/tariffs`, headers: admin.auth, payload: tariffOf(carrierId, 10) });
    expect(t.statusCode, t.body).toBe(201);

    const tr = trackingNo();
    const measure = async () => {
      const p = measurementPayload({ trackingRaw: tr, lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
      const m = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...p.headers }, payload: p.payload });
      expect(m.statusCode, m.body).toBe(201);
      return m.json().measurement.id as string;
    };
    const m1 = await measure();
    const csv = ['Takip No;Desi;Tutar', `${tr};5;50`].join('\n');
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
    const id = inv.json().invoice.id as string;
    const lineOf = async () => {
      const r = await app.inject({ method: 'GET', url: `${API}/invoices/${id}/lines`, headers: admin.auth });
      expect(r.statusCode, r.body).toBe(200);
      return r.json().items[0] as Line & { measurementId: string | null; recalcPending: string | null; decision: string };
    };
    const l0 = await lineOf();
    expect([l0.status, l0.measurementId, l0.expectedAmount, l0.diffAmount]).toEqual(['DIFF', m1, 30, 20]);
    const v = await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${l0.id}`, headers: admin.auth, payload: { decision: 'VERIFIED' } });
    expect(v.statusCode, v.body).toBe(200);

    // Aynı takip no yeniden ölçülünce yeni ölçüm M1'in zincirine yeni sürüm olarak girer (POST /measurements
    // `promoteVersion`): rakam aynıysa "aynı ölçüm" sayılır, işaret konmaz (doğru). Zincir dışı ayrı ölçüm ancak eskisi
    // silindikten sonra doğar: M1 silinir (kararlı satır "eşleşmedi" sonucuyla işaretlenir, karar ve rakam yerinde),
    // sonra koli aynı desiyle yeniden ölçülür (M2 yeni zincir). Satır hâlâ M1'e bağlı ve işaretli; tutar değişmez.
    const del = await app.inject({ method: 'DELETE', url: `${API}/measurements/${m1}`, headers: admin.auth });
    expect(del.statusCode, del.body).toBe(204);
    expect((await lineOf()).recalcPending).toBe('MEASUREMENT');
    const m2 = await measure();
    expect(m2).not.toBe(m1);
    const l1 = await lineOf();
    expect([l1.decision, l1.recalcPending, l1.measurementId, l1.status, l1.expectedAmount]).toEqual(['VERIFIED', 'MEASUREMENT', m1, 'DIFF', 30]);

    // "Yeni ölçümle hesapla": görünür değişiklik yok (Y32 sayımı 0) ama yazılacak satır var
    const p = await previewRecalc(app, admin.auth, id, { basis: 'pinned', lineIds: [l1.id] });
    expect(p.statusCode, p.body).toBe(200);
    const pv = p.json() as RecalcPreview;
    expect(pv.changedLines).toBe(0);
    expect(pv.writeLines).toBeGreaterThanOrEqual(1);
    expect(pv.totals.after.overchargeTotal).toBe(pv.totals.before.overchargeTotal);

    // web bu durumda sormadan uygular: işaret silinir, satır yeni ölçüme bağlanır, karar korunur
    const a = await applyRecalc(app, admin.auth, id, { basis: 'pinned', lineIds: [l1.id], token: pv.token });
    expect(a.statusCode, a.body).toBe(200);
    const l2 = await lineOf();
    expect([l2.decision, l2.recalcPending, l2.measurementId, l2.expectedAmount, l2.diffAmount]).toEqual(['VERIFIED', null, m2, 30, 20]);
    expect(a.json().invoice.totals.pendingLines).toBe(0);
    // ikinci kez: yazılacak bir şey kalmadı (sessiz uygulama döngüye girmez)
    const again = (await previewRecalc(app, admin.auth, id, { basis: 'pinned', lineIds: [l1.id] })).json() as RecalcPreview;
    expect([again.changedLines, again.writeLines]).toEqual([0, 0]);
  });
});
