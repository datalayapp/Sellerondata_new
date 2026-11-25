import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestAuthority, TEST_ORIGIN } from '@sellerondata/auth-kit/testing';
import { memberProjectionSql, pgDb, registerProductIdentity, type SqlDb } from '../../src/index.ts';
import { ensureToolRoles } from './dbSetup.ts';
import { ORNEKARAC, ORNEKARAC_ADMIN_ROLE, ORNEKARAC_APP_ROLE } from './product.ts';
import { resolveTestDbHost } from '../../../../../scripts/lib/pg-guard.mjs';

/**
 * `purge.orgColumn`: aracın firma tabloları `"orgId"` yerine başka sütun taşıyabilir (TagPress `org_id`). Silme koşulu ve katalog
 * denetimi o sütunla; paketin `Member` tablosu `"orgId"` ile kalır. Gerçek Postgres, Örnek Araç'ın rolleriyle, koşu başına
 * açılıp silinen veritabanında (ornekarac.db.test.ts düzeni).
 */
const host = resolveTestDbHost();
const SUPER_URL = process.env.TEST_SUPER_URL ?? `postgresql://postgres:sod_postgres_dev@${host}/postgres`;
const DB = `productkit_orgcol_${process.pid}_${randomUUID().slice(0, 6)}`;
const S = 'orgkolon';
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

beforeAll(async () => {
  const su = new pg.Client({ connectionString: SUPER_URL });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS "${DB}"`);
  await su.query(`CREATE DATABASE "${DB}"`);
  await su.end();
  const roles = await ensureToolRoles(SUPER_URL);
  admin = new pg.Client({ connectionString: dbUrl() });
  await admin.connect();
  await admin.query(roles.dbSetupSql);
  await admin.query(`CREATE SCHEMA ${S} AUTHORIZATION ${ORNEKARAC_ADMIN_ROLE}`);
  await admin.query(`GRANT USAGE ON SCHEMA ${S} TO ${ORNEKARAC_APP_ROLE}`);
  await admin.query(memberProjectionSql({ schema: S, appRole: ORNEKARAC_APP_ROLE }));
  await admin.query(`
    CREATE TABLE ${S}.batches (id text PRIMARY KEY, org_id text NOT NULL REFERENCES ${S}."Company"("id"), UNIQUE (org_id, id));
    CREATE TABLE ${S}.jobs (id text PRIMARY KEY, org_id text NOT NULL REFERENCES ${S}."Company"("id"), batch_id text NOT NULL,
      member_id text, FOREIGN KEY (org_id, batch_id) REFERENCES ${S}.batches (org_id, id) ON DELETE CASCADE,
      FOREIGN KEY (member_id, org_id) REFERENCES ${S}."Member"("id", "orgId"));
    CREATE TABLE ${S}.org_settings (org_id text NOT NULL REFERENCES ${S}."Company"("id"), key text NOT NULL, PRIMARY KEY (org_id, key));
    GRANT SELECT, INSERT, DELETE ON ${S}.batches, ${S}.jobs, ${S}.org_settings TO ${ORNEKARAC_APP_ROLE};
  `);
  pool = new pg.Pool({ connectionString: dbUrl(roles.app), max: 5 });
  db = pgDb(pool);
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  const su = new pg.Client({ connectionString: SUPER_URL });
  await su.connect();
  await su.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [DB]);
  await su.query(`DROP DATABASE IF EXISTS "${DB}"`);
  await su.end();
});

async function kit(purge: Parameters<typeof registerProductIdentity>[1]['purge']) {
  const authority = await createTestAuthority();
  const app = Fastify();
  const identity = registerProductIdentity(app, {
    product: 'ornekarac',
    definition: ORNEKARAC,
    db,
    schema: S,
    ...authority.authOptions,
    allowedOrigins: [TEST_ORIGIN],
    purgeRetryEveryMs: 0,
    ...(purge ? { purge } : {}),
  });
  return { app, identity };
}

const count = async (table: string, org: string, col = 'org_id') =>
  (await admin.query(`SELECT count(*)::int AS n FROM ${S}."${table}" WHERE "${col}" = $1`, [org])).rows[0].n as number;

async function seedOrg(org: string) {
  const member = `m-${org}`;
  await admin.query(`INSERT INTO ${S}."Company"(id, name) VALUES ($1, $1)`, [org]);
  await admin.query(`INSERT INTO ${S}."Member"(id, "orgId") VALUES ($1, $2)`, [member, org]);
  for (let i = 0; i < 3; i++) {
    await admin.query(`INSERT INTO ${S}.batches(id, org_id) VALUES ($1, $2)`, [`b${i}-${org}`, org]);
    await admin.query(`INSERT INTO ${S}.jobs(id, org_id, batch_id, member_id) VALUES ($1, $2, $3, $4)`, [`j${i}-${org}`, org, `b${i}-${org}`, member]);
    await admin.query(`INSERT INTO ${S}.org_settings(org_id, key) VALUES ($1, $2)`, [org, `k${i}`]);
  }
}

const TABLES = ['jobs', 'batches', { table: 'org_settings', key: 'key' }] as const;

describe('purge.orgColumn', () => {
  it('katalog denetimi aracın sütunuyla: liste tam ise []; varsayılan sütunla bütün tablolar eksik sütun sayılır', async () => {
    const ok = await kit({ tables: [...TABLES], orgColumn: 'org_id' });
    expect(await ok.identity.checkPurgeTables()).toEqual([]);
    await ok.app.close();
    // `orgColumn` verilmezse eski davranış: `"orgId"` aranır (ornekarac aynen çalışır), org_id'li tablolar eksik sütun.
    const legacy = await kit({ tables: [...TABLES] });
    expect((await legacy.identity.checkPurgeTables()).map((i) => `${i.table}: ${i.issue}`).sort()).toEqual(
      ['batches: missing-column', 'jobs: missing-column', 'org_settings: missing-column'].sort(),
    );
    await legacy.app.close();
  });

  it('listede olmayan tablo: aracın sütunlu da, paketin adıyla ("orgId") yazılmış da görünür; bozuk sütun adı açılışta reddedilir', async () => {
    await admin.query(`CREATE TABLE ${S}.forgotten (id text PRIMARY KEY, org_id text NOT NULL)`);
    await admin.query(`CREATE TABLE ${S}."Camel" (id text PRIMARY KEY, "orgId" text NOT NULL)`);
    try {
      const k = await kit({ tables: [...TABLES], orgColumn: 'org_id' });
      expect((await k.identity.checkPurgeTables()).map((i) => `${i.table}: ${i.issue}`).sort()).toEqual(['Camel: not-listed', 'forgotten: not-listed']);
      await k.app.close();
    } finally {
      await admin.query(`DROP TABLE ${S}.forgotten, ${S}."Camel"`);
    }
    await expect(kit({ tables: [...TABLES], orgColumn: 'org_id; DROP TABLE x' })).rejects.toThrow(/geçersiz SQL adı/);
  });

  it('silme aracın sütunuyla parça parça: A firmasının satırları, üyesi ve firma satırı gider; B aynen kalır', async () => {
    const a = `a-${randomUUID()}`;
    const b = `b-${randomUUID()}`;
    await seedOrg(a);
    await seedOrg(b);
    await admin.query(`INSERT INTO ${S}."CompanyPurge"("orgId") VALUES ($1)`, [a]);
    const k = await kit({ tables: [...TABLES], orgColumn: 'org_id', batchSize: 2 });
    const res = await k.identity.purgeOrg(a);
    await k.app.close();
    expect(res).toEqual({ state: 'completed', rows: { jobs: 3, batches: 3, org_settings: 3, Member: 1, Company: 1 } });
    for (const t of ['jobs', 'batches', 'org_settings']) {
      expect(await count(t, a), t).toBe(0);
      expect(await count(t, b), t).toBe(3);
    }
    expect(await count('Member', a, 'orgId')).toBe(0);
    expect(await count('Member', b, 'orgId')).toBe(1);
    expect((await admin.query(`SELECT id FROM ${S}."Company" ORDER BY id`)).rows.map((r) => r.id)).toEqual([b]);
  });
});
