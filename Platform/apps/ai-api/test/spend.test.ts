import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AI_SPEND_EXPORT_MAX_ROWS, type HubAnalytics, type HubDatasetPage } from '@sellerondata/contracts';
import { disconnectPrisma, getPrisma } from '../src/db.ts';
import { closeSuper, superClient } from './helpers.ts';
import { auth, createG4Account, lastMonth, makeG4App, resetG4, seedCalls, thisMonth, unzip, ymd, type G4Account } from './g4Helpers.ts';

/**
 * Merkez harcama görünümü (G4): iki firma izolasyonu, platform yöneticisi, tutar yalnız OWNER/ADMIN ve `op`'a, TL/USD, süzgeçler,
 * firmanın saat dilimi, dışa aktarma (CSV/XLSX, 50.000 satır sınırı), aylık hak görünümü.
 */

let account: G4Account;
let app: FastifyInstance;

beforeAll(async () => {
  account = await createG4Account();
  app = await makeG4App(account);
});
afterAll(async () => {
  await app.close();
  await closeSuper();
  await disconnectPrisma();
});
beforeEach(resetG4);

const get = async (url: string, token: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers: { ...auth(token), ...headers } });
const owner = (orgId: string, extra: Parameters<G4Account['access']>[0] = {}) => account.access({ orgId, orgRole: 'OWNER', ...extra });

function kpi(s: HubAnalytics, id: string) {
  return s.sections
    .flatMap((x) => x.widgets)
    .flatMap((w) => (w.kind === 'kpis' ? w.items : []))
    .find((k) => k.id === id);
}
function widget(s: HubAnalytics, id: string) {
  return s.sections.flatMap((x) => x.widgets).find((w) => w.id === id);
}

describe('erişim', () => {
  it('MEMBER, firmasız jeton ve op olmayanın platform görünümü 403; firma görünümünde org süzgeci 400', async () => {
    await seedCalls([{ orgId: 'org-a', startedAt: thisMonth(1) }]);
    const member = await account.access({ orgId: 'org-a', orgRole: 'MEMBER' });
    const noOrg = await account.access({ orgId: null });
    const ownerA = await owner('org-a');
    for (const url of ['/api/ai/spend/summary', '/api/ai/spend/calls', '/api/ai/spend/calls/export', '/api/ai/spend/allowance']) {
      for (const t of [member, noOrg]) {
        const res = await get(url, t);
        expect(res.statusCode, url).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
    }
    for (const url of ['/api/ai/spend/summary?scope=platform', '/api/ai/spend/calls?scope=platform', '/api/ai/spend/calls/export?scope=platform']) {
      expect((await get(url, ownerA)).statusCode, url).toBe(403);
      // op olup firmada MEMBER olan da firma görünümüne giremez (kural rol), platforma girer.
      const opMember = await account.access({ orgId: 'org-a', orgRole: 'MEMBER', op: true });
      expect((await get(url, opMember)).statusCode, url).toBe(200);
      expect((await get(url.replace('?scope=platform', ''), opMember)).statusCode, url).toBe(403);
    }
    const res = await get('/api/ai/spend/calls?org=org-b', ownerA);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0]).toMatchObject({ path: 'org' });
    expect((await get('/api/ai/spend/summary', await account.access({ orgId: 'org-a', orgRole: 'ADMIN' }))).statusCode).toBe(200);
  });
});

describe('iki firma izolasyonu', () => {
  it('A firmasının sahibi yalnız A satırlarını görür (liste, özet, dışa aktarma); B de yalnız kendisini', async () => {
    const aIds = await seedCalls([
      { orgId: 'org-a', startedAt: thisMonth(1, 9), costMicroUsd: 10_000 },
      { orgId: 'org-a', startedAt: thisMonth(1, 10), costMicroUsd: 20_000, product: 'tagpress' },
    ]);
    const bIds = await seedCalls([
      { orgId: 'org-b', startedAt: thisMonth(1, 11), costMicroUsd: 999_000, model: 'claude-opus-5-5', product: 'tagpress', purpose: 'tagpress.rank' },
    ]);

    const calls = (await get('/api/ai/spend/calls', await owner('org-a'))).json() as HubDatasetPage;
    expect(calls.total).toBe(2);
    expect(calls.rows.map((r) => r.id).sort()).toEqual([...aIds].sort());
    expect(calls.columns.map((c) => c.id)).not.toContain('org');

    const sum = (await get('/api/ai/spend/summary', await owner('org-a'))).json() as HubAnalytics;
    // 30.000 mikro USD × 100 = 3 TL.
    expect(kpi(sum, 'spend')).toMatchObject({ value: 3, currency: 'TRY', format: 'money' });
    expect(kpi(sum, 'spend_usd')).toBeUndefined();
    expect(kpi(sum, 'calls')?.value).toBe(2);
    const models = widget(sum, 'by_model');
    expect(models?.kind === 'breakdown' && models.items.map((i) => i.key)).not.toContain('claude-opus-5-5');
    expect(JSON.stringify(sum)).not.toContain('org-b');

    const csv = await get('/api/ai/spend/calls/export?format=csv', await owner('org-a'));
    expect(csv.statusCode).toBe(200);
    expect(csv.body).not.toContain('Opus');
    expect(csv.body.trim().split('\r\n')).toHaveLength(3);

    const callsB = (await get('/api/ai/spend/calls', await owner('org-b'))).json() as HubDatasetPage;
    expect(callsB.rows.map((r) => r.id)).toEqual(bIds);
    // Jetondaki firma esastır: sorguda başka firma seçmenin yolu yok.
    expect((await get('/api/ai/spend/summary?scope=org&org=org-a', await owner('org-b'))).statusCode).toBe(400);
  });

  it('platform yöneticisi bütün firmaları görür; org süzgeci, firma sütunu ve kırılımı; USD birimi', async () => {
    await seedCalls([
      { orgId: 'org-a', startedAt: thisMonth(1, 9), costMicroUsd: 10_000 },
      { orgId: 'org-b', startedAt: thisMonth(1, 10), costMicroUsd: 30_000 },
    ]);
    await getPrisma().org.create({ data: { id: 'org-b', name: 'Bé Firma' } });
    const op = await account.access({ orgId: 'org-a', orgRole: 'MEMBER', op: true });
    const all = (await get('/api/ai/spend/summary?scope=platform', op)).json() as HubAnalytics;
    expect(kpi(all, 'spend')?.value).toBe(4);
    expect(kpi(all, 'spend_usd')).toMatchObject({ value: 0.04, currency: 'USD' });
    expect(kpi(all, 'cap_used')).toBeUndefined();
    const byOrg = widget(all, 'by_org');
    expect(byOrg?.kind === 'breakdown' && byOrg.items).toEqual([
      expect.objectContaining({ key: 'org-b', label: 'Bé Firma', value: 3 }),
      expect.objectContaining({ key: 'org-a', label: '', value: 1 }),
    ]);
    expect(widget(all, 'by_member')).toBeUndefined();

    const usd = (await get('/api/ai/spend/summary?scope=platform&currency=USD&org=org-b', op)).json() as HubAnalytics;
    expect(kpi(usd, 'spend')).toMatchObject({ value: 0.03, currency: 'USD' });
    expect(kpi(usd, 'cap_used')?.value).toBe(0.1);

    const calls = (await get('/api/ai/spend/calls?scope=platform', op)).json() as HubDatasetPage;
    expect(calls.total).toBe(2);
    expect(calls.columns.map((c) => c.id)).toContain('org');
    expect(calls.rows.map((r) => r.cells.org).sort()).toEqual(['Bé Firma', 'org-a']);
    expect((await get('/api/ai/spend/calls?scope=platform&member=none', op)).statusCode).toBe(400);
    // Firma görünümünde USD yok.
    expect((await get('/api/ai/spend/summary?currency=USD', await owner('org-a'))).statusCode).toBe(400);
  });
});

describe('özet ve liste', () => {
  it('KPI, günlük seri, kırılımlar; pending özete girmez, listede görünür; süzgeçler', async () => {
    const day = thisMonth(1, 12);
    await seedCalls([
      { orgId: 'org-a', startedAt: day, costMicroUsd: 12_000, cacheReadTokens: 10_000, memberId: 'mem-x' },
      { orgId: 'org-a', startedAt: day, status: 'failed', costMicroUsd: 0, memberId: null },
      { orgId: 'org-a', startedAt: day, status: 'cancelled', costMicroUsd: 3_000, memberId: 'mem-x' },
      { orgId: 'org-a', startedAt: day, status: 'pending', costMicroUsd: 0 },
      { orgId: 'org-a', startedAt: day, product: 'tagpress', costMicroUsd: 5_000, memberId: 'mem-y' },
    ]);
    const t = await owner('org-a');
    const s = (await get('/api/ai/spend/summary', t, { 'accept-language': 'en' })).json() as HubAnalytics;
    expect(s.product).toBe('ai');
    expect(s.sections.map((x) => x.id)).toEqual(['overview', 'products', 'purposes', 'models', 'members']);
    expect(kpi(s, 'calls')).toMatchObject({ value: 4, hint: '2 succeeded · 1 failed · 1 cancelled' });
    expect(kpi(s, 'spend')?.value).toBe(2);
    expect(kpi(s, 'tokens')?.value).toBe(4 * 2000 + 10_000);
    // Sonnet 5.5: girdi 2 $, okuma 0,10 $ / 1M → 10.000 × 1,9 = 19.000 mikro USD = 1,90 TL.
    expect(kpi(s, 'cache_savings')?.value).toBe(1.9);
    // Hak 30 $; harcanan 0,02 $ → %0,07 → bir haneye yuvarlanır.
    expect(kpi(s, 'cap_used')?.value).toBe(0.1);
    const daily = widget(s, 'daily');
    expect(daily?.kind).toBe('timeseries');
    if (daily?.kind === 'timeseries') {
      expect(daily.series.map((x) => x.id)).toEqual(['deciship', 'tagpress']);
      expect(daily.series[0]!.points.find((p) => p.x === ymd(day))?.y).toBe(1.5);
    }
    const members = widget(s, 'by_member');
    expect(members?.kind === 'breakdown' && members.items.map((i) => i.key).sort()).toEqual(['mem-x', 'mem-y', 'none']);
    const products = widget(s, 'by_product');
    expect(products?.kind === 'breakdown' && products.items.find((i) => i.key === 'deciship')?.href).toBe('/account/billing/ai/deciship');

    const list = (await get('/api/ai/spend/calls?pageSize=2', t)).json() as HubDatasetPage;
    expect(list.total).toBe(5);
    expect(list.rows).toHaveLength(2);
    expect((await get('/api/ai/spend/calls?status=failed', t)).json().total).toBe(1);
    expect((await get('/api/ai/spend/calls?member=none', t)).json().total).toBe(1);
    expect((await get('/api/ai/spend/calls?product=tagpress', t)).json().total).toBe(1);
    expect((await get('/api/ai/spend/calls?purpose=deciship.invoice_pdf', t)).json().total).toBe(4);
    expect((await get('/api/ai/spend/calls?model=claude-haiku-5-5', t)).json().total).toBe(1);

    const empty = (await get(`/api/ai/spend/summary?from=${ymd(lastMonth(1))}&to=${ymd(lastMonth(2))}`, t)).json() as HubAnalytics;
    expect(kpi(empty, 'spend')?.value).toBe(0);
    const emptyDaily = widget(empty, 'daily');
    expect(emptyDaily?.kind === 'timeseries' && emptyDaily.series).toEqual([]);
  });

  it('günler firmanın saat diliminde (firma), UTC (platform)', async () => {
    // Önceki ayın 10'u 22:30 UTC = İstanbul'da 11'i 01:30.
    const at = lastMonth(10, 22, 30);
    await seedCalls([{ orgId: 'org-a', startedAt: at, costMicroUsd: 10_000 }]);
    await getPrisma().org.create({ data: { id: 'org-a', name: 'A', timeZone: 'Europe/Istanbul' } });
    const range = `from=${ymd(lastMonth(1))}&to=${ymd(lastMonth(20))}`;
    const org = (await get(`/api/ai/spend/summary?${range}`, await owner('org-a'))).json() as HubAnalytics;
    const d1 = widget(org, 'daily');
    const local = d1?.kind === 'timeseries' ? d1.series[0]!.points.filter((p) => p.y) : [];
    expect(local.map((p) => p.x)).toEqual([ymd(lastMonth(11))]);
    const plat = (await get(`/api/ai/spend/summary?scope=platform&${range}`, await account.access({ op: true }))).json() as HubAnalytics;
    const d2 = widget(plat, 'daily');
    const utc = d2?.kind === 'timeseries' ? d2.series[0]!.points.filter((p) => p.y) : [];
    expect(utc.map((p) => p.x)).toEqual([ymd(lastMonth(10))]);
    // Yalnız 11'i (İstanbul) seçilirse satır girer, 10'u seçilirse girmez.
    const only10 = (await get(`/api/ai/spend/calls?from=${ymd(lastMonth(10))}&to=${ymd(lastMonth(10))}`, await owner('org-a'))).json();
    expect(only10.total).toBe(0);
  });

  it('bozuk süzgeç 400', async () => {
    const t = await owner('org-a');
    const now = new Date();
    const earliest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1));
    for (const q of [
      'from=2026-02-30',
      'from=2020-01-01',
      `from=${ymd(lastMonth(5))}&to=${ymd(lastMonth(4))}`,
      `from=${ymd(earliest)}&to=${ymd(new Date(earliest.getTime() + 370 * 86_400_000))}`,
      'product=yok',
      'product=deciship&purpose=tagpress.design',
      'purpose=deciship.bilinmeyen',
      'status=pending',
      'model=bad model',
      'member=a;b',
      'scope=diger',
      'page=0',
      'pageSize=500',
    ]) {
      const res = await get(`/api/ai/spend/calls?${q}`, t);
      expect(res.statusCode, q).toBe(400);
      expect(res.json().error.code, q).toBe('VALIDATION');
    }
  });
});

describe('dışa aktarma', () => {
  it('XLSX: geçerli zip, başlıklar isteğin dilinde, satır sayısı; CSV: BOM ve formül koruması', async () => {
    await seedCalls([
      { orgId: 'org-a', startedAt: thisMonth(1, 9) },
      { orgId: 'org-a', startedAt: thisMonth(1, 10), memberId: '=cmd' },
    ]);
    const t = await owner('org-a');
    const res = await app.inject({ method: 'GET', url: '/api/ai/spend/calls/export', headers: { ...auth(t), 'accept-language': 'tr' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('.xlsx');
    const files = unzip(res.rawPayload);
    expect([...files.keys()]).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml']));
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('Tutar (TRY)');
    expect(sheet.match(/<row /g)).toHaveLength(3);

    const csv = await get('/api/ai/spend/calls/export?format=csv', t, { 'accept-language': 'en' });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(csv.body).toContain('Amount (TRY)');
    expect(csv.body).toContain("'=cmd");
    expect((await get('/api/ai/spend/calls/export?format=pdf', t)).statusCode).toBe(400);
  });

  it(`${AI_SPEND_EXPORT_MAX_ROWS} satırı aşan aralık 400 (too_many_rows)`, async () => {
    const c = await superClient();
    const at = thisMonth(1, 8);
    await c.query(
      `INSERT INTO ai."AiCall" ("id", "product", "orgId", "purpose", "origin", "provider", "requestedModel", "priceVersion", "status", "toolRequestId", "startedAt")
       SELECT gen_random_uuid(), 'deciship', 'org-a', 'deciship.invoice_pdf', 'request', 'anthropic', 'claude-sonnet-5-5', 'r100:test', 'ok', 'req-' || g, $1
       FROM generate_series(1, $2::int) g`,
      [at, AI_SPEND_EXPORT_MAX_ROWS + 1],
    );
    const res = await get('/api/ai/spend/calls/export', await owner('org-a'));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'VALIDATION', details: { reason: 'too_many_rows', maxRows: AI_SPEND_EXPORT_MAX_ROWS } });
  }, 60_000);
});

describe('aylık hak görünümü', () => {
  it('tek ortak hak TL, araç kırılımı; yöneticinin ezdiği hak ve dolma durumu', async () => {
    await seedCalls([
      { orgId: 'org-a', startedAt: thisMonth(1), costMicroUsd: 6_000_000 },
      { orgId: 'org-a', startedAt: thisMonth(1), costMicroUsd: 1_000_000, product: 'tagpress' },
      { orgId: 'org-b', startedAt: thisMonth(1), costMicroUsd: 29_000_000 },
    ]);
    const t = await owner('org-a');
    const v = (await get('/api/ai/spend/allowance', t)).json();
    // Hak 30 $ = 3.000 TL; harcanan 7 $ = 700 TL.
    expect(v).toMatchObject({ currency: 'TRY', capAmount: 3000, usedAmount: 700, remainingAmount: 2300, usedPct: 23, state: 'ok', pausedBy: null });
    expect(v.byProduct).toEqual([
      { product: 'deciship', usedAmount: 600, capAmount: 1500, state: 'ok' },
      { product: 'tagpress', usedAmount: 100, capAmount: 2000, state: 'ok' },
    ]);
    await getPrisma().org.create({ data: { id: 'org-a', capOverrideMicroUsd: 7_000_000n } });
    const capped = (await get('/api/ai/spend/allowance', t)).json();
    expect(capped).toMatchObject({ capAmount: 700, state: 'capped', pausedBy: 'org', usedPct: 100 });
  });
});
