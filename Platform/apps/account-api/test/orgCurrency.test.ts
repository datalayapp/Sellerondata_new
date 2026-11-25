import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/db.ts';
import { localAddressWarning } from '../src/env.ts';
import { announceAllOrgs } from '../src/lib/orgs.ts';
import { API, getApp, registerOrg, type Ctx, asWeb } from './helpers.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

type Payload = { type: string; name: string; currency?: string; country?: string; version: number };

async function orgEvents(orgId: string) {
  const rows = await prisma.outbox.findMany({ where: { orgId, type: 'org.updated' } });
  return rows.map((r) => r.payload as Payload).sort((a, b) => a.version - b.version);
}

async function patchOrg(owner: Ctx, payload: Record<string, unknown>) {
  return app.inject({ method: 'PATCH', url: `${API}/org`, headers: await asWeb(owner), payload });
}

describe('org.updated para birimini taşır', () => {
  it('kayıtta ülke US: ilk olay USD ve sürüm 1', async () => {
    const owner = await registerOrg(app, { country: 'US' });
    const [first] = await orgEvents(owner.orgId);
    expect(first).toMatchObject({ currency: 'USD', version: 1 });
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } })).currency).toBe('USD');
  });

  it('kayıtta ülke TR: ilk olay TRY', async () => {
    const owner = await registerOrg(app, { country: 'TR' });
    expect((await orgEvents(owner.orgId))[0]).toMatchObject({ currency: 'TRY', version: 1 });
  });

  it('sonradan açılan firma (POST /orgs) da aynı olayı üretir', async () => {
    const owner = await registerOrg(app);
    const res = await app.inject({ method: 'POST', url: `${API}/orgs`, headers: owner.headers, payload: { name: 'İkinci Firma', country: 'US' } });
    expect(res.statusCode).toBe(201);
    const second = await prisma.organization.findFirstOrThrow({ where: { name: 'İkinci Firma', memberships: { some: { personId: owner.personId } } } });
    expect((await orgEvents(second.id))[0]).toMatchObject({ currency: 'USD', version: 1 });
  });

  it('PATCH para birimi: olay üretir, sürüm artar', async () => {
    const owner = await registerOrg(app, { country: 'TR' });
    const res = await patchOrg(owner, { currency: 'USD' });
    expect(res.statusCode).toBe(200);
    const events = await orgEvents(owner.orgId);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ currency: 'USD', version: 2 });
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } })).version).toBe(2);
  });

  it('PATCH ad: olay güncel para birimini de taşır', async () => {
    const owner = await registerOrg(app, { country: 'US' });
    await patchOrg(owner, { name: 'Yeni Ad' });
    expect((await orgEvents(owner.orgId)).at(-1)).toMatchObject({ name: 'Yeni Ad', currency: 'USD', version: 2 });
  });

  it('ad ve para birimi birlikte: tek olay, tek sürüm', async () => {
    const owner = await registerOrg(app, { country: 'TR' });
    await patchOrg(owner, { name: 'Birlikte', currency: 'USD' });
    const events = await orgEvents(owner.orgId);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ name: 'Birlikte', currency: 'USD', version: 2 });
  });

  it('değişmeyen para birimi, değişmeyen ülke ve dil olay üretmez, sürüm artmaz', async () => {
    const owner = await registerOrg(app, { country: 'TR' });
    for (const payload of [{ currency: 'TRY' }, { country: 'TR' }, { country: 'tr' }, { locale: 'en' }]) {
      expect((await patchOrg(owner, payload)).statusCode).toBe(200);
    }
    expect(await orgEvents(owner.orgId)).toHaveLength(1);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } })).version).toBe(1);
  });

  it('kayıtta ve sonradan açılan firmada ilk olay ülkeyi de taşır', async () => {
    const us = await registerOrg(app, { country: 'US' });
    expect((await orgEvents(us.orgId))[0]).toMatchObject({ country: 'US', currency: 'USD', version: 1 });
    const tr = await registerOrg(app, { country: 'TR' });
    expect((await orgEvents(tr.orgId))[0]).toMatchObject({ country: 'TR', currency: 'TRY', version: 1 });
    const res = await app.inject({ method: 'POST', url: `${API}/orgs`, headers: tr.headers, payload: { name: 'Almanya Şubesi', country: 'DE' } });
    expect(res.statusCode).toBe(201);
    const second = await prisma.organization.findFirstOrThrow({ where: { name: 'Almanya Şubesi', memberships: { some: { personId: tr.personId } } } });
    expect((await orgEvents(second.id))[0]).toMatchObject({ country: 'DE', currency: 'EUR', version: 1 });
    const gb = await registerOrg(app, { country: 'GB' });
    expect((await orgEvents(gb.orgId))[0]).toMatchObject({ country: 'GB', currency: 'GBP', version: 1 });
  });

  it('PATCH ülke: olay üretir, sürüm artar, para birimi yerinde kalır', async () => {
    const owner = await registerOrg(app, { country: 'TR' });
    const res = await patchOrg(owner, { country: 'us' });
    expect(res.statusCode).toBe(200);
    const events = await orgEvents(owner.orgId);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ country: 'US', currency: 'TRY', version: 2 });
  });

  it('PATCH ad: olay güncel ülkeyi de taşır', async () => {
    const owner = await registerOrg(app, { country: 'DE' });
    await patchOrg(owner, { name: 'Yeni Ad' });
    expect((await orgEvents(owner.orgId)).at(-1)).toMatchObject({ name: 'Yeni Ad', country: 'DE', version: 2 });
  });

  it('eşzamanlı ülke değişiminde en büyük sürüm veritabanındaki ülkeyi taşır', async () => {
    const owner = await registerOrg(app, { country: 'TR' });
    await Promise.all([patchOrg(owner, { country: 'US' }), patchOrg(owner, { country: 'DE' }), patchOrg(owner, { country: 'GB' }), patchOrg(owner, { name: 'Ülkeli Ad' })]);
    const events = await orgEvents(owner.orgId);
    expect(new Set(events.map((e) => e.version)).size).toBe(events.length);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } });
    expect(events.at(-1)).toMatchObject({ name: org.name, country: org.country, currency: org.currency, version: org.version });
  });

  it('eski firmalar için duyuru: her firma güncel ülkesiyle bir kez daha gider, sürüm artar, tekrar çalıştırmak zararsız', async () => {
    const owner = await registerOrg(app, { country: 'DE' });
    const before = (await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } })).version;
    expect(await announceAllOrgs()).toBeGreaterThan(0);
    await announceAllOrgs();
    const events = await orgEvents(owner.orgId);
    expect(events.at(-1)).toMatchObject({ country: 'DE', version: before + 2 });
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } })).version).toBe(before + 2);
  });

  it('eşzamanlı değişimde sürümler tekrarlanmaz, en büyük sürüm veritabanındaki değerleri taşır', async () => {
    const owner = await registerOrg(app, { country: 'TR' });
    await Promise.all([
      patchOrg(owner, { currency: 'USD' }),
      patchOrg(owner, { name: 'Eşzamanlı' }),
      patchOrg(owner, { currency: 'TRY' }),
      patchOrg(owner, { name: 'Eşzamanlı 2' }),
    ]);
    const events = await orgEvents(owner.orgId);
    expect(new Set(events.map((e) => e.version)).size).toBe(events.length);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } });
    expect(events.at(-1)).toMatchObject({ name: org.name, currency: org.currency, version: org.version });
  });
});

describe('üretimde yerel adres uyarısı', () => {
  const saved = { env: process.env.NODE_ENV, url: process.env.APP_BASE_URL };
  afterEach(() => {
    process.env.NODE_ENV = saved.env;
    process.env.APP_BASE_URL = saved.url;
  });

  it.each(['http://localhost:8088', 'http://127.0.0.1:8088', 'https://localhost'])('üretim + %s: uyarı döner, adresi söyler', (url) => {
    process.env.NODE_ENV = 'production';
    process.env.APP_BASE_URL = url;
    expect(localAddressWarning()).toContain(url);
  });

  it('üretim + gerçek adres: uyarı yok', () => {
    process.env.NODE_ENV = 'production';
    process.env.APP_BASE_URL = 'https://app.sellerondata.com';
    expect(localAddressWarning()).toBeNull();
  });

  it('geliştirmede uyarı yok', () => {
    process.env.NODE_ENV = 'test';
    process.env.APP_BASE_URL = 'http://localhost:8088';
    expect(localAddressWarning()).toBeNull();
  });
});
