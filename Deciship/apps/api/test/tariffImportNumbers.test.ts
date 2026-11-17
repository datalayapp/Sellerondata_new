import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { getApp, multipart, registerCompany, uniq } from './helpers.ts';

/**
 * DENETIM-2 Mesaj 3, tarife tablosu yolu uçtan uca: indirim oranı şablon gidiş-dönüşü ve eski şablon (01-B12a), sayı
 * biçimi seçeneği (01-B6), lb tablosunun mevcut 0,5 kg basamaklı tarifeye yüklenmesi (01-B5).
 */

type Auth = { authorization: string };
type Check = { code: string; severity: string; title: string; detail?: string };
type Fix = { id: string; value?: string; label: string };
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let app: FastifyInstance;
let auth: Auth;

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: auth, payload: payload as object });
const get = (url: string) => app.inject({ method: 'GET', url, headers: auth });
const upload = (tariffId: string, filename: string, data: Buffer) => {
  const form = multipart([{ name: 'file', filename, contentType: filename.endsWith('.csv') ? 'text/csv' : XLSX_MIME, data }]);
  return app.inject({ method: 'POST', url: `/api/deciship/tariffs/${tariffId}/import`, headers: { ...auth, ...form.headers }, payload: form.payload });
};
const errors = (checks: Check[]) => checks.filter((c) => c.severity === 'error').map((c) => c.code);

async function carrier(code: string) {
  const r = await post('/api/deciship/carriers', { code, name: uniq(code) });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().carrier.id as string;
}

async function createTariff(body: Record<string, unknown>) {
  const r = await post('/api/deciship/tariffs', { divisor: 5000, overflow: [], surcharges: [], ...body });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().tariff as Record<string, unknown> & { id: string };
}

beforeAll(async () => {
  app = await getApp();
  auth = (await registerCompany(app, 'M3 Sayı Biçimi')).auth;
});

describe('01-B12a indirim oranı', () => {
  it('şablon gidiş-dönüşü: %0,5 indirim %0,5 kalır (önceden %50 oluyordu); şablon oranı yüzde biçimiyle yazar', async () => {
    const t = await createTariff({
      carrierId: await carrier('fedex'),
      name: 'İndirim 0,5',
      currency: 'TRY',
      discountPct: 0.5,
      weightSteps: [{ upto: 1, step: 0.5 }, { upto: null, step: 1 }],
      zones: [{ country: 'DE', zone: 'A' }],
      rates: [
        { zone: 'A', weightUpto: 0.5, price: 100 },
        { zone: 'A', weightUpto: 1, price: 150 },
      ],
      overflow: [{ zone: 'A', perUnit: 10 }],
    });
    const tpl = await get(`/api/deciship/tariffs/template.xlsx?tariffId=${t.id}`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(tpl.rawPayload as unknown as ArrayBuffer);
    const cell = wb.worksheets[0]!.getRow(2).getCell(3);
    expect(wb.worksheets[0]!.getRow(1).getCell(3).value).toBe('İndirim %');
    expect(cell.value).toBe(0.005);
    expect(String(cell.numFmt)).toContain('%');

    const pv = await upload(t.id, 'gidis.xlsx', tpl.rawPayload);
    expect(pv.statusCode, pv.body).toBe(200);
    const draft = pv.json();
    expect(draft.checks.filter((c: Check) => c.severity !== 'info')).toEqual([]);
    const ap = await post(`/api/deciship/tariff-imports/${draft.draftId}/apply`, { options: {} });
    expect(ap.statusCode, ap.body).toBe(200);
    expect(ap.json().tariff.discountPct).toBe(0.5);
  });

  it('eski şablonla dışa aktarılmış dosya (ham 0,5): uygulama durur, iki okuma sorulur; seçilen oran yazılır', async () => {
    const t = await createTariff({ carrierId: await carrier('ups'), name: 'Eski şablon', currency: 'TRY', discountPct: 10, zones: [{ country: 'DE', zone: 'A' }], rates: [{ zone: 'A', weightUpto: 1, price: 1 }] });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Fiyatlar');
    ws.addRow(['Ağırlık (kg/desi) ≤', 'A', 'İndirim %']);
    ws.addRow([0.5, 100, 0.5]);
    ws.addRow([1, 150, null]);
    const pv = await upload(t.id, 'eski.xlsx', Buffer.from(await wb.xlsx.writeBuffer()));
    const draft = pv.json();
    expect(errors(draft.checks)).toEqual(['DISCOUNT_UNCLEAR']);
    expect(draft.canApply).toBe(false);
    expect(draft.fixes.map((f: Fix) => [f.id, f.value, f.label])).toEqual([
      ['discountUnit', 'percent', 'İndirim "0,5" = %0,5'],
      ['discountUnit', 'ratio', 'İndirim "0,5" = %50'],
    ]);
    const blocked = await post(`/api/deciship/tariff-imports/${draft.draftId}/apply`, { options: {}, acknowledged: true });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe('IMPORT_BLOCKED');

    const options = { discountUnit: 'percent' };
    const re = await post(`/api/deciship/tariff-imports/${draft.draftId}/recheck`, { options });
    expect(re.statusCode, re.body).toBe(200);
    expect(re.json().canApply).toBe(true);
    expect(re.json().suggestedMeta).toEqual({ discountPct: 0.5 });
    const ap = await post(`/api/deciship/tariff-imports/${draft.draftId}/apply`, { options, acknowledged: true });
    expect(ap.statusCode, ap.body).toBe(200);
    expect(ap.json().tariff.discountPct).toBe(0.5);
  });
});

describe('01-B6 sayı biçimi', () => {
  it('belirsiz CSV: "1,250" uygulamayı durdurur; İngilizce seçilince 1250 olarak yazılır', async () => {
    const t = await createTariff({ carrierId: await carrier('dhl'), name: 'EN CSV', currency: 'USD', zones: [{ country: 'US', zone: 'A' }], rates: [{ zone: 'A', weightUpto: 1, price: 1 }] });
    const csv = 'Weight,A,Discount %\n1,"1,250",0\n2,"1,500",\n3,"1,750",\n';
    const draft = (await upload(t.id, 'en.csv', Buffer.from(csv))).json();
    expect(errors(draft.checks)).toEqual(['NUMBER_FORMAT_UNCLEAR']);
    const err = draft.checks.find((c: Check) => c.code === 'NUMBER_FORMAT_UNCLEAR');
    expect(err.detail).toContain('"1,250" → Türkçe okunursa 1,25, İngilizce okunursa 1.250');
    expect(draft.fixes.map((f: Fix) => `${f.id}:${f.value}`)).toEqual(['numberFormat:tr', 'numberFormat:en']);
    expect(draft.rates.map((r: { price: number }) => r.price)).toEqual([1.25, 1.5, 1.75]);

    const options = { numberFormat: 'en' };
    const re = (await post(`/api/deciship/tariff-imports/${draft.draftId}/recheck`, { options })).json();
    expect(errors(re.checks)).toEqual([]);
    expect(re.rates.map((r: { price: number }) => r.price)).toEqual([1250, 1500, 1750]);
    const ap = await post(`/api/deciship/tariff-imports/${draft.draftId}/apply`, { options, acknowledged: true });
    expect(ap.statusCode, ap.body).toBe(200);
    expect(ap.json().tariff.rates.map((r: { price: number }) => r.price)).toEqual([1250, 1500, 1750]);
  });

  it('İngilizce CSV (zayıf kanıt): doğru okunur ama biçim seçilmeden uygulanmaz (bin kat tuzağı)', async () => {
    const t = await createTariff({ carrierId: await carrier('aras'), name: 'EN CSV 2', currency: 'USD', zones: [{ country: 'US', zone: 'A' }], rates: [{ zone: 'A', weightUpto: 1, price: 1 }] });
    const csv = 'Weight (kg),A,Discount %\n0.500,45.20,0\n1.000,52.10,\n1.500,58.00,\n2.000,"1,250",\n';
    const draft = (await upload(t.id, 'en2.csv', Buffer.from(csv))).json();
    expect(errors(draft.checks)).toEqual(['NUMBER_FORMAT_ASSUMED']);
    expect(draft.rates.map((r: { weightUpto: number; price: number }) => [r.weightUpto, r.price])).toEqual([
      [0.5, 45.2],
      [1, 52.1],
      [1.5, 58],
      [2, 1250],
    ]);
    // toplu onay yetmez: hata
    const ack = await post(`/api/deciship/tariff-imports/${draft.draftId}/apply`, { options: {}, acknowledged: true });
    expect(ack.statusCode).toBe(422);
    const options = { numberFormat: 'en' };
    const re = (await post(`/api/deciship/tariff-imports/${draft.draftId}/recheck`, { options })).json();
    expect(errors(re.checks)).toEqual([]);
    const ap = await post(`/api/deciship/tariff-imports/${draft.draftId}/apply`, { options, acknowledged: true });
    expect(ap.statusCode, ap.body).toBe(200);
    expect(ap.json().tariff.rates.map((r: { weightUpto: number; price: number }) => [r.weightUpto, r.price])).toEqual([
      [0.5, 45.2],
      [1, 52.1],
      [1.5, 58],
      [2, 1250],
    ]);
  });
});

describe('01-B5 lb tablosu mevcut 0,5 kg basamaklı tarifeye', () => {
  it('basamak lb olur; 0,88 kg (1,94 lb) 2 lb fiyatından, aşım lb başına (6,536 kg = 14,41 lb → 15 lb)', async () => {
    const t = await createTariff({
      carrierId: await carrier('fedex'),
      name: 'lb',
      currency: 'USD',
      weightSteps: [{ upto: null, step: 0.5 }],
      zones: [{ country: 'US', zone: 'A' }],
      rates: [{ zone: 'A', weightUpto: 1, price: 1 }],
    });
    const lines = ['Weight (lb),A,Discount %'];
    for (let lb = 1; lb <= 10; lb++) lines.push(`${lb},${10 + lb},${lb === 1 ? '0' : ''}`);
    lines.push('Additional 1 lb,2,');
    const draft = (await upload(t.id, 'lb.csv', Buffer.from(lines.join('\n')))).json();
    expect(errors(draft.checks)).toEqual(['WEIGHT_UNIT_LB']);
    const options = { convertLbToKg: true };
    const re = (await post(`/api/deciship/tariff-imports/${draft.draftId}/recheck`, { options })).json();
    expect(errors(re.checks)).toEqual([]);
    expect(re.checks.find((c: Check) => c.code === 'LB_WEIGHT_STEPS')?.title).toBe('lb çevriminden sonra ağırlık yuvarlaması değişiyor: her 0,5 kg → her 0,454 kg');
    const ap = await post(`/api/deciship/tariff-imports/${draft.draftId}/apply`, { options, acknowledged: true });
    expect(ap.statusCode, ap.body).toBe(200);
    expect(ap.json().tariff.weightSteps).toEqual([{ upto: null, step: 0.45359237 }]);
    const quote = (weightKg: number) => post(`/api/deciship/tariffs/${t.id}/quote`, { lengthCm: 1, widthCm: 1, heightCm: 1, weightKg, destCountry: 'US' });
    // önceden 1 kg'a yuvarlanıp 3 lb satırından 13
    expect((await quote(0.88)).json()).toMatchObject({ ok: true, chargeableKg: 0.907, base: 12 });
    // 10 lb satırı (20) + 5 × 2 = 30 (önceden yarım kg başına aşım 42,05; kg başına çevrilince 28,82)
    expect((await quote(6.536)).json()).toMatchObject({ ok: true, chargeableKg: 6.804, base: 30 });
    expect((await quote(4.537)).json()).toMatchObject({ ok: true, base: 22 });
    expect((await quote(100)).json()).toMatchObject({ ok: true, base: 442 });
  });
});
