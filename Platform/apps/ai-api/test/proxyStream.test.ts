import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AI_CHARGED_MAYBE, AI_HEADERS, aiContextHeaders } from '@sellerondata/contracts';
import { disconnectPrisma } from '../src/db.ts';
import { allowAllLimits, type Limits } from '../src/proxy/limits.ts';
import { proxyRoutes } from '../src/proxy/routes.ts';
import { closeSuper, createTestAccount, fakeKey, logCapture } from './helpers.ts';
import {
  anthropicEvents,
  anthropicMessage,
  chunked,
  fakeUpstream,
  json,
  ledgerRows,
  makeProxyApp,
  newRequestId,
  resetAll,
  setKey,
  sseFrame,
  waitFor,
} from './proxyHelpers.ts';
import { TEST_TOOL_TOKENS } from './testEnv.ts';

/**
 * Vekil gerçek HTTP üzerinden (G2): GERÇEK Anthropic SDK + sahte sağlayıcı geçitten geçer (akış, akışsız, beta), retlerde SDK yeniden
 * denemez, sağlayıcının 529'unda SDK'nın denemeleri ayrı satırlar; aracın bağlantıyı kesmesi `cancelled` + `estimated` ve sağlayıcı
 * isteği de kesilir; sağlayıcı akışı koparsa `failed` + `estimated` ve araç yarım akışı hata olarak görür; süre dolması.
 */

let app: FastifyInstance;
let base: string;
const up = fakeUpstream();
const logs = logCapture();
const key = fakeKey('anthropic');
let limits: Limits = allowAllLimits;
const MAX_STREAM_MS = 1500;

beforeAll(async () => {
  const account = await createTestAccount();
  await resetAll();
  app = await makeProxyApp(account, up.fetch, {
    logger: true,
    logStream: logs.stream,
    internalRoutes: (deps) => [
      proxyRoutes(deps, {
        limits: { admit: (i) => limits.admit(i), settle: (a, b) => limits.settle(a, b), release: (a) => limits.release(a) },
        maxStreamMs: MAX_STREAM_MS,
        sweepEveryMs: 0,
      }),
    ],
  });
  await setKey(app, 'anthropic', key);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app.close();
  expect(logs.text().includes(key)).toBe(false);
  expect(logs.text().includes(TEST_TOOL_TOKENS.deciship)).toBe(false);
  await closeSuper();
  await disconnectPrisma();
});
beforeEach(() => {
  limits = allowAllLimits;
  up.calls.length = 0;
});

/** DeciShip istemcisinin geçit kurulumu (`services/ai.ts`): SDK 1.x anahtarı `Authorization: Bearer` gönderir; jeton `x-api-key`'e yazılır. */
const sdk = (opts: { maxRetries?: number } = {}) =>
  new Anthropic({
    baseURL: `${base}/internal/anthropic`,
    apiKey: TEST_TOOL_TOKENS.deciship,
    defaultHeaders: { 'x-api-key': TEST_TOOL_TOKENS.deciship, authorization: null },
    maxRetries: opts.maxRetries ?? 2,
    timeout: 10_000,
  });

const ctx = (requestId = newRequestId()) => ({ orgId: 'org-a', memberId: 'member-1', purpose: 'deciship.invoice_pdf', requestId, origin: 'request' as const });

function expectUpstreamClean() {
  for (const c of up.calls) {
    expect(c.headers['x-api-key']).toBe(key);
    expect(c.headers.authorization).toBeUndefined();
    const all = JSON.stringify(c.headers);
    expect(all).not.toContain(TEST_TOOL_TOKENS.deciship);
    expect(Object.keys(c.headers).some((h) => h.startsWith('x-sod-'))).toBe(false);
  }
}

describe('gerçek Anthropic SDK geçit üzerinden', () => {
  it('akış: SDK olayları ve son mesajı alır; satır ok, kullanım doğru; jeton ve bağlam sağlayıcıya gitmez', async () => {
    up.set(() => chunked(anthropicEvents({ input: 321, output: 45, cacheRead: 10, cache1h: 20, text: 'Fatura okundu' }).map(sseFrame), { delayMs: 5 }));
    const c = ctx();
    const stream = sdk().messages.stream({ model: 'claude-sonnet-5-5', max_tokens: 500, messages: [{ role: 'user', content: 'oku' }] }, { headers: aiContextHeaders(c) });
    let text = '';
    stream.on('text', (t) => (text += t));
    const msg = await stream.finalMessage();
    expect(text).toBe('Fatura okundu');
    expect(msg.usage.input_tokens).toBe(321);
    expect(msg.usage.output_tokens).toBe(45);
    const callId = (await stream.withResponse()).response.headers.get(AI_HEADERS.callId);
    const [row] = await ledgerRows('id = $1', [callId]);
    expect(row).toMatchObject({ status: 'ok', stream: true, inputTokens: 321, outputTokens: 45, cacheReadTokens: 10, cacheWrite1hTokens: 20, attempt: 0, toolRequestId: c.requestId });
    expect(up.calls).toHaveLength(1);
    expectUpstreamClean();
  });

  it('akışsız ve beta (anthropic-beta başlığı): SDK sonucu aynen; satır ok', async () => {
    up.set(() => json(anthropicMessage({ input: 9, output: 3, text: 'tamam' })));
    const c = ctx();
    const r = await sdk().beta.messages.create(
      { model: 'claude-sonnet-5-5', max_tokens: 50, messages: [{ role: 'user', content: 'x' }], betas: ['server-side-fallback-2026-07-01'] },
      { headers: aiContextHeaders(c) },
    );
    expect(r.content[0]).toMatchObject({ type: 'text', text: 'tamam' });
    // SDK sürümüne göre `?beta=true` eklenir ya da eklenmez; gelirse aynen gider (proxy.test.ts).
    expect(['http://anthropic.test/v1/messages', 'http://anthropic.test/v1/messages?beta=true']).toContain(up.calls[0]!.url);
    expect(up.calls[0]!.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expectUpstreamClean();
    const rows = await ledgerRows('"toolRequestId" = $1', [c.requestId]);
    expect(rows).toMatchObject([{ status: 'ok', inputTokens: 9, outputTokens: 3 }]);
  });

  it('geçidin reddi (x-should-retry: false): SDK yeniden denemez, tek rejected satırı, sağlayıcıya gidilmez', async () => {
    limits = { ...allowAllLimits, admit: async () => ({ ok: false, code: 'sod_tool_cap' }) };
    const c = ctx();
    const err = await sdk({ maxRetries: 2 })
      .messages.create({ model: 'claude-sonnet-5-5', max_tokens: 50, messages: [{ role: 'user', content: 'x' }] }, { headers: aiContextHeaders(c) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.APIError);
    expect((err as InstanceType<typeof Anthropic.APIError>).status).toBe(429);
    expect((err as InstanceType<typeof Anthropic.APIError>).headers?.get(AI_HEADERS.reject)).toBe('sod_tool_cap');
    expect(up.calls).toHaveLength(0);
    const rows = await ledgerRows('"toolRequestId" = $1', [c.requestId]);
    expect(rows).toMatchObject([{ status: 'rejected', errorCode: 'sod_tool_cap', attempt: 0 }]);
  });

  it('sağlayıcının 529’u: SDK kendi denemelerini yapar, her deneme ayrı satır (attempt 0, 1, 2)', async () => {
    up.set(() => json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529, { 'retry-after-ms': '1' }));
    const c = ctx();
    const err = await sdk({ maxRetries: 2 })
      .messages.create({ model: 'claude-sonnet-5-5', max_tokens: 50, messages: [{ role: 'user', content: 'x' }] }, { headers: aiContextHeaders(c) })
      .catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(529);
    expect(up.calls).toHaveLength(3);
    const rows = await ledgerRows('"toolRequestId" = $1', [c.requestId]);
    expect(rows.map((r) => [r.attempt, r.status, r.errorCode])).toEqual([
      [0, 'failed', 'overloaded_error'],
      [1, 'failed', 'overloaded_error'],
      [2, 'failed', 'overloaded_error'],
    ]);
  });

  it('istek gittikten sonra bağlantı hatası: geçit 502 + x-should-retry: false, SDK yeniden denemez (ikinci ücret yok), satır tahmini', async () => {
    up.set(() => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
    });
    const c = ctx();
    const err = await sdk({ maxRetries: 2 })
      .messages.create({ model: 'claude-sonnet-5-5', max_tokens: 50, messages: [{ role: 'user', content: 'x' }] }, { headers: aiContextHeaders(c) })
      .catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(502);
    // R2: ücret doğmuş olabilir; araç (DeciShip iş kuyruğu, TagPress) bunu geçici sayıp yeniden denemez.
    expect((err as InstanceType<typeof Anthropic.APIError>).headers?.get(AI_HEADERS.charged)).toBe(AI_CHARGED_MAYBE);
    expect(up.calls).toHaveLength(1);
    const rows = await ledgerRows('"toolRequestId" = $1', [c.requestId]);
    expect(rows).toMatchObject([{ status: 'failed', errorCode: 'upstream_unreachable', estimated: true }]);
    expect(rows[0]!.costMicroUsd).toBeGreaterThan(0);
  });

  it('bağlantı kurulamadı (istek gitmedi): 502, yeniden denenebilir; satır tutar 0', async () => {
    up.set(() => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
    });
    const c = ctx();
    const res = await fetch(`${base}/internal/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': TEST_TOOL_TOKENS.deciship, ...aiContextHeaders(c) },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 10, messages: [] }),
    });
    expect(res.status).toBe(502);
    expect(res.headers.get(AI_HEADERS.shouldRetry)).toBe('true');
    expect(res.headers.get(AI_HEADERS.charged)).toBeNull();
    const rows = await ledgerRows('"toolRequestId" = $1', [c.requestId]);
    expect(rows).toMatchObject([{ status: 'failed', costMicroUsd: 0, estimated: false }]);
  });
});

describe('kesilme', () => {
  const streamBody = JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 800, stream: true, messages: [{ role: 'user', content: 'uzun' }] });

  it('araç bağlantıyı keser: geçit sağlayıcıyı da keser; satır cancelled + estimated, girdi message_start’tan, çıktı tahmini ≥ 1, ≤ max_tokens', async () => {
    const evs = anthropicEvents({ input: 700, output: 999, text: 'x'.repeat(350) }).map(sseFrame);
    let upstreamSignal: AbortSignal | null = null;
    up.set((call) => {
      upstreamSignal = call.signal;
      return chunked(evs, { hangAfter: 4, signal: call.signal });
    });
    const c = ctx();
    const ac = new AbortController();
    const res = await fetch(`${base}/internal/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': TEST_TOOL_TOKENS.deciship, ...aiContextHeaders(c) },
      body: streamBody,
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    let got = '';
    while (!got.includes('text_delta')) got += new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    const row = await waitFor(async () => (await ledgerRows('"toolRequestId" = $1 AND status <> $2', [c.requestId, 'pending']))[0]);
    expect(row).toMatchObject({ status: 'cancelled', estimated: true, errorCode: 'client_closed', inputTokens: 700 });
    expect(row.outputTokens).toBeGreaterThanOrEqual(100);
    expect(row.outputTokens).toBeLessThanOrEqual(800);
    expect(row.costMicroUsd).toBeGreaterThan(0);
    expect(row.reservedMicroUsd).toBe(0);
    expect((upstreamSignal as AbortSignal | null)?.aborted).toBe(true);
  });

  it('sağlayıcı akışı koparsa: araç hata görür (bağlantı kesilir), satır failed stream_interrupted + estimated', async () => {
    const evs = anthropicEvents({ input: 100, output: 50 }).map(sseFrame);
    up.set((call) => chunked(evs, { failAfter: 3, signal: call.signal }));
    const c = ctx();
    const err = await sdk({ maxRetries: 0 })
      .messages.stream({ model: 'claude-sonnet-5-5', max_tokens: 300, messages: [{ role: 'user', content: 'x' }] }, { headers: aiContextHeaders(c) })
      .finalMessage()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const row = await waitFor(async () => (await ledgerRows('"toolRequestId" = $1 AND status <> $2', [c.requestId, 'pending']))[0]);
    expect(row).toMatchObject({ status: 'failed', errorCode: 'stream_interrupted', estimated: true, inputTokens: 100 });
  });

  it('akış süresi dolarsa: sağlayıcı kesilir, satır failed gateway_timeout + estimated', async () => {
    up.set((call) => chunked(anthropicEvents({ input: 10, output: 5 }).map(sseFrame), { hangAfter: 2, signal: call.signal }));
    const c = ctx();
    const res = await fetch(`${base}/internal/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': TEST_TOOL_TOKENS.deciship, ...aiContextHeaders(c) },
      body: streamBody,
    });
    expect(res.status).toBe(200);
    await res.text().catch(() => '');
    const row = await waitFor(async () => (await ledgerRows('"toolRequestId" = $1 AND status <> $2', [c.requestId, 'pending']))[0], MAX_STREAM_MS + 4000);
    expect(row).toMatchObject({ status: 'failed', errorCode: 'gateway_timeout', estimated: true, inputTokens: 10 });
  });

  it('satır tek kez kapanır: tarama canlı satırı önce kapatırsa canlı kapanış ona dokunmaz', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    up.set(async (call) => {
      await gate;
      return chunked(anthropicEvents({ input: 10, output: 5 }).map(sseFrame), { signal: call.signal });
    });
    const c = ctx();
    const pending = fetch(`${base}/internal/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': TEST_TOOL_TOKENS.deciship, ...aiContextHeaders(c) },
      body: streamBody,
    });
    const open = await waitFor(async () => (await ledgerRows('"toolRequestId" = $1 AND status = $2', [c.requestId, 'pending']))[0]);
    const { Ledger } = await import('../src/ledger/store.ts');
    const swept = await new Ledger(app.aiDeps.prisma).sweep(new Date(Date.now() + 1000));
    expect(swept.map((s) => s.id)).toContain(open.id);
    release();
    const res = await pending;
    await res.text();
    const [row] = await ledgerRows('id = $1', [open.id]);
    expect(row).toMatchObject({ status: 'interrupted', estimated: true, costMicroUsd: open.reservedMicroUsd, reservedMicroUsd: 0 });
    expect(logs.text()).toContain('defter satırı önceden kapanmıştı');
  });
});
