/**
 * Pano ve Merkez aynı veride aynı sayıyı verir: para birimleri toplanmaz, fark türleri kartı fazla ödemeyle tutar,
 * ölçüm dönemi firmanın saat dilimindedir, ölçüm oluşturma denetim izine yazılır.
 */
import { createRequire } from 'node:module';
import type { HubActivityPage, HubAnalytics, HubKpi, HubOverview, HubWidget } from '@sellerondata/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { zonedDate, zonedDayStart } from '../../src/lib/time.ts';
import { getApp, measurementPayload, registerCompany, createWorker, inCompany } from '../helpers.ts';
import { prisma, ROLE, authHeader, buildHubApp, createCompany, createMember, insertCarrier, insertInvoice, type Actor } from './harness.ts';
import { digestOf } from '../disputeHelpers.ts';

type TopType = { type: string; count: number; amount: number };
type Pano = {
  month: string;
  currency: string;
  overchargeTotal: number;
  verifiedTotal: number;
  recoveredTotal: number;
  disputePendingTotal: number;
  topDiffTypes: TopType[];
  measurements: { count: number; today: number };
  invoices: { count: number; lines: number; diff: number };
  otherCurrencies: string[];
  byCurrency: { currency: string; invoices: number; lines: number; billedTotal: number; overchargeTotal: number; estimatedOverchargeTotal: number; verifiedTotal: number; recoveredTotal: number; disputePendingTotal: number; topDiffTypes: TopType[] }[];
  recentInvoices: { invoiceNo: string; currency: string }[];
};

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildHubApp();
});
afterAll(async () => {
  await app.close();
});

const get = async <T>(actor: Actor, url: string, locale = 'tr') => {
  const res = await app.inject({ method: 'GET', url: `/api${url}`, headers: authHeader(actor, ROLE.ADMIN, locale) });
  if (res.statusCode !== 200) throw new Error(`${url} -> ${res.statusCode} ${res.body}`);
  return res.json() as T;
};
const pano = (a: Actor, month = '2026-10') => get<Pano>(a, `/dashboard?month=${month}`);
const overview = (a: Actor, q = 'from=2026-10-01&to=2026-10-31') => get<HubOverview>(a, `/platform/overview?${q}`);
const analytics = (a: Actor, q = 'from=2026-10-01&to=2026-10-31') => get<HubAnalytics>(a, `/platform/analytics?${q}`);
type HubDatasetListLike = { datasets: { id: string; filters: { id: string; options?: { value: string; label: string }[] }[] }[] };
const kpi = (o: { kpis: HubKpi[] }, id: string) => o.kpis.find((k) => k.id === id);
const widgets = (an: HubAnalytics) => an.sections.flatMap((s) => s.widgets);
const widget = <K extends HubWidget['kind']>(an: HubAnalytics, id: string) => widgets(an).find((w) => w.id === id) as Extract<HubWidget, { kind: K }> | undefined;

/** Saat dilimi Merkez'den gelir (`org.updated`; `PATCH /settings` kabul etmez, Y131): test doğrudan yazar. */
async function setTimeZone(a: Actor, timeZone: string) {
  const c = await prisma.company.findUniqueOrThrow({ where: { id: a.companyId } });
  await prisma.company.update({ where: { id: a.companyId }, data: { settings: { ...((c.settings as object | null) ?? {}), timeZone } } });
}

describe('Pano: para birimleri toplanmaz', () => {
  let a: Actor;
  beforeAll(async () => {
    a = await createCompany('Çok Para');
    const carrier = await insertCarrier(a.companyId, 'fedex', 'FedEx');
    await insertInvoice(a, { carrierId: carrier.id, invoiceNo: 'T-1', date: '2026-10-10', lines: [{ status: 'DIFF', net: 700, expected: 500, diff: 200, diffTypes: ['PRICE'], decision: 'VERIFIED' }] });
    await insertInvoice(a, { carrierId: carrier.id, invoiceNo: 'U-1', date: '2026-10-11', currency: 'USD', lines: [{ status: 'DIFF', net: 100, expected: 70, diff: 30, diffTypes: ['PRICE'] }, { status: 'MATCH', net: 50, expected: 50, diff: 0 }] });
  });

  it('200 TRY + 30 USD 230 olmaz: baş rakam firma para biriminde, diğeri ayrı', async () => {
    const p = await pano(a);
    expect(p.currency).toBe('TRY');
    expect(p.overchargeTotal).toBe(200);
    expect(p.verifiedTotal).toBe(200);
    expect(p.topDiffTypes).toEqual([{ type: 'PRICE', count: 1, amount: 200 }]);
    expect(p.otherCurrencies).toEqual(['USD']);
    expect(p.byCurrency).toEqual([
      { currency: 'TRY', invoices: 1, lines: 1, billedTotal: 700, overchargeTotal: 200, estimatedOverchargeTotal: 0, verifiedTotal: 200, recoveredTotal: 0, disputePendingTotal: 0, topDiffTypes: [{ type: 'PRICE', count: 1, amount: 200 }] },
      { currency: 'USD', invoices: 1, lines: 2, billedTotal: 150, overchargeTotal: 30, estimatedOverchargeTotal: 0, verifiedTotal: 0, recoveredTotal: 0, disputePendingTotal: 0, topDiffTypes: [{ type: 'PRICE', count: 1, amount: 30 }] },
    ]);
    // sayılar para biriminden bağımsız, toplam kalır
    expect(p.invoices).toMatchObject({ count: 2, lines: 3, diff: 2 });
    expect(p.recentInvoices.map((i) => [i.invoiceNo, i.currency]).sort()).toEqual([['T-1', 'TRY'], ['U-1', 'USD']]);
  });

  it('Merkez aynı sayıları verir', async () => {
    const [p, o] = await Promise.all([pano(a), overview(a)]);
    expect(kpi(o, 'overcharge')).toMatchObject({ value: p.overchargeTotal, currency: p.currency });
    expect(kpi(o, 'overcharge:USD')).toMatchObject({ value: p.byCurrency[1]!.overchargeTotal, currency: 'USD' });
    const usd = await analytics(a, 'from=2026-10-01&to=2026-10-31&filter.currency=USD');
    const types = widget<'breakdown'>(usd, 'diff-types')!;
    expect(types.items.map((i) => ({ type: i.key, amount: i.value }))).toEqual(p.byCurrency[1]!.topDiffTypes.map((t) => ({ type: t.type, amount: t.amount })));
  });

  it('para dışı sayılar para biriminden bağımsız: Pano, Genel Bakış ve Analiz aynı; süzgeç yalnız tutarda', async () => {
    const [p, o, an, usd] = await Promise.all([pano(a), overview(a), analytics(a), analytics(a, 'from=2026-10-01&to=2026-10-31&filter.currency=USD')]);
    const kpiOf = (doc: HubAnalytics, id: string) => widgets(doc).flatMap((w) => (w.kind === 'kpis' ? w.items : [])).find((k) => k.id === id);
    for (const doc of [an, usd]) {
      expect(kpiOf(doc, 'lines')?.value).toBe(3);
      expect(kpiOf(doc, 'lines')?.value).toBe((p as unknown as { invoices: { lines: number } }).invoices.lines);
      expect(kpiOf(doc, 'diffs')?.value).toBe(2);
      expect(kpiOf(doc, 'diffs')?.value).toBe(kpi(o, 'diffs')?.value);
      expect(kpiOf(doc, 'open')?.value).toBe(kpi(o, 'open')?.value);
      expect(kpiOf(doc, 'diff-rate')?.value).toBeCloseTo((2 / 3) * 100, 0);
      const table = widget<'table'>(doc, 'carrier-rates')!;
      expect(table.rows[0]!.cells).toMatchObject({ lines: 3, diff: 2 });
      expect(widget<'breakdown'>(doc, 'decision-lines')!.items.reduce((n, i) => n + i.value, 0)).toBe(2);
    }
    // tutarlar süzgece uyar, toplanmaz
    expect(kpiOf(an, 'overcharge')).toMatchObject({ value: 200, currency: 'TRY' });
    expect(kpiOf(usd, 'overcharge')).toMatchObject({ value: 30, currency: 'USD' });
    expect(kpiOf(an, 'billed')?.value).toBe(700);
    expect(kpiOf(usd, 'billed')?.value).toBe(150);
    expect(widget<'table'>(an, 'carrier-rates')!.rows[0]!.cells).toMatchObject({ billed: 700, overcharge: 200 });
    expect(widget<'table'>(usd, 'carrier-rates')!.rows[0]!.cells).toMatchObject({ billed: 150, overcharge: 30 });
    // sayının bağlantısı süzgeç taşımaz: açılan listede aynı sayı görünür
    expect(String(kpiOf(an, 'lines')?.href ?? '')).not.toContain('currency');
    expect(String(kpiOf(an, 'verified')?.href)).toContain('currency');
  });

  it('kapsam Pano, Genel Bakış ve Analiz arasında aynı', async () => {
    const m = await createCompany('Kapsam');
    const carrier = await insertCarrier(m.companyId, 'fedex', 'FedEx');
    await insertInvoice(m, { carrierId: carrier.id, invoiceNo: 'T-1', date: '2026-10-10', lines: [{ status: 'MATCH', net: 10, expected: 10, diff: 0 }, { status: 'UNMATCHED', net: 10 }] });
    await insertInvoice(m, { carrierId: carrier.id, invoiceNo: 'U-1', date: '2026-10-11', currency: 'USD', lines: Array.from({ length: 6 }, () => ({ status: 'UNMATCHED', net: 5 })) });
    const measured = await prisma.member.findFirstOrThrow({ where: { companyId: m.companyId } });
    await prisma.measurement.create({ data: { companyId: m.companyId, clientId: 'k1', trackingRaw: 'K1', trackingNo: 'K1', lengthCm: 1, widthCm: 1, heightCm: 1, weightKg: 1, dimMethod: 'MANUAL', weightMethod: 'MANUAL', measuredById: measured.id, measuredAt: new Date('2026-10-10T10:00:00Z') } });
    const [p, o, an] = await Promise.all([pano(m), overview(m), analytics(m)]);
    const coverage = widgets(an).flatMap((w) => (w.kind === 'kpis' ? w.items : [])).find((k) => k.id === 'coverage')?.value;
    expect((p as unknown as { coveragePct: number }).coveragePct).toBe(12.5);
    expect(kpi(o, 'coverage')?.value).toBe(12.5);
    expect(coverage).toBe(12.5);
  });

  it('dönemde ölçüm olmasa da kapsam satırlardan hesaplanır: Analiz, Pano ile aynı', async () => {
    const m = await createCompany('Ölçümsüz Dönem');
    const carrier = await insertCarrier(m.companyId, 'fedex', 'FedEx');
    await insertInvoice(m, { carrierId: carrier.id, invoiceNo: 'T-1', date: '2026-10-10', lines: [{ status: 'MATCH', net: 10, expected: 10, diff: 0 }, { status: 'UNMATCHED', net: 10 }, { status: 'UNMATCHED', net: 10 }, { status: 'UNMATCHED', net: 10 }] });
    const [p, an] = await Promise.all([pano(m), analytics(m)]);
    const coverage = widgets(an).flatMap((w) => (w.kind === 'kpis' ? w.items : [])).find((k) => k.id === 'coverage')?.value;
    expect((p as unknown as { coveragePct: number }).coveragePct).toBe(25);
    expect(coverage).toBe(25);
    // dönemde ölçüm yok bilgisi de durur
    expect(an.sections.find((s) => s.id === 'measure')!.widgets.some((w) => w.kind === 'empty')).toBe(true);
  });

  it('firma para biriminde fatura yoksa baş rakam en çok satırlı para biriminde', async () => {
    const b = await createCompany('Yalnız Dolar');
    const carrier = await insertCarrier(b.companyId, 'fedex', 'FedEx');
    await insertInvoice(b, { carrierId: carrier.id, invoiceNo: 'U-2', date: '2026-10-11', currency: 'USD', lines: [{ status: 'DIFF', net: 100, expected: 70, diff: 30, diffTypes: ['WEIGHT'] }] });
    const p = await pano(b);
    expect(p).toMatchObject({ currency: 'USD', overchargeTotal: 30, otherCurrencies: [] });
    expect(kpi(await overview(b), 'overcharge')).toMatchObject({ value: 30, currency: 'USD' });
  });
});

describe('Pano: fark türleri kartı fazla ödemeyle tutar', () => {
  it('kabul edilen ve tahmini satır düşer; toplam KPI ve Merkez ile aynı', async () => {
    const a = await createCompany('Fark Türleri');
    const carrier = await insertCarrier(a.companyId, 'fedex', 'FedEx');
    await insertInvoice(a, {
      carrierId: carrier.id,
      invoiceNo: 'F-1',
      date: '2026-10-10',
      lines: [
        { status: 'DIFF', net: 1500, expected: 380, diff: 1120, diffTypes: ['DIMENSION'] },
        { status: 'DIFF', net: 558.5, expected: 100, diff: 458.5, diffTypes: ['WEIGHT'], decision: 'VERIFIED' },
        { status: 'DIFF', net: 196.4, expected: 100, diff: 96.4, diffTypes: ['WEIGHT'], decision: 'ACCEPTED' },
        { status: 'DIFF', net: 156.3, expected: 100, diff: 56.3, diffTypes: ['PRICE'] },
        { status: 'DIFF', net: 180, expected: 100, diff: 80, diffTypes: ['PRICE'], low: true },
      ],
    });
    const [p, o, an] = await Promise.all([pano(a), overview(a), analytics(a)]);
    expect(p.overchargeTotal).toBe(1634.8);
    expect(p.topDiffTypes).toEqual([
      { type: 'DIMENSION', count: 1, amount: 1120 },
      { type: 'WEIGHT', count: 1, amount: 458.5 },
      { type: 'PRICE', count: 1, amount: 56.3 },
    ]);
    expect(Math.round(p.topDiffTypes.reduce((s, t) => s + t.amount, 0) * 100) / 100).toBe(p.overchargeTotal);
    expect(kpi(o, 'overcharge')!.value).toBe(p.overchargeTotal);
    const types = widget<'breakdown'>(an, 'diff-types')!;
    expect(types.items.map((i) => ({ type: i.key, amount: i.value }))).toEqual(p.topDiffTypes.map((t) => ({ type: t.type, amount: t.amount })));
    expect(p.byCurrency[0]).toMatchObject({ estimatedOverchargeTotal: 80, overchargeTotal: 1634.8 });
  });
});

describe('Saat dilimi: ölçüm dönemi firmanın gününde, fatura günü kaymaz', () => {
  let a: Actor;
  let workerId = '';
  const measure = (trackingNo: string, measuredAt: string) =>
    prisma.measurement.create({
      data: { companyId: a.companyId, clientId: `${trackingNo}-${a.companyId}`, trackingRaw: trackingNo, trackingNo, lengthCm: 10, widthCm: 10, heightCm: 10, weightKg: 1, dimMethod: 'MANUAL', weightMethod: 'MANUAL', measuredById: workerId, measuredAt: new Date(measuredAt) },
    });

  beforeAll(async () => {
    a = await createCompany('Saat Dilimi');
    workerId = (await createMember(a.companyId, 'Gece Vardiyası', 'worker', 'MEASURE')).id;
    const carrier = await insertCarrier(a.companyId, 'fedex', 'FedEx');
    // Türkiye'de 1 Kasım 00:30 (UTC 31 Ekim 21:30); UTC'ye göre ekimde kalırdı
    await measure('GECE1', '2026-10-31T21:30:00.000Z');
    // Türkiye'de 31 Ekim 23:30: ekimde kalır
    await measure('GECE2', '2026-10-31T20:30:00.000Z');
    // ay başı fatura: gün tabanlı, hangi dilimde olursa olsun 1 Kasım
    await insertInvoice(a, { carrierId: carrier.id, invoiceNo: 'GUN-1', date: '2026-11-01', lines: [{ status: 'DIFF', net: 10, expected: 5, diff: 5, diffTypes: ['PRICE'] }] });
  });

  it('varsayılan Europe/Istanbul: gece 00:30 ölçümü yeni ayda; Pano ve Merkez aynı', async () => {
    const [oct, nov] = await Promise.all([pano(a, '2026-10'), pano(a, '2026-11')]);
    expect(oct.measurements.count).toBe(1);
    expect(nov.measurements.count).toBe(1);
    expect(nov.invoices.count).toBe(1);
    const novQ = 'from=2026-11-01&to=2026-11-30';
    const [oOct, oNov, anNov] = await Promise.all([overview(a), overview(a, novQ), analytics(a, novQ)]);
    expect(kpi(oOct, 'measured')!.value).toBe(oct.measurements.count);
    expect(kpi(oNov, 'measured')!.value).toBe(nov.measurements.count);
    expect(kpi(oNov, 'overcharge')!.value).toBe(nov.overchargeTotal);
    const chart = widget<'timeseries'>(anNov, 'measured-trend') ?? widgets(anNov).find((w) => w.kind === 'timeseries' && w.id.includes('measur'));
    expect(chart).toBeDefined();
    const points = (chart as Extract<HubWidget, { kind: 'timeseries' }>).series.find((s) => s.role === 'current')!.points;
    expect(points[0]).toMatchObject({ x: '2026-11-01', y: 1 });
  });

  it('Merkez veri seti süzgeci aynı günü kullanır', async () => {
    const day = await get<{ total: number; rows: { cells: Record<string, unknown> }[] }>(a, '/platform/datasets/measurements?filter.from=2026-11-01&filter.to=2026-11-01');
    expect(day.rows.map((r) => r.cells.tracking)).toEqual(['GECE1']);
    const prev = await get<{ rows: { cells: Record<string, unknown> }[] }>(a, '/platform/datasets/measurements?filter.from=2026-10-31&filter.to=2026-10-31');
    expect(prev.rows.map((r) => r.cells.tracking)).toEqual(['GECE2']);
  });

  it('firma saat dilimi değişince ölçüm günü değişir, fatura günü değişmez', async () => {
    await setTimeZone(a, 'UTC');
    const [oct, nov] = await Promise.all([pano(a, '2026-10'), pano(a, '2026-11')]);
    expect(oct.measurements.count).toBe(2);
    expect(nov.measurements.count).toBe(0);
    expect(nov.invoices.count).toBe(1);
    await setTimeZone(a, 'Europe/Istanbul');
  });

  it('ölçüm listesi ve bugünkü sayı da firmanın gününü kullanır', async () => {
    const real = await getApp();
    const admin = await registerCompany(real, 'Liste Günü');
    const worker = await createWorker(real, admin.auth);
    // Şimdiye göre (sunucu ölçüm anını en çok 730 gün geriden kabul eder, KALANLAR 6.7): 10 gün önceki İstanbul günü D,
    // ölçüm D'nin 00:30'u (UTC'de bir önceki gün 21:30). İstanbul yaz saati uygulamaz (sabit +03).
    const utcDay = (offsetDays: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + offsetDays)).toISOString().slice(0, 10);
    const day = utcDay(-10);
    const dayBefore = utcDay(-11);
    const p = measurementPayload({ trackingRaw: 'LISTE1', measuredAt: `${dayBefore}T21:30:00.000Z` });
    expect((await real.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...worker.auth, ...p.headers }, payload: p.payload })).statusCode).toBe(201);
    const list = async (q: string) => (await real.inject({ method: 'GET', url: `/api/deciship/measurements?${q}`, headers: admin.auth })).json().total as number;
    expect(await list(`from=${day}&to=${day}`)).toBe(1);
    expect(await list(`from=${dayBefore}&to=${dayBefore}`)).toBe(0);
    const n = measurementPayload({ trackingRaw: 'LISTE2' });
    await real.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...worker.auth, ...n.headers }, payload: n.payload });
    const stats = await real.inject({ method: 'GET', url: '/api/deciship/measurements/stats/today', headers: worker.auth });
    expect(stats.json().count).toBe(1);
  });

  it('gün sınırı hesabı: yaz saati geçişi dahil', () => {
    expect(zonedDayStart('2026-11-01', 'Europe/Istanbul').toISOString()).toBe('2026-10-31T21:00:00.000Z');
    expect(zonedDayStart('2026-11-01', 'UTC').toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(zonedDayStart('2026-03-29', 'Europe/Berlin').toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(zonedDayStart('2026-03-30', 'Europe/Berlin').toISOString()).toBe('2026-03-29T22:00:00.000Z');
    expect(zonedDate(new Date('2026-10-31T21:30:00.000Z'), 'Europe/Istanbul')).toBe('2026-11-01');
    expect(zonedDate(new Date('2026-10-31T21:30:00.000Z'), 'UTC')).toBe('2026-10-31');
  });

  it('saat dilimi ayar ucundan yazılmaz (Y131: tek yazarı Merkez), geçerli ad da reddedilir', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/settings', headers: authHeader(a, ROLE.ADMIN), payload: { timeZone: 'UTC' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });
});

describe('Etkinlik: ölçüm oluşturma denetim izine yazılır', () => {
  const pg = createRequire(import.meta.url)('pg') as { Client: { prototype: { query: (...a: unknown[]) => unknown } } };

  it('ilk ölçüm yazılır, tekrar gönderim ikinci kayıt açmaz, yeniden ölçüm ayrı; Merkez TR/EN gösterir', async () => {
    const real = await getApp();
    const admin = await registerCompany(real, 'Etkinlik');
    const worker = await createWorker(real, admin.auth);
    const post = (p: ReturnType<typeof measurementPayload>) => real.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...worker.auth, ...p.headers }, payload: p.payload });
    const logs = () => inCompany(admin.auth, () => prisma.auditLog.findMany({ where: { action: { startsWith: 'measurement.' }, companyId: admin.companyId }, orderBy: { createdAt: 'asc' } }));

    const first = measurementPayload({ trackingRaw: 'ETKINLIK1' });
    const created = await post(first);
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().measurement.id as string;
    expect((await logs()).map((l) => [l.action, l.entityId, l.userId])).toEqual([['measurement.create', id, worker.userId]]);

    // mobil kuyruk aynı clientId ile yeniden gönderir
    expect((await post(first)).statusCode).toBe(200);
    expect(await logs()).toHaveLength(1);

    const again = await post(measurementPayload({ trackingRaw: 'ETKINLIK1' }));
    expect(again.statusCode).toBe(201);
    expect((await logs()).map((l) => l.action)).toEqual(['measurement.create', 'measurement.remeasure']);

    const actor = { companyId: admin.companyId, userId: admin.userId };
    const hubApp = app;
    const page = async (locale: string) => {
      const res = await hubApp.inject({ method: 'GET', url: '/api/platform/activity', headers: authHeader(actor, ROLE.ADMIN, locale) });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as HubActivityPage;
    };
    const tr = await page('tr');
    const en = await page('en');
    expect(tr.items.map((i) => i.action)).toContain('koli ölçtü');
    expect(en.items.map((i) => i.action)).toContain('measured a parcel');
    const item = tr.items.find((i) => i.action === 'koli ölçtü')!;
    expect(item.target).toBe('ETKINLIK1');
  });

  it('yeniden hesaplama eylemleri etkinlikte TR/EN görünür', async () => {
    const real = await getApp();
    const admin = await registerCompany(real, 'Yeniden Hesap');
    await inCompany(admin.auth, async () => {
      for (const action of ['invoice.recalculate', 'tariff.recompare', 'settings.recompare']) {
        await prisma.auditLog.create({ data: { companyId: admin.companyId, userId: admin.userId, action, entity: 'Company', entityId: admin.companyId, data: {} } });
      }
    });
    const actor = { companyId: admin.companyId, userId: admin.userId };
    const page = async (locale: string) => {
      const res = await app.inject({ method: 'GET', url: '/api/platform/activity', headers: authHeader(actor, ROLE.ADMIN, locale) });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as HubActivityPage).items.map((i) => i.action);
    };
    expect(await page('tr')).toEqual(expect.arrayContaining(['faturayı yeniden hesapladı', 'eski faturaları yeni tarifeye geçirdi', 'eski faturaları yeni ayara geçirdi']));
    expect(await page('en')).toEqual(expect.arrayContaining(['recalculated an invoice', 'moved earlier invoices to the new tariff', 'moved earlier invoices to the new settings']));
  });

  it('kayıt ölçümle aynı işlemde yazılır: istek başına ek bağlantı ve ek işlem yok', async () => {
    const real = await getApp();
    const admin = await registerCompany(real, 'Toplu Kuyruk');
    const worker = await createWorker(real, admin.auth);
    const orig = pg.Client.prototype.query;
    const statements: string[] = [];
    pg.Client.prototype.query = function (this: unknown, ...args: unknown[]) {
      const q = args[0] as { text?: string } | string;
      statements.push(typeof q === 'string' ? q : (q.text ?? ''));
      return orig.apply(this, args);
    };
    try {
      const p = measurementPayload();
      const res = await real.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...worker.auth, ...p.headers }, payload: p.payload });
      expect(res.statusCode, res.body).toBe(201);
    } finally {
      pg.Client.prototype.query = orig;
    }
    const insertMeasurement = statements.findIndex((s) => /INSERT INTO "deciship"\."Measurement"/.test(s));
    const insertAudit = statements.findIndex((s) => /INSERT INTO "deciship"\."AuditLog"/.test(s));
    expect(insertMeasurement).toBeGreaterThan(-1);
    expect(insertAudit).toBeGreaterThan(insertMeasurement);
    const between = statements.slice(insertMeasurement, insertAudit);
    expect(between.filter((s) => /^\s*(BEGIN|COMMIT|ROLLBACK)/.test(s))).toEqual([]);
  });
});

describe('Genel Bakış: en çok kaçıran, kurulum adımları, tek karar sayısı', () => {
  type Leader = { id: string; label: string; name: string; value: { value: number; format: string; currency?: string }; share?: number; href?: string };
  type Step = { id: string; label: string; done: boolean; href: string; required: boolean };
  const leadersOf = (o: HubOverview) => (o as unknown as { leaders?: Leader[] }).leaders ?? [];
  const stepsOf = (o: HubOverview) => (o as unknown as { setup?: { steps?: Step[] } }).setup?.steps ?? [];
  const asRole = async (a: Actor, perms: readonly string[]) =>
    (await app.inject({ method: 'GET', url: '/api/platform/overview?from=2026-10-01&to=2026-10-31', headers: authHeader(a, perms as never) })).json() as HubOverview;

  async function fourCarriers() {
    const m = await createCompany('Liderler');
    const ids = [];
    for (const [code, name, amount] of [['fedex', 'FedEx', 400], ['ups', 'UPS', 300], ['dhl', 'DHL', 200], ['aras', 'Aras', 100]] as const) {
      const c = await insertCarrier(m.companyId, code, name);
      ids.push(c.id);
      await insertInvoice(m, { carrierId: c.id, invoiceNo: `T-${code}`, date: '2026-10-10', lines: [{ status: 'DIFF', net: amount + 100, expected: 100, diff: amount, diffTypes: [code === 'fedex' ? 'PRICE' : code === 'ups' ? 'WEIGHT' : code === 'dhl' ? 'DIMENSION' : 'SURCHARGE'] }] });
    }
    // başka para birimi lider tutarına karışmaz
    await insertInvoice(m, { carrierId: ids[3]!, invoiceNo: 'U-1', date: '2026-10-11', currency: 'USD', lines: [{ status: 'DIFF', net: 99999, expected: 1, diff: 99998, diffTypes: ['DUPLICATE'] }] });
    return m;
  }

  it('ilk 3 taşıyıcı ve ilk 3 fark türü; tutar baş para biriminde, Pano ile aynı; derin bağlantılı', async () => {
    const m = await fourCarriers();
    const [o, p, an] = await Promise.all([overview(m), pano(m), analytics(m)]);
    const leaders = leadersOf(o);
    const carriers = leaders.filter((l) => l.id.startsWith('carrier:'));
    const types = leaders.filter((l) => l.id.startsWith('type:'));
    expect(carriers.map((l) => [l.name, l.value.value])).toEqual([['FedEx', 400], ['UPS', 300], ['DHL', 200]]);
    expect(types.map((l) => l.value.value)).toEqual([400, 300, 200]);
    expect(leaders.every((l) => l.value.format === 'money' && l.value.currency === 'TRY')).toBe(true);
    const tryPano = p.byCurrency.find((c) => c.currency === 'TRY')!;
    expect(types.map((l) => [l.id.slice(5), l.value.value])).toEqual(tryPano.topDiffTypes.slice(0, 3).map((t) => [t.type, t.amount]));
    expect(carriers.map((l) => l.value.value)).toEqual(widget<'breakdown'>(an, 'by-carrier')!.items.slice(0, 3).map((i) => i.value));
    expect(carriers[0]!.share).toBe(40);
    expect(carriers[0]!.href).toContain('filter.carrier=');
    expect(carriers[0]!.href).toContain('filter.status=DIFF');
    expect(carriers[0]!.href).toContain('filter.currency=TRY');
    expect(types[0]!.href).toContain('filter.diff=PRICE');
    expect(types[0]!.label).not.toBe(carriers[0]!.label);
    const en = await get<HubOverview>(m, '/platform/overview?from=2026-10-01&to=2026-10-31', 'en');
    expect(leadersOf(en).find((l) => l.id === 'type:PRICE')!.name).not.toBe(types[0]!.name);
  });

  it('fiyat izni yoksa dönmez; fark yoksa alan yok', async () => {
    const m = await fourCarriers();
    const noPrices = await asRole(m, ROLE.NO_PRICES);
    expect((noPrices as unknown as { leaders?: unknown }).leaders).toBeUndefined();
    const empty = await createCompany('Farksız');
    expect((await overview(empty) as unknown as { leaders?: unknown }).leaders).toBeUndefined();
  });

  it('kurulum adımları gerçek veriden; ayar izni yoksa setup yok', async () => {
    const m = await createCompany('Kurulum');
    const ids = ['carriers', 'tariffs', 'measure-rules', 'first-measurement', 'first-invoice', 'box-presets'];
    let steps = stepsOf(await overview(m));
    expect(steps.map((s) => s.id)).toEqual(ids);
    expect(steps.map((s) => s.done)).toEqual([false, false, false, false, false, false]);
    expect(steps.map((s) => s.required)).toEqual([true, true, true, true, true, false]);
    expect(steps.find((s) => s.id === 'first-invoice')!.href).toBe('/deciship/invoices/upload');
    expect(steps.find((s) => s.id === 'first-measurement')!.href).toBe('/deciship/measurements');
    for (const s of steps) {
      expect(s.label.length).toBeGreaterThan(2);
      expect(s.href.startsWith('/deciship/')).toBe(true);
    }
    const carrier = await insertCarrier(m.companyId, 'fedex', 'FedEx');
    await prisma.tariff.create({ data: { companyId: m.companyId, carrierId: carrier.id, name: 'T', currency: 'TRY', divisor: 3000, edgeRounding: 'CEIL_CM', weightSteps: [], discountPct: 0, fuelPct: 0, active: true, isDefault: true } as never });
    await insertInvoice(m, { carrierId: carrier.id, invoiceNo: 'S-1', date: '2026-10-10', isSample: true, lines: [{ status: 'MATCH', net: 1, expected: 1, diff: 0 }] });
    steps = stepsOf(await overview(m));
    expect(steps.map((s) => s.done)).toEqual([true, true, false, false, false, false]);
    await insertInvoice(m, { carrierId: carrier.id, invoiceNo: 'R-1', date: '2026-10-10', lines: [{ status: 'MATCH', net: 1, expected: 1, diff: 0 }] });
    await prisma.boxPreset.create({ data: { companyId: m.companyId, name: 'K1', lengthCm: 1, widthCm: 1, heightCm: 1, sortOrder: 1, active: true } as never });
    const patched = await app.inject({ method: 'PATCH', url: '/api/settings', headers: authHeader(m, ROLE.ADMIN), payload: { requiredBoxPhotos: 2 } });
    expect(patched.statusCode, patched.body).toBe(200);
    steps = stepsOf(await overview(m));
    expect(steps.map((s) => s.done)).toEqual([true, true, true, false, true, true]);
    expect((await overview(m)).setup!.completed).toBe(false);
    const member = await prisma.member.findFirstOrThrow({ where: { companyId: m.companyId } });
    await prisma.measurement.create({ data: { companyId: m.companyId, clientId: 'ilk', trackingRaw: 'ILK1', trackingNo: 'ILK1', lengthCm: 1, widthCm: 1, heightCm: 1, weightKg: 1, dimMethod: 'MANUAL', weightMethod: 'MANUAL', measuredById: member.id, measuredAt: new Date() } });
    steps = stepsOf(await overview(m));
    expect(steps.map((s) => s.done)).toEqual([true, true, true, true, true, true]);
    expect((await overview(m)).setup!.completed).toBe(true);
    expect((await asRole(m, ROLE.ACCOUNTING)).setup).toBeUndefined();
  });

  it('karar bekleyen tek tanım: KPI, para birimi kuyruklarının toplamı; kuyruk başlığı para birimini söyler; süresi yaklaşan üçüncü KPI', async () => {
    const m = await createCompany('Tek Tanım');
    const c = await insertCarrier(m.companyId, 'fedex', 'FedEx');
    const open = (n: number) => Array.from({ length: n }, () => ({ status: 'DIFF' as const, net: 10, expected: 5, diff: 5, diffTypes: ['PRICE'] }));
    await insertInvoice(m, { carrierId: c.id, invoiceNo: 'T', date: '2026-10-10', lines: open(3) });
    await insertInvoice(m, { carrierId: c.id, invoiceNo: 'U', date: '2026-10-11', currency: 'USD', lines: open(1) });
    const o = await overview(m);
    expect(kpi(o, 'open')?.value).toBe(4);
    const queues = o.alerts.filter((a) => a.id.startsWith('open:'));
    expect(queues.map((a) => a.id).sort()).toEqual(['open:TRY', 'open:USD']);
    expect(queues.find((a) => a.id === 'open:TRY')!.title).toContain('3');
    expect(queues.find((a) => a.id === 'open:TRY')!.title).toContain('TRY');
    expect(queues.find((a) => a.id === 'open:USD')!.title).toContain('USD');
    expect(o.kpis[2]!.id).toBe('deadlines');

    const single = await createCompany('Tek Para');
    const sc = await insertCarrier(single.companyId, 'fedex', 'FedEx');
    await insertInvoice(single, { carrierId: sc.id, invoiceNo: 'T', date: '2026-10-10', lines: open(2) });
    const so = await overview(single);
    expect(so.alerts.find((a) => a.id === 'open:TRY')!.title).not.toContain('TRY');
    expect(so.kpis[2]!.id).toBe('deadlines');
  });
});

describe('Veri seti sütunları', () => {
  type Col = { id: string; format: string; currency?: string; hiddenByDefault?: boolean; currencyCell?: string };
  type Page = { columns: Col[]; rows: { id: string; cells: Record<string, string | number | null> }[] };

  it('fatura seti öncelik sırasında; Uyumlu ve Tarife yok varsayılan gizli', async () => {
    const m = await createCompany('Sütun');
    const c = await insertCarrier(m.companyId, 'fedex', 'FedEx');
    await insertInvoice(m, { carrierId: c.id, invoiceNo: 'T', date: '2026-10-10', lines: [{ status: 'DIFF', net: 10, expected: 5, diff: 5, diffTypes: ['PRICE'] }] });
    const page = await get<Page>(m, '/platform/datasets/invoices');
    expect(page.columns.map((x) => x.id).slice(0, 6)).toEqual(['no', 'carrier', 'date', 'overcharge', 'billed', 'diff']);
    expect(page.columns.filter((x) => x.hiddenByDefault).map((x) => x.id).sort()).toEqual(['match', 'noTariff']);
    expect(page.columns.find((x) => x.id === 'overcharge')).toMatchObject({ format: 'money', currency: 'TRY' });
    const noPrices = (await app.inject({ method: 'GET', url: '/api/platform/datasets/invoices', headers: authHeader(m, ROLE.NO_PRICES) })).json() as Page;
    expect(noPrices.columns.map((x) => x.id).slice(0, 4)).toEqual(['no', 'carrier', 'date', 'diff']);
    const lines = await get<Page>(m, '/platform/datasets/invoice-lines');
    expect(lines.columns.map((x) => x.id).slice(0, 6)).toEqual(['tracking', 'carrier', 'invoice', 'diffAmount', 'net', 'expected']);
    expect(lines.rows[0]!.cells.diffAmount).toBe(5);
  });

  it('çok para birimi: tutar sütunu satırın para birimini gösterir, sıralamada önce para birimi', async () => {
    const m = await createCompany('Sıralama');
    const c = await insertCarrier(m.companyId, 'fedex', 'FedEx');
    const line = (diff: number) => [{ status: 'DIFF' as const, net: diff + 1, expected: 1, diff, diffTypes: ['PRICE'] }];
    await insertInvoice(m, { carrierId: c.id, invoiceNo: 'T-big', date: '2026-10-10', lines: line(500) });
    await insertInvoice(m, { carrierId: c.id, invoiceNo: 'U-mid', date: '2026-10-11', currency: 'USD', lines: line(300) });
    await insertInvoice(m, { carrierId: c.id, invoiceNo: 'T-small', date: '2026-10-12', lines: line(100) });
    const inv = await get<Page>(m, '/platform/datasets/invoices?sort=overcharge&dir=desc');
    expect(inv.columns.map((x) => x.id).slice(0, 5)).toEqual(['no', 'carrier', 'date', 'currency', 'overcharge']);
    expect(inv.columns.find((x) => x.id === 'overcharge')).toMatchObject({ currencyCell: 'currency' });
    expect(inv.columns.find((x) => x.id === 'overcharge')!.currency).toBeUndefined();
    expect(inv.rows.map((r) => r.cells.no)).toEqual(['T-big', 'T-small', 'U-mid']);
    const lines = await get<Page>(m, '/platform/datasets/invoice-lines?sort=diffAmount&dir=desc');
    expect(lines.rows.map((r) => [r.cells.currency, r.cells.diffAmount])).toEqual([['TRY', 500], ['TRY', 100], ['USD', 300]]);
    const byDate = await get<Page>(m, '/platform/datasets/invoices?sort=date&dir=desc');
    expect(byDate.rows.map((r) => r.cells.no)).toEqual(['T-small', 'U-mid', 'T-big']);
  });
});

describe('Merkez alanları: son gün, parça açıklaması, süzgeç varsayılanı', () => {
  it('itiraz süresi uyarısı dueAt taşır, gövde kalan günü tekrar etmez', async () => {
    const m = await createCompany('Son Gün');
    const c = await insertCarrier(m.companyId, 'aras', 'Aras');
    const today = zonedDate(new Date(), 'Europe/Istanbul');
    await insertInvoice(m, { carrierId: c.id, invoiceNo: 'D-1', date: today, lines: [{ status: 'DIFF', net: 10, expected: 5, diff: 5, diffTypes: ['PRICE'] }] });
    const range = `from=${today}&to=${today}`;
    for (const lang of ['tr', 'en']) {
      const o = await get<HubOverview>(m, `/platform/overview?${range}`, lang);
      const alert = o.alerts.find((a) => a.id.startsWith('deadline:'))!;
      expect(alert.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
      expect(alert.dueAt! >= today).toBe(true);
      expect(alert.body).not.toMatch(/gün kaldı|days? left|\bbugün\b|\btoday\b/i);
      expect(alert.body!.length).toBeGreaterThan(5);
    }
  });

  it('dağılım parçaları açıklama taşır; dile göre', async () => {
    const m = await createCompany('Parça');
    const c = await insertCarrier(m.companyId, 'fedex', 'FedEx');
    await insertInvoice(m, { carrierId: c.id, invoiceNo: 'T', date: '2026-10-10', lines: [{ status: 'DIFF', net: 10, expected: 5, diff: 5, diffTypes: ['PRICE'] }, { status: 'MATCH', net: 5, expected: 5, diff: 0 }, { status: 'UNMATCHED', net: 3 }, { status: 'NO_TARIFF', net: 2 }] });
    const tr = (await overview(m)).split!;
    const en = (await get<HubOverview>(m, '/platform/overview?from=2026-10-01&to=2026-10-31', 'en')).split!;
    for (const part of tr.parts) expect(part.note, part.key).toBeTruthy();
    expect(en.parts.find((p) => p.key === 'diff')!.note).not.toBe(tr.parts.find((p) => p.key === 'diff')!.note);
  });

  it('para birimi süzgeci varsayılanı: seçim yokken uygulanan para birimi', async () => {
    const m = await createCompany('Varsayılan');
    const c = await insertCarrier(m.companyId, 'fedex', 'FedEx');
    const line = [{ status: 'DIFF' as const, net: 10, expected: 5, diff: 5, diffTypes: ['PRICE'] }];
    await insertInvoice(m, { carrierId: c.id, invoiceNo: 'T', date: '2026-10-10', lines: line });
    await insertInvoice(m, { carrierId: c.id, invoiceNo: 'U', date: '2026-10-11', currency: 'USD', lines: line });
    const an = await analytics(m);
    const f = an.filters.find((x) => x.id === 'currency') as { default?: string } | undefined;
    expect(f?.default).toBe('TRY');
  });
});

describe('Bekleyenler: tutar bir kez, iş tarifi, tek terim', () => {
  const todayIso = () => zonedDate(new Date(), 'Europe/Istanbul');
  const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const open = (diff: number) => ({ status: 'DIFF' as const, net: diff + 100, expected: 100, diff, diffTypes: ['PRICE'] });

  it('aynı tutar iki maddede sayılmaz: süresi yaklaşan fatura kendi tutarını taşır, kuyruk kalanı', async () => {
    const m = await createCompany('Tek Tutar');
    const c = await insertCarrier(m.companyId, 'aras', 'Aras');
    const today = todayIso();
    await insertInvoice(m, { carrierId: c.id, invoiceNo: 'YENI', date: today, lines: [open(1461.33)] });
    const range = `from=${shift(today, -60)}&to=${today}`;
    const only = await get<HubOverview>(m, `/platform/overview?${range}`);
    expect(only.alerts.find((a) => a.id.startsWith('deadline:'))!.amount).toMatchObject({ value: 1461.33 });
    const queue = only.alerts.find((a) => a.id.startsWith('open:'))!;
    expect(queue.title).toContain('1');
    expect(queue.amount).toBeUndefined();

    await insertInvoice(m, { carrierId: c.id, invoiceNo: 'ESKI', date: shift(today, -40), lines: [open(200)] });
    const both = await get<HubOverview>(m, `/platform/overview?${range}`);
    const q2 = both.alerts.find((a) => a.id.startsWith('open:'))!;
    expect(q2.amount).toMatchObject({ value: 200 });
    const sum = both.alerts.reduce((n, a) => n + (a.id.startsWith('deadline:') || a.id.startsWith('open:') ? (a.amount?.value as number) ?? 0 : 0), 0);
    expect(Number(sum.toFixed(2))).toBe(1661.33);
    expect(kpi(both, 'overcharge')?.value).toBe(1661.33);
  });

  it('eşleşmeyen satır: tek terim, ne yapılacağını söyler, satırlara bağlanır', async () => {
    const m = await createCompany('Eşleşmedi');
    const c = await insertCarrier(m.companyId, 'aras', 'Aras');
    await insertInvoice(m, { carrierId: c.id, invoiceNo: 'T', date: '2026-10-10', lines: Array.from({ length: 17 }, () => ({ status: 'UNMATCHED' as const, net: 5 })) });
    const o = await overview(m);
    const a = o.alerts.find((x) => x.id.startsWith('unmatched:'))!;
    expect(a.title).toBe('17 fatura satırı eşleşmedi');
    expect(a.body).toMatch(/mobil uygulamada/);
    expect(a.body).toMatch(/Ölçümler/);
    expect(a.href).toContain('filter.status=UNMATCHED');
    expect(o.split!.parts.find((p) => p.key === 'unmatched')!.label).toBe('Eşleşmedi');
    const page = await get<{ columns: { id: string; label: string }[]; rows: { cells: Record<string, unknown> }[] }>(m, '/platform/datasets/invoice-lines');
    expect(page.rows[0]!.cells.status).toBe('Eşleşmedi');
    const inv = await get<{ columns: { id: string; label: string }[] }>(m, '/platform/datasets/invoices');
    expect(inv.columns.find((x) => x.id === 'unmatched')!.label).toBe('Eşleşmedi');
    const en = await get<HubOverview>(m, '/platform/overview?from=2026-10-01&to=2026-10-31', 'en');
    expect(en.alerts.find((x) => x.id.startsWith('unmatched:'))!.title).toBe('17 invoice lines are unmatched');
  });

  it('"Fark var" parçası uyumlu sayılanları içermez; bağlantısı aynı satırları açar', async () => {
    const m = await createCompany('Fark Parça');
    const c = await insertCarrier(m.companyId, 'aras', 'Aras');
    await insertInvoice(m, { carrierId: c.id, invoiceNo: 'T', date: '2026-10-10', lines: [open(50), { ...open(30), decision: 'VERIFIED' as const }, { ...open(20), decision: 'ACCEPTED' as const }] });
    const o = await overview(m);
    const diff = o.split!.parts.find((p) => p.key === 'diff')!;
    expect(diff.value).toBe(150 + 130);
    expect(o.split!.parts.find((p) => p.key === 'accepted')!.value).toBe(120);
    const url = new URL(diff.href!, 'http://x');
    const q = url.search + '&pageSize=200';
    const page = await get<{ total: number; rows: { cells: { net?: number } }[] }>(m, `/platform/datasets/invoice-lines${q}`);
    expect(page.total).toBe(2);
    expect(page.rows.reduce((n, r) => n + (r.cells.net ?? 0), 0)).toBe(diff.value);
  });

  it('baş para birimi firmanınki: settings.currency', async () => {
    const m = await createCompany('Raporlama', { currency: 'EUR' });
    const c = await insertCarrier(m.companyId, 'fedex', 'FedEx');
    const line = [open(10)];
    await insertInvoice(m, { carrierId: c.id, invoiceNo: 'E', date: '2026-10-10', currency: 'EUR', lines: line });
    await insertInvoice(m, { carrierId: c.id, invoiceNo: 'T', date: '2026-10-11', currency: 'TRY', lines: [...line, ...line] });
    expect(kpi(await overview(m), 'overcharge')).toMatchObject({ currency: 'EUR' });
  });
});

describe('"İtiraz listesinde": tek terim, tek sayı', () => {
  const line = (diff: number, decision: 'OPEN' | 'VERIFIED' | 'ACCEPTED') => ({ status: 'DIFF' as const, net: diff + 100, expected: 100, diff, diffTypes: ['PRICE'], decision });

  it('Pano, Genel Bakış ve Analiz aynı tutarı verir; para birimi ayrı', async () => {
    const m = await createCompany('Terim');
    const c = await insertCarrier(m.companyId, 'fedex', 'FedEx');
    await insertInvoice(m, { carrierId: c.id, invoiceNo: 'T', date: '2026-10-10', lines: [line(120, 'VERIFIED'), line(80, 'VERIFIED'), line(50, 'OPEN'), line(30, 'ACCEPTED')] });
    await insertInvoice(m, { carrierId: c.id, invoiceNo: 'U', date: '2026-10-11', currency: 'USD', lines: [line(7, 'VERIFIED')] });
    const [p, o, an] = await Promise.all([pano(m), overview(m), analytics(m)]);
    const fromAnalytics = widgets(an).flatMap((w) => (w.kind === 'kpis' ? w.items : [])).find((k) => k.id === 'verified');
    expect(p.verifiedTotal).toBe(200);
    expect(kpi(o, 'verified')).toMatchObject({ value: p.verifiedTotal, currency: p.currency });
    expect(fromAnalytics).toMatchObject({ value: p.verifiedTotal, currency: p.currency });
    expect(p.byCurrency.find((x) => x.currency === 'USD')!.verifiedTotal).toBe(7);
  });

  it('Merkez etiketleri TR ve EN', async () => {
    const m = await createCompany('Terim Etiket');
    const c = await insertCarrier(m.companyId, 'fedex', 'FedEx');
    await insertInvoice(m, { carrierId: c.id, invoiceNo: 'T', date: '2026-10-10', lines: [line(120, 'VERIFIED')] });
    const q = 'from=2026-10-01&to=2026-10-31';
    const tr = await get<HubOverview>(m, `/platform/overview?${q}`);
    const en = await get<HubOverview>(m, `/platform/overview?${q}`, 'en');
    expect(kpi(tr, 'verified')!.label).toBe('İtiraz listesinde');
    expect(kpi(en, 'verified')!.label).toBe('On dispute list');
    expect(kpi(tr, 'verified')!.hint).not.toMatch(/doğrula/i);
    expect(kpi(en, 'verified')!.hint).not.toMatch(/verified/i);
    const page = await get<{ columns: { id: string; label: string }[]; rows: { cells: Record<string, unknown> }[] }>(m, '/platform/datasets/invoice-lines');
    expect(page.rows[0]!.cells.decision).toBe('İtiraz listesinde');
    const inv = await get<{ columns: { id: string; label: string }[] }>(m, '/platform/datasets/invoices', 'en');
    expect(inv.columns.find((x) => x.id === 'verified')!.label).toBe('On dispute list');
    const list = await get<HubDatasetListLike>(m, '/platform/datasets');
    const decision = list.datasets.find((d) => d.id === 'invoice-lines')!.filters.find((f) => f.id === 'decision')!;
    expect(decision.options!.find((x) => x.value === 'VERIFIED')!.label).toBe('İtiraz listesinde');
  });

  it('sözlükte bu anlamda doğrulama sözcüğü kalmadı (TR, EN)', async () => {
    const { translator } = await import('../../src/services/hub/i18n.ts');
    for (const key of ['col.verified', 'decision.VERIFIED', 'kpi.verified', 'kpi.verified.hint', 'kpi.diffs.hint', 'alert.open.body', 'widget.decisionTable.desc', 'activity.invoiceLine.decision.VERIFIED'] as const) {
      expect(translator('tr')(key), key).not.toMatch(/doğrula/i);
      expect(translator('en')(key), key).not.toMatch(/verif/i);
    }
    const { MESSAGES } = await import('../../src/i18n/messages.ts');
    for (const key of ['report.decision.VERIFIED', 'report.sum.verified', 'report.pdf.kpi.verified', 'dispute.noVerifiedLines', 'dispute.noDiffLines'] as const) {
      expect(MESSAGES[key].tr, key).toMatch(/İtiraz listesinde/);
      expect(MESSAGES[key].en, key).toMatch(/dispute list/i);
      expect(MESSAGES[key].tr, key).not.toMatch(/doğrula/i);
      expect(MESSAGES[key].en, key).not.toMatch(/verif/i);
    }
  });
});

describe('Hazır koli adımı: örnekler kendiliğinden tamamlamaz', () => {
  const step = async (m: Actor) => ((await overview(m)) as unknown as { setup: { steps: { id: string; done: boolean; required: boolean }[] } }).setup.steps.find((s) => s.id === 'box-presets')!;
  const status = async (m: Actor) => (await app.inject({ method: 'GET', url: '/api/settings/onboarding', headers: authHeader(m, ROLE.ADMIN) })).json() as { boxPresets: number; boxPresetsReady: boolean };

  it('yeni firma: K1-K3 dokunulmadan tamamlanmamış, isteğe bağlı; özet aynı', async () => {
    const m = await createCompany('Koli Yeni');
    const s = await step(m);
    expect(s).toMatchObject({ done: false, required: false });
    const st = await status(m);
    expect(st.boxPresets).toBeGreaterThan(0);
    expect(st.boxPresetsReady).toBe(false);
  });

  it('yeni koli, değiştirilen örnek, silinen örnek ya da kapatılan örnek tamamlar', async () => {
    const add = await createCompany('Koli Ek');
    await prisma.boxPreset.create({ data: { companyId: add.companyId, name: 'Özel', lengthCm: 70, widthCm: 50, heightCm: 40, sortOrder: 9 } });
    const edited = await createCompany('Koli Değişti');
    await prisma.boxPreset.updateMany({ where: { companyId: edited.companyId, name: 'K1' }, data: { lengthCm: 31 } });
    const removed = await createCompany('Koli Silindi');
    await prisma.boxPreset.deleteMany({ where: { companyId: removed.companyId, name: 'K3' } });
    const off = await createCompany('Koli Kapalı');
    await prisma.boxPreset.updateMany({ where: { companyId: off.companyId, name: 'K2' }, data: { active: false } });
    for (const m of [add, edited, removed, off]) {
      expect((await step(m)).done, m.name).toBe(true);
      expect((await status(m)).boxPresetsReady, m.name).toBe(true);
    }
  });

  it('sihirbazda onay ya da ölçümde kullanım tamamlar; hiç etkin koli yoksa tamamlanmaz', async () => {
    const confirmed = await createCompany('Koli Onay');
    const patch = await app.inject({ method: 'PATCH', url: '/api/settings/onboarding', headers: authHeader(confirmed, ROLE.ADMIN), payload: { done: 'koliler' } });
    expect(patch.statusCode, patch.body).toBe(200);
    expect((await step(confirmed)).done).toBe(true);
    expect((await status(confirmed)).boxPresetsReady).toBe(true);

    const used = await createCompany('Koli Kullanım');
    const preset = await prisma.boxPreset.findFirstOrThrow({ where: { companyId: used.companyId, name: 'K1' } });
    const member = await prisma.member.findFirstOrThrow({ where: { companyId: used.companyId } });
    await prisma.measurement.create({ data: { companyId: used.companyId, clientId: 'kul', trackingRaw: 'KUL1', trackingNo: 'KUL1', lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 1, dimMethod: 'PRESET', weightMethod: 'MANUAL', measuredById: member.id, measuredAt: new Date(), boxPresetId: preset.id } });
    expect((await step(used)).done).toBe(true);

    const none = await createCompany('Koli Yok');
    await prisma.boxPreset.deleteMany({ where: { companyId: none.companyId } });
    await app.inject({ method: 'PATCH', url: '/api/settings/onboarding', headers: authHeader(none, ROLE.ADMIN), payload: { done: 'koliler' } });
    expect((await step(none)).done).toBe(false);
    expect((await status(none)).boxPresetsReady).toBe(false);
  });

  it('kurulum tamam tanımını etkilemez: zorunlu değil', async () => {
    const m = await createCompany('Koli Zorunlu Değil');
    const steps = ((await overview(m)) as unknown as { setup: { steps: { id: string; required: boolean }[] } }).setup.steps;
    expect(steps.filter((s) => s.required).map((s) => s.id)).toEqual(['carriers', 'tariffs', 'measure-rules', 'first-measurement', 'first-invoice']);
  });
});

describe('İtiraz: geri alınan ve itirazda bekleyen her yerde aynı', () => {
  type Col = { id: string; format: string; currency?: string };
  type Page = { columns: Col[]; rows: { id: string; cells: Record<string, string | number | null> }[] };
  type Round = { id: string; version: number; lines: { id: string; claimedAmount: number }[] };
  let a: Actor;
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url: `/api${url}`, headers: authHeader(a, ROLE.ADMIN), payload: payload as object });
  const send = async (invoiceId: string, sentOn: string): Promise<Round> => {
    const r = await post(`/invoices/${invoiceId}/disputes`, { sentOn, channel: 'EMAIL', selectionDigest: await digestOf(app, authHeader(a, ROLE.ADMIN), invoiceId, '/api') });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().dispute.active as Round;
  };
  const recover = async (round: Round, shares: [number, number][], note: string) => {
    const r = await post(`/disputes/${round.id}/results`, { version: round.version, kind: 'RECOVERED', resultOn: '2026-10-20', creditNoteNo: note, lines: shares.map(([i, amount]) => ({ disputeLineId: round.lines[i]!.id, amount })) });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().dispute.active as Round;
  };
  const diff = (net: number, d: number) => ({ status: 'DIFF' as const, net, expected: net - d, diff: d, diffTypes: ['PRICE'], decision: 'VERIFIED' as const });

  beforeAll(async () => {
    a = await createCompany('İtiraz Tutarlılık');
    const c = await insertCarrier(a.companyId, 'ups', 'UPS');
    // Ekim TRY: 30 tam + 50,55'ten 40,55 geri alındı, 20 bekliyor; bir satır listede değil
    const t = await insertInvoice(a, { carrierId: c.id, invoiceNo: 'TD-1', date: '2026-10-12', lines: [diff(100, 30), diff(200, 50.55), diff(80, 20), { status: 'DIFF', net: 40, expected: 30, diff: 10, diffTypes: ['PRICE'] }] });
    const r1 = await send(t.id, '2026-10-14');
    await recover(r1, [[0, 30], [1, 40.55]], 'AD-1');
    // Ekim USD: 15 bekliyor
    const u = await insertInvoice(a, { carrierId: c.id, invoiceNo: 'UD-1', date: '2026-10-13', currency: 'USD', lines: [diff(25, 15)] });
    await send(u.id, '2026-10-15');
    // Eylül TRY: 12,50 geri alındı (önceki dönem), gönderim Ekim'de: ay fatura ayıdır
    const s = await insertInvoice(a, { carrierId: c.id, invoiceNo: 'SD-1', date: '2026-09-25', lines: [diff(50, 12.5)] });
    const r3 = await send(s.id, '2026-10-02');
    await recover(r3, [[0, 12.5]], 'AD-0');
  });

  it('Pano, Genel Bakış ve Analiz: fatura ayına göre, para birimi başına, kuruşu kuruşuna', async () => {
    const p = await pano(a);
    expect([p.currency, p.recoveredTotal, p.disputePendingTotal]).toEqual(['TRY', 70.55, 20]);
    expect(p.byCurrency.map((x) => [x.currency, x.recoveredTotal, x.disputePendingTotal])).toEqual([['TRY', 70.55, 20], ['USD', 0, 15]]);
    const sept = await pano(a, '2026-09');
    expect([sept.recoveredTotal, sept.disputePendingTotal]).toEqual([12.5, 0]);

    const o = await overview(a);
    expect(kpi(o, 'recovered')).toMatchObject({ value: 70.55, format: 'money', currency: 'TRY', previous: 12.5 });
    expect(kpi(o, 'disputePending')).toMatchObject({ value: 20, format: 'money', currency: 'TRY', previous: 0 });
    const kpiOf = (doc: HubAnalytics, id: string) => widgets(doc).flatMap((w) => (w.kind === 'kpis' ? w.items : [])).find((k) => k.id === id);
    const an = await analytics(a);
    expect([kpiOf(an, 'recovered')?.value, kpiOf(an, 'disputePending')?.value]).toEqual([70.55, 20]);
    const usd = await analytics(a, 'from=2026-10-01&to=2026-10-31&filter.currency=USD');
    expect([kpiOf(usd, 'recovered')?.value, kpiOf(usd, 'disputePending')?.value, kpiOf(usd, 'recovered')?.currency]).toEqual([0, 15, 'USD']);
  });

  it('veri setleri aynı tutarları verir; durum ve sonuç sütunları; süzgeç', async () => {
    const inv = await get<Page>(a, '/platform/datasets/invoices?filter.from=2026-10-01&filter.to=2026-10-31&filter.currency=TRY');
    expect(inv.columns.find((x) => x.id === 'recovered')).toMatchObject({ format: 'money', currency: 'TRY' });
    const td = inv.rows.find((r) => r.cells.no === 'TD-1')!;
    expect(td.cells).toMatchObject({ dispute: 'İtiraz gönderildi', sentOn: '2026-10-14', recovered: 70.55 });
    const sumRecovered = inv.rows.reduce((n, r) => n + Math.round(Number(r.cells.recovered) * 100), 0) / 100;
    expect(sumRecovered).toBe(70.55);
    const lines = await get<Page>(a, '/platform/datasets/invoice-lines?filter.from=2026-10-01&filter.to=2026-10-31&filter.currency=TRY');
    const outcomes = lines.rows.map((r) => r.cells.disputeOutcome).sort();
    expect(outcomes).toEqual(['Geri alındı', 'Geri alındı', 'Sonuç bekliyor', null].sort());
    expect(lines.rows.reduce((n, r) => n + Math.round(Number(r.cells.recovered ?? 0) * 100), 0) / 100).toBe(70.55);
    const sent = await get<Page>(a, '/platform/datasets/invoices?filter.dispute=SENT');
    expect(sent.rows.map((r) => r.cells.no).sort()).toEqual(['TD-1', 'UD-1']);
    const closed = await get<Page>(a, '/platform/datasets/invoices?filter.dispute=CLOSED');
    expect(closed.rows.map((r) => r.cells.no)).toEqual(['SD-1']);
    const en = (await app.inject({ method: 'GET', url: '/api/platform/datasets/invoices?filter.dispute=CLOSED', headers: authHeader(a, ROLE.ADMIN, 'en') })).json() as Page;
    expect(en.rows[0]!.cells.dispute).toBe('Closed');
  });

  it('itiraz listesinin toplamı dönemlerin toplamı; para izni olmayana tutar ve sütun yok', async () => {
    const list = await get<{ summary: { byCurrency: { currency: string; recoveredAmount: number; pendingAmount: number }[] } }>(a, '/disputes');
    expect(list.summary.byCurrency.map((x) => [x.currency, x.recoveredAmount, x.pendingAmount])).toEqual([['TRY', 83.05, 20], ['USD', 0, 15]]);
    const o = (await app.inject({ method: 'GET', url: '/api/platform/overview?from=2026-10-01&to=2026-10-31', headers: authHeader(a, ROLE.NO_PRICES) })).json() as HubOverview;
    expect(o.kpis.map((k) => k.id)).not.toContain('recovered');
    expect(o.kpis.map((k) => k.id)).not.toContain('disputePending');
    const ds = (await app.inject({ method: 'GET', url: '/api/platform/datasets/invoices', headers: authHeader(a, ROLE.NO_PRICES) })).json() as Page;
    expect(ds.columns.map((x) => x.id)).toContain('dispute');
    expect(ds.columns.map((x) => x.id)).not.toContain('recovered');
    expect(ds.rows.every((r) => !('recovered' in r.cells))).toBe(true);
  });
});
