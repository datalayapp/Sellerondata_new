/**
 * Mesaj 5 inceleme A: akışın içindeki hata GERÇEK SDK ile (sahte `fetch`, SSE; `aiProvider.test.ts` deseni). SDK akış içi
 * `event: error` için durum kodsuz `APIError(undefined, …, type)` atar; kopan bağlantı `AnthropicError` olur. Ücretsizse
 * (yanıt başlamadı) aşırı yük geçicidir; kullanım > 0 ise hata iş için kalıcıdır (ikinci ücret olmasın).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { prisma } from '../src/db.ts';
import { AI_CANCEL_OUTPUT_TOKENS_PER_SEC, cancelledUsage, meteredCall, resetAiMeterState, type AiCallContext, type MeterLog } from '../src/services/aiMeter.ts';
import { isTransientJobError } from '../src/services/jobs/runner.ts';
import { getApp, inCompany, registerCompany, uniq } from './helpers.ts';

type Ev = [string, unknown];
type Handler = (init?: RequestInit) => Response;

const realFetch = globalThis.fetch;
let handler: Handler = () => new Response('{}', { status: 500 });
let requests = 0;
/** KALANLAR 6.5: SDK'nın `fetch`'e verdiği sinyal kesildi mi (istek gerçekten kesildi). */
let fetchAborted = 0;

vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes('/v1/messages')) return realFetch(input, init);
  requests++;
  init?.signal?.addEventListener('abort', () => fetchAborted++, { once: true });
  return handler(init);
});

const enc = new TextEncoder();
const frame = ([event, data]: Ev) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const sseHeaders = { 'content-type': 'text/event-stream', 'request-id': 'req_test' };

const messageStart = (input: number): Ev => [
  'message_start',
  {
    type: 'message_start',
    message: {
      id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: input, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  },
];
const overloadedEvent: Ev = ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }];

/** Olaylar tek tek verilir; `brokenAfter` verilirse sonra bağlantı kopar. */
const sse = (evs: Ev[], brokenAfter = false): Handler => () => {
  let i = 0;
  return new Response(
    new ReadableStream({
      pull(c) {
        if (i < evs.length) c.enqueue(frame(evs[i++]!));
        else if (brokenAfter) c.error(new TypeError('terminated'));
        else c.close();
      },
    }),
    { status: 200, headers: sseHeaders },
  );
};

const schema = z.object({ value: z.string() });
const silent: MeterLog = { warn: () => undefined, error: () => undefined };
let A: Awaited<ReturnType<typeof registerCompany>>;
const ctx = (over: Partial<AiCallContext> = {}): AiCallContext => ({ companyId: A.companyId, memberId: A.userId, kind: 'TARIFF_REVIEW', limits: {}, log: silent, ...over });
const call = (content: string) => meteredCall(ctx(), { schema, system: 'sys', maxTokens: 50, effort: 'low', content: [{ type: 'text', text: content }] });
const rows = () => inCompany(A.companyId, () => prisma.aiUsage.findMany({ where: { companyId: A.companyId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));

const saved: Record<string, string | undefined> = {};
beforeAll(async () => {
  A = await registerCompany(await getApp(), uniq('Akış hatası '));
});
beforeEach(async () => {
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_MODEL']) saved[k] = process.env[k];
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.CLAUDE_MODEL = 'claude-sonnet-5-5';
  requests = 0;
  fetchAborted = 0;
  resetAiMeterState();
  await inCompany(A.companyId, () => prisma.aiUsage.deleteMany({}));
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe('gerçek SDK: akış içi hata', () => {
  it('yanıt başlamadan akış içi aşırı yük: 503 AI_BUSY, iş için geçici, satır 0 TL; hatırlanmaz', async () => {
    handler = sse([overloadedEvent]);
    const err = await call('akışta yoğun').catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 503, code: 'AI_BUSY' });
    expect(isTransientJobError(err)).toBe(true);
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'FAILED', errorCode: 'AI_BUSY', inputTokens: 0 });
    expect(row!.cost.toString()).toBe('0');
    // hatırlanmadı: aynı içerik yeniden sağlayıcıya gider
    handler = sse([messageStart(1), ['message_stop', { type: 'message_stop' }]]);
    await call('akışta yoğun').catch(() => undefined);
    expect(requests).toBe(2);
  });

  it('message_start sonrası akış içi aşırı yük (girdi ücretli): iş için kalıcı', async () => {
    handler = sse([messageStart(800), overloadedEvent]);
    const err = await call('ücretli yoğun').catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 503, code: 'AI_BUSY' });
    expect(isTransientJobError(err)).toBe(false);
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'FAILED', inputTokens: 800 });
    expect(Number(row!.cost)).toBeGreaterThan(0);
  });

  it('message_start sonrası bağlantı koptu (SDK AnthropicError): iş için kalıcı', async () => {
    handler = sse([messageStart(800)], true);
    const err = await call('ücretli kopma').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: expect.stringMatching(/^AI_/) });
    expect(isTransientJobError(err)).toBe(false);
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'FAILED', inputTokens: 800 });
  });
});

// ---------- KALANLAR 6.5: vazgeçince süren çağrı kesilir ----------

const textDone = (text: string, output: number): Ev[] => [
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: output } }],
  ['message_stop', { type: 'message_stop' }],
];

/**
 * `head` olayları hemen gider, sonra akış bekler: `fetch`'in sinyali kesilirse gövde hata verir (gerçek `fetch` gibi);
 * kesilmezse `ms` sonra `tail` ile tamamlanır (bugünkü davranışta çağrı sonuna kadar sürer).
 */
const hanging =
  (head: Ev[], ms: number, tail: Ev[]): Handler =>
  (init) =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const e of head) c.enqueue(frame(e));
          const t = setTimeout(() => {
            for (const e of tail) c.enqueue(frame(e));
            c.close();
          }, ms);
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              try {
                c.error(new DOMException('aborted', 'AbortError'));
              } catch {
                // akış zaten kapandı
              }
            },
            { once: true },
          );
        },
      }),
      { status: 200, headers: sseHeaders },
    );

async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('bekleme süresi doldu');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const OK_TEXT = JSON.stringify({ value: 'ok' });
const signalled = (content: string, signal: AbortSignal | undefined, cache = false) =>
  meteredCall(ctx(signal ? { signal } : {}), { schema, system: 'sys', maxTokens: 50, effort: 'low', cache, content: [{ type: 'text', text: content }] });

describe('KALANLAR 6.5: durdurma sinyali süren çağrıyı keser', () => {
  it('message_start sonrası durdurma: istek kesilir (fetch sinyali), AI_CANCELLED, satır FAILED; girdi sağlayıcının sayısı, çıktı üst tahmin', async () => {
    handler = hanging([messageStart(800)], 1500, textDone(OK_TEXT, 20));
    const ac = new AbortController();
    const p = signalled('kesilecek', ac.signal).catch((e: unknown) => e);
    await until(() => requests === 1);
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    ac.abort();
    const err = await p;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(err).toMatchObject({ code: 'AI_CANCELLED' });
    expect(isTransientJobError(err)).toBe(false);
    expect(fetchAborted).toBe(1);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'FAILED', errorCode: 'AI_CANCELLED', inputTokens: 800, estimated: true });
    // çıktı bilinmiyor: geçen süreyle üst tahmin (en az 1, en çok `maxTokens`)
    expect(all[0]!.outputTokens).toBeGreaterThanOrEqual(1);
    expect(all[0]!.outputTokens).toBeLessThanOrEqual(50);
    expect(Number(all[0]!.cost)).toBeGreaterThan(0);
    // hatırlanmaz: aynı içerik yeniden sağlayıcıya gider
    handler = sse([messageStart(800), ...textDone(OK_TEXT, 20)]);
    await expect(signalled('kesilecek', undefined)).resolves.toMatchObject({ data: { value: 'ok' } });
    expect(requests).toBe(2);
  });

  it('yanıt başlamadan durdurma: girdi istek boyundan tahmin edilir (fazla sayılır), satır işaretli', async () => {
    handler = hanging([], 1500, [messageStart(800), ...textDone(OK_TEXT, 20)]);
    const ac = new AbortController();
    const p = signalled('başlamadan', ac.signal).catch((e: unknown) => e);
    await until(() => requests === 1);
    ac.abort();
    expect(await p).toMatchObject({ code: 'AI_CANCELLED' });
    expect(fetchAborted).toBe(1);
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'FAILED', errorCode: 'AI_CANCELLED', estimated: true });
    expect(row!.inputTokens).toBeGreaterThan(0);
    expect(Number(row!.cost)).toBeGreaterThan(0);
  });

  it('önceden kesilmiş sinyal: sağlayıcıya gidilmez, satır yazılmaz', async () => {
    handler = sse([messageStart(800), ...textDone(OK_TEXT, 20)]);
    const ac = new AbortController();
    ac.abort();
    expect(await signalled('hiç', ac.signal).catch((e: unknown) => e)).toMatchObject({ code: 'AI_CANCELLED' });
    expect(requests).toBe(0);
    expect(await rows()).toHaveLength(0);
  });

  it('tek uçuş: süren çağrıyı bekleyen ikinci istek durdurulan çağrıyla düşmez, kendisi çağırır', async () => {
    const tail = textDone(OK_TEXT, 20);
    const first = hanging([messageStart(800)], 1500, tail);
    const second = sse([messageStart(800), ...tail]);
    handler = (init) => (requests === 1 ? first(init) : second(init));
    const ac = new AbortController();
    const p1 = signalled('ortak', ac.signal, true).catch((e: unknown) => e);
    await until(() => requests === 1);
    const p2 = signalled('ortak', undefined, true);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    expect(await p1).toMatchObject({ code: 'AI_CANCELLED' });
    await expect(p2).resolves.toMatchObject({ data: { value: 'ok' }, cached: false });
    expect(requests).toBe(2);
    expect((await rows()).map((r) => [r.status, r.errorCode])).toEqual([
      ['FAILED', 'AI_CANCELLED'],
      ['OK', null],
    ]);
  });
});

describe('KALANLAR 6.5: kesilen çağrının üst tahmini', () => {
  it('çıktı: saniyede 110 token (gerçekçi üretim hızı), en az 1, en çok maxTokens; bilinen girdi aynen', () => {
    const call = { system: 'sys', content: [{ type: 'text', text: 'x' }], schema, maxTokens: 64000 };
    const known = { model: 'claude-sonnet-5-5', inputTokens: 800, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, iterations: null };
    expect(AI_CANCEL_OUTPUT_TOKENS_PER_SEC).toBe(110);
    expect(cancelledUsage(call, known, 10_000, true)).toMatchObject({ inputTokens: 800, outputTokens: 1100, estimated: true });
    expect(cancelledUsage(call, known, 0, true)!.outputTokens).toBe(1);
    expect(cancelledUsage({ ...call, maxTokens: 500 }, known, 60_000, true)!.outputTokens).toBe(500);
    expect(cancelledUsage(call, null, 0, false)).toBeNull();
  });
});
