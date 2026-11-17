/** Yetki süzmesi, firma izolasyonu, TR/EN etiket, CSV, boş firma, sayfalama, sorgu sayısı. */
import { createRequire } from 'node:module';
import type { HubActivityPage, HubAnalytics, HubDatasetList, HubDatasetPage, HubOverview } from '@sellerondata/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCompany } from '../../src/db.ts';
import { audit as writeAudit } from '../../src/lib/audit.ts';
import { HUB_KEYS, resolveLocale } from '../../src/services/hub/i18n.ts';
import { prisma, ROLE, authHeader, buildHubApp, createCompany, createMember, insertCarrier, insertInvoice, moneyTraces, walk, type Actor } from './harness.ts';

/** Uygulama kodu: firma bağlamı olmadan RLS yazdırmaz. */
const audit = (companyId: string, ...rest: [string | null, string, string, (string | null)?, unknown?]) => withCompany(companyId, () => writeAudit(companyId, ...rest));

const OCT = 'from=2026-10-01&to=2026-10-31';
const ENDPOINTS = [`/platform/overview?${OCT}`, `/platform/analytics?${OCT}&compare=previous`, '/platform/datasets', '/platform/datasets/invoices', '/platform/datasets/invoice-lines', '/platform/datasets/measurements', '/platform/datasets/tariffs', '/platform/datasets/carriers', '/platform/datasets/audit-log', '/platform/activity'];

let app: FastifyInstance;
let a: Actor & { name: string };
let b: Actor & { name: string };
let carrierA = '';
let carrierB = '';
let workerName = '';
let invoiceA = '';
let lineA = '';
let invoiceB = '';

const req = (actor: Actor, url: string, perms: readonly string[] = ROLE.ADMIN, locale = 'tr') => app.inject({ method: 'GET', url: `/api${url}`, headers: authHeader(actor, perms, locale) });
const json = async <T>(actor: Actor, url: string, perms: readonly string[] = ROLE.ADMIN, locale = 'tr') => {
  const res = await req(actor, url, perms, locale);
  if (res.statusCode !== 200) throw new Error(`${url} -> ${res.statusCode} ${res.body}`);
  return res.json() as T;
};

beforeAll(async () => {
  app = await buildHubApp();
  a = await createCompany('A Şirketi');
  b = await createCompany('B Şirketi');
  carrierA = (await insertCarrier(a.companyId, 'fedex', 'FedEx')).id;
  carrierB = (await insertCarrier(b.companyId, 'ups', 'GizliKargo')).id;
  const inv = await insertInvoice(a, {
    carrierId: carrierA,
    invoiceNo: 'A-100',
    date: '2026-10-15',
    lines: [
      { tracking: 'TRACKA1', status: 'DIFF', net: 1000.5, expected: 700.25, diff: 300.25, diffTypes: ['DIMENSION'], service: 'Economy; "Hızlı"', country: 'DE' },
      { tracking: 'TRACKA2', status: 'DIFF', net: 777.77, expected: 700, diff: 77.77, diffTypes: ['PRICE'], service: 'Economy; "Hızlı"', country: 'FR' },
      { tracking: '=HYPERLINK("x")', status: 'MATCH', net: 500, expected: 500, diff: 0, country: 'DE' },
      { tracking: 'TRACKA4', status: 'UNMATCHED', net: 250 },
    ],
  });
  invoiceA = inv.id;
  lineA = (await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: inv.id, trackingNo: 'TRACKA1' } })).id;
  const worker = await createMember(a.companyId, 'Mehmet Gizliad', 'worker');
  workerName = worker.name;
  await prisma.measurement.create({
    data: { companyId: a.companyId, clientId: `m-a-1-${a.companyId}`, trackingRaw: 'TRACKA1', trackingNo: 'TRACKA1', lengthCm: 40, widthCm: 30, heightCm: 25, weightKg: 4, dimMethod: 'LIDAR', weightMethod: 'OCR', measuredById: worker.id, measuredAt: new Date('2026-10-14T10:00:00Z'), version: 2 },
  });
  await prisma.tariff.create({ data: { companyId: a.companyId, carrierId: carrierA, name: 'FedEx 2026', currency: 'TRY', divisor: 5000, weightSteps: [], discountPct: 38.5, fuelPct: 27.25, isDefault: true } });
  const bInv = await insertInvoice(b, { carrierId: carrierB, invoiceNo: 'GIZLI-999', date: '2026-10-15', lines: [{ tracking: 'GIZLITRACK', status: 'DIFF', net: 5555, expected: 1, diff: 5554, diffTypes: ['PRICE'] }] });
  invoiceB = bInv.id;
  await prisma.measurement.create({
    data: { companyId: b.companyId, clientId: `m-b-1-${b.companyId}`, trackingRaw: 'GIZLIM', trackingNo: 'GIZLIM', lengthCm: 1, widthCm: 1, heightCm: 1, weightKg: 1, dimMethod: 'AR', weightMethod: 'OCR', measuredById: b.userId, measuredAt: new Date('2026-10-14T10:00:00Z') },
  });
  await audit(a.companyId, a.userId, 'invoice.import', 'Invoice', invoiceA, { invoiceNo: 'A-100', lines: 4, secretAmount: 123456.78 });
  await audit(a.companyId, a.userId, 'invoiceLine.decision', 'InvoiceLine', lineA, { decision: 'VERIFIED' });
  await audit(a.companyId, worker.id, 'measurement.correct', 'Measurement', (await prisma.measurement.findFirstOrThrow({ where: { companyId: a.companyId } })).id, { previousId: 'x' });
  await audit(a.companyId, a.userId, 'tariff.update', 'Tariff', (await prisma.tariff.findFirstOrThrow({ where: { companyId: a.companyId } })).id, { name: 'FedEx 2026' });
  await audit(a.companyId, a.userId, 'settings.update', 'Company', a.companyId, { amountTol: 5 });
  await audit(a.companyId, a.userId, 'login', 'User', a.userId, { client: 'web' });
  await audit(b.companyId, b.userId, 'invoice.import', 'Invoice', invoiceB, { invoiceNo: 'GIZLI-999' });
});
afterAll(async () => {
  await app.close();
});

describe('yetki', () => {
  it('Ölçüm rolü (MEASURE) hiçbir uca giremez: 403', async () => {
    for (const url of [...ENDPOINTS, '/platform/datasets/invoices/export']) {
      const res = await req(a, url, ROLE.MEASURE);
      expect(res.statusCode, url).toBe(403);
      expect(res.body).not.toContain('A-100');
    }
  });

  it('kimliksiz istek 401', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/platform/overview?${OCT}` });
    expect(res.statusCode).toBe(401);
  });

  it('Muhasebe (ACCOUNTING) para, çalışan adı ve dışa aktarma görür; ayar kaydı ve kurulum görmez', async () => {
    const o = await json<HubOverview>(a, `/platform/overview?${OCT}`, ROLE.ACCOUNTING);
    expect(o.kpis[0]).toMatchObject({ id: 'overcharge', value: 378.02, currency: 'TRY' });
    expect(o.split).toBeDefined();
    expect(o.setup).toBeUndefined();
    const an = await json<HubAnalytics>(a, `/platform/analytics?${OCT}`, ROLE.ACCOUNTING);
    const ops = an.sections.flatMap((s) => s.widgets).find((w) => w.id === 'operators');
    expect(JSON.stringify(ops)).toContain(workerName);
    const list = await json<HubDatasetList>(a, '/platform/datasets', ROLE.ACCOUNTING);
    expect(list.datasets.map((d) => d.id)).toEqual(['invoices', 'invoice-lines', 'measurements', 'tariffs', 'carriers', 'box-presets', 'audit-log']);
    expect(list.datasets.every((d) => d.exportable)).toBe(true);
    expect((await req(a, '/platform/datasets/invoices/export', ROLE.ACCOUNTING)).statusCode).toBe(200);
    const feed = await json<HubActivityPage>(a, '/platform/activity', ROLE.ACCOUNTING);
    expect(feed.items.map((i) => i.action)).not.toContain('ayarları değiştirdi');
    expect(feed.items.map((i) => i.action)).toContain('fatura yükledi');
  });

  it('para izni yoksa hiçbir uçta para alanı, para KPI ya da para sıralaması yok', async () => {
    for (const url of ENDPOINTS) {
      const body = await json<unknown>(a, url, ROLE.NO_PRICES);
      expect(moneyTraces(body), url).toEqual([]);
      const text = JSON.stringify(body);
      for (const money of ['1000.5', '777.77', '378.02', '2528.27', '300.25', '38.5', '27.25']) expect(text, `${url} ${money}`).not.toContain(money);
    }
    const o = await json<HubOverview>(a, `/platform/overview?${OCT}`, ROLE.NO_PRICES);
    expect(o.kpis[0]).toMatchObject({ id: 'diffs', value: 2, format: 'number' });
    expect(o.split).toBeUndefined();
    for (const alert of o.alerts) expect(alert.amount).toBeUndefined();
    expect(o.kpis.find((k) => k.id === 'overcharge' || k.id === 'verified' || k.id === 'estimated')).toBeUndefined();

    const page = await json<HubDatasetPage>(a, '/platform/datasets/invoice-lines', ROLE.NO_PRICES);
    expect(page.columns.map((c) => c.id)).not.toEqual(expect.arrayContaining(['net']));
    expect(page.columns.find((c) => ['net', 'expected', 'diffAmount', 'confidence', 'currency'].includes(c.id))).toBeUndefined();
    // Tutara göre sıralama isteği yok sayılır: sıra tutarı ele vermez.
    const asc = await json<HubDatasetPage>(a, '/platform/datasets/invoice-lines?sort=net&dir=asc', ROLE.NO_PRICES);
    const desc = await json<HubDatasetPage>(a, '/platform/datasets/invoice-lines?sort=net&dir=desc', ROLE.NO_PRICES);
    expect(asc.rows.map((r) => r.id)).toEqual(desc.rows.map((r) => r.id));
    // Sütun ve hücre birlikte süzülür.
    for (const r of page.rows) for (const k of ['net', 'diffAmount', 'expected']) expect(r.cells[k]).toBeUndefined();

    const inv = await json<HubDatasetPage>(a, '/platform/datasets/invoices?sort=overcharge&dir=asc', ROLE.NO_PRICES);
    expect(moneyTraces(inv)).toEqual([]);
    const tar = await json<HubDatasetPage>(a, '/platform/datasets/tariffs', ROLE.NO_PRICES);
    expect(tar.columns.find((c) => c.id === 'discount' || c.id === 'fuel')).toBeUndefined();
    const csv = (await req(a, '/platform/datasets/invoice-lines/export', ROLE.NO_PRICES)).body;
    expect(csv).toContain('TRACKA1');
    expect(csv).not.toContain('1000,5');
    expect(csv).not.toContain('300,25');
    expect(csv.split('\r\n')[0]).not.toContain('Faturalanan;');
  });

  it('measurements.view_all yoksa çalışan adı, ölçüm veri seti ve ölçüm etkinliği yok; toplam sayı kalır', async () => {
    const an = await json<HubAnalytics>(a, `/platform/analytics?${OCT}`, ROLE.NO_PEOPLE);
    const text = JSON.stringify(an);
    expect(text).not.toContain(workerName);
    expect(an.sections.flatMap((s) => s.widgets).find((w) => w.id === 'operators')).toBeUndefined();
    expect(an.sections.flatMap((s) => s.widgets).find((w) => w.id === 'methods')).toBeDefined();
    const o = await json<HubOverview>(a, `/platform/overview?${OCT}`, ROLE.NO_PEOPLE);
    expect(o.kpis.find((k) => k.id === 'measured')).toMatchObject({ value: 1 });
    expect(o.kpis.find((k) => k.id === 'measured')!.href).toBeUndefined();
    expect(o.alerts.find((x) => x.id === 'no-photo')).toBeUndefined();
    expect((await req(a, '/platform/datasets/measurements', ROLE.NO_PEOPLE)).statusCode).toBe(403);
    expect((await req(a, '/platform/datasets/measurements/export', ROLE.NO_PEOPLE)).statusCode).toBe(403);
    const list = await json<HubDatasetList>(a, '/platform/datasets', ROLE.NO_PEOPLE);
    expect(list.datasets.map((d) => d.id)).not.toContain('measurements');
    const feed = await json<HubActivityPage>(a, '/platform/activity', ROLE.NO_PEOPLE);
    expect(JSON.stringify(feed)).not.toContain(workerName);
  });

  it('data.export yoksa dışa aktarma 403, veri seti açık ama exportable false', async () => {
    const perms = ROLE.ACCOUNTING.filter((p) => p !== 'deciship.data.export');
    expect((await req(a, '/platform/datasets/invoices/export', perms)).statusCode).toBe(403);
    const list = await json<HubDatasetList>(a, '/platform/datasets', perms);
    expect(list.datasets.every((d) => !d.exportable)).toBe(true);
  });

  it('invoices.view yoksa veri setleri 403; dışa aktarma izni tek başına yetmez', async () => {
    const perms = ROLE.ACCOUNTING.filter((p) => p !== 'deciship.invoices.view');
    expect((await req(a, '/platform/datasets', perms)).statusCode).toBe(403);
    expect((await req(a, '/platform/datasets/invoices/export', perms)).statusCode).toBe(403);
    const o = await json<HubOverview>(a, `/platform/overview?${OCT}`, perms);
    walk(o, (k, v) => {
      if (k === 'href') expect(String(v)).not.toMatch(/^\/data\/deciship\/invoice/);
    });
  });

  it('reports.view yoksa Genel Bakış, Analiz ve Etkinlik 403', async () => {
    const perms = ROLE.ACCOUNTING.filter((p) => p !== 'deciship.reports.view');
    for (const url of [`/platform/overview?${OCT}`, `/platform/analytics?${OCT}`, '/platform/activity', '/platform/datasets/audit-log']) expect((await req(a, url, perms)).statusCode, url).toBe(403);
    expect((await req(a, '/platform/datasets/invoices', perms)).statusCode).toBe(200);
  });
});

describe('firma izolasyonu', () => {
  it('A firması hiçbir uçta B verisini görmez', async () => {
    for (const url of ENDPOINTS) {
      const text = JSON.stringify(await json<unknown>(a, url));
      for (const secret of ['GIZLI', 'GizliKargo', invoiceB, carrierB, ':5554', ':5555']) expect(text, `${url} ${secret}`).not.toContain(secret);
    }
    const csv = (await req(a, '/platform/datasets/invoice-lines/export')).body;
    expect(csv).not.toContain('GIZLI');
  });

  it('B taşıyıcısıyla süzmek A firmasına veri açmaz', async () => {
    const lines = await json<HubDatasetPage>(a, `/platform/datasets/invoice-lines?filter.carrier=${carrierB}`);
    expect(lines.total).toBe(0);
    const inv = await json<HubDatasetPage>(a, `/platform/datasets/invoices?filter.carrier=${carrierB}`);
    expect(inv.total).toBe(0);
    const an = await json<HubAnalytics>(a, `/platform/analytics?${OCT}&filter.carrier=${carrierB}`);
    expect(JSON.stringify(an)).not.toContain('5554');
  });

  it('B kullanıcısı süzgeçle A ölçümlerini göremez, ad çözülmez', async () => {
    const m = await json<HubDatasetPage>(a, `/platform/datasets/measurements?filter.user=${b.userId}`);
    expect(m.total).toBe(0);
    const bLines = await json<HubDatasetPage>(b, '/platform/datasets/invoice-lines');
    expect(bLines.total).toBe(1);
    expect(JSON.stringify(bLines)).not.toContain('TRACKA');
    const feed = await json<HubActivityPage>(b, '/platform/activity');
    expect(feed.total).toBe(1);
    expect(feed.items[0]!.target).toContain('GIZLI-999');
  });
});

describe('TR/EN etiketler', () => {
  it('sözlük anahtarları iki dilde aynı', () => {
    expect(HUB_KEYS.en).toEqual(HUB_KEYS.tr);
  });

  it('Accept-Language q değerine ve bölgeye göre çözülür', () => {
    expect(resolveLocale('en-US,en;q=0.9,tr;q=0.8')).toBe('en');
    expect(resolveLocale('tr-TR,tr;q=0.9,en;q=0.8')).toBe('tr');
    expect(resolveLocale('de-DE,en;q=0.5')).toBe('en');
    expect(resolveLocale('en;q=0.2,tr;q=0.9')).toBe('tr');
    // Kullanıcı kararı 2026-11-12: desteklenen dil de oturum dili de yoksa İngilizce (eskiden Türkçe).
    expect(resolveLocale('de')).toBe('en');
    expect(resolveLocale('de', 'tr')).toBe('tr');
    expect(resolveLocale(undefined, 'en')).toBe('en');
    expect(resolveLocale(undefined, 'tr')).toBe('tr');
    expect(resolveLocale('')).toBe('en');
  });

  it('etiketler dile göre, marka ve taşıyıcı adı çevrilmez, değerler aynı', async () => {
    const tr = await json<HubOverview>(a, `/platform/overview?${OCT}`, ROLE.ADMIN, 'tr-TR');
    const en = await json<HubOverview>(a, `/platform/overview?${OCT}`, ROLE.ADMIN, 'en-US,en;q=0.9');
    expect(tr.kpis[0]!.label).toBe('Yakalanan fazla ödeme');
    expect(en.kpis[0]!.label).toBe('Overcharges caught');
    expect(en.kpis.map((k) => k.value)).toEqual(tr.kpis.map((k) => k.value));
    expect(en.split!.title).toBe('Where the billed amount went');
    expect(en.split!.parts.map((p) => p.value)).toEqual(tr.split!.parts.map((p) => p.value));

    const anEn = await json<HubAnalytics>(a, `/platform/analytics?${OCT}`, ROLE.ADMIN, 'en');
    const anTr = await json<HubAnalytics>(a, `/platform/analytics?${OCT}`, ROLE.ADMIN, 'tr');
    expect(anEn.sections[0]!.title).toBe('Overcharges');
    expect(anTr.sections[0]!.title).toBe('Fazla ödeme');
    const carriersEn = anEn.sections.flatMap((s) => s.widgets).find((w) => w.id === 'by-carrier');
    expect(JSON.stringify(carriersEn)).toContain('FedEx');
    const typesEn = anEn.sections.flatMap((s) => s.widgets).find((w) => w.id === 'diff-types') as { items: { key: string; label: string }[] };
    expect(typesEn.items.find((i) => i.key === 'DIMENSION')!.label).toBe('Dimension discrepancy');
    const typesTr = anTr.sections.flatMap((s) => s.widgets).find((w) => w.id === 'diff-types') as { items: { key: string; label: string }[] };
    expect(typesTr.items.find((i) => i.key === 'DIMENSION')!.label).toBe('Ölçü farkı');

    const dsEn = await json<HubDatasetList>(a, '/platform/datasets', ROLE.ADMIN, 'en');
    expect(dsEn.datasets[0]).toMatchObject({ id: 'invoices', label: 'Invoices' });
    const pageEn = await json<HubDatasetPage>(a, '/platform/datasets/invoice-lines?filter.status=DIFF', ROLE.ADMIN, 'en');
    expect(pageEn.rows[0]!.cells.status).toBe('Discrepancy');
    expect(pageEn.columns.find((c) => c.id === 'tracking')!.label).toBe('Tracking no');

    const feedEn = await json<HubActivityPage>(a, '/platform/activity', ROLE.ADMIN, 'en');
    expect(feedEn.items.map((i) => i.action)).toContain('uploaded an invoice');
    expect(feedEn.items.map((i) => i.action)).toContain('added a discrepancy to the dispute list');
  });

  it('İngilizce çoğul, Türkçe tekil', async () => {
    const en = await json<HubOverview>(a, `/platform/overview?${OCT}`, ROLE.ADMIN, 'en');
    expect(en.alerts.find((x) => x.id === 'open:TRY')!.title).toBe('2 discrepancies need a decision');
    expect(en.alerts.find((x) => x.id === 'unmatched:TRY')!.title).toBe('1 invoice line is unmatched');
  });

  it('hata iletileri dile göre', async () => {
    const tr = await req(a, '/platform/overview?from=bozuk');
    const en = await req(a, '/platform/overview?from=bozuk', ROLE.ADMIN, 'en');
    expect(tr.statusCode).toBe(400);
    expect(tr.json().error.message).toContain('YYYY-AA-GG');
    expect(en.json().error.message).toContain('YYYY-MM-DD');
    expect((await req(a, '/platform/datasets/yok', ROLE.ADMIN, 'en')).json().error.message).toBe('Dataset not found');
    expect((await req(a, '/platform/datasets/yok')).statusCode).toBe(404);
  });
});

describe('tarih aralığı', () => {
  it('geçersiz ve fazla uzun aralık 400; Şubat 30 kabul edilmez', async () => {
    expect((await req(a, '/platform/overview?from=2026-02-30&to=2026-03-01')).statusCode).toBe(400);
    expect((await req(a, '/platform/overview?from=2026-10-10&to=2026-10-01')).statusCode).toBe(400);
    expect((await req(a, '/platform/overview?from=2020-01-01&to=2026-01-01')).statusCode).toBe(400);
    expect((await req(a, '/platform/analytics?from=2020-01-01&to=2026-01-01')).statusCode).toBe(400);
    expect((await req(a, '/platform/datasets/invoices?filter.from=dun')).statusCode).toBe(400);
    expect((await req(a, '/platform/datasets/invoice-lines?filter.status=YOK')).statusCode).toBe(400);
    for (const id of ['invoices', 'invoice-lines', 'measurements', 'tariffs', 'carriers', 'box-presets', 'audit-log']) {
      for (const sort of ['1;DROP TABLE x', 'constructor', '__proto__', 'toString']) {
        const res = await req(a, `/platform/datasets/${id}?sort=${encodeURIComponent(sort)}&filter.__proto__=x`);
        expect(res.statusCode, `${id} ${sort}`).toBe(200);
      }
    }
    expect((await req(a, "/platform/analytics?from=2026-10-01&to=2026-10-31&filter.currency=x'y")).statusCode).toBe(400);
  });

  it('verilmezse son 30 gün', async () => {
    const o = await json<HubOverview>(a, '/platform/overview');
    const days = Math.round((Date.parse(o.to) - Date.parse(o.from)) / 86_400_000) + 1;
    expect(days).toBe(30);
  });

  it('uzun aralıkta aynı sayıda nokta, toplam değişmez', async () => {
    const o = await json<HubOverview>(a, '/platform/overview?from=2026-01-01&to=2026-12-31');
    const cur = o.kpis[0]!.trend!.find((s) => s.role === 'current')!;
    const prev = o.kpis[0]!.trend!.find((s) => s.role === 'previous')!;
    expect(cur.points.length).toBe(prev.points.length);
    expect(cur.points.length).toBeLessThanOrEqual(13);
    expect(o.kpis[0]!.value).toBe(378.02);
  });
});

describe('veri setleri', () => {
  it('arama, sıralama, süzme, sayfalama, üst sınır', async () => {
    const search = await json<HubDatasetPage>(a, '/platform/datasets/invoice-lines?q=tracka1');
    expect(search.total).toBe(1);
    expect(search.rows[0]!.cells.tracking).toBe('TRACKA1');
    expect(search.rows[0]!.href).toBe(`/deciship/invoices/${invoiceA}?tab=DIFF&line=${lineA}`);

    const asc = await json<HubDatasetPage>(a, '/platform/datasets/invoice-lines?sort=net&dir=asc');
    expect(asc.rows.map((r) => r.cells.net)).toEqual([250, 500, 777.77, 1000.5]);
    const desc = await json<HubDatasetPage>(a, '/platform/datasets/invoice-lines?sort=net&dir=desc');
    expect(desc.rows.map((r) => r.cells.net)).toEqual([1000.5, 777.77, 500, 250]);

    const p1 = await json<HubDatasetPage>(a, '/platform/datasets/invoice-lines?pageSize=3&page=1&sort=net&dir=asc');
    const p2 = await json<HubDatasetPage>(a, '/platform/datasets/invoice-lines?pageSize=3&page=2&sort=net&dir=asc');
    expect(p1).toMatchObject({ total: 4, page: 1, pageSize: 3 });
    expect(p1.rows).toHaveLength(3);
    expect(p2.rows).toHaveLength(1);
    const capped = await json<HubDatasetPage>(a, '/platform/datasets/invoice-lines?pageSize=100000');
    expect(capped.pageSize).toBe(200);
    const beyond = await json<HubDatasetPage>(a, '/platform/datasets/invoice-lines?page=99');
    expect(beyond.rows).toEqual([]);
    expect(beyond.total).toBe(4);

    const byCountry = await json<HubDatasetPage>(a, '/platform/datasets/invoice-lines?filter.country=de');
    expect(byCountry.total).toBe(2);
    const byType = await json<HubDatasetPage>(a, '/platform/datasets/invoice-lines?filter.diff=PRICE');
    expect(byType.total).toBe(1);
    const inRange = await json<HubDatasetPage>(a, '/platform/datasets/invoices?filter.from=2026-10-15&filter.to=2026-10-15');
    expect(inRange.total).toBe(1);
    const outRange = await json<HubDatasetPage>(a, '/platform/datasets/invoices?filter.from=2026-10-16');
    expect(outRange.total).toBe(0);
  });

  it('her satırda derin bağlantı; yollar ARCHITECTURE §3', async () => {
    const hrefs: Record<string, RegExp> = {
      invoices: /^\/deciship\/invoices\/[^/]+\?tab=ALL$/,
      'invoice-lines': /^\/deciship\/invoices\/[^/]+\?tab=[A-Z_]+&line=/,
      measurements: /^\/deciship\/measurements\?id=/,
      tariffs: /^\/deciship\/tariffs\/[^/]+$/,
      carriers: /^\/deciship\/tariffs\?carrier=/,
      'box-presets': /^\/deciship\/settings$/,
    };
    for (const [id, re] of Object.entries(hrefs)) {
      const page = await json<HubDatasetPage>(a, `/platform/datasets/${id}`);
      expect(page.rows.length, id).toBeGreaterThan(0);
      for (const r of page.rows) expect(r.href, id).toMatch(re);
      // Her hücre tanımlı bir sütuna ait.
      const cols = new Set(page.columns.map((c) => c.id));
      for (const r of page.rows) for (const k of Object.keys(r.cells)) expect(cols.has(k), `${id}.${k}`).toBe(true);
    }
  });

  it('ölçüm satırı: yöntem, çalışan, fotoğraf, süzgeç', async () => {
    const page = await json<HubDatasetPage>(a, '/platform/datasets/measurements?filter.method=LIDAR&filter.photos=none');
    expect(page.total).toBe(1);
    expect(page.rows[0]!.cells).toMatchObject({ tracking: 'TRACKA1', method: 'LiDAR', dims: '40 × 30 × 25', kg: 4, by: workerName, photos: 0, version: 2 });
    expect((await json<HubDatasetPage>(a, '/platform/datasets/measurements?filter.method=AR')).total).toBe(0);
    expect((await json<HubDatasetPage>(a, '/platform/datasets/measurements?filter.photos=some')).total).toBe(0);
    const list = await json<HubDatasetList>(a, '/platform/datasets');
    const def = list.datasets.find((d) => d.id === 'measurements')!;
    const users = def.filters.find((f) => f.id === 'user') as { options: { label: string }[] };
    expect(users.options.map((o) => o.label)).toEqual([workerName]);
  });

  it('taşıyıcı seti fatura sayısını Pano kümesinden verir, örnek ve silinen sayılmaz', async () => {
    const c = await createCompany('Sayım');
    const car = await insertCarrier(c.companyId, 'ups', 'UPS');
    await insertInvoice(c, { carrierId: car.id, invoiceNo: '1', date: '2026-10-01', lines: [{ status: 'MATCH', net: 1, expected: 1, diff: 0 }] });
    await insertInvoice(c, { carrierId: car.id, invoiceNo: '2', date: '2026-10-05', isSample: true, lines: [{ status: 'MATCH', net: 1, expected: 1, diff: 0 }] });
    const del = await insertInvoice(c, { carrierId: car.id, invoiceNo: '3', date: '2026-10-09', lines: [{ status: 'MATCH', net: 1, expected: 1, diff: 0 }] });
    await prisma.invoice.update({ where: { id: del.id }, data: { deletedAt: new Date() } });
    const page = await json<HubDatasetPage>(c, '/platform/datasets/carriers');
    expect(page.rows[0]!.cells).toMatchObject({ name: 'UPS', invoices: 1, lastInvoice: '2026-10-01', tariffs: 0 });
    expect((await json<HubDatasetPage>(c, '/platform/datasets/invoices')).total).toBe(1);
  });
});

describe('CSV', () => {
  it('Türkçe: BOM, noktalı virgül, ondalık virgül, CRLF, tırnak, formül koruması', async () => {
    const res = await req(a, '/platform/datasets/invoice-lines/export?sort=net&dir=desc');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="deciship-invoice-lines-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers['cache-control']).toContain('no-store');
    const body = res.body;
    expect(body.charCodeAt(0)).toBe(0xfeff);
    const lines = body.slice(1).split('\r\n');
    expect(lines.at(-1)).toBe('');
    expect(lines).toHaveLength(6); // başlık + 4 satır + son CRLF
    const header = lines[0]!.split(';');
    expect(header).toContain('Takip no');
    expect(header).toContain('Para birimi');
    expect(header).toContain('Faturalanan');
    const first = lines[1]!;
    expect(first.startsWith('TRACKA1;FedEx;A-100;')).toBe(true);
    expect(first).toContain(';1000,50;');
    expect(first).toContain(';700,25;');
    expect(first).toContain(';300,25;');
    expect(first).toContain(';TRY;');
    // Ayırıcı ve tırnak içeren hizmet adı.
    expect(first).toContain('"Economy; ""Hızlı"""');
    // Faturadan gelen formül metni çalışmaz.
    expect(body).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('İngilizce: virgül ve ondalık nokta', async () => {
    const body = (await req(a, '/platform/datasets/invoice-lines/export?sort=net&dir=desc', ROLE.ADMIN, 'en')).body;
    const lines = body.slice(1).split('\r\n');
    expect(lines[0]!.split(',')).toContain('Tracking no');
    expect(lines[1]).toContain(',1000.50,');
  });

  it('süzgeç ve arama dışa aktarmaya uygulanır; sayfa sınırı uygulanmaz; iz yazılır', async () => {
    const body = (await req(a, '/platform/datasets/invoice-lines/export?filter.status=DIFF&pageSize=1')).body;
    expect(body.slice(1).split('\r\n')).toHaveLength(4);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { companyId: a.companyId, action: 'data.export' }, orderBy: { createdAt: 'desc' } });
    expect(log).toMatchObject({ entity: 'Dataset', entityId: 'invoice-lines', userId: a.userId });
    const feed = await json<HubActivityPage>(a, '/platform/activity');
    expect(feed.items[0]).toMatchObject({ action: 'veri dışa aktardı', target: 'Fatura satırları' });
  });

  it('büyük toplu yanıt: sayfa aşan set eksiksiz', async () => {
    const c = await createCompany('Toplu');
    const car = await insertCarrier(c.companyId, 'ups', 'UPS');
    await insertInvoice(c, { carrierId: car.id, invoiceNo: 'B', date: '2026-10-01', lines: Array.from({ length: 2300 }, (_, i) => ({ status: 'MATCH' as const, net: i + 1, expected: i + 1, diff: 0 })) });
    const body = (await req(c, '/platform/datasets/invoice-lines/export')).body;
    const rows = body.slice(1).split('\r\n').slice(1).filter(Boolean);
    expect(rows).toHaveLength(2300);
    expect(new Set(rows.map((r) => r.split(';')[0])).size).toBe(2300);
  });

  it('her veri seti dışa aktarılır', async () => {
    for (const id of ['invoices', 'invoice-lines', 'measurements', 'tariffs', 'carriers', 'box-presets', 'audit-log']) {
      const res = await req(a, `/platform/datasets/${id}/export`);
      expect(res.statusCode, id).toBe(200);
      expect(res.body.charCodeAt(0), id).toBe(0xfeff);
      expect(res.body).not.toContain('undefined');
      expect(res.body).not.toContain('[object');
    }
  });
});

describe('etkinlik', () => {
  it('kayıtlar okunur cümle; data sızmaz; giriş ve ayar izinsiz görünmez', async () => {
    const feed = await json<HubActivityPage>(a, '/platform/activity');
    const actions = feed.items.map((i) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['fatura yükledi', 'bir farkı itiraz listesine aldı', 'ölçüm düzeltti', 'tarife değiştirdi', 'ayarları değiştirdi']));
    expect(actions.find((x) => x.includes('login'))).toBeUndefined();
    const text = JSON.stringify(feed);
    expect(text).not.toContain('123456.78');
    expect(text).not.toContain('secretAmount');
    const upload = feed.items.find((i) => i.action === 'fatura yükledi')!;
    expect(upload).toMatchObject({ actor: a ? 'Ayşe Yönetici' : '', target: 'FedEx A-100', href: `/deciship/invoices/${invoiceA}?tab=ALL` });
    const decide = feed.items.find((i) => i.action === 'bir farkı itiraz listesine aldı')!;
    expect(decide).toMatchObject({ target: 'TRACKA1', href: `/deciship/invoices/${invoiceA}?tab=DIFF&line=${lineA}` });
    expect(feed.items.find((i) => i.action === 'ölçüm düzeltti')!.actor).toBe(workerName);
    expect(feed.pageSize).toBe(25);
  });

  it('silinen fatura hedefinde bağlantı yok; denetim seti arama ve türe göre süzer', async () => {
    const c = await createCompany('Silme');
    const car = await insertCarrier(c.companyId, 'ups', 'UPS');
    const inv = await insertInvoice(c, { carrierId: car.id, invoiceNo: 'SIL-1', date: '2026-10-01', lines: [{ status: 'MATCH', net: 1, expected: 1, diff: 0 }] });
    await prisma.invoice.update({ where: { id: inv.id }, data: { deletedAt: new Date() } });
    await audit(c.companyId, c.userId, 'invoice.delete', 'Invoice', inv.id);
    await audit(c.companyId, c.userId, 'carrier.create', 'Carrier', car.id, { name: 'UPS' });
    const feed = await json<HubActivityPage>(c, '/platform/activity');
    const del = feed.items.find((i) => i.action === 'fatura sildi')!;
    expect(del.target).toBe('UPS SIL-1');
    expect(del.href).toBeUndefined();
    const page = await json<HubDatasetPage>(c, '/platform/datasets/audit-log?filter.group=carrier');
    expect(page.total).toBe(1);
    expect(page.rows[0]!.cells).toMatchObject({ action: 'taşıyıcı ekledi', target: 'UPS', actor: 'Ayşe Yönetici' });
    expect((await json<HubDatasetPage>(c, '/platform/datasets/audit-log?q=sildi')).total).toBe(1);
    expect((await json<HubDatasetPage>(c, '/platform/datasets/audit-log?q=Ayşe')).total).toBe(2);
    expect((await json<HubDatasetPage>(c, '/platform/datasets/audit-log?q=yokböyle')).total).toBe(0);
  });
});

describe('boş firma', () => {
  let e: Actor;
  beforeAll(async () => {
    e = await createCompany('Boş Firma');
  });

  it('Genel Bakış: baş rakam boş, kurulum yönlendirmesi, uyarı yok, NaN yok', async () => {
    const res = await req(e, `/platform/overview?${OCT}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('NaN');
    expect(res.body).not.toContain('Infinity');
    const o = res.json() as HubOverview;
    expect(o.kpis[0]).toMatchObject({ id: 'overcharge', value: null });
    expect(o.alerts).toEqual([]);
    expect(o.split).toBeUndefined();
    expect(o.setup).toMatchObject({ completed: false, href: '/deciship/setup' });
    expect(o.setup!.label).toContain('Taşıyıcı');
    expect(o.kpis.find((k) => k.id === 'coverage')!.value).toBeNull();
  });

  it('hazır koli seti: ölçüm kaydı görme izni yoksa kullanım sayısı yok', async () => {
    const p = await json<HubDatasetPage>(e, '/platform/datasets/box-presets', ROLE.NO_PEOPLE);
    expect(p.columns.map((c) => c.id)).not.toContain('measurements');
    for (const r of p.rows) expect(r.cells).not.toHaveProperty('measurements');
  });

  it('kurulum yönlendirmesi yalnız ayar izni olana', async () => {
    const o = await json<HubOverview>(e, `/platform/overview?${OCT}`, ROLE.ACCOUNTING);
    expect(o.setup).toBeUndefined();
  });

  it('Analiz: empty widget ve yönlendirme', async () => {
    const res = await req(e, `/platform/analytics?${OCT}&compare=previous`);
    expect(res.body).not.toContain('NaN');
    const an = res.json() as HubAnalytics;
    expect(an.sections).toHaveLength(1);
    expect(an.sections[0]!.widgets[0]).toMatchObject({ kind: 'empty', href: '/deciship/setup' });
    expect(an.compare).toBeDefined();
    const en = await json<HubAnalytics>(e, `/platform/analytics?${OCT}`, ROLE.ADMIN, 'en');
    expect(en.sections[0]!.title).toBe('Nothing to analyze yet');
  });

  it('Veri setleri boş, CSV yalnız başlık, etkinlik boş', async () => {
    const ids = ['invoices', 'invoice-lines', 'measurements', 'tariffs', 'carriers', 'audit-log'];
    for (const id of ids) {
      const page = await json<HubDatasetPage>(e, `/platform/datasets/${id}`);
      expect(page, id).toMatchObject({ total: 0, rows: [] });
      expect(page.columns.length, id).toBeGreaterThan(0);
    }
    expect(await json<HubActivityPage>(e, '/platform/activity?page=3')).toMatchObject({ items: [], total: 0, page: 3 });
    // Dışa aktarma kendi izini yazar: boşluk kontrolünden sonra.
    for (const id of [...ids].reverse()) {
      const csv = (await req(e, `/platform/datasets/${id}/export`)).body;
      expect(csv.slice(1).split('\r\n'), id).toHaveLength(2);
    }
  });

  it('veri olan firmada boş dönem: bölüm boş durumla gelir, sıfıra bölme yok', async () => {
    const res = await req(a, '/platform/analytics?from=2020-01-01&to=2020-01-31&compare=previous');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('NaN');
    const an = res.json() as HubAnalytics;
    const ids = an.sections.flatMap((s) => s.widgets.map((w) => `${w.kind}:${w.id}`));
    expect(ids).toEqual(expect.arrayContaining(['empty:no-lines', 'empty:no-measurements']));
    const o = await json<HubOverview>(a, '/platform/overview?from=2020-01-01&to=2020-01-31');
    expect(o.kpis[0]!.value).toBeNull();
    expect(o.split).toBeUndefined();
  });
});

describe('N+1 yok', () => {
  const pg = createRequire(import.meta.url)('pg') as { Client: { prototype: { query: (...args: unknown[]) => unknown } } };

  async function countQueries(run: () => Promise<unknown>) {
    let n = 0;
    const orig = pg.Client.prototype.query;
    pg.Client.prototype.query = function patched(this: unknown, ...args: unknown[]) {
      // RLS bağlamının denetim ifadeleri (BEGIN, set_config, COMMIT) iş sorgusu değil; veriyle de artmaz.
      const q = args[0] as { text?: string } | string | undefined;
      const text = typeof q === 'string' ? q : (q?.text ?? '');
      if (!/^s*(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/.test(text)) n++;
      return orig.apply(this, args);
    };
    try {
      await run();
    } finally {
      pg.Client.prototype.query = orig;
    }
    return n;
  }

  it('sorgu sayısı fatura, satır ve kayıt sayısıyla artmaz', async () => {
    const c = await createCompany('Hacim');
    const car = await insertCarrier(c.companyId, 'ups', 'UPS');
    const add = async (n: number, prefix: string) => {
      for (let i = 0; i < n; i++) {
        const inv = await insertInvoice(c, { carrierId: car.id, invoiceNo: `${prefix}-${i}`, date: '2026-10-10', lines: Array.from({ length: 20 }, (_, j) => ({ status: 'DIFF' as const, net: 100, expected: 50, diff: 50, diffTypes: ['PRICE'], country: 'DE', tracking: `${prefix}${i}X${j}` })) });
        await audit(c.companyId, c.userId, 'invoice.import', 'Invoice', inv.id, { invoiceNo: inv.invoiceNo });
      }
    };
    const urls = [`/platform/overview?${OCT}`, `/platform/analytics?${OCT}&compare=previous`, '/platform/datasets/invoices', '/platform/datasets/invoice-lines', '/platform/activity', '/platform/datasets/audit-log'];
    await add(2, 'K');
    const before: Record<string, number> = {};
    for (const u of urls) before[u] = await countQueries(() => json(c, u));
    await add(12, 'B');
    for (const u of urls) {
      const after = await countQueries(() => json(c, u));
      expect(after, u).toBe(before[u]);
      expect(after, u).toBeLessThan(45);
    }
  });
});
