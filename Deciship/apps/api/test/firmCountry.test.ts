/**
 * Türk Ticaret Kanunu süresi yalnız ülkesi Türkiye olan firmada görünür. Ülkenin tek kaynağı Merkez'dir: `org.updated` ile gelir.
 * Olay gerçek uçtan geçer, Merkez uçları gerçek Postgres üzerinde okunur.
 */
import crypto from 'node:crypto';
import type { HubDatasetList, HubDatasetPage, HubOverview, PlatformEvent } from '@sellerondata/contracts';
import { turkeyDate } from '@deciship/core';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, withCompany } from '../src/db.ts';
import { readSettings } from '../src/lib/settings.ts';
import { compareSettingsOf } from '../src/services/compare.ts';
import { isoShift } from '../src/services/hub/period.ts';
import { getApp, issueIdentity, registerCompany, sendEvent, uniq, writeTimeZone } from './helpers.ts';
import { insertCarrier, insertInvoice } from './hub/harness.ts';

const API = '/api/deciship';
let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

const orgUpdated = (orgId: string, version: number | undefined, fields: { currency?: unknown; country?: unknown; timeZone?: unknown; name?: string } = {}) =>
  ({ eventId: crypto.randomUUID(), type: 'org.updated', orgId, product: 'deciship', name: 'Firma', ...(version === undefined ? {} : { version }), ...fields }) as PlatformEvent;

type Firm = Awaited<ReturnType<typeof registerCompany>>;
const storedCountry = (companyId: string) =>
  withCompany(companyId, async () => ((await prisma.company.findFirstOrThrow({ where: { id: companyId } })).settings as { country?: string }).country);
const shownCountry = async (a: { auth: Record<string, string> }) => {
  const me = (await app.inject({ method: 'GET', url: `${API}/me`, headers: a.auth })).json();
  const settings = (await app.inject({ method: 'GET', url: `${API}/settings`, headers: a.auth })).json();
  expect(me.company.settings.country).toEqual(settings.country);
  return settings.country as string | null;
};

describe('org.updated ülke', () => {
  it('olay ülkeyi yazar, /me ve /settings çözülmüş değeri verir; fatura gören görür, ölçüm rolüne gitmez', async () => {
    const a = await registerCompany(app, uniq('Ülke '));
    const r = await sendEvent(app, orgUpdated(a.companyId, 1, { currency: 'USD', country: 'US' }));
    expect(r.statusCode, r.body).toBe(200);
    expect(await storedCountry(a.companyId)).toBe('US');
    expect(await shownCountry(a)).toBe('US');
    const auditor = await issueIdentity({ companyId: a.companyId, orgName: 'Firma', role: 'AUDITOR', name: 'Denetçi Test' });
    expect((await app.inject({ method: 'GET', url: `${API}/me`, headers: auditor.auth })).json().company.settings.country).toBe('US');
    const worker = await issueIdentity({ companyId: a.companyId, orgName: 'Firma', role: 'MEASURE', name: 'Çalışan Test' });
    expect((await app.inject({ method: 'GET', url: `${API}/me`, headers: worker.auth })).json().company.settings).not.toHaveProperty('country');
  });

  it('olayla açılan firma ülkesiyle açılır', async () => {
    const id = crypto.randomUUID();
    await sendEvent(app, orgUpdated(id, 1, { currency: 'TRY', country: 'TR' }));
    expect(await storedCountry(id)).toBe('TR');
  });

  it('eski olay yeniyi ezmez, sürümsüz olay sürümlü değeri ezmez, paralelde son sürüm kalır', async () => {
    const a = await registerCompany(app, uniq('Sıra '));
    await sendEvent(app, orgUpdated(a.companyId, 10, { country: 'US' }));
    const late = await sendEvent(app, orgUpdated(a.companyId, 5, { country: 'TR' }));
    expect(late.json()).toEqual({ ok: true, outcome: 'stale' });
    expect(await storedCountry(a.companyId)).toBe('US');
    await sendEvent(app, orgUpdated(a.companyId, undefined, { country: 'TR' }));
    expect(await storedCountry(a.companyId)).toBe('US');
    await Promise.all(
      ([[30, 'DE'], [35, 'GB'], [40, 'TR'], [32, 'US']] as const).map(([version, country]) => sendEvent(app, orgUpdated(a.companyId, version, { country }))),
    );
    expect(await storedCountry(a.companyId)).toBe('TR');
  });

  it('alan yoksa ya da bozuksa dokunmaz; ad ve para birimi yine işlenir', async () => {
    const a = await registerCompany(app, uniq('Alan '));
    await sendEvent(app, orgUpdated(a.companyId, 1, { currency: 'USD', country: 'US' }));
    await sendEvent(app, orgUpdated(a.companyId, 2, { currency: 'TRY' }));
    expect(await storedCountry(a.companyId)).toBe('US');
    let version = 3;
    for (const bad of ['usa', 'us', 12, '', 'T1', ' TR', null]) {
      const r = await sendEvent(app, orgUpdated(a.companyId, version++, { country: bad }));
      expect(r.statusCode, String(bad)).toBeLessThan(500);
      expect(await storedCountry(a.companyId), String(bad)).toBe('US');
    }
  });

  it('DeciShip ülkeyi yazmaz: istek reddedilir; başka ayar yazımı ülkeyi korur', async () => {
    const a = await registerCompany(app, uniq('Tek Kaynak '));
    await sendEvent(app, orgUpdated(a.companyId, 1, { country: 'US' }));
    const r = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: a.auth, payload: { country: 'TR' } });
    expect(r.statusCode, r.body).toBe(400);
    const patched = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: a.auth, payload: { amountTol: 6 } });
    expect(patched.json().country).toBe('US');
    expect(await storedCountry(a.companyId)).toBe('US');
  });
});

describe('org.updated saat dilimi (Mesaj 15 §4.1)', () => {
  const storedTimeZone = (companyId: string) =>
    withCompany(companyId, async () => ((await prisma.company.findFirstOrThrow({ where: { id: companyId } })).settings as { timeZone?: string }).timeZone);
  const shownTimeZone = async (a: { auth: Record<string, string> }) =>
    (await app.inject({ method: 'GET', url: `${API}/settings`, headers: a.auth })).json().timeZone as string;

  it('olay saat dilimini yazar; ayar yetkilisi /settings ile görür', async () => {
    const a = await registerCompany(app, uniq('Saat '));
    expect(await shownTimeZone(a)).toBe('Europe/Istanbul');
    const r = await sendEvent(app, orgUpdated(a.companyId, 1, { currency: 'USD', country: 'US', timeZone: 'America/New_York' }));
    expect(r.statusCode, r.body).toBe(200);
    expect(await storedTimeZone(a.companyId)).toBe('America/New_York');
    expect(await shownTimeZone(a)).toBe('America/New_York');
  });

  it('olayla açılan firma saat dilimiyle açılır', async () => {
    const id = crypto.randomUUID();
    await sendEvent(app, orgUpdated(id, 1, { currency: 'GBP', country: 'GB', timeZone: 'Europe/London' }));
    expect(await storedTimeZone(id)).toBe('Europe/London');
  });

  it('eski olay yeniyi ezmez, sürümsüz olay sürümlü değeri ezmez, paralelde son sürüm kalır', async () => {
    const a = await registerCompany(app, uniq('Saat Sıra '));
    await sendEvent(app, orgUpdated(a.companyId, 10, { timeZone: 'Asia/Tokyo' }));
    const late = await sendEvent(app, orgUpdated(a.companyId, 5, { timeZone: 'UTC' }));
    expect(late.json()).toEqual({ ok: true, outcome: 'stale' });
    expect(await storedTimeZone(a.companyId)).toBe('Asia/Tokyo');
    await sendEvent(app, orgUpdated(a.companyId, undefined, { timeZone: 'UTC' }));
    expect(await storedTimeZone(a.companyId)).toBe('Asia/Tokyo');
    await Promise.all(
      ([[30, 'Europe/Berlin'], [35, 'Europe/London'], [40, 'America/Chicago'], [32, 'UTC']] as const).map(([version, timeZone]) =>
        sendEvent(app, orgUpdated(a.companyId, version, { timeZone })),
      ),
    );
    expect(await storedTimeZone(a.companyId)).toBe('America/Chicago');
  });

  it('alan yoksa (eski biçim olay, yeniden duyuru) dokunmaz: olayla gelen ve DeciShip\'te yazılmış değer kalır; ad ve ülke yine işlenir', async () => {
    const a = await registerCompany(app, uniq('Saat Alan '));
    await sendEvent(app, orgUpdated(a.companyId, 1, { country: 'TR', timeZone: 'Asia/Dubai' }));
    await sendEvent(app, orgUpdated(a.companyId, 2, { name: 'Yeni Ad', country: 'US' }));
    expect(await storedTimeZone(a.companyId)).toBe('Asia/Dubai');
    expect(await storedCountry(a.companyId)).toBe('US');
    expect((await withCompany(a.companyId, () => prisma.company.findFirstOrThrow({ where: { id: a.companyId } }))).name).toBe('Yeni Ad');

    // Merkez'den önce yazılmış değer (eski DeciShip ayarı; uç artık kabul etmez, Y131): varsayılanı söylemeyen duyuru
    // (alan yok, aynı sürüm) onu ezmez.
    const b = await registerCompany(app, uniq('Saat Yerel '));
    await writeTimeZone(b.companyId, 'Asia/Kolkata');
    await sendEvent(app, orgUpdated(b.companyId, 3, { currency: 'TRY', country: 'TR' }));
    await sendEvent(app, orgUpdated(b.companyId, 3, { currency: 'TRY', country: 'TR' }));
    expect(await storedTimeZone(b.companyId)).toBe('Asia/Kolkata');
  });

  it('listede olmayan ya da bozuk değer yok sayılır; ad, para birimi ve ülke yine işlenir', async () => {
    const a = await registerCompany(app, uniq('Saat Bozuk '));
    await sendEvent(app, orgUpdated(a.companyId, 1, { timeZone: 'Europe/Paris' }));
    let version = 2;
    for (const bad of ['Mars/Olympus', 'Asia/Kolkata', 'europe/paris', '+03:00', '', 12, null, { tz: 'UTC' }]) {
      const r = await sendEvent(app, orgUpdated(a.companyId, version, { timeZone: bad, currency: 'EUR', country: 'FR', name: `Ad ${version}` }));
      expect(r.statusCode, String(bad)).toBe(200);
      expect(await storedTimeZone(a.companyId), String(bad)).toBe('Europe/Paris');
      expect(await storedCountry(a.companyId), String(bad)).toBe('FR');
      version++;
    }
    expect((await withCompany(a.companyId, () => prisma.company.findFirstOrThrow({ where: { id: a.companyId } }))).name).toBe(`Ad ${version - 1}`);
  });

  it('DeciShip saat dilimini yazmaz (Y131): istek reddedilir, değer değişmez; başka ayar yazımı saat dilimini korur', async () => {
    const a = await registerCompany(app, uniq('Saat Tek Kaynak '));
    await sendEvent(app, orgUpdated(a.companyId, 1, { timeZone: 'Europe/Paris' }));
    for (const timeZone of ['UTC', 'Asia/Tokyo', 'Mars/Olympus']) {
      const r = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: a.auth, payload: { timeZone } });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().error.code).toBe('VALIDATION');
    }
    expect(await storedTimeZone(a.companyId)).toBe('Europe/Paris');
    const patched = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: a.auth, payload: { amountTol: 6 } });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().timeZone).toBe('Europe/Paris');
    expect(await storedTimeZone(a.companyId)).toBe('Europe/Paris');
  });

  it('saat dilimi faturanın hesap dayanağına girmez (SPEC §3.14): dayanak ayarı olaydan önceki ve sonraki hâlde aynı', async () => {
    const a = await registerCompany(app, uniq('Saat Dayanak '));
    await sendEvent(app, orgUpdated(a.companyId, 1, { currency: 'TRY', country: 'TR' }));
    const settings = () => withCompany(a.companyId, async () => (await prisma.company.findFirstOrThrow({ where: { id: a.companyId } })).settings);
    const before = compareSettingsOf(readSettings(await settings()));
    await sendEvent(app, orgUpdated(a.companyId, 2, { currency: 'TRY', country: 'TR', timeZone: 'Asia/Tokyo' }));
    expect(await storedTimeZone(a.companyId)).toBe('Asia/Tokyo');
    expect(compareSettingsOf(readSettings(await settings()))).toEqual(before);
  });
});

describe('ülke bilinmiyorsa', () => {
  it('hiç olay gelmemiş (JIT) firma: bilinmiyor, TTK gösterilmez', async () => {
    const a = await registerCompany(app, uniq('JIT '));
    expect(await shownCountry(a)).toBeNull();
  });

  it('eski biçim olay: para birimi TRY ise Türkiye, değilse bilinmiyor; yazılmaz, yalnız okunurken çözülür', async () => {
    const tr = await registerCompany(app, uniq('Eski TR '));
    await sendEvent(app, orgUpdated(tr.companyId, 1, { currency: 'TRY' }));
    expect(await shownCountry(tr)).toBe('TR');
    expect(await storedCountry(tr.companyId)).toBeUndefined();

    const foreign = await registerCompany(app, uniq('Eski USD '));
    await sendEvent(app, orgUpdated(foreign.companyId, 1, { currency: 'USD' }));
    expect(await shownCountry(foreign)).toBeNull();
  });

  it('Merkez ülkeyi söylediyse para birimine bakılmaz', async () => {
    const usdInTurkey = await registerCompany(app, uniq('TR USD '));
    await sendEvent(app, orgUpdated(usdInTurkey.companyId, 1, { currency: 'USD', country: 'TR' }));
    expect(await shownCountry(usdInTurkey)).toBe('TR');
    const tryAbroad = await registerCompany(app, uniq('US TRY '));
    await sendEvent(app, orgUpdated(tryAbroad.companyId, 1, { currency: 'TRY', country: 'US' }));
    expect(await shownCountry(tryAbroad)).toBe('US');
  });

  it('Merkez EUR ve GBP para birimini de yazar; geçersiz kod yok sayılır', async () => {
    for (const code of ['EUR', 'GBP']) {
      const a = await registerCompany(app, uniq(`Para ${code} `));
      await sendEvent(app, orgUpdated(a.companyId, 1, { currency: code, country: code === 'EUR' ? 'DE' : 'GB' }));
      expect((await app.inject({ method: 'GET', url: `${API}/me`, headers: a.auth })).json().company.settings.currency).toBe(code);
    }
    const b = await registerCompany(app, uniq('Para JPY '));
    await sendEvent(app, orgUpdated(b.companyId, 1, { currency: 'JPY' }));
    expect((await app.inject({ method: 'GET', url: `${API}/me`, headers: b.auth })).json().company.settings.currency).not.toBe('JPY');
  });
});

describe('Merkez: Pano, Veriler ve CSV', () => {
  const today = turkeyDate(new Date());
  const period = `from=${isoShift(today, -40)}&to=${today}`;
  const diff = (n: number) => [{ status: 'DIFF' as const, net: n + 10, expected: 10, diff: n, diffTypes: ['PRICE'] }];
  const get = async <T,>(a: Firm, url: string, locale = 'tr') => {
    const r = await app.inject({ method: 'GET', url: `${API}${url}`, headers: { ...a.auth, 'accept-language': locale } });
    expect(r.statusCode, r.body).toBe(200);
    return (url.includes('/export') ? r.body : r.json()) as T;
  };
  const overview = (a: Firm, locale?: string) => get<HubOverview>(a, `/platform/overview?${period}`, locale);
  const dueAlerts = (o: HubOverview) => o.alerts.filter((x) => x.id.startsWith('deadline'));

  async function firmWithInvoices(fields: { currency?: string; country?: string }) {
    const a = await registerCompany(app, uniq('Süre '));
    await sendEvent(app, orgUpdated(a.companyId, 1, fields));
    const ups = (await insertCarrier(a.companyId, 'ups', 'UPS')).id;
    const fedex = (await insertCarrier(a.companyId, 'fedex', 'FedEx')).id;
    const actor = { companyId: a.companyId, userId: a.userId };
    await insertInvoice(actor, { carrierId: ups, invoiceNo: 'UPS-3', date: isoShift(today, -5), lines: diff(200) }); // TTK'ya 3 gün
    await insertInvoice(actor, { carrierId: ups, invoiceNo: 'UPS-GECMIS', date: isoShift(today, -9), lines: diff(300) });
    await insertInvoice(actor, { carrierId: fedex, invoiceNo: 'FEDEX-25', date: isoShift(today, -25), lines: diff(400) }); // FedEx düzeltmeye 5 gün
    return a;
  }

  it('Türkiye: TTK uyarısı, KPI, son gün sütunu ve CSV yerinde', async () => {
    const a = await firmWithInvoices({ currency: 'TRY', country: 'TR' });
    const o = await overview(a);
    expect(o.kpis.find((k) => k.id === 'deadlines')).toMatchObject({ value: 2, label: 'İtiraz süresi yaklaşan fatura' });
    expect(dueAlerts(o).map((x) => x.title)).toEqual(['UPS UPS-3 faturasında 1 fark', 'FedEx FEDEX-25 faturasında 1 fark']);
    expect(dueAlerts(o)[0]!.body).toMatch(/^İtiraz için son gün /);

    const page = await get<HubDatasetPage>(a, '/platform/datasets/invoices');
    expect(page.columns.map((c) => c.id)).toContain('lastDay');
    expect(page.rows.find((r) => r.cells.no === 'UPS-3')!.cells.lastDay).toBe(isoShift(today, 3));
    const csv = await get<string>(a, '/platform/datasets/invoices/export');
    expect(csv).toContain('İtiraz son günü');
    const list = await get<HubDatasetList>(a, '/platform/datasets');
    expect(list.datasets.find((d) => d.id === 'invoices')!.filters.find((f) => f.id === 'deadline')!.label).toBe('İtiraz süresi');
  });

  it('ABD: TTK uyarısı ve sütunu yok, FedEx kendi süresi kalır ve adıyla söylenir', async () => {
    const a = await firmWithInvoices({ currency: 'USD', country: 'US' });
    const o = await overview(a);
    const alerts = dueAlerts(o);
    expect(alerts.map((x) => x.title)).toEqual(['FedEx FEDEX-25 faturasında 1 fark']);
    expect(alerts[0]!.body).toContain('FedEx düzeltme için son gün');
    expect(alerts[0]!.dueAt).toBe(isoShift(today, 5));
    // Yaklaşan süre taşıyıcınındır: "itiraz süresi" denmez.
    expect(o.kpis.find((k) => k.id === 'deadlines')).toMatchObject({ value: 1, label: 'Düzeltme süresi yaklaşan fatura' });

    const page = await get<HubDatasetPage>(a, '/platform/datasets/invoices');
    expect(page.columns.map((c) => c.id)).not.toContain('lastDay');
    expect(page.rows.every((r) => !('lastDay' in r.cells))).toBe(true);
    const csv = await get<string>(a, '/platform/datasets/invoices/export', 'en');
    expect(csv).not.toContain('Last day to dispute');

    const soon = await get<HubDatasetPage>(a, '/platform/datasets/invoices?filter.deadline=soon');
    expect(soon.rows.map((r) => r.cells.no)).toEqual(['FEDEX-25']);
    const list = await get<HubDatasetList>(a, '/platform/datasets', 'en');
    expect(list.datasets.find((d) => d.id === 'invoices')!.filters.find((f) => f.id === 'deadline')!.label).toBe('Correction window');
    expect((await overview(a, 'en')).kpis.find((k) => k.id === 'deadlines')!.label).toBe('Invoices near the correction deadline');
  });

  it('ABD, yaklaşan süre yok: KPI çıkmaz, "0 fatura" denmez', async () => {
    const a = await registerCompany(app, uniq('Yalın '));
    await sendEvent(app, orgUpdated(a.companyId, 1, { currency: 'USD', country: 'US' }));
    const ups = (await insertCarrier(a.companyId, 'ups', 'UPS')).id;
    await insertInvoice({ companyId: a.companyId, userId: a.userId }, { carrierId: ups, invoiceNo: 'UPS-1', date: isoShift(today, -2), lines: diff(50) });
    const o = await overview(a);
    expect(o.kpis.find((k) => k.id === 'deadlines')).toBeUndefined();
    expect(dueAlerts(o)).toEqual([]);
  });

  it('ülke değişince hemen geçerli: ABD → Türkiye → ABD', async () => {
    const a = await firmWithInvoices({ currency: 'USD', country: 'US' });
    expect(dueAlerts(await overview(a)).map((x) => x.title)).toEqual(['FedEx FEDEX-25 faturasında 1 fark']);
    await sendEvent(app, orgUpdated(a.companyId, 2, { currency: 'USD', country: 'TR' }));
    expect(dueAlerts(await overview(a))).toHaveLength(2);
    await sendEvent(app, orgUpdated(a.companyId, 3, { currency: 'USD', country: 'US' }));
    expect(dueAlerts(await overview(a))).toHaveLength(1);
  });

  it('hiç olay gelmemiş firma: TTK çıkmaz', async () => {
    const a = await registerCompany(app, uniq('JIT Süre '));
    const ups = (await insertCarrier(a.companyId, 'ups', 'UPS')).id;
    await insertInvoice({ companyId: a.companyId, userId: a.userId }, { carrierId: ups, invoiceNo: 'UPS-1', date: isoShift(today, -2), lines: diff(50) });
    expect(dueAlerts(await overview(a))).toEqual([]);
  });

  it('eski biçim olaylı Türkiye firması uyarıyı kaybetmez', async () => {
    const a = await firmWithInvoices({ currency: 'TRY' });
    expect(dueAlerts(await overview(a))).toHaveLength(2);
  });

  it('eski biçim olaylı dolar firmasına TTK çıkmaz', async () => {
    const a = await firmWithInvoices({ currency: 'USD' });
    expect(dueAlerts(await overview(a)).map((x) => x.title)).toEqual(['FedEx FEDEX-25 faturasında 1 fark']);
  });
});
