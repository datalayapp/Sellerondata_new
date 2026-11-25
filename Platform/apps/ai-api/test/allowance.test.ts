import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AI_HEADERS, AI_MICROS_PER_UNIT, aiPeriodOf, type AiAllowance, type AiGatewayStatus } from '@sellerondata/contracts';
import { disconnectPrisma, getPrisma } from '../src/db.ts';
import { uuidv7 } from '../src/ledger/ids.ts';
import { closeSuper, createTestAccount, fakeKey, makeApp, resetKeys, superClient } from './helpers.ts';
import { TEST_TOOL_TOKENS } from './testEnv.ts';

/**
 * `GET /internal/status` ve `GET /internal/allowance?orgId=` (araç jetonuyla). TagPress bunları 30 sn önbellekle okur; biçim sözleşmede
 * (`AiGatewayStatus`, `AiAllowance`). Firmanın hakkı bütün araçlarda tek; `tool` çağıran aracın (jetondan) tavanı.
 */

const prisma = getPrisma();
const $ = (usd: number) => Math.round(usd * AI_MICROS_PER_UNIT);
let app: FastifyInstance;

async function reset() {
  const su = await superClient();
  await su.query('TRUNCATE ai."AiCall", ai."Org", ai."OrgProductCap"');
  // Platformun günlük tavanı (varsayılan 10 $) firma hakkı testlerine karışmasın: bugünkü satırlar onu doldurmasın.
  await su.query('UPDATE ai."PlatformLimits" SET "dailyCapMicroUsd" = $1, "monthlyCapMicroUsd" = NULL, paused = false WHERE id = 1', [$(1000)]);
  await resetKeys();
}

async function spend(o: { orgId?: string; product?: 'deciship' | 'tagpress'; costUsd?: number; pendingUsd?: number }) {
  const pending = o.pendingUsd !== undefined;
  await prisma.aiCall.create({
    data: {
      id: uuidv7(),
      product: o.product ?? 'deciship',
      orgId: o.orgId ?? 'org-a',
      purpose: `${o.product ?? 'deciship'}.invoice_pdf`,
      origin: 'request',
      provider: 'anthropic',
      requestedModel: 'claude-sonnet-5-5',
      priceVersion: 'r100:test',
      status: pending ? 'pending' : 'ok',
      costMicroUsd: BigInt(pending ? 0 : $(o.costUsd ?? 0)),
      reservedMicroUsd: BigInt(pending ? $(o.pendingUsd!) : 0),
      toolRequestId: randomUUID(),
      startedAt: new Date(),
    },
  });
}

const tool = (product: 'deciship' | 'tagpress') => ({ 'x-api-key': TEST_TOOL_TOKENS[product] });
const allowance = (orgId: string, product: 'deciship' | 'tagpress' = 'tagpress') =>
  app.inject({ method: 'GET', url: `/internal/allowance?orgId=${encodeURIComponent(orgId)}`, headers: tool(product) });
const status = () => app.inject({ method: 'GET', url: '/internal/status', headers: tool('tagpress') });

beforeAll(async () => {
  app = await makeApp(await createTestAccount());
});
beforeEach(reset);
afterAll(async () => {
  await reset();
  await app.close();
  await closeSuper();
  await disconnectPrisma();
});

describe('/internal/status', () => {
  it('anahtar yokken kullanılamaz; bir sağlayıcı ok olunca kullanılabilir; yalnız sözleşmedeki alanlar', async () => {
    const before = await status();
    expect(before.statusCode).toBe(200);
    expect(before.headers['cache-control']).toBe('no-store');
    expect(before.json()).toEqual({ available: false, paused: false, providers: { anthropic: 'missing', gemini: 'missing' } } satisfies AiGatewayStatus);
    const r = await app.aiDeps.keys.set('gemini', fakeKey('gemini'), { id: 'cli:test', name: 'test' }, { skipTest: true });
    expect(r.ok).toBe(true);
    expect((await status()).json()).toEqual({ available: true, paused: false, providers: { anthropic: 'missing', gemini: 'ok' } });
  });

  it('yönetici durdurunca ya da platformun günlük tavanı dolunca paused ve kullanılamaz', async () => {
    await app.aiDeps.keys.set('anthropic', fakeKey('anthropic'), { id: 'cli:test', name: 'test' }, { skipTest: true });
    const su = await superClient();
    await su.query('UPDATE ai."PlatformLimits" SET paused = true WHERE id = 1');
    expect((await status()).json()).toMatchObject({ available: false, paused: true, providers: { anthropic: 'ok' } });
    await su.query('UPDATE ai."PlatformLimits" SET paused = false, "dailyCapMicroUsd" = $1 WHERE id = 1', [$(1)]);
    await spend({ orgId: 'org-z', costUsd: 1 });
    expect((await status()).json()).toMatchObject({ available: false, paused: true });
  });

  it('jetonsuz istek 401 (sağlayıcı biçiminde, yeniden denenmez)', async () => {
    const res = await app.inject({ method: 'GET', url: '/internal/status' });
    expect(res.statusCode).toBe(401);
    expect(res.headers[AI_HEADERS.reject]).toBe('sod_unauthorized');
    expect(res.headers[AI_HEADERS.shouldRetry]).toBe('false');
  });
});

describe('/internal/allowance', () => {
  it('boş firma: tam hak (30 $), çağıran aracın tavanı (TagPress 20 $, DeciShip 15 $), dönem firmanın saat diliminde', async () => {
    const res = await allowance('org-a');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json() as AiAllowance;
    const period = aiPeriodOf(new Date(), 'Europe/Istanbul');
    expect(body).toEqual({
      period,
      resetsAt: expect.any(String),
      capMicroUsd: $(30),
      usedMicroUsd: 0,
      reservedMicroUsd: 0,
      remainingMicroUsd: $(30),
      state: 'ok',
      tool: { product: 'tagpress', capMicroUsd: $(20), usedMicroUsd: 0 },
    } satisfies AiAllowance);
    expect(new Date(body.resetsAt).getTime()).toBeGreaterThan(Date.now());
    expect((await allowance('org-a', 'deciship')).json().tool).toEqual({ product: 'deciship', capMicroUsd: $(15), usedMicroUsd: 0 });
  });

  it('tek ortak hak: iki aracın harcaması aynı toplamda; araç kısmı yalnız çağıranın; açık pay kalanı düşürür', async () => {
    await spend({ product: 'deciship', costUsd: 5 });
    await spend({ product: 'tagpress', costUsd: 3 });
    await spend({ product: 'tagpress', pendingUsd: 2 });
    await spend({ orgId: 'org-b', product: 'tagpress', costUsd: 7 });
    const tp = (await allowance('org-a', 'tagpress')).json() as AiAllowance;
    const ds = (await allowance('org-a', 'deciship')).json() as AiAllowance;
    for (const b of [tp, ds]) {
      expect(b).toMatchObject({ capMicroUsd: $(30), usedMicroUsd: $(8), reservedMicroUsd: $(2), remainingMicroUsd: $(20), state: 'ok' });
    }
    expect(tp.tool).toEqual({ product: 'tagpress', capMicroUsd: $(20), usedMicroUsd: $(3) });
    expect(ds.tool).toEqual({ product: 'deciship', capMicroUsd: $(15), usedMicroUsd: $(5) });
  });

  it('durum: %80 warn, dolu capped (hak ya da araç tavanı), platform durunca paused; ezilen hak ve araç tavanı geçer', async () => {
    await prisma.org.create({ data: { id: 'org-a', capOverrideMicroUsd: BigInt($(10)) } });
    await spend({ product: 'deciship', costUsd: 7.99 });
    expect((await allowance('org-a')).json().state).toBe('ok');
    await spend({ product: 'deciship', costUsd: 0.01 });
    expect((await allowance('org-a')).json()).toMatchObject({ capMicroUsd: $(10), state: 'warn' });
    await spend({ product: 'tagpress', costUsd: 2 });
    expect((await allowance('org-a')).json()).toMatchObject({ remainingMicroUsd: 0, state: 'capped' });
    // Yalnız araç tavanı dolu: o aracın durumu capped, öbürününki değil.
    await reset();
    await prisma.orgProductCap.create({ data: { orgId: 'org-a', product: 'tagpress', capMicroUsd: BigInt($(1)) } });
    await spend({ product: 'tagpress', costUsd: 1 });
    expect((await allowance('org-a', 'tagpress')).json()).toMatchObject({ state: 'capped', tool: { capMicroUsd: $(1), usedMicroUsd: $(1) } });
    expect((await allowance('org-a', 'deciship')).json().state).toBe('ok');
    const su = await superClient();
    await su.query('UPDATE ai."PlatformLimits" SET paused = true WHERE id = 1');
    expect((await allowance('org-a', 'deciship')).json().state).toBe('paused');
  });

  it('eksik ya da bozuk orgId: 400 sod_context_invalid (Anthropic biçimi, yeniden denenmez); jetonsuz 401', async () => {
    for (const url of ['/internal/allowance', '/internal/allowance?orgId=', '/internal/allowance?orgId=a%20b', `/internal/allowance?orgId=${'x'.repeat(65)}`]) {
      const res = await app.inject({ method: 'GET', url, headers: tool('tagpress') });
      expect(res.statusCode, url).toBe(400);
      expect(res.headers[AI_HEADERS.reject]).toBe('sod_context_invalid');
      expect(res.headers[AI_HEADERS.shouldRetry]).toBe('false');
      expect(res.json()).toMatchObject({ type: 'error', error: { type: 'sod_context_invalid' } });
    }
    expect((await app.inject({ method: 'GET', url: '/internal/allowance?orgId=org-a' })).statusCode).toBe(401);
  });
});
