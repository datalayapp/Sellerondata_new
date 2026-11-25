/**
 * Merkez kurulumu (2026-11-13): firma bilgilerinin Merkez'de onayı. `Organization.companyConfirmedAt`, `PATCH /org
 * { confirmCompany: true }`, GET /org, /me `activeOrg.companyConfirmedAt` ve her `org.updated` olayındaki `companyConfirmed`.
 * Yeni firma onaysız açılır; göçten önce açılmış firmalar `createdAt` ile doldurulur; demo firması onaylıdır.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { isCompanyConfirmed } from '@sellerondata/contracts';
import { prisma } from '../src/db.ts';
import { announceAllOrgs } from '../src/lib/orgs.ts';
import { orgUpdatedEvent } from '../src/lib/outbox.ts';
import { announceMembers } from '../src/lib/subscriptions.ts';
import { SEED_ORGS, seedDevData } from '../src/seed.ts';
import { API, addMember, getApp, registerOrg, type Ctx, asWeb } from './helpers.ts';
import { TEST_ADMIN_URL } from './testEnv.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

type Payload = { type: string; name: string; companyConfirmed?: boolean; version: number };

async function orgEvents(orgId: string) {
  const rows = await prisma.outbox.findMany({ where: { orgId, type: 'org.updated' } });
  return rows.map((r) => r.payload as Payload).sort((a, b) => a.version - b.version);
}

async function patchOrg(who: Ctx, payload: Record<string, unknown>) {
  return app.inject({ method: 'PATCH', url: `${API}/org`, headers: await asWeb(who), payload });
}

const storedOrg = (orgId: string) => prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
const getOrg = async (who: Ctx) => (await app.inject({ url: `${API}/org`, headers: who.headers })).json();
const getMe = async (who: Ctx) => (await app.inject({ url: `${API}/me`, headers: who.headers })).json();

describe('yeni firma onaysız açılır', () => {
  it('kayıt: alan null, /me ve GET /org null verir, ilk olay companyConfirmed false', async () => {
    const owner = await registerOrg(app);
    expect((await storedOrg(owner.orgId)).companyConfirmedAt).toBeNull();
    const me = await getMe(owner);
    expect(me.activeOrg).toHaveProperty('companyConfirmedAt', null);
    expect(isCompanyConfirmed(me.activeOrg)).toBe(false);
    expect(await getOrg(owner)).toHaveProperty('companyConfirmedAt', null);
    const events = await orgEvents(owner.orgId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ companyConfirmed: false, version: 1 });
  });

  it('sonradan açılan firma (POST /orgs) da onaysız açılır', async () => {
    const owner = await registerOrg(app);
    const res = await app.inject({ method: 'POST', url: `${API}/orgs`, headers: owner.headers, payload: { name: 'İkinci Firma', country: 'TR' } });
    expect(res.statusCode, res.body).toBe(201);
    const second = await prisma.organization.findFirstOrThrow({ where: { name: 'İkinci Firma', memberships: { some: { personId: owner.personId } } } });
    expect(second.companyConfirmedAt).toBeNull();
    expect((await orgEvents(second.id))[0]).toMatchObject({ companyConfirmed: false, version: 1 });
  });
});

describe('PATCH /org confirmCompany', () => {
  it('onay: an yazılır, yanıt/GET//me verir, sürüm artar, olay companyConfirmed true', async () => {
    const owner = await registerOrg(app);
    const before = Date.now();
    const res = await patchOrg(owner, { confirmCompany: true });
    expect(res.statusCode, res.body).toBe(200);
    const at = res.json().companyConfirmedAt as string;
    expect(typeof at).toBe('string');
    expect(new Date(at).getTime()).toBeGreaterThanOrEqual(before - 1000);

    const org = await storedOrg(owner.orgId);
    expect(org.companyConfirmedAt?.toISOString()).toBe(at);
    expect(org.version).toBe(2);
    expect((await getOrg(owner)).companyConfirmedAt).toBe(at);
    const me = await getMe(owner);
    expect(me.activeOrg.companyConfirmedAt).toBe(at);
    expect(isCompanyConfirmed(me.activeOrg)).toBe(true);

    const events = await orgEvents(owner.orgId);
    expect(events.map((e) => [e.version, e.companyConfirmed])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it('tekrar onay zararsız: an değişmez, sürüm artmaz, olay gitmez', async () => {
    const owner = await registerOrg(app);
    const first = (await patchOrg(owner, { confirmCompany: true })).json().companyConfirmedAt;
    const again = await patchOrg(owner, { confirmCompany: true });
    expect(again.statusCode).toBe(200);
    expect(again.json().companyConfirmedAt).toBe(first);
    expect((await storedOrg(owner.orgId)).version).toBe(2);
    expect(await orgEvents(owner.orgId)).toHaveLength(2);
  });

  it('alanlarla birlikte onay: tek olay, tek sürüm, ikisi de olayda', async () => {
    const owner = await registerOrg(app);
    const res = await patchOrg(owner, { name: 'Onaylı Ad', timeZone: 'Europe/Berlin', confirmCompany: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Onaylı Ad', timeZone: 'Europe/Berlin', companyConfirmedAt: expect.any(String) });
    const events = await orgEvents(owner.orgId);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ name: 'Onaylı Ad', timeZone: 'Europe/Berlin', companyConfirmed: true, version: 2 });
  });

  it('onaylı firmada başka alan değişince olay companyConfirmed true taşır', async () => {
    const owner = await registerOrg(app);
    await patchOrg(owner, { confirmCompany: true });
    await patchOrg(owner, { name: 'Sonra Değişen' });
    expect((await orgEvents(owner.orgId)).at(-1)).toMatchObject({ name: 'Sonra Değişen', companyConfirmed: true, version: 3 });
  });

  it('onaysız firmada başka alan değişimi onay sayılmaz', async () => {
    const owner = await registerOrg(app);
    const res = await patchOrg(owner, { name: 'Yalnız Ad' });
    expect(res.json().companyConfirmedAt).toBeNull();
    expect((await storedOrg(owner.orgId)).companyConfirmedAt).toBeNull();
    expect((await orgEvents(owner.orgId)).at(-1)).toMatchObject({ name: 'Yalnız Ad', companyConfirmed: false, version: 2 });
  });

  it.each([false, 'true', 1, null])('confirmCompany %s: 400 VALIDATION, onay ve sürüm değişmez', async (confirmCompany) => {
    const owner = await registerOrg(app);
    const res = await patchOrg(owner, { confirmCompany });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
    const org = await storedOrg(owner.orgId);
    expect(org.companyConfirmedAt).toBeNull();
    expect(org.version).toBe(1);
  });

  it('onaylı firmada confirmCompany false da 400: onay geri alınmaz', async () => {
    const owner = await registerOrg(app);
    await patchOrg(owner, { confirmCompany: true });
    expect((await patchOrg(owner, { confirmCompany: false })).statusCode).toBe(400);
    expect((await storedOrg(owner.orgId)).companyConfirmedAt).not.toBeNull();
  });

  it('yetki: üye onaylayamaz (403), yönetici onaylar', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    expect((await patchOrg(member, { confirmCompany: true })).statusCode).toBe(403);
    expect((await storedOrg(owner.orgId)).companyConfirmedAt).toBeNull();
    // Üye de /me'de onay durumunu görür (araç paneli bunu okur).
    expect((await getMe(member)).activeOrg.companyConfirmedAt).toBeNull();
    const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN' });
    expect((await patchOrg(admin, { confirmCompany: true })).statusCode).toBe(200);
    expect((await storedOrg(owner.orgId)).companyConfirmedAt).not.toBeNull();
  });

  it('denetim kaydında görünür', async () => {
    const owner = await registerOrg(app);
    await patchOrg(owner, { confirmCompany: true });
    const audit = await prisma.auditLog.findFirst({ where: { orgId: owner.orgId, action: 'org.updated' }, orderBy: { createdAt: 'desc' } });
    expect(audit?.meta).toMatchObject({ confirmCompany: true });
  });

  it('eşzamanlı onaylar tek sürüm artırır', async () => {
    const owner = await registerOrg(app);
    const results = await Promise.all([1, 2, 3].map(() => patchOrg(owner, { confirmCompany: true })));
    for (const r of results) expect(r.statusCode).toBe(200);
    expect(new Set(results.map((r) => r.json().companyConfirmedAt)).size).toBe(1);
    expect((await storedOrg(owner.orgId)).version).toBe(2);
    expect(await orgEvents(owner.orgId)).toHaveLength(2);
  });
});

describe('yeniden duyurular o anki onay değerini taşır', () => {
  it('org:announce: onaysız false, onaylı true', async () => {
    const pending = await registerOrg(app);
    const confirmed = await registerOrg(app);
    await patchOrg(confirmed, { confirmCompany: true });
    await announceAllOrgs();
    expect((await orgEvents(pending.orgId)).at(-1)).toMatchObject({ companyConfirmed: false, version: 2 });
    expect((await orgEvents(confirmed.orgId)).at(-1)).toMatchObject({ companyConfirmed: true, version: 3 });
  });

  it('members:announce: sürüm artmaz, olay o anki değeri taşır', async () => {
    const owner = await registerOrg(app);
    await patchOrg(owner, { confirmCompany: true });
    await announceMembers('deciship', { orgId: owner.orgId });
    const events = await orgEvents(owner.orgId);
    expect(events.at(-1)).toMatchObject({ companyConfirmed: true, version: 2 });
  });

  it('orgUpdatedEvent: alan her zaman boolean', () => {
    const base = { id: 'o', name: 'F', country: 'TR', currency: 'TRY' as const, timeZone: 'Europe/Istanbul', version: 3 };
    expect(orgUpdatedEvent({ ...base, companyConfirmedAt: null }, 'deciship')).toHaveProperty('companyConfirmed', false);
    expect(orgUpdatedEvent({ ...base, companyConfirmedAt: new Date() }, 'deciship')).toHaveProperty('companyConfirmed', true);
  });
});

describe('göç ve tohum', () => {
  const admin = new pg.Client({ connectionString: TEST_ADMIN_URL });
  beforeAll(async () => {
    await admin.connect();
  });
  afterAll(async () => {
    await admin.end();
  });

  it('geriye dönük doldurma: onaysız firma createdAt alır, onaylı firmanın anı değişmez (işlem geri alınır)', async () => {
    const pending = await registerOrg(app);
    const confirmed = await registerOrg(app);
    await patchOrg(confirmed, { confirmCompany: true });
    const sql = fs.readFileSync(path.resolve(import.meta.dirname, '../prisma/migrations/20261121090000_org_company_confirmed/migration.sql'), 'utf8');
    const backfill = sql.split('\n').find((l) => /^\s*UPDATE\b/i.test(l));
    expect(backfill).toBeDefined();
    // Karşılaştırma SQL'de ve metinle: `pg` saat dilimsiz TIMESTAMP'ı yerel saat sayar, Date karşılaştırması kayar.
    const read = async () => {
      const { rows } = await admin.query<{ id: string; created: string; confirmed: string | null }>(
        'SELECT "id", "createdAt"::text AS created, "companyConfirmedAt"::text AS confirmed FROM "platform"."Organization" WHERE "id" = ANY($1)',
        [[pending.orgId, confirmed.orgId]],
      );
      return Object.fromEntries(rows.map((r) => [r.id, r]));
    };
    const before = await read();
    expect(before[pending.orgId].confirmed).toBeNull();
    expect(before[confirmed.orgId].confirmed).not.toBeNull();
    await admin.query('BEGIN');
    try {
      await admin.query(backfill!);
      const after = await read();
      expect(after[pending.orgId].confirmed).toBe(after[pending.orgId].created);
      expect(after[confirmed.orgId].confirmed).toBe(before[confirmed.orgId].confirmed);
    } finally {
      await admin.query('ROLLBACK');
    }
    expect((await storedOrg(pending.orgId)).companyConfirmedAt).toBeNull();
  });

  it('demo firması onaylı açılır', async () => {
    await seedDevData();
    for (const org of Object.values(SEED_ORGS)) {
      expect((await storedOrg(org.id)).companyConfirmedAt, org.name).not.toBeNull();
    }
  });
});
