/**
 * Kullanıcı kararı: Muhasebe tarifeleri salt okunur görür. Okuma `tariffs.view`, yazma, önizleme ve içe aktarma `tariffs.edit`.
 */
import { permissionsOf } from '@sellerondata/contracts';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { companyFixture, tariffPayload, type Fixture } from './fixtures.ts';
import { findMoneyKeys, getApp, issueIdentity } from './helpers.ts';
import { ROLES } from './routeRules.ts';

const API = '/api/deciship';
let app: FastifyInstance;
let f: Fixture;
let accounting: Awaited<ReturnType<typeof issueIdentity>>;

beforeAll(async () => {
  app = await getApp();
  f = await companyFixture(app);
  accounting = await issueIdentity({ companyId: f.companyId, orgName: f.admin.orgName, role: 'ACCOUNTING', name: 'Muhasebe' });
});

const get = (url: string, auth: { authorization: string }) => app.inject({ method: 'GET', url: `${API}${url}`, headers: auth });
const QUOTE = { lengthCm: 10, widthCm: 10, heightCm: 10, weightKg: 1 };

describe('tariffs.view', () => {
  it('katalog: Yönetici, Denetleyici, Muhasebe görür; Ölçüm görmez; gören herkes fiyat izni de taşır', () => {
    const has = (role: string) => (permissionsOf('deciship', role) as readonly string[]).includes('deciship.tariffs.view');
    expect(Object.fromEntries(ROLES.map((r) => [r, has(r)]))).toEqual({ ADMIN: true, AUDITOR: true, ACCOUNTING: true, MEASURE: false });
    for (const r of ROLES) if (has(r)) expect(permissionsOf('deciship', r), r).toContain('deciship.prices.view');
    expect(permissionsOf('deciship', 'ACCOUNTING')).not.toContain('deciship.tariffs.edit');
  });

  it('Muhasebe okur ve hesaplar', async () => {
    for (const url of ['/tariffs', `/tariffs/${f.tariffId}`, `/tariffs/${f.tariffId}/versions`, `/tariff-documents/${f.documentId}`]) {
      const r = await get(url, accounting.auth);
      expect(r.statusCode, `${url} ${r.body}`).toBe(200);
    }
    const q = await app.inject({ method: 'POST', url: `${API}/tariffs/${f.tariffId}/quote`, headers: accounting.auth, payload: QUOTE });
    expect(q.statusCode, q.body).toBe(200);
  });

  it('Muhasebe yazamaz, önizleyemez, içe aktaramaz; kayıt değişmez', async () => {
    const before = (await get(`/tariffs/${f.tariffId}`, accounting.auth)).body;
    const writes: [string, string, unknown][] = [
      ['POST', '/tariffs', tariffPayload(f.carrierId)],
      ['PUT', `/tariffs/${f.tariffId}`, tariffPayload(f.carrierId)],
      ['DELETE', `/tariffs/${f.tariffId}`, undefined],
      ['POST', `/tariffs/${f.tariffId}/default`, {}],
      ['POST', `/tariffs/${f.tariffId}/duplicate`, {}],
      ['POST', `/tariffs/${f.tariffId}/import`, {}],
      ['POST', '/tariff-imports', {}],
      ['POST', `/tariff-documents/${f.documentId}/scan`, { mode: 'code' }],
      ['POST', `/tariff-documents/${f.documentId}/extract`, {}],
      ['POST', `/tariff-imports/${f.draftId}/recheck`, {}],
      ['POST', `/tariff-imports/${f.draftId}/review`, {}],
      ['POST', `/tariff-imports/${f.draftId}/apply`, {}],
      ['POST', `/tariffs/${f.tariffId}/versions/${f.versionId}/restore`, {}],
      ['POST', `/tariffs/${f.tariffId}/recompare-invoices`, {}],
      ['POST', `/tariffs/${f.tariffId}/country-adjustments`, { country: 'DE', pct: 5 }],
    ];
    for (const [method, url, payload] of writes) {
      const r = await app.inject({ method: method as 'POST', url: `${API}${url}`, headers: accounting.auth, ...(payload === undefined ? {} : { payload: payload as object }) });
      expect(r.statusCode, `${method} ${url} ${r.body}`).toBe(403);
    }
    expect((await get('/tariffs/template.xlsx', accounting.auth)).statusCode).toBe(403);
    expect((await get(`/tariffs/${f.tariffId}`, accounting.auth)).body).toBe(before);
  });

  it('Ölçüm rolü tarife göremez, hesaplayamaz; para izi yok', async () => {
    for (const url of ['/tariffs', `/tariffs/${f.tariffId}`, `/tariffs/${f.tariffId}/versions`, `/tariff-documents/${f.documentId}`]) {
      const r = await get(url, f.worker.auth);
      expect(r.statusCode, url).toBe(403);
      expect(findMoneyKeys(r.json())).toEqual([]);
    }
    expect((await app.inject({ method: 'POST', url: `${API}/tariffs/${f.tariffId}/quote`, headers: f.worker.auth, payload: QUOTE })).statusCode).toBe(403);
  });

  it('salt okunur abonelikte okuma ve hesaplama çalışır, yazma 403 READ_ONLY', async () => {
    const readOnly = await accounting.token({ status: 'READ_ONLY' });
    expect((await get('/tariffs', readOnly.auth)).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `${API}/tariffs/${f.tariffId}/quote`, headers: readOnly.auth, payload: QUOTE })).statusCode).toBe(200);
    const admin = await f.admin.token({ status: 'READ_ONLY' });
    const put = await app.inject({ method: 'PUT', url: `${API}/tariffs/${f.tariffId}`, headers: admin.auth, payload: tariffPayload(f.carrierId) });
    expect(put.statusCode).toBe(403);
    expect(put.json().error.code).toBe('READ_ONLY');
  });

  it('firmalar arası: A Muhasebesi B tarifesini ve belgesini göremez, hesaplayamaz', async () => {
    const B = await companyFixture(app);
    for (const url of [`/tariffs/${B.tariffId}`, `/tariffs/${B.tariffId}/versions`, `/tariff-documents/${B.documentId}`]) {
      expect((await get(url, accounting.auth)).statusCode, url).toBe(404);
    }
    const list = await get('/tariffs', accounting.auth);
    expect(list.body).not.toContain(B.tariffId);
    expect((await app.inject({ method: 'POST', url: `${API}/tariffs/${B.tariffId}/quote`, headers: accounting.auth, payload: QUOTE })).statusCode).toBe(404);
  });
});
