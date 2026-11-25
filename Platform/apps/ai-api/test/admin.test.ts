import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AiAdminLimits } from '@sellerondata/contracts';
import { disconnectPrisma, getPrisma } from '../src/db.ts';
import { closeSuper } from './helpers.ts';
import { auth, createG4Account, makeG4App, resetG4, seedCalls, stepUp, thisMonth, type G4Account } from './g4Helpers.ts';

/**
 * Yönetici tavan ve durum uçları (G4): yalnız `op`; acil durdurma adım artırmasız, geri açma ve tavanlar adım artırmalı; firma hakkı
 * ezme; firma tablosu; durum; her değişiklik yönetici kaydında.
 */

let account: G4Account;
let app: FastifyInstance;

beforeAll(async () => {
  account = await createG4Account();
  app = await makeG4App(account);
});
afterAll(async () => {
  await app.close();
  await closeSuper();
  await disconnectPrisma();
});
beforeEach(resetG4);

const opToken = () => account.access({ op: true, name: 'Platform Sahibi' });
const req = async (method: 'GET' | 'PATCH' | 'PUT', url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { ...headers, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

describe('yetki', () => {
  it('op olmayan (firma sahibi dahil) 403; op okuma uçlarına adım artırmasız girer', async () => {
    const owner = auth(await account.access({ orgRole: 'OWNER' }));
    for (const [m, u, b] of [
      ['GET', '/api/ai/admin/limits', undefined],
      ['GET', '/api/ai/admin/status', undefined],
      ['PATCH', '/api/ai/admin/limits', { paused: true }],
      ['PUT', '/api/ai/admin/limits/orgs/org-a', { capUsd: 5 }],
    ] as const) {
      const res = await req(m, u, { ...owner, ...stepUp(await account.stepUp()) }, b);
      expect(res.statusCode, `${m} ${u}`).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    }
    const op = auth(await opToken());
    expect((await req('GET', '/api/ai/admin/limits', op)).statusCode).toBe(200);
    expect((await req('GET', '/api/ai/admin/status', op)).statusCode).toBe(200);
  });
});

describe('platform tavanları ve acil durdurma', () => {
  it('durdurma adım artırmasız; geri açma ve tavan adım artırma ister; yönetici kaydı', async () => {
    const op = auth(await opToken());
    const paused = await req('PATCH', '/api/ai/admin/limits', op, { paused: true });
    expect(paused.statusCode).toBe(200);
    expect((paused.json() as AiAdminLimits).platform).toMatchObject({ paused: true, pausedBy: 'Platform Sahibi' });

    const status = (await req('GET', '/api/ai/admin/status', op)).json();
    expect(status).toMatchObject({ paused: true, available: false, providers: { anthropic: 'missing', gemini: 'missing' } });
    expect(Array.isArray(status.stalePrices)).toBe(true);

    for (const body of [{ paused: false }, { platformDailyUsd: 5 }, { paused: true, platformMonthlyUsd: 99 }]) {
      const res = await req('PATCH', '/api/ai/admin/limits', op, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(403);
      expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
    }
    // Başka oturumun adım artırması geçmez.
    const foreign = await req('PATCH', '/api/ai/admin/limits', { ...op, ...stepUp(await account.stepUp({ sessionId: 'baska' })) }, { paused: false });
    expect(foreign.statusCode).toBe(403);

    const withStep = { ...op, ...stepUp(await account.stepUp()) };
    const resumed = await req('PATCH', '/api/ai/admin/limits', withStep, { paused: false, platformDailyUsd: 5, platformMonthlyUsd: 99.5 });
    expect(resumed.statusCode).toBe(200);
    expect((resumed.json() as AiAdminLimits).platform).toMatchObject({
      paused: false,
      pausedAt: null,
      pausedBy: null,
      dailyCapMicroUsd: 5_000_000,
      monthlyCapMicroUsd: 99_500_000,
    });

    const audit = await getPrisma().adminAudit.findMany({ orderBy: { at: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['platform.pause', 'platform.resume']);
    expect(audit[1]!.detail).toMatchObject({ dailyCapMicroUsd: { from: null, to: 5_000_000 }, paused: { from: true, to: false } });
    expect(audit.every((a) => a.actorId === 'person-1' && a.actorName === 'Platform Sahibi')).toBe(true);
  });

  it('bozuk gövde 400', async () => {
    const h = { ...auth(await opToken()), ...stepUp(await account.stepUp()) };
    for (const body of [{}, { platformDailyUsd: -1 }, { platformDailyUsd: '5' }, { paused: 'true' }, { baska: 1 }, { platformMonthlyUsd: 2_000_000 }]) {
      const res = await req('PATCH', '/api/ai/admin/limits', h, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION');
    }
  });
});

describe('firma hakkı ve firma tablosu', () => {
  it('firma hakkını ezme adım artırmalı; null varsayılana döner; tablo bu ayın harcamasıyla sıralı', async () => {
    await seedCalls([
      { orgId: 'org-a', startedAt: thisMonth(1), costMicroUsd: 2_000_000 },
      { orgId: 'org-a', startedAt: thisMonth(1), costMicroUsd: 1_000_000, product: 'tagpress' },
      { orgId: 'org-b', startedAt: thisMonth(1), costMicroUsd: 25_000_000 },
      // Firmanın kendi anahtarı (ileride) hakka girmez.
      { orgId: 'org-b', startedAt: thisMonth(1), costMicroUsd: 9_000_000, keySource: 'org' },
    ]);
    await getPrisma().org.create({ data: { id: 'org-b', name: 'B Firma' } });
    const op = auth(await opToken());
    const none = await req('PUT', '/api/ai/admin/limits/orgs/org-a', op, { capUsd: 5 });
    expect(none.statusCode).toBe(403);
    expect(none.json().error.code).toBe('STEP_UP_REQUIRED');

    const h = { ...op, ...stepUp(await account.stepUp()) };
    const set = await req('PUT', '/api/ai/admin/limits/orgs/org-a', h, { capUsd: 3 });
    expect(set.statusCode).toBe(200);
    const limits = set.json() as AiAdminLimits;
    expect(limits.orgDefaultCapMicroUsd).toBe(30_000_000);
    expect(limits.tools).toEqual({ deciship: { defaultCapMicroUsd: 15_000_000 }, tagpress: { defaultCapMicroUsd: 20_000_000 } });
    expect(limits.tryPerUsd).toBe(100);
    expect(limits.orgs).toEqual([
      {
        orgId: 'org-b',
        orgName: 'B Firma',
        usedMicroUsd: 25_000_000,
        byProduct: { deciship: 25_000_000 },
        capMicroUsd: 30_000_000,
        capOverridden: false,
        usedPct: 83,
        state: 'warn',
      },
      {
        orgId: 'org-a',
        orgName: null,
        usedMicroUsd: 3_000_000,
        byProduct: { deciship: 2_000_000, tagpress: 1_000_000 },
        capMicroUsd: 3_000_000,
        capOverridden: true,
        usedPct: 100,
        state: 'capped',
      },
    ]);
    const org = await getPrisma().org.findUnique({ where: { id: 'org-a' } });
    expect(org).toMatchObject({ capOverrideMicroUsd: 3_000_000n, capOverriddenBy: 'Platform Sahibi' });

    const reset = (await req('PUT', '/api/ai/admin/limits/orgs/org-a', h, { capUsd: null })).json() as AiAdminLimits;
    expect(reset.orgs.find((o) => o.orgId === 'org-a')).toMatchObject({ capMicroUsd: 30_000_000, capOverridden: false });
    expect((await getPrisma().org.findUnique({ where: { id: 'org-a' } }))?.capOverriddenBy).toBeNull();

    for (const body of [{}, { capUsd: -1 }, { capUsd: '3' }]) expect((await req('PUT', '/api/ai/admin/limits/orgs/org-a', h, body)).statusCode).toBe(400);
    expect((await req('PUT', '/api/ai/admin/limits/orgs/k%C3%B6t%C3%BC', h, { capUsd: 1 })).statusCode).toBe(404);
    await getPrisma().org.update({ where: { id: 'org-b' }, data: { purgedAt: new Date(), name: null } });
    expect((await req('PUT', '/api/ai/admin/limits/orgs/org-b', h, { capUsd: 1 })).statusCode).toBe(404);
    const actions = (await getPrisma().adminAudit.findMany({ orderBy: { at: 'asc' } })).map((a) => [a.action, a.orgId]);
    expect(actions).toEqual([
      ['org.cap', 'org-a'],
      ['org.cap', 'org-a'],
    ]);
  });
});
