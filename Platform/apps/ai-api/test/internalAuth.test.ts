import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI_HEADERS } from '@sellerondata/contracts';
import { disconnectPrisma } from '../src/db.ts';
import { createTestAccount, makeApp } from './helpers.ts';
import { TEST_TOOL_TOKENS } from './testEnv.ts';

/**
 * Araç yolları (`/internal/*`): araç jetonu SDK'nın anahtar başlığında. Jetonsuz, yanlış jetonlu, öbür sağlayıcının başlığıyla,
 * `Authorization` ya da sorgu `key=` ile gelen istek 401 (sağlayıcı biçiminde `sod_unauthorized`, yeniden denenmez); kodlanmış yol da
 * aynı kancadan geçer; izin listesinde olmayan yol jetonla da 404.
 */

let app: FastifyInstance;
const seen: { product: string | undefined; url: string }[] = [];

beforeAll(async () => {
  const account = await createTestAccount();
  app = await makeApp(account, {
    // Sınama rotaları (vekil G2'de): kapsamın kancasını kanıtlamak için.
    internalRoutes: () => [
      (scope) => {
        scope.post('/anthropic/v1/messages', async (req) => {
          seen.push({ product: req.tool?.product, url: req.url });
          return { ok: true, product: req.tool?.product };
        });
        scope.post('/gemini/v1beta/models/:model', async (req) => ({ ok: true, product: req.tool?.product }));
        scope.get('/status', async (req) => ({ product: req.tool?.product }));
      },
    ],
  });
});
afterAll(async () => {
  await app.close();
  await disconnectPrisma();
});

const anthropic = (headers: Record<string, string>, url = '/internal/anthropic/v1/messages') =>
  app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', ...headers }, payload: { model: 'claude-sonnet-5-5' } });

function expectReject(res: Awaited<ReturnType<typeof anthropic>>, provider: 'anthropic' | 'gemini') {
  expect(res.statusCode).toBe(401);
  expect(res.headers[AI_HEADERS.reject]).toBe('sod_unauthorized');
  expect(res.headers[AI_HEADERS.shouldRetry]).toBe('false');
  const body = res.json();
  if (provider === 'anthropic') expect(body).toMatchObject({ type: 'error', error: { type: 'sod_unauthorized' } });
  else expect(body).toMatchObject({ error: { code: 401, status: 'UNAUTHENTICATED', reason: 'sod_unauthorized' } });
}

describe('araç jetonu', () => {
  it('doğru jeton ürünü çözer (Anthropic x-api-key, Gemini x-goog-api-key, durum x-api-key)', async () => {
    const a = await anthropic({ 'x-api-key': TEST_TOOL_TOKENS.deciship });
    expect(a.statusCode).toBe(200);
    expect(a.json().product).toBe('deciship');
    const g = await app.inject({
      method: 'POST',
      url: '/internal/gemini/v1beta/models/gemini-3.1-flash-image:generateContent',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': TEST_TOOL_TOKENS.tagpress },
      payload: {},
    });
    expect(g.statusCode).toBe(200);
    expect(g.json().product).toBe('tagpress');
    const s = await app.inject({ method: 'GET', url: '/internal/status', headers: { 'x-api-key': TEST_TOOL_TOKENS.tagpress } });
    expect(s.json().product).toBe('tagpress');
  });

  it('jetonsuz, yanlış, kısaltılmış, uzatılmış, büyük harfli jeton; Authorization ve öbür sağlayıcının başlığı: 401', async () => {
    const t = TEST_TOOL_TOKENS.deciship;
    for (const headers of [
      {},
      { 'x-api-key': '' },
      { 'x-api-key': 'yanlis-jeton-0123456789abcdef0123456789' },
      { 'x-api-key': t.slice(0, -1) },
      { 'x-api-key': `${t}x` },
      { 'x-api-key': t.toUpperCase() },
      { authorization: `Bearer ${t}` },
      { 'x-goog-api-key': t },
    ] as Record<string, string>[]) {
      expectReject(await anthropic(headers), 'anthropic');
    }
    const g = await app.inject({
      method: 'POST',
      url: '/internal/gemini/v1beta/models/m:generateContent',
      headers: { 'content-type': 'application/json', 'x-api-key': TEST_TOOL_TOKENS.tagpress },
      payload: {},
    });
    expectReject(g, 'gemini');
    const q = await app.inject({ method: 'POST', url: `/internal/gemini/v1beta/models/m:generateContent?key=${TEST_TOOL_TOKENS.tagpress}`, headers: { 'content-type': 'application/json' }, payload: {} });
    expectReject(q, 'gemini');
    expect(seen).toHaveLength(1);
  });

  it('kodlanmış yol rotayla eşleşir ve aynı kancadan geçer: jetonsuz 401, jetonla 200; %2F, // ve sondaki / eşleşmez (jetonla 404)', async () => {
    const before = seen.length;
    for (const url of ['/%69nternal/anthropic/v1/messages', '/internal/%61nthropic/v1/messages']) {
      expectReject(await anthropic({}, url), 'anthropic');
      const ok = await anthropic({ 'x-api-key': TEST_TOOL_TOKENS.deciship }, url);
      expect(ok.statusCode, url).toBe(200);
    }
    expect(seen.length).toBe(before + 2);
    for (const url of ['/internal/anthropic%2Fv1/messages', '/internal//anthropic/v1/messages', '/internal/anthropic/v1/messages/']) {
      expectReject(await anthropic({}, url), 'anthropic');
      expect((await anthropic({ 'x-api-key': TEST_TOOL_TOKENS.deciship }, url)).statusCode, url).toBe(404);
    }
    expect(seen.length).toBe(before + 2);
  });

  it('izin listesinde olmayan yol: jetonsuz 401, jetonla 404 (sağlayıcı biçiminde); yukarı akışa bir şey gitmez', async () => {
    const noTok = await app.inject({ method: 'GET', url: '/internal/anthropic/v1/models' });
    expectReject(noTok, 'anthropic');
    const withTok = await app.inject({ method: 'GET', url: '/internal/anthropic/v1/models', headers: { 'x-api-key': TEST_TOOL_TOKENS.deciship } });
    expect(withTok.statusCode).toBe(404);
    expect(withTok.json()).toMatchObject({ type: 'error', error: { type: 'not_found_error' } });
    const gem = await app.inject({ method: 'GET', url: '/internal/gemini/v1beta/models', headers: { 'x-goog-api-key': TEST_TOOL_TOKENS.tagpress } });
    expect(gem.statusCode).toBe(404);
    expect(gem.json()).toMatchObject({ error: { code: 404, status: 'NOT_FOUND' } });
  });

  it('araç jetonu Merkez uçlarına girmez', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ai/admin/keys', headers: { 'x-api-key': TEST_TOOL_TOKENS.deciship } });
    expect(res.statusCode).toBe(401);
    const b = await app.inject({ method: 'GET', url: '/api/ai/admin/keys', headers: { authorization: `Bearer ${TEST_TOOL_TOKENS.deciship}` } });
    expect(b.statusCode).toBe(401);
  });
});
