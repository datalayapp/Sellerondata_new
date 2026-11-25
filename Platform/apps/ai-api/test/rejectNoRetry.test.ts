import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AI_HEADERS, AI_MICROS_PER_UNIT, aiContextHeaders, aiRejectCodeOf, type AiRejectCode } from '@sellerondata/contracts';
import { disconnectPrisma, getPrisma } from '../src/db.ts';
import { uuidv7 } from '../src/ledger/ids.ts';
import { closeSuper, createTestAccount, fakeKey, makeApp, resetKeys, superClient } from './helpers.ts';
import { TEST_TOOL_TOKENS } from './testEnv.ts';

/**
 * Tavan retleri araçta yeniden denemeye yol açmaz: gerçek Anthropic SDK (varsayılan `maxRetries: 2`) → vekil (G2) → tavanlar (G3).
 * Ret yanıtı: sağlayıcı biçiminde gövde (`error.type = sod_*`), `x-sod-ai-reject`, `x-should-retry: false`; SDK tek istek yapar,
 * sağlayıcıya hiçbir şey gitmez. Karşı deneme: aynı 429 bu başlık olmadan gelirse SDK yeniden dener (SDK sürümü değişirse bu test
 * bunu yakalar; YAPAY-ZEKA-GECIDI §7 riskler).
 */

const prisma = getPrisma();
let app: FastifyInstance;
const upstream: string[] = [];
let toGateway = 0;

/** SDK'nın `fetch`'i → `app.inject` (ağ yok). */
const bridge = (async (input: string | URL | Request, init?: RequestInit) => {
  toGateway += 1;
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const res = await app.inject({ method: (init?.method ?? 'GET') as 'POST', url: url.pathname + url.search, headers, payload: (init?.body as string | undefined) ?? undefined });
  const out = new Headers();
  for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out.set(k, Array.isArray(v) ? v.join(', ') : String(v));
  return new Response(res.payload, { status: res.statusCode, headers: out });
}) as typeof fetch;

/**
 * SDK 1.x `apiKey`'i `Authorization: Bearer` olarak gönderir; geçidin araç kimliği bugün yalnız `x-api-key` kabul eder (auth/tool.ts).
 * Bu test tavan retlerini sınar: jeton açıkça `x-api-key` başlığıyla verilir (TagPress'in SDK 0.x'i kendiliğinden böyle gönderir).
 */
const sdk = () =>
  new Anthropic({ baseURL: 'http://ai-api.test/internal/anthropic', apiKey: null, authToken: null, defaultHeaders: { 'x-api-key': TEST_TOOL_TOKENS.deciship }, fetch: bridge, maxRetries: 2 });

async function send(orgId = 'org-a'): Promise<{ status: number; code: AiRejectCode | null; type: string | undefined }> {
  try {
    await sdk().messages.create(
      { model: 'claude-sonnet-5-5', max_tokens: 256, messages: [{ role: 'user', content: 'merhaba' }] },
      { headers: aiContextHeaders({ orgId, memberId: 'member-1', purpose: 'deciship.invoice_pdf', requestId: randomUUID(), origin: 'job' }) },
    );
    throw new Error('ret bekleniyordu');
  } catch (e) {
    if (!(e instanceof Anthropic.APIError)) throw e;
    return { status: e.status ?? 0, code: e.headers ? aiRejectCodeOf(e.headers) : null, type: (e.error as { error?: { type?: string } } | undefined)?.error?.type };
  }
}

beforeAll(async () => {
  app = await makeApp(await createTestAccount(), {
    fetch: (async (input: string | URL | Request) => {
      upstream.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'beklenmeyen' } }), { status: 500 });
    }) as typeof fetch,
  });
});
beforeEach(async () => {
  const su = await superClient();
  await su.query('TRUNCATE ai."AiCall", ai."Org", ai."OrgProductCap"');
  await su.query('UPDATE ai."PlatformLimits" SET "dailyCapMicroUsd" = NULL, "monthlyCapMicroUsd" = NULL, paused = false WHERE id = 1');
  await resetKeys();
  const r = await app.aiDeps.keys.set('anthropic', fakeKey('anthropic'), { id: 'cli:test', name: 'test' }, { skipTest: true });
  expect(r.ok).toBe(true);
  upstream.length = 0;
  toGateway = 0;
});
afterAll(async () => {
  await app.close();
  await closeSuper();
  await disconnectPrisma();
});

describe('ret → SDK yeniden denemez', () => {
  it('platform durdu (sod_platform_paused 429): tek istek, sağlayıcıya gidilmez, satır rejected', async () => {
    const su = await superClient();
    await su.query('UPDATE ai."PlatformLimits" SET paused = true WHERE id = 1');
    expect(await send()).toEqual({ status: 429, code: 'sod_platform_paused', type: 'sod_platform_paused' });
    expect(toGateway).toBe(1);
    expect(upstream).toEqual([]);
    const rows = await prisma.aiCall.findMany();
    expect(rows.map((r) => [r.status, r.errorCode, r.reservedMicroUsd, r.costMicroUsd])).toEqual([['rejected', 'sod_platform_paused', 0n, 0n]]);
  });

  it('firma hakkı dolu (sod_org_cap), araç tavanı dolu (sod_tool_cap), kapalı firma (sod_org_closed): tek istek', async () => {
    // Hak gerçekten dolu (harcanan ≥ tavan): kesin ret. Yalnız pay sığmasaydı geçici olurdu (R2, limits.test.ts).
    await prisma.org.create({ data: { id: 'org-a', capOverrideMicroUsd: 1n } });
    await prisma.aiCall.create({
      data: {
        id: uuidv7(),
        product: 'tagpress',
        orgId: 'org-a',
        purpose: 'tagpress.design',
        origin: 'request',
        provider: 'anthropic',
        requestedModel: 'claude-opus-5-5',
        priceVersion: 'r100:test',
        status: 'ok',
        costMicroUsd: 1n,
        toolRequestId: randomUUID(),
      },
    });
    expect(await send('org-a')).toMatchObject({ status: 429, code: 'sod_org_cap' });
    await prisma.orgProductCap.create({ data: { orgId: 'org-b', product: 'deciship', capMicroUsd: 0n } });
    expect(await send('org-b')).toMatchObject({ status: 429, code: 'sod_tool_cap' });
    await prisma.org.create({ data: { id: 'org-c', closedAt: new Date() } });
    expect(await send('org-c')).toMatchObject({ status: 403, code: 'sod_org_closed' });
    expect(toGateway).toBe(3);
    expect(upstream).toEqual([]);
  });

  it('geçici ret (süren çağrıların payı, sod_rate_limited + retry-after): SDK yine beklemeden yeniden denemez', async () => {
    await prisma.org.create({ data: { id: 'org-a', capOverrideMicroUsd: BigInt(1 * AI_MICROS_PER_UNIT) } });
    await prisma.aiCall.create({
      data: {
        id: uuidv7(),
        product: 'tagpress',
        orgId: 'org-a',
        purpose: 'tagpress.design',
        origin: 'request',
        provider: 'anthropic',
        requestedModel: 'claude-opus-5-5',
        priceVersion: 'r100:test',
        status: 'pending',
        reservedMicroUsd: BigInt(0.999 * AI_MICROS_PER_UNIT),
        toolRequestId: randomUUID(),
      },
    });
    const r = await send('org-a');
    expect(r).toMatchObject({ status: 429, code: 'sod_rate_limited' });
    expect(toGateway).toBe(1);
    expect(upstream).toEqual([]);
  });

  it('karşı deneme: aynı 429 x-should-retry olmadan gelirse SDK yeniden dener (başlık gerçekten belirleyici)', async () => {
    let calls = 0;
    const plain = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ type: 'error', error: { type: 'sod_org_cap', message: 'x' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', [AI_HEADERS.reject]: 'sod_org_cap', 'retry-after-ms': '1' },
      });
    }) as typeof fetch;
    const client = new Anthropic({ baseURL: 'http://ai-api.test/internal/anthropic', apiKey: 'x', fetch: plain, maxRetries: 2 });
    await expect(client.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'a' }] })).rejects.toBeInstanceOf(Anthropic.APIError);
    expect(calls).toBe(3);
  });
});
