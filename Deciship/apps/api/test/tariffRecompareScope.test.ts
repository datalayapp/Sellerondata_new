import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { getApp, measurementPayload, multipart, registerCompany, SAMPLES, uniq } from './helpers.ts';
import { viaJob } from './jobHelpers.ts';

/**
 * "Yeniden karşılaştır" önerisi yalnız bu tarifenin fiyatladığı faturaları sayar, düğme de yalnız onları hesaplar.
 * Fatura kendi tarifesiyle fiyatlanır: seçili tarife, seçim yoksa taşıyıcının varsayılanı (`invoiceTariff`).
 * Eskiden taşıyıcının bütün faturaları sayılıyordu: varsayılan olmayan yeni tarife "yeni fiyatlarla görmek için" diyordu, fiyat değişmiyordu.
 * Mesaj 4: fatura hesaplandığı sürümde donar; düğme artık önizleme + `token` ile çalışır (`bulk`) ve yalnız bu tarifeyle hesaplı ya da dayanağı olmayan faturaları bu tarifenin bugünkü sürümüne geçirir.
 */

type Auth = { authorization: string };
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const TEMPLATE = fs.readFileSync(path.join(SAMPLES, 'tariff-template-example.xlsx'));

let app: FastifyInstance;
let auth: Auth;

const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, headers: auth, payload: payload ?? {} });

function tariffBody(carrierId: string, name: string, perKg: number, over: Record<string, unknown> = {}) {
  return {
    carrierId,
    name,
    currency: 'TRY',
    divisor: 3000,
    edgeRounding: 'CEIL_CM',
    weightSteps: [{ upto: null, step: 1 }],
    discountPct: 0,
    fuelPct: 0,
    active: true,
    isDefault: false,
    zones: [{ country: '*', zone: 'TR' }],
    rates: Array.from({ length: 30 }, (_, i) => ({ zone: 'TR', weightUpto: i + 1, price: (i + 1) * perKg })),
    overflow: [],
    surcharges: [],
    ...over,
  };
}

async function carrier() {
  const r = await post('/api/deciship/carriers', { code: 'aras', name: uniq('Aras') });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().carrier.id as string;
}

async function createTariff(carrierId: string, name: string, perKg: number, over: Record<string, unknown> = {}) {
  const r = await post('/api/deciship/tariffs', tariffBody(carrierId, name, perKg, over));
  expect(r.statusCode, r.body).toBe(201);
  return r.json().tariff.id as string;
}

/** Toplu "yeni tarifeyle hesapla": önizleme (yazmaz) → önizlemenin özetiyle onay. */
async function bulk(tariffId: string) {
  // Y83: yalnız arka planda; `viaJob` işin sonucunu eski yanıt biçiminde verir (işin sonucu `stopped` da taşır: 0)
  const preview = await viaJob(app, { method: 'POST', url: `/api/deciship/tariffs/${tariffId}/recompare-invoices/preview`, headers: auth, payload: {} });
  expect(preview.statusCode, preview.body).toBe(200);
  const r = await viaJob(app, { method: 'POST', url: `/api/deciship/tariffs/${tariffId}/recompare-invoices`, headers: auth, payload: { token: preview.json().token } });
  expect(r.statusCode, r.body).toBe(200);
  const { skipped, stopped, ...rest } = r.json();
  expect(skipped).toEqual({ inDispute: 0, stale: 0 });
  expect(stopped).toBe(0);
  expect(rest.invoices).toBe(preview.json().changedInvoices);
  return rest as { invoices: number; lines: number };
}

const putTariff = (id: string, carrierId: string, name: string, perKg: number, over: Record<string, unknown> = {}) =>
  app.inject({ method: 'PUT', url: `/api/deciship/tariffs/${id}`, headers: auth, payload: tariffBody(carrierId, name, perKg, over) });

/** 30×20×15 / 3000 = 3 desi, 2 kg: ücretli 3. Beklenen tutar 3 × kg fiyatı. */
async function invoice(carrierId: string, tariffId?: string) {
  const p = measurementPayload({ lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
  const m = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...auth, ...p.headers }, payload: p.payload });
  expect(m.statusCode, m.body).toBe(201);
  const csv = `Takip No;Hizmet;Desi;Tutar\n${m.json().measurement.trackingNo};Express;3;30`;
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
  ]);
  const preview = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
  expect(preview.statusCode, preview.body).toBe(200);
  const created = await post('/api/deciship/invoices', {
    fileId: preview.json().fileId,
    carrierId,
    invoiceNo: uniq('F'),
    invoiceDate: '2026-10-15',
    currency: 'TRY',
    mapping: { trackingNo: 'Takip No', service: 'Hizmet', billedKg: 'Desi', netAmount: 'Tutar' },
    ...(tariffId ? { tariffId } : {}),
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json().invoice.id as string;
}

async function expectedAmount(invoiceId: string) {
  const r = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${invoiceId}/lines`, headers: auth });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().items[0].expectedAmount as number | null;
}

async function lineTariff(invoiceId: string) {
  const r = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${invoiceId}/lines`, headers: auth });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().items[0].tariffId as string | null;
}

/** Dosyadan yeni tarife: şikâyetin geldiği akış. */
async function createFromFile(carrierId: string) {
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: 'yeni.xlsx', contentType: XLSX_MIME, data: TEMPLATE },
  ]);
  const up = await app.inject({ method: 'POST', url: '/api/deciship/tariff-imports', headers: { ...auth, ...form.headers }, payload: form.payload });
  expect(up.statusCode, up.body).toBe(200);
  const applied = await post(`/api/deciship/tariff-imports/${up.json().draftId}/apply`, { options: {}, acknowledged: true, meta: { name: uniq('Dosyadan') } });
  expect(applied.statusCode, applied.body).toBe(200);
  return applied.json() as { tariff: { id: string; isDefault: boolean }; affectedInvoices: number; otherInvoices: number };
}

beforeAll(async () => {
  app = await getApp();
  auth = (await registerCompany(app, 'Tarife Öneri')).auth;
});

describe('tarife değişince yeniden karşılaştırma önerisi', () => {
  it('dosyadan gelen varsayılan olmayan yeni tarife: fatura kullanmıyor, öneri yok, düğme de hesaplamaz', async () => {
    const c = await carrier();
    await createTariff(c, 'Standart', 10, { isDefault: true });
    const a = await invoice(c);
    const b = await invoice(c);

    const created = await createFromFile(c);
    expect(created.tariff.isDefault).toBe(false);
    expect(created.affectedInvoices).toBe(0);
    expect(created.otherInvoices).toBe(2);

    expect(await bulk(created.tariff.id)).toEqual({ invoices: 0, lines: 0 });
    expect(await expectedAmount(a)).toBe(30);
    expect(await expectedAmount(b)).toBe(30);
  });

  it('varsayılan olmayan tarifeyi seçen fatura önerilir ve yeni fiyatı alır; öbür fatura yerinde kalır', async () => {
    const c = await carrier();
    const standart = await createTariff(c, 'Standart', 10, { isDefault: true });
    const economy = await createTariff(c, 'Economy', 5);
    const onDefault = await invoice(c);
    const onEconomy = await invoice(c, economy);
    expect(await expectedAmount(onDefault)).toBe(30);
    expect(await expectedAmount(onEconomy)).toBe(15);

    const put = await putTariff(economy, c, 'Economy', 6);
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ affectedInvoices: 1, otherInvoices: 1 });

    // öbür faturanın tarifesi de değişti ama önerisi alınmadı: Economy düğmesi onu hesaplamamalı
    expect((await putTariff(standart, c, 'Standart', 20, { isDefault: true })).statusCode).toBe(200);

    expect(await bulk(economy)).toEqual({ invoices: 1, lines: 1 });
    expect(await expectedAmount(onEconomy)).toBe(18);
    expect(await expectedAmount(onDefault)).toBe(30);
  });

  it('sürüm geri yükleme de yalnız bu tarifeyi kullanan faturayı sayar', async () => {
    const c = await carrier();
    await createTariff(c, 'Standart', 10, { isDefault: true });
    const economy = await createTariff(c, 'Economy', 5);
    await invoice(c);
    const onEconomy = await invoice(c, economy);
    expect((await putTariff(economy, c, 'Economy', 6)).statusCode).toBe(200);

    const versions = (await app.inject({ method: 'GET', url: `/api/deciship/tariffs/${economy}/versions`, headers: auth })).json().items;
    const restore = await post(`/api/deciship/tariffs/${economy}/versions/${versions[0].id}/restore`);
    expect(restore.statusCode, restore.body).toBe(200);
    expect(restore.json()).toMatchObject({ affectedInvoices: 1, otherInvoices: 1 });
    expect(await expectedAmount(onEconomy)).toBe(15);
  });

  it('tarife seçilmemiş fatura taşıyıcının varsayılanına düşer: yeni tek tarife varsayılan olur ve önerilir', async () => {
    const c = await carrier();
    const before = await invoice(c);
    expect(await lineTariff(before)).toBeNull();

    const created = await createFromFile(c);
    expect(created.tariff.isDefault).toBe(true);
    expect(created.affectedInvoices).toBe(1);
    expect(created.otherInvoices).toBe(0);

    expect(await bulk(created.tariff.id)).toEqual({ invoices: 1, lines: 1 });
    // Şablonda "*" bölgesi yok, tutar çıkmaz: satırın artık bu tarifeyle karşılaştırıldığı tarifesinden görülür. Tutar için bir sonraki test.
    expect(await lineTariff(before)).toBe(created.tariff.id);
  });

  it('işaretli varsayılan yoksa kural karşılaştırmayla aynı: en son güncellenen etkin tarife', async () => {
    const c = await carrier();
    const orphan = await invoice(c);
    const older = await createTariff(c, 'Eski', 10);
    const newer = await createTariff(c, 'Yeni', 20);

    // Eski kaydedilince en son güncellenen o olur
    const put = await putTariff(older, c, 'Eski', 11);
    expect(put.json()).toMatchObject({ affectedInvoices: 1, otherInvoices: 0 });
    // Yeni kaydedilince sıra ona geçer, Eski artık bu faturayı fiyatlamaz
    expect((await putTariff(newer, c, 'Yeni', 21)).json()).toMatchObject({ affectedInvoices: 1, otherInvoices: 0 });
    expect(await bulk(older)).toEqual({ invoices: 0, lines: 0 });
    expect(await expectedAmount(orphan)).toBeNull();

    expect(await bulk(newer)).toEqual({ invoices: 1, lines: 1 });
    expect(await expectedAmount(orphan)).toBe(63);
  });

  it('silinmiş fatura ve başka taşıyıcının faturası sayılmaz', async () => {
    const c = await carrier();
    const other = await carrier();
    const t = await createTariff(c, 'Tek', 10, { isDefault: true });
    await createTariff(other, 'Başka', 10, { isDefault: true });
    await invoice(other);
    const gone = await invoice(c);
    const del = await app.inject({ method: 'DELETE', url: `/api/deciship/invoices/${gone}`, headers: auth });
    expect(del.statusCode, del.body).toBeLessThan(300);
    expect((await putTariff(t, c, 'Tek', 11, { isDefault: true })).json()).toMatchObject({ affectedInvoices: 0, otherInvoices: 0 });
  });
});
