import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformEvent } from '@sellerondata/contracts';
import { registerEventReceiver, registerProductAuth, type MemberProjection } from '../src/index.ts';
import { createTestAuthority, runEpochRaceCheck, TEST_ORIGIN, type TestAuthority } from '../src/testing.ts';
import { resolveTestDbHost } from '../../../../scripts/lib/pg-guard.mjs';

/**
 * Gerçek Postgres, gerçek uygulama rolü (`sod_deciship`, süper kullanıcı değil, READ COMMITTED), gerçek FORCE RLS.
 * Sahte işlem yarışı gösteremez. Compose Postgres'i açık olmalı; kapalıysa test başarısız olur, atlanmaz.
 */
// Gerçek kullanımda (Platform/.env SOD_GERCEK_KULLANIM) gerçek verinin Postgres'ine bağlanılmaz (scripts/lib/pg-guard.mjs).
const host = resolveTestDbHost();
const SUPER_URL = process.env.TEST_SUPER_URL ?? `postgresql://postgres:sod_postgres_dev@${host}/postgres`;
/** Koşu başına ayrı: aynı anda başka koşu varsa birbirini düşürmesin. */
const DB = `authkit_test_${process.pid}_${randomUUID().slice(0, 6)}`;
const dbSuperUrl = () => {
  const u = new URL(SUPER_URL);
  u.pathname = `/${DB}`;
  return u.toString();
};

let admin: pg.Client;
let pool: pg.Pool;
let authority: TestAuthority;

const SCHEMA_SQL = `
  CREATE SCHEMA deciship;
  GRANT USAGE ON SCHEMA deciship TO sod_deciship;
  CREATE TABLE deciship."ProcessedEvent"("eventId" text primary key);
  CREATE TABLE deciship."Member"(id text primary key, "companyId" text not null, epoch int not null, active bool not null, role text);
  CREATE TABLE deciship."Company"(id text primary key, name text not null, version int not null default 0);
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA deciship TO sod_deciship;
  ALTER TABLE deciship."Member" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE deciship."Member" FORCE ROW LEVEL SECURITY;
  CREATE POLICY firma ON deciship."Member"
    USING ("companyId" = current_setting('app.company_id', true))
    WITH CHECK ("companyId" = current_setting('app.company_id', true));
`;

beforeAll(async () => {
  const su = new pg.Client({ connectionString: SUPER_URL });
  await su.connect();
  await su.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [DB]);
  await su.query(`DROP DATABASE IF EXISTS "${DB}"`);
  await su.query(`CREATE DATABASE "${DB}"`);
  await su.end();
  admin = new pg.Client({ connectionString: dbSuperUrl() });
  await admin.connect();
  await admin.query(SCHEMA_SQL);
  await admin.query(`GRANT CONNECT ON DATABASE "${DB}" TO sod_deciship`);
  const appUrl = new URL(dbSuperUrl());
  appUrl.username = 'sod_deciship';
  appUrl.password = process.env.TEST_DECISHIP_DB_PASSWORD ?? 'sod_deciship_dev';
  pool = new pg.Pool({ connectionString: appUrl.toString(), max: 20 });
  authority = await createTestAuthority();
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  const su = new pg.Client({ connectionString: SUPER_URL });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS "${DB}"`);
  await su.end();
});

// ---------- README tarifleri (bire bir aynı SQL) ----------

type Tx = pg.PoolClient;

async function transaction<R>(work: (tx: Tx) => Promise<R>): Promise<R> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await work(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

const eventContext = async (tx: Tx, event: PlatformEvent) => {
  await tx.query(`SELECT set_config('app.company_id', $1, true)`, [event.orgId]);
};
const claimEvent = async (tx: Tx, eventId: string) =>
  (await tx.query(`INSERT INTO deciship."ProcessedEvent" VALUES ($1) ON CONFLICT DO NOTHING`, [eventId])).rowCount === 1;
/** Sözleşme: FOR UPDATE. */
const memberEpoch = async (tx: Tx, mid: string) =>
  (await tx.query(`SELECT epoch FROM deciship."Member" WHERE id = $1 FOR UPDATE`, [mid])).rows[0]?.epoch ?? null;
/** Sözleşme: satır yoksa aç, varsa koşullu güncelle. Koşul FOR UPDATE'in satır yokken koruyamadığı ilk olayı da korur. */
const onEvent = async (tx: Tx, e: PlatformEvent) => {
  if (e.type !== 'member.upserted' && e.type !== 'member.removed') return;
  const active = e.type === 'member.upserted' ? e.active : false;
  const role = e.type === 'member.upserted' ? e.role : null;
  await tx.query(
    `INSERT INTO deciship."Member"(id, "companyId", epoch, active, role) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET epoch = EXCLUDED.epoch, active = EXCLUDED.active, role = EXCLUDED.role
     WHERE deciship."Member".epoch <= EXCLUDED.epoch`,
    [e.membershipId, e.orgId, e.epoch, active, role],
  );
};

async function seed(mid: string, epoch: number, active = true, orgId = 'org-a') {
  await admin.query(`INSERT INTO deciship."Member" VALUES ($1, $2, $3, $4, 'AUDITOR')`, [mid, orgId, epoch, active]);
}
async function row(mid: string): Promise<{ epoch: number; active: boolean; role: string | null } | undefined> {
  return (await admin.query(`SELECT epoch, active, role FROM deciship."Member" WHERE id = $1`, [mid])).rows[0];
}

function upserted(mid: string, epoch: number, active: boolean, orgId = 'org-a'): PlatformEvent {
  return { eventId: randomUUID(), type: 'member.upserted', orgId, product: 'deciship', membershipId: mid, personId: 'p', name: 'Ali', orgRole: 'MEMBER', role: active ? 'AUDITOR' : null, active, epoch };
}

async function receiver(extra: Record<string, unknown> = {}): Promise<FastifyInstance> {
  const app = Fastify();
  registerEventReceiver<Tx>(app, { product: 'deciship', ...authority.authOptions, transaction, eventContext, claimEvent, memberEpoch, onEvent, ...extra });
  await app.ready();
  return app;
}

const post = async (app: FastifyInstance, event: PlatformEvent) =>
  app.inject({ method: 'POST', url: '/api/deciship/internal/events', payload: { token: await authority.eventToken(event) } });

describe('B1: eşzamanlı olaylar', () => {
  it('rol değişimi ep6 ve askı ep7 aynı anda gelse de askı kaybolmaz (iki sıra, tekrarlı)', async () => {
    const app = await receiver();
    const result = await runEpochRaceCheck({
      app,
      authority,
      rounds: 60,
      orgId: 'org-a',
      seedMember: (mid, epoch) => seed(mid, epoch),
      readMember: async (mid) => (await row(mid)) as MemberProjection,
    });
    await app.close();
    expect(result).toEqual({ rounds: 60, wrong: 0 });
  });

  it('kilitsiz düz okuma tarifi yarışı kaybeder: sözleşme testi bunu yakalar', async () => {
    const naive = async (tx: Tx, e: PlatformEvent) => {
      if (e.type !== 'member.upserted') return;
      await tx.query(`UPDATE deciship."Member" SET epoch = $1, active = $2 WHERE id = $3`, [e.epoch, e.active, e.membershipId]);
    };
    const app = await receiver({
      memberEpoch: async (tx: Tx, mid: string) => (await tx.query(`SELECT epoch FROM deciship."Member" WHERE id = $1`, [mid])).rows[0]?.epoch ?? null,
      onEvent: naive,
    });
    const result = await runEpochRaceCheck({
      app,
      authority,
      rounds: 60,
      orgId: 'org-a',
      seedMember: (mid, epoch) => seed(mid, epoch),
      readMember: async (mid) => (await row(mid)) as MemberProjection,
    });
    await app.close();
    expect(result.wrong).toBeGreaterThan(0);
  });

  it('satır yokken iki ilk olay: yenisi kazanır', async () => {
    const app = await receiver();
    for (let i = 0; i < 30; i++) {
      const mid = `ilk-${randomUUID()}`;
      await Promise.all([post(app, upserted(mid, 6, true)), post(app, upserted(mid, 7, false))]);
      expect(await row(mid)).toMatchObject({ epoch: 7, active: false });
    }
    await app.close();
  });

  it('aynı eventId paralel: bir kez uygulanır', async () => {
    const applied: string[] = [];
    const app = await receiver({
      onEvent: async (tx: Tx, e: PlatformEvent) => {
        applied.push(e.eventId);
        await onEvent(tx, e);
      },
    });
    const mid = `idem-${randomUUID()}`;
    await seed(mid, 5);
    const event = upserted(mid, 6, true);
    const results = await Promise.all(Array.from({ length: 20 }, () => post(app, event)));
    await app.close();
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(results.filter((r) => r.json().outcome === 'processed')).toHaveLength(1);
    expect(applied).toHaveLength(1);
  });
});

describe('B2: FORCE RLS altında olay yolu', () => {
  it('bağlam kancasıyla askı uygulanır, eski olay stale olur', async () => {
    const app = await receiver();
    const mid = `rls-${randomUUID()}`;
    await seed(mid, 5);
    const suspended = await post(app, upserted(mid, 7, false));
    expect(suspended.json().outcome).toBe('processed');
    expect(await row(mid)).toMatchObject({ epoch: 7, active: false });

    const old = await post(app, upserted(mid, 3, true));
    expect(old.json().outcome).toBe('stale');
    expect(await row(mid)).toMatchObject({ epoch: 7, active: false });
    await app.close();
  });

  it('bağlam kancası yokken satır görünmez: kusurun kendisi (işlendi denir, iptal kaybolur)', async () => {
    const app = await receiver({ eventContext: undefined, onEvent: async (tx: Tx, e: PlatformEvent) => {
      if (e.type !== 'member.upserted') return;
      await tx.query(`UPDATE deciship."Member" SET epoch = $1, active = $2 WHERE id = $3`, [e.epoch, e.active, e.membershipId]);
    } });
    const mid = `rls-yok-${randomUUID()}`;
    await seed(mid, 5);
    const res = await post(app, upserted(mid, 7, false));
    expect(res.json().outcome).toBe('processed');
    expect(await row(mid)).toMatchObject({ epoch: 5, active: true });
    await app.close();
  });

  it('başka firmanın bağlamında satır yazılamaz: olay firması ile satır firması ayrı ise uygulanmaz', async () => {
    const app = await receiver();
    const mid = `capraz-${randomUUID()}`;
    await seed(mid, 5, true, 'org-b');
    // org-a bağlamı, org-b satırı: FORCE RLS eşleşmeyi gizler, ekleme de çakışır ve politika reddeder.
    const res = await post(app, upserted(mid, 9, false, 'org-a'));
    expect(res.statusCode).toBe(500);
    expect(await row(mid)).toMatchObject({ epoch: 5, active: true });
    await app.close();
  });
});

describe('B2: istek yolu, RLS ve tarifler', () => {
  const ctx = new AsyncLocalStorage<{ orgId: string; client: Tx }>();

  /** README tarifi: işlem açar, `SET LOCAL` yapar, kancayı o bağlamda çalıştırır. */
  const withOrgContext = <T>(orgId: string, work: () => Promise<T>): Promise<T> =>
    transaction(async (client) => {
      await client.query(`SELECT set_config('app.company_id', $1, true)`, [orgId]);
      return ctx.run({ orgId, client }, work);
    });
  const db = () => {
    const store = ctx.getStore();
    if (!store) throw new Error('bağlam yok');
    return store.client;
  };

  const select = `SELECT epoch, active FROM deciship."Member" WHERE id = $1`;

  let beforeSync: (() => Promise<void>) | null = null;
  let afterLoad: (() => Promise<void>) | null = null;

  async function product(overrides: Record<string, unknown> = {}) {
    const app = Fastify();
    registerProductAuth(app, {
      product: 'deciship',
      ...authority.authOptions,
      allowedOrigins: [TEST_ORIGIN],
      withOrgContext,
      loadMember: async (mid) => (await db().query(select, [mid])).rows[0] ?? null,
      // Sözleşme: ON CONFLICT DO NOTHING + mevcut satırı döndür.
      provisionMember: async ({ auth }) => {
        if (afterLoad) await afterLoad();
        await db().query(
          `INSERT INTO deciship."Member"(id, "companyId", epoch, active, role) VALUES ($1, $2, $3, true, $4) ON CONFLICT (id) DO NOTHING`,
          [auth.membershipId, auth.orgId, auth.epoch, auth.productRole],
        );
        return (await db().query(select, [auth.membershipId])).rows[0] as MemberProjection;
      },
      // Sözleşme: yalnız daha eski kaydı günceller, sonucu yeniden okur.
      syncMember: async ({ auth }) => {
        if (beforeSync) await beforeSync();
        await db().query(`UPDATE deciship."Member" SET epoch = $1, role = $2, active = true WHERE id = $3 AND epoch < $1`, [auth.epoch, auth.productRole, auth.membershipId]);
        return (await db().query(select, [auth.membershipId])).rows[0] as MemberProjection;
      },
      ...overrides,
    });
    app.get('/r', { onRequest: app.authenticate }, async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  it('geçerli üye loadMember bağlamıyla görülür (403 NO_PRODUCT_ACCESS değil)', async () => {
    const app = await product();
    const mid = `load-${randomUUID()}`;
    await seed(mid, 2);
    const token = await authority.accessToken({ orgId: 'org-a', membershipId: mid, epoch: 2 });
    const res = await app.inject({ url: '/r', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('bağlamsız okuma satır göremez: kusurun kendisi', async () => {
    const app = await product({
      withOrgContext: undefined,
      provisionMember: undefined,
      loadMember: async (mid: string) => (await pool.query(select, [mid])).rows[0] ?? null,
    });
    const mid = `load-yok-${randomUUID()}`;
    await seed(mid, 2);
    const token = await authority.accessToken({ orgId: 'org-a', membershipId: mid, epoch: 2 });
    const res = await app.inject({ url: '/r', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('O2 sync: araya giren ep7 askısı geri alınmaz, jeton bayat', async () => {
    const app = await product();
    const eventApp = await receiver();
    const mid = `sync-${randomUUID()}`;
    await seed(mid, 5);
    beforeSync = async () => {
      beforeSync = null;
      expect((await post(eventApp, upserted(mid, 7, false))).json().outcome).toBe('processed');
    };
    const token = await authority.accessToken({ orgId: 'org-a', membershipId: mid, epoch: 6 });
    const res = await app.inject({ url: '/r', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('TOKEN_STALE');
    expect(await row(mid)).toMatchObject({ epoch: 7, active: false });
    await eventApp.close();
    await app.close();
  });

  it('O2 JIT: araya giren member.removed geri açılmaz', async () => {
    const app = await product();
    const eventApp = await receiver();
    const mid = `jit-${randomUUID()}`;
    afterLoad = async () => {
      afterLoad = null;
      expect((await post(eventApp, upserted(mid, 7, false))).json().outcome).toBe('processed');
    };
    const token = await authority.accessToken({ orgId: 'org-a', membershipId: mid, epoch: 6 });
    const res = await app.inject({ url: '/r', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(401);
    expect(await row(mid)).toMatchObject({ epoch: 7, active: false });
    await eventApp.close();
    await app.close();
  });

  it('O2 JIT: eşzamanlı ilk istekler tek satır açar', async () => {
    const app = await product();
    const mid = `jit-es-${randomUUID()}`;
    const token = await authority.accessToken({ orgId: 'org-a', membershipId: mid, epoch: 1 });
    const results = await Promise.all(Array.from({ length: 10 }, () => app.inject({ url: '/r', headers: authority.bearer(token) })));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(await row(mid)).toMatchObject({ epoch: 1, active: true });
    await app.close();
  });
});

describe('O3: sürümlü firma olayları', () => {
  const orgEvent = (id: string, name: string, version: number): PlatformEvent =>
    ({ eventId: randomUUID(), type: 'org.updated', orgId: id, product: 'deciship', name, version });

  it('eski ad yenisini ezmez, eşzamanlı da', async () => {
    const app = await receiver({
      currentVersion: async (tx: Tx, e: PlatformEvent) =>
        (await tx.query(`SELECT version FROM deciship."Company" WHERE id = $1 FOR UPDATE`, [e.orgId])).rows[0]?.version ?? null,
      onEvent: async (tx: Tx, e: PlatformEvent) => {
        if (e.type !== 'org.updated') return;
        await tx.query(
          `INSERT INTO deciship."Company"(id, name, version) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version WHERE deciship."Company".version <= EXCLUDED.version`,
          [e.orgId, e.name, e.version ?? 0],
        );
      },
    });
    const id = `org-${randomUUID()}`;
    expect((await post(app, orgEvent(id, 'Yeni', 2))).json().outcome).toBe('processed');
    expect((await post(app, orgEvent(id, 'Eski', 1))).json().outcome).toBe('stale');
    await Promise.all([post(app, orgEvent(id, 'Üç', 3)), post(app, orgEvent(id, 'Dört', 4))]);
    const { rows } = await admin.query(`SELECT name, version FROM deciship."Company" WHERE id = $1`, [id]);
    expect(rows[0]).toEqual({ name: 'Dört', version: 4 });
    await app.close();
  });
});
