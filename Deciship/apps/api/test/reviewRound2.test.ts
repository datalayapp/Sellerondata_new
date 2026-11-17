/**
 * Değerlendirme 2. tur bulguları. Her `describe` bulgu numarasını taşır; test önce kırmızı görüldü.
 */
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { normalizeLocale } from '@deciship/core';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, stripMoney } from '../src/app.ts';
import { env } from '../src/env.ts';
import { schemaProblems, SCHEMA_RESET_HINT } from '../src/lib/schemaCheck.ts';
import { withCompany } from '../src/db.ts';
import { createSampleMeasurement } from '../src/services/companyData.ts';
import { hubSlotsInUse, limited } from '../src/services/hub/limiter.ts';
import { registerErrorHandling } from '../src/errors.ts';
import { companyFixture, type Fixture } from './fixtures.ts';
import { getApp, getAuthority, issueIdentity, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';
import { SUPER_URL, testSuperDbUrl, TEST_DB_NAME } from './testEnv.ts';

const API = '/api/deciship';
const OVERVIEW = `${API}/platform/overview?from=2026-10-01&to=2026-10-31`;
const ANALYTICS = `${API}/platform/analytics?from=2026-10-01&to=2026-10-31&compare=1`;
const API_ROOT = path.resolve(import.meta.dirname, '..');

type Auth = { authorization: string };

let app: FastifyInstance;
let sup: pg.Client;
let server: FastifyInstance;
let port: number;

beforeAll(async () => {
  app = await getApp();
  sup = new pg.Client({ connectionString: testSuperDbUrl(), options: '-c search_path=deciship' });
  await sup.connect();
  const authority = await getAuthority();
  server = await buildApp({ identity: authority.authOptions });
  await server.listen({ port: 0, host: '127.0.0.1' });
  port = (server.server.address() as AddressInfo).port;
});
afterAll(async () => {
  await server.close();
  await sup.end();
});

const waitUntil = async (test: () => boolean, ms = 15_000) => {
  const started = Date.now();
  while (!test() && Date.now() - started < ms) await new Promise((r) => setTimeout(r, 20));
  return test();
};

const openConnections = () => new Promise<number>((resolve) => server.server.getConnections((_e, n) => resolve(n)));

/**
 * Kesilen istekler bitti mi. İstemcinin `fetch`i hemen döner, sunucu isteği daha sonra işler: tanı serisinde sayaç iptalden
 * hemen sonra 0, ardından 1-4, 200 ms içinde yine 0 ve 10 sn boyunca 0 kaldı (Linux). Yani anlık 0 "bitti" demek değil.
 * Doğru şart: istek işleyen bağlantı kalmadı ve sayaç bir süre 0 kaldı.
 * Boşta bekleyen keep-alive bağlantısı sayılmaz, her turda kapatılır: kesilmeden biten `fetch`in soketi istemci havuzunda
 * sunucunun `Keep-Alive: timeout=72` ipucuyla ~70 sn açık kalır, `getConnections` onu da sayar (0.15: CI'da hızlı biten
 * tek istek bekleme süresini doldurdu, sayaç 0'dı). İstek yazmadan kesilen soketi istemci ~4 sn'de kendisi kapatır.
 */
async function settled(orgId: string, quietMs = 500, maxMs = 20_000) {
  const started = Date.now();
  let quietSince = Date.now();
  while (Date.now() - started < maxMs) {
    server.server.closeIdleConnections();
    const open = await openConnections();
    if (open > 0 || hubSlotsInUse(orgId) > 0) quietSince = Date.now();
    else if (Date.now() - quietSince >= quietMs) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

/** Kapasitenin tamamı geri döndü mü: tek yuva kaçsa sınır kadar paralel istekten biri 429 alır. */
async function expectFullCapacity(auth: Auth, orgId: string) {
  const res = await Promise.all(Array.from({ length: env.hubConcurrencyPerOrg }, () => app.inject({ method: 'GET', url: OVERVIEW, headers: auth })));
  expect(res.map((r) => r.statusCode)).toEqual(Array(env.hubConcurrencyPerOrg).fill(200));
  expect(await waitUntil(() => hubSlotsInUse(orgId) === 0, 2000)).toBe(true);
}

/** İstek gider, kısa süre sonra soket kesilir: kimlik denetimi sırasında kopuş dahil. */
function cut(auth: Auth, url: string, delay: number) {
  return new Promise<void>((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(`GET ${url} HTTP/1.1\r\nHost: x\r\nAuthorization: ${auth.authorization}\r\nConnection: close\r\n\r\n`);
      if (delay === 0) {
        s.destroy();
        resolve();
      } else {
        setTimeout(() => {
          s.destroy();
          resolve();
        }, delay);
      }
    });
    s.on('error', () => resolve());
  });
}

const seedMeasurements = (f: Fixture, n: number) =>
  sup.query(
    `INSERT INTO "Measurement" (id, "companyId", "clientId", "trackingRaw", "trackingNo", "lengthCm", "widthCm", "heightCm", "weightKg", "dimMethod", "weightMethod", "measuredById", "measuredAt", "updatedAt")
     SELECT gen_random_uuid()::text, $1, gen_random_uuid()::text, 'K' || g, 'K' || g, 10, 10, 10, 1, 'MANUAL', 'MANUAL', $2, now() - (g || ' seconds')::interval, now() FROM generate_series(1, $3::int) g`,
    [f.companyId, f.worker.userId, n],
  );

describe('K1: yuva her koşulda geri döner', () => {
  it('0-16 ms soket kesme: firma 429a kilitlenmez, sayaç sıfıra döner', async () => {
    const f = await companyFixture(app);
    for (const delay of [0, 1, 2, 4, 8, 16]) {
      await Promise.all(Array.from({ length: 40 }, () => cut(f.admin.auth, OVERVIEW, delay)));
    }
    // Kesilen isteklerin işleyicileri sürer: sınır o kadar dolu kalır, sonra boşalır. Kalıcı 429 yok.
    expect(await settled(f.companyId), `kalan yuva ${hubSlotsInUse(f.companyId)}, bağlantı ${await openConnections()}`).toBe(true);
    await expectFullCapacity(f.admin.auth, f.companyId);
  }, 90_000);

  it('yük altında AbortController, başarılı ve hata yolu: sayaç sıfır', async () => {
    const f = await companyFixture(app);
    const url = `http://127.0.0.1:${port}${ANALYTICS}`;
    const [completed] = await Promise.all([
      // kesilmeyen istek her koşuda biter (200 ya da 429): soketi keep-alive havuzunda açık kalır
      fetch(url, { headers: f.admin.auth }).then(async (r) => (await r.text(), r.status)),
      ...Array.from({ length: 30 }, async (_, i) => {
        const ctrl = new AbortController();
        // 0-87 ms: istek sırası, kimlik denetimi ve işleyici sırasında kopuş
        setTimeout(() => ctrl.abort(), i * 3);
        await fetch(url, { headers: f.admin.auth, signal: ctrl.signal }).then((r) => r.text()).catch(() => undefined);
      }),
    ]);
    expect([200, 429]).toContain(completed);
    expect(await settled(f.companyId), `kalan yuva ${hubSlotsInUse(f.companyId)}, bağlantı ${await openConnections()}`).toBe(true);
    await expectFullCapacity(f.admin.auth, f.companyId);
    // hata yolu da yuvasını bırakır
    expect((await app.inject({ method: 'GET', url: `${API}/platform/datasets/yok`, headers: f.admin.auth })).statusCode).toBe(404);
    expect(await waitUntil(() => hubSlotsInUse(f.companyId) === 0, 2000)).toBe(true);
    expect((await app.inject({ method: 'GET', url: `${API}/platform/overview?from=x`, headers: f.admin.auth })).statusCode).toBe(400);
    expect(await waitUntil(() => hubSlotsInUse(f.companyId) === 0, 2000)).toBe(true);
    expect((await app.inject({ method: 'GET', url: `${API}/platform/datasets/invoices/export`, headers: f.admin.auth })).statusCode).toBe(200);
    expect(await waitUntil(() => hubSlotsInUse(f.companyId) === 0)).toBe(true);
  });

  describe('yuva, yanıt kapanınca ve işleyici bitince bırakılır', () => {
    const org = 'yuva-firmasi';
    let local: FastifyInstance;
    let localPort: number;
    let release: () => void;
    let gate: Promise<void>;
    const arm = () => {
      gate = new Promise((r) => (release = r));
    };
    beforeAll(async () => {
      local = Fastify();
      registerErrorHandling(local);
      local.decorateRequest('auth', null as never);
      local.addHook('onRequest', async (req) => {
        (req as unknown as { auth: { orgId: string } }).auth = { orgId: org };
        // kimlik denetimi: istemci bu sırada kopabilir
        if ((req.query as { slowAuth?: string }).slowAuth) await new Promise((r) => setTimeout(r, 60));
      });
      local.get(
        '/x',
        limited(async () => {
          await gate;
          return { ok: true };
        }),
      );
      await local.listen({ port: 0, host: '127.0.0.1' });
      localPort = (local.server.address() as AddressInfo).port;
    });
    afterAll(() => local.close());

    const send = (url: string) =>
      new Promise<net.Socket>((resolve) => {
        const s = net.connect(localPort, '127.0.0.1', () => {
          s.write(`GET ${url} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
          resolve(s);
        });
        s.on('error', () => undefined);
      });

    it('istemci koptu, işleyici sürüyor: yuva dolu kalır; bitince boşalır', async () => {
      arm();
      const s = await send('/x');
      expect(await waitUntil(() => hubSlotsInUse(org) === 1)).toBe(true);
      s.destroy();
      await new Promise((r) => setTimeout(r, 100));
      expect(hubSlotsInUse(org)).toBe(1);
      release();
      expect(await waitUntil(() => hubSlotsInUse(org) === 0)).toBe(true);
    });

    it('kimlik denetimi sırasında kopuş: kapanmış yanıtta da yuva boşalır', async () => {
      arm();
      release();
      const s = await send('/x?slowAuth=1');
      s.destroy();
      await new Promise((r) => setTimeout(r, 150));
      expect(await waitUntil(() => hubSlotsInUse(org) === 0, 2000)).toBe(true);
    });

    it('işleyici hiç bitmezse koruyucu süre yuvayı bırakır', async () => {
      const before = process.env.HUB_SLOT_MAX_MS;
      process.env.HUB_SLOT_MAX_MS = '100';
      try {
        arm();
        const s = await send('/x');
        expect(await waitUntil(() => hubSlotsInUse(org) === 1)).toBe(true);
        s.destroy();
        expect(await waitUntil(() => hubSlotsInUse(org) === 0, 2000)).toBe(true);
        release();
      } finally {
        if (before === undefined) delete process.env.HUB_SLOT_MAX_MS;
        else process.env.HUB_SLOT_MAX_MS = before;
      }
    });
  });
});

describe('O2: pahalı uçlar yuva alır', () => {
  it.each([
    ['/dashboard?month=2026-10'],
    ['/platform/datasets'],
    ['/invoices/:id/lines'],
    ['/invoices/:id/tariff-health'],
    ['/invoices/:id/report.xlsx'],
    ['/invoices/:id/report.pdf'],
  ])('%s sınırı aşınca 429, sayaç sıfıra döner', async (route) => {
    const f = await companyFixture(app);
    const url = `${API}${route.replace(':id', f.invoiceId)}`;
    const res = await Promise.all(Array.from({ length: env.hubConcurrencyPerOrg + 12 }, () => app.inject({ method: 'GET', url, headers: f.admin.auth })));
    const codes = res.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 429).length, codes.join()).toBeGreaterThan(0);
    expect(codes.filter((c) => c === 200).length).toBeGreaterThan(0);
    expect(hubSlotsInUse(f.companyId)).toBe(0);
  });

  it('sınır firma başına ve uçlar arasında ortak; başka firma etkilenmez', async () => {
    const a = await companyFixture(app);
    const b = await companyFixture(app);
    const mixed = Array.from({ length: env.hubConcurrencyPerOrg + 8 }, (_, i) =>
      app.inject({ method: 'GET', url: i % 2 ? `${API}/dashboard?month=2026-10` : OVERVIEW, headers: a.admin.auth }),
    );
    const [other, ...flood] = await Promise.all([app.inject({ method: 'GET', url: OVERVIEW, headers: b.admin.auth }), ...mixed]);
    expect(other!.statusCode).toBe(200);
    expect(flood.filter((r) => r.statusCode === 429).length).toBeGreaterThan(0);
  });
});

describe('Dışa aktarma: ayrı yuva ve boşta süresi', () => {
  it('dışa aktarmalar genel yuvaları tutmaz; kendi sınırı aşınca 429', async () => {
    const f = await companyFixture(app);
    await seedMeasurements(f, 30_000);
    const url = `http://127.0.0.1:${port}${API}/platform/datasets/measurements/export`;
    const held: AbortController[] = [];
    try {
      for (let i = 0; i < env.hubExportConcurrencyPerOrg; i++) {
        const ctrl = new AbortController();
        held.push(ctrl);
        const r = await fetch(url, { headers: f.admin.auth, signal: ctrl.signal });
        expect(r.status).toBe(200);
      }
      const over = await fetch(url, { headers: f.admin.auth });
      expect(over.status).toBe(429);
      expect((await fetch(`http://127.0.0.1:${port}${OVERVIEW}`, { headers: f.admin.auth })).status).toBe(200);
    } finally {
      for (const c of held) c.abort();
    }
    expect(await waitUntil(() => hubSlotsInUse(f.companyId) === 0)).toBe(true);
  }, 90_000);

  it('okumayan istemci boşta süresinde kesilir, yuva döner; sunucuda istek süresi sınırı var', async () => {
    const before = process.env.HUB_EXPORT_IDLE_MS;
    process.env.HUB_EXPORT_IDLE_MS = '400';
    const f = await companyFixture(app);
    await seedMeasurements(f, 90_000);
    let closed = false;
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(`GET ${API}/platform/datasets/measurements/export HTTP/1.1\r\nHost: x\r\nAuthorization: ${f.admin.auth.authorization}\r\n\r\n`);
    });
    // okuma yok: tampon dolar, sunucu yazamaz
    s.pause();
    s.on('close', () => (closed = true));
    s.on('error', () => undefined);
    try {
      expect(await waitUntil(() => hubSlotsInUse(f.companyId) === 1, 10_000)).toBe(true);
      expect(await waitUntil(() => hubSlotsInUse(f.companyId) === 0, 30_000), 'boşta süresi yuvayı bırakmadı').toBe(true);
    } finally {
      s.destroy();
      if (before === undefined) delete process.env.HUB_EXPORT_IDLE_MS;
      else process.env.HUB_EXPORT_IDLE_MS = before;
    }
    expect(closed || s.destroyed).toBe(true);
    expect((server.initialConfig as { requestTimeout?: number }).requestTimeout).toBeGreaterThan(0);
  }, 120_000);
});

describe('B1: eski şemayla açılmaz', () => {
  it('güncel şemada sorun yok', async () => {
    expect(await schemaProblems((sql) => sup.query(sql).then((r) => r.rows))).toEqual([]);
  });

  it('eski init: kısmi dizin, clientId dizini ve bileşik anahtar eksikliği ayrı ayrı söylenir; yönlendirme açık', async () => {
    const name = `${TEST_DB_NAME}_eski`;
    const admin = new pg.Client({ connectionString: SUPER_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(SUPER_URL);
    url.pathname = `/${name}`;
    const old = new pg.Client({ connectionString: url.toString() });
    await old.connect();
    try {
      await old.query(`
        CREATE SCHEMA deciship;
        CREATE TABLE deciship."Company" (id text PRIMARY KEY);
        CREATE TABLE deciship."Member" (id text PRIMARY KEY, "companyId" text NOT NULL REFERENCES deciship."Company"(id));
        CREATE TABLE deciship."Measurement" (id text PRIMARY KEY, "companyId" text NOT NULL REFERENCES deciship."Company"(id), "clientId" text, "measuredById" text REFERENCES deciship."Member"(id));
        CREATE UNIQUE INDEX "Measurement_clientId_key" ON deciship."Measurement"("clientId");`);
      const problems = await schemaProblems((sql) => old.query(sql).then((r) => r.rows));
      expect(problems.join('\n')).toContain('Measurement_current_tracking_key');
      expect(problems.join('\n')).toContain('Measurement_companyId_measuredById_clientId_key');
      expect(problems.join('\n')).toContain('Measurement_measuredById');
      expect(SCHEMA_RESET_HINT).toContain('SIFIRLA.bat');
    } finally {
      await old.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    }
  });

  const drift = (env2: Record<string, string>) =>
    spawnSync(process.execPath, ['scripts/check-drift.mjs'], { cwd: API_ROOT, env: { ...process.env, ...env2 }, encoding: 'utf8', shell: false, timeout: 60_000 });

  it('db:check-drift: bilinen fark dışında sorun yoksa 0; göç bileşik anahtarı düşürürse reddeder', async () => {
    const adminUrl = new URL(testSuperDbUrl());
    const ok = drift({ MIGRATE_DATABASE_URL: adminUrl.toString() });
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    const { dangerousMigration, unexpectedDiff } = (await import(path.join(API_ROOT, 'scripts/check-drift.mjs').replace(/\\/g, '/'))) as {
      dangerousMigration: (sql: string) => string[];
      unexpectedDiff: (sql: string) => string[];
    };
    expect(dangerousMigration('ALTER TABLE "File" DROP CONSTRAINT "File_createdById_fkey";').length).toBe(1);
    expect(dangerousMigration('ALTER TABLE "File" ADD CONSTRAINT "File_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Member"("id");').length).toBe(1);
    expect(dangerousMigration('DROP INDEX "deciship"."Measurement_current_tracking_key";').length).toBe(1);
    expect(dangerousMigration('ALTER TABLE "File" ADD CONSTRAINT "File_createdById_fkey" FOREIGN KEY ("createdById", "companyId") REFERENCES "Member"("id", "companyId");')).toEqual([]);
    expect(dangerousMigration('ALTER TABLE "File" ADD COLUMN "x" TEXT;')).toEqual([]);
    expect(unexpectedDiff('-- DropForeignKey\nALTER TABLE "File" DROP CONSTRAINT "File_createdById_fkey";\n\n-- AddForeignKey\nALTER TABLE "File" ADD CONSTRAINT "File_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Member"("id");')).toEqual([]);
    expect(unexpectedDiff('ALTER TABLE "File" ADD COLUMN "x" TEXT;').length).toBe(1);
  }, 90_000);
});

describe('O1: yeniden ölçülmüş kayıtlarla veri sıfırlama ve örnek veri', () => {
  it('sıfırlama zincirli ölçümde 500 vermez, başka firmaya dokunmaz', async () => {
    const f = await companyFixture(app);
    const other = await companyFixture(app);
    const post = async (raw: string) => {
      const p = measurementPayload({ trackingRaw: raw });
      const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...f.worker.auth, ...p.headers }, payload: p.payload });
      expect(r.statusCode, r.body).toBe(201);
    };
    const raw = uniq('ZNC');
    await post(raw);
    await post(raw);
    await post(raw);
    const reset = await app.inject({ method: 'POST', url: `${API}/settings/data/reset`, headers: f.admin.auth, payload: { confirm: true } });
    expect(reset.statusCode, reset.body).toBe(200);
    const left = await sup.query(`SELECT count(*)::int n FROM "Measurement" WHERE "companyId"=$1`, [f.companyId]);
    expect(left.rows[0].n).toBe(0);
    const kept = await sup.query(`SELECT count(*)::int n FROM "Measurement" WHERE "companyId"=$1`, [other.companyId]);
    expect(kept.rows[0].n).toBe(1);
  });

  it('örnek veride tekrar eden takip no sürüm olur', async () => {
    const f = await registerCompany(app);
    const m = { trackingRaw: uniq('ORN'), lengthCm: 1, widthCm: 1, heightCm: 1, weightKg: 1, dimMethod: 'MANUAL', weightMethod: 'MANUAL', measuredAt: '2026-10-10T10:00:00Z' };
    await withCompany(f.companyId, async () => {
      await createSampleMeasurement(f.companyId, f.userId, m as never, []);
      await createSampleMeasurement(f.companyId, f.userId, { ...m, measuredAt: '2026-10-11T10:00:00Z' } as never, []);
    });
    const r = await sup.query(`SELECT version, "supersededById" IS NULL AS live, "deletedAt" IS NULL AS alive FROM "Measurement" WHERE "companyId"=$1 ORDER BY version`, [f.companyId]);
    expect(r.rows).toEqual([{ version: 1, live: false, alive: true }, { version: 2, live: true, alive: true }]);
  });
});

describe('/measurements/check kişiye göre', () => {
  it('başkasının kaydı, view_all yok: yalnız zaman ve ad; kendi kaydı ve view_all tam', async () => {
    const f = await companyFixture(app);
    const other = await issueIdentity({ companyId: f.companyId, orgName: f.admin.orgName, role: 'MEASURE', name: 'Başka Kişi' });
    const url = `${API}/measurements/check?tracking=${f.measurement.trackingNo}`;
    const asOther = (await app.inject({ method: 'GET', url, headers: other.auth })).json();
    expect(asOther.exists).toBe(true);
    expect(Object.keys(asOther.last).sort()).toEqual(['measuredAt', 'measuredByName']);
    const own = (await app.inject({ method: 'GET', url, headers: f.worker.auth })).json();
    expect(own.last).toMatchObject({ id: f.measurement.id, lengthCm: 30, weightKg: 2 });
    const admin = (await app.inject({ method: 'GET', url, headers: f.admin.auth })).json();
    expect(admin.last).toMatchObject({ id: f.measurement.id, lengthCm: 30 });
  });
});

describe('küçük bulgular (2. tur)', () => {
  it.each([
    ['tr;q=0.1,en;q=0.9', 'en'],
    ['de-DE,en;q=0.8', 'en'],
    ['en;q=0.1,tr;q=0.9', 'tr'],
    // Kullanıcı kararı 2026-11-12: desteklenen dil yoksa İngilizce (eskiden Türkçe).
    ['fr,de;q=0.9', 'en'],
    ['en_GB', 'en'],
    ['EN-us', 'en'],
    ['en-US,en;q=0.9', 'en'],
    ['tr-TR', 'tr'],
    ['en;q=0,tr', 'tr'],
    ['', 'en'],
  ])('normalizeLocale(%s) = %s', (header, expected) => {
    expect(normalizeLocale(header)).toBe(expected);
  });

  it('doğrulama ayrıntısı isteğin dilinde', async () => {
    const f = await registerCompany(app);
    const patch = (lang: string, payload: unknown) => app.inject({ method: 'PATCH', url: `${API}/settings`, headers: { ...f.auth, 'accept-language': lang }, payload: payload as object });
    for (const payload of [{ edgeTolCm: 'x' }, { edgeTolCm: -1 }, { edgeTolCm: 1000 }, { currency: 'TOOLONG' }, { unknown: 1 }]) {
      const tr = (await patch('tr', payload)).json().error.details as { message: string }[];
      const en = (await patch('en', payload)).json().error.details as { message: string }[];
      expect(tr.length, JSON.stringify(payload)).toBeGreaterThan(0);
      for (const d of tr) expect(d.message, JSON.stringify(payload)).not.toMatch(/\b(Invalid|Too|expected|Unrecognized)\b/i);
      expect(en[0]!.message).not.toBe(tr[0]!.message);
    }
    const body = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: { ...f.auth, 'accept-language': 'tr' }, payload: {} });
    expect(body.statusCode).toBe(400);
    expect((body.json().error.details as { message: string }[])[0]!.message).not.toMatch(/Invalid|expected/i);
  });

  it('dil: başlık yoksa oturumun dili, başlık varsa başlık; hata ve Merkez aynı kural', async () => {
    const en = await registerCompany(app);
    const session = await en.token({ locale: 'en' });
    const missing = await app.inject({ method: 'GET', url: `${API}/measurements/yok`, headers: session.auth });
    expect(missing.statusCode).toBe(404);
    const enMessage = missing.json().error.message as string;
    const trMessage = (await app.inject({ method: 'GET', url: `${API}/measurements/yok`, headers: { ...session.auth, 'accept-language': 'tr' } })).json().error.message as string;
    expect(enMessage).not.toBe(trMessage);
    expect(enMessage).toMatch(/not found/i);
    const diffsLabel = async (headers: Record<string, string>) => (await app.inject({ method: 'GET', url: OVERVIEW, headers })).json().kpis.find((k: { id: string }) => k.id === 'diffs').label as string;
    expect(await diffsLabel(session.auth)).toBe(await diffsLabel({ ...session.auth, 'accept-language': 'en' }));
    expect(await diffsLabel(session.auth)).not.toBe(await diffsLabel({ ...session.auth, 'accept-language': 'tr' }));
    const bad = await app.inject({ method: 'GET', url: `${API}/platform/overview?from=x`, headers: session.auth });
    expect(bad.json().error.message).toMatch(/date/i);
    const noBody = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: session.auth, payload: { edgeTolCm: 'x' } });
    expect(noBody.json().error.message).toBe((await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: { ...en.auth, 'accept-language': 'en' }, payload: { edgeTolCm: 'x' } })).json().error.message);
  });

  it('zincir ortasındaki sürüm silinemez ve geri yüklenemez: anlaşılır 409', async () => {
    const c = await registerCompany(app, uniq('Zincir '));
    const post = async (raw?: string) => {
      const p = measurementPayload(raw ? { trackingRaw: raw } : {});
      return (await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...c.auth, ...p.headers }, payload: p.payload })).json().measurement as { id: string; trackingRaw: string };
    };
    const first = await post();
    const second = await post(first.trackingRaw);
    const del = await app.inject({ method: 'DELETE', url: `${API}/measurements/${first.id}`, headers: c.auth });
    expect(del.statusCode, del.body).toBe(409);
    expect(del.json().error.code).toBe('NOT_LATEST_VERSION');
    // eski bir kurulumda silinmiş ara sürüm kaldıysa
    await sup.query(`UPDATE "Measurement" SET "deletedAt"=now() WHERE id=$1`, [first.id]);
    const restore = await app.inject({ method: 'POST', url: `${API}/measurements/${first.id}/restore`, headers: c.auth });
    expect(restore.statusCode, restore.body).toBe(409);
    expect(restore.json().error.code).toBe('NOT_LATEST_VERSION');
    expect(restore.json().error.message.length).toBeGreaterThan(10);
    expect((await app.inject({ method: 'DELETE', url: `${API}/measurements/${second.id}`, headers: c.auth })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: `${API}/measurements/${second.id}/restore`, headers: c.auth })).statusCode).toBe(200);
  });

  it('para son güvencesi: indirim, yakıt ve döküm', () => {
    expect(stripMoney({ discountPct: 1, fuelPct: 2, breakdown: [{ label: 'x' }], keep: 3 })).toEqual({ keep: 3 });
  });
});

describe('kapanış küçükleri', () => {
  it('eski hacim mesajı veriyi korumayı önce söyler', () => {
    expect(SCHEMA_RESET_HINT).toMatch(/Veri varsa önce yedek alın/);
    expect(SCHEMA_RESET_HINT).toMatch(/ileri migration/);
    expect(SCHEMA_RESET_HINT).toMatch(/yalnız demo veriyse SIFIRLA\.bat/);
  });

  it('check-drift: IF EXISTS ve küçük harf de yakalanır', async () => {
    const { dangerousMigration } = (await import(path.join(API_ROOT, 'scripts/check-drift.mjs').replace(/\\/g, '/'))) as { dangerousMigration: (sql: string) => string[] };
    expect(dangerousMigration('ALTER TABLE "File" DROP CONSTRAINT IF EXISTS "File_createdById_fkey";').length).toBe(1);
    expect(dangerousMigration('alter table "File" drop constraint "File_createdById_fkey";').length).toBe(1);
    expect(dangerousMigration('DROP INDEX IF EXISTS "deciship"."Measurement_current_tracking_key";').length).toBe(1);
  });

  it('EN tekil: 1 character; çoğul: 3 characters', async () => {
    const f = await registerCompany(app);
    const details = async (payload: object) => (await app.inject({ method: 'POST', url: `${API}/carriers`, headers: { ...f.auth, 'accept-language': 'en' }, payload })).json().error.details as { path: string; message: string }[];
    const short = await details({ code: '', name: 'x' });
    expect(short.map((d) => d.message).join()).not.toMatch(/\b1 characters/);
    const { MESSAGES } = await import('../src/i18n/messages.ts');
    expect(MESSAGES['v.tooShortOne'].en).toBe('Must be at least 1 character');
    expect(MESSAGES['v.tooLongOne'].en).toBe('Must be at most 1 character');
  });

  it.each(['/measurements', '/invoices', '/invoices/:id'])('%s: firma başına genel sınır 20, başka firma etkilenmez', async (route) => {
    const a = await companyFixture(app);
    const b = await companyFixture(app);
    const url = `${API}${route.replace(':id', a.invoiceId)}`;
    const res = await Promise.all(Array.from({ length: 60 }, () => app.inject({ method: 'GET', url, headers: a.admin.auth })));
    const codes = res.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 429).length, codes.join()).toBeGreaterThan(0);
    expect(codes.filter((c) => c === 200).length).toBeGreaterThanOrEqual(20);
    const busy = res.find((r) => r.statusCode === 429)!;
    expect(busy.headers['retry-after']).toBeDefined();
    expect(busy.json().error.message).not.toMatch(/rapor/i);
    expect(hubSlotsInUse(a.companyId)).toBe(0);
    expect((await app.inject({ method: 'GET', url: `${API}${route.replace(':id', b.invoiceId)}`, headers: b.admin.auth })).statusCode).toBe(200);
  });
});

describe('rapor: sayılar kendi içinde mutabık', () => {
  async function setup() {
    const f = await companyFixture(app);
    const t = (no: string, net: number) => `${no};5;${net}`;
    const trackings = [uniq('RAP'), uniq('RAP'), uniq('RAP')];
    for (const tr of trackings) {
      const p = measurementPayload({ trackingRaw: tr, lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
      const res = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...f.admin.auth, ...p.headers }, payload: p.payload });
      expect(res.statusCode, res.body).toBe(201);
    }
    const csv = ['Takip No;Desi;Tutar', t(trackings[0]!, 500), t(trackings[1]!, 700), t(trackings[2]!, 900)].join('\n');
    const form = multipart([{ name: 'carrierId', value: f.carrierId }, { name: 'file', filename: 'r.csv', contentType: 'text/csv', data: Buffer.from(csv) }]);
    const preview = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...f.admin.auth, ...form.headers }, payload: form.payload });
    const inv = await app.inject({ method: 'POST', url: `${API}/invoices`, headers: f.admin.auth, payload: { fileId: preview.json().fileId, carrierId: f.carrierId, invoiceNo: uniq('RAP'), invoiceDate: '2026-10-15', currency: 'TRY', mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' }, acknowledgeIssues: true } });
    expect(inv.statusCode, inv.body).toBe(201);
    const id = inv.json().invoice.id as string;
    const lines = (await app.inject({ method: 'GET', url: `${API}/invoices/${id}/lines?pageSize=50`, headers: f.admin.auth })).json().items as { id: string; status: string; diffAmount: number }[];
    const diffs = lines.filter((l) => l.status === 'DIFF');
    expect(diffs.length).toBeGreaterThanOrEqual(2);
    const accept = await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${diffs[0]!.id}`, headers: f.admin.auth, payload: { decision: 'ACCEPTED', reason: 'kabul edildi' } });
    expect(accept.statusCode, accept.body).toBe(200);
    const totals = (await app.inject({ method: 'GET', url: `${API}/invoices/${id}`, headers: f.admin.auth })).json().invoice.totals as { overchargeTotal: number };
    return { f, id, diffs, accepted: diffs[0]!, totals };
  }

  const pdfText = async (buf: Buffer) => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, verbosity: 0 }).promise;
    let out = '';
    for (let i = 1; i <= doc.numPages; i++) out += (await (await doc.getPage(i)).getTextContent()).items.map((x) => ('str' in x ? x.str : '')).join(' ') + ' ';
    return out;
  };

  it('Excel: satır 1 den, karar yalnız farkta, TR tarih; özet Fark sütunuyla tutar', async () => {
    const { f, id, diffs, accepted, totals } = await setup();
    const r = await app.inject({ method: 'GET', url: `${API}/invoices/${id}/report.xlsx`, headers: f.admin.auth });
    expect(r.statusCode).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.rawPayload as never);
    const all = wb.getWorksheet('Tüm satırlar')!;
    const head = (all.getRow(1).values as unknown[]);
    const col = (name: string) => head.indexOf(name);
    expect(all.getRow(2).getCell(col('Satır')).value).toBe(1);
    const rows = Array.from({ length: all.rowCount - 1 }, (_, i) => all.getRow(i + 2));
    for (const row of rows) {
      const status = row.getCell(col('Durum')).value;
      if (status !== 'Fark var') expect(row.getCell(col('Karar')).value).toBe('—');
    }
    const sum = wb.getWorksheet('Özet')!;
    const cells = new Map<string, unknown>();
    sum.eachRow((row) => cells.set(String(row.getCell(1).value), row.getCell(2).value));
    expect(cells.get('Fatura tarihi')).toBe('15.10.2026');
    expect(cells.has('İtiraz listesinde')).toBe(true);
    expect([...cells.keys()].filter((k) => /Doğrula/.test(k))).toEqual([]);
    const total = diffs.reduce((n, l) => n + l.diffAmount, 0);
    expect(cells.get('Fazla ödeme')).toBe(totals.overchargeTotal);
    expect(cells.get('Uyumlu sayılan fark')).toBe(accepted.diffAmount);
    expect(cells.get('Fark sütunu toplamı')).toBe(Number(total.toFixed(2)));
    // KARARLAR "İncele" (2026-11-10): "Tahmini" sınıfının adı "İncele" oldu; Özet satırı artık "İncelenecek fark".
    // parçalar toplamı tutar: Fazla ödeme + İncelenecek + Uyumlu sayılan + Lehe = Fark sütunu
    expect(cells.has('Tahmini fark')).toBe(false);
    const part = (k: string) => (cells.get(k) as number | undefined) ?? 0;
    expect(Number((part('Fazla ödeme') + part('İncelenecek fark') + part('Uyumlu sayılan fark') + part('Lehe fark')).toFixed(2))).toBe(cells.get('Fark sütunu toplamı'));
  });

  it('PDF: Karar sütunu, Uyumlu sayılan ayrı satır, Fark toplamı', async () => {
    const { f, id, diffs, accepted, totals } = await setup();
    const r = await app.inject({ method: 'GET', url: `${API}/invoices/${id}/report.pdf`, headers: f.admin.auth });
    expect(r.statusCode).toBe(200);
    const text = await pdfText(r.rawPayload);
    const { fmtMoney } = await import('@deciship/core');
    expect(text).toContain('Karar');
    expect(text).toContain('Uyumlu sayıldı');
    expect(text).toContain('Uyumlu sayılan fark');
    expect(text).toContain('İtiraz listesinde');
    expect(text).not.toMatch(/Doğrula/);
    expect(text).toContain('Fark sütunu toplamı');
    expect(text).toContain(fmtMoney(accepted.diffAmount, 'TRY', 'tr'));
    expect(text).toContain(fmtMoney(totals.overchargeTotal, 'TRY', 'tr'));
    expect(text).toContain(fmtMoney(diffs.reduce((n, l) => n + l.diffAmount, 0), 'TRY', 'tr'));
    expect(text).toContain('15.10.2026');
  });
});

describe('hata metni alanı ve sınırı söyler', () => {
  it('doğrulama: alan adı ve sınır', async () => {
    const f = await registerCompany(app);
    const p = measurementPayload({ trackingRaw: 'x'.repeat(201) });
    const tr = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...f.auth, ...p.headers }, payload: p.payload });
    expect(tr.statusCode).toBe(400);
    expect(tr.json().error.message).toBe('Takip no: En çok 200 karakter olabilir');
    const en = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...f.auth, ...p.headers, 'accept-language': 'en' }, payload: p.payload });
    expect(en.json().error.message).toBe('Tracking number: Must be at most 200 characters');
    // Üst sınır 100 → 10 (2026-11-10): tolerans artık ölçümün her kenarına eklenen pay, büyük değer gerçek farkı gizler.
    const num = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: f.auth, payload: { edgeTolCm: 1000 } });
    expect(num.json().error.message).toBe('Kenar toleransı: En çok 10 olabilir');
  });

  it('veritabanı sınırı: sütun biliniyorsa alanı söyler', async () => {
    const { Prisma } = await import('../src/db.ts');
    const local = Fastify();
    registerErrorHandling(local);
    local.get('/x', async () => {
      throw new Prisma.PrismaClientKnownRequestError('too long', { code: 'P2000', clientVersion: 'x', meta: { column_name: 'note' } });
    });
    const r = await local.inject({ method: 'GET', url: '/x' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('VALUE_OUT_OF_RANGE');
    expect(r.json().error.message).toContain('Not');
    await local.close();
  });
});
