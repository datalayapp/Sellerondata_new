/**
 * Firma para biriminin tek kaynağı Merkez'dir: `org.updated` ile gelir, DeciShip yazmaz.
 * Yeni kayıtların varsayılanı olur; var olan fatura değişmez.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PlatformEvent } from '@sellerondata/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma, withCompany } from '../src/db.ts';
import { defaultAmountTol, readSettings } from '../src/lib/settings.ts';
import { FxService, setFxService, tcmbUrl, type FxFetcher } from '../src/services/fx.ts';
import { setupFacts } from '../src/services/onboarding.ts';
import { companyFixture, tariffPayload } from './fixtures.ts';
import { getApp, inCompany, multipart, registerCompany, SAMPLES, sendEvent, uniq } from './helpers.ts';

const API = '/api/deciship';
let app: FastifyInstance;
// Dövizli fatura kur ister: gerçek TCMB'ye gidilmez, 1 USD = 40,05 TRY (orta kur) sahte kurla verilir.
const fxFetcher: FxFetcher = async (url) =>
  url === tcmbUrl('2026-10-16')
    ? { status: 200, text: '<Tarih_Date Tarih="16.10.2026"><Currency CurrencyCode="USD"><Unit>1</Unit><ForexBuying>40</ForexBuying><ForexSelling>40.1</ForexSelling></Currency></Tarih_Date>' }
    : { status: 404, text: '' };
beforeAll(async () => {
  app = await getApp();
  setFxService(new FxService({ fetcher: fxFetcher, cacheDir: null, now: () => new Date('2026-11-04T12:00:00Z') }));
});
afterAll(() => setFxService(null));

const orgUpdated = (orgId: string, name: string, version: number | undefined, currency?: unknown) =>
  ({ eventId: crypto.randomUUID(), type: 'org.updated', orgId, product: 'deciship', name, ...(version === undefined ? {} : { version }), ...(currency === undefined ? {} : { currency }) }) as PlatformEvent;
const settingsOf = (companyId: string) => withCompany(companyId, async () => readSettings((await prisma.company.findFirstOrThrow({ where: { id: companyId } })).settings));

describe('org.updated para birimi', () => {
  it('JIT ile açılmış firma olay gelince düzelir; iç alan tutulmaz', async () => {
    const a = await registerCompany(app, uniq('JIT '));
    expect((await settingsOf(a.companyId)).currency).toBe('TRY');
    const r = await sendEvent(app, orgUpdated(a.companyId, 'JIT Firma', 3, 'USD'));
    expect(r.statusCode, r.body).toBe(200);
    expect((await settingsOf(a.companyId)).currency).toBe('USD');
    const seen = (await app.inject({ method: 'GET', url: `${API}/settings`, headers: a.auth })).json();
    expect(seen.currency).toBe('USD');
    const patched = (await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: a.auth, payload: { amountTol: 6 } })).json();
    expect(patched.currency).toBe('USD');
    expect(await settingsOf(a.companyId)).not.toHaveProperty('orgCurrency');
  });

  it('olayla açılan firma para birimiyle açılır', async () => {
    const id = crypto.randomUUID();
    await sendEvent(app, orgUpdated(id, 'Olayla', 1, 'USD'));
    expect((await settingsOf(id)).currency).toBe('USD');
  });

  it('eski olay yeniyi ezmez, sırası bozuk ve paralel gelse de son sürüm kalır', async () => {
    const a = await registerCompany(app, uniq('Sıra '));
    await sendEvent(app, orgUpdated(a.companyId, 'Ad', 10, 'USD'));
    const late = await sendEvent(app, orgUpdated(a.companyId, 'Ad', 5, 'TRY'));
    expect(late.json()).toEqual({ ok: true, outcome: 'stale' });
    expect((await settingsOf(a.companyId)).currency).toBe('USD');
    // sürümsüz olay sıralanamaz: sürümlü değeri ezmez
    await sendEvent(app, orgUpdated(a.companyId, 'Ad', undefined, 'TRY'));
    expect((await settingsOf(a.companyId)).currency).toBe('USD');
    await Promise.all([
      [30, 'USD'],
      [35, 'USD'],
      [40, 'TRY'],
      [32, 'USD'],
    ].map(([v, c]) => sendEvent(app, orgUpdated(a.companyId, 'Ad', v as number, c))));
    expect((await settingsOf(a.companyId)).currency).toBe('TRY');
  });

  it('alan yoksa ya da geçersizse dokunmaz; diğer ayarlar korunur', async () => {
    const a = await registerCompany(app, uniq('Alan '));
    await sendEvent(app, orgUpdated(a.companyId, 'Ad', 1, 'USD'));
    await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: a.auth, payload: { amountTol: 7 } });
    await sendEvent(app, orgUpdated(a.companyId, 'Yeni Ad', 2));
    expect(await settingsOf(a.companyId)).toMatchObject({ currency: 'USD', amountTol: 7 });
    // Yalnız TRY, USD, EUR ve GBP (ülkeye göre): başka para birimi ve bozuk değer yok sayılır, ad güncellenir.
    for (const bad of ['usdollar', 12, '', 'U1D', 'JPY', 'gbp', 'usd', ' TRY']) {
      const r = await sendEvent(app, orgUpdated(a.companyId, 'Yeni Ad', 3, bad));
      expect(r.statusCode, String(bad)).toBeLessThan(500);
      expect((await settingsOf(a.companyId)).currency, String(bad)).toBe('USD');
    }
    await sendEvent(app, orgUpdated(a.companyId, 'Yeni Ad', 4, 'TRY'));
    expect(await settingsOf(a.companyId)).toMatchObject({ currency: 'TRY', amountTol: 7 });
  });

  it('DeciShip firma para birimini yazmaz: istek reddedilir, değer değişmez, olay günceller', async () => {
    const a = await registerCompany(app, uniq('Tek Kaynak '));
    await sendEvent(app, orgUpdated(a.companyId, 'Ad', 1, 'USD'));
    const r = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: a.auth, payload: { currency: 'TRY' } });
    expect(r.statusCode, r.body).toBe(400);
    expect((await settingsOf(a.companyId)).currency).toBe('USD');
    // Aynı değeri taşıyan ad olayı da, para birimini değiştiren olay da uygulanır: başka kaynak yok.
    await sendEvent(app, orgUpdated(a.companyId, 'Yeni Ad', 2, 'USD'));
    expect((await settingsOf(a.companyId)).currency).toBe('USD');
    await sendEvent(app, orgUpdated(a.companyId, 'Yeni Ad', 3, 'TRY'));
    expect((await settingsOf(a.companyId)).currency).toBe('TRY');
  });

  it('var olan fatura değişmez; yeni fatura yeni varsayılanı alır; baş rakam kuralı', async () => {
    const f = await companyFixture(app);
    const before = await inCompany(f.companyId, () => prisma.invoice.findFirstOrThrow({ where: { id: f.invoiceId } }));
    expect(before.currency).toBe('TRY');
    const overview = async () => (await app.inject({ method: 'GET', url: `${API}/platform/overview?from=2026-10-01&to=2026-10-31`, headers: f.admin.auth })).json();
    await sendEvent(app, orgUpdated(f.companyId, 'Firma', 5, 'USD'));
    const after = await inCompany(f.companyId, () => prisma.invoice.findFirstOrThrow({ where: { id: f.invoiceId } }));
    expect({ currency: after.currency, totals: after.totals }).toEqual({ currency: before.currency, totals: before.totals });
    // Bu para biriminde fatura yok: baş rakam faturanın kendi para biriminde kalır, tutar çevrilmez.
    expect((await overview()).kpis.find((k: { id: string }) => k.id === 'overcharge').currency).toBe('TRY');

    const form = multipart([{ name: 'carrierId', value: f.carrierId }, { name: 'file', filename: 'f.csv', contentType: 'text/csv', data: Buffer.from(`Takip No;Desi;Tutar\n${uniq('Y')};3;30`) }]);
    const preview = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...f.admin.auth, ...form.headers }, payload: form.payload });
    const inv = await app.inject({ method: 'POST', url: `${API}/invoices`, headers: f.admin.auth, payload: { fileId: preview.json().fileId, carrierId: f.carrierId, invoiceNo: uniq('N'), invoiceDate: '2026-10-16', mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' }, acknowledgeIssues: true } });
    expect(inv.statusCode, inv.body).toBe(201);
    expect(inv.json().invoice.currency).toBe('USD');
    // Şimdi firma para biriminde fatura var: baş rakam o; eskisi ayrı kalır, toplanmaz.
    const kpis = (await overview()).kpis as { id: string; currency?: string }[];
    expect(kpis.find((k) => k.id === 'overcharge')!.currency).toBe('USD');
    expect(kpis.find((k) => k.id === 'overcharge:TRY')).toBeDefined();
  });
});

describe('Mesaj 5 E1 (Y7): varsayılan tutar toleransı firma para birimine göre', () => {
  it('varsayılan: TRY 5; USD, EUR, GBP 0,5; listede olmayan para birimi 5 (bugünkü sayı); kayıtlı değer korunur', () => {
    expect(defaultAmountTol('TRY')).toBe(5);
    expect(['USD', 'EUR', 'GBP', 'usd'].map(defaultAmountTol)).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(defaultAmountTol('CHF')).toBe(5);
    expect(readSettings({}).amountTol).toBe(5);
    expect(readSettings({ currency: 'USD' }).amountTol).toBe(0.5);
    expect(readSettings({ currency: 'EUR', amountTol: 7 }).amountTol).toBe(7);
    expect(readSettings({ currency: 'GBP', amountTol: 0 }).amountTol).toBe(0);
  });

  it('olayla açılan USD firma 0,5 ile açılır', async () => {
    const id = crypto.randomUUID();
    await sendEvent(app, orgUpdated(id, 'Olayla USD', 1, 'USD'));
    expect(await settingsOf(id)).toMatchObject({ currency: 'USD', amountTol: 0.5 });
  });

  it('para birimi değişince varsayılandaki tolerans yenisine geçer; geri dönünce de', async () => {
    const a = await registerCompany(app, uniq('Tol '));
    expect(await settingsOf(a.companyId)).toMatchObject({ currency: 'TRY', amountTol: 5 });
    await sendEvent(app, orgUpdated(a.companyId, 'Ad', 1, 'USD'));
    expect(await settingsOf(a.companyId)).toMatchObject({ currency: 'USD', amountTol: 0.5 });
    await sendEvent(app, orgUpdated(a.companyId, 'Ad', 2, 'EUR'));
    expect(await settingsOf(a.companyId)).toMatchObject({ currency: 'EUR', amountTol: 0.5 });
    await sendEvent(app, orgUpdated(a.companyId, 'Ad', 3, 'TRY'));
    expect(await settingsOf(a.companyId)).toMatchObject({ currency: 'TRY', amountTol: 5 });
    // aynı para birimi yeniden gelince dokunulmaz
    await sendEvent(app, orgUpdated(a.companyId, 'Ad', 4, 'TRY'));
    expect(await settingsOf(a.companyId)).toMatchObject({ currency: 'TRY', amountTol: 5 });
  });

  it('kullanıcının elle değiştirdiği toleransa dokunulmaz', async () => {
    const a = await registerCompany(app, uniq('Elle '));
    const r = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: a.auth, payload: { amountTol: 2 } });
    expect(r.statusCode, r.body).toBe(200);
    await sendEvent(app, orgUpdated(a.companyId, 'Ad', 1, 'USD'));
    expect(await settingsOf(a.companyId)).toMatchObject({ currency: 'USD', amountTol: 2 });
    await sendEvent(app, orgUpdated(a.companyId, 'Ad', 2, 'TRY'));
    expect(await settingsOf(a.companyId)).toMatchObject({ currency: 'TRY', amountTol: 2 });
  });

  it('eski fatura sessizce değişmez: hesap ayarı ve toplamlar aynı, fatura "Ayar değişti" der', async () => {
    const f = await companyFixture(app);
    const read = () => inCompany(f.companyId, () => prisma.invoice.findFirstOrThrow({ where: { id: f.invoiceId } }));
    const before = await read();
    expect(before.compareSettings).toMatchObject({ amountTol: 5, companyCurrency: 'TRY' });
    await sendEvent(app, orgUpdated(f.companyId, 'Firma', 7, 'USD'));
    expect(await settingsOf(f.companyId)).toMatchObject({ currency: 'USD', amountTol: 0.5 });
    const after = await read();
    expect({ compareSettings: after.compareSettings, totals: after.totals, updatedAt: after.updatedAt }).toEqual({
      compareSettings: before.compareSettings,
      totals: before.totals,
      updatedAt: before.updatedAt,
    });
    const detail = await app.inject({ method: 'GET', url: `${API}/invoices/${f.invoiceId}`, headers: f.admin.auth });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().invoice.basis.state).toBe('RULES_CHANGED');
  });
});

describe('kurulum: hazır koli kullanım sorgusu', () => {
  afterEach(() => vi.restoreAllMocks());
  const usageQueries = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([arg]) => JSON.stringify(arg).includes('boxPresetId')).length;

  it('onaylı ya da değişmiş kolide ölçüm taranmaz; dokunulmamışta bakılır', async () => {
    const a = await registerCompany(app, uniq('Sorgu '));
    const spy = vi.spyOn(prisma.measurement, 'count');
    const settings = await settingsOf(a.companyId);
    await withCompany(a.companyId, () => setupFacts(a.companyId, settings));
    expect(usageQueries(spy)).toBe(1);

    spy.mockClear();
    await withCompany(a.companyId, () => setupFacts(a.companyId, { ...settings, onboarding: { done: ['koliler'] } }));
    expect(usageQueries(spy)).toBe(0);

    spy.mockClear();
    await inCompany(a.companyId, () => prisma.boxPreset.create({ data: { companyId: a.companyId, name: 'Özel', lengthCm: 70, widthCm: 50, heightCm: 40, sortOrder: 9 } }));
    await withCompany(a.companyId, () => setupFacts(a.companyId, settings));
    expect(usageQueries(spy)).toBe(0);
  });
});

describe('içe aktarma: indirim onayı ve önerisi', () => {
  const CSV = (header: string, rows: string[]) => Buffer.from([header, ...rows].join('\n'));
  async function draftFor(f: Awaited<ReturnType<typeof companyFixture>>, data: Buffer, newTariff = true, filename = 't.csv') {
    const contentType = filename.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv';
    const parts = newTariff
      ? [{ name: 'carrierId', value: f.carrierId }, { name: 'name', value: uniq('Yeni ') }, { name: 'file', filename, contentType, data }]
      : [{ name: 'file', filename, contentType, data }];
    const form = multipart(parts);
    const url = newTariff ? `${API}/tariff-imports` : `${API}/tariffs/${f.tariffId}/import`;
    const r = await app.inject({ method: 'POST', url, headers: { ...f.admin.auth, ...form.headers }, payload: form.payload });
    expect(r.statusCode, r.body).toBeLessThan(300);
    return r.json() as { draftId: string; checks: { code: string; severity: string }[]; suggestedMeta?: { discountPct?: number }; suggestedDefaults?: unknown };
  }
  const apply = (f: { admin: { auth: { authorization: string } } }, id: string, payload: object) =>
    app.inject({ method: 'POST', url: `${API}/tariff-imports/${id}/apply`, headers: f.admin.auth, payload: { options: {}, ...payload } });

  it('yeni tarife + meta.discountPct: NO_DISCOUNT onay istemez, indirim yazılır', async () => {
    const f = await companyFixture(app);
    // örnek şablon: tek uyarısı indirimin olmaması
    const d = await draftFor(f, fs.readFileSync(path.join(SAMPLES, 'tariff-template-example.xlsx')), true, 'sablon.xlsx');
    expect(d.checks.filter((c) => c.severity === 'warning').map((c) => c.code)).toEqual(['NO_DISCOUNT']);
    const r = await apply(f, d.draftId, { meta: { discountPct: 12, name: uniq('T ') } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().tariff.discountPct).toBe(12);
  });

  it('meta yoksa yeni tarifede de onay ister', async () => {
    const f = await companyFixture(app);
    const d = await draftFor(f, CSV('Ağırlık;TR', ['1;10', '2;20']));
    const r = await apply(f, d.draftId, { meta: { name: uniq('T ') } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.details.warnings).toContain('NO_DISCOUNT');
  });

  it('kalan uyarı yine onay ister; yalnız NO_DISCOUNT süzülür', async () => {
    const f = await companyFixture(app);
    const d = await draftFor(f, CSV('Ağırlık;TR', ['1;10', '2;20', '3;900']));
    const others = d.checks.filter((c) => c.severity === 'warning' && c.code !== 'NO_DISCOUNT').map((c) => c.code);
    expect(others.length).toBeGreaterThan(0);
    const r = await apply(f, d.draftId, { meta: { discountPct: 12, name: uniq('T ') } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.details.warnings).toEqual(others);
  });

  it('var olan tarifede meta.discountPct NO_DISCOUNT uyarısını süzmez', async () => {
    const f = await companyFixture(app);
    const d = await draftFor(f, CSV('Ağırlık;TR', ['1;10', '2;20']), false);
    const r = await apply(f, d.draftId, { meta: { discountPct: 12 } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.details.warnings).toContain('NO_DISCOUNT');
  });

  it('tablo dosyasında indirim sütunu varsa suggestedMeta.discountPct döner; yoksa dönmez', async () => {
    const f = await companyFixture(app);
    const withColumn = await draftFor(f, CSV('Ağırlık;TR;İndirim %', ['1;10;38', '2;20;']));
    expect(withColumn.suggestedMeta?.discountPct).toBe(38);
    const without = await draftFor(f, CSV('Ağırlık;TR', ['1;10', '2;20']));
    expect(without.suggestedMeta?.discountPct).toBeUndefined();
    const zero = await draftFor(f, CSV('Ağırlık;TR;İndirim %', ['1;10;0']));
    expect(zero.suggestedMeta?.discountPct).toBe(0);
    expect(tariffPayload(f.carrierId).discountPct).toBe(0);
  });
});
