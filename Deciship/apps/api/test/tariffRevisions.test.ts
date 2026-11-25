import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { applyRecompare } from '../src/services/compare.ts';
import { ensureTariffRevision, tariffBody, tariffContentHash, tariffSnapshot, type TariffBody } from '../src/services/tariffs.ts';
import { tariffPayload } from './fixtures.ts';
import { getApp, inCompany, multipart, registerCompany, uniq } from './helpers.ts';

/**
 * Mesaj 4, Adım 1-A: tarifenin değişmez fiyat sürümü (TariffRevision). Fiyatı etkileyen içerik ya da taşıyıcı değişince
 * yeni sürüm doğar; ad, ek ücret adı, etkinlik, varsayılan, geçerlilik ve satır sırası değişince doğmaz; tarife silinse de
 * sürüm durur.
 */

type Auth = { authorization: string };
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let app: FastifyInstance;
let auth: Auth;
let companyId: string;
let userId: string;
let carrierId: string;

const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, headers: auth, ...(payload === undefined ? {} : { payload: payload as object }) });
const put = (url: string, payload: unknown) => app.inject({ method: 'PUT', url, headers: auth, payload: payload as object });
const get = (url: string) => app.inject({ method: 'GET', url, headers: auth });

const revisions = (tariffId: string) =>
  inCompany(auth, () => prisma.tariffRevision.findMany({ where: { tariffId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));
const currentOf = (tariffId: string) =>
  inCompany(auth, () => prisma.tariff.findFirstOrThrow({ where: { id: tariffId }, select: { currentRevisionId: true, updatedAt: true } }));

function payload(over: Record<string, unknown> = {}) {
  return tariffPayload(carrierId, {
    name: uniq('Sürüm '),
    isDefault: false,
    validFrom: '2026-01-01',
    validTo: '2026-12-31',
    zones: [
      { country: 'DE', zone: 'A' },
      { country: 'FR', zone: 'B' },
      { country: '*', zone: 'TR' },
    ],
    rates: [
      { zone: 'A', weightUpto: 1, price: 15.5 },
      { zone: 'A', weightUpto: 2, price: 20 },
      { zone: 'B', weightUpto: 1, price: 30 },
      { zone: 'TR', weightUpto: 5, price: 40, perKg: true },
    ],
    overflow: [
      { zone: 'A', perUnit: 3 },
      { zone: 'B', perUnit: 4 },
    ],
    surcharges: [
      { code: 'FUEL', name: 'Yakıt', kind: 'PCT', amount: 10 },
      { code: 'REMOTE_AREA', name: 'Uzak bölge', kind: 'FIXED', amount: 25 },
    ],
    ...over,
  });
}

async function createTariff(over: Record<string, unknown> = {}) {
  const r = await post('/api/deciship/tariffs', payload(over));
  expect(r.statusCode, r.body).toBe(201);
  return r.json().tariff as { id: string; name: string } & Record<string, unknown>;
}

/** Yüklenmiş bir dosyası olan, verilen sürüme bağlı en küçük fatura (hesap motoru çağrılmaz). */
async function pinnedInvoice(revisionId: string, tariffId: string | null, invoiceCarrierId = carrierId) {
  return inCompany(auth, async () => {
    const file = await prisma.file.create({
      data: { companyId, kind: 'INVOICE_SOURCE', mime: 'text/csv', size: 1, path: `yok/${uniq('f')}.csv`, sha256: uniq('s'), createdById: userId },
    });
    return prisma.invoice.create({
      data: {
        companyId,
        carrierId: invoiceCarrierId,
        tariffId,
        tariffRevisionId: revisionId,
        invoiceNo: uniq('F'),
        invoiceDate: new Date('2026-10-15T00:00:00.000Z'),
        currency: 'TRY',
        sourceFileId: file.id,
        mapping: {},
        totals: {},
      },
    });
  });
}

beforeAll(async () => {
  app = await getApp();
  const a = await registerCompany(app, uniq('Sürüm Şirketi '));
  auth = a.auth;
  companyId = a.companyId;
  userId = a.userId;
  const c = await post('/api/deciship/carriers', { code: 'fedex', name: uniq('FedEx ') });
  expect(c.statusCode, c.body).toBe(201);
  carrierId = c.json().carrier.id;
});

describe('tariffContentHash', () => {
  const base = (): TariffBody => tariffBody.parse(payload({ carrierId: 'k', countryAdjustments: [{ country: 'DE', pct: -10, note: 'a' }] }));

  it('yalnız fiyatı etkileyen alanlara bakar; sıra ve sayı biçimi önemsiz', () => {
    const b = base();
    const h = tariffContentHash(b);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // ad, ek ücret adı, etkinlik, varsayılan, geçerlilik, istisna notu/kaynağı özete girmez
    expect(
      tariffContentHash({
        ...b,
        name: 'Başka ad',
        surcharges: b.surcharges.map((s) => ({ ...s, name: `${s.name ?? ''} (yeni ad)` })),
        active: false,
        isDefault: true,
        validFrom: '2025-01-01',
        validTo: null,
        countryAdjustments: [{ country: 'DE', pct: -10, note: 'başka not', source: 'invoice', invoiceId: 'x' }],
      }),
    ).toBe(h);
    // satır sırası, bölge/taşma/ek ücret/istisna sırası, küçük harf ülke ve para birimi
    expect(
      tariffContentHash({
        ...b,
        currency: 'try',
        zones: [...b.zones].reverse().map((z) => ({ ...z, country: z.country.toLowerCase() })),
        rates: [...b.rates].reverse(),
        overflow: [...b.overflow].reverse(),
        surcharges: [...b.surcharges].reverse(),
        countryAdjustments: [{ country: 'de', pct: -10, source: 'manual' }],
      }),
    ).toBe(h);
    // 15.50 = 15.5; ondalık sayıdan gelen değer
    expect(tariffContentHash({ ...b, rates: b.rates.map((r) => ({ ...r, price: Number('15.50') === r.price ? Number('15.500') : r.price })) })).toBe(h);
  });

  it('fiyatı etkileyen her alan özeti değiştirir', () => {
    const b = base();
    const h = tariffContentHash(b);
    const variants: Partial<TariffBody>[] = [
      // taşıyıcı: sürüm bir taşıyıcının fiyatıdır (tarife başka taşıyıcıya taşınınca yeni sürüm)
      { carrierId: 'baska' },
      { currency: 'EUR' },
      { divisor: 5000 },
      { edgeRounding: 'NONE' },
      { weightSteps: [{ upto: null, step: 0.5 }] },
      { discountPct: 1 },
      { fuelPct: 1 },
      { fuelVariable: !b.fuelVariable },
      { service: 'Express' },
      { zones: b.zones.map((z) => (z.country === 'DE' ? { ...z, zone: 'B' } : z)) },
      { rates: b.rates.map((r, i) => (i === 0 ? { ...r, price: 15.51 } : r)) },
      { rates: b.rates.map((r, i) => (i === 0 ? { ...r, perKg: true } : r)) },
      { overflow: [{ zone: 'A', perUnit: 3 }] },
      { surcharges: b.surcharges.map((s, i) => (i === 0 ? { ...s, amount: 11 } : s)) },
      { surcharges: b.surcharges.map((s, i) => (i === 0 ? { ...s, kind: 'FIXED' as const } : s)) },
      { countryAdjustments: [{ country: 'DE', pct: -11, source: 'manual' }] },
      { countryAdjustments: [] },
    ];
    for (const v of variants) expect(tariffContentHash({ ...b, ...v }), JSON.stringify(v)).not.toBe(h);
  });

  it('sırası hesabı etkileyen dizilerde sıra korunur (basamaklar; aynı koddaki ek ücretler)', () => {
    const b = base();
    const steps = { ...b, weightSteps: [{ upto: 10, step: 0.5 }, { upto: null, step: 1 }] };
    expect(tariffContentHash(steps)).not.toBe(tariffContentHash({ ...steps, weightSteps: [...steps.weightSteps].reverse() }));
    const dup = { ...b, surcharges: [{ code: 'X', name: '', kind: 'FIXED' as const, amount: 1 }, { code: 'X', name: '', kind: 'FIXED' as const, amount: 2 }] };
    expect(tariffContentHash(dup)).not.toBe(tariffContentHash({ ...dup, surcharges: [...dup.surcharges].reverse() }));
  });
});

describe('tarife sürümü', () => {
  it('yeni tarifede sürüm doğar; anlık görüntü canlı tarifeyle aynı', async () => {
    const t = await createTariff();
    const revs = await revisions(t.id);
    expect(revs).toHaveLength(1);
    const r = revs[0]!;
    expect(r).toMatchObject({ companyId, tariffId: t.id, tariffName: t.name, currency: 'TRY' });
    expect((await currentOf(t.id)).currentRevisionId).toBe(r.id);
    const full = (await get(`/api/deciship/tariffs/${t.id}`)).json().tariff;
    const snap = tariffSnapshot(full);
    expect(r.snapshot).toEqual(JSON.parse(JSON.stringify(snap)));
    expect(r.contentHash).toBe(tariffContentHash(snap));
  });

  it('fiyat değişince yeni sürüm; ad, etkinlik, varsayılan, geçerlilik ve satır sırası değişince doğmaz', async () => {
    const t = await createTariff();
    const p = payload({ name: t.name });
    const [first] = await revisions(t.id);

    // aynı içerik yeniden kaydedilir
    expect((await put(`/api/deciship/tariffs/${t.id}`, p)).statusCode).toBe(200);
    // satırların sırası değişir, ülke küçük harf
    const reordered = {
      ...p,
      zones: [...p.zones].reverse().map((z) => ({ ...z, country: z.country.toLowerCase() })),
      rates: [...p.rates].reverse(),
      overflow: [...p.overflow].reverse(),
      surcharges: [...p.surcharges].reverse(),
    };
    expect((await put(`/api/deciship/tariffs/${t.id}`, reordered)).statusCode).toBe(200);
    // ad, etkinlik, geçerlilik
    const renamed = { ...p, name: `${t.name} yeni`, active: false, validFrom: '2026-03-01', validTo: null };
    expect((await put(`/api/deciship/tariffs/${t.id}`, renamed)).statusCode).toBe(200);
    // varsayılan (PUT ile ve tek tıkla)
    expect((await put(`/api/deciship/tariffs/${t.id}`, { ...renamed, active: true, isDefault: true })).statusCode).toBe(200);
    await put(`/api/deciship/tariffs/${t.id}`, { ...renamed, active: true, isDefault: false });
    expect((await post(`/api/deciship/tariffs/${t.id}/default`)).statusCode).toBe(200);
    let revs = await revisions(t.id);
    expect(revs.map((r) => r.id)).toEqual([first!.id]);
    // ad değişince güncel sürümün adı izler (silinen tarifenin faturalarında bu ad görünür); içerik aynı
    expect(revs[0]!.tariffName).toBe(`${t.name} yeni`);
    expect(revs[0]!.contentHash).toBe(first!.contentHash);
    expect(revs[0]!.snapshot).toEqual(first!.snapshot);

    // fiyat değişir
    const priced = { ...renamed, active: true, rates: p.rates.map((r, i) => (i === 0 ? { ...r, price: 16 } : r)) };
    expect((await put(`/api/deciship/tariffs/${t.id}`, priced)).statusCode).toBe(200);
    revs = await revisions(t.id);
    expect(revs).toHaveLength(2);
    expect(revs[1]!.contentHash).not.toBe(revs[0]!.contentHash);
    expect((await currentOf(t.id)).currentRevisionId).toBe(revs[1]!.id);
    // eski sürüm değişmedi
    expect(revs[0]!.snapshot).toEqual(first!.snapshot);
    // geri alınan fiyat da yeni sürümdür (son sürümle karşılaştırılır)
    expect((await put(`/api/deciship/tariffs/${t.id}`, { ...priced, rates: p.rates })).statusCode).toBe(200);
    revs = await revisions(t.id);
    expect(revs).toHaveLength(3);
    expect(revs[2]!.contentHash).toBe(revs[0]!.contentHash);
  });

  it('kopyalama kendi sürümünü açar; içerik aynı olduğundan özet de aynı', async () => {
    const t = await createTariff();
    const dup = await post(`/api/deciship/tariffs/${t.id}/duplicate`);
    expect(dup.statusCode, dup.body).toBe(201);
    const [a] = await revisions(t.id);
    const b = await revisions(dup.json().tariff.id);
    expect(b).toHaveLength(1);
    expect(b[0]!.id).not.toBe(a!.id);
    expect(b[0]!.contentHash).toBe(a!.contentHash);
    expect(b[0]!.tariffName).toBe(`${t.name} (kopya)`);
  });

  it('ülke istisnası ekleme ve kaldırma yeni sürüm doğurur', async () => {
    const t = await createTariff();
    const add = await post(`/api/deciship/tariffs/${t.id}/country-adjustments`, { country: 'DE', pct: -12.5 });
    expect(add.statusCode, add.body).toBe(200);
    let revs = await revisions(t.id);
    expect(revs).toHaveLength(2);
    expect((revs[1]!.snapshot as TariffBody).countryAdjustments).toMatchObject([{ country: 'DE', pct: -12.5 }]);
    expect((await currentOf(t.id)).currentRevisionId).toBe(revs[1]!.id);
    // aynı istisna yeniden (yalnız not farklı) → sürüm doğmaz
    expect((await post(`/api/deciship/tariffs/${t.id}/country-adjustments`, { country: 'DE', pct: -12.5, note: 'not' })).statusCode).toBe(200);
    expect(await revisions(t.id)).toHaveLength(2);
    const del = await post(`/api/deciship/tariffs/${t.id}/country-adjustments`, { country: 'DE', pct: 0 });
    expect(del.statusCode, del.body).toBe(200);
    revs = await revisions(t.id);
    expect(revs).toHaveLength(3);
    expect(revs[2]!.contentHash).toBe(revs[0]!.contentHash);
  });

  it('içe aktarma ve geri yükleme yeni sürüm doğurur', async () => {
    const t = await createTariff();
    const other = await createTariff({ rates: [{ zone: 'A', weightUpto: 1, price: 99 }, { zone: 'B', weightUpto: 1, price: 98 }, { zone: 'TR', weightUpto: 1, price: 97 }] });
    const tpl = await get(`/api/deciship/tariffs/template.xlsx?tariffId=${other.id}`);
    expect(tpl.statusCode).toBe(200);
    const form = multipart([{ name: 'file', filename: 'yeni.xlsx', contentType: XLSX_MIME, data: tpl.rawPayload }]);
    const pv = await app.inject({ method: 'POST', url: `/api/deciship/tariffs/${t.id}/import`, headers: { ...auth, ...form.headers }, payload: form.payload });
    expect(pv.statusCode, pv.body).toBe(200);
    const ap = await post(`/api/deciship/tariff-imports/${pv.json().draftId}/apply`, { options: {}, acknowledged: true });
    expect(ap.statusCode, ap.body).toBe(200);
    let revs = await revisions(t.id);
    expect(revs).toHaveLength(2);
    expect((await currentOf(t.id)).currentRevisionId).toBe(revs[1]!.id);
    expect((revs[1]!.snapshot as TariffBody).rates.map((r) => r.price).sort()).toEqual([97, 98, 99]);

    // içe aktarmadan önceki hâle geri yükleme: yeni sürüm (içerik ilk sürümle aynı)
    const restore = await post(`/api/deciship/tariffs/${t.id}/versions/${ap.json().versionId}/restore`);
    expect(restore.statusCode, restore.body).toBe(200);
    revs = await revisions(t.id);
    expect(revs).toHaveLength(3);
    expect(revs[2]!.contentHash).toBe(revs[0]!.contentHash);
    expect((await currentOf(t.id)).currentRevisionId).toBe(revs[2]!.id);
  });

  it('içe aktarmayla yeni tarife sürümüyle doğar', async () => {
    const other = await createTariff();
    const tpl = await get(`/api/deciship/tariffs/template.xlsx?tariffId=${other.id}`);
    const form = multipart([
      { name: 'carrierId', value: carrierId },
      { name: 'file', filename: 'yeni.xlsx', contentType: XLSX_MIME, data: tpl.rawPayload },
    ]);
    const pv = await app.inject({ method: 'POST', url: '/api/deciship/tariff-imports', headers: { ...auth, ...form.headers }, payload: form.payload });
    expect(pv.statusCode, pv.body).toBe(200);
    const ap = await post(`/api/deciship/tariff-imports/${pv.json().draftId}/apply`, { options: {}, acknowledged: true, meta: { name: uniq('İçe ') } });
    expect(ap.statusCode, ap.body).toBe(200);
    const id = ap.json().tariff.id as string;
    const revs = await revisions(id);
    expect(revs).toHaveLength(1);
    expect((await currentOf(id)).currentRevisionId).toBe(revs[0]!.id);
  });

  it("backfill sürümünde (contentHash boş) ilk çağrı özeti doldurur, yeni sürüm açmaz; updatedAt oynamaz", async () => {
    const t = await createTariff();
    const [r] = await revisions(t.id);
    await inCompany(auth, () => prisma.tariffRevision.updateMany({ where: { id: r!.id }, data: { contentHash: null } }));
    const before = await currentOf(t.id);
    const res = await inCompany(auth, () => prisma.$transaction((tx) => ensureTariffRevision(tx, t.id, companyId)));
    expect(res).toEqual({ id: r!.id, created: false });
    const revs = await revisions(t.id);
    expect(revs).toHaveLength(1);
    expect(revs[0]!.contentHash).toBe(r!.contentHash);
    expect((await currentOf(t.id)).updatedAt).toEqual(before.updatedAt);

    // backfill sürümünün içeriği bugünkü tarifeden farklıysa yeni sürüm açılır, eski sürüm dokunulmadan kalır
    await inCompany(auth, () => prisma.tariffRevision.updateMany({ where: { id: r!.id }, data: { contentHash: null } }));
    await inCompany(auth, () => prisma.tariff.update({ where: { id: t.id }, data: { discountPct: 7 } }));
    const res2 = await inCompany(auth, () => prisma.$transaction((tx) => ensureTariffRevision(tx, t.id, companyId)));
    expect(res2.created).toBe(true);
    const revs2 = await revisions(t.id);
    expect(revs2).toHaveLength(2);
    expect(revs2[0]!.contentHash).toBeNull();
    expect((revs2[1]!.snapshot as TariffBody).discountPct).toBe(7);
  });

  it('özet başka kuralla yazılmışsa (özete giren alanlar değişti) içerik aynıysa yeni sürüm açılmaz, etiket düzelir', async () => {
    const t = await createTariff();
    const [r] = await revisions(t.id);
    await inCompany(auth, () => prisma.tariffRevision.updateMany({ where: { id: r!.id }, data: { contentHash: 'eski-kural' } }));
    const res = await inCompany(auth, () => prisma.$transaction((tx) => ensureTariffRevision(tx, t.id, companyId)));
    expect(res).toEqual({ id: r!.id, created: false });
    const revs = await revisions(t.id);
    expect(revs).toHaveLength(1);
    expect(revs[0]!.contentHash).toBe(r!.contentHash);
  });

  it('eşzamanlı iki çağrı tek sürüm açar', async () => {
    const t = await createTariff();
    await inCompany(auth, () => prisma.tariff.update({ where: { id: t.id }, data: { fuelPct: 3 } }));
    const run = () => inCompany(auth, () => prisma.$transaction((tx) => ensureTariffRevision(tx, t.id, companyId)));
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.id).toBe(b.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await revisions(t.id)).toHaveLength(2);
  });

  it('tarife silinince sürüm durur, tariffId boşalır; fatura sürümünde kalır; silmeden önce sayı GET ile gelir', async () => {
    const t = await createTariff();
    const [r] = await revisions(t.id);
    const inv = await pinnedInvoice(r!.id, t.id);
    await pinnedInvoice(r!.id, t.id).then((i) => inCompany(auth, () => prisma.invoice.update({ where: { id: i.id }, data: { deletedAt: new Date() } })));
    const info = await get(`/api/deciship/tariffs/${t.id}`);
    expect(info.json().pinnedInvoices).toBe(1);

    expect((await app.inject({ method: 'DELETE', url: `/api/deciship/tariffs/${t.id}`, headers: auth })).statusCode).toBe(204);
    const kept = await inCompany(auth, () => prisma.tariffRevision.findFirst({ where: { id: r!.id } }));
    expect(kept).toMatchObject({ id: r!.id, tariffId: null, tariffName: t.name, contentHash: r!.contentHash });
    expect(kept!.snapshot).toEqual(r!.snapshot);
    const after = await inCompany(auth, () => prisma.invoice.findFirstOrThrow({ where: { id: inv.id }, select: { tariffId: true, tariffRevisionId: true } }));
    expect(after).toEqual({ tariffId: null, tariffRevisionId: r!.id });
  });

  it('başka firmanın sürümüne erişilemez', async () => {
    const t = await createTariff();
    const [r] = await revisions(t.id);
    const b = await registerCompany(app, uniq('Başka '));
    expect(await inCompany(b.auth, () => prisma.tariffRevision.findFirst({ where: { id: r!.id } }))).toBeNull();
    expect(await inCompany(b.auth, () => prisma.tariffRevision.count({ where: { tariffId: t.id } }))).toBe(0);
    await expect(inCompany(b.auth, () => prisma.$transaction((tx) => ensureTariffRevision(tx, t.id, b.companyId)))).rejects.toThrow();
    // başka firmanın kimliğiyle çağrı (RLS bağlamı uyuşmaz) da sürüm açmaz
    await expect(inCompany(b.auth, () => prisma.$transaction((tx) => ensureTariffRevision(tx, t.id, companyId)))).rejects.toThrow();
    expect(await revisions(t.id)).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `/api/deciship/tariffs/${t.id}`, headers: b.auth })).statusCode).toBe(404);
  });

  it('veri sıfırlama sürümleri temizler; örnek veri tarifeleri sürümle doğar', async () => {
    const a = await registerCompany(app, uniq('Sıfır '));
    const loaded = await app.inject({ method: 'POST', url: '/api/deciship/settings/data/reset', headers: a.auth, payload: { confirm: true, samples: true } });
    expect(loaded.statusCode, loaded.body).toBe(200);
    const tariffs = await inCompany(a.auth, () => prisma.tariff.findMany({ select: { id: true, currentRevisionId: true } }));
    expect(tariffs.length).toBeGreaterThan(0);
    for (const t of tariffs) expect(t.currentRevisionId).toBeTruthy();
    const revs = await inCompany(a.auth, () => prisma.tariffRevision.findMany());
    expect(revs).toHaveLength(tariffs.length);
    expect(revs.every((r) => r.contentHash)).toBe(true);

    // bir fatura sürüme bağlıyken de sıfırlama 23503 vermez
    const carrier = await inCompany(a.auth, () => prisma.carrier.findFirstOrThrow());
    await inCompany(a.auth, async () => {
      const file = await prisma.file.create({ data: { companyId: a.companyId, kind: 'INVOICE_SOURCE', mime: 'text/csv', size: 1, path: 'yok/x.csv', sha256: 'x', createdById: a.userId } });
      await prisma.invoice.create({
        data: { companyId: a.companyId, carrierId: carrier.id, tariffRevisionId: revs[0]!.id, invoiceNo: 'F1', invoiceDate: new Date(), currency: 'TRY', sourceFileId: file.id, mapping: {}, totals: {} },
      });
    });
    const cleared = await app.inject({ method: 'POST', url: '/api/deciship/settings/data/reset', headers: a.auth, payload: { confirm: true } });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(await inCompany(a.auth, () => prisma.tariffRevision.count())).toBe(0);
    expect(await inCompany(a.auth, () => prisma.tariff.count())).toBe(0);
  });
});

describe('ek ücret adı ve taşıyıcı (inceleme 8)', () => {
  const basisOf = async (invoiceId: string) => {
    const r = await get(`/api/deciship/invoices/${invoiceId}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json().invoice.basis as { state: string; tariffName: string | null };
  };

  it('ek ücretin yalnız adı değişince sürüm doğmaz; faturada "Tarife değişti" çıkmaz', async () => {
    const t = await createTariff();
    const [r] = await revisions(t.id);
    const inv = await pinnedInvoice(r!.id, t.id);
    expect((await basisOf(inv.id)).state).toBe('CURRENT');
    const p = payload({ name: t.name });
    const renamed = { ...p, surcharges: p.surcharges.map((s: { name?: string }) => ({ ...s, name: `${s.name} (yeni)` })) };
    expect((await put(`/api/deciship/tariffs/${t.id}`, renamed)).statusCode).toBe(200);
    expect((await revisions(t.id)).map((x) => x.id)).toEqual([r!.id]);
    expect((await basisOf(inv.id)).state).toBe('CURRENT');
  });

  it('taşıyıcı değişince yeni sürüm doğar; eski taşıyıcının faturası eski sürümde kalır, tarifesiz kalmaz, durum "tarife yok"', async () => {
    const carrierOf = async (code: string) => {
      const c = await post('/api/deciship/carriers', { code, name: uniq(`${code} `) });
      expect(c.statusCode, c.body).toBe(201);
      return c.json().carrier.id as string;
    };
    // yalnız bu tarifesi olan taşıyıcı A
    const own = await carrierOf('mng');
    const otherId = await carrierOf('ups');
    const t = await createTariff({ carrierId: own });
    const [r1] = await revisions(t.id);
    const inv = await pinnedInvoice(r1!.id, t.id, own);

    const moved = await put(`/api/deciship/tariffs/${t.id}`, { ...payload({ name: t.name }), carrierId: otherId });
    expect(moved.statusCode, moved.body).toBe(200);
    const revs = await revisions(t.id);
    expect(revs).toHaveLength(2);
    expect([(revs[0]!.snapshot as TariffBody).carrierId, (revs[1]!.snapshot as TariffBody).carrierId]).toEqual([own, otherId]);
    expect((await currentOf(t.id)).currentRevisionId).toBe(revs[1]!.id);

    // eski taşıyıcının faturası için tarife artık yok: bant "tarife yok", eylem yok
    expect((await basisOf(inv.id)).state).toBe('TARIFF_REMOVED');
    // "Yeni tarifeyle hesapla" (taşıyıcının başka tarifesi yok) faturayı tarifesiz bırakmaz: kendi taşıyıcısının sürümünde kalır
    const r = await inCompany(auth, () => applyRecompare(inv.id, { basis: 'tariff', scope: 'all' }));
    expect(typeof r === 'object' && r ? r.summary.revisionTo : r).toBe(r1!.id);
    // ayar geçişi tarife parçasına dokunmaz
    const s = await inCompany(auth, () => applyRecompare(inv.id, { basis: 'rules', scope: 'all' }));
    expect(typeof s === 'object' && s ? s.summary.revisionTo : s).toBe(r1!.id);
    expect((await inCompany(auth, () => prisma.invoice.findFirstOrThrow({ where: { id: inv.id } }))).tariffRevisionId).toBe(r1!.id);
  });
});
