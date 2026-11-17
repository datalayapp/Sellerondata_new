/**
 * Asıl güvence (R1 1c): GERÇEK Anthropic SDK + sahte `fetch` (SSE akış yanıtı). SDK sınıfı sahtelenmez; böylece SDK'nın
 * kendi ayrıştırması, hata yolları ve akış birikimi gerçekten denenir. Kesilme, ret, bozuk biçim, kopma ve süre dolması
 * sayaca gerçek token ve maliyetle yazılır; sonuç vermeyen çağrı kotadan düşmez.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { prisma } from '../src/db.ts';
import { aiAllowance, meteredCall, resetAiMeterState, type AiCallContext, type MeterLog } from '../src/services/aiMeter.ts';
import { getApp, inCompany, registerCompany } from './helpers.ts';

type Ev = [string, unknown];
type Handler = (body: Record<string, unknown>, init: RequestInit) => Response | Promise<Response>;

const realFetch = globalThis.fetch;
let handler: Handler = () => new Response('{}', { status: 500 });
const requests: Record<string, unknown>[] = [];

vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes('/v1/messages')) return realFetch(input, init);
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  requests.push(body);
  return handler(body, init ?? {});
});

const enc = new TextEncoder();
const frame = ([event, data]: Ev) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function events(opts: { text: string; stop: string; input: number; output: number; model?: string }): Ev[] {
  return [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: opts.model ?? 'claude-sonnet-5-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: opts.input, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: opts.text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: opts.stop, stop_sequence: null }, usage: { output_tokens: opts.output } }],
    ['message_stop', { type: 'message_stop' }],
  ];
}

const sseHeaders = { 'content-type': 'text/event-stream', 'request-id': 'req_test' };

/** Tam akış. */
const stream = (evs: Ev[]): Handler => () =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const e of evs) c.enqueue(frame(e));
        c.close();
      },
    }),
    { status: 200, headers: sseHeaders },
  );

/** İlk olaylar okunduktan sonra bağlantı kopar (`error()` kuyruktakini siler: olaylar tek tek verilir). */
const broken = (evs: Ev[]): Handler => () => {
  let i = 0;
  return new Response(
    new ReadableStream({
      pull(c) {
        if (i < evs.length) c.enqueue(frame(evs[i++]!));
        else c.error(new TypeError('terminated'));
      },
    }),
    { status: 200, headers: sseHeaders },
  );
};

/** İlk olaylardan sonra akış durur (asla bitmez); istek kesilince hata verir. */
const stalled = (evs: Ev[]): Handler => (_b, init) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const e of evs) c.enqueue(frame(e));
        init.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
      },
    }),
    { status: 200, headers: sseHeaders },
  );

const schema = z.object({ value: z.string() });
const silent: MeterLog = { warn: () => undefined, error: () => undefined };
let A: Awaited<ReturnType<typeof registerCompany>>;
const ctx = (over: Partial<AiCallContext> = {}): AiCallContext => ({ companyId: A.companyId, memberId: A.userId, kind: 'TARIFF_REVIEW', limits: {}, log: silent, ...over });
const call = (content: string, over: Partial<AiCallContext> = {}, extra: { timeoutMs?: number } = {}) =>
  meteredCall(ctx(over), { schema, system: 'sys', maxTokens: 50, effort: 'low', content: [{ type: 'text', text: content }], ...extra });
const rows = () => inCompany(A.companyId, () => prisma.aiUsage.findMany({ where: { companyId: A.companyId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));

const saved: Record<string, string | undefined> = {};
beforeAll(async () => {
  A = await registerCompany(await getApp(), 'Gerçek SDK');
});
beforeEach(async () => {
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_MODEL', 'API_RATE_LIMIT']) saved[k] = process.env[k];
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.CLAUDE_MODEL = 'claude-sonnet-5-5';
  requests.length = 0;
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

describe('gerçek SDK + sahte akış: sayaç her sonuçta gerçek kullanımı yazar', () => {
  it('başarılı çağrı: OK satırı, yanıttaki token ve kuruşu kuruşuna ücret; biçim SDK\'ya yalnız şema olarak gider', async () => {
    handler = stream(events({ text: JSON.stringify({ value: 'tamam' }), stop: 'end_turn', input: 1000, output: 1000 }));
    const r = await call('başarılı');
    expect(r).toMatchObject({ data: { value: 'tamam' }, cached: false, usage: { model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 1000 } });
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'OK', inputTokens: 1000, outputTokens: 1000 });
    expect(row!.cost.toString()).toBe('1.2');
    const format = (requests[0]!.output_config as { format: Record<string, unknown> }).format;
    expect(format.type).toBe('json_schema');
    expect(format.schema).toMatchObject({ type: 'object', properties: { value: { type: 'string' } } });
    expect(Object.keys(format).sort()).toEqual(['schema', 'type']);
  });

  it('kesilme: 422 AI_TRUNCATED (doğru neden), FAILED satırı gerçek tokenle; kotadan düşmez; aynı içerik yeniden çağrılmaz', async () => {
    handler = stream(events({ text: '{"value": "yar', stop: 'max_tokens', input: 2000, output: 50 }));
    await expect(call('uzun belge')).rejects.toMatchObject({ statusCode: 422, code: 'AI_TRUNCATED', message: expect.stringContaining('bölerek') });
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'FAILED', errorCode: 'AI_TRUNCATED', inputTokens: 2000, outputTokens: 50, estimated: false });
    expect(row!.cost.toString()).toBe('0.45'); // 2000×200 + 50×1000 mikro TL
    expect((await aiAllowance(A.companyId, {})).usedMicros).toBe(0);
    await expect(call('uzun belge')).rejects.toMatchObject({ code: 'AI_TRUNCATED' });
    expect(requests).toHaveLength(1);
    // fresh hatırlamayı atlamaz (yalnız başarılı sonuç önbelleğini atlar)
    await expect(call('uzun belge', { fresh: true })).rejects.toMatchObject({ code: 'AI_TRUNCATED' });
    expect(requests).toHaveLength(1);
  });

  it('ret: 422 AI_REFUSED, FAILED satırı gerçek tokenle', async () => {
    handler = stream(events({ text: '', stop: 'refusal', input: 300, output: 7 }));
    await expect(call('ret')).rejects.toMatchObject({ statusCode: 422, code: 'AI_REFUSED' });
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'FAILED', errorCode: 'AI_REFUSED', inputTokens: 300, outputTokens: 7 });
    expect(row!.cost.toString()).toBe('0.067');
  });

  it('bozuk biçim (şemaya uymayan ve JSON olmayan): 502 AI_FAILED "beklenen biçimde değil", FAILED satırı gerçek tokenle', async () => {
    handler = stream(events({ text: JSON.stringify({ other: 1 }), stop: 'end_turn', input: 100, output: 10 }));
    await expect(call('şema dışı')).rejects.toMatchObject({ statusCode: 502, code: 'AI_FAILED', message: expect.stringContaining('beklenen biçimde') });
    handler = stream(events({ text: 'json değil', stop: 'end_turn', input: 100, output: 10 }));
    await expect(call('json değil')).rejects.toMatchObject({ statusCode: 502, code: 'AI_FAILED', message: expect.stringContaining('beklenen biçimde') });
    const all = await rows();
    expect(all.map((r) => [r.status, r.errorCode, r.inputTokens, r.outputTokens, r.cost.toString()])).toEqual([
      ['FAILED', 'AI_FAILED', 100, 10, '0.03'],
      ['FAILED', 'AI_FAILED', 100, 10, '0.03'],
    ]);
  });

  it('bağlantı yarıda koparsa eldeki kullanım alt sınır olarak yazılır; çıktı tokeni akan metinden tahmin edilir (karakter / 3,5)', async () => {
    const streamed = `{"value":"${'x'.repeat(60)}`; // 70 karakter → en az 20 çıktı tokeni
    expect(streamed).toHaveLength(70);
    handler = broken(events({ text: streamed, stop: 'end_turn', input: 5000, output: 0 }).slice(0, 3));
    await expect(call('kopuk')).rejects.toMatchObject({ code: expect.stringMatching(/^AI_/) });
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'FAILED', inputTokens: 5000, outputTokens: 20, estimated: true }); // Y60: satırda işaret
    expect(row!.cost.toString()).toBe('1.02'); // 5000×200 + 20×1000 mikro TL
    expect(Number(row!.cost)).toBeGreaterThan(0);
  });

  it('akış durursa toplam süre sınırı keser: 504, eldeki kullanım yazılır, yuva bırakılır', async () => {
    process.env.AI_CONCURRENCY_PER_ORG = '1';
    try {
      handler = stalled(events({ text: '{"value":"x"}', stop: 'end_turn', input: 800, output: 0 }).slice(0, 2));
      const t0 = Date.now();
      await expect(call('asılı', {}, { timeoutMs: 300 })).rejects.toMatchObject({ statusCode: 504, code: 'AI_FAILED' });
      expect(Date.now() - t0).toBeLessThan(5_000);
      const [row] = await rows();
      expect(row).toMatchObject({ status: 'FAILED', errorCode: 'AI_FAILED', inputTokens: 800, outputTokens: 1, estimated: false }); // akan metin yok: tahmin yok
      handler = stream(events({ text: JSON.stringify({ value: 'ok' }), stop: 'end_turn', input: 1, output: 1 }));
      await expect(call('sonraki')).resolves.toMatchObject({ cached: false });
    } finally {
      delete process.env.AI_CONCURRENCY_PER_ORG;
    }
  });
});
