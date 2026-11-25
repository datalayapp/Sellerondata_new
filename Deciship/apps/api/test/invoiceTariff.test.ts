import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { getApp, measurementPayload, multipart, registerCompany, uniq, inCompany } from './helpers.ts';
import { patchInvoice, recalculate } from './recalcHelpers.ts';

type Auth = { authorization: string };

async function carrier(app: FastifyInstance, auth: Auth, code: string, name: string) {
  const r = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code, name } });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json().carrier?.id ?? r.json().id) as string;
}

async function tariff(app: FastifyInstance, auth: Auth, carrierId: string, over: Record<string, unknown> & { perKg: number }) {
  const { perKg, ...rest } = over;
  const r = await app.inject({
    method: 'POST',
    url: '/api/deciship/tariffs',
    headers: auth,
    payload: {
      carrierId,
      name: uniq('T'),
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
      ...rest,
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json().tariff?.id ?? r.json().id) as string;
}

async function measurement(app: FastifyInstance, auth: Auth) {
  // 30×20×15 / 3000 = 3 desi, 2 kg → ücretli 3
  const p = measurementPayload({ lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
  const r = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...auth, ...p.headers }, payload: p.payload });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().measurement.trackingNo as string;
}

/** Aras: Standart (varsayılan, 10/kg), Economy (hizmet "Economy", 5/kg), Eski (2025'te bitti, 20/kg). MNG: tek tarife. */
async function fixture(app: FastifyInstance) {
  const admin = await registerCompany(app);
  const auth = admin.auth;
  const aras = await carrier(app, auth, 'aras', 'Aras Test');
  const mng = await carrier(app, auth, 'mng', 'MNG Test');
  const standart = await tariff(app, auth, aras, { name: 'Aras Standart', isDefault: true, perKg: 10 });
  const economy = await tariff(app, auth, aras, { name: 'Aras Economy', service: 'Economy', perKg: 5 });
  const eski = await tariff(app, auth, aras, { name: 'Aras Eski', validTo: '2025-12-31', perKg: 20 });
  const pasif = await tariff(app, auth, aras, { name: 'Aras Pasif', active: false, perKg: 1 });
  const mngT = await tariff(app, auth, mng, { name: 'MNG Tek', isDefault: true, perKg: 7 });
  const t1 = await measurement(app, auth);
  const t2 = await measurement(app, auth);
  return { auth, aras, mng, standart, economy, eski, pasif, mngT, t1, t2 };
}

async function upload(
  app: FastifyInstance,
  auth: Auth,
  carrierId: string,
  rows: [string, string][],
  tariffId?: string | null,
  extra: Record<string, unknown> = {},
) {
  const csv = ['Takip No;Hizmet;Desi;Tutar', ...rows.map(([t, s]) => `${t};${s};3;30`)].join('\n');
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
  ]);
  const preview = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
  expect(preview.statusCode, preview.body).toBe(200);
  return app.inject({
    method: 'POST',
    url: '/api/deciship/invoices',
    headers: auth,
    payload: {
      fileId: preview.json().fileId,
      carrierId,
      invoiceNo: uniq('F'),
      invoiceDate: '2026-10-15',
      currency: 'TRY',
      mapping: { trackingNo: 'Takip No', service: 'Hizmet', billedKg: 'Desi', netAmount: 'Tutar' },
      ...(tariffId !== undefined ? { tariffId } : {}),
      ...extra,
    },
  });
}

type Line = { trackingNo: string; tariffId: string | null; tariff: { id: string; name: string } | null; expectedAmount: number | null; note: string | null };
async function lines(app: FastifyInstance, auth: Auth, invoiceId: string) {
  const r = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${invoiceId}/lines`, headers: auth });
  expect(r.statusCode).toBe(200);
  return r.json().items as Line[];
}
async function detail(app: FastifyInstance, auth: Auth, invoiceId: string) {
  const r = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${invoiceId}`, headers: auth });
  expect(r.statusCode).toBe(200);
  return r.json().invoice;
}

describe('Fatura tarifesi seçimi (varsayılan önseçili, tüm satırlar tek tarife)', () => {
  it('tarife verilmezse varsayılan kaydedilir; hizmete göre seçim yapılmaz', async () => {
    const app = await getApp();
    const f = await fixture(app);
    const res = await upload(app, f.auth, f.aras, [[f.t1, 'Express'], [f.t2, 'Economy']]);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().invoice).toMatchObject({ tariffId: f.standart, tariff: { id: f.standart, name: 'Aras Standart' } });
    const id = res.json().invoice.id;
    // "Economy" hizmetli satır da varsayılan tarifeyle
    for (const l of await lines(app, f.auth, id)) {
      expect(l).toMatchObject({ tariffId: f.standart, tariff: { id: f.standart, name: 'Aras Standart' }, expectedAmount: 30 });
    }
    expect((await detail(app, f.auth, id)).tariffsUsed).toEqual([{ id: f.standart, name: 'Aras Standart', lines: 2 }]);
  });

  it('seçilen tarife tüm satırlarda kullanılır; geçerlilik dışı uyarı verir ama fiyatlar', async () => {
    const app = await getApp();
    const f = await fixture(app);
    const res = await upload(app, f.auth, f.aras, [[f.t1, 'Express'], [f.t2, 'Standard']], f.economy);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().invoice).toMatchObject({ tariffId: f.economy, tariff: { name: 'Aras Economy' } });
    for (const l of await lines(app, f.auth, res.json().invoice.id)) expect(l).toMatchObject({ tariffId: f.economy, expectedAmount: 15 });

    const old = await upload(app, f.auth, f.aras, [[uniq('X1'), 'Express']], f.eski);
    expect(old.statusCode, old.body).toBe(201);
    const [l] = await lines(app, f.auth, old.json().invoice.id);
    expect(l!.tariffId).toBe(f.eski);
    expect(l!.note).toContain('Tarife (Aras Eski) 2026-10-15 tarihinde geçerli değil');
  });

  it('başka taşıyıcının tarifesi 400, pasif 400, başka şirketin tarifesi 404; tarifesiz taşıyıcı NO_TARIFF', async () => {
    const app = await getApp();
    const f = await fixture(app);
    const wrong = await upload(app, f.auth, f.aras, [[f.t1, 'Express']], f.mngT);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('TARIFF_CARRIER_MISMATCH');
    const inactive = await upload(app, f.auth, f.aras, [[f.t1, 'Express']], f.pasif);
    expect(inactive.statusCode).toBe(400);
    expect(inactive.json().error.code).toBe('TARIFF_INACTIVE');
    const other = await fixture(app);
    const foreign = await upload(app, f.auth, f.aras, [[f.t1, 'Express']], other.standart);
    expect(foreign.statusCode).toBe(404);

    const bare = await carrier(app, f.auth, 'yurtici', 'Tarifesiz');
    const none = await upload(app, f.auth, bare, [[f.t1, 'Express']]);
    expect(none.statusCode, none.body).toBe(201);
    expect(none.json().invoice).toMatchObject({ tariffId: null, tariff: null, totals: { noTariff: 1 } });
  });

  // Mesaj 4: PATCH ile tarife / taşıyıcı değişince fatura yeni tarifenin bugünkü sürümüne bağlanır (current + all); her hesap `invoice.recalculate` kaydı bırakır.
  it('PATCH tariffId yeniden karşılaştırır; null varsayılana döner; taşıyıcı değişince yeni taşıyıcının varsayılanı; rapor tarifeyi yazar', async () => {
    const app = await getApp();
    const f = await fixture(app);
    const res = await upload(app, f.auth, f.aras, [[f.t1, 'Express'], [f.t2, 'Economy']]);
    const id = res.json().invoice.id as string;
    const patch = (payload: Record<string, unknown>) => patchInvoice(app, f.auth, id, payload);
    const summary = async () => {
      const x = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}/report.xlsx`, headers: f.auth });
      expect(x.statusCode).toBe(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
      const v: string[] = [];
      wb.getWorksheet('Özet')!.eachRow((r) => v.push(String((r.values as unknown[]).slice(1).join('|'))));
      return v;
    };

    const set = await patch({ tariffId: f.economy });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().invoice).toMatchObject({ tariffId: f.economy, tariff: { name: 'Aras Economy' }, tariffsUsed: [{ id: f.economy, lines: 2 }], basis: { state: 'CURRENT', tariffName: 'Aras Economy' } });
    for (const l of await lines(app, f.auth, id)) expect(l).toMatchObject({ tariffId: f.economy, expectedAmount: 15, prevResult: { expectedAmount: 30, cause: 'TARIFF' } });
    // fatura ve satırlar Economy'nin bugünkü sürümüne bağlandı
    const economyRev = (await inCompany(f.auth, () => prisma.tariff.findUniqueOrThrow({ where: { id: f.economy } }))).currentRevisionId;
    expect(economyRev).toBeTruthy();
    expect((await inCompany(f.auth, () => prisma.invoice.findUniqueOrThrow({ where: { id } }))).tariffRevisionId).toBe(economyRev);
    expect((await inCompany(f.auth, () => prisma.invoiceLine.findMany({ where: { invoiceId: id } }))).map((l) => l.tariffRevisionId)).toEqual([economyRev, economyRev]);
    expect(await summary()).toContain('Tarife|Aras Economy');
    const pdf = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}/report.pdf`, headers: f.auth });
    expect(pdf.statusCode).toBe(200);

    expect((await patch({ tariffId: f.mngT })).statusCode).toBe(400);

    const back = await patch({ tariffId: null });
    expect(back.json().invoice).toMatchObject({ tariffId: f.standart, tariff: { name: 'Aras Standart' } });
    expect((await lines(app, f.auth, id)).every((l) => l.tariffId === f.standart)).toBe(true);

    const moved = await patch({ carrierId: f.mng });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().invoice).toMatchObject({ carrier: { id: f.mng }, tariffId: f.mngT, tariff: { name: 'MNG Tek' } });
    expect((await lines(app, f.auth, id)).every((l) => l.tariffId === f.mngT)).toBe(true);

    // taşıyıcı + yeni taşıyıcının tarifesi birlikte
    const both = await patch({ carrierId: f.aras, tariffId: f.economy });
    expect(both.json().invoice).toMatchObject({ carrier: { id: f.aras }, tariffId: f.economy });

    const audits = await inCompany(f.auth, () => prisma.auditLog.count({ where: { entityId: id, action: 'invoice.update' } }));
    expect(audits).toBe(4); // 400 yazılmaz
    const recalcs = await inCompany(f.auth, () => prisma.auditLog.findMany({ where: { entityId: id, action: 'invoice.recalculate' }, orderBy: { createdAt: 'asc' } }));
    expect(recalcs).toHaveLength(4);
    expect(recalcs[0]!.data).toMatchObject({ basis: 'tariff', cause: 'TARIFF', revisionTo: economyRev, changedLines: 2, totalsBefore: { match: 2 }, totalsAfter: { diff: 2 } });
  });

  // Mesaj 4: tarife silinince ve "Varsayılan yap" denince fatura hesaplandığı sürümle aynı rakamda kalır; başka tarifeye yalnız kullanıcı (önizleme + onay) geçirir.
  it('silinen tarife: fatura aynı rakamda kalır, "yeni tarifeyle hesapla" varsayılana bağlar; "Varsayılan yap" tek tıkla ve faturayı değiştirmez', async () => {
    const app = await getApp();
    const f = await fixture(app);
    const res = await upload(app, f.auth, f.aras, [[f.t1, 'Economy']], f.economy);
    const id = res.json().invoice.id as string;
    await inCompany(f.auth, () => prisma.tariff.delete({ where: { id: f.economy } }));
    expect((await inCompany(f.auth, () => prisma.invoice.findUniqueOrThrow({ where: { id } }))).tariffId).toBeNull();
    // silinen tarifenin sürümü durur: "Yeniden karşılaştır" Economy fiyatıyla (5/kg → 15) aynı sonucu verir, ad sürümden gelir
    const rc = await app.inject({ method: 'POST', url: `/api/deciship/invoices/${id}/recompare`, headers: f.auth });
    expect(rc.statusCode).toBe(200);
    expect(rc.json().invoice.basis).toMatchObject({ state: 'TARIFF_REMOVED', tariffName: 'Aras Economy' });
    expect((await lines(app, f.auth, id))[0]).toMatchObject({ tariffId: null, expectedAmount: 15 });
    // rapor (Excel ve PDF aynı özetten) ekrandaki gibi sürümdeki adı "silindi" ile yazar, "Tarife yok" demez
    const reportTariff = async (headers: Record<string, string>) => {
      const x = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}/report.xlsx`, headers: { ...f.auth, ...headers } });
      expect(x.statusCode).toBe(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
      const v: string[] = [];
      wb.worksheets[0]!.eachRow((r) => v.push(String((r.values as unknown[]).slice(1).join('|'))));
      return v.filter((row) => row.startsWith('Tarife|') || row.startsWith('Tariff|'));
    };
    expect(await reportTariff({})).toEqual(['Tarife|Aras Economy (silindi)']);
    expect(await reportTariff({ 'accept-language': 'en' })).toEqual(['Tariff|Aras Economy (deleted)']);
    const pdf = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}/report.pdf`, headers: f.auth });
    expect(pdf.statusCode).toBe(200);
    // kullanıcı "yeni tarifeyle hesapla" der: taşıyıcının varsayılanı (Standart, 10/kg → 30), fatura ona bağlanır
    const moved = await recalculate(app, f.auth, id, { basis: 'tariff' });
    expect(moved.preview.basis).toMatchObject({ from: { tariffId: null, tariffName: 'Aras Economy' }, to: { tariffId: f.standart, tariffName: 'Aras Standart' } });
    expect(moved.preview.lines).toHaveLength(1);
    expect(moved.preview.lines[0]).toMatchObject({ before: { expectedAmount: 15 }, after: { expectedAmount: 30 } });
    expect(moved.invoice).toMatchObject({ tariffId: f.standart, basis: { state: 'CURRENT', tariffName: 'Aras Standart' } });
    expect((await lines(app, f.auth, id))[0]).toMatchObject({ tariffId: f.standart, expectedAmount: 30 });

    const mk = await app.inject({ method: 'POST', url: `/api/deciship/tariffs/${f.eski}/default`, headers: f.auth });
    expect(mk.statusCode, mk.body).toBe(200);
    expect(mk.json().tariff.isDefault).toBe(true);
    const list = await app.inject({ method: 'GET', url: `/api/deciship/tariffs?carrierId=${f.aras}`, headers: f.auth });
    const items = (list.json().items ?? list.json()) as { id: string; isDefault: boolean }[];
    expect(items.filter((t) => t.isDefault).map((t) => t.id)).toEqual([f.eski]);
    expect((await app.inject({ method: 'POST', url: `/api/deciship/tariffs/${f.pasif}/default`, headers: f.auth })).statusCode).toBe(400);
    // "Varsayılan yap" eski faturayı kaydırmaz: fatura Standart'ın sürümünde, rakamı aynı
    const after = await app.inject({ method: 'POST', url: `/api/deciship/invoices/${id}/recompare`, headers: f.auth });
    expect(after.json().invoice).toMatchObject({ tariffId: f.standart, basis: { state: 'CURRENT', tariffName: 'Aras Standart' } });
    expect((await lines(app, f.auth, id))[0]).toMatchObject({ tariffId: f.standart, expectedAmount: 30 });
    expect((await recalculate(app, f.auth, id, { basis: 'tariff' })).preview).toMatchObject({ changedLines: 0, basis: { to: { tariffId: f.standart } } });
    // yeni varsayılana kullanıcı faturanın tarifesini değiştirerek geçirir (Eski: 20/kg; faturalanan 30 → beklenen 30'da kalır, tarife Eski olur)
    const toEski = await patchInvoice(app, f.auth, id, { tariffId: f.eski });
    expect(toEski.statusCode, toEski.body).toBe(200);
    expect((await lines(app, f.auth, id))[0]!.tariffId).toBe(f.eski);
  });

  it('tarife şüphesi: karşılaştırılan ≥5 satırın %30\'undan fazlasında fiyat farkı varsa tariffSuspect', async () => {
    const app = await getApp();
    const f = await fixture(app);
    const more = [f.t1, f.t2, await measurement(app, f.auth), await measurement(app, f.auth), await measurement(app, f.auth)];
    // Beş satır aynı tutar: okuma kontrolü "fatura toplamı olabilir" der; onaylanarak içe aktarılır.
    const rows = more.map((t) => [t, 'Express'] as [string, string]);
    const res = await upload(app, f.auth, f.aras, rows, undefined, { acknowledgeIssues: true });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().invoice.id as string;
    // Standart (10/kg): beklenen 30 = faturalanan 30 → uyumlu
    expect(await detail(app, f.auth, id)).toMatchObject({ tariffSuspect: false, totals: { match: 5 } });
    // Economy (5/kg): her satırda fiyat farkı → şüpheli
    const set = await patchInvoice(app, f.auth, id, { tariffId: f.economy });
    expect(set.json().invoice).toMatchObject({ tariffSuspect: true, totals: { diff: 5 } });
    expect((await lines(app, f.auth, id)).every((l) => l.expectedAmount === 15)).toBe(true);
    // 5'ten az karşılaştırılan satırda uyarı yok
    const fresh = [await measurement(app, f.auth), await measurement(app, f.auth)];
    const small = await upload(app, f.auth, f.aras, fresh.map((t) => [t, 'Express'] as [string, string]), f.economy, { acknowledgeIssues: true });
    expect(small.statusCode, small.body).toBe(201);
    expect(await detail(app, f.auth, small.json().invoice.id)).toMatchObject({ tariffSuspect: false, totals: { diff: 2 } });
  });
});
