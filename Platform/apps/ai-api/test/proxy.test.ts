import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AI_HEADERS, AI_LIST_PRICES_USD, aiCostMicroUsd, aiPriceVersion } from '@sellerondata/contracts';
import { disconnectPrisma } from '../src/db.ts';
import { UUID_V7_PATTERN } from '../src/ledger/ids.ts';
import { upperInputTokens } from '../src/ledger/pricing.ts';
import { allowAllLimits, type AdmitInput, type Limits } from '../src/proxy/limits.ts';
import { proxyRoutes } from '../src/proxy/routes.ts';
import { closeSuper, createTestAccount, fakeKey, logCapture, type TestAccount } from './helpers.ts';
import {
  anthropicEvents,
  anthropicMessage,
  chunked,
  ctxHeaders,
  fakeUpstream,
  geminiResponse,
  json,
  ledgerRows,
  makeProxyApp,
  newRequestId,
  resetAll,
  setKey,
  sseFrame,
  type Ctx,
} from './proxyHelpers.ts';
import { TEST_ANTHROPIC_URL, TEST_GEMINI_URL, TEST_TOOL_TOKENS } from './testEnv.ts';

/**
 * Vekil (G2), `app.inject` ile: istek ve yanıt aynen geçer (gövde, beta ve sürüm başlıkları, araçlar, görsel, önbellek), bağlam ve araç
 * jetonu sağlayıcıya gitmez, gerçek anahtar eklenir; akış bayt bayt aynı; defter satırı doğru kullanım ve tutarla kapanır; retler
 * (`rejected` satırı, `x-should-retry: false`); `count_tokens` deftere yazılmaz; aynı deneme sayısı yeni satır; Gemini yolu.
 * Gizli değer (anahtar, jeton) hiçbir yanıtta ve günlükte yok.
 */

let account: TestAccount;
let app: FastifyInstance;
const up = fakeUpstream();
const logs = logCapture();
const keys = { anthropic: fakeKey('anthropic'), gemini: fakeKey('gemini') };
const allBodies: string[] = [];
let limits: Limits = allowAllLimits;
const admits: AdmitInput[] = [];
const settles: [string, number][] = [];
const releases: string[] = [];

const recordingLimits: Limits = {
  async admit(i) {
    admits.push(i);
    return limits.admit(i);
  },
  async settle(id, amount) {
    settles.push([id, amount]);
  },
  async release(id) {
    releases.push(id);
  },
};

beforeAll(async () => {
  account = await createTestAccount();
  await resetAll();
  app = await makeProxyApp(account, up.fetch, {
    logger: true,
    logStream: logs.stream,
    logLevel: 'debug',
    // Uygulamanın varsayılan vekili yerine kayıtlı tavanlı örnek (aynı kod; tavan kaydedicisi).
    internalRoutes: (deps) => [proxyRoutes(deps, { limits: recordingLimits, sweepEveryMs: 0 })],
  });
  await setKey(app, 'anthropic', keys.anthropic);
  await setKey(app, 'gemini', keys.gemini);
});
afterAll(async () => {
  await app.close();
  // Yakalayıcı: anahtar ve jeton hiçbir yanıt gövdesinde ve günlük satırında yok.
  const text = logs.text() + allBodies.join('\n');
  for (const secret of [keys.anthropic, keys.gemini, TEST_TOOL_TOKENS.deciship, TEST_TOOL_TOKENS.tagpress]) expect(text.includes(secret)).toBe(false);
  await closeSuper();
  await disconnectPrisma();
});
beforeEach(() => {
  limits = allowAllLimits;
  admits.length = 0;
  settles.length = 0;
  releases.length = 0;
  up.calls.length = 0;
});

const toolHeaders = (product: 'deciship' | 'tagpress' = 'deciship', provider: 'anthropic' | 'gemini' = 'anthropic') => ({
  [provider === 'anthropic' ? 'x-api-key' : 'x-goog-api-key']: TEST_TOOL_TOKENS[product],
});

async function post(url: string, payload: string | Buffer | object, headers: Record<string, string>) {
  const res = await app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload: typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload),
  });
  allBodies.push(res.body, JSON.stringify(res.headers));
  return res;
}

const messages = (payload: object | string | Buffer, ctx: Ctx = {}, extra: Record<string, string> = {}, query = '') =>
  post(`/internal/anthropic/v1/messages${query}`, payload, { ...toolHeaders(), 'anthropic-version': '2023-06-01', ...ctxHeaders(ctx), ...extra });

/** Araçlar, görsel, belge, önbellek denetimi, düşünme: bütünü baytı baytına gitmeli. */
const richBody = () =>
  JSON.stringify({
    model: 'claude-sonnet-5-5',
    max_tokens: 4096,
    system: [{ type: 'text', text: 'Sen bir fatura okuyucususun.', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    tools: [{ name: 'kaydet', description: 'satırı kaydet', input_schema: { type: 'object', properties: { tutar: { type: 'number' } } }, cache_control: { type: 'ephemeral' } }],
    tool_choice: { type: 'auto' },
    thinking: { type: 'enabled', budget_tokens: 1024 },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.alloc(300, 7).toString('base64') } },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.alloc(200, 3).toString('base64') } },
          { type: 'text', text: 'Şu faturayı oku: ğüşıöç “tırnak” \u2028' },
        ],
      },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'kaydet', input: { tutar: 12.5 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }] }] },
    ],
  });

describe('istek aynen gider', () => {
  it('gövde baytı baytına; beta ve sürüm başlıkları korunur; bağlam, araç jetonu, çerez gitmez; gerçek anahtar eklenir; sorguda yalnız beta', async () => {
    up.set(() => json(anthropicMessage({ input: 10, output: 5 })));
    const body = richBody();
    const res = await messages(body, {}, { 'anthropic-beta': 'files-api-2025-04-14,server-side-fallback-2026-07-01', 'x-stainless-retry-count': '0', 'x-stainless-lang': 'js', cookie: 'a=b', authorization: 'Bearer zz', 'x-forwarded-for': '1.2.3.4' }, `?beta=true&key=${TEST_TOOL_TOKENS.deciship}`);
    expect(res.statusCode).toBe(200);
    expect(up.calls).toHaveLength(1);
    const call = up.calls[0]!;
    expect(call.url).toBe(`${TEST_ANTHROPIC_URL}/v1/messages?beta=true`);
    expect(call.body.equals(Buffer.from(body, 'utf8'))).toBe(true);
    expect(call.headers['x-api-key']).toBe(keys.anthropic);
    expect(call.headers['anthropic-beta']).toBe('files-api-2025-04-14,server-side-fallback-2026-07-01');
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
    expect(call.headers['x-stainless-lang']).toBe('js');
    expect(call.headers['accept-encoding']).toBe('identity');
    for (const h of Object.keys(call.headers)) expect(h.startsWith('x-sod-'), h).toBe(false);
    for (const h of ['authorization', 'cookie', 'x-forwarded-for', 'x-goog-api-key', 'host']) expect(call.headers[h], h).toBeUndefined();
    expect(JSON.stringify(call.headers)).not.toContain(TEST_TOOL_TOKENS.deciship);
    const [row] = await ledgerRows('id = $1', [res.headers[AI_HEADERS.callId]]);
    expect(row!.inputImages).toBe(2);
  });

  it('Gemini: anahtar x-goog-api-key, yalnız alt=sse sorgusu, model yoldan', async () => {
    up.set(() => json(geminiResponse({ prompt: 100, output: 1290, images: 1 })));
    const body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'etiket' }, { inline_data: { mime_type: 'image/png', data: 'AAAA' } }] }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'] } });
    const res = await post(`/internal/gemini/v1beta/models/gemini-3.1-flash-image:generateContent?key=${TEST_TOOL_TOKENS.tagpress}&alt=json`, body, {
      ...toolHeaders('tagpress', 'gemini'),
      ...ctxHeaders({ purpose: 'tagpress.image' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(JSON.stringify(geminiResponse({ prompt: 100, output: 1290, images: 1 })));
    const call = up.calls[0]!;
    expect(call.url).toBe(`${TEST_GEMINI_URL}/v1beta/models/gemini-3.1-flash-image:generateContent?alt=json`);
    expect(call.headers['x-goog-api-key']).toBe(keys.gemini);
    expect(call.headers['x-api-key']).toBeUndefined();
    expect(call.body.toString()).toBe(body);
    const [row] = await ledgerRows('id = $1', [res.headers[AI_HEADERS.callId]]);
    expect(row).toMatchObject({ product: 'tagpress', provider: 'gemini', requestedModel: 'gemini-3.1-flash-image', status: 'ok', outputImages: 1, inputImages: 1, inputTokens: 100, outputTokens: 1290 });
    const price = AI_LIST_PRICES_USD['gemini-3.1-flash-image']!;
    expect(row!.costMicroUsd).toBe(aiCostMicroUsd({ inputTokens: 100, outputTokens: 1290, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputImages: 1 }, price));
  });
});

describe('yanıt aynen gelir', () => {
  it('SSE akışı bayt bayt aynı (olay ortasından bölünmüş parçalar, CRLF, yorum satırı); kullanım message_start + message_delta', async () => {
    const evs = anthropicEvents({ input: 1200, output: 340, cacheRead: 5000, cache5m: 800, cache1h: 400, text: 'Fatura: 12,50 TL ✓' });
    const text = `: yorum\r\n${evs.map(sseFrame).join('')}`;
    const bytes = Buffer.from(text, 'utf8');
    // Çok baytlı karakterin ortasından ve olay ortasından bölünür.
    const cuts = [3, 17, 18, 120, 121, 400, bytes.length - 5];
    const parts: Uint8Array[] = [];
    let at = 0;
    for (const c of cuts) {
      parts.push(bytes.subarray(at, c));
      at = c;
    }
    parts.push(bytes.subarray(at));
    up.set(() => chunked(parts, { headers: { 'retry-after': '7', 'anthropic-ratelimit-requests-remaining': '99', 'set-cookie': 'cf=1' } }));
    const res = await messages(JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 1000, stream: true, messages: [{ role: 'user', content: 'x' }] }));
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(bytes)).toBe(true);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['request-id']).toBe('req_up_sse');
    expect(res.headers['retry-after']).toBe('7');
    expect(res.headers['anthropic-ratelimit-requests-remaining']).toBe('99');
    expect(res.headers['set-cookie']).toBeUndefined();
    const callId = res.headers[AI_HEADERS.callId] as string;
    expect(callId).toMatch(UUID_V7_PATTERN);
    const [row] = await ledgerRows('id = $1', [callId]);
    expect(row).toMatchObject({
      status: 'ok',
      stream: true,
      estimated: false,
      servedModel: 'claude-sonnet-5-5',
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 5000,
      cacheWrite5mTokens: 800,
      cacheWrite1hTokens: 400,
      reservedMicroUsd: 0,
      httpStatus: 200,
      upstreamRequestId: 'req_up_sse',
      priceVersion: aiPriceVersion(AI_LIST_PRICES_USD, 100),
      memberId: 'member-1',
      orgId: 'org-a',
      purpose: 'deciship.invoice_pdf',
      product: 'deciship',
      keySource: 'platform',
    });
    const expected = aiCostMicroUsd({ inputTokens: 1200, outputTokens: 340, cacheReadTokens: 5000, cacheWrite5mTokens: 800, cacheWrite1hTokens: 400 }, AI_LIST_PRICES_USD['claude-sonnet-5-5']!);
    expect(row!.costMicroUsd).toBe(expected);
    expect(settles).toEqual([[callId, expected]]);
  });

  it('akışsız JSON yanıtı aynen; yedek modelle (iterations) her kalem kendi modelinden fiyatlanır', async () => {
    const msg = {
      ...anthropicMessage({ input: 0, output: 0, model: 'claude-opus-5-5' }),
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        iterations: [
          { model: 'claude-sonnet-5-5', input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          { model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        ],
      },
    };
    up.set(() => json(msg));
    const res = await messages({ model: 'claude-sonnet-5-5', max_tokens: 1000, messages: [{ role: 'user', content: 'x' }] });
    expect(res.body).toBe(JSON.stringify(msg));
    const [row] = await ledgerRows('id = $1', [res.headers[AI_HEADERS.callId]]);
    const z = { cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 };
    const cost =
      aiCostMicroUsd({ inputTokens: 1000, outputTokens: 10, ...z }, AI_LIST_PRICES_USD['claude-sonnet-5-5']!) + aiCostMicroUsd({ inputTokens: 1000, outputTokens: 500, ...z }, AI_LIST_PRICES_USD['claude-opus-5-5']!);
    expect(row).toMatchObject({ status: 'ok', servedModel: 'claude-opus-5-5', inputTokens: 2000, outputTokens: 510, costMicroUsd: cost });
  });

  it('tabloda olmayan yedek model en pahalı fiyattan yazılır', async () => {
    up.set(() => json(anthropicMessage({ input: 1000, output: 1000, model: 'claude-gizemli-9' })));
    const res = await messages({ model: 'claude-sonnet-5-5', max_tokens: 100, messages: [] });
    const [row] = await ledgerRows('id = $1', [res.headers[AI_HEADERS.callId]]);
    expect(row!.costMicroUsd).toBeGreaterThan(aiCostMicroUsd({ inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 }, AI_LIST_PRICES_USD['claude-opus-5-5']!));
    expect(logs.text()).toContain('fiyat tablosunda olmayan model');
  });

  it('sağlayıcı hatası: durum, gövde ve retry-after/x-should-retry aynen; satır failed + hata türü; 529 ücretsiz', async () => {
    const err = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' }, request_id: 'req_x' };
    up.set(() => json(err, 529, { 'retry-after': '3', 'x-should-retry': 'true' }));
    const res = await messages({ model: 'claude-sonnet-5-5', max_tokens: 100, messages: [] });
    expect(res.statusCode).toBe(529);
    expect(res.body).toBe(JSON.stringify(err));
    expect(res.headers['retry-after']).toBe('3');
    expect(res.headers['x-should-retry']).toBe('true');
    expect(res.headers[AI_HEADERS.reject]).toBeUndefined();
    const [row] = await ledgerRows('id = $1', [res.headers[AI_HEADERS.callId]]);
    expect(row).toMatchObject({ status: 'failed', errorCode: 'overloaded_error', httpStatus: 529, costMicroUsd: 0, estimated: false, reservedMicroUsd: 0 });
  });

  it('sağlayıcı anahtarı hata metninde yansıtırsa araca maskelenmiş gider; 401 anahtarı reddedildi işaretler, sonraki başarı geri açar', async () => {
    up.set((c) => json({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${c.headers['x-api-key']}` } }, 401));
    const res = await messages({ model: 'claude-sonnet-5-5', max_tokens: 100, messages: [] });
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('[gizli]');
    expect(res.body).not.toContain(keys.anthropic);
    await expect.poll(async () => (await app.aiDeps.keys.get('anthropic')).state).toBe('rejected');
    up.set(() => json(anthropicMessage({ input: 1, output: 1 })));
    expect((await messages({ model: 'claude-sonnet-5-5', max_tokens: 100, messages: [] })).statusCode).toBe(200);
    await expect.poll(async () => (await app.aiDeps.keys.get('anthropic')).state).toBe('ok');
  });

  it('akış içinde hata olayı: failed, tahmini (üretilen kısım fazla sayılır)', async () => {
    const evs = anthropicEvents({ input: 500, output: 0, stop: false }).slice(0, 4);
    const text = evs.map(sseFrame).join('') + sseFrame(['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]);
    up.set(() => chunked([text]));
    const res = await messages({ model: 'claude-sonnet-5-5', max_tokens: 2000, stream: true, messages: [] });
    expect(res.rawPayload.toString()).toBe(text);
    const [row] = await ledgerRows('id = $1', [res.headers[AI_HEADERS.callId]]);
    expect(row).toMatchObject({ status: 'failed', errorCode: 'overloaded_error', estimated: true, inputTokens: 500 });
    expect(row!.outputTokens).toBeGreaterThanOrEqual(1);
  });

  it('bitiş olayı gelmeden temiz kapanan akış: failed stream_incomplete, tahmini', async () => {
    const text = anthropicEvents({ input: 50, output: 10, stop: false }).slice(0, 4).map(sseFrame).join('');
    up.set(() => chunked([text]));
    const res = await messages({ model: 'claude-sonnet-5-5', max_tokens: 300, stream: true, messages: [] });
    const [row] = await ledgerRows('id = $1', [res.headers[AI_HEADERS.callId]]);
    expect(row).toMatchObject({ status: 'failed', errorCode: 'stream_incomplete', estimated: true, inputTokens: 50 });
  });

  it('Gemini akışı (alt=sse): görseller toplanır, son usageMetadata kazanır', async () => {
    const c1 = { candidates: [{ content: { parts: [{ text: 'a' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 }, modelVersion: 'gemini-3.1-flash-image' };
    const c2 = geminiResponse({ prompt: 10, output: 1300, images: 2, cached: 4 });
    const text = `data: ${JSON.stringify(c1)}\r\n\r\ndata: ${JSON.stringify(c2)}\r\n\r\n`;
    up.set(() => chunked([text.slice(0, 50), text.slice(50)]));
    const res = await post('/internal/gemini/v1beta/models/gemini-3.1-flash-image:streamGenerateContent?alt=sse', { contents: [] }, { ...toolHeaders('tagpress', 'gemini'), ...ctxHeaders({ purpose: 'tagpress.image' }) });
    expect(res.rawPayload.toString()).toBe(text);
    expect(up.calls[0]!.url.endsWith(':streamGenerateContent?alt=sse')).toBe(true);
    const [row] = await ledgerRows('id = $1', [res.headers[AI_HEADERS.callId]]);
    expect(row).toMatchObject({ status: 'ok', stream: true, outputImages: 2, inputTokens: 6, cacheReadTokens: 4, outputTokens: 1300 });
  });

  it('Gemini akışı (JSON dizisi) ve 400 API_KEY_INVALID anahtarı reddedildi işaretler', async () => {
    up.set(() => new Response(JSON.stringify([geminiResponse({ prompt: 5, output: 5, images: 1 })]), { status: 200, headers: { 'content-type': 'application/json' } }));
    const ok = await post('/internal/gemini/v1beta/models/gemini-3.1-flash-image:streamGenerateContent', { contents: [] }, { ...toolHeaders('tagpress', 'gemini'), ...ctxHeaders({ purpose: 'tagpress.image' }) });
    const [row] = await ledgerRows('id = $1', [ok.headers[AI_HEADERS.callId]]);
    expect(row).toMatchObject({ status: 'ok', outputImages: 1 });
    up.set(() => json({ error: { code: 400, message: 'API key not valid', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }, 400));
    const bad = await post('/internal/gemini/v1beta/models/gemini-3.1-flash-image:generateContent', { contents: [] }, { ...toolHeaders('tagpress', 'gemini'), ...ctxHeaders({ purpose: 'tagpress.image' }) });
    expect(bad.statusCode).toBe(400);
    await expect.poll(async () => (await app.aiDeps.keys.get('gemini')).state).toBe('rejected');
    const [frow] = await ledgerRows('id = $1', [bad.headers[AI_HEADERS.callId]]);
    expect(frow).toMatchObject({ status: 'failed', errorCode: 'INVALID_ARGUMENT', httpStatus: 400 });
    await setKey(app, 'gemini', keys.gemini);
  });
});

describe('retler', () => {
  const expectReject = (res: Awaited<ReturnType<typeof messages>>, code: string, status: number) => {
    expect(res.statusCode).toBe(status);
    expect(res.headers[AI_HEADERS.reject]).toBe(code);
    expect(res.headers[AI_HEADERS.shouldRetry]).toBe('false');
    expect(res.json()).toMatchObject({ type: 'error', error: { type: code } });
  };

  it('bağlam başlığı eksik: sod_context_invalid, satır yok, sağlayıcıya gidilmez', async () => {
    const h = ctxHeaders();
    delete h[AI_HEADERS.org];
    const res = await post('/internal/anthropic/v1/messages', { model: 'claude-sonnet-5-5', max_tokens: 1, messages: [] }, { ...toolHeaders(), ...h });
    expectReject(res, 'sod_context_invalid', 400);
    expect(res.headers[AI_HEADERS.callId]).toBeUndefined();
    expect(await ledgerRows('"toolRequestId" = $1', [h[AI_HEADERS.requestId]])).toHaveLength(0);
    expect(up.calls).toHaveLength(0);
  });

  it('başka aracın amacı, izin listesinde olmayan model, öbür sağlayıcının modeli: rejected satırı, tutar 0, sağlayıcıya gidilmez', async () => {
    const a = await messages({ model: 'claude-sonnet-5-5', max_tokens: 1, messages: [] }, { purpose: 'tagpress.design' });
    expectReject(a, 'sod_purpose_unknown', 400);
    const b = await messages({ model: 'claude-opus-5-5', max_tokens: 1, messages: [] });
    expectReject(b, 'sod_model_not_allowed', 400);
    const c = await post('/internal/gemini/v1beta/models/claude-haiku-5-5:generateContent', { contents: [] }, { ...toolHeaders('tagpress', 'gemini'), ...ctxHeaders({ purpose: 'tagpress.image' }) });
    expect(c.statusCode).toBe(400);
    expect(c.headers[AI_HEADERS.reject]).toBe('sod_model_not_allowed');
    expect(c.json()).toMatchObject({ error: { code: 400, reason: 'sod_model_not_allowed' } });
    expect(up.calls).toHaveLength(0);
    for (const r of [a, b, c]) {
      const [row] = await ledgerRows('id = $1', [r.headers[AI_HEADERS.callId]]);
      expect(row).toMatchObject({ status: 'rejected', costMicroUsd: 0, reservedMicroUsd: 0 });
    }
    expect(admits).toHaveLength(0);
  });

  it('R2: sağlayıcı araçları (web arama), MCP, Gemini Google araması ve tanınmayan yedek model: sod_model_not_allowed, rejected satırı, sağlayıcıya gidilmez', async () => {
    const base = { model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] };
    const a = await messages({ ...base, tools: [{ type: 'web_search_20260209', name: 'web_search' }] });
    expectReject(a, 'sod_model_not_allowed', 400);
    const b = await messages({ ...base, mcp_servers: [{ type: 'url', url: 'https://mcp.example', name: 'm' }] });
    expectReject(b, 'sod_model_not_allowed', 400);
    const c = await messages({ ...base, fallbacks: [{ model: 'claude-yok-9' }] });
    expectReject(c, 'sod_model_not_allowed', 400);
    const d = await post(
      '/internal/gemini/v1beta/models/gemini-3.1-flash-image:generateContent',
      { contents: [], tools: [{ googleSearch: {} }] },
      { ...toolHeaders('tagpress', 'gemini'), ...ctxHeaders({ purpose: 'tagpress.image' }) },
    );
    expect(d.headers[AI_HEADERS.reject]).toBe('sod_model_not_allowed');
    expect(up.calls).toHaveLength(0);
    expect(admits).toHaveLength(0);
    for (const r of [a, b, c, d]) {
      const [row] = await ledgerRows('id = $1', [r.headers[AI_HEADERS.callId]]);
      expect(row).toMatchObject({ status: 'rejected', errorCode: 'sod_model_not_allowed', costMicroUsd: 0, reservedMicroUsd: 0 });
    }
  });

  it('R2: yedek model dizisi (izin listesinde olmasa da fiyatı bilinen) geçer; pay en pahalı modelden ve en büyük max_tokens ile; "default" istenen modelden', async () => {
    limits = { ...allowAllLimits, admit: async () => ({ ok: false, code: 'sod_tool_cap' }) };
    const body = { model: 'claude-opus-5-5', max_tokens: 100, fallbacks: [{ model: 'claude-opus-5', max_tokens: 300 }], messages: [{ role: 'user', content: 'x' }] };
    const res = await post('/internal/anthropic/v1/messages', body, { ...toolHeaders('tagpress'), ...ctxHeaders({ purpose: 'tagpress.builder_turn' }) });
    expect(res.headers[AI_HEADERS.reject]).toBe('sod_tool_cap');
    const input = upperInputTokens(Buffer.byteLength(JSON.stringify(body)));
    const opus5 = AI_LIST_PRICES_USD['claude-opus-5']!;
    expect(admits[0]!.estimateMicroUsd).toBe(Math.round(input * opus5.input + 300 * opus5.output));
    const plain = { model: 'claude-sonnet-5-5', max_tokens: 100, fallbacks: 'default', messages: [{ role: 'user', content: 'x' }] };
    await messages(plain);
    const sonnet = AI_LIST_PRICES_USD['claude-sonnet-5-5']!;
    expect(admits[1]!.estimateMicroUsd).toBe(Math.round(upperInputTokens(Buffer.byteLength(JSON.stringify(plain))) * sonnet.input + 100 * sonnet.output));
  });

  it('bozuk gövde: 400 invalid_request_error, satır yok', async () => {
    const res = await messages('{bozuk');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
    expect(up.calls).toHaveLength(0);
  });

  it('anahtar yok: sod_provider_missing (503), rejected satırı', async () => {
    await app.aiDeps.keys.remove('anthropic', { id: 'cli:test', name: 'test' });
    try {
      const res = await messages({ model: 'claude-sonnet-5-5', max_tokens: 1, messages: [] });
      expectReject(res, 'sod_provider_missing', 503);
      const [row] = await ledgerRows('id = $1', [res.headers[AI_HEADERS.callId]]);
      expect(row).toMatchObject({ status: 'rejected', errorCode: 'sod_provider_missing', httpStatus: 503 });
    } finally {
      await setKey(app, 'anthropic', keys.anthropic);
    }
  });

  it('tavan reddi: satır admit öncesi pending + pay ile yazılmış, ret sonrası rejected; retry-after; sağlayıcıya gidilmez; settle/release yok', async () => {
    let seenPending: unknown = null;
    limits = {
      ...allowAllLimits,
      async admit(i) {
        seenPending = (await ledgerRows('id = $1', [i.callId]))[0];
        return { ok: false, code: 'sod_org_cap', retryAfterSec: 3600 };
      },
    };
    const body = JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 2000, messages: [{ role: 'user', content: 'x' }] });
    const res = await messages(body, { origin: 'job', member: null });
    expectReject(res, 'sod_org_cap', 429);
    expect(res.headers['retry-after']).toBe('3600');
    expect(up.calls).toHaveLength(0);
    // Önbelleksiz düz metin gövde: girdi düz girdi fiyatından, bayt / 2 + 1.000 (R2).
    const expectedReserve = aiCostMicroUsd(
      { inputTokens: upperInputTokens(Buffer.byteLength(body)), outputTokens: 2000, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 },
      AI_LIST_PRICES_USD['claude-sonnet-5-5']!,
    );
    expect(seenPending).toMatchObject({ status: 'pending', reservedMicroUsd: expectedReserve });
    expect(admits[0]).toMatchObject({ product: 'deciship', orgId: 'org-a', memberId: null, origin: 'job', model: 'claude-sonnet-5-5', provider: 'anthropic', estimateMicroUsd: expectedReserve, attempt: 0, stream: false, keySource: 'platform' });
    const [row] = await ledgerRows('id = $1', [res.headers[AI_HEADERS.callId]]);
    expect(row).toMatchObject({ status: 'rejected', errorCode: 'sod_org_cap', httpStatus: 429, reservedMicroUsd: 0, costMicroUsd: 0, memberId: null, origin: 'job' });
    expect(settles).toHaveLength(0);
    expect(releases).toHaveLength(0);
  });

  it('tavan denetimi fırlatırsa: 503, satır failed, sağlayıcıya gidilmez', async () => {
    limits = {
      ...allowAllLimits,
      async admit() {
        throw new Error('veritabanı yok');
      },
    };
    const res = await messages({ model: 'claude-sonnet-5-5', max_tokens: 1, messages: [] });
    expect(res.statusCode).toBe(503);
    expect(res.headers[AI_HEADERS.shouldRetry]).toBe('false');
    expect(up.calls).toHaveLength(0);
    const [row] = await ledgerRows('id = $1', [res.headers[AI_HEADERS.callId]]);
    expect(row).toMatchObject({ status: 'failed', errorCode: 'gateway_limits_error', costMicroUsd: 0 });
  });
});

describe('deneme sayısı ve count_tokens', () => {
  it('aynı istek kimliği ve deneme sayısıyla ikinci istek reddedilmez: bir sonraki boş deneme sayısıyla ayrı satır', async () => {
    up.set(() => json(anthropicMessage({ input: 10, output: 10 })));
    const requestId = newRequestId();
    const r1 = await messages({ model: 'claude-sonnet-5-5', max_tokens: 10, messages: [] }, { requestId, attempt: 0 });
    const r2 = await messages({ model: 'claude-sonnet-5-5', max_tokens: 10, messages: [] }, { requestId, attempt: 0 });
    const r3 = await messages({ model: 'claude-sonnet-5-5', max_tokens: 10, messages: [] }, { requestId, attempt: 5 });
    // Deneme başlığı yoksa SDK'nın sayacı: 1 dolu (r2), sıradaki boş 2.
    const r4 = await messages({ model: 'claude-sonnet-5-5', max_tokens: 10, messages: [] }, { requestId }, { 'x-stainless-retry-count': '1' });
    for (const r of [r1, r2, r3, r4]) expect(r.statusCode).toBe(200);
    const rows = await ledgerRows('"toolRequestId" = $1', [requestId]);
    expect(rows.map((r) => r.attempt).sort((a, b) => a - b)).toEqual([0, 1, 2, 5]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(4);
    expect(rows.every((r) => r.status === 'ok')).toBe(true);
  });

  it('eşzamanlı aynı kimlikli denemeler ayrı satırlara düşer', async () => {
    up.set(() => json(anthropicMessage({ input: 1, output: 1 })));
    const requestId = newRequestId();
    const res = await Promise.all(Array.from({ length: 6 }, () => messages({ model: 'claude-sonnet-5-5', max_tokens: 10, messages: [] }, { requestId, attempt: 0 })));
    expect(res.every((r) => r.statusCode === 200)).toBe(true);
    const rows = await ledgerRows('"toolRequestId" = $1', [requestId]);
    expect(rows.map((r) => r.attempt).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('count_tokens: ücretsiz, deftere yazılmaz, tavana gitmez; bağlam yine zorunlu', async () => {
    up.set(() => json({ input_tokens: 42 }));
    const h = ctxHeaders();
    const res = await post('/internal/anthropic/v1/messages/count_tokens', { model: 'claude-sonnet-5-5', messages: [] }, { ...toolHeaders(), ...h });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ input_tokens: 42 });
    expect(res.headers[AI_HEADERS.callId]).toBeUndefined();
    expect(up.calls[0]!.url).toBe(`${TEST_ANTHROPIC_URL}/v1/messages/count_tokens`);
    expect(up.calls[0]!.headers['x-api-key']).toBe(keys.anthropic);
    expect(await ledgerRows('"toolRequestId" = $1', [h[AI_HEADERS.requestId]])).toHaveLength(0);
    expect(admits).toHaveLength(0);
    const noCtx = await post('/internal/anthropic/v1/messages/count_tokens', { model: 'claude-sonnet-5-5', messages: [] }, toolHeaders());
    expect(noCtx.headers[AI_HEADERS.reject]).toBe('sod_context_invalid');
  });

  it('izin listesinde olmayan Gemini eylemi ve yolları 404 (sağlayıcı biçimi), yukarı akış yok', async () => {
    for (const url of ['/internal/gemini/v1beta/models/gemini-3.1-flash-image:countTokens', '/internal/gemini/v1beta/models/gemini-3.1-flash-image', '/internal/gemini/v1beta/interactions']) {
      const res = await post(url, {}, { ...toolHeaders('tagpress', 'gemini'), ...ctxHeaders({ purpose: 'tagpress.image' }) });
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 404 } });
    }
    expect(up.calls).toHaveLength(0);
  });

  it('32 MB üstü gövde: sod_body_too_large (413)', async () => {
    const big = Buffer.alloc(32 * 1024 * 1024 + 10, 0x20);
    const res = await messages(big);
    expect(res.statusCode).toBe(413);
    expect(res.headers[AI_HEADERS.reject]).toBe('sod_body_too_large');
    expect(up.calls).toHaveLength(0);
  });
});
