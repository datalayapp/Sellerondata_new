import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { lockCarrierDefault } from '../src/services/tariffs.ts';
import { tariffPayload } from './fixtures.ts';
import { getApp, inCompany, registerCompany, uniq } from './helpers.ts';

/**
 * Yeni denetim Mesaj 0 (rapor 10-B17, 02-B4, 02-B10): tarife düzenlemede çakışma koruması ve aynı satırın iki kez girilmesi.
 * PUT /tariffs/:id `expectedUpdatedAt` alır; tarife bu arada değiştiyse 409 STALE. Değişiklikten önceki hâl (sürüm) kilit
 * altında okunur: eşzamanlı iki kayıtta ara hâl de sürüm geçmişinde kalır. Başka tarifenin varsayılan yapılması bu tarifeye
 * dokunmuyorsa sahte çakışma doğmaz.
 */

type Auth = { authorization: string };
let app: FastifyInstance;
let auth: Auth;
let carrierId: string;
let companyId: string;

const put = (url: string, payload: unknown) => app.inject({ method: 'PUT', url, headers: auth, payload: payload as object });
const get = (url: string) => app.inject({ method: 'GET', url, headers: auth });

beforeAll(async () => {
  app = await getApp();
  const a = await registerCompany(app, uniq('Çakışma Şirketi '));
  auth = a.auth;
  companyId = a.companyId;
  const c = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code: 'fedex', name: uniq('FedEx ') } });
  expect(c.statusCode, c.body).toBe(201);
  carrierId = c.json().carrier.id;
});

async function createTariff(over: Record<string, unknown> = {}) {
  const r = await app.inject({ method: 'POST', url: '/api/deciship/tariffs', headers: auth, payload: tariffPayload(carrierId, { isDefault: false, ...over }) });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().tariff as { id: string; name: string; updatedAt: string; fuelPct: number };
}
const versionSnapshots = (tariffId: string) =>
  inCompany(auth, () => prisma.tariffVersion.findMany({ where: { tariffId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { snapshot: true } }));

describe('tarife kaydında çakışma koruması (10-B17, 02-B4)', () => {
  it('düzenlenen hâl değişmediyse kayıt olur ve yeni an döner', async () => {
    const t = await createTariff();
    const r = await put(`/api/deciship/tariffs/${t.id}`, { ...tariffPayload(carrierId, { name: t.name, isDefault: false, fuelPct: 12 }), expectedUpdatedAt: t.updatedAt });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().tariff.fuelPct).toBe(12);
    expect(new Date(r.json().tariff.updatedAt).getTime()).toBeGreaterThan(new Date(t.updatedAt).getTime());
  });

  it('tarife bu arada değiştiyse 409 STALE; ikinci kayıt ilkini ezmez', async () => {
    const t = await createTariff();
    const first = await put(`/api/deciship/tariffs/${t.id}`, { ...tariffPayload(carrierId, { name: t.name, isDefault: false, fuelPct: 15 }), expectedUpdatedAt: t.updatedAt });
    expect(first.statusCode, first.body).toBe(200);
    const second = await put(`/api/deciship/tariffs/${t.id}`, { ...tariffPayload(carrierId, { name: 'Eski ekrandan', isDefault: false, fuelPct: 12 }), expectedUpdatedAt: t.updatedAt });
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json().error.code).toBe('STALE');
    expect(second.json().error.message).toMatch(/siz bakarken değişti/);
    expect(second.json().error.details.updatedAt).toBe(first.json().tariff.updatedAt);
    const now = (await get(`/api/deciship/tariffs/${t.id}`)).json().tariff;
    expect(now).toMatchObject({ fuelPct: 15, name: t.name });
  });

  it('aynı hâli düzenleyen iki eşzamanlı kayıttan yalnız biri yazılır', async () => {
    const t = await createTariff();
    const [a, b] = await Promise.all([
      put(`/api/deciship/tariffs/${t.id}`, { ...tariffPayload(carrierId, { name: t.name, isDefault: false, fuelPct: 15 }), expectedUpdatedAt: t.updatedAt }),
      put(`/api/deciship/tariffs/${t.id}`, { ...tariffPayload(carrierId, { name: t.name, isDefault: false, fuelPct: 12 }), expectedUpdatedAt: t.updatedAt }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const winner = a.statusCode === 200 ? 15 : 12;
    expect((await get(`/api/deciship/tariffs/${t.id}`)).json().tariff.fuelPct).toBe(winner);
  });

  it('beklenen an verilmeyen eşzamanlı iki kayıtta ara hâl de sürüm geçmişinde kalır (kilit altında okunur)', async () => {
    const t = await createTariff({ fuelPct: 10 });
    const [a, b] = await Promise.all([
      put(`/api/deciship/tariffs/${t.id}`, tariffPayload(carrierId, { name: t.name, isDefault: false, fuelPct: 15 })),
      put(`/api/deciship/tariffs/${t.id}`, tariffPayload(carrierId, { name: t.name, isDefault: false, fuelPct: 12 })),
    ]);
    expect(a.statusCode, a.body).toBe(200);
    expect(b.statusCode, b.body).toBe(200);
    const fuels = (await versionSnapshots(t.id)).map((v) => (v.snapshot as { fuelPct: number }).fuelPct);
    const final = (await get(`/api/deciship/tariffs/${t.id}`)).json().tariff.fuelPct as number;
    // önce ilk hâl (10), sonra öbür kaydın yazdığı ara hâl; ikisi de geri alınabilir
    expect(fuels).toEqual([10, final === 15 ? 12 : 15]);
  });

  it('geçersiz an 400; eski istemci (an yok) bugünkü gibi kaydeder', async () => {
    const t = await createTariff();
    const bad = await put(`/api/deciship/tariffs/${t.id}`, { ...tariffPayload(carrierId, { name: t.name, isDefault: false }), expectedUpdatedAt: 'dün' });
    expect(bad.statusCode, bad.body).toBe(400);
    const old = await put(`/api/deciship/tariffs/${t.id}`, tariffPayload(carrierId, { name: t.name, isDefault: false, fuelPct: 3 }));
    expect(old.statusCode, old.body).toBe(200);
  });

  it('başka tarife varsayılan yapılınca varsayılan olmayan kardeşin anı değişmez (sahte çakışma yok); önceki varsayılanınki değişir', async () => {
    const other = await createTariff();
    const prevDefault = await createTariff({ isDefault: true });
    const editing = (await get(`/api/deciship/tariffs/${other.id}`)).json().tariff;
    const prevBefore = (await get(`/api/deciship/tariffs/${prevDefault.id}`)).json().tariff;
    await createTariff({ isDefault: true });
    expect((await get(`/api/deciship/tariffs/${other.id}`)).json().tariff.updatedAt).toBe(editing.updatedAt);
    const prevAfter = (await get(`/api/deciship/tariffs/${prevDefault.id}`)).json().tariff;
    expect(prevAfter.isDefault).toBe(false);
    expect(prevAfter.updatedAt).not.toBe(prevBefore.updatedAt);
    const r = await put(`/api/deciship/tariffs/${other.id}`, { ...tariffPayload(carrierId, { name: other.name, isDefault: false, fuelPct: 7 }), expectedUpdatedAt: editing.updatedAt });
    expect(r.statusCode, r.body).toBe(200);
  });
});

describe('taşıyıcıda tek varsayılan, eşzamanlı işlemlerde de (02-B10)', () => {
  it('iki tarife aynı anda "Varsayılan yap" ya da varsayılan kaydedilince taşıyıcıda tek varsayılan kalır', async () => {
    const c = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code: 'ups', name: uniq('UPS ') } });
    expect(c.statusCode, c.body).toBe(201);
    const cid = c.json().carrier.id as string;
    const mk = async () => {
      const r = await app.inject({ method: 'POST', url: '/api/deciship/tariffs', headers: auth, payload: tariffPayload(cid, { isDefault: false }) });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().tariff as { id: string; name: string };
    };
    const ts = [await mk(), await mk(), await mk()];
    const defaults = async () =>
      (await get(`/api/deciship/tariffs?carrierId=${cid}`)).json().items.filter((t: { isDefault: boolean }) => t.isDefault).map((t: { id: string }) => t.id);
    for (let round = 0; round < 6; round++) {
      const rs = await Promise.all([
        app.inject({ method: 'POST', url: `/api/deciship/tariffs/${ts[0]!.id}/default`, headers: auth }),
        app.inject({ method: 'POST', url: `/api/deciship/tariffs/${ts[1]!.id}/default`, headers: auth }),
        put(`/api/deciship/tariffs/${ts[2]!.id}`, tariffPayload(cid, { name: ts[2]!.name, isDefault: true })),
      ]);
      for (const r of rs) expect(r.statusCode, r.body).toBe(200);
      expect(await defaults()).toHaveLength(1);
    }
  });

  it('"Varsayılan yap", başka işlemin henüz kaydedilmemiş varsayılanını bekler (iki varsayılan kalmaz)', async () => {
    const c = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code: 'dhl', name: uniq('DHL ') } });
    expect(c.statusCode, c.body).toBe(201);
    const cid = c.json().carrier.id as string;
    const mk = async (isDefault: boolean) => {
      const r = await app.inject({ method: 'POST', url: '/api/deciship/tariffs', headers: auth, payload: tariffPayload(cid, { isDefault }) });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().tariff.id as string;
    };
    await mk(true); // önceki varsayılan
    const x = await mk(false);
    const y = await mk(false);
    // Başka bir istek (aynı kuralla) X'i varsayılan yapıyor ve işlemi henüz bitmedi; bu sırada Y için "Varsayılan yap" gelir.
    let second: Promise<{ statusCode: number; body: string }> | undefined;
    await inCompany(companyId, () =>
      prisma.$transaction(async (tx) => {
        await lockCarrierDefault(tx, companyId, cid);
        await tx.tariff.updateMany({ where: { companyId, carrierId: cid, id: { not: x }, isDefault: true }, data: { isDefault: false } });
        await tx.tariff.update({ where: { id: x }, data: { isDefault: true } });
        second = app.inject({ method: 'POST', url: `/api/deciship/tariffs/${y}/default`, headers: auth });
        await new Promise((r) => setTimeout(r, 400));
      }),
    );
    const r = await second!;
    expect(r.statusCode, r.body).toBe(200);
    const items = (await get(`/api/deciship/tariffs?carrierId=${cid}`)).json().items as { id: string; isDefault: boolean }[];
    expect(items.filter((t) => t.isDefault).map((t) => t.id)).toEqual([y]);
  });
});

describe('ülke istisnası eşzamanlı yazımda kaybolmaz (02-B4)', () => {
  it('iki ülke istisnası aynı anda eklenince ikisi de kalır; her biri ezdiği hâli sürümde saklar', async () => {
    const t = await createTariff();
    const add = (country: string, pct: number) =>
      app.inject({ method: 'POST', url: `/api/deciship/tariffs/${t.id}/country-adjustments`, headers: auth, payload: { country, pct, source: 'manual' } });
    const rs = await Promise.all([add('DE', -10), add('FR', 5), add('IT', 7)]);
    for (const r of rs) expect(r.statusCode, r.body).toBe(200);
    const now = (await get(`/api/deciship/tariffs/${t.id}`)).json().tariff;
    expect(now.countryAdjustments.map((a: { country: string }) => a.country)).toEqual(['DE', 'FR', 'IT']);
    // sürümler sırayla 0, 1, 2 istisnalı hâli saklar (hiçbiri aynı eski hâli iki kez değil)
    const counts = (await versionSnapshots(t.id)).map((v) => ((v.snapshot as { countryAdjustments?: unknown[] }).countryAdjustments ?? []).length);
    expect(counts).toEqual([0, 1, 2]);
  });

  it('istisna eklendikten sonra eski ekrandan kayıt 409 STALE (istisna ezilmez)', async () => {
    const t = await createTariff();
    const adj = await app.inject({ method: 'POST', url: `/api/deciship/tariffs/${t.id}/country-adjustments`, headers: auth, payload: { country: 'DE', pct: -10, source: 'manual' } });
    expect(adj.statusCode, adj.body).toBe(200);
    const r = await put(`/api/deciship/tariffs/${t.id}`, { ...tariffPayload(carrierId, { name: t.name, isDefault: false, fuelPct: 9 }), expectedUpdatedAt: t.updatedAt });
    expect(r.statusCode, r.body).toBe(409);
    expect((await get(`/api/deciship/tariffs/${t.id}`)).json().tariff.countryAdjustments).toEqual([expect.objectContaining({ country: 'DE', pct: -10 })]);
  });
});

describe('aynı fiyat ya da ek ücret satırı iki kez girilmez (02-B10)', () => {
  it('aynı bölge ve ağırlık iki fiyat: 400, satır söylenir; "a" ile "A" aynı bölge', async () => {
    const rates = [
      { zone: 'A', weightUpto: 1, price: 10 },
      { zone: 'a', weightUpto: 1, price: 12 },
    ];
    const r = await app.inject({ method: 'POST', url: '/api/deciship/tariffs', headers: auth, payload: tariffPayload(carrierId, { isDefault: false, zones: [{ country: '*', zone: 'A' }], rates, overflow: [] }) });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.code).toBe('VALIDATION');
    expect(r.json().error.details).toEqual([expect.objectContaining({ path: 'rates.1' })]);
  });

  it('aynı gruptaki ek ücret iki kez: PUT 400, tarife değişmez', async () => {
    const t = await createTariff();
    const surcharges = [
      { code: 'RES', name: 'Konut', kind: 'FIXED', amount: 45 },
      { code: 'res', name: 'Konut 2', kind: 'FIXED', amount: 50 },
    ];
    const r = await put(`/api/deciship/tariffs/${t.id}`, tariffPayload(carrierId, { name: t.name, isDefault: false, surcharges }));
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.details).toEqual([expect.objectContaining({ path: 'surcharges.1' })]);
    const now = (await get(`/api/deciship/tariffs/${t.id}`)).json().tariff;
    expect(now.surcharges.map((s: { code: string }) => s.code)).toEqual(['FUEL']);
  });
});
