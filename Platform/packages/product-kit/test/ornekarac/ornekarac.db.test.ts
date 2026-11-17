import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestAuthority, runEpochRaceCheck, TEST_ORIGIN, type TestAuthority, type TestTokenInput } from '@sellerondata/auth-kit/testing';
import { DEFAULT_ORG_TIME_ZONE, TIME_ZONES, type HubDatasetList, type HubDatasetPage, type HubOverview, type PlatformEvent } from '@sellerondata/contracts';
import {
  isOrgClosed,
  loadMemberAccess,
  memberProjectionSql,
  memberPermissions,
  pgDb,
  readOrgProfile,
  registerProductIdentity,
  withEventScope,
  withMaintenanceScope,
  withOrg,
  zonedDate,
  type ProductIdentity,
  type SqlDb,
} from '../../src/index.ts';
import { buildOrnekApp, SETUP_HREF } from './app.ts';
import { ensureToolRoles } from './dbSetup.ts';
import { ORNEKARAC, ORNEKARAC_ADMIN_ROLE, ORNEKARAC_APP_ROLE } from './product.ts';
import { resolveTestDbHost } from '../../../../../scripts/lib/pg-guard.mjs';

/**
 * Örnek Araç uçtan uca, gerçek Postgres ile: kendi rolleri ve şeması (init.sql üreteciyle, `dbSetup.ts`), göç `sod_ornekarac_admin`,
 * uygulama `sod_ornekarac` (süper kullanıcı değil), FORCE RLS, READ COMMITTED.
 * Compose Postgres'i (5434) açık olmalı; kapalıysa test başarısız olur, atlanmaz. Veritabanı koşu başına açılır ve silinir.
 */
// Gerçek kullanımda (Platform/.env SOD_GERCEK_KULLANIM) gerçek verinin Postgres'ine bağlanılmaz (scripts/lib/pg-guard.mjs).
const host = resolveTestDbHost();
const SUPER_URL = process.env.TEST_SUPER_URL ?? `postgresql://postgres:sod_postgres_dev@${host}/postgres`;
const DB = `productkit_test_${process.pid}_${randomUUID().slice(0, 6)}`;
const dbUrl = (user?: { name: string; password: string }) => {
  const u = new URL(SUPER_URL);
  u.pathname = `/${DB}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
};

let admin: pg.Client;
let pool: pg.Pool;
let db: SqlDb;
let authority: TestAuthority;
let app: FastifyInstance;
let identity: ProductIdentity;
/** Dosya kancalarının gördüğü (test denetler); `failOnPurged` sayısı kadar `onPurged` hata atar. */
const hooks = { rows: [] as { orgId: string; table: string; rows: Record<string, unknown>[] }[], purged: [] as string[], failOnPurged: 0 };

beforeAll(async () => {
  const su = new pg.Client({ connectionString: SUPER_URL });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS "${DB}"`);
  await su.query(`CREATE DATABASE "${DB}"`);
  await su.end();
  const roles = await ensureToolRoles(SUPER_URL);
  expect([roles.admin.name, roles.app.name]).toEqual([ORNEKARAC_ADMIN_ROLE, ORNEKARAC_APP_ROLE]);
  // `admin`: süper kullanıcı (testin gözü, RLS'yi aşar). Göç, gerçek araç gibi göç rolüyle: şemayı açamaz, yalnız sahibidir.
  admin = new pg.Client({ connectionString: dbUrl() });
  await admin.connect();
  await admin.query(roles.dbSetupSql);
  const migrator = new pg.Client({ connectionString: dbUrl(roles.admin) });
  await migrator.connect();
  try {
    await migrator.query(readFileSync(new URL('./migration.sql', import.meta.url), 'utf8'));
  } finally {
    await migrator.end();
  }
  pool = new pg.Pool({ connectionString: dbUrl(roles.app), max: 20 });
  db = pgDb(pool);
  authority = await createTestAuthority();
  ({ app, identity } = await buildOrnekApp({
    db,
    ...authority.authOptions,
    allowedOrigins: [TEST_ORIGIN],
    // bakım zamanlayıcısı kapalı: parçalı silme adım adım sınanır (zamanlayıcının kendi testi aşağıda)
    purgeRetryEveryMs: 0,
    purgeHooks: {
      onRowsDeleted: async (orgId, table, rows) => {
        hooks.rows.push({ orgId, table, rows });
      },
      onPurged: async (orgId) => {
        if (hooks.failOnPurged > 0) {
          hooks.failOnPurged--;
          throw new Error('disk dolu');
        }
        hooks.purged.push(orgId);
      },
    },
  }));
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await admin?.end();
  const su = new pg.Client({ connectionString: SUPER_URL });
  await su.connect();
  await su.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [DB]);
  await su.query(`DROP DATABASE IF EXISTS "${DB}"`);
  await su.end();
});

// ---------- yardımcılar ----------

const newOrg = () => `org-${randomUUID()}`;
const token = (input: TestTokenInput = {}) => authority.accessToken({ product: 'ornekarac', role: 'ADMIN', ...input });
const call = async (method: 'GET' | 'POST', url: string, tok: string, payload?: Record<string, unknown>, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...authority.bearer(tok), ...headers }, ...(payload === undefined ? {} : { payload }) });
const postEvent = async (event: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/api/ornekarac/internal/events',
    payload: { token: await authority.eventToken({ eventId: randomUUID(), product: 'ornekarac', ...event } as unknown as PlatformEvent) },
  });
const member = async (id: string) =>
  (await admin.query(`SELECT "orgId", "personId", name, role, permissions, active, epoch, "lastSeenAt" FROM ornekarac."Member" WHERE id = $1`, [id])).rows[0];
const company = async (id: string) =>
  (await admin.query(`SELECT name, "nameVersion", currency, country FROM ornekarac."Company" WHERE id = $1`, [id])).rows[0];
const orgFields = async (id: string) =>
  (await admin.query(`SELECT "timeZone", "companyConfirmed" FROM ornekarac."Company" WHERE id = $1`, [id])).rows[0];
const purgeRecord = async (id: string) =>
  (await admin.query(`SELECT "completedAt" FROM ornekarac."CompanyPurge" WHERE "orgId" = $1`, [id])).rows[0] as { completedAt: Date | null } | undefined;
const orgRows = async (id: string) => ({
  company: (await admin.query(`SELECT count(*)::int AS n FROM ornekarac."Company" WHERE id = $1`, [id])).rows[0].n as number,
  members: (await admin.query(`SELECT count(*)::int AS n FROM ornekarac."Member" WHERE "orgId" = $1`, [id])).rows[0].n as number,
  items: (await admin.query(`SELECT count(*)::int AS n FROM ornekarac."Item" WHERE "orgId" = $1`, [id])).rows[0].n as number,
});
const waitFor = async (check: () => Promise<boolean>, ms = 10_000) => {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('waitFor: süre doldu');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
/** Olay işlemi gibi: silme kaydı + kapalı, arka plan silmesi başlamadan (parçalı silmeyi adım adım sınamak için). */
const requestPurge = async (id: string) => {
  await admin.query(`INSERT INTO ornekarac."CompanyPurge"("orgId") VALUES ($1)`, [id]);
  await admin.query(`UPDATE ornekarac."Company" SET "closedAt" = now() WHERE id = $1`, [id]);
};
const code = (res: { json: () => unknown }) => (res.json() as { error: { code: string } }).error.code;

describe('kimlik', () => {
  it('jetonla giriş: ilk istek firma ve üyeyi açar (JIT), yazma ve okuma çalışır', async () => {
    const org = newOrg();
    const mid = randomUUID();
    const t = await token({ orgId: org, orgName: 'Deneme Ltd', membershipId: mid, personId: 'p-1', name: 'Ayşe', epoch: 3 });
    const created = await call('POST', '/api/ornekarac/items', t, { title: 'İlk kayıt' });
    expect(created.statusCode).toBe(201);
    expect(await member(mid)).toMatchObject({ orgId: org, personId: 'p-1', name: 'Ayşe', role: 'ADMIN', active: true, epoch: 3 });
    expect((await member(mid)).lastSeenAt).not.toBeNull();
    expect(await company(org)).toMatchObject({ name: 'Deneme Ltd' });
    const list = await call('GET', '/api/ornekarac/items', t);
    expect(list.json()).toEqual([{ id: created.json().id, title: 'İlk kayıt' }]);
  });

  it('jetonda araç yoksa 403 NO_PRODUCT_ACCESS', async () => {
    const t = await authority.accessToken({ product: 'deciship', role: 'ADMIN', orgId: newOrg(), membershipId: randomUUID() });
    const res = await call('GET', '/api/ornekarac/items', t);
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe('NO_PRODUCT_ACCESS');
  });

  it('izinsiz yazma 403 FORBIDDEN', async () => {
    const res = await call('POST', '/api/ornekarac/items', await token({ role: 'VIEWER', orgId: newOrg(), membershipId: randomUUID() }), { title: 'x' });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe('FORBIDDEN');
  });

  it("READ_ONLY'de yazma 403 READ_ONLY, okuma açık", async () => {
    const t = await token({ status: 'READ_ONLY', orgId: newOrg(), membershipId: randomUUID() });
    const res = await call('POST', '/api/ornekarac/items', t, { title: 'x' });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe('READ_ONLY');
    expect((await call('GET', '/api/ornekarac/items', t)).statusCode).toBe(200);
  });

  it('jeton yerelden yeniyse eşitlenir; eskiyse 401 TOKEN_STALE', async () => {
    const org = newOrg();
    const mid = randomUUID();
    await call('GET', '/api/ornekarac/items', await token({ orgId: org, membershipId: mid, epoch: 2, role: 'VIEWER' }));
    const newer = await call('POST', '/api/ornekarac/items', await token({ orgId: org, membershipId: mid, epoch: 4, role: 'ADMIN', name: 'Yeni Ad' }), { title: 'x' });
    expect(newer.statusCode).toBe(201);
    expect(await member(mid)).toMatchObject({ epoch: 4, role: 'ADMIN', name: 'Yeni Ad', active: true });
    const stale = await call('GET', '/api/ornekarac/items', await token({ orgId: org, membershipId: mid, epoch: 3 }));
    expect(stale.statusCode).toBe(401);
    expect(code(stale)).toBe('TOKEN_STALE');
  });
});

describe('olaylar', () => {
  it('member.upserted ve member.removed: sıra epoch ile, ad korunur', async () => {
    const org = newOrg();
    const mid = randomUUID();
    const up = await postEvent({ type: 'member.upserted', orgId: org, membershipId: mid, personId: 'p-9', name: 'Ali', orgRole: 'MEMBER', role: 'VIEWER', active: true, epoch: 2 });
    expect(up.json()).toEqual({ ok: true, outcome: 'processed' });
    expect(await member(mid)).toMatchObject({ orgId: org, personId: 'p-9', name: 'Ali', role: 'VIEWER', active: true, epoch: 2 });

    const removed = await postEvent({ type: 'member.removed', orgId: org, membershipId: mid, epoch: 3 });
    expect(removed.json().outcome).toBe('processed');
    expect(await member(mid)).toMatchObject({ name: 'Ali', personId: 'p-9', role: null, active: false, epoch: 3 });

    const old = await postEvent({ type: 'member.upserted', orgId: org, membershipId: mid, personId: 'p-9', name: 'Ali', orgRole: 'MEMBER', role: 'ADMIN', active: true, epoch: 2 });
    expect(old.json().outcome).toBe('stale');
    expect(await member(mid)).toMatchObject({ active: false, epoch: 3 });
  });

  it('özel rol: olaydaki izin listesi katalogla kesişip yazılır; eski biçim olay ve askı null yazar', async () => {
    const org = newOrg();
    const mid = randomUUID();
    const role = 'custom:0193a1b2-0000-7000-8000-0000000000aa';
    const base = { type: 'member.upserted', orgId: org, membershipId: mid, personId: 'p-7', name: 'Ece', orgRole: 'MEMBER', active: true };
    await postEvent({ ...base, role, permissions: ['ornekarac.items.write', 'deciship.prices.view', 'ornekarac.reports.view'], epoch: 2 });
    expect(await member(mid)).toMatchObject({ role, permissions: ['ornekarac.reports.view', 'ornekarac.items.write'], epoch: 2 });
    // eski biçim olay (alan yok): rolden türet
    await postEvent({ ...base, role: 'VIEWER', epoch: 3 });
    expect(await member(mid)).toMatchObject({ role: 'VIEWER', permissions: null, epoch: 3 });
    await postEvent({ ...base, role, permissions: [], epoch: 4 });
    expect(await member(mid)).toMatchObject({ permissions: [], epoch: 4 });
    await postEvent({ type: 'member.removed', orgId: org, membershipId: mid, epoch: 5 });
    expect(await member(mid)).toMatchObject({ role: null, permissions: null, active: false });
  });

  it('özel rol jetonu: JIT ve eşitleme izin listesini yazar, eski jeton null yazar; yetki jetondaki listeden', async () => {
    const org = newOrg();
    const mid = randomUUID();
    const role = 'custom:0193a1b2-0000-7000-8000-0000000000bb';
    const viewerOnly = await token({ orgId: org, membershipId: mid, role, perms: ['ornekarac.reports.view', 'ornekarac.data.view'], epoch: 1 });
    expect((await call('POST', '/api/ornekarac/items', viewerOnly, { title: 'x' })).statusCode).toBe(403);
    expect(await member(mid)).toMatchObject({ role, permissions: ['ornekarac.reports.view', 'ornekarac.data.view'], epoch: 1 });
    const writer = await token({ orgId: org, membershipId: mid, role, perms: ['ornekarac.items.write', 'yabanci.izin'], epoch: 2 });
    expect((await call('POST', '/api/ornekarac/items', writer, { title: 'x' })).statusCode).toBe(201);
    expect(await member(mid)).toMatchObject({ permissions: ['ornekarac.items.write'], epoch: 2 });
    await call('GET', '/api/ornekarac/items', await token({ orgId: org, membershipId: mid, role: 'VIEWER', epoch: 3 }));
    expect(await member(mid)).toMatchObject({ role: 'VIEWER', permissions: null, epoch: 3 });
  });

  it('aynı olay iki kez: ikincisi duplicate', async () => {
    const event = { eventId: randomUUID(), product: 'ornekarac', type: 'org.updated', orgId: newOrg(), name: 'Bir', version: 1 } as unknown as PlatformEvent;
    const send = async () =>
      (await app.inject({ method: 'POST', url: '/api/ornekarac/internal/events', payload: { token: await authority.eventToken(event) } })).json().outcome;
    expect(await send()).toBe('processed');
    expect(await send()).toBe('duplicate');
  });

  it('org.updated: sürüm sırası, para birimi ve ülke; bozuk değer yok sayılır', async () => {
    const org = newOrg();
    expect((await postEvent({ type: 'org.updated', orgId: org, name: 'İki', version: 2, currency: 'EUR', country: 'DE' })).json().outcome).toBe('processed');
    expect(await company(org)).toEqual({ name: 'İki', nameVersion: 2, currency: 'EUR', country: 'DE' });
    expect((await postEvent({ type: 'org.updated', orgId: org, name: 'Bir', version: 1, currency: 'USD' })).json().outcome).toBe('stale');
    expect((await postEvent({ type: 'org.updated', orgId: org, name: 'Sürümsüz' })).json().outcome).toBe('processed');
    expect(await company(org)).toMatchObject({ name: 'İki' });
    await postEvent({ type: 'org.updated', orgId: org, name: 'Üç', version: 3, currency: 'XXX', country: 'tr' });
    expect(await company(org)).toEqual({ name: 'Üç', nameVersion: 3, currency: 'EUR', country: 'DE' });
    await Promise.all([postEvent({ type: 'org.updated', orgId: org, name: 'Beş', version: 5 }), postEvent({ type: 'org.updated', orgId: org, name: 'Dört', version: 4 })]);
    expect(await company(org)).toMatchObject({ name: 'Beş', nameVersion: 5 });
  });

  it('org.updated: saat dilimi ve Merkez onayı; yeni firma onaysız açılır; alan yoksa ya da bozuksa kayıtlı değer kalır', async () => {
    const org = newOrg();
    await call('GET', '/api/ornekarac/items', await token({ orgId: org, membershipId: randomUUID(), orgName: 'Saat Ltd' }));
    // JIT firmayı açtı: onay yok, saat dilimi söylenmedi (varsayılan)
    expect(await orgFields(org)).toEqual({ timeZone: null, companyConfirmed: false });
    expect(await withOrg(db, org, (tx) => readOrgProfile(tx, 'ornekarac', org))).toEqual({
      name: 'Saat Ltd',
      currency: null,
      country: null,
      timeZone: 'Europe/Istanbul',
      companyConfirmed: false,
      closed: false,
    });
    await postEvent({ type: 'org.updated', orgId: org, name: 'Saat Ltd', version: 2, currency: 'GBP', country: 'GB', timeZone: 'Europe/London', companyConfirmed: true });
    expect(await orgFields(org)).toEqual({ timeZone: 'Europe/London', companyConfirmed: true });
    // eski biçim olay (alan yok) ve bozuk değer dokunmaz
    await postEvent({ type: 'org.updated', orgId: org, name: 'Saat Ltd', version: 3 });
    await postEvent({ type: 'org.updated', orgId: org, name: 'Saat Ltd', version: 4, timeZone: 'Mars/Base', companyConfirmed: 'evet' });
    await postEvent({ type: 'org.updated', orgId: org, name: 'Saat Ltd', version: 5, timeZone: '+03:00' });
    expect(await orgFields(org)).toEqual({ timeZone: 'Europe/London', companyConfirmed: true });
    // eski sürüm yenisini ezmez; onay geri alınabilir
    expect((await postEvent({ type: 'org.updated', orgId: org, name: 'Saat Ltd', version: 1, timeZone: 'UTC', companyConfirmed: false })).json().outcome).toBe('stale');
    expect(await orgFields(org)).toEqual({ timeZone: 'Europe/London', companyConfirmed: true });
    await postEvent({ type: 'org.updated', orgId: org, name: 'Saat Ltd', version: 6, timeZone: 'Asia/Tokyo', companyConfirmed: false });
    expect(await withOrg(db, org, (tx) => readOrgProfile(tx, 'ornekarac', org))).toMatchObject({ timeZone: 'Asia/Tokyo', companyConfirmed: false, currency: 'GBP', country: 'GB' });
    // olayla açılan firma da onaysız açılır; ilk olay onay taşıyorsa yazılır
    const fresh = newOrg();
    await postEvent({ type: 'member.upserted', orgId: fresh, membershipId: randomUUID(), personId: 'p', name: 'X', orgRole: 'OWNER', role: 'ADMIN', active: true, epoch: 1 });
    expect(await orgFields(fresh)).toEqual({ timeZone: null, companyConfirmed: false });
    const announced = newOrg();
    await postEvent({ type: 'org.updated', orgId: announced, name: 'Yeni', version: 1, timeZone: 'America/New_York', companyConfirmed: false });
    expect(await orgFields(announced)).toEqual({ timeZone: 'America/New_York', companyConfirmed: false });
  });

  it('özel rol: yerel kayıttan geçerli izinler (istek dışı yetki); null rolden türer, pasif üye rolsüz', async () => {
    const org = newOrg();
    const custom = randomUUID();
    const viewer = randomUUID();
    const removed = randomUUID();
    const base = { type: 'member.upserted', orgId: org, personId: 'p', name: 'Üye', orgRole: 'MEMBER', active: true, epoch: 1 };
    await postEvent({ ...base, membershipId: custom, role: 'custom:0193a1b2-0000-7000-8000-0000000000cc', permissions: ['ornekarac.data.export', 'ornekarac.data.view'] });
    await postEvent({ ...base, membershipId: viewer, role: 'VIEWER' });
    await postEvent({ ...base, membershipId: removed, role: 'ADMIN' });
    await postEvent({ type: 'member.removed', orgId: org, membershipId: removed, epoch: 2 });
    const rows = await withOrg(db, org, (tx) => loadMemberAccess(tx, 'ornekarac', org));
    expect(rows.map((r) => r.id).sort()).toEqual([custom, viewer, removed].sort());
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(custom)).toMatchObject({ permissions: ['ornekarac.data.view', 'ornekarac.data.export'], active: true, epoch: 1 });
    expect(memberPermissions(ORNEKARAC, byId.get(custom)!)).toEqual(['ornekarac.data.view', 'ornekarac.data.export']);
    expect(byId.get(viewer)!.permissions).toBeNull();
    expect(memberPermissions(ORNEKARAC, byId.get(viewer)!)).toEqual(['ornekarac.reports.view', 'ornekarac.data.view']);
    expect(byId.get(removed)).toMatchObject({ role: null, active: false, epoch: 2 });
    expect(memberPermissions(ORNEKARAC, byId.get(removed)!)).toEqual([]);
    expect(await withOrg(db, org, (tx) => loadMemberAccess(tx, 'ornekarac', org, [viewer, 'yok']))).toEqual([expect.objectContaining({ id: viewer })]);
    expect(await withOrg(db, org, (tx) => loadMemberAccess(tx, 'ornekarac', org, []))).toEqual([]);
    // başka firmanın bağlamında görünmez
    expect(await withOrg(db, newOrg(), (tx) => loadMemberAccess(tx, 'ornekarac', org))).toEqual([]);
  });

  it('firmayı kapatma: kapalı firmada 409 ORG_CLOSED, JIT üye açmaz; sürüm sırası; geri açılınca eskisi gibi', async () => {
    const org = newOrg();
    const mid = randomUUID();
    const t = await token({ orgId: org, membershipId: mid, epoch: 1 });
    expect((await call('POST', '/api/ornekarac/items', t, { title: 'Kalır' })).statusCode).toBe(201);
    const closed = (version: number) => ({ type: 'org.closed', orgId: org, closedAt: '2026-11-13T10:00:00.000Z', purgeAfter: '2026-12-13T10:00:00.000Z', version });
    expect((await postEvent(closed(5))).json().outcome).toBe('processed');
    const closedRow = async () => (await admin.query(`SELECT "closedAt", "closedVersion" FROM ornekarac."Company" WHERE id = $1`, [org])).rows[0];
    expect(await closedRow()).toEqual({ closedAt: new Date('2026-11-13T10:00:00.000Z'), closedVersion: 5 });
    for (const [method, url] of [['GET', '/api/ornekarac/items'], ['POST', '/api/ornekarac/items']] as const) {
      const res = await call(method, url, t, method === 'POST' ? { title: 'x' } : undefined);
      expect(res.statusCode, `${method} ${url}`).toBe(409);
      expect(code(res)).toBe('ORG_CLOSED');
    }
    const lateMid = randomUUID();
    expect(code(await call('GET', '/api/ornekarac/items', await token({ orgId: org, membershipId: lateMid })))).toBe('ORG_CLOSED');
    expect(await member(lateMid)).toBeUndefined();
    expect(await withOrg(db, org, (tx) => isOrgClosed(tx, 'ornekarac', org))).toBe(true);
    // küçük sürüm bayat, eşit sürüm uygulanmaz
    expect((await postEvent({ type: 'org.reopened', orgId: org, version: 4 })).json().outcome).toBe('stale');
    expect((await postEvent({ type: 'org.reopened', orgId: org, version: 5 })).json().outcome).toBe('processed');
    expect((await closedRow()).closedVersion).toBe(5);
    expect((await closedRow()).closedAt).not.toBeNull();
    expect((await postEvent({ type: 'org.reopened', orgId: org, version: 6 })).json().outcome).toBe('processed');
    expect(await closedRow()).toEqual({ closedAt: null, closedVersion: 6 });
    expect((await postEvent(closed(6))).json().outcome).toBe('processed');
    expect((await closedRow()).closedAt).toBeNull();
    expect(await withOrg(db, org, (tx) => isOrgClosed(tx, 'ornekarac', org))).toBe(false);
    const list = await call('GET', '/api/ornekarac/items', t);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([expect.objectContaining({ title: 'Kalır' })]);
    // hiç görülmemiş firmada önce kapatma, sonra üye olayı: firma kapalı kalır
    const other = newOrg();
    await postEvent({ ...closed(2), orgId: other });
    await postEvent({ type: 'member.upserted', orgId: other, membershipId: randomUUID(), personId: 'p', name: 'Geç', orgRole: 'MEMBER', role: 'VIEWER', active: true, epoch: 1 });
    expect((await admin.query(`SELECT "closedAt" FROM ornekarac."Company" WHERE id = $1`, [other])).rows[0].closedAt).not.toBeNull();
  });

  it('org.purged: olay kaydı yazar, silme commit sonrası; aracın satırları, izdüşüm ve dosyalar gider, başka firma kalır; tekrar ve gecikmiş olay firmayı kurmaz', async () => {
    const org = newOrg();
    const keep = newOrg();
    const t = await token({ orgId: org, membershipId: randomUUID() });
    const k = await token({ orgId: keep, membershipId: randomUUID() });
    await call('POST', '/api/ornekarac/items', t, { title: 'Gider', attachment: `${org}/ek.pdf` });
    await call('POST', '/api/ornekarac/items', t, { title: 'Eksiz' });
    await call('POST', '/api/ornekarac/items', k, { title: 'Kalır', attachment: `${keep}/ek.pdf` });
    const keepBefore = await orgRows(keep);
    expect(keepBefore).toEqual({ company: 1, members: 1, items: 1 });
    expect(await orgRows(org)).toEqual({ company: 1, members: 1, items: 2 });

    const eventId = randomUUID();
    const purge = async (id = randomUUID()) =>
      app.inject({ method: 'POST', url: '/api/ornekarac/internal/events', payload: { token: await authority.eventToken({ eventId: id, product: 'ornekarac', type: 'org.purged', orgId: org } as unknown as PlatformEvent) } });
    expect((await purge(eventId)).json().outcome).toBe('processed');
    await identity.settlePurges();
    expect(await orgRows(org)).toEqual({ company: 0, members: 0, items: 0 });
    expect((await purgeRecord(org))?.completedAt).toBeInstanceOf(Date);
    // dosya kancaları: yalnız bu firmanın eki, parçanın commit'inden sonra; sonra firmanın kendisi
    expect(hooks.rows.filter((r) => r.orgId === org)).toEqual([{ orgId: org, table: 'Item', rows: expect.arrayContaining([expect.objectContaining({ attachment: `${org}/ek.pdf` }), expect.objectContaining({ attachment: null })]) }]);
    expect(hooks.rows.some((r) => r.orgId === keep)).toBe(false);
    expect(hooks.purged).toContain(org);
    expect(await orgRows(keep)).toEqual(keepBefore);
    expect((await call('GET', '/api/ornekarac/items', k)).json()).toEqual([expect.objectContaining({ title: 'Kalır' })]);

    expect((await purge(eventId)).json().outcome).toBe('duplicate');
    expect((await purge()).json().outcome).toBe('processed');
    await identity.settlePurges();
    // gecikmiş olaylar ve JIT firmayı yeniden kurmaz
    await postEvent({ type: 'member.upserted', orgId: org, membershipId: randomUUID(), personId: 'p', name: 'Geç', orgRole: 'MEMBER', role: 'VIEWER', active: true, epoch: 9 });
    await postEvent({ type: 'org.updated', orgId: org, name: 'Hayalet', version: 99 });
    await postEvent({ type: 'org.reopened', orgId: org, version: 100 });
    const jit = await call('GET', '/api/ornekarac/items', t);
    expect(jit.statusCode).toBe(409);
    expect(code(jit)).toBe('ORG_CLOSED');
    expect(await orgRows(org)).toEqual({ company: 0, members: 0, items: 0 });
    expect(await withOrg(db, org, (tx) => isOrgClosed(tx, 'ornekarac', org))).toBe(true);
  });

  it('parçalı silme: yarıda kalır, kaldığı yerden sürer; silme sürerken firma kapalı; bakım yalnız bitmemiş kaydı görür', async () => {
    const org = newOrg();
    const keep = newOrg();
    const t = await token({ orgId: org, membershipId: randomUUID() });
    for (let i = 0; i < 7; i++) await call('POST', '/api/ornekarac/items', t, { title: `k${i}` });
    await call('POST', '/api/ornekarac/items', await token({ orgId: keep, membershipId: randomUUID() }), { title: 'Kalır' });

    // silme kaydı yoksa hiçbir şey silinmez
    expect(await identity.purgeOrg(org)).toEqual({ state: 'not-requested' });
    expect(await orgRows(org)).toEqual({ company: 1, members: 1, items: 7 });

    await requestPurge(org);
    // her parça kendi işleminde: iki parça (2 + 2 satır) sonra durur
    const first = await identity.purgeOrg(org, { batchSize: 2, maxBatches: 2 });
    expect(first).toMatchObject({ state: 'in-progress', rows: { Item: 4, Member: 0, Company: 0 } });
    expect(await orgRows(org)).toEqual({ company: 1, members: 1, items: 3 });
    expect((await purgeRecord(org))?.completedAt).toBeNull();
    // silme sürerken firma kapalı: uçlar 409, arka plan işleri atlar
    expect(code(await call('GET', '/api/ornekarac/items', t))).toBe('ORG_CLOSED');
    expect(await withOrg(db, org, (tx) => isOrgClosed(tx, 'ornekarac', org))).toBe(true);
    // bakım kapsamı: firma bağlamı olmadan yalnız bitmemiş silme kaydı görünür, firma satırları görünmez
    const seen = await withMaintenanceScope(db, async (tx) => ({
      pending: (await tx.query<{ orgId: string }>(`SELECT "orgId" FROM ornekarac."CompanyPurge"`)).map((r) => r.orgId),
      items: (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ornekarac."Item"`))[0]!.n,
      companies: (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ornekarac."Company"`))[0]!.n,
    }));
    expect(seen.pending).toContain(org);
    expect(seen).toMatchObject({ items: 0, companies: 0 });

    // bakım turu kaldığı yerden sürdürür; dosya adımı bir kez düşerse kayıt bitmemiş kalır, sonraki tur tamamlar
    hooks.failOnPurged = 1;
    await identity.runPendingPurges({ batchSize: 2 });
    expect(await orgRows(org)).toEqual({ company: 0, members: 0, items: 0 });
    expect((await purgeRecord(org))?.completedAt).toBeNull();
    expect(await identity.purgeOrg(org)).toMatchObject({ state: 'completed', rows: { Item: 0, Member: 0, Company: 0 } });
    expect((await purgeRecord(org))?.completedAt).toBeInstanceOf(Date);
    expect(await withMaintenanceScope(db, (tx) => tx.query(`SELECT 1 FROM ornekarac."CompanyPurge" WHERE "orgId" = $1`, [org]))).toEqual([]);
    expect(await orgRows(keep)).toEqual({ company: 1, members: 1, items: 1 });
  });

  it('silme listesi şemadaki bütün firma tablolarını kapsar', async () => {
    expect(await identity.checkPurgeTables()).toEqual([]);
  });

  it('silme listesi denetimi: eksik tablo (yetkisiz da), engelleyen bağ (iki kat da), yetki, anahtar, sıra, cascade ile kaybolan dosya satırı; görünüm ve SET NULL sayılmaz', async () => {
    const S = 'ornekbozuk';
    const R = ORNEKARAC_APP_ROLE;
    // şablon şemayı açmaz (init.sql'in işi): burada süper kullanıcı açar
    await admin.query(`CREATE SCHEMA ${S} AUTHORIZATION ${ORNEKARAC_ADMIN_ROLE}`);
    await admin.query(memberProjectionSql({ schema: S, appRole: R }));
    await admin.query(`
      CREATE TABLE ${S}."Order" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "orgId" text NOT NULL REFERENCES ${S}."Company"("id"));
      -- orgId'siz çocuk, CASCADE yok: firma silmesini her turda yabancı anahtar hatasıyla durdurur
      CREATE TABLE ${S}."OrderNote" ("id" uuid PRIMARY KEY, "orderId" uuid NOT NULL REFERENCES ${S}."Order"("id"));
      -- orgId'siz çocuk, CASCADE: sorun değil
      CREATE TABLE ${S}."OrderTag" ("id" uuid PRIMARY KEY, "orderId" uuid NOT NULL REFERENCES ${S}."Order"("id") ON DELETE CASCADE);
      -- CASCADE ile giden çocuğa CASCADE'siz bağlı torun (iki kat): çocuk, dolayısıyla ebeveyn silinemez
      CREATE TABLE ${S}."OrderTagNote" ("id" uuid PRIMARY KEY, "tagId" uuid NOT NULL REFERENCES ${S}."OrderTag"("id"));
      -- orgId'siz çocuk, SET NULL: bağ boşalır, engellemez
      CREATE TABLE ${S}."OrderLink" ("id" uuid PRIMARY KEY, "orderId" uuid REFERENCES ${S}."Order"("id") ON DELETE SET NULL);
      -- listede değil, uygulama rolünün hiç yetkisi yok: yine görünmeli
      CREATE TABLE ${S}."Secret" ("id" uuid PRIMARY KEY, "orgId" text NOT NULL);
      CREATE VIEW ${S}."OrderView" AS SELECT "id", "orgId" FROM ${S}."Order";
      -- listede, silme yetkisi yok
      CREATE TABLE ${S}."Locked" ("id" uuid PRIMARY KEY, "orgId" text NOT NULL REFERENCES ${S}."Company"("id"));
      -- listede, varsayılan anahtar "id" yok
      CREATE TABLE ${S}."Keyless" ("code" text PRIMARY KEY, "orgId" text NOT NULL REFERENCES ${S}."Company"("id"));
      -- listede ama ebeveyninden sonra (RESTRICT): ebeveyn silinemez
      CREATE TABLE ${S}."Line" ("id" uuid PRIMARY KEY, "orgId" text NOT NULL, "orderId" uuid REFERENCES ${S}."Order"("id") ON DELETE RESTRICT);
      -- dosya yolu dönen tablo, ebeveyni önce silinince CASCADE ile gider: yollar kancaya hiç ulaşmaz
      CREATE TABLE ${S}."Doc" ("id" uuid PRIMARY KEY, "orgId" text NOT NULL, "path" text, "orderId" uuid REFERENCES ${S}."Order"("id") ON DELETE CASCADE);
      GRANT SELECT, INSERT, DELETE ON ${S}."Order", ${S}."OrderNote", ${S}."OrderTag", ${S}."Keyless", ${S}."Line", ${S}."Doc" TO ${R};
      GRANT SELECT ON ${S}."Locked", ${S}."OrderView" TO ${R};
    `);
    const broken = Fastify();
    const kit = registerProductIdentity(broken, {
      product: 'ornekarac',
      definition: ORNEKARAC,
      db,
      schema: S,
      ...authority.authOptions,
      allowedOrigins: [TEST_ORIGIN],
      purgeRetryEveryMs: 0,
      purge: {
        tables: ['Order', 'Locked', 'Keyless', 'Line', { table: 'Doc', returning: ['path', 'nope'] }, 'Ghost'],
        onRowsDeleted: async () => {},
        onPurged: async () => {},
      },
    });
    const issues = (await kit.checkPurgeTables()).map((i) => `${i.table}: ${i.issue}`).sort();
    // hak denetimi: şablon temiz başlar; toplu GRANT (products-lists.mjs reddeder) ve sütun hakkı kayması görünür
    expect(await kit.checkGrants()).toEqual([]);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${S} TO ${R}`);
    await admin.query(`REVOKE UPDATE ON ${S}."Company" FROM ${R}`);
    await admin.query(`REVOKE INSERT ON ${S}."ProcessedEvent" FROM ${R}`);
    expect((await kit.checkGrants()).map((i) => `${i.table}: ${i.issue} ${i.privilege}${i.column ? ` ${i.column}` : ''}`).sort()).toEqual(
      ['Company: missing-privilege UPDATE', 'CompanyPurge: extra-privilege DELETE', 'CompanyPurge: extra-privilege UPDATE', 'ProcessedEvent: extra-privilege UPDATE', 'ProcessedEvent: missing-privilege INSERT'].sort(),
    );
    await admin.query(`REVOKE UPDATE, DELETE ON ${S}."CompanyPurge", ${S}."ProcessedEvent" FROM ${R}`);
    await admin.query(`GRANT UPDATE ON ${S}."Company" TO ${R}; GRANT INSERT ON ${S}."ProcessedEvent" TO ${R}; GRANT DELETE ON ${S}."ProcessedEvent" TO ${R}`);
    // tablo hakkı geri alınınca sütun hakkı da gider: yalnız bitiş anı eksik kalır; başka sütuna güncelleme fazladır
    await admin.query(`GRANT UPDATE ("createdAt") ON ${S}."CompanyPurge" TO ${R}`);
    expect(await kit.checkGrants()).toEqual([
      { table: 'CompanyPurge', issue: 'extra-privilege', privilege: 'UPDATE', column: 'createdAt' },
      { table: 'CompanyPurge', issue: 'missing-privilege', privilege: 'UPDATE', column: 'completedAt' },
    ]);
    await broken.close();
    expect(issues).toEqual(
      [
        'Doc: cascade-returning',
        'Doc: missing-column',
        'Ghost: missing-table',
        'Keyless: missing-column',
        'Line: order',
        'Locked: no-delete-privilege',
        'OrderNote: blocking-reference',
        'OrderTagNote: blocking-reference',
        'Secret: not-listed',
      ].sort(),
    );
    expect(await identity.checkPurgeTables()).toEqual([]);
  });

  it('bakım zamanlayıcısı: ilk tur açılıştan kısa süre sonra; kapanış süren turu bekler', async () => {
    const org = newOrg();
    await call('POST', '/api/ornekarac/items', await token({ orgId: org, membershipId: randomUUID() }), { title: 'x' });
    await requestPurge(org);
    const gate = deferred();
    let entered = false;
    const timed = Fastify();
    registerProductIdentity(timed, {
      product: 'ornekarac',
      definition: ORNEKARAC,
      db,
      schema: 'ornekarac',
      ...authority.authOptions,
      allowedOrigins: [TEST_ORIGIN],
      purgeRetryEveryMs: 3_600_000,
      purgeFirstRunMs: 20,
      purge: {
        tables: [{ table: 'Item', returning: ['attachment'] }],
        onRowsDeleted: async () => {},
        onPurged: async () => {
          entered = true;
          await gate.promise;
        },
      },
    });
    await timed.ready();
    // saatlik aralık beklenmeden ilk tur başlar
    await waitFor(async () => entered);
    expect(await orgRows(org)).toEqual({ company: 0, members: 0, items: 0 });
    let closed = false;
    const closing = timed.close().then(() => {
      closed = true;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(closed).toBe(false);
    gate.resolve();
    await closing;
    expect((await purgeRecord(org))?.completedAt).toBeInstanceOf(Date);
  });

  it('subscription.updated işlenir, yerelde satır açmaz', async () => {
    const org = newOrg();
    expect((await postEvent({ type: 'subscription.updated', orgId: org, status: 'READ_ONLY', plan: 'early_access', version: 1 })).json().outcome).toBe('processed');
    expect(await company(org)).toBeUndefined();
  });

  it('askıdan dönüş olayı gelmese de (DEAD) askıdan sonra basılan jeton pasif üyeyi açar; eşit epoch açmaz; yeni askı yine kapatır', async () => {
    const org = newOrg();
    const mid = randomUUID();
    const upsert = (epoch: number, active: boolean) =>
      postEvent({ type: 'member.upserted', orgId: org, membershipId: mid, personId: 'p-a', name: 'Askı', orgRole: 'MEMBER', role: 'ADMIN', active, epoch });
    expect((await upsert(4, false)).json().outcome).toBe('processed');
    const same = await call('GET', '/api/ornekarac/items', await token({ orgId: org, membershipId: mid, epoch: 4 }));
    expect(same.statusCode).toBe(403);
    expect(code(same)).toBe('FORBIDDEN');
    const back = await token({ orgId: org, membershipId: mid, epoch: 5 });
    expect((await call('GET', '/api/ornekarac/items', back)).statusCode).toBe(200);
    expect(await member(mid)).toMatchObject({ active: true, epoch: 5 });
    // gecikmiş eski askı dönüşü geri almaz; yeni askı kapatır, eski jeton yenilemeye zorlanır
    expect((await upsert(4, false)).json().outcome).toBe('stale');
    expect(await member(mid)).toMatchObject({ active: true, epoch: 5 });
    expect((await upsert(6, false)).json().outcome).toBe('processed');
    const again = await call('GET', '/api/ornekarac/items', back);
    expect(again.statusCode).toBe(401);
    expect(code(again)).toBe('TOKEN_STALE');
  });

  it("çıkarma kalıcı: çıkarılmış üye JIT ya da daha büyük epoch'lu jetonla geri açılamaz", async () => {
    const org = newOrg();
    const mid = randomUUID();
    // Tanınmayan üyenin çıkarılması pasif kayıt açar.
    expect((await postEvent({ type: 'member.removed', orgId: org, membershipId: mid, epoch: 5 })).json().outcome).toBe('processed');
    expect(await member(mid)).toMatchObject({ active: false, epoch: 5 });
    const same = await call('GET', '/api/ornekarac/items', await token({ orgId: org, membershipId: mid, epoch: 5 }));
    expect(same.statusCode).toBe(403);
    expect(code(same)).toBe('FORBIDDEN');
    const newer = await call('GET', '/api/ornekarac/items', await token({ orgId: org, membershipId: mid, epoch: 9 }));
    expect(newer.statusCode).toBe(403);
    expect(await member(mid)).toMatchObject({ active: false });
  });

  it('runEpochRaceCheck: rol değişimi ve askı aynı anda, 0 hata', async () => {
    const org = newOrg();
    await admin.query(`INSERT INTO ornekarac."Company"(id) VALUES ($1)`, [org]);
    const result = await runEpochRaceCheck({
      app,
      authority,
      product: 'ornekarac',
      role: 'VIEWER',
      rounds: 60,
      orgId: org,
      seedMember: async (mid, epoch) => {
        await admin.query(`INSERT INTO ornekarac."Member"(id, "orgId", epoch, active, role) VALUES ($1, $2, $3, true, 'VIEWER')`, [mid, org, epoch]);
      },
      readMember: async (mid) => (await member(mid)) as { epoch: number; active: boolean },
    });
    expect(result).toEqual({ rounds: 60, wrong: 0 });
  });
});

describe('RLS', () => {
  it('başka firmanın satırını göremez', async () => {
    const orgA = newOrg();
    const orgB = newOrg();
    const ta = await token({ orgId: orgA, membershipId: randomUUID() });
    const tb = await token({ orgId: orgB, membershipId: randomUUID() });
    await call('POST', '/api/ornekarac/items', ta, { title: 'A kaydı' });
    await call('POST', '/api/ornekarac/items', tb, { title: 'B kaydı' });
    expect((await call('GET', '/api/ornekarac/items', ta)).json().map((r: { title: string }) => r.title)).toEqual(['A kaydı']);
    expect((await call('GET', '/api/ornekarac/items', tb)).json().map((r: { title: string }) => r.title)).toEqual(['B kaydı']);
    // Başka firmanın bağlamında yazılamaz.
    await expect(withOrg(db, orgA, (tx) => tx.query(`INSERT INTO ornekarac."Item"("orgId", title) VALUES ($1, 'sızma')`, [orgB]))).rejects.toThrow(/row-level security/);
    // Bileşik anahtar: kayıt başka firmanın üyesine bağlanamaz (üye kimliği bilinse de).
    const memberB = (await admin.query(`SELECT id FROM ornekarac."Member" WHERE "orgId" = $1`, [orgB])).rows[0].id as string;
    await expect(
      withOrg(db, orgA, (tx) => tx.query(`INSERT INTO ornekarac."Item"("orgId", title, "createdBy") VALUES ($1, 'sızma', $2)`, [orgA, memberB])),
    ).rejects.toThrow(/Item_createdBy_orgId_fkey/);
  });

  it('bağlamsız sorgu firma satırı görmez; olay kapsamı yalnız ProcessedEvent görür', async () => {
    const org = newOrg();
    await call('POST', '/api/ornekarac/items', await token({ orgId: org, membershipId: randomUUID() }), { title: 'x' });
    for (const t of ['Company', 'Member', 'Item', 'ProcessedEvent', 'CompanyPurge']) {
      expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ornekarac."${t}"`))[0]!.n).toBe(0);
    }
    const counts = await withEventScope(db, async (tx) => ({
      member: (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ornekarac."Member"`))[0]!.n,
      processed: (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ornekarac."ProcessedEvent"`))[0]!.n,
    }));
    expect(counts.member).toBe(0);
    expect(counts.processed).toBeGreaterThan(0);
    // silme hakkı yalnız kalıcı firma silmesi için (Company, Member): bağlamsız silme satır görmez; silme kaydı silinemez.
    // Olay kimliği yalnız bakımda ve yalnız süresi dolmuşsa silinir: bağlamsız da olay kapsamında da satır görünmez.
    expect(await db.query(`DELETE FROM ornekarac."Member" RETURNING "id"`)).toEqual([]);
    expect(await db.query(`DELETE FROM ornekarac."ProcessedEvent" RETURNING "eventId"`)).toEqual([]);
    expect(await withEventScope(db, (tx) => tx.query(`DELETE FROM ornekarac."ProcessedEvent" RETURNING "eventId"`))).toEqual([]);
    await expect(withEventScope(db, (tx) => tx.query(`UPDATE ornekarac."ProcessedEvent" SET "processedAt" = now()`))).rejects.toThrow(/permission denied/);
    await expect(db.query(`DELETE FROM ornekarac."CompanyPurge"`)).rejects.toThrow(/permission denied/);
    // uygulama rolünün hakları init.sql'in varsayılanları değil, şablonun verdikleri
    const privileges = (
      await admin.query<{ t: string; p: string }>(
        `SELECT table_name AS t, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p FROM information_schema.role_table_grants
         WHERE grantee = $1 AND table_schema = 'ornekarac' GROUP BY table_name ORDER BY table_name`,
        [ORNEKARAC_APP_ROLE],
      )
    ).rows;
    expect(privileges).toEqual([
      { t: 'Company', p: 'DELETE,INSERT,SELECT,UPDATE' },
      { t: 'CompanyPurge', p: 'INSERT,SELECT' },
      { t: 'Item', p: 'DELETE,INSERT,SELECT' },
      { t: 'Member', p: 'DELETE,INSERT,SELECT,UPDATE' },
      { t: 'ProcessedEvent', p: 'DELETE,INSERT,SELECT' },
    ]);
    // sütun düzeyinde ayrıca verilen tek hak: silme kaydının bitiş anı (tablo hakları her sütunda da görünür, onlar sayılmaz)
    const columnOnly = (
      await admin.query<{ t: string; c: string; p: string }>(
        `SELECT cp.table_name AS t, cp.column_name AS c, cp.privilege_type AS p FROM information_schema.column_privileges cp
         WHERE cp.grantee = $1 AND cp.table_schema = 'ornekarac'
           AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants tg WHERE tg.grantee = cp.grantee
             AND tg.table_schema = cp.table_schema AND tg.table_name = cp.table_name AND tg.privilege_type = cp.privilege_type)
         ORDER BY 1, 2, 3`,
        [ORNEKARAC_APP_ROLE],
      )
    ).rows;
    expect(columnOnly).toEqual([{ t: 'CompanyPurge', c: 'completedAt', p: 'UPDATE' }]);
    // paketin hak denetimi aynı sonuca varır
    expect(await identity.checkGrants()).toEqual([]);
  });

  it('işlenmiş olay kimlikleri: bakım yalnız 30 günü dolanı siler; olay kapsamı silemez; bakım turu da temizler', async () => {
    const day = 86_400_000;
    const ids = { old: `eski-${randomUUID()}`, fresh: `taze-${randomUUID()}` };
    await admin.query(`INSERT INTO ornekarac."ProcessedEvent"("eventId", "processedAt") VALUES ($1, now() - interval '31 days'), ($2, now() - interval '29 days')`, [
      ids.old,
      ids.fresh,
    ]);
    const has = async (id: string) => (await admin.query(`SELECT 1 FROM ornekarac."ProcessedEvent" WHERE "eventId" = $1`, [id])).rowCount === 1;
    // bakım kapsamında yalnız süresi dolmuş satır görünür
    const visible = await withMaintenanceScope(db, (tx) => tx.query<{ eventId: string }>(`SELECT "eventId" FROM ornekarac."ProcessedEvent" WHERE "eventId" = ANY($1)`, [Object.values(ids)]));
    expect(visible).toEqual([{ eventId: ids.old }]);
    // saat ileri alınsa da (kod tarafı sınır) veritabanı ilkesi 30 günden tazeyi korur
    expect(await identity.cleanupProcessedEvents(Date.now() + 365 * day)).toBeGreaterThanOrEqual(1);
    expect([await has(ids.old), await has(ids.fresh)]).toEqual([false, true]);
    // kod tarafı sınır da geçerli: süresi henüz dolmamış saydığı satıra dokunmaz
    const older = `eski-${randomUUID()}`;
    await admin.query(`INSERT INTO ornekarac."ProcessedEvent"("eventId", "processedAt") VALUES ($1, now() - interval '40 days')`, [older]);
    await identity.cleanupProcessedEvents(Date.now() - 20 * day);
    expect(await has(older)).toBe(true);
    // tekrar gelen olay hâlâ "duplicate" (taze kimlik silinmedi)
    expect(await withEventScope(db, (tx) => tx.query(`INSERT INTO ornekarac."ProcessedEvent"("eventId") VALUES ($1) ON CONFLICT DO NOTHING RETURNING "eventId"`, [ids.fresh]))).toEqual([]);

    // bakım zamanlayıcısının turu olay kimliklerini de temizler
    const timed = Fastify();
    registerProductIdentity(timed, {
      product: 'ornekarac',
      definition: ORNEKARAC,
      db,
      schema: 'ornekarac',
      ...authority.authOptions,
      allowedOrigins: [TEST_ORIGIN],
      purgeRetryEveryMs: 3_600_000,
      purgeFirstRunMs: 20,
      purge: { tables: [{ table: 'Item', returning: ['attachment'] }], onRowsDeleted: async () => {}, onPurged: async () => {} },
    });
    await timed.ready();
    try {
      await waitFor(async () => !(await has(older)));
    } finally {
      await timed.close();
    }
    expect(await has(ids.fresh)).toBe(true);
  });

  it('silme kaydı: yalnız olay kapsamında yazılır; bitiş anı bir kez yazılır, geri alınamaz', async () => {
    const org = newOrg();
    await call('GET', '/api/ornekarac/items', await token({ orgId: org, membershipId: randomUUID() }));
    // firma bağlamı tek başına yetmez: silme kaydını yalnız olay alıcısı yazar
    await expect(withOrg(db, org, (tx) => tx.query(`INSERT INTO ornekarac."CompanyPurge"("orgId") VALUES ($1)`, [org]))).rejects.toThrow(/row-level security/);
    // olay kapsamında da yalnız kendi firması
    await expect(
      withEventScope(db, async (tx) => {
        await tx.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
        await tx.query(`INSERT INTO ornekarac."CompanyPurge"("orgId") VALUES ($1)`, [newOrg()]);
      }),
    ).rejects.toThrow(/row-level security/);
    // kayıt baştan "bitti" eklenemez
    await expect(
      withEventScope(db, async (tx) => {
        await tx.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
        await tx.query(`INSERT INTO ornekarac."CompanyPurge"("orgId", "completedAt") VALUES ($1, now())`, [org]);
      }),
    ).rejects.toThrow(/row-level security/);
    await requestPurge(org);
    // bitmemiş kayıt yalnız "bitti"ye çevrilir
    await expect(withOrg(db, org, (tx) => tx.query(`UPDATE ornekarac."CompanyPurge" SET "completedAt" = NULL WHERE "orgId" = $1`, [org]))).rejects.toThrow(
      /row-level security/,
    );
    expect(await identity.purgeOrg(org)).toMatchObject({ state: 'completed' });
    const done = (await purgeRecord(org))!.completedAt;
    expect(done).toBeInstanceOf(Date);
    // bitmiş kayda dokunulamaz (satır görünmez: 0 satır)
    expect(await withOrg(db, org, (tx) => tx.query(`UPDATE ornekarac."CompanyPurge" SET "completedAt" = now() WHERE "orgId" = $1 RETURNING "orgId"`, [org]))).toEqual([]);
    expect((await purgeRecord(org))!.completedAt).toEqual(done);
  });
});

describe('Merkez uçları', () => {
  it('şekiller contracts tipleriyle uyumlu; izinler hub alanından', async () => {
    const org = newOrg();
    const adminToken = await token({ orgId: org, membershipId: randomUUID() });
    for (const title of ['b', 'a', '=SUM(1)']) await call('POST', '/api/ornekarac/items', adminToken, { title });
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const overview = (await call('GET', `/api/ornekarac/platform/overview?from=${today}&to=${tomorrow}`, adminToken)).json<HubOverview>();
    // JIT ile açılan firma Merkez onayı bekler: kurulum tamamlanmış sayılmaz
    expect(overview).toEqual({
      product: 'ornekarac',
      from: today,
      to: tomorrow,
      kpis: [{ id: 'items', label: 'Kayıt', value: 3, format: 'number' }],
      alerts: [],
      setup: {
        completed: false,
        href: SETUP_HREF,
        label: 'Örnek Araç kurulumunu tamamlayın',
        steps: [{ id: 'first-item', label: 'İlk kaydı ekleyin', done: true, href: SETUP_HREF, required: true }],
      },
    });
    const en = (await call('GET', `/api/ornekarac/platform/overview?from=${today}&to=${tomorrow}`, adminToken, undefined, { 'accept-language': 'en' })).json<HubOverview>();
    expect(en.kpis[0]!.label).toBe('Records');

    const list = (await call('GET', '/api/ornekarac/platform/datasets', adminToken)).json<HubDatasetList>();
    expect(list).toEqual({ product: 'ornekarac', datasets: [{ id: 'kayitlar', label: 'Kayıtlar', filters: [], exportable: true }] });
    const page = (await call('GET', '/api/ornekarac/platform/datasets/kayitlar', adminToken)).json<HubDatasetPage>();
    expect(page).toMatchObject({ id: 'kayitlar', page: 1, pageSize: 50, total: 3 });
    expect(page.rows.map((r) => r.cells.title)).toEqual(['b', 'a', '=SUM(1)']);
    expect((await call('GET', '/api/ornekarac/platform/datasets/yok', adminToken)).statusCode).toBe(404);

    const csv = await call('GET', '/api/ornekarac/platform/datasets/kayitlar/export', adminToken);
    expect(csv.statusCode).toBe(200);
    expect(csv.body.split('\r\n').slice(0, 4).map((l) => l.split(';')[0])).toEqual(['\uFEFFBaşlık', 'b', 'a', "'=SUM(1)"]);
    expect((await call('GET', '/api/ornekarac/platform/activity', adminToken)).json()).toEqual({ items: [], page: 1, pageSize: 25, total: 0 });

    const viewer = await token({ orgId: org, membershipId: randomUUID(), role: 'VIEWER' });
    expect((await call('GET', '/api/ornekarac/platform/datasets', viewer)).json<HubDatasetList>().datasets[0]!.exportable).toBe(false);
    const denied = await call('GET', '/api/ornekarac/platform/datasets/kayitlar/export', viewer);
    expect(denied.statusCode).toBe(403);
    expect(code(denied)).toBe('FORBIDDEN');

    // Başka firma kendi (boş) verisini görür.
    const other = await token({ orgId: newOrg(), membershipId: randomUUID() });
    expect((await call('GET', '/api/ornekarac/platform/datasets/kayitlar', other)).json<HubDatasetPage>().total).toBe(0);
  });
});

describe('Merkez uçları: firma kaydı', () => {
  it('saat dilimi ve Merkez onayı yerel firma kaydından: dönem ve dosya adı firmanın gününe göre, kurulum onayla tamamlanır', async () => {
    const org = newOrg();
    const t = await token({ orgId: org, membershipId: randomUUID() });
    await call('POST', '/api/ornekarac/items', t, { title: 'x' });
    // Günü varsayılandan (İstanbul) farklı olan bir saat dilimi seçilir: "bugün" saat dilimini gerçekten izlesin (UTC 08–15 arası
    // listede böylesi yoktur; o zaman Tokyo, sınama zayıflar ama yanlış sonuç vermez).
    const now = new Date();
    const zone = TIME_ZONES.find((z) => zonedDate(now, z) !== zonedDate(now, DEFAULT_ORG_TIME_ZONE)) ?? 'Asia/Tokyo';
    await postEvent({ type: 'org.updated', orgId: org, name: 'Firma', version: 1, timeZone: zone, companyConfirmed: false });
    const today = zonedDate(new Date(), zone);
    const before = (await call('GET', '/api/ornekarac/platform/overview', t)).json<HubOverview>();
    expect(before.to).toBe(today);
    expect(before.setup).toMatchObject({ completed: false });
    const csv = await call('GET', '/api/ornekarac/platform/datasets/kayitlar/export', t);
    expect(csv.headers['content-disposition']).toBe(`attachment; filename="ornekarac-kayitlar-${today}.csv"`);

    await postEvent({ type: 'org.updated', orgId: org, name: 'Firma', version: 2, timeZone: zone, companyConfirmed: true });
    expect((await call('GET', '/api/ornekarac/platform/overview', t)).json<HubOverview>().setup).toEqual({
      completed: true,
      href: SETUP_HREF,
      label: '',
      steps: [{ id: 'first-item', label: 'İlk kaydı ekleyin', done: true, href: SETUP_HREF, required: true }],
    });
  });
});

describe('onCompanyCreated', () => {
  it('eşzamanlı ilk istekler: firma bir kez açılır, kanca bir kez çalışır', async () => {
    const calls: string[] = [];
    const second = Fastify();
    registerProductIdentity(second, {
      product: 'ornekarac',
      definition: ORNEKARAC,
      db,
      schema: 'ornekarac',
      ...authority.authOptions,
      allowedOrigins: [TEST_ORIGIN],
      onCompanyCreated: async (tx, orgId) => {
        calls.push(orgId);
        await tx.query(`INSERT INTO ornekarac."Item"("orgId", title) VALUES ($1, 'varsayılan')`, [orgId]);
      },
    });
    second.get('/r', { onRequest: second.authenticate }, async () => ({ ok: true }));
    await second.ready();
    const org = newOrg();
    const tokens = await Promise.all(Array.from({ length: 8 }, () => token({ orgId: org, membershipId: randomUUID() })));
    const results = await Promise.all(tokens.map((t) => second.inject({ url: '/r', headers: authority.bearer(t) })));
    await second.close();
    expect(results.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
    expect(calls).toEqual([org]);
    expect((await admin.query(`SELECT count(*)::int AS n FROM ornekarac."Item" WHERE "orgId" = $1`, [org])).rows[0].n).toBe(1);
  });
});
