import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POOL_DEFAULTS, Prisma } from '../src/db.ts';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { AppError, isDbConnectionError, registerErrorHandling } from '../src/errors.ts';

const known = (code: string, message = 'x') => new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test' });
const sockErr = (code: string) => Object.assign(new Error(`read ${code}`), { code });

describe('veritabanı bağlantı kopması → 503', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify();
    registerErrorHandling(app);
    const cases: Record<string, () => unknown> = {
      p1017: () => known('P1017', 'Server has closed the connection.'),
      econnreset: () => sockErr('ECONNRESET'),
      wrapped: () => new Error('sorgu başarısız', { cause: sockErr('ECONNRESET') }),
      adapter: () => Object.assign(known('P2010'), { meta: { driverAdapterError: { cause: { kind: 'ConnectionClosed' } } } }),
      unique: () => known('P2002'),
      plain: () => new Error('beklenmeyen'),
      app: () => new AppError(404, 'NOT_FOUND', 'yok'),
    };
    for (const [name, make] of Object.entries(cases)) {
      app.get(`/${name}`, async () => {
        throw make();
      });
    }
    await app.ready();
  });
  afterAll(() => app.close());

  it.each(['p1017', 'econnreset', 'wrapped', 'adapter'])('%s → 503 anlaşılır mesaj', async (name) => {
    const res = await app.inject({ method: 'GET', url: `/${name}`, headers: { 'accept-language': 'tr' } });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('3');
    expect(res.json()).toEqual({ error: { code: 'DB_UNAVAILABLE', message: 'Sunucu meşgul, birkaç saniye sonra tekrar deneyin' } });
    // Dil bilgisi yoksa İngilizce (KARARLAR, ilk açılış dili 2026-11-12)
    const plain = await app.inject({ method: 'GET', url: `/${name}` });
    expect(plain.json()).toEqual({ error: { code: 'DB_UNAVAILABLE', message: 'The server is busy. Try again in a few seconds' } });
  });

  it('bağlantıyla ilgisiz hatalar eskisi gibi', async () => {
    expect((await app.inject({ method: 'GET', url: '/unique' })).statusCode).toBe(500);
    expect((await app.inject({ method: 'GET', url: '/plain' })).statusCode).toBe(500);
    expect((await app.inject({ method: 'GET', url: '/app' })).statusCode).toBe(404);
  });

  it('isDbConnectionError: Postgres bağlantı kodları ve döngüsel cause', () => {
    expect(isDbConnectionError(Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }))).toBe(true);
    expect(isDbConnectionError(Object.assign(new Error('x'), { code: '08006' }))).toBe(true);
    expect(isDbConnectionError(Object.assign(new Error('x'), { code: '23505' }))).toBe(false);
    const loop: Error & { cause?: unknown } = new Error('döngü');
    loop.cause = loop;
    expect(isDbConnectionError(loop)).toBe(false);
    expect(isDbConnectionError(null)).toBe(false);
  });

  // Yük altında kopmanın zamanlaması değişebiliyor (sunucu bağlantıyı ikinci sorgudan sonra kapatabilir); gerçek ağ olayı olduğundan yeniden dene
  it('gerçek kopma: işlem ortasında sunucu bağlantıyı kapatır → bağlantı hatası olarak tanınır', { retry: 3 }, async () => {
    const url = new URL(process.env.DATABASE_URL!);
    const appName = `deciship_conn_test_${process.pid}`;
    url.searchParams.set('application_name', appName);
    const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString(), ...POOL_DEFAULTS }) });
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    let caught: unknown;
    try {
      await client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1', [appName]);
        await tx.$queryRaw`SELECT 1`;
      });
    } catch (e) {
      caught = e;
    } finally {
      await admin.end();
      await client.$disconnect().catch(() => {});
    }
    expect(caught).toBeDefined();
    expect(isDbConnectionError(caught)).toBe(true);
  });
});

describe('bağlantı öldürülürken istek', () => {
  it('sunucu bağlantıyı sonlandırırsa kullanıcı 500 değil 503 görür', async () => {
    const { getApp, registerCompany } = await import('./helpers.ts');
    const { testSuperDbUrl } = await import('./testEnv.ts');
    const app = await getApp();
    const admin = await registerCompany(app);
    const sup = new pg.Client({ connectionString: testSuperDbUrl() });
    await sup.connect();
    let stop = false;
    const killer = (async () => {
      while (!stop) {
        await sup.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'sod_deciship' AND datname = current_database() AND pid <> pg_backend_pid()`);
        await new Promise((r) => setTimeout(r, 15));
      }
    })();
    const urls = ['/dashboard?month=2026-10', '/platform/overview', '/measurements', '/settings', '/platform/datasets/invoices'];
    const statuses: Record<string, number> = {};
    const bodies: string[] = [];
    try {
      for (let round = 0; round < 30; round++) {
        const res = await Promise.all(urls.map((u) => app.inject({ method: 'GET', url: `/api/deciship${u}`, headers: admin.auth })));
        for (const r of res) {
          statuses[r.statusCode] = (statuses[r.statusCode] ?? 0) + 1;
          if (r.statusCode >= 500 && r.statusCode !== 503) bodies.push(r.body);
        }
      }
    } finally {
      stop = true;
      await killer;
      await sup.end();
    }
    expect(statuses['500'] ?? 0, JSON.stringify({ statuses, bodies: bodies.slice(0, 2) })).toBe(0);
    expect(statuses['503'] ?? 0).toBeGreaterThan(0);
  }, 60_000);

  it('havuza giren her bağlantı dinleyici taşır: teslim anındaki kapanma süreci düşürmez', async () => {
    const { poolConfig } = await import('../src/db.ts');
    const { EventEmitter } = await import('node:events');
    const client = new EventEmitter();
    poolConfig({}).onConnect(client);
    expect(() => client.emit('error', new Error('terminating connection'))).not.toThrow();
  });

  it('statement_timeout ve havuz zaman aşımı 503', () => {
    const q = (code: string) => Object.assign(new Error('canceling statement due to statement timeout'), { code });
    expect(isDbConnectionError(q('57014'))).toBe(true);
    expect(isDbConnectionError(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isDbConnectionError(known('P2024', 'Timed out fetching a new connection from the connection pool'))).toBe(true);
    expect(isDbConnectionError(known('P2028', 'Transaction API error: Transaction already closed'))).toBe(true);
  });
});
