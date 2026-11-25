/**
 * Mesaj 4, geçmiş sonuçlar donsun: hesap motoru (services/compare.ts).
 *
 *  - Hesabın kaynağı canlı tarife değil tarifenin sürümüdür: tarife değişse ya da silinse de fatura aynı rakamda kalır.
 *  - Firma ayarı (tolerans) faturaya yazılır; ayar değişince fatura eski ayarla kalır.
 *  - Ölçüm değişince açık satır yeni ölçümle hesaplanır, eski rakam `prevResult`'ta kalır; karar verilmiş ve itirazdaki
 *    satır yazılmaz, `recalcPending` ile işaretlenir.
 *  - Önizleme yazmaz; onay önizlemenin özetiyle (`token`) gelir, tutmuyorsa `PREVIEW_STALE`.
 *
 * Uçlar henüz yok: servis işlevleri doğrudan, mevcut uçlarla (içe aktarma, ölçüm, karar, tarife, ayar, itiraz) birlikte.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { compareLine, type ParsedInvoiceLine, type TariffInput } from '@deciship/core';
import { describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import {
  applyRecompare,
  compareSettingsOf,
  computeTotals,
  invoiceBasisState,
  invoicesOnOldRevisions,
  invoicesWithOtherSettings,
  loadBasisInfo,
  previewRecompare,
  recompareInvoice,
  recompareLaterDuplicates,
  resolveCurrentBasis,
  sameCompareSettings,
  settleMeasurementRecompare,
  snapshotToTariffInput,
  tariffInclude,
  toTariffInput,
  type ApplyRecompareResult,
  type InvoiceTotals,
  type PrevResult,
  type RecompareComputation,
} from '../src/services/compare.ts';
import { readSettings } from '../src/lib/settings.ts';
import { applyBulk, previewBulk } from '../src/services/bulkRecalc.ts';
import { invoiceTariffHealth } from '../src/services/tariffHealth.ts';
import { createTariff, tariffBody } from '../src/services/tariffs.ts';
import { digestOf, disputeCompany, invoiceWithDiffs, trDay } from './disputeHelpers.ts';
import { createWorker, getApp, inCompany, measurementPayload, multipart, registerCompany, SAMPLES, uniq } from './helpers.ts';

const API = '/api/deciship';
type Auth = { authorization: string };

/** Yalnız rakam: normalleştirme numarayı değiştirmez. */
const trackingNo = () => `7948${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;

/** Desi başına `perKg` TL; yakıt ve ek ücret yok: 3 desi → 3 × perKg. */
const tariffOf = (carrierId: string, perKg: number, over: Record<string, unknown> = {}) => ({
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
  ...over,
});

type Firm = { app: FastifyInstance; auth: Auth; worker: Auth; companyId: string; carrierId: string; tariffId: string };

async function firm(app: FastifyInstance, opts: { tariff?: boolean } = {}): Promise<Firm> {
  const admin = await registerCompany(app, uniq('Donmuş '));
  const worker = await createWorker(app, admin.auth);
  const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'aras', name: uniq('Aras ') } });
  expect(c.statusCode, c.body).toBe(201);
  const carrierId = c.json().carrier.id as string;
  let tariffId = '';
  if (opts.tariff !== false) {
    const t = await app.inject({ method: 'POST', url: `${API}/tariffs`, headers: admin.auth, payload: tariffOf(carrierId, 10) });
    expect(t.statusCode, t.body).toBe(201);
    tariffId = t.json().tariff.id;
  }
  return { app, auth: admin.auth, worker: worker.auth, companyId: admin.companyId, carrierId, tariffId };
}

/** 26×25×16 = 10.400 cm³ → 4 desi; kenar payıyla (27×26×17) da 4: faturadaki 5 desi yine fark. */
const FOUR_DESI = { lengthCm: 26, widthCm: 25, heightCm: 16 };

/**
 * 30×20×15 cm, 2 kg = 3 desi. Fatura satırı 5 desi, 50 TL. Tarife 10 TL/desi iken beklenen 30, fark 20.
 * Tarife UCUZLARSA beklenen düşer (8 TL/desi → 24); pahalanırsa değişmez (taşıyıcının kendi fiyatı ölçeklenir, SPEC §3.8):
 * bu yüzden "yeni fiyat" sınamaları fiyatı düşürür.
 */
async function measure(f: Firm, tracking: string, dims: { lengthCm: number; widthCm: number; heightCm: number } = { lengthCm: 30, widthCm: 20, heightCm: 15 }) {
  const p = measurementPayload({ trackingRaw: tracking, ...dims, weightKg: 2 });
  const r = await f.app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...f.worker, ...p.headers }, payload: p.payload });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().measurement.id as string;
}

/** Düzeltme: yeni sürüm doğar, eski sürümün yerini alır. */
async function correct(f: Firm, tracking: string, dims: { lengthCm: number; widthCm: number; heightCm: number }) {
  const head = await inCompany(f.auth, () => prisma.measurement.findFirstOrThrow({ where: { trackingNo: tracking, supersededById: null, deletedAt: null } }));
  const r = await f.app.inject({ method: 'PATCH', url: `${API}/measurements/${head.id}`, headers: f.worker, payload: dims });
  expect(r.statusCode, r.body).toBe(200);
  return (await inCompany(f.auth, () => prisma.measurement.findFirstOrThrow({ where: { trackingNo: tracking, supersededById: null, deletedAt: null } }))).id;
}

/**
 * Faturayı uçtan içe aktarır (her satır 5 desi, 50 TL). İçe aktarma ucu dayanağı henüz yazmıyor (sonraki adım): fatura
 * "dayanağı hiç yazılmamış" doğar ve ilk yeniden karşılaştırmada güncel dayanağa bağlanır; burada o adım atılır.
 */
async function importInvoice(f: Firm, trackings: string[], opts: { pin?: boolean; confirmOverlap?: boolean; amount?: number } = {}) {
  const csv = ['Takip No;Desi;Tutar', ...trackings.map((t) => `${t};5;${opts.amount ?? 50}`)].join('\n');
  const form = multipart([
    { name: 'carrierId', value: f.carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
  ]);
  const preview = await f.app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...f.auth, ...form.headers }, payload: form.payload });
  expect(preview.statusCode, preview.body).toBe(200);
  const inv = await f.app.inject({
    method: 'POST',
    url: `${API}/invoices`,
    headers: f.auth,
    payload: {
      fileId: preview.json().fileId,
      carrierId: f.carrierId,
      invoiceNo: uniq('F'),
      invoiceDate: '2026-10-15',
      currency: 'TRY',
      mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
      acknowledgeIssues: true,
      ...(opts.confirmOverlap ? { confirmOverlap: true } : {}),
    },
  });
  expect(inv.statusCode, inv.body).toBe(201);
  const id = inv.json().invoice.id as string;
  if (opts.pin !== false) await inCompany(f.auth, () => recompareInvoice(id));
  return id;
}

const invoiceRow = (f: { auth: Auth }, id: string) => inCompany(f.auth, () => prisma.invoice.findFirstOrThrow({ where: { id } }));
const lineRows = (f: { auth: Auth }, invoiceId: string) => inCompany(f.auth, () => prisma.invoiceLine.findMany({ where: { invoiceId }, orderBy: { rowIndex: 'asc' } }));
const lineBy = async (f: { auth: Auth }, invoiceId: string, tracking: string) => (await lineRows(f, invoiceId)).find((l) => l.trackingNo === tracking)!;
const money = (l: { status: string; expectedAmount: unknown; diffAmount: unknown }) => [l.status, l.expectedAmount == null ? null : Number(l.expectedAmount), l.diffAmount == null ? null : Number(l.diffAmount)];
const totalsOf = async (f: { auth: Auth }, id: string) => (await invoiceRow(f, id)).totals as InvoiceTotals;
const currentRevision = async (f: Firm, tariffId = f.tariffId) => (await inCompany(f.auth, () => prisma.tariff.findFirstOrThrow({ where: { id: tariffId } }))).currentRevisionId;

/** Satırların ve faturanın yazılıp yazılmadığını görmek için: kimlik → değişme anı, tutarlar. */
async function fingerprint(f: { auth: Auth }, invoiceId: string) {
  const inv = await invoiceRow(f, invoiceId);
  const lines = await lineRows(f, invoiceId);
  return {
    invoice: [+inv.updatedAt, inv.tariffRevisionId, JSON.stringify(inv.compareSettings), JSON.stringify(inv.totals)],
    lines: lines.map((l) => [l.id, +l.updatedAt, ...money(l), l.measurementId, l.tariffRevisionId, l.recalcPending, JSON.stringify(l.prevResult)]),
  };
}

const decide = async (f: { auth: Auth }, app: FastifyInstance, lineId: string, payload: Record<string, unknown>) => {
  const r = await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${lineId}`, headers: f.auth, payload });
  expect(r.statusCode, r.body).toBe(200);
};
const putTariff = async (f: Firm, perKg: number, over: Record<string, unknown> = {}) => {
  const r = await f.app.inject({ method: 'PUT', url: `${API}/tariffs/${f.tariffId}`, headers: f.auth, payload: tariffOf(f.carrierId, perKg, over) });
  expect(r.statusCode, r.body).toBe(200);
};
const ok = <T>(r: T | string | null): Exclude<T, string | null> => {
  expect(typeof r, String(r)).toBe('object');
  expect(r).not.toBeNull();
  return r as Exclude<T, string | null>;
};
const applied = (r: ApplyRecompareResult | string | null) => ok<ApplyRecompareResult>(r);
const previewed = (r: RecompareComputation | string | null) => ok<RecompareComputation>(r);
const basisState = async (f: Firm, invoiceId: string) => {
  const inv = await invoiceRow(f, invoiceId);
  return inCompany(f.auth, async () => {
    const info = await loadBasisInfo(f.companyId, [inv.tariffRevisionId]);
    const company = await prisma.company.findFirstOrThrow({ where: { id: f.companyId } });
    return invoiceBasisState(inv, info.get(inv.tariffRevisionId ?? '')?.tariff ?? null, readSettings(company.settings));
  });
};

describe('tarife değişince fatura donmuş kalır', () => {
  it('fiyat değişir (PUT): satırlar ve toplam değişmez; ölçüm, bakım, mükerrer zinciri ve "Yeniden karşılaştır" eski fiyatla sürer', async () => {
    const app = await getApp();
    const f = await firm(app);
    const [a, b] = [trackingNo(), trackingNo()];
    await measure(f, a);
    const id = await importInvoice(f, [a, b]);
    const rev1 = await currentRevision(f);
    const inv = await invoiceRow(f, id);
    // dayanağı yazılmamış fatura ilk hesapta güncel dayanağa bağlandı
    expect(inv.tariffRevisionId).toBe(rev1);
    expect(sameCompareSettings(inv.compareSettings as never, compareSettingsOf(readSettings({})))).toBe(true);
    expect(money(await lineBy(f, id, a))).toEqual(['DIFF', 30, 20]);
    expect((await lineBy(f, id, a)).tariffRevisionId).toBe(rev1);
    expect((await lineBy(f, id, b)).status).toBe('UNMATCHED');
    expect(await basisState(f, id)).toBe('CURRENT');
    const before = await fingerprint(f, id);

    await putTariff(f, 8);
    const rev2 = await currentRevision(f);
    expect(rev2).not.toBe(rev1);
    expect(await fingerprint(f, id)).toEqual(before);
    expect(await basisState(f, id)).toBe('TARIFF_CHANGED');
    expect((await inCompany(f.auth, () => invoicesOnOldRevisions(f.companyId, f.tariffId))).map((x) => x.id)).toEqual([id]);

    // ölçüm kaydı: ölçülmemiş satır ESKİ fiyatla hesaplanır (3 desi × 10; yeni fiyatla 24 olurdu)
    const mB = await measure(f, b);
    expect(money(await lineBy(f, id, b))).toEqual(['DIFF', 30, 20]);
    expect((await lineBy(f, id, b)).tariffRevisionId).toBe(rev1);
    // bakım işinin çağırdığı yol
    await inCompany(f.auth, () => settleMeasurementRecompare(f.companyId, mB, null));
    // mükerrer zinciri: aynı numarayı taşıyan sonraki fatura eklenip silinir, bu fatura yeniden karşılaştırılır
    await inCompany(f.auth, () => recompareLaterDuplicates(f.companyId, id, [a, b]));
    // "Yeniden karşılaştır" ucu (bugün: sabit dayanak, açık satırlar)
    const re = await app.inject({ method: 'POST', url: `${API}/invoices/${id}/recompare`, headers: f.auth });
    expect(re.statusCode, re.body).toBe(200);
    // düzeltme: 4 desi × 10 = 40 (yeni fiyatla 32 olurdu)
    await correct(f, a, FOUR_DESI);

    expect(money(await lineBy(f, id, a))).toEqual(['DIFF', 40, 10]);
    expect(money(await lineBy(f, id, b))).toEqual(['DIFF', 30, 20]);
    const after = await invoiceRow(f, id);
    expect(after.tariffRevisionId).toBe(rev1);
    expect((after.totals as InvoiceTotals).expectedTotal).toBe(70);
    expect((after.totals as InvoiceTotals).overchargeTotal).toBe(30);
    // tarife uyumu raporu da faturanın sürümünü okur
    const health = await inCompany(f.auth, () => invoiceTariffHealth(id, f.companyId));
    expect(health.tariff).toMatchObject({ id: f.tariffId, revisionId: rev1, removed: false });
  });

  it('"yeni tarifeyle hesapla" (tariff + all): yeni fiyat geçer, eski rakam prevResult\'ta, fatura yalnız yeni sürüme bağlanır; ayar ayrıca "yeni ayarla hesapla" ile', async () => {
    const app = await getApp();
    const f = await firm(app);
    const [a, b] = [trackingNo(), trackingNo()];
    await measure(f, a);
    await measure(f, b);
    const id = await importInvoice(f, [a, b]);
    const rev1 = await currentRevision(f);
    const lineB = await lineBy(f, id, b);
    await decide(f, app, lineB.id, { decision: 'VERIFIED' });
    await putTariff(f, 8);
    const rev2 = await currentRevision(f);
    const set = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: f.auth, payload: { amountTol: 7 } });
    expect(set.statusCode, set.body).toBe(200);

    const oldSettings = (await invoiceRow(f, id)).compareSettings;
    expect(oldSettings).toMatchObject({ amountTol: 5 });
    // ikisi de değişti: önce tarife (durum TARIFF_CHANGED)
    expect(await basisState(f, id)).toBe('TARIFF_CHANGED');
    // neden verilmedi: tarife sürümü değiştiği için TARIFF
    const r = applied(await inCompany(f.auth, () => applyRecompare(id, { basis: 'tariff', scope: 'all' })));
    // 3 desi × 8 = 24; fark 26
    for (const t of [a, b]) {
      const l = await lineBy(f, id, t);
      expect(money(l)).toEqual(['DIFF', 24, 26]);
      expect(l.tariffRevisionId).toBe(rev2);
      expect(l.prevResult as PrevResult).toMatchObject({ status: 'DIFF', diffTypes: l.diffTypes, expectedAmount: 30, diffAmount: 20, ourChargeableKg: 3, measurementId: l.measurementId, tariffRevisionId: rev1, cause: 'TARIFF' });
      expect(Number.isNaN(Date.parse((l.prevResult as PrevResult).at))).toBe(false);
    }
    // karar durumu değişmez
    expect((await lineBy(f, id, b)).decision).toBe('VERIFIED');
    const inv = await invoiceRow(f, id);
    expect(inv.tariffRevisionId).toBe(rev2);
    // ayar parçası faturadaki gibi kalır
    expect(inv.compareSettings).toEqual(oldSettings);
    expect(r.summary).toMatchObject({ basis: 'tariff', cause: 'TARIFF', revisionFrom: rev1, revisionTo: rev2, changedLines: 2 });
    expect(r.summary.totalsBefore.expectedTotal).toBe(60);
    expect(r.summary.totalsAfter.expectedTotal).toBe(48);
    expect(r.totals).toEqual(inv.totals);
    expect(r.frozenChanged).toBe(1);
    expect(await basisState(f, id)).toBe('RULES_CHANGED');
    expect(await inCompany(f.auth, () => invoicesOnOldRevisions(f.companyId, f.tariffId))).toEqual([]);

    // ikinci kez: değişiklik yok, önceki rakam bir adım olarak kalır (üstüne yazılmaz)
    const again = applied(await inCompany(f.auth, () => applyRecompare(id, { basis: 'tariff', scope: 'all' })));
    expect([again.writtenLines, again.summary.changedLines]).toEqual([0, 0]);
    expect(((await lineBy(f, id, a)).prevResult as PrevResult).expectedAmount).toBe(30);

    // ardından "yeni ayarla hesapla": yalnız ayar geçer, tarife sürümü aynı kalır
    const rules = applied(await inCompany(f.auth, () => applyRecompare(id, { basis: 'rules', scope: 'all' })));
    expect(rules.summary).toMatchObject({ basis: 'rules', cause: 'RULES', revisionFrom: rev2, revisionTo: rev2 });
    const inv2 = await invoiceRow(f, id);
    expect(inv2.tariffRevisionId).toBe(rev2);
    expect(inv2.compareSettings).toMatchObject({ amountTol: 7, companyCurrency: 'TRY' });
    expect(await basisState(f, id)).toBe('CURRENT');
  });

  it('tarife silinir: fatura aynı rakamda kalır, sabit dayanakla hesap aynı sonucu verir, ad sürümden okunur', async () => {
    const app = await getApp();
    const f = await firm(app);
    const [a, b] = [trackingNo(), trackingNo()];
    await measure(f, a);
    const id = await importInvoice(f, [a, b]);
    const rev1 = await currentRevision(f);
    const before = await fingerprint(f, id);

    const del = await app.inject({ method: 'DELETE', url: `${API}/tariffs/${f.tariffId}`, headers: f.auth });
    expect(del.statusCode, del.body).toBe(204);
    const inv = await invoiceRow(f, id);
    expect([inv.tariffId, inv.tariffRevisionId]).toEqual([null, rev1]);
    expect(JSON.stringify(inv.totals)).toBe(before.invoice[3]);
    expect(money(await lineBy(f, id, a))).toEqual(['DIFF', 30, 20]);
    expect(await basisState(f, id)).toBe('TARIFF_REMOVED');
    const info = (await inCompany(f.auth, () => loadBasisInfo(f.companyId, [rev1]))).get(rev1!)!;
    expect([info.tariffName, info.tariff]).toEqual(['Sabit', null]);

    // kullanıcının "Yeniden karşılaştır"ı: hiçbir rakam değişmez
    const p = previewed(await inCompany(f.auth, () => previewRecompare(id, { basis: 'pinned' })));
    expect([p.changedLines, p.to.tariffRevisionId, p.to.tariffName]).toEqual([0, rev1, 'Sabit']);
    const r = applied(await inCompany(f.auth, () => applyRecompare(id, { basis: 'pinned', scope: 'all' })));
    expect(r.summary.changedLines).toBe(0);
    expect(money(await lineBy(f, id, a))).toEqual(['DIFF', 30, 20]);
    // yeni ölçüm silinmiş tarifenin sürümüyle fiyatlanır
    await measure(f, b);
    const lb = await lineBy(f, id, b);
    expect(money(lb)).toEqual(['DIFF', 30, 20]);
    expect([lb.tariffId, lb.tariffRevisionId]).toEqual([null, rev1]);
    expect((await invoiceRow(f, id)).tariffRevisionId).toBe(rev1);
    const health = await inCompany(f.auth, () => invoiceTariffHealth(id, f.companyId));
    expect(health.tariff).toMatchObject({ id: null, name: 'Sabit', removed: true, revisionId: rev1 });
    // güncel tarife yok: "yeni tarifeyle hesapla" da faturayı tarifesiz bırakmaz, sürümü korur
    const cur = applied(await inCompany(f.auth, () => applyRecompare(id, { basis: 'tariff', scope: 'all' })));
    expect(cur.summary.revisionTo).toBe(rev1);
    expect(money(await lineBy(f, id, a))).toEqual(['DIFF', 30, 20]);
  });
});

describe('geçerlilik notu canlı tarifeden okunur (tarihler sürüm doğurmaz)', () => {
  it('yalnız tarih değişince sürüm aynı kalır, "Yeniden karşılaştır" notu yeni tarihle yazar; tarife silinince sürümdeki tarih', async () => {
    const app = await getApp();
    const f = await firm(app);
    await putTariff(f, 10, { validFrom: '2026-01-01', validTo: '2026-12-31' });
    const rev = await currentRevision(f);
    const a = trackingNo();
    await measure(f, a);
    const id = await importInvoice(f, [a]);
    const note = async () => (await lineBy(f, id, a)).note ?? '';
    expect(await note()).not.toContain('geçerli değil');

    // fatura günü (2026-10-15) yeni geçerlilik aralığının dışında; fiyat aynı, yeni sürüm yok
    await putTariff(f, 10, { validFrom: '2026-01-01', validTo: '2026-06-30' });
    expect(await currentRevision(f)).toBe(rev);
    applied(await inCompany(f.auth, () => applyRecompare(id, { basis: 'pinned', scope: 'all' })));
    expect(await note()).toContain('2026-10-15 tarihinde geçerli değil (geçerlilik: 2026-01-01 – 2026-06-30)');
    expect(money(await lineBy(f, id, a))).toEqual(['DIFF', 30, 20]);

    // tarih geri alınınca not da kalkar
    await putTariff(f, 10, { validFrom: '2026-01-01', validTo: null });
    applied(await inCompany(f.auth, () => applyRecompare(id, { basis: 'pinned', scope: 'all' })));
    expect(await note()).not.toContain('geçerli değil');

    // canlı tarih fatura gününü dışarıda bırakır; tarife silinince sürümdeki tarih okunur (sürüm tarihsiz doğdu): not yok, rakam aynı
    await putTariff(f, 10, { validFrom: '2026-11-01', validTo: null });
    applied(await inCompany(f.auth, () => applyRecompare(id, { basis: 'pinned', scope: 'all' })));
    expect(await note()).toContain('geçerli değil (geçerlilik: 2026-11-01 – …)');
    expect((await app.inject({ method: 'DELETE', url: `${API}/tariffs/${f.tariffId}`, headers: f.auth })).statusCode).toBeLessThan(300);
    applied(await inCompany(f.auth, () => applyRecompare(id, { basis: 'pinned', scope: 'all' })));
    expect(await note()).not.toContain('geçerli değil');
    expect((await invoiceRow(f, id)).tariffRevisionId).toBe(rev);
    expect(money(await lineBy(f, id, a))).toEqual(['DIFF', 30, 20]);
  });
});

describe('ölçüm değişince: açık satır güncellenir, donmuş satır işaretlenir', () => {
  it('"Doğrulandı" ve "Uyumlu sayıldı" satır değişmez; ölçüm geri dönünce işaret silinir; lineIds ile onaylanınca güncellenir', async () => {
    const app = await getApp();
    const f = await firm(app);
    const [open, verified, accepted] = [trackingNo(), trackingNo(), trackingNo()];
    const first: Record<string, string> = {};
    for (const t of [open, verified, accepted]) first[t] = await measure(f, t);
    const id = await importInvoice(f, [open, verified, accepted]);
    const rev = await currentRevision(f);
    const lv = await lineBy(f, id, verified);
    const la = await lineBy(f, id, accepted);
    await decide(f, app, lv.id, { decision: 'VERIFIED' });
    await decide(f, app, la.id, { decision: 'ACCEPTED', reason: 'anlaşmalı' });

    // 30×20×20 = 4 desi → beklenen 40, fark 10
    const bigger = FOUR_DESI;
    const second: Record<string, string> = {};
    for (const t of [open, verified, accepted]) second[t] = await correct(f, t, bigger);

    const lo = await lineBy(f, id, open);
    expect(money(lo)).toEqual(['DIFF', 40, 10]);
    expect(lo.measurementId).toBe(second[open]);
    expect(lo.recalcPending).toBeNull();
    expect(lo.prevResult as PrevResult).toMatchObject({ status: 'DIFF', expectedAmount: 30, diffAmount: 20, ourChargeableKg: 3, measurementId: first[open], tariffRevisionId: rev, cause: 'MEASUREMENT' });
    for (const [t, decision] of [[verified, 'VERIFIED'], [accepted, 'ACCEPTED']] as const) {
      const l = await lineBy(f, id, t);
      expect(money(l)).toEqual(['DIFF', 30, 20]);
      expect([l.measurementId, l.decision, l.prevResult]).toEqual([first[t], decision, null]);
      expect(l.recalcPending).toBe('MEASUREMENT');
      expect(l.recalcPendingAt).not.toBeNull();
    }
    let totals = await totalsOf(f, id);
    expect(totals.pendingLines).toBe(2);
    // toplam kayıtlı satırlardan: 40 + 30 + 30
    expect(totals.expectedTotal).toBe(100);
    expect(totals).toEqual(computeTotals(await lineRows(f, id)));

    // "Doğrulandı" satırın ölçümü eski hâline döner: sonuç yine aynı, işaret silinir (satır yazılmaz)
    await correct(f, verified, { lengthCm: 30, widthCm: 20, heightCm: 15 });
    const back = await lineBy(f, id, verified);
    expect([back.recalcPending, back.recalcPendingAt, back.measurementId, back.decision]).toEqual([null, null, first[verified], 'VERIFIED']);
    expect(money(back)).toEqual(['DIFF', 30, 20]);
    expect((await lineBy(f, id, accepted)).recalcPending).toBe('MEASUREMENT');
    expect((await totalsOf(f, id)).pendingLines).toBe(1);

    // donmuş satırda "yeni ölçümle hesapla": önizleme → onay; karar aynı kalır
    const p = previewed(await inCompany(f.auth, () => previewRecompare(id, { lineIds: [la.id] })));
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0]).toMatchObject({ id: la.id, decision: 'ACCEPTED', inDispute: false, action: 'write' });
    expect([p.lines[0]!.before.expectedAmount, p.lines[0]!.after.expectedAmount]).toEqual([30, 40]);
    expect([p.changedLines, p.frozenChanged, p.totals.before.pendingLines, p.totals.after.pendingLines]).toEqual([1, 1, 1, 0]);
    const r = applied(await inCompany(f.auth, () => applyRecompare(id, { lineIds: [la.id], cause: 'MEASUREMENT', expectedToken: p.token })));
    const done = await lineBy(f, id, accepted);
    expect(money(done)).toEqual(['DIFF', 40, 10]);
    expect([done.decision, done.decisionReason, done.recalcPending, done.measurementId]).toEqual(['ACCEPTED', 'anlaşmalı', null, second[accepted]]);
    expect(done.decidedAt).toEqual(la.decidedAt ?? done.decidedAt);
    expect(done.prevResult as PrevResult).toMatchObject({ expectedAmount: 30, diffAmount: 20, measurementId: first[accepted], cause: 'MEASUREMENT' });
    expect(r.totals).toEqual(p.totals.after);
    totals = await totalsOf(f, id);
    expect(totals.pendingLines).toBe(0);
    // lineIds dışındaki satırlara dokunulmadı
    expect((await lineBy(f, id, verified)).updatedAt).toEqual(back.updatedAt);
  });

  it('kullanıcının düzelttiği satır (forceLineIds) kararlı olsa da yazılır; "all" kapsamı kararı korur', async () => {
    const app = await getApp();
    const f = await firm(app);
    const [x, y] = [trackingNo(), trackingNo()];
    await measure(f, x);
    await measure(f, y);
    const id = await importInvoice(f, [x, y]);
    const lx = await lineBy(f, id, x);
    const ly = await lineBy(f, id, y);
    await decide(f, app, lx.id, { decision: 'VERIFIED' });
    await decide(f, app, ly.id, { decision: 'VERIFIED' });
    await correct(f, x, FOUR_DESI);
    await correct(f, y, FOUR_DESI);
    expect((await totalsOf(f, id)).pendingLines).toBe(2);

    await inCompany(f.auth, () => recompareInvoice(id, { forceLineIds: [lx.id] }));
    expect(money(await lineBy(f, id, x))).toEqual(['DIFF', 40, 10]);
    expect((await lineBy(f, id, x)).decision).toBe('VERIFIED');
    expect(money(await lineBy(f, id, y))).toEqual(['DIFF', 30, 20]);
    expect((await lineBy(f, id, y)).recalcPending).toBe('MEASUREMENT');

    const r = applied(await inCompany(f.auth, () => applyRecompare(id, { scope: 'all' })));
    expect(r.summary.changedLines).toBe(1);
    const after = await lineBy(f, id, y);
    expect(money(after)).toEqual(['DIFF', 40, 10]);
    expect([after.decision, after.recalcPending]).toEqual(['VERIFIED', null]);
    expect(r.pendingLines).toBe(0);
  });

  it('mükerrer zinciri: önceki fatura silinince donmuş satır yazılmaz, DUPLICATE ile işaretlenir; açık satır güncellenir', async () => {
    const app = await getApp();
    const f = await firm(app);
    const [x, y] = [trackingNo(), trackingNo()];
    await measure(f, x);
    await measure(f, y);
    const firstId = await importInvoice(f, [x, y]);
    const secondId = await importInvoice(f, [x, y], { confirmOverlap: true });
    const sx = await lineBy(f, secondId, x);
    const sy = await lineBy(f, secondId, y);
    expect(sx.diffTypes).toContain('DUPLICATE');
    expect(sy.diffTypes).toContain('DUPLICATE');
    await decide(f, app, sx.id, { decision: 'VERIFIED' });
    const frozen = await lineBy(f, secondId, x);

    const del = await app.inject({ method: 'DELETE', url: `${API}/invoices/${firstId}`, headers: f.auth });
    expect(del.statusCode, del.body).toBe(204);
    const kept = await lineBy(f, secondId, x);
    expect(kept.diffTypes).toEqual(frozen.diffTypes);
    expect(money(kept)).toEqual(money(frozen));
    expect([kept.decision, kept.recalcPending]).toEqual(['VERIFIED', 'DUPLICATE']);
    const moved = await lineBy(f, secondId, y);
    expect(moved.diffTypes).not.toContain('DUPLICATE');
    expect(money(moved)).toEqual(['DIFF', 30, 20]);
    expect((moved.prevResult as PrevResult).cause).toBe('DUPLICATE');
    expect((await totalsOf(f, secondId)).pendingLines).toBe(1);
  });
});

describe('etkin itirazdaki satır hiçbir kipte yazılmaz', () => {
  it('ölçüm değişir: itirazdaki satır aynı kalır ve işaretlenir; lineIds → LINE_IN_DISPUTE; current → INVOICE_HAS_DISPUTE', async () => {
    const app = await getApp();
    const c = await disputeCompany(app);
    const f: Firm = { app, auth: c.admin.auth, worker: c.worker.auth, companyId: c.admin.companyId, carrierId: c.carrierId, tariffId: '' };
    // iki satır: ilki "Doğrulandı" ve itiraza girer, ikincisi açık
    const inv = await invoiceWithDiffs(app, c, [50, 50], { verify: 1 });
    const id = inv.invoiceId;
    await inCompany(f.auth, () => recompareInvoice(id));
    const send = await app.inject({ method: 'POST', url: `${API}/invoices/${id}/disputes`, headers: f.auth, payload: { sentOn: trDay(0), channel: 'EMAIL', selectionDigest: await digestOf(app, f.auth, id) } });
    expect(send.statusCode, send.body).toBe(201);
    const [inDispute, open] = await lineRows(f, id);
    const disputeLines = await inCompany(f.auth, () => prisma.disputeLine.findMany({ where: { dispute: { invoiceId: id } } }));
    expect(disputeLines.map((d) => d.invoiceLineId)).toEqual([inDispute!.id]);

    for (const t of [inDispute!.trackingNo, open!.trackingNo]) await correct(f, t, FOUR_DESI);
    const frozen = await lineBy(f, id, inDispute!.trackingNo);
    expect(money(frozen)).toEqual(money(inDispute!));
    expect([frozen.measurementId, frozen.recalcPending]).toEqual([inDispute!.measurementId, 'MEASUREMENT']);
    const moved = await lineBy(f, id, open!.trackingNo);
    expect(moved.measurementId).not.toBe(open!.measurementId);
    expect(Number(moved.expectedAmount)).toBeGreaterThan(Number(open!.expectedAmount));

    // kullanıcının "Yeniden karşılaştır"ı (pinned + all), zorla ve önizleme: satır yine yazılmaz
    const stamp = (await lineBy(f, id, inDispute!.trackingNo)).updatedAt;
    const p = previewed(await inCompany(f.auth, () => previewRecompare(id, { basis: 'pinned' })));
    expect([p.changedLines, p.skippedInDispute, p.inDisputeLines]).toEqual([0, 1, 1]);
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0]).toMatchObject({ id: inDispute!.id, inDispute: true, action: 'skip' });
    const all = applied(await inCompany(f.auth, () => applyRecompare(id, { basis: 'pinned', scope: 'all', forceLineIds: [inDispute!.id] })));
    expect([all.writtenLines, all.skippedInDispute, all.pendingLines]).toEqual([0, 1, 1]);
    const still = await lineBy(f, id, inDispute!.trackingNo);
    expect(money(still)).toEqual(money(inDispute!));
    expect(still.updatedAt).toEqual(stamp);

    expect(await inCompany(f.auth, () => previewRecompare(id, { lineIds: [inDispute!.id] }))).toBe('LINE_IN_DISPUTE');
    expect(await inCompany(f.auth, () => applyRecompare(id, { lineIds: [inDispute!.id, open!.id] }))).toBe('LINE_IN_DISPUTE');
    for (const basis of ['tariff', 'rules'] as const) {
      expect(await inCompany(f.auth, () => previewRecompare(id, { basis }))).toBe('INVOICE_HAS_DISPUTE');
      expect(await inCompany(f.auth, () => applyRecompare(id, { basis, scope: 'all' }))).toBe('INVOICE_HAS_DISPUTE');
    }
    expect(await inCompany(f.auth, () => previewRecompare(id, { patch: { invoiceDate: new Date('2026-10-01T00:00:00.000Z') } }))).toBe('INVOICE_HAS_DISPUTE');
    await expect(inCompany(f.auth, () => recompareInvoice(id, { lineIds: [inDispute!.id] }))).rejects.toMatchObject({ code: 'LINE_IN_DISPUTE' });
    expect((await lineBy(f, id, inDispute!.trackingNo)).updatedAt).toEqual(stamp);
  });
});

describe('dayanaksız faturada itiraz kilidi (inceleme 7)', () => {
  it('etkin itirazı olan dayanaksız fatura: pinned + tümü ve önizlemesiz uç tarifeyi benimsemez; tariff kipi 409; itiraz önizlemeden sonra gönderilirse onay bayat', async () => {
    const app = await getApp();
    const c = await disputeCompany(app);
    const f: Firm = { app, auth: c.admin.auth, worker: c.worker.auth, companyId: c.admin.companyId, carrierId: c.carrierId, tariffId: '' };
    // ikinci fatura: itiraz önizlemeden SONRA gönderilecek
    const late = await invoiceWithDiffs(app, c, [50], { verify: 1 });
    const inv = await invoiceWithDiffs(app, c, [50, 50], { verify: 1 });
    const id = inv.invoiceId;
    const send = await app.inject({ method: 'POST', url: `${API}/invoices/${id}/disputes`, headers: f.auth, payload: { sentOn: trDay(0), channel: 'EMAIL', selectionDigest: await digestOf(app, f.auth, id) } });
    expect(send.statusCode, send.body).toBe(201);
    // dayanaksız (ör. tarifesiz içe aktarılmış, tarife sonradan eklenmiş) fatura gibi
    const unpin = (x: string) => inCompany(f.auth, () => prisma.invoice.update({ where: { id: x }, data: { tariffRevisionId: null } }));
    await unpin(id);
    await unpin(late.invoiceId);

    const p = previewed(await inCompany(f.auth, () => previewRecompare(id, { basis: 'pinned' })));
    expect([p.from.tariffRevisionId, p.to.tariffRevisionId]).toEqual([null, null]);
    const r = applied(await inCompany(f.auth, () => applyRecompare(id, { basis: 'pinned', scope: 'all', expectedToken: p.token })));
    expect(r.summary.revisionTo).toBeNull();
    const re = await app.inject({ method: 'POST', url: `${API}/invoices/${id}/recompare`, headers: f.auth });
    expect(re.statusCode, re.body).toBe(200);
    expect((await invoiceRow(f, id)).tariffRevisionId).toBeNull();
    expect(await inCompany(f.auth, () => previewRecompare(id, { basis: 'tariff' }))).toBe('INVOICE_HAS_DISPUTE');
    // itirazdaki satır hiç yazılmadı
    const disputed = inv.lines[0]!;
    expect((await lineBy(f, id, disputed.trackingNo)).status).toBe('DIFF');

    // itirazsız iken önizleme tarifeyi benimser; itiraz onaydan önce gönderilince onay bayat, hiçbir şey yazılmaz
    const before = previewed(await inCompany(f.auth, () => previewRecompare(late.invoiceId, { basis: 'pinned' })));
    expect(before.to.tariffRevisionId).not.toBeNull();
    const s2 = await app.inject({ method: 'POST', url: `${API}/invoices/${late.invoiceId}/disputes`, headers: f.auth, payload: { sentOn: trDay(0), channel: 'EMAIL', selectionDigest: await digestOf(app, f.auth, late.invoiceId) } });
    expect(s2.statusCode, s2.body).toBe(201);
    const print = await fingerprint(f, late.invoiceId);
    expect(await inCompany(f.auth, () => applyRecompare(late.invoiceId, { basis: 'pinned', scope: 'all', expectedToken: before.token }))).toBe('PREVIEW_STALE');
    expect(await fingerprint(f, late.invoiceId)).toEqual(print);
  });

  it('satır seçimi ve patch yalnız pinned ile (motor koruması)', async () => {
    const app = await getApp();
    const f = await firm(app);
    const a = trackingNo();
    const id = await importInvoice(f, [a]);
    const line = await lineBy(f, id, a);
    await expect(inCompany(f.auth, () => previewRecompare(id, { basis: 'tariff', lineIds: [line.id] }))).rejects.toThrow(/pinned/);
    await expect(inCompany(f.auth, () => applyRecompare(id, { basis: 'rules', lineIds: [line.id] }))).rejects.toThrow(/pinned/);
    await expect(inCompany(f.auth, () => previewRecompare(id, { basis: 'rules', patch: { currency: 'USD' } }))).rejects.toThrow(/pinned/);
  });
});

describe('tolerans ayarı değişince fatura eski ayarla kalır', () => {
  it('pinned: eski toleransla aynı sonuç; rules: yeni toleransa geçer', async () => {
    const app = await getApp();
    const f = await firm(app);
    const a = trackingNo();
    await measure(f, a);
    const id = await importInvoice(f, [a]);
    expect(money(await lineBy(f, id, a))).toEqual(['DIFF', 30, 20]);
    expect(await inCompany(f.auth, () => invoicesWithOtherSettings(f.companyId))).toEqual([]);

    // tutar toleransı 5 → 25: fark (20) artık tolerans içinde
    const set = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: f.auth, payload: { amountTol: 25 } });
    expect(set.statusCode, set.body).toBe(200);
    const before = await fingerprint(f, id);
    expect(await basisState(f, id)).toBe('RULES_CHANGED');
    expect(await inCompany(f.auth, () => invoicesWithOtherSettings(f.companyId))).toEqual([{ id, lines: 1 }]);

    const re = await app.inject({ method: 'POST', url: `${API}/invoices/${id}/recompare`, headers: f.auth });
    expect(re.statusCode, re.body).toBe(200);
    const pinned = applied(await inCompany(f.auth, () => applyRecompare(id, { basis: 'pinned', scope: 'all' })));
    expect(pinned.summary.changedLines).toBe(0);
    expect(money(await lineBy(f, id, a))).toEqual(['DIFF', 30, 20]);
    expect((await fingerprint(f, id)).lines).toEqual(before.lines);
    expect(((await invoiceRow(f, id)).compareSettings as { amountTol: number }).amountTol).toBe(5);
    // otomatik tetikleyici de eski toleransla: ölçüm düzeltmesi 4 desi → fark 10 (> 5) hâlâ "Fark var"
    await correct(f, a, FOUR_DESI);
    expect(money(await lineBy(f, id, a))).toEqual(['DIFF', 40, 10]);

    const p = previewed(await inCompany(f.auth, () => previewRecompare(id, { basis: 'rules' })));
    expect([p.from.compareSettings?.amountTol, p.to.compareSettings?.amountTol, p.changedLines]).toEqual([5, 25, 1]);
    applied(await inCompany(f.auth, () => applyRecompare(id, { basis: 'rules', scope: 'all', expectedToken: p.token })));
    const l = await lineBy(f, id, a);
    expect(l.status).toBe('MATCH');
    expect((l.prevResult as PrevResult).status).toBe('DIFF');
    expect(((await invoiceRow(f, id)).compareSettings as { amountTol: number }).amountTol).toBe(25);
    expect(await basisState(f, id)).toBe('CURRENT');
    expect(await inCompany(f.auth, () => invoicesWithOtherSettings(f.companyId))).toEqual([]);
  });

  it('ayar karşılaştırması anahtar sırasından bağımsız', async () => {
    const app = await getApp();
    const f = await firm(app);
    const a = trackingNo();
    const id = await importInvoice(f, [a]);
    const s = (await invoiceRow(f, id)).compareSettings as Record<string, unknown>;
    const reversed = Object.fromEntries(Object.entries(s).reverse());
    expect(Object.keys(reversed)).not.toEqual(Object.keys(s));
    await inCompany(f.auth, () => prisma.invoice.update({ where: { id }, data: { compareSettings: reversed as never } }));
    expect(await basisState(f, id)).toBe('CURRENT');
    expect(await inCompany(f.auth, () => invoicesWithOtherSettings(f.companyId))).toEqual([]);
  });
});

describe('önizleme hiçbir şey yazmaz', () => {
  it('satırların ve faturanın değişme anı aynı kalır; özet tutmazsa PREVIEW_STALE', async () => {
    const app = await getApp();
    const f = await firm(app);
    const [a, b] = [trackingNo(), trackingNo()];
    await measure(f, a);
    await measure(f, b);
    const id = await importInvoice(f, [a, b]);
    const rev1 = await currentRevision(f);
    await decide(f, app, (await lineBy(f, id, b)).id, { decision: 'VERIFIED' });
    await putTariff(f, 8);
    const rev2 = await currentRevision(f);
    const before = await fingerprint(f, id);

    const p = previewed(await inCompany(f.auth, () => previewRecompare(id, { basis: 'tariff' })));
    expect(p).toMatchObject({ basis: 'tariff', scope: 'all', changedLines: 2, frozenChanged: 1, skippedInDispute: 0 });
    expect([p.from.tariffRevisionId, p.to.tariffRevisionId]).toEqual([rev1, rev2]);
    expect([p.totals.before.expectedTotal, p.totals.after.expectedTotal]).toEqual([60, 48]);
    expect([p.totals.before.overchargeTotal, p.totals.after.overchargeTotal]).toEqual([40, 52]);
    expect(p.lines.map((l) => [l.before.expectedAmount, l.after.expectedAmount, l.action])).toEqual([[30, 24, 'write'], [30, 24, 'write']]);
    expect(p.token).toMatch(/^[0-9a-f]{64}$/);
    // aynı girdide özet aynıdır
    expect(previewed(await inCompany(f.auth, () => previewRecompare(id, { basis: 'tariff' }))).token).toBe(p.token);
    // sabit dayanakla önizleme: değişiklik yok
    const same = previewed(await inCompany(f.auth, () => previewRecompare(id, { basis: 'pinned' })));
    expect([same.changedLines, same.lines.length, same.to.tariffRevisionId]).toEqual([0, 0, rev1]);
    expect(same.token).not.toBe(p.token);
    // açık kapsam: kararlı satır yazılmaz, işaretlenir
    const openOnly = previewed(await inCompany(f.auth, () => previewRecompare(id, { basis: 'tariff', scope: 'open' })));
    expect(openOnly.lines.map((l) => l.action)).toEqual(['write', 'pending']);
    expect([openOnly.changedLines, openOnly.frozenChanged, openOnly.totals.after.pendingLines]).toEqual([1, 1, 1]);
    expect(await fingerprint(f, id)).toEqual(before);

    // önizlemeden sonra tarife yine değişti: eski özet tutmaz, hiçbir şey yazılmaz
    await putTariff(f, 7);
    expect(await inCompany(f.auth, () => applyRecompare(id, { basis: 'tariff', scope: 'all', expectedToken: p.token }))).toBe('PREVIEW_STALE');
    expect(await fingerprint(f, id)).toEqual(before);
    // önizlemeden sonra karar değişti: plan değişir, özet tutmaz
    const p2 = previewed(await inCompany(f.auth, () => previewRecompare(id, { basis: 'tariff', scope: 'open' })));
    await decide(f, app, (await lineBy(f, id, a)).id, { decision: 'VERIFIED' });
    const mid = await fingerprint(f, id);
    expect(await inCompany(f.auth, () => applyRecompare(id, { basis: 'tariff', scope: 'open', expectedToken: p2.token }))).toBe('PREVIEW_STALE');
    expect(await fingerprint(f, id)).toEqual(mid);
    // başka kiple alınmış özet de tutmaz
    const p3 = previewed(await inCompany(f.auth, () => previewRecompare(id, { basis: 'tariff' })));
    expect(await inCompany(f.auth, () => applyRecompare(id, { basis: 'pinned', scope: 'all', expectedToken: p3.token }))).toBe('PREVIEW_STALE');
    expect(await fingerprint(f, id)).toEqual(mid);
    // taze özetle uygulanır: sonuç önizlemedeki "sonra" ile aynı
    const r = applied(await inCompany(f.auth, () => applyRecompare(id, { basis: 'tariff', scope: 'all', expectedToken: p3.token })));
    expect(r.totals).toEqual(p3.totals.after);
    expect(money(await lineBy(f, id, a))).toEqual(['DIFF', 21, 29]);
    expect(r.summary.totalsAfter).toEqual(await totalsOf(f, id));
  });

  it('patch: tarife değişikliği fatura o tarifeye geçmiş gibi hesaplanır, yazılmaz', async () => {
    const app = await getApp();
    const f = await firm(app);
    const a = trackingNo();
    await measure(f, a);
    const id = await importInvoice(f, [a]);
    const other = await app.inject({ method: 'POST', url: `${API}/tariffs`, headers: f.auth, payload: tariffOf(f.carrierId, 7, { name: 'Öbür', isDefault: false }) });
    expect(other.statusCode, other.body).toBe(201);
    const otherId = other.json().tariff.id as string;
    const before = await fingerprint(f, id);

    const p = previewed(await inCompany(f.auth, () => previewRecompare(id, { patch: { tariffId: otherId } })));
    expect(p.basis).toBe('tariff');
    expect([p.to.tariffName, p.to.tariffRevisionId]).toEqual(['Öbür', await currentRevision(f, otherId)]);
    // ayar parçası faturadaki gibi kalır
    expect(p.to.compareSettings).toEqual(p.from.compareSettings);
    expect(p.lines.map((l) => [l.before.expectedAmount, l.after.expectedAmount])).toEqual([[30, 21]]);
    // yalnız tarih değişikliği: dayanak aynı kalır
    const dated = previewed(await inCompany(f.auth, () => previewRecompare(id, { patch: { invoiceDate: new Date('2026-09-01T00:00:00.000Z') } })));
    expect([dated.basis, dated.to.tariffRevisionId, dated.changedLines]).toEqual(['pinned', before.invoice[1], 0]);
    expect(await fingerprint(f, id)).toEqual(before);

    // uç (PATCH /invoices/:id) böyle uygular: aynı patch ve önizlemenin özetiyle; alan satırlarla aynı işlemde yazılır
    const r = applied(await inCompany(f.auth, () => applyRecompare(id, { basis: 'pinned', scope: 'all', patch: { tariffId: otherId }, expectedToken: p.token })));
    expect(r.totals).toEqual(p.totals.after);
    expect(r.summary.basis).toBe('tariff');
    expect((await invoiceRow(f, id)).tariffId).toBe(otherId);
    expect(money(await lineBy(f, id, a))).toEqual(['DIFF', 21, 29]);
  });
});

describe('dayanaksız fatura (tariffRevisionId null)', () => {
  it('otomatik tetikleyici güncel tarifeyi benimsemez; kullanıcının başlattığı (all) hesap benimser', async () => {
    const app = await getApp();
    const f = await firm(app, { tariff: false });
    const [a, b] = [trackingNo(), trackingNo()];
    await measure(f, a);
    // hesaplandığında taşıyıcının tarifesi yok: fatura dayanaksız doğar (içe aktarma ayarı yazar, sürüm boş kalır)
    const id = await importInvoice(f, [a, b], { pin: false });
    const basis = await inCompany(f.auth, () => resolveCurrentBasis(f.companyId, f.carrierId, null));
    expect([basis.tariffId, basis.tariffRevisionId]).toEqual([null, null]);
    await inCompany(f.auth, () => prisma.invoice.update({ where: { id }, data: { tariffRevisionId: basis.tariffRevisionId, compareSettings: basis.compareSettings } }));
    expect((await lineBy(f, id, a)).status).toBe('NO_TARIFF');
    expect(await basisState(f, id)).toBe('NONE');

    // tarife sonradan eklenir
    const t = await app.inject({ method: 'POST', url: `${API}/tariffs`, headers: f.auth, payload: tariffOf(f.carrierId, 10) });
    expect(t.statusCode, t.body).toBe(201);
    f.tariffId = t.json().tariff.id;
    // otomatik yollar: ölçüm kaydı, düzeltme, mükerrer zinciri, sabit dayanaklı açık kapsam
    await measure(f, b);
    await correct(f, a, FOUR_DESI);
    await inCompany(f.auth, () => recompareLaterDuplicates(f.companyId, id, [a]));
    await inCompany(f.auth, () => recompareInvoice(id));
    for (const x of [a, b]) {
      const l = await lineBy(f, id, x);
      expect([l.status, l.expectedAmount, l.tariffId, l.tariffRevisionId]).toEqual(['NO_TARIFF', null, null, null]);
    }
    expect((await invoiceRow(f, id)).tariffRevisionId).toBeNull();
    // tek satırlık onay da benimsemez
    const lineA = await lineBy(f, id, a);
    const one = applied(await inCompany(f.auth, () => applyRecompare(id, { lineIds: [lineA.id] })));
    expect(one.summary.revisionTo).toBeNull();

    // kullanıcı "Yeniden karşılaştır" der: güncel varsayılan benimsenir
    const p = previewed(await inCompany(f.auth, () => previewRecompare(id, { basis: 'pinned' })));
    const rev = await currentRevision(f);
    expect([p.from.tariffRevisionId, p.to.tariffRevisionId]).toEqual([null, rev]);
    const r = applied(await inCompany(f.auth, () => applyRecompare(id, { basis: 'pinned', scope: 'all', expectedToken: p.token })));
    expect([r.summary.revisionFrom, r.summary.revisionTo]).toEqual([null, rev]);
    expect(money(await lineBy(f, id, a))).toEqual(['DIFF', 40, 10]);
    expect(money(await lineBy(f, id, b))).toEqual(['DIFF', 30, 20]);
    expect((await lineBy(f, id, a)).tariffRevisionId).toBe(rev);
    // tarifesiz eski sonuç "önceki rakam" sayılmaz
    expect((await lineBy(f, id, a)).prevResult).toBeNull();
    expect((await invoiceRow(f, id)).tariffRevisionId).toBe(rev);
    expect(await basisState(f, id)).toBe('CURRENT');
  });
});

describe('sürüm (snapshot) ↔ canlı tarife eşdeğerliği', () => {
  type SeedCarrier = { code: string; name: string; tariffs: Record<string, unknown>[] };
  const seedFile = path.join(SAMPLES, 'seed-tariffs.json');
  /** `rates` sırası snapshot'ta bölge + ağırlığa göre, canlıda tablo sırasıyla: sıraya duyarsız karşılaştırılır. */
  const canon = (t: TariffInput) => ({
    ...t,
    currency: t.currency.toUpperCase(),
    rates: [...t.rates].sort((x, y) => (x.zone < y.zone ? -1 : x.zone > y.zone ? 1 : x.weightUpto - y.weightUpto || x.price - y.price)),
    zones: Object.fromEntries(Object.entries(t.zones).sort(([x], [y]) => (x < y ? -1 : 1))),
    overflowPerUnit: t.overflowPerUnit ? Object.fromEntries(Object.entries(t.overflowPerUnit).sort(([x], [y]) => (x < y ? -1 : 1))) : undefined,
  });

  it('örnek tarifeler: iki yoldan kurulan girdi aynı, compareLine aynı sonucu verir', async () => {
    expect(fs.existsSync(seedFile), seedFile).toBe(true);
    const app = await getApp();
    const admin = await registerCompany(app, uniq('Eşdeğer '));
    const carriers = JSON.parse(fs.readFileSync(seedFile, 'utf8')) as SeedCarrier[];
    let tariffs = 0;
    let compared = 0;
    await inCompany(admin.auth, async () => {
      for (const c of carriers) {
        const carrier = await prisma.carrier.create({ data: { companyId: admin.companyId, code: c.code, name: uniq(c.name) } });
        for (const [n, raw] of c.tariffs.entries()) {
          // ülke istisnası ve taşma olan tarife de sınansın
          const body = tariffBody.parse({
            ...raw,
            carrierId: carrier.id,
            ...(n === 0 ? { countryAdjustments: [{ country: 'DE', pct: -12.5, note: 'özel', source: 'manual' }] } : {}),
          });
          const created = await createTariff(admin.companyId, body);
          const live = await prisma.tariff.findFirstOrThrow({ where: { id: created.id }, include: tariffInclude });
          expect(live.currentRevisionId).toBeTruthy();
          const rev = await prisma.tariffRevision.findFirstOrThrow({ where: { id: live.currentRevisionId! } });
          const fromLive = toTariffInput(live);
          const fromSnapshot = snapshotToTariffInput(rev.snapshot, live.id, rev.currency);
          expect(canon(fromSnapshot), live.name).toEqual(canon(fromLive));
          tariffs++;

          const countries = [...Object.keys(fromLive.zones).filter((z) => z !== '*').slice(0, 6), 'ZZ'];
          const weights = [0.3, 0.5, 1, 2.2, 5, 19.7, 25, 31, 70, 150, 400];
          for (const destCountry of countries) {
            for (const [i, w] of weights.entries()) {
              const line: ParsedInvoiceLine = {
                rowIndex: i,
                trackingNo: `7948000000${String(i).padStart(4, '0')}`,
                destCountry,
                billedKg: w + 1,
                service: i % 2 ? (fromLive.service ?? undefined) : 'Başka Hizmet',
                baseAmount: i % 3 ? undefined : 500,
                fuelAmount: i % 3 ? undefined : 50,
                surcharges: i % 4 ? [] : [{ code: 'RESI', name: 'Residential', amount: 12 }],
                netAmount: 500 + i * 37,
                currency: fromLive.currency,
                rawHash: `h${i}`,
              };
              const input = {
                line,
                measurement: { id: 'm', dims: { l: 30, w: 20, h: 15 }, actualKg: w, measuredAt: '2026-10-15T00:00:00.000Z' },
                tol: { edgeTolCm: 1, weightTolKg: 0.1, amountTol: 5, fxTolerancePct: 1.5, unknownSurchargesAsDiff: i % 2 === 0 },
                isDuplicate: false,
              };
              expect(compareLine({ ...input, tariff: fromSnapshot }), `${live.name} ${destCountry} ${w}`).toEqual(compareLine({ ...input, tariff: fromLive }));
              compared++;
            }
          }
        }
      }
    });
    expect(tariffs).toBeGreaterThan(0);
    expect(compared).toBeGreaterThan(50);
  });

  it('uçtan uca: içe aktarmanın (sürümden) rakamı, canlı tarifeden kurulan girdinin rakamıyla aynı', async () => {
    const app = await getApp();
    const f = await firm(app);
    // yakıt, indirim, ek ücret, taşma ve ülke istisnası olan tarife; ağırlık tablonun üstünde (taşma)
    await putTariff(f, 10, {
      discountPct: 12.5,
      fuelPct: 7.25,
      fuelVariable: false,
      service: 'Standart',
      validFrom: '2026-01-01',
      validTo: '2026-12-31',
      zones: [{ country: '*', zone: 'TR' }, { country: 'DE', zone: 'AB' }],
      rates: [
        ...Array.from({ length: 30 }, (_, i) => ({ zone: 'TR', weightUpto: 30 - i, price: (30 - i) * 10 })),
        { zone: 'AB', weightUpto: 5, price: 99.99 },
        { zone: 'AB', weightUpto: 30, price: 7.5, perKg: true },
      ],
      overflow: [{ zone: 'TR', perUnit: 9.5 }],
      surcharges: [{ code: 'HANDLING', name: 'Elleçleme', kind: 'FIXED', amount: 3.3 }],
      countryAdjustments: [{ country: 'DE', pct: -10, source: 'manual' }],
    });
    const a = trackingNo();
    // 60×50×40 / 3000 = 40 desi: tablonun (30) üstü
    await measure(f, a, { lengthCm: 60, widthCm: 50, heightCm: 40 });
    const id = await importInvoice(f, [a], { amount: 700 });
    const l = await lineBy(f, id, a);
    expect(l.status).not.toBe('NO_TARIFF');
    const live = await inCompany(f.auth, () => prisma.tariff.findFirstOrThrow({ where: { id: f.tariffId }, include: tariffInclude }));
    const rev = await inCompany(f.auth, () => prisma.tariffRevision.findFirstOrThrow({ where: { id: live.currentRevisionId! } }));
    expect(canon(snapshotToTariffInput(rev.snapshot, live.id, rev.currency))).toEqual(canon(toTariffInput(live)));
    const m = await inCompany(f.auth, () => prisma.measurement.findFirstOrThrow({ where: { id: l.measurementId! } }));
    const expected = compareLine({
      line: { rowIndex: l.rowIndex, trackingNo: a, billedKg: 5, netAmount: 700, currency: 'TRY', surcharges: [], rawHash: l.rawHash },
      measurement: { id: m.id, dims: { l: 60, w: 50, h: 40 }, actualKg: 2, measuredAt: m.measuredAt.toISOString() },
      tariff: toTariffInput(live),
      tol: { edgeTolCm: 1, weightTolKg: 0.1, amountTol: 5, fxTolerancePct: 1.5, unknownSurchargesAsDiff: false },
      isDuplicate: false,
    });
    expect([l.status, Number(l.expectedAmount), Number(l.diffAmount), l.diffTypes]).toEqual([expected.status, expected.expectedAmount, expected.diffAmount, expected.diffTypes]);
    expect(expected.expectedAmount).toBeGreaterThan(0);
  });
});

describe('tarife parçası faturanın bugünkü taşıyıcısından çözülür', () => {
  /** Faturanın taşıyıcısı (rota dışından, ör. eski bir yol) tarifesi olmayan B olarak yazılmış. */
  async function movedToBare(f: Firm, id: string) {
    const bare = await f.app.inject({ method: 'POST', url: `${API}/carriers`, headers: f.auth, payload: { code: 'yurtici', name: uniq('Tarifesiz ') } });
    expect(bare.statusCode, bare.body).toBe(201);
    const bareId = bare.json().carrier.id as string;
    await inCompany(f.auth, () => prisma.invoice.update({ where: { id }, data: { carrierId: bareId } }));
    return bareId;
  }

  it('A sürümüyle hesaplı, taşıyıcısı tarifesiz B olmuş fatura: tariff dayanağı A sürümünde kalmaz, satırlar NO_TARIFF', async () => {
    const app = await getApp();
    const f = await firm(app);
    const a = trackingNo();
    await measure(f, a);
    const id = await importInvoice(f, [a]);
    const rev = await currentRevision(f);
    expect((await invoiceRow(f, id)).tariffRevisionId).toBe(rev);
    expect(money(await lineBy(f, id, a))).toEqual(['DIFF', 30, 20]);
    await movedToBare(f, id);

    const p = previewed(await inCompany(f.auth, () => previewRecompare(id, { basis: 'tariff' })));
    expect([p.from.tariffRevisionId, p.to.tariffRevisionId]).toEqual([rev, null]);
    const r = applied(await inCompany(f.auth, () => applyRecompare(id, { basis: 'tariff', scope: 'all' })));
    expect(r.summary).toMatchObject({ basis: 'tariff', revisionFrom: rev, revisionTo: null, cause: 'TARIFF' });
    expect((await invoiceRow(f, id)).tariffRevisionId).toBeNull();
    const l = await lineBy(f, id, a);
    expect([l.status, l.expectedAmount, l.tariffId, l.tariffRevisionId]).toEqual(['NO_TARIFF', null, null, null]);
    expect((await totalsOf(f, id)).noTariff).toBe(1);
  });

  it('tarifesi silinmiş: aynı taşıyıcıda sürüm korunur; taşıyıcı değişmişse (sürümdeki carrierId başka) korunmaz', async () => {
    const app = await getApp();
    const f = await firm(app);
    const [a, b] = [trackingNo(), trackingNo()];
    await measure(f, a);
    await measure(f, b);
    const same = await importInvoice(f, [a]);
    const moved = await importInvoice(f, [b]);
    const rev = await currentRevision(f);
    const del = await app.inject({ method: 'DELETE', url: `${API}/tariffs/${f.tariffId}`, headers: f.auth });
    expect(del.statusCode, del.body).toBe(204);
    await movedToBare(f, moved);

    const keep = applied(await inCompany(f.auth, () => applyRecompare(same, { basis: 'tariff', scope: 'all' })));
    expect(keep.summary.revisionTo).toBe(rev);
    expect(money(await lineBy(f, same, a))).toEqual(['DIFF', 30, 20]);
    const drop = applied(await inCompany(f.auth, () => applyRecompare(moved, { basis: 'tariff', scope: 'all' })));
    expect(drop.summary.revisionTo).toBeNull();
    expect((await lineBy(f, moved, b)).status).toBe('NO_TARIFF');
  });
});

describe('yeniden hesabın nedeni', () => {
  it('tariff kipinde sürüm değişince TARIFF, rules kipinde ayar değişince RULES; toplu geçiş tarife için TARIFF, ayar için RULES', async () => {
    const app = await getApp();
    const f = await firm(app);
    const [a, b] = [trackingNo(), trackingNo()];
    await measure(f, a);
    await measure(f, b);
    const one = await importInvoice(f, [a]);
    const two = await importInvoice(f, [b]);

    // tek fatura, neden verilmeden: motor hedef dayanaktan seçer
    await putTariff(f, 8);
    const t = applied(await inCompany(f.auth, () => applyRecompare(one, { basis: 'tariff', scope: 'all' })));
    expect(t.summary.cause).toBe('TARIFF');
    expect((await lineBy(f, one, a)).prevResult as PrevResult).toMatchObject({ expectedAmount: 30, cause: 'TARIFF' });
    const set = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: f.auth, payload: { amountTol: 3 } });
    expect(set.statusCode, set.body).toBe(200);
    // ayar değişti ama tarife kipi ayara dokunmaz: neden genel, ayar eski
    const tOnly = applied(await inCompany(f.auth, () => applyRecompare(one, { basis: 'tariff', scope: 'all' })));
    expect(tOnly.summary.cause).toBe('OTHER');
    expect(((await invoiceRow(f, one)).compareSettings as { amountTol: number }).amountTol).toBe(5);
    const s = applied(await inCompany(f.auth, () => applyRecompare(one, { basis: 'rules', scope: 'all' })));
    expect([s.summary.cause, s.summary.revisionFrom === s.summary.revisionTo]).toEqual(['RULES', true]);
    // hiçbir şey değişmiyorsa genel neden; verilen neden korunur
    expect(applied(await inCompany(f.auth, () => applyRecompare(one, { basis: 'rules', scope: 'all' }))).summary.cause).toBe('OTHER');
    expect(applied(await inCompany(f.auth, () => applyRecompare(one, { basis: 'tariff', scope: 'all', cause: 'MATCH' }))).summary.cause).toBe('MATCH');

    // toplu: tarife geçişi TARIFF (ikinci fatura eski sürümde ve eski ayarda)
    const recalcs = (id: string) =>
      inCompany(f.auth, () => prisma.auditLog.findMany({ where: { entityId: id, action: 'invoice.recalculate' }, orderBy: { createdAt: 'asc' } }));
    const tp = await inCompany(f.auth, () => previewBulk(f.companyId, { kind: 'tariff', tariffId: f.tariffId }));
    expect(tp.invoices.map((x) => x.id)).toEqual([two]);
    const ta = await inCompany(f.auth, () => applyBulk(f.companyId, null, { kind: 'tariff', tariffId: f.tariffId }, tp.token));
    expect(ta).toMatchObject({ invoices: 1 });
    expect((await recalcs(two)).at(-1)!.data).toMatchObject({ basis: 'tariff', cause: 'TARIFF' });
    expect((await lineBy(f, two, b)).prevResult as PrevResult).toMatchObject({ expectedAmount: 30, cause: 'TARIFF' });

    // toplu: ayar geçişi RULES
    const set2 = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: f.auth, payload: { amountTol: 4 } });
    expect(set2.statusCode, set2.body).toBe(200);
    const sp = await inCompany(f.auth, () => previewBulk(f.companyId, { kind: 'settings' }));
    expect(sp.invoices.map((x) => x.id).sort()).toEqual([one, two].sort());
    const sa = await inCompany(f.auth, () => applyBulk(f.companyId, null, { kind: 'settings' }, sp.token));
    expect(sa).toMatchObject({ invoices: 2 });
    for (const id of [one, two]) expect((await recalcs(id)).at(-1)!.data).toMatchObject({ basis: 'rules', cause: 'RULES' });
  });

  it('recalcPending üstüne yazma: OTHER < DUPLICATE < MEASUREMENT; satıra özgü ve tarife/ayar nedeni işarette OTHER olur', async () => {
    const app = await getApp();
    const f = await firm(app);
    const a = trackingNo();
    await measure(f, a);
    const id = await importInvoice(f, [a]);
    const line = await lineBy(f, id, a);
    await decide(f, app, line.id, { decision: 'VERIFIED' });
    // kayıtlı rakamı bozarak donmuş satırın yeni hesabı farklı çıksın (yazılmaz, yalnız işaretlenir)
    await inCompany(f.auth, () => prisma.invoiceLine.update({ where: { id: line.id }, data: { expectedAmount: 31, diffAmount: 19 } }));
    const step = async (cause: 'MEASUREMENT' | 'DUPLICATE' | 'TRACKING' | 'MATCH' | 'TARIFF' | 'RULES' | 'OTHER') => {
      applied(await inCompany(f.auth, () => applyRecompare(id, { basis: 'pinned', scope: 'open', cause })));
      const l = await lineBy(f, id, a);
      return [l.recalcPending, l.recalcPendingAt ? +l.recalcPendingAt : null] as const;
    };
    expect((await step('TRACKING'))[0]).toBe('OTHER');
    for (const c of ['MATCH', 'TARIFF', 'RULES', 'OTHER'] as const) expect((await step(c))[0]).toBe('OTHER');
    const [dup, dupAt] = await step('DUPLICATE');
    expect(dup).toBe('DUPLICATE');
    // eşit ya da daha genel neden işareti ve anını değiştirmez
    for (const c of ['OTHER', 'TRACKING', 'DUPLICATE'] as const) expect(await step(c)).toEqual(['DUPLICATE', dupAt]);
    const [meas, measAt] = await step('MEASUREMENT');
    expect(meas).toBe('MEASUREMENT');
    for (const c of ['DUPLICATE', 'OTHER', 'MATCH', 'MEASUREMENT'] as const) expect(await step(c)).toEqual(['MEASUREMENT', measAt]);
    // satır hiç yazılmadı: karar ve kayıtlı (bozuk) rakam yerinde
    const after = await lineBy(f, id, a);
    expect([after.decision, ...money(after), after.prevResult]).toEqual(['VERIFIED', 'DIFF', 31, 19, null]);
    // sonuç kayıtlıyla yeniden aynı çıkınca işaret silinir
    await inCompany(f.auth, () => prisma.invoiceLine.update({ where: { id: line.id }, data: { expectedAmount: 30, diffAmount: 20 } }));
    expect(await step('OTHER')).toEqual([null, null]);
  });
});
