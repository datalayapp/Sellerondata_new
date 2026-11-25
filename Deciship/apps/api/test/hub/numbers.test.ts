/**
 * Merkez sayıları: README'deki örnek senaryo, Pano ile eşitlik, kırılımların toplama tutması, çok para birimi, itiraz süresi.
 * Gerçek Postgres, gerçek içe aktarma akışı (`importSample`).
 */
import type { HubAnalytics, HubKpi, HubOverview, HubWidget } from '@sellerondata/contracts';
import type { FastifyInstance } from 'fastify';
import { turkeyDate } from '@deciship/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCompany } from '../../src/db.ts';
import { refreshTotals } from '../../src/services/compare.ts';
import { loadSampleData } from '../../src/services/companyData.ts';
import { isoShift } from '../../src/services/hub/period.ts';
import { samplesExist } from '../helpers.ts';
import { prisma, ROLE, authHeader, buildHubApp, createCompany, createMember, importSample, insertCarrier, insertInvoice, type Actor } from './harness.ts';
import { digestOf } from '../disputeHelpers.ts';

const OCT = 'from=2026-10-01&to=2026-10-31';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildHubApp();
});
afterAll(async () => {
  await app.close();
});

const get = async <T = never>(actor: Actor, url: string, perms: readonly string[] = ROLE.ADMIN) => {
  const res = await app.inject({ method: 'GET', url: `/api${url}`, headers: authHeader(actor, perms) });
  if (res.statusCode !== 200) throw new Error(`${url} -> ${res.statusCode} ${res.body}`);
  return res.json() as T;
};
const overview = (a: Actor, q = OCT) => get<HubOverview>(a, `/platform/overview?${q}`);
const analytics = (a: Actor, q = `${OCT}&compare=previous`) => get<HubAnalytics>(a, `/platform/analytics?${q}`);
const pano = (a: Actor, month = '2026-10') =>
  get<{
    overchargeTotal: number;
    verifiedTotal: number;
    recoveredTotal: number;
    disputePendingTotal: number;
    coveragePct: number;
    invoices: { count: number; lines: number; match: number; diff: number; unmatched: number; noTariff: number };
    measurements: { count: number; byMethod: Record<string, number> };
    topDiffTypes: { type: string; count: number; amount: number }[];
    currency: string;
  }>(a, `/dashboard?month=${month}`);

const kpi = (o: { kpis: HubKpi[] }, id: string) => o.kpis.find((k) => k.id === id);
const widgets = (a: HubAnalytics) => a.sections.flatMap((s) => s.widgets);
const widget = <K extends HubWidget['kind']>(a: HubAnalytics, id: string) => widgets(a).find((w) => w.id === id) as Extract<HubWidget, { kind: K }> | undefined;
const kpiIn = (a: HubAnalytics, id: string) => widgets(a).flatMap((w) => (w.kind === 'kpis' ? w.items : [])).find((k) => k.id === id);
const sumItems = (items: { value: number }[]) => Math.round(items.reduce((s, i) => s + i.value, 0) * 100) / 100;

/** Pano ve Merkez (Genel Bakış + Analiz) aynı veride aynı sayıyı vermeli. */
async function expectSameAsPano(a: Actor, month = '2026-10', q = OCT) {
  const [p, o, an] = await Promise.all([pano(a, month), overview(a, q), analytics(a, q)]);
  expect(kpi(o, 'overcharge')!.value, 'overview overcharge').toBe(p.overchargeTotal);
  expect(kpi(o, 'overcharge')!.currency).toBe(p.currency);
  expect(kpi(o, 'diffs')!.value, 'overview diffs').toBe(p.invoices.diff);
  expect(kpi(o, 'coverage')!.value, 'overview coverage').toBe(p.coveragePct);
  expect(kpi(o, 'verified')!.value, 'overview verified').toBe(p.verifiedTotal);
  expect(kpi(o, 'invoices')!.value, 'overview invoices').toBe(p.invoices.count);
  expect(kpi(o, 'measured')!.value, 'overview measured').toBe(p.measurements.count);
  // Analiz satırlardan toplar, Pano saklı toplamdan: iki yol aynı sonuca varmalı.
  expect(kpiIn(an, 'overcharge')!.value, 'analytics overcharge').toBe(p.overchargeTotal);
  expect(kpiIn(an, 'verified')!.value, 'analytics verified').toBe(p.verifiedTotal);
  expect(kpiIn(an, 'diffs')!.value, 'analytics diffs').toBe(p.invoices.diff);
  expect(kpiIn(an, 'lines')!.value, 'analytics lines').toBe(p.invoices.lines);
  expect(kpiIn(an, 'coverage')?.value ?? p.coveragePct, 'analytics coverage').toBe(p.coveragePct);
  // İtiraz: Pano saklı tutarlardan (disputeFacts), Genel Bakış aynı yoldan, Analiz satırlardan: üçü aynı
  expect(kpi(o, 'recovered')!.value, 'overview recovered').toBe(p.recoveredTotal);
  expect(kpi(o, 'disputePending')!.value, 'overview disputePending').toBe(p.disputePendingTotal);
  expect(kpiIn(an, 'recovered')!.value, 'analytics recovered').toBe(p.recoveredTotal);
  expect(kpiIn(an, 'disputePending')!.value, 'analytics disputePending').toBe(p.disputePendingTotal);
  if (p.measurements.count) {
    expect(kpiIn(an, 'measured')!.value).toBe(p.measurements.count);
    const methods = widget<'breakdown'>(an, 'methods')!;
    for (const [k, v] of Object.entries(p.measurements.byMethod)) expect(methods.items.find((i) => i.key === k)?.value ?? 0, `method ${k}`).toBe(v);
  }
  return { p, o, an };
}

describe('README örnek senaryosu: fedex-9-482-11735.csv', () => {
  // Örnek klasörü depoda izlenir; yoksa takım sessizce atlanmaz, kırılır.
  it('samples/ klasörü yerinde', () => {
    expect(samplesExist, 'Deciship/samples/expected.json yok').toBe(true);
  });

  let a: Actor;
  let invoiceId = '';

  beforeAll(async () => {
    a = await createCompany('Örnek Şirket');
    const worker = await createMember(a.companyId, 'Mehmet Demir', 'worker', 'MEASURE');
    await withCompany(a.companyId, () => loadSampleData(a.companyId, { fallbackUserId: worker.id }));
    const fedex = await prisma.carrier.findFirstOrThrow({ where: { companyId: a.companyId, code: 'fedex' } });
    invoiceId = (await importSample(app, a, 'fedex-9-482-11735.csv', fedex.id, { invoiceNo: '9-482-11735', invoiceDate: '2026-10-27' })).id;
  });

  // KALANLAR 1.8 (2026-11-14): #5288 aynı dosyada iki satırda → ikinci satırı (mükerrer 1.120,00) "İncele", Fazla ödeme dışında
  it('varsayılan ayarda 18 satır, 13 uyumlu, 4 fark, 1 eşleşmedi, 611,20 ₺', async () => {
    const o = await overview(a);
    const lead = o.kpis[0]!;
    expect(lead.id).toBe('overcharge');
    expect(lead).toMatchObject({ value: 611.2, format: 'money', currency: 'TRY' });
    expect(kpi(o, 'diffs')!.value).toBe(4);
    expect(kpi(o, 'open')!.value).toBe(4);
    expect(kpi(o, 'invoices')!.value).toBe(1);
    expect(kpi(o, 'coverage')!.value).toBe(94.4); // 17/18
    const an = await analytics(a);
    expect(kpiIn(an, 'lines')!.value).toBe(18);
    expect(kpiIn(an, 'overcharge')!.value).toBe(611.2);
    expect(kpiIn(an, 'estimated')!.value).toBe(1120); // İncele: #5288 ikinci satırı
    const types = widget<'breakdown'>(an, 'diff-types')!;
    expect(Object.fromEntries(types.items.map((i) => [i.key, i.value]))).toEqual({ DIMENSION: 458.5, WEIGHT: 96.4, PRICE: 56.3 });
    expect(types.items.map((i) => i.key)[0]).toBe('DIMENSION');
    expect(sumItems(types.items)).toBe(611.2);
  });

  it('"Faturalanan tutar nereye gitti" faturanın toplamına kuruşu kuruşuna eşit', async () => {
    const { split } = await overview(a);
    expect(split!.total).toEqual({ value: 28501.33, format: 'money', currency: 'TRY' });
    const parts = Object.fromEntries(split!.parts.map((p) => [p.key, p.value]));
    expect(parts).toEqual({ match: 21070.49, diff: 6753.8, unmatched: 677.04, noTariff: 0 });
    expect(sumItems(split!.parts)).toBe(28501.33);
  });

// KARARLAR "Geçmiş sonuçlar donar" (2026-11-10): ayar/tarife değişince fatura eski dayanağıyla kalır; yeni dayanağa recalculate ile geçilir.
  it('ek ücret ayarı açıkken 5 fark, 1.023,20 ₺; kapatınca geri döner', async () => {
    const admin = authHeader(a, ROLE.ADMIN);
    const set = async (v: boolean) => {
      await app.inject({ method: 'PATCH', url: '/api/settings', headers: admin, payload: { unknownSurchargesAsDiff: v } });
      // yardımcı (recalcHelpers) /api/deciship önekini varsayar; bu uygulama /api altında olduğundan aynı iki adım burada elle
      const p = await app.inject({ method: 'POST', url: `/api/invoices/${invoiceId}/recalculate/preview`, headers: admin, payload: { basis: 'rules' } });
      expect(p.statusCode, p.body).toBe(200);
      const r = await app.inject({ method: 'POST', url: `/api/invoices/${invoiceId}/recalculate`, headers: admin, payload: { basis: 'rules', token: p.json().token } });
      expect(r.statusCode, r.body).toBe(200);
    };
    await set(true);
    const o = await overview(a);
    expect(kpi(o, 'overcharge')!.value).toBe(1023.2);
    expect(kpi(o, 'diffs')!.value).toBe(5);
    const { p } = await expectSameAsPano(a);
    expect(p.overchargeTotal).toBe(1023.2);
    const types = widget<'breakdown'>(await analytics(a), 'diff-types')!;
    expect(Object.fromEntries(types.items.map((i) => [i.key, i.value]))).toEqual({ DIMENSION: 458.5, SURCHARGE: 412, WEIGHT: 96.4, PRICE: 56.3 });
    await set(false);
    expect(kpi(await overview(a), 'overcharge')!.value).toBe(611.2);
  });

  it('Pano ile aynı sayılar; fark türleri kartı karar yokken de aynı', async () => {
    const { p, an } = await expectSameAsPano(a);
    expect(p.invoices).toMatchObject({ count: 1, lines: 18, match: 13, diff: 4, unmatched: 1, noTariff: 0 });
    expect(p.measurements.count).toBeGreaterThan(0);
    const types = widget<'breakdown'>(an, 'diff-types')!;
    expect(types.items.map((i) => ({ type: i.key, amount: i.value }))).toEqual(p.topDiffTypes.map((t) => ({ type: t.type, amount: t.amount })));
  });

  it('veri setindeki satırlar KPI ile tutar, karar DIFF dışında boş', async () => {
    const diff = await get<{ total: number; rows: { href: string; cells: Record<string, unknown> }[] }>(a, `/platform/datasets/invoice-lines?filter.status=DIFF&filter.from=2026-10-01&filter.to=2026-10-31`);
    expect(diff.total).toBe(4);
    // satırlar ham farkı taşır: kesin satırlar KPI'ya (611,20), İncele satırı (#5288 mükerreri 1.120,00) ayrı
    const total = diff.rows.reduce((s, r) => s + Number(r.cells.diffAmount), 0);
    expect(Math.round(total * 100) / 100).toBe(1731.2);
    const firm = await get<{ total: number; rows: { cells: Record<string, unknown> }[] }>(a, `/platform/datasets/invoice-lines?filter.status=DIFF&filter.confidence=HIGH&filter.from=2026-10-01&filter.to=2026-10-31`);
    expect(firm.total).toBe(3);
    expect(Math.round(firm.rows.reduce((s, r) => s + Number(r.cells.diffAmount), 0) * 100) / 100).toBe(611.2);
    expect(diff.rows[0]!.href).toMatch(new RegExp(`^/deciship/invoices/${invoiceId}\\?tab=DIFF&line=`));
    const match = await get<{ total: number; rows: { cells: Record<string, unknown> }[] }>(a, `/platform/datasets/invoice-lines?filter.status=MATCH`);
    expect(match.total).toBe(13);
    expect(match.rows[0]!.cells.decision).toBeNull();
    const invoices = await get<{ rows: { href: string; cells: Record<string, unknown> }[] }>(a, '/platform/datasets/invoices');
    expect(invoices.rows[0]!.cells).toMatchObject({ no: '9-482-11735', lines: 18, match: 13, diff: 4, unmatched: 1, billed: 28501.33, overcharge: 611.2, lastDay: '2026-11-04' });
  });

  it('kararlar: VERIFIED fazla ödemede kalır, ACCEPTED düşer; kırılımlar baş rakama tutar', async () => {
    const lines = await prisma.invoiceLine.findMany({ where: { invoiceId, status: 'DIFF' }, orderBy: { rowIndex: 'asc' } });
    const admin = authHeader(a, ROLE.ADMIN);
    const decide = (id: string, decision: string, reason?: string) => app.inject({ method: 'PATCH', url: `/api/invoice-lines/${id}`, headers: admin, payload: { decision, reason } });
    const dim = lines.find((l) => l.diffTypes[0] === 'DIMENSION')!; // 458,50
    const weight = lines.find((l) => l.diffTypes[0] === 'WEIGHT')!; // 96,40
    expect((await decide(dim.id, 'VERIFIED')).statusCode).toBe(200);
    expect((await decide(weight.id, 'ACCEPTED', 'Tartı farkı önemsiz')).statusCode).toBe(200);

    const { p, o, an } = await expectSameAsPano(a);
    expect(p.overchargeTotal).toBe(514.8); // 611,20 − 96,40
    expect(p.verifiedTotal).toBe(458.5);
    expect(kpi(o, 'open')!.value).toBe(2);
    // Karar tablosu baş rakama tutar: Karar bekliyor + İtiraz listesinde = fazla ödeme.
    const summary = widget<'table'>(an, 'decision-summary')!;
    const row = (id: string) => summary.rows.find((r) => r.id === id)!.cells;
    // açık: fiyat farkı 56,30 + İncele mükerrer (fazla ödemeye girmez, `estimated` sütununda)
    expect(row('OPEN')).toMatchObject({ lines: 2, overcharge: 56.3, estimated: 1120 });
    expect(row('VERIFIED')).toMatchObject({ lines: 1, overcharge: 458.5 });
    expect(row('ACCEPTED')).toMatchObject({ lines: 1, overcharge: 0 });
    // Tür, taşıyıcı, ülke, hizmet: her kırılımın toplamı fazla ödeme.
    for (const id of ['diff-types', 'by-carrier', 'by-country', 'by-service']) expect(sumItems(widget<'breakdown'>(an, id)!.items), id).toBe(514.8);
    const trend = widget<'timeseries'>(an, 'overcharge-trend')!.series.find((s) => s.role === 'current')!;
    expect(trend.points.at(-1)!.y).toBe(514.8);
    expect(trend.points.length).toBe(31);
    expect(o.kpis[0]!.trend!.find((s) => s.role === 'current')!.points.at(-1)!.y).toBe(514.8);
    // Pano'nun "Fark türleri" kartı fazla ödemeyle aynı küme: kabul edilen satır düşer, Merkez ile aynı.
    expect(Math.round(p.topDiffTypes.reduce((s, t) => s + t.amount, 0) * 100) / 100).toBe(p.overchargeTotal);
    expect(p.topDiffTypes.map((t) => ({ type: t.type, amount: t.amount }))).toEqual(widget<'breakdown'>(an, 'diff-types')!.items.map((i) => ({ type: i.key, amount: i.value })));
    // Kararlar geri: sonraki testler etkilenmesin.
    await decide(dim.id, 'OPEN');
    await decide(weight.id, 'OPEN');
    expect(kpi(await overview(a), 'overcharge')!.value).toBe(611.2);
  });

  it('en çok fark çıkan gönderi sırası ve derin bağlantı', async () => {
    const top = widget<'table'>(await analytics(a), 'top-shipments')!;
    expect(top.rows.map((r) => r.cells.overcharge)).toEqual([458.5, 96.4, 56.3]);
    expect(top.rows[0]!.href).toMatch(new RegExp(`^/deciship/invoices/${invoiceId}\\?tab=DIFF&line=`));
    const topInv = widget<'table'>(await analytics(a), 'top-invoices')!;
    expect(topInv.rows).toHaveLength(1);
    expect(topInv.rows[0]!.cells).toMatchObject({ invoice: '9-482-11735', lines: 18, diff: 4, overcharge: 611.2 });
  });

  it('süzgeçler satırlardan toplar: taşıyıcı ve takip no', async () => {
    const fedex = await prisma.carrier.findFirstOrThrow({ where: { companyId: a.companyId, code: 'fedex' } });
    const other = await prisma.carrier.findFirstOrThrow({ where: { companyId: a.companyId, code: { not: 'fedex' } } });
    expect(kpiIn(await analytics(a, `${OCT}&filter.carrier=${fedex.id}`), 'overcharge')!.value).toBe(611.2);
    const none = await analytics(a, `${OCT}&filter.carrier=${other.id}`);
    expect(widgets(none).some((w) => w.kind === 'empty' && w.id === 'no-lines')).toBe(true);
    const one = await analytics(a, `${OCT}&filter.tracking=794812345305`);
    expect(kpiIn(one, 'overcharge')!.value).toBe(458.5);
    expect(kpiIn(one, 'lines')!.value).toBe(1);
  });

  it('önceki dönemle karşılaştırma ve gelecek günler', async () => {
    const fedex = await prisma.carrier.findFirstOrThrow({ where: { companyId: a.companyId, code: 'fedex' } });
    await insertInvoice(a, { carrierId: fedex.id, invoiceNo: 'KASIM-1', date: '2026-11-02', lines: [{ status: 'DIFF', net: 100, expected: 40, diff: 60, diffTypes: ['PRICE'] }] });
    const o = await overview(a, 'from=2026-11-01&to=2026-11-30');
    expect(o.kpis[0]).toMatchObject({ value: 60, previous: 611.2 });
    const prev = o.kpis[0]!.trend!.find((s) => s.role === 'previous')!;
    const cur = o.kpis[0]!.trend!.find((s) => s.role === 'current')!;
    expect(prev.points).toHaveLength(30);
    expect(cur.points).toHaveLength(30);
    expect(prev.points.at(-1)!.y).toBe(611.2);
    // Bugünden sonrası boş: çizgi geleceğe uzamaz.
    const today = turkeyDate(new Date());
    for (const pt of cur.points) expect(pt.y === null).toBe(pt.x > today);
    const an = await analytics(a, 'from=2026-11-01&to=2026-11-30&compare=previous');
    expect(an.compare).toEqual({ from: '2026-10-02', to: '2026-10-31' });
    expect(kpiIn(an, 'overcharge')).toMatchObject({ value: 60, previous: 611.2 });
    await expectSameAsPano(a, '2026-11', 'from=2026-11-01&to=2026-11-30');
    const off = await analytics(a, 'from=2026-11-01&to=2026-11-30');
    expect(off.compare).toBeUndefined();
    expect(kpiIn(off, 'overcharge')!.previous).toBeUndefined();
  });
});

describe('Pano kuralları: tahmini, örnek ve silinen faturalar', () => {
  let a: Actor;
  let carrierId = '';

  beforeAll(async () => {
    a = await createCompany('Kural Şirketi');
    carrierId = (await insertCarrier(a.companyId, 'fedex', 'FedEx')).id;
    await insertInvoice(a, {
      carrierId,
      invoiceNo: 'K-1',
      date: '2026-10-10',
      lines: [
        { status: 'MATCH', net: 100, expected: 100, diff: 0 },
        { status: 'MATCH', net: 90, expected: 100, diff: -10, note: 'Lehimize fark' },
        { status: 'DIFF', net: 300, expected: 200, diff: 100, diffTypes: ['DIMENSION', 'SURCHARGE'], service: 'Economy', country: 'DE' },
        { status: 'DIFF', net: 150, expected: 120, diff: 30, diffTypes: ['WEIGHT'], decision: 'VERIFIED', service: 'Economy', country: 'FR' },
        { status: 'DIFF', net: 80, expected: 60, diff: 20, diffTypes: ['PRICE'], decision: 'ACCEPTED', service: 'Priority', country: 'FR' },
        { status: 'DIFF', net: 70, expected: 60, diff: 10, diffTypes: ['PRICE'], low: true, service: 'Priority', country: 'FR' },
        { status: 'DIFF', net: 70, expected: 60, diff: 5, diffTypes: ['PRICE'], low: true, decision: 'VERIFIED', service: 'Priority' },
        { status: 'DIFF', net: 40, expected: 50, diff: -10, diffTypes: ['WEIGHT'] },
        { status: 'UNMATCHED', net: 11 },
        { status: 'UNMATCHED', net: 22, note: 'Pak/zarf gönderisi — kapsam dışı' },
        { status: 'NO_TARIFF', net: 33 },
      ],
    });
    await insertInvoice(a, { carrierId, invoiceNo: 'ORNEK', date: '2026-10-11', isSample: true, lines: [{ status: 'DIFF', net: 9000, expected: 1, diff: 8999, diffTypes: ['PRICE'] }] });
    const deleted = await insertInvoice(a, { carrierId, invoiceNo: 'SILINEN', date: '2026-10-12', lines: [{ status: 'DIFF', net: 7000, expected: 1, diff: 6999, diffTypes: ['PRICE'] }] });
    await prisma.invoice.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
    await insertInvoice(a, { carrierId, invoiceNo: 'EYLUL', date: '2026-09-30', lines: [{ status: 'DIFF', net: 500, expected: 100, diff: 400, diffTypes: ['PRICE'] }] });
    await insertInvoice(a, { carrierId, invoiceNo: 'KASIM', date: '2026-11-01', lines: [{ status: 'DIFF', net: 500, expected: 100, diff: 400, diffTypes: ['PRICE'] }] });
  });

  it('saklı toplam, satır toplamı ve Pano aynı', async () => {
    const { p, o, an } = await expectSameAsPano(a);
    expect(p.overchargeTotal).toBe(130); // 100 + 30; kabul (20), tahmini (10, 5), negatif yok
    expect(p.verifiedTotal).toBe(35); // 30 + tahmini doğrulanan 5 (computeTotals kuralı)
    expect(p.invoices).toMatchObject({ count: 1, lines: 11, diff: 6, match: 2, unmatched: 2, noTariff: 1 });
    expect(p.coveragePct).toBe(81.8); // 9/11
    expect(kpi(o, 'estimated')).toMatchObject({ value: 15, format: 'money' });
    expect(kpi(o, 'open')!.value).toBe(3);
    expect(kpiIn(an, 'estimated')!.value).toBe(15);
    const summary = widget<'table'>(an, 'decision-summary')!;
    const cell = (id: string) => summary.rows.find((r) => r.id === id)!.cells;
    expect(cell('OPEN')).toMatchObject({ lines: 3, overcharge: 100, estimated: 10 });
    expect(cell('VERIFIED')).toMatchObject({ lines: 2, overcharge: 30, estimated: 5 });
    expect(cell('ACCEPTED')).toMatchObject({ lines: 1, overcharge: 0, estimated: 0 });
  });

  it('split kabul edilen farkı ayırır, toplamı tutar, sınır günleri karışmaz', async () => {
    const { split } = await overview(a);
    const parts = Object.fromEntries(split!.parts.map((x) => [x.key, x.value]));
    expect(split!.total.value).toBe(966);
    expect(parts).toEqual({ match: 190, diff: 630, accepted: 80, unmatched: 33, noTariff: 33 });
    expect(sumItems(split!.parts)).toBe(966);
  });

  it('bekleyenler tutarlı; pak/zarf iş listesine girmez ve tıklanan satır sayısı başlıkla aynı', async () => {
    const { alerts } = await overview(a);
    const unmatched = alerts.find((x) => x.id === 'unmatched:TRY')!;
    expect(unmatched.title).toContain('1 fatura satırı eşleşmedi');
    expect(unmatched.amount).toEqual({ value: 11, format: 'money', currency: 'TRY' });
    expect(alerts.find((x) => x.id === 'no-tariff:TRY')!.amount!.value).toBe(33);
    const open = alerts.find((x) => x.id === 'open:TRY')!;
    expect(open.title).toContain('3 fark');
    // Süresi yaklaşan faturanın tutarı kendi maddesindedir, kuyruk kalanını taşır: kesin sayı consistency.test.ts'te, burada tarih bugüne bağlı.
    expect(open.amount?.value ?? 0).toBeLessThanOrEqual(100);
    const url = new URL(unmatched.href!, 'http://x');
    const res = await get<{ total: number }>(a, `/platform/datasets/invoice-lines${url.search}`);
    expect(res.total).toBe(1);
    const all = await get<{ total: number }>(a, `/platform/datasets/invoice-lines?filter.status=UNMATCHED&filter.from=2026-10-01&filter.to=2026-10-31`);
    expect(all.total).toBe(2);
    const openRes = await get<{ total: number }>(a, `/platform/datasets/invoice-lines${new URL(open.href!, 'http://x').search}`);
    expect(openRes.total).toBe(3);
  });

  it('KPI bağlantıları aynı dönem ve aynı sayıyı açar', async () => {
    const o = await overview(a);
    const res = await get<{ total: number }>(a, `/platform/datasets/invoice-lines${new URL(kpi(o, 'diffs')!.href!, 'http://x').search}`);
    expect(res.total).toBe(kpi(o, 'diffs')!.value);
    const low = await get<{ total: number; rows: { cells: Record<string, unknown> }[] }>(a, `/platform/datasets/invoice-lines${new URL(kpi(o, 'estimated')!.href!, 'http://x').search}`);
    expect(low.total).toBe(2);
    // KARARLAR "İncele" (2026-11-10): "Tahmini" sınıfının adı "İncele" oldu (EN "Review").
    expect(low.rows[0]!.cells.confidence).toBe('İncele');
    const high = await get<{ total: number }>(a, '/platform/datasets/invoice-lines?filter.confidence=HIGH&filter.from=2026-10-01&filter.to=2026-10-31');
    expect(high.total).toBe(9);
  });

  it('elle değişen stale toplam yok: refreshTotals sonrası SQL ile saklı toplam yine eşit', async () => {
    const inv = await prisma.invoice.findFirstOrThrow({ where: { companyId: a.companyId, invoiceNo: 'K-1' } });
    const totals = await withCompany(a.companyId, () => refreshTotals(inv.id));
    expect(totals.overchargeTotal).toBe(130);
    expect(totals.estimatedOverchargeTotal).toBe(15);
    expect(totals.estimatedLines).toBe(2);
  });
});

describe('çok para birimi: para birimleri toplanmaz', () => {
  let a: Actor;
  let carrierId = '';

  beforeAll(async () => {
    a = await createCompany('Döviz Şirketi', { currency: 'TRY' });
    carrierId = (await insertCarrier(a.companyId, 'ups', 'UPS')).id;
    await insertInvoice(a, { carrierId, invoiceNo: 'TL-1', date: '2026-10-05', currency: 'TRY', lines: [{ status: 'DIFF', net: 1000, expected: 800, diff: 200, diffTypes: ['PRICE'] }, { status: 'MATCH', net: 500, expected: 500, diff: 0 }] });
    await insertInvoice(a, { carrierId, invoiceNo: 'USD-1', date: '2026-10-06', currency: 'USD', lines: [{ status: 'DIFF', net: 100, expected: 70, diff: 30, diffTypes: ['WEIGHT'] }, { status: 'UNMATCHED', net: 50 }] });
  });

  it('baş rakam firma para biriminde, diğer para birimi ayrı KPI; sayılar birlikte', async () => {
    const o = await overview(a);
    expect(o.kpis[0]).toMatchObject({ id: 'overcharge', value: 200, currency: 'TRY' });
    expect(kpi(o, 'overcharge:USD')).toMatchObject({ value: 30, currency: 'USD', format: 'money' });
    expect(kpi(o, 'diffs')!.value).toBe(2);
    expect(kpi(o, 'coverage')!.value).toBe(75);
    expect(o.split!.total).toEqual({ value: 1500, format: 'money', currency: 'TRY' });
    expect(o.split!.title).toContain('TRY');
    // Bekleyen tutarı da para birimine göre ayrı.
    expect(o.alerts.find((x) => x.id === 'open:USD')!.amount).toEqual({ value: 30, format: 'money', currency: 'USD' });
    expect(o.alerts.find((x) => x.id === 'open:TRY')!.amount).toEqual({ value: 200, format: 'money', currency: 'TRY' });
    expect(o.alerts.find((x) => x.id === 'unmatched:USD')!.amount).toEqual({ value: 50, format: 'money', currency: 'USD' });
  });

  it('Pano ve Merkez para birimlerini aynı şekilde ayırır (230 diye toplanmaz)', async () => {
    const p = await pano(a);
    expect(p.overchargeTotal).toBe(200);
    const o = await overview(a);
    expect(kpi(o, 'overcharge')!.value).toBe(p.overchargeTotal);
    expect(kpi(o, 'overcharge:USD')!.value).toBe(30);
    // Sayılar Pano ile aynı.
    expect(kpi(o, 'diffs')!.value).toBe(p.invoices.diff);
    expect(kpi(o, 'coverage')!.value).toBe(p.coveragePct);
  });

  it('analiz seçili para biriminde; süzgeç yalnız birden çok para birimi varsa çıkar', async () => {
    const an = await analytics(a);
    expect(an.filters.find((f) => f.id === 'currency')).toBeDefined();
    expect(an.sections[0]!.description).toContain('TRY');
    expect(kpiIn(an, 'overcharge')).toMatchObject({ value: 200, currency: 'TRY' });
    const usd = await analytics(a, `${OCT}&filter.currency=USD`);
    expect(kpiIn(usd, 'overcharge')).toMatchObject({ value: 30, currency: 'USD' });
    expect(widget<'breakdown'>(usd, 'diff-types')).toMatchObject({ currency: 'USD' });
    const money = widgets(usd).flatMap((w) => (w.kind === 'table' ? w.columns : [])).filter((c) => c.format === 'money');
    expect(money.length).toBeGreaterThan(0);
    for (const c of money) expect(c.currency).toBe('USD');
  });

  it('veri seti: karışık sayfada yanlış simge yok, ham sayı + para birimi sütunu; tek para biriminde simge', async () => {
    const mixed = await get<{ columns: { id: string; format: string; currency?: string }[]; rows: { cells: Record<string, unknown> }[] }>(a, '/platform/datasets/invoices');
    expect(mixed.columns.find((c) => c.id === 'overcharge')).toMatchObject({ format: 'number' });
    expect(mixed.columns.find((c) => c.id === 'currency')).toBeDefined();
    expect(mixed.rows.map((r) => r.cells.currency).sort()).toEqual(['TRY', 'USD']);
    const single = await get<{ columns: { id: string; format: string; currency?: string }[]; rows: { cells: Record<string, unknown> }[] }>(a, '/platform/datasets/invoices?filter.currency=USD');
    expect(single.columns.find((c) => c.id === 'overcharge')).toMatchObject({ format: 'money', currency: 'USD' });
    expect(single.columns.find((c) => c.id === 'currency')).toBeUndefined();
    expect(single.rows[0]!.cells.currency).toBeUndefined();
  });

  it('firma para biriminde fatura yoksa baş rakam en çok satırı olan para biriminde; 0 ₺ yazmaz', async () => {
    const b = await createCompany('Yalnız Dolar', { currency: 'TRY' });
    const c = await insertCarrier(b.companyId, 'ups', 'UPS');
    await insertInvoice(b, { carrierId: c.id, invoiceNo: 'U-1', date: '2026-10-06', currency: 'USD', lines: [{ status: 'DIFF', net: 100, expected: 70, diff: 30, diffTypes: ['WEIGHT'] }] });
    const o = await overview(b);
    expect(o.kpis[0]).toMatchObject({ value: 30, currency: 'USD' });
    expect(kpi(o, 'overcharge:TRY')).toBeUndefined();
  });
  it('yalnız başka para biriminde faturalanan taşıyıcı: Analiz boş (—) yazar, Genel Bakış söyler; 0 yazılmaz', async () => {
    const b = await createCompany('Dolar Taşıyıcı', { currency: 'TRY' });
    const ups = await insertCarrier(b.companyId, 'ups', 'UPS');
    const dhl = await insertCarrier(b.companyId, 'dhl', 'DHL');
    await insertInvoice(b, { carrierId: ups.id, invoiceNo: 'T-1', date: '2026-10-05', currency: 'TRY', lines: [{ status: 'DIFF', net: 1000, expected: 800, diff: 200, diffTypes: ['PRICE'] }] });
    await insertInvoice(b, { carrierId: dhl.id, invoiceNo: 'D-1', date: '2026-10-06', currency: 'USD', lines: [{ status: 'DIFF', net: 100, expected: 70, diff: 30, diffTypes: ['WEIGHT'] }, { status: 'MATCH', net: 50, expected: 50, diff: 0 }] });
    const an = await analytics(b);
    const t = widget<'table'>(an, 'carrier-rates')!;
    const row = (name: string) => t.rows.find((r) => r.cells.carrier === name)!;
    expect(row('DHL').cells).toMatchObject({ lines: 2, diff: 1, billed: null, overcharge: null, overchargeRate: null, note: 'Başka para biriminde' });
    expect(row('UPS').cells).toMatchObject({ billed: 1000, overcharge: 200, note: null });
    const o = await overview(b);
    expect(o.leaders!.some((l) => l.name === 'DHL')).toBe(false);
    expect(o.alerts.find((x) => x.id === 'other-currency')!.title).toContain('DHL');
  });
});

describe('itiraz süresi: core `disputeDeadlines` ile', () => {
  const today = turkeyDate(new Date());
  let a: Actor;
  let fedex = '';
  let ups = '';

  beforeAll(async () => {
    a = await createCompany('Süre Şirketi');
    fedex = (await insertCarrier(a.companyId, 'fedex', 'FedEx')).id;
    ups = (await insertCarrier(a.companyId, 'ups', 'UPS')).id;
    const diff = (n: number) => [{ status: 'DIFF' as const, net: n + 10, expected: 10, diff: n, diffTypes: ['PRICE'] }];
    await insertInvoice(a, { carrierId: ups, invoiceNo: 'SON-GUN', date: isoShift(today, -8), lines: diff(100) }); // bugün son gün
    await insertInvoice(a, { carrierId: ups, invoiceNo: 'UC-GUN', date: isoShift(today, -5), lines: diff(200) }); // 3 gün
    await insertInvoice(a, { carrierId: ups, invoiceNo: 'GECMIS', date: isoShift(today, -9), lines: diff(300) }); // TTK bitti, FedEx değil
    await insertInvoice(a, { carrierId: fedex, invoiceNo: 'FEDEX-25', date: isoShift(today, -25), lines: diff(400) }); // FedEx son 5 gün
    await insertInvoice(a, { carrierId: fedex, invoiceNo: 'FEDEX-15', date: isoShift(today, -15), lines: diff(500) }); // FedEx 15 gün: yaklaşmıyor
    await insertInvoice(a, { carrierId: ups, invoiceNo: 'FARKSIZ', date: isoShift(today, -2), lines: [{ status: 'MATCH', net: 10, expected: 10, diff: 0 }] });
    await insertInvoice(a, { carrierId: ups, invoiceNo: 'KABUL', date: isoShift(today, -2), lines: [{ status: 'DIFF', net: 60, expected: 10, diff: 50, diffTypes: ['PRICE'], decision: 'ACCEPTED' }] });
  });

  it('yalnız süresi yaklaşan ve tutarı olan faturalar, en acili önce; döneme bağlı değil', async () => {
    // Seçili dönem geçmişte: yine de bugüne göre.
    const o = await overview(a, 'from=2020-01-01&to=2020-01-31');
    expect(kpi(o, 'deadlines')!.value).toBe(3);
    const alerts = o.alerts.filter((x) => x.id.startsWith('deadline:'));
    expect(alerts.map((x) => x.title)).toEqual(['UPS SON-GUN faturasında 1 fark', 'UPS UC-GUN faturasında 1 fark', 'FedEx FEDEX-25 faturasında 1 fark']);
    expect(alerts[0]).toMatchObject({ tone: 'bad', amount: { value: 100, format: 'money', currency: 'TRY' } });
    expect(alerts[0]!.body).toMatch(/^İtiraz için son gün \d{2}\.\d{2}\.\d{4}\.$/);
    expect(alerts[1]!.tone).toBe('warning');
    expect(alerts[1]!.dueAt).toBeTruthy();
    expect(alerts[1]!.body).not.toContain('gün kaldı');
    expect(alerts[2]!.body).toContain('FedEx düzeltme için son gün');
    expect(alerts[0]!.href).toMatch(/^\/deciship\/invoices\/[^/]+\?tab=DIFF$/);
  });

  it('veri seti süzgeci aynı listeyi verir', async () => {
    const res = await get<{ total: number; rows: { cells: { no: string } }[] }>(a, '/platform/datasets/invoices?filter.deadline=soon');
    expect(res.total).toBe(3);
    expect(res.rows.map((r) => r.cells.no).sort()).toEqual(['FEDEX-25', 'SON-GUN', 'UC-GUN']);
  });

  it('itirazı gönderilmiş fatura süresi yaklaşanlardan çıkar; geri çekilince döner', async () => {
    const inv = await insertInvoice(a, { carrierId: ups, invoiceNo: 'GONDERILDI', date: isoShift(today, -4), lines: [{ status: 'DIFF', net: 80, expected: 10, diff: 70, diffTypes: ['PRICE'], decision: 'VERIFIED' }] });
    const soon = async () => {
      const o = await overview(a, 'from=2020-01-01&to=2020-01-31');
      const ds = await get<{ rows: { cells: { no: string } }[] }>(a, '/platform/datasets/invoices?filter.deadline=soon');
      return { kpi: kpi(o, 'deadlines')!.value, alert: o.alerts.some((x) => x.id === `deadline:${inv.id}`), rows: ds.rows.map((r) => r.cells.no).includes('GONDERILDI') };
    };
    expect(await soon()).toEqual({ kpi: 4, alert: true, rows: true });
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url: `/api${url}`, headers: authHeader(a, ROLE.ADMIN), payload: payload as object });
    const sent = await post(`/invoices/${inv.id}/disputes`, { sentOn: today, channel: 'EMAIL', selectionDigest: await digestOf(app, authHeader(a, ROLE.ADMIN), inv.id, '/api') });
    expect(sent.statusCode, sent.body).toBe(201);
    expect(sent.json().dispute.active.ttk).toBe('ON_TIME');
    expect(await soon()).toEqual({ kpi: 3, alert: false, rows: false });
    const round = sent.json().dispute.active;
    expect((await post(`/disputes/${round.id}/withdraw`, { version: round.version, reason: 'yanlış fatura' })).statusCode).toBe(200);
    expect(await soon()).toEqual({ kpi: 4, alert: true, rows: true });
  });
});

describe('tarife ve ölçüm bekleyenleri', () => {
  it('etkin tarifesi olmayan taşıyıcı, süresi yaklaşan ve dolan tarife, fotoğrafsız ölçüm', async () => {
    const a = await createCompany('Tarife Şirketi');
    const none = await insertCarrier(a.companyId, 'dhl', 'DHL');
    const soon = await insertCarrier(a.companyId, 'ups', 'UPS');
    const gone = await insertCarrier(a.companyId, 'aras', 'Aras');
    const today = turkeyDate(new Date());
    const tariff = (carrierId: string, name: string, validTo: string) =>
      prisma.tariff.create({ data: { companyId: a.companyId, carrierId, name, currency: 'TRY', divisor: 5000, weightSteps: [], validTo: new Date(`${validTo}T00:00:00.000Z`), isDefault: true } });
    await tariff(soon.id, 'UPS 2026', isoShift(today, 9));
    await tariff(gone.id, 'Aras 2025', isoShift(today, -4));
    await prisma.measurement.create({
      data: { companyId: a.companyId, clientId: `c-${a.companyId}`, trackingRaw: 'T1', trackingNo: 'T1', lengthCm: 10, widthCm: 10, heightCm: 10, weightKg: 1, dimMethod: 'LIDAR', weightMethod: 'MANUAL', measuredById: a.userId, measuredAt: new Date() },
    });
    const o = await overview(a, `from=${today}&to=${today}`);
    const titles = o.alerts.map((x) => x.title);
    expect(titles).toContain('DHL için etkin tarife yok');
    expect(titles).toContain('UPS 2026 tarifesinin süresi 9 gün sonra doluyor');
    expect(titles).toContain('Aras 2025 tarifesinin süresi 4 gün önce doldu');
    expect(o.alerts.find((x) => x.id === `tariff-none:${none.id}`)!.href).toBe(`/deciship/tariffs?carrier=${none.id}`);
    expect(o.alerts.find((x) => x.id === 'no-photo')!.title).toBe('1 koli fotoğrafsız ölçüldü');
    // Ölçüm var, fatura yok: baş rakam 0, gerekçesi yazılı.
    expect(o.kpis[0]).toMatchObject({ value: 0, hint: 'Bu dönemde işlenmiş fatura yok.' });
    expect(kpi(o, 'coverage')!.value).toBeNull();
  });
});
