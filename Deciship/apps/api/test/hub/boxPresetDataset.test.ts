/**
 * Merkez Veriler: hazır koli seti. Diğer setlerle aynı sözleşme: alan, arama, sıralama, süzgeç, sayfa, CSV, rol, firma sınırı.
 */
import type { HubDatasetList, HubDatasetPage } from '@sellerondata/contracts';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { companyFixture, type Fixture } from '../fixtures.ts';
import { findMoneyKeys, getApp, issueIdentity, measurementPayload, uniq } from '../helpers.ts';

const API = '/api/deciship';
const SET = `${API}/platform/datasets/box-presets`;
type Auth = { authorization: string };

let app: FastifyInstance;
let a: Fixture;
let b: Fixture;
let accounting: Auth;
let auditor: Auth;
const bigName = uniq('Büyük ');
const smallName = uniq('Küçük ');
const passiveName = uniq('Pasif ');
const otherFirmName = uniq('BaşkaFirma ');
let bigId = '';

const get = (url: string, auth: Auth, lang = 'tr') => app.inject({ method: 'GET', url, headers: { ...auth, 'accept-language': lang } });
const page = async (query: string, auth: Auth = a.admin.auth, lang = 'tr') => {
  const r = await get(`${SET}${query}`, auth, lang);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as HubDatasetPage;
};
const addPreset = async (f: Fixture, name: string, l: number, w: number, h: number, sortOrder: number) => {
  const r = await app.inject({ method: 'POST', url: `${API}/box-presets`, headers: f.admin.auth, payload: { name, lengthCm: l, widthCm: w, heightCm: h, sortOrder } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().item?.id ?? r.json().preset?.id ?? r.json().boxPreset?.id;
};

beforeAll(async () => {
  app = await getApp();
  a = await companyFixture(app);
  b = await companyFixture(app);
  accounting = (await issueIdentity({ companyId: a.companyId, orgName: a.admin.orgName, role: 'ACCOUNTING' })).auth;
  auditor = (await issueIdentity({ companyId: a.companyId, orgName: a.admin.orgName, role: 'AUDITOR' })).auth;
  bigId = await addPreset(a, bigName, 60, 50, 40, 100);
  await addPreset(a, smallName, 10, 10, 10, 101);
  const passive = await addPreset(a, passiveName, 20, 20, 20, 102);
  const off = await app.inject({ method: 'PATCH', url: `${API}/box-presets/${passive}`, headers: a.admin.auth, payload: { active: false } });
  expect(off.statusCode, off.body).toBe(200);
  await addPreset(b, otherFirmName, 33, 33, 33, 1);
  const p = measurementPayload({ boxPresetId: bigId });
  const m = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...a.admin.auth, ...p.headers }, payload: p.payload });
  expect(m.statusCode, m.body).toBe(201);
});

describe('hazır koli veri seti', () => {
  it('listede, TR ve EN etiketli, dışa aktarılabilir', async () => {
    const list = async (lang: string) => (await get(`${API}/platform/datasets`, a.admin.auth, lang)).json() as HubDatasetList;
    const tr = (await list('tr')).datasets.find((d) => d.id === 'box-presets')!;
    const en = (await list('en')).datasets.find((d) => d.id === 'box-presets')!;
    expect(tr.label).toBe('Hazır koliler');
    expect(en.label).toBe('Box presets');
    expect(tr.description).toBeTruthy();
    expect(en.description).not.toBe(tr.description);
    expect(tr.exportable).toBe(true);
    expect(tr.filters.map((f) => f.id)).toEqual(['active']);
  });

  it('alanlar: ölçü, desi, durum, kullanım; hücre sütunlarla aynı; para izi yok', async () => {
    const p = await page('?pageSize=200');
    expect(p.columns.map((c) => c.id)).toEqual(['name', 'lengthCm', 'widthCm', 'heightCm', 'desi', 'active', 'measurements', 'sortOrder']);
    const big = p.rows.find((r) => r.cells.name === bigName)!;
    expect(big.id).toBe(bigId);
    expect(big.cells).toEqual({ name: bigName, lengthCm: 60, widthCm: 50, heightCm: 40, desi: 40, active: 'Evet', measurements: 1, sortOrder: 100 });
    expect(big.href).toBe('/deciship/settings');
    expect(findMoneyKeys(p.rows.map((r) => r.cells))).toEqual([]);
    const en = await page('?pageSize=200', a.admin.auth, 'en');
    expect(en.columns.find((c) => c.id === 'lengthCm')!.label).toMatch(/length/i);
    expect(en.rows.find((r) => r.cells.name === passiveName)!.cells.active).toBe('No');
  });

  it('arama, sıralama, süzgeç, sayfalama', async () => {
    expect((await page(`?q=${encodeURIComponent(bigName.slice(0, 8).toLocaleLowerCase('tr'))}`)).rows.map((r) => r.cells.name)).toEqual([bigName]);
    const asc = (await page('?sort=lengthCm&dir=asc&pageSize=200')).rows.map((r) => r.cells.lengthCm as number);
    expect(asc).toEqual([...asc].sort((x, y) => x - y));
    const desc = (await page('?sort=name&dir=desc&pageSize=200')).rows.map((r) => r.cells.name as string);
    expect(desc[0]! >= desc[desc.length - 1]!).toBe(true);
    const dflt = (await page('?pageSize=200')).rows.map((r) => r.cells.sortOrder as number);
    expect(dflt).toEqual([...dflt].sort((x, y) => x - y));
    expect((await page('?filter.active=no')).rows.map((r) => r.cells.name)).toEqual([passiveName]);
    expect((await page('?filter.active=yes&pageSize=200')).rows.map((r) => r.cells.name)).not.toContain(passiveName);
    expect((await get(`${SET}?filter.active=belki`, a.admin.auth)).statusCode).toBe(400);
    for (const sort of ['1;DROP TABLE x', 'constructor', '__proto__']) expect((await get(`${SET}?sort=${encodeURIComponent(sort)}`, a.admin.auth)).statusCode, sort).toBe(200);
    const all = await page('?pageSize=200');
    const first = await page('?pageSize=2&page=1');
    const second = await page('?pageSize=2&page=2');
    expect(first.total).toBe(all.total);
    expect(first.rows).toHaveLength(2);
    expect([...first.rows, ...second.rows].map((r) => r.id)).toEqual(all.rows.slice(0, 4).map((r) => r.id));
  });

  it('CSV: TR ve EN, tüm satırlar, sayfa sırası', async () => {
    const tr = await get(`${SET}/export`, a.admin.auth);
    expect(tr.statusCode).toBe(200);
    expect(tr.headers['content-type']).toContain('text/csv');
    expect(tr.body.charCodeAt(0)).toBe(0xfeff);
    const lines = tr.body.slice(1).trim().split('\r\n');
    expect(lines[0]).toContain(';');
    expect(lines[0]).toContain('Uzunluk (cm)');
    expect(lines.some((l) => l.startsWith(`${bigName};60;50;40;40;Evet;1;100`))).toBe(true);
    expect(lines.slice(1).map((l) => l.split(';')[0])).toEqual((await page('?pageSize=200')).rows.map((r) => r.cells.name));
    const en = await get(`${SET}/export`, a.admin.auth, 'en');
    expect(en.body).toContain('Length (cm),');
    expect(en.body).not.toContain('undefined');
  });

  it('Muhasebe ve Denetleyici: okur, pasifi görmez, ayar bağlantısı yok', async () => {
    for (const auth of [accounting, auditor]) {
      const p = await page('?pageSize=200', auth);
      const names = p.rows.map((r) => r.cells.name);
      expect(names).toContain(bigName);
      expect(names).not.toContain(passiveName);
      expect(p.rows.every((r) => r.href === undefined)).toBe(true);
      expect((await page('?filter.active=no', auth)).rows).toEqual([]);
      const csv = await get(`${SET}/export`, auth);
      expect(csv.statusCode).toBe(200);
      expect(csv.body).not.toContain(passiveName);
      const def = ((await get(`${API}/platform/datasets`, auth)).json() as HubDatasetList).datasets.find((d) => d.id === 'box-presets')!;
      expect(def.filters).toEqual([]);
    }
  });

  it('Ölçüm rolü giremez: liste, sayfa, CSV', async () => {
    expect((await get(`${API}/platform/datasets`, a.worker.auth)).statusCode).toBe(403);
    for (const url of [SET, `${SET}/export`]) {
      const r = await get(url, a.worker.auth);
      expect(r.statusCode, url).toBe(403);
      expect(r.body).not.toContain(bigName);
    }
  });

  it('firma sınırı: başka firmanın kolisi sayfada, aramada ve CSV de yok', async () => {
    expect((await page('?pageSize=200')).rows.map((r) => r.cells.name)).not.toContain(otherFirmName);
    expect((await page(`?q=${encodeURIComponent(otherFirmName)}`)).rows).toEqual([]);
    expect((await get(`${SET}/export`, a.admin.auth)).body).not.toContain(otherFirmName);
    expect((await page('?pageSize=200', b.admin.auth)).rows.map((r) => r.cells.name)).not.toContain(bigName);
  });
});
