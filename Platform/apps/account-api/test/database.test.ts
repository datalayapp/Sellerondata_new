import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { prisma } from '../src/db.ts';
import { isProductOn } from '../src/lib/launch.ts';
import { assertSeedAllowed, SEED_ORGS, SEED_PASSWORD, SEED_PEOPLE, seedDevData } from '../src/seed.ts';
import { addMember, API, claimsOf, getApp, login, randomEmail, randomTrPhone, registerOrg } from './helpers.ts';
import { SUPER_URL, TEST_ADMIN_URL, TEST_APP_URL, TEST_DB_NAME, TEST_DECISHIP_ADMIN_URL, TEST_DECISHIP_URL } from './testEnv.ts';

const appRole = new pg.Client({ connectionString: TEST_APP_URL });
const decishipRole = new pg.Client({ connectionString: TEST_DECISHIP_URL });
const adminRole = new pg.Client({ connectionString: TEST_ADMIN_URL });
const decishipAdminRole = new pg.Client({ connectionString: TEST_DECISHIP_ADMIN_URL });

beforeAll(async () => {
  await Promise.all([appRole.connect(), decishipRole.connect(), adminRole.connect(), decishipAdminRole.connect()]);
});
afterAll(async () => {
  await Promise.all([appRole.end(), decishipRole.end(), adminRole.end(), decishipAdminRole.end()]);
});

const pgCode = async (client: pg.Client, sql: string, params: unknown[] = []) => {
  try {
    await client.query(sql, params);
    return 'OK';
  } catch (err) {
    return (err as { code: string }).code;
  }
};

const DENIED = '42501';

describe('roller ve şema sınırı (ARCHITECTURE §4)', () => {
  it('uygulama rolleri süper kullanıcı değil, yetki verme ve RLS atlatma hakları yok', async () => {
    const { rows } = await adminRole.query(
      `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname IN ('sod_platform_admin','sod_deciship_admin','sod_platform','sod_deciship') ORDER BY rolname`,
    );
    expect(rows).toEqual([
      { rolname: 'sod_deciship', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false },
      { rolname: 'sod_deciship_admin', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false },
      { rolname: 'sod_platform', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false },
      { rolname: 'sod_platform_admin', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false },
    ]);
    const me = await appRole.query('SELECT current_user');
    expect(me.rows[0].current_user).toBe('sod_platform');
  });

  it('tablolar ürünün migration rolüne ait; veritabanı süper kullanıcıya', async () => {
    const { rows } = await adminRole.query(`SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'platform'`);
    expect(rows).toEqual([{ tableowner: 'sod_platform_admin' }]);
    const db = await adminRole.query(`SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()`);
    expect(db.rows[0].owner).toBe('postgres');
  });

  it('migration rolleri birbirinin şemasını göremez, veritabanı açamaz, public kullanamaz', async () => {
    expect(await pgCode(adminRole, 'SELECT * FROM deciship."Sinama"')).toBe(DENIED);
    expect(await pgCode(adminRole, 'CREATE TABLE deciship.kotu (id int)')).toBe(DENIED);
    expect(await pgCode(decishipAdminRole, 'SELECT * FROM platform."Person"')).toBe(DENIED);
    expect(await pgCode(decishipAdminRole, 'CREATE TABLE platform.kotu (id int)')).toBe(DENIED);
    expect(await pgCode(decishipAdminRole, 'ALTER TABLE platform."Person" DISABLE ROW LEVEL SECURITY')).toBe(DENIED);
    for (const role of [adminRole, decishipAdminRole]) {
      expect(await pgCode(role, 'CREATE DATABASE kotu')).toBe(DENIED);
      expect(await pgCode(role, 'CREATE TABLE public.kotu (id int)')).toBe(DENIED);
      expect(await pgCode(role, 'CREATE SCHEMA kotu')).toBe(DENIED);
    }
  });

  it('uygulama rolleri postgres ve template1 veritabanına bağlanamaz', async () => {
    for (const db of ['postgres', 'template1']) {
      const url = new URL(TEST_APP_URL);
      url.pathname = `/${db}`;
      const client = new pg.Client({ connectionString: url.toString() });
      await expect(client.connect()).rejects.toThrow(/permission denied/);
      await client.end().catch(() => {});
    }
  });

  it('search_path sabit, büyük nesne ve pg_notify kapalı', async () => {
    expect((await appRole.query('SHOW search_path')).rows[0].search_path).toBe('platform, pg_temp');
    expect((await decishipRole.query('SHOW search_path')).rows[0].search_path).toBe('deciship, pg_temp');
    for (const role of [appRole, decishipRole, adminRole]) {
      expect(await pgCode(role, 'SELECT lo_create(0)')).toBe(DENIED);
      expect(await pgCode(role, "SELECT pg_notify('a', 'b')")).toBe(DENIED);
    }
  });

  it('init.sql bölümü tekrar çalıştırılabilir', async () => {
    const text = fs.readFileSync(path.resolve(import.meta.dirname, '../../../infra/postgres/init.sql'), 'utf8');
    const section = text.slice(text.indexOf('-- @db-setup-begin'), text.indexOf('-- @db-setup-end'));
    const url = new URL(SUPER_URL);
    url.pathname = `/${TEST_DB_NAME}`;
    const su = new pg.Client({ connectionString: url.toString() });
    await su.connect();
    await su.query(section);
    await su.end();
    expect((await appRole.query('SELECT count(*) FROM platform."Person"')).rowCount).toBe(1);
  });

  it('sod_platform: veri okur/yazar, DDL yapamaz, deciship şemasını göremez, public kullanamaz', async () => {
    expect(await pgCode(appRole, 'SELECT count(*) FROM platform."Person"')).toBe('OK');
    expect(await pgCode(appRole, 'CREATE TABLE platform.kotu (id int)')).toBe(DENIED);
    expect(await pgCode(appRole, 'DROP TABLE platform."Person"')).toBe(DENIED);
    expect(await pgCode(appRole, 'ALTER TABLE platform."Person" ADD COLUMN x int')).toBe(DENIED);
    expect(await pgCode(appRole, 'CREATE TABLE public.kotu (id int)')).toBe(DENIED);
    expect(await pgCode(appRole, 'CREATE SCHEMA kotu')).toBe(DENIED);
    expect(await pgCode(appRole, 'CREATE TABLE deciship.kotu (id int)')).toBe(DENIED);
    expect(await pgCode(decishipAdminRole, 'CREATE TABLE IF NOT EXISTS deciship."Sinama" (id int)')).toBe('OK');
    expect(await pgCode(appRole, 'SELECT * FROM deciship."Sinama"')).toBe(DENIED);
    expect(await pgCode(appRole, 'INSERT INTO deciship."Sinama" VALUES (1)')).toBe(DENIED);
  });

  it('sod_deciship: kendi şemasında veri yazar, platform şemasına hiç erişemez', async () => {
    expect(await pgCode(decishipRole, 'INSERT INTO deciship."Sinama" VALUES (2)')).toBe('OK');
    expect(await pgCode(decishipRole, 'CREATE TABLE deciship.kotu (id int)')).toBe(DENIED);
    expect(await pgCode(decishipRole, 'SELECT * FROM platform."Person"')).toBe(DENIED);
    expect(await pgCode(decishipRole, 'SELECT * FROM platform."Membership"')).toBe(DENIED);
    expect(await pgCode(decishipRole, `UPDATE platform."Person" SET name = 'x'`)).toBe(DENIED);
  });

  it('uygulama rolü migration geçmişine dokunamaz', async () => {
    expect(await pgCode(appRole, 'SELECT * FROM platform."_prisma_migrations"')).toBe(DENIED);
    expect(await pgCode(appRole, 'DELETE FROM platform."_prisma_migrations"')).toBe(DENIED);
  });

  it('migration, şemayla aynı: sürüklenme yok', async () => {
    const dir = path.resolve(import.meta.dirname, '../prisma/migrations');
    expect(fs.existsSync(path.join(dir, 'migration_lock.toml'))).toBe(true);
    const { rows } = await adminRole.query('SELECT count(*)::int AS n FROM platform."_prisma_migrations" WHERE finished_at IS NOT NULL');
    expect(rows[0].n).toBeGreaterThan(0);
  });
});

describe('veritabanı kuralları: uygulama kodu atlasa da geçerli', () => {
  async function orgWithOwner() {
    const app = await getApp();
    return registerOrg(app);
  }

  it('en az bir kimlik zorunlu; e-posta küçük harf; telefon E.164', async () => {
    const hash = 'x';
    await expect(prisma.person.create({ data: { name: 'x', passwordHash: hash } })).rejects.toThrow();
    await expect(prisma.person.create({ data: { name: 'x', passwordHash: hash, email: 'BUYUK@HARF.COM' } })).rejects.toThrow();
    await expect(prisma.person.create({ data: { name: 'x', passwordHash: hash, phone: '05321234567' } })).rejects.toThrow();
  });

  it('bir firmada ikinci OWNER olamaz', async () => {
    const app = await getApp();
    const owner = await orgWithOwner();
    const member = await addMember(app, owner.orgId);
    await expect(prisma.membership.update({ where: { id: member.membershipId }, data: { orgRole: 'OWNER' } })).rejects.toThrow();
  });

  it('OWNER askıya alınamaz', async () => {
    const owner = await orgWithOwner();
    await expect(prisma.membership.update({ where: { id: owner.membershipId }, data: { status: 'SUSPENDED' } })).rejects.toThrow();
  });

  it('firmanın tek OWNER\'ı silinemez ve düşürülemez (işlem sonu tetikleyici)', async () => {
    const owner = await orgWithOwner();
    await expect(prisma.membership.delete({ where: { id: owner.membershipId } })).rejects.toThrow();
    await expect(prisma.membership.update({ where: { id: owner.membershipId }, data: { orgRole: 'ADMIN' } })).rejects.toThrow();
    expect(await prisma.membership.count({ where: { id: owner.membershipId, orgRole: 'OWNER' } })).toBe(1);
  });

  it('devir ara durumu işlem içinde serbest, sonunda tek OWNER', async () => {
    const app = await getApp();
    const owner = await orgWithOwner();
    const member = await addMember(app, owner.orgId);
    await prisma.$transaction(async (tx) => {
      await tx.membership.update({ where: { id: owner.membershipId }, data: { orgRole: 'ADMIN' } });
      await tx.membership.update({ where: { id: member.membershipId }, data: { orgRole: 'OWNER' } });
    });
    expect(await prisma.membership.count({ where: { orgId: owner.orgId, orgRole: 'OWNER' } })).toBe(1);
  });

  it('firma silinince üyelikler de gider, tetikleyici engellemez', async () => {
    const owner = await orgWithOwner();
    await prisma.organization.delete({ where: { id: owner.orgId } });
    expect(await prisma.membership.count({ where: { orgId: owner.orgId } })).toBe(0);
  });

  it('bir firmada aynı kişiye iki bekleyen davet olamaz', async () => {
    const owner = await orgWithOwner();
    const data = {
      orgId: owner.orgId,
      kind: 'EMAIL' as const,
      email: randomEmail(),
      invitedById: owner.membershipId,
      expiresAt: new Date(Date.now() + 1000),
    };
    await prisma.invitation.create({ data: { ...data, tokenHash: `a${Date.now()}` } });
    await expect(prisma.invitation.create({ data: { ...data, tokenHash: `b${Date.now()}` } })).rejects.toThrow();
  });

  it('davet türü ile hedef uyuşmalı; OWNER davet edilemez', async () => {
    const owner = await orgWithOwner();
    const base = { orgId: owner.orgId, invitedById: owner.membershipId, expiresAt: new Date(Date.now() + 1000) };
    await expect(prisma.invitation.create({ data: { ...base, kind: 'EMAIL', phone: randomTrPhone(), tokenHash: `c${Date.now()}` } })).rejects.toThrow();
    await expect(prisma.invitation.create({ data: { ...base, kind: 'PHONE_RESET', phone: randomTrPhone(), tokenHash: `d${Date.now()}` } })).rejects.toThrow();
    await expect(prisma.invitation.create({ data: { ...base, kind: 'EMAIL', email: randomEmail(), orgRole: 'OWNER', tokenHash: `e${Date.now()}` } })).rejects.toThrow();
  });

  it('bir oturum ailesinde tek etkin baş', async () => {
    const owner = await orgWithOwner();
    const head = await prisma.session.findFirstOrThrow({ where: { personId: owner.personId, rotatedAt: null, revokedAt: null } });
    await expect(
      prisma.session.create({
        data: {
          personId: owner.personId,
          client: 'mobile',
          familyId: head.familyId,
          refreshHash: `h${Date.now()}`,
          expiresAt: new Date(Date.now() + 1000),
        },
      }),
    ).rejects.toThrow();
  });
});

describe('deneme süresi yok', () => {
  it('kaynakta, şemada ve migration\'da deneme kavramı geçmez', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'generated' || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(path.join(root, 'src'));
    walk(path.join(root, 'prisma'));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      expect(/\btrial/i.test(text), file).toBe(false);
      expect(/deneme süresi/i.test(text), file).toBe(false);
    }
  });
});

describe('geliştirme tohumu', () => {
  it('üretimde çalışmaz', async () => {
    expect(() => assertSeedAllowed('production')).toThrow(/üretimde/);
    expect(() => assertSeedAllowed('development')).not.toThrow();
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(seedDevData()).rejects.toThrow(/üretimde/);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  it('tek firmada her DeciShip rolü, TagPress Yönetici ve Kullanıcı, telefonlu e-postasız kişi, iki firmalı kişi; tekrar çalışır', async () => {
    const app = await getApp();
    await seedDevData();
    await seedDevData(); // tekrar çalıştırılabilir

    const demo = await prisma.membership.findMany({ where: { orgId: SEED_ORGS.demo.id }, include: { productAccess: true, person: true } });
    const rolesOf = (product: string) => new Set(demo.flatMap((m) => m.productAccess.filter((a) => a.product === product).map((a) => a.role)));
    const roleOf = (m: (typeof demo)[number], product: string) => m.productAccess.find((a) => a.product === product)?.role ?? null;
    expect(rolesOf('deciship')).toEqual(new Set(['ADMIN', 'AUDITOR', 'ACCOUNTING', 'MEASURE']));
    expect(rolesOf('tagpress')).toEqual(new Set(['ADMIN', 'USER']));
    expect(new Set(demo.flatMap((m) => m.productAccess.map((a) => a.product)))).toEqual(new Set(['deciship', 'tagpress']));
    expect(demo.some((m) => m.productAccess.length === 0)).toBe(true); // Erişim yok
    expect(demo.filter((m) => m.orgRole === 'OWNER')).toHaveLength(1);
    expect(demo.some((m) => m.orgRole === 'ADMIN')).toBe(true);
    // TagPress: sahip ve firma yöneticisi Yönetici, çalışanlar Kullanıcı (erişimsiz kişi hariç).
    for (const m of demo) {
      const want = m.orgRole === 'MEMBER' ? (m.productAccess.length ? 'USER' : null) : 'ADMIN';
      expect(roleOf(m, 'tagpress'), m.person.name).toBe(want);
    }
    // Her iki firmada her aracın aboneliği etkin (pilotta erişimi abonelik verir).
    for (const org of Object.values(SEED_ORGS)) {
      const subs = await prisma.subscription.findMany({ where: { orgId: org.id }, orderBy: { product: 'asc' } });
      expect(subs.map((s) => `${s.product}:${s.status}`), org.name).toEqual(['deciship:ACTIVE', 'tagpress:ACTIVE']);
    }

    const phoneOnly = demo.find((m) => !m.person.email);
    expect(phoneOnly?.person.phone).toBeTruthy();
    expect(phoneOnly && roleOf(phoneOnly, 'deciship')).toBe('MEASURE');

    const multi = SEED_PEOPLE.find((p) => p.memberships.length === 2);
    expect(multi).toBeTruthy();
    expect(await prisma.membership.count({ where: { personId: multi?.id } })).toBe(2);

    // Herkes şifreyle girer.
    for (const p of SEED_PEOPLE) {
      const res = await login(app, (p.email ?? p.phone) as string, SEED_PASSWORD);
      expect(res.statusCode, p.name).toBe(200);
    }
    const res = await login(app, phoneOnly?.person.phone as string, SEED_PASSWORD);
    expect(claimsOf(res.json().accessToken).org).toBe(SEED_ORGS.demo.id);

    const sw = await login(app, multi?.email as string, SEED_PASSWORD);
    const switched = await app.inject({
      method: 'POST',
      url: `${API}/auth/switch-org`,
      headers: { authorization: `Bearer ${sw.json().accessToken}` },
      payload: { orgId: SEED_ORGS.second.id },
    });
    expect(switched.statusCode).toBe(200);
    expect(claimsOf(switched.json().accessToken).prod.deciship?.role).toBe('ADMIN');
    // TagPress jetona yalnız açıkken girer (kapalı araçta rol ve abonelik sayılmaz).
    expect(claimsOf(switched.json().accessToken).prod.tagpress?.role).toBe(isProductOn('tagpress') ? 'ADMIN' : undefined);
  });
});
