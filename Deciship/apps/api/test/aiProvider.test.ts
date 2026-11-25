/**
 * Asıl güvence (R1 1c): GERÇEK Anthropic SDK + sahte `fetch` (SSE akış yanıtı). SDK sınıfı sahtelenmez; böylece SDK'nın
 * kendi ayrıştırması, hata yolları ve akış birikimi gerçekten denenir. Kesilme, ret, bozuk biçim, kopma ve süre dolması
 * sayaca gerçek token ve maliyetle yazılır; sonuç vermeyen çağrı kotadan düşmez.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AI_CHARGED_MAYBE, AI_HEADERS, aiRejectBody, aiRejectHeaders, type AiRejectCode } from '@sellerondata/contracts';
import { prisma } from '../src/db.ts';
import { AiMaybeChargedError, aiAvailable, aiEnabled, aiPlatformPaused } from '../src/services/ai.ts';
import { runInJobScope } from '../src/services/jobs/jobScope.ts';
import { isTransientJobError } from '../src/services/jobs/runner.ts';
import { aiAllowance, meteredCall, resetAiMeterState, type AiCallContext, type MeterLog } from '../src/services/aiMeter.ts';
import { getApp, inCompany, registerCompany } from './helpers.ts';

type Ev = [string, unknown];
type Handler = (body: Record<string, unknown>, init: RequestInit) => Response | Promise<Response>;

const realFetch = globalThis.fetch;
let handler: Handler = () => new Response('{}', { status: 500 });
const requests: Record<string, unknown>[] = [];
/** Sağlayıcıya (ya da geçide) giden her isteğin adresi ve başlıkları (gövde `requests`'te). */
const sent: { url: string; headers: Headers }[] = [];
/** Geçidin `GET /internal/status` yanıtı (DS-AI); null: ulaşılamıyor. */
let statusReply: (() => Response) | null = null;
const statusCalls: { url: string; headers: Headers }[] = [];

vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith('/internal/status')) {
    statusCalls.push({ url, headers: new Headers(init?.headers) });
    if (!statusReply) throw new TypeError('fetch failed');
    return statusReply();
  }
  if (!url.includes('/v1/messages')) return realFetch(input, init);
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  requests.push(body);
  sent.push({ url, headers: new Headers(init?.headers) });
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
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_MODEL', 'API_RATE_LIMIT', 'AI_GATEWAY_URL', 'AI_GATEWAY_TOKEN', 'SOD_ENV']) saved[k] = process.env[k];
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.CLAUDE_MODEL = 'claude-sonnet-5-5';
  for (const k of ['AI_GATEWAY_URL', 'AI_GATEWAY_TOKEN', 'SOD_ENV']) delete process.env[k];
  requests.length = 0;
  sent.length = 0;
  statusCalls.length = 0;
  statusReply = null;
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

/**
 * DS-AI (YAPAY-ZEKA-GECIDI §6, plan §S9): `AI_GATEWAY_URL` doluyken aynı gerçek SDK geçide gider. Geçit isteği değiştirmeden
 * iletir; burada sahte `fetch` geçidin yerine yanıt verir. Ret yanıtları geçidin sözleşmedeki biçimiyle (`aiRejectHeaders`,
 * `aiRejectBody`): SDK `x-should-retry: false`'a uyar, tek istek gider; para kuralı: ret ücretsizdir ve yeniden denenmez (hız reddi
 * hariç: yalnız arka plan işi yeni bir istekle dener).
 */
describe('DS-AI: geçit yolu (AI_GATEWAY_URL)', () => {
  const GATEWAY = 'http://ai-gw.test:4300';
  const TOKEN = 'gecit-jetonu-deciship-0123456789abcdef';
  const CALL_ID = '0197a000-0000-7000-8000-00000000c0de';
  const okStatus = { available: true, paused: false, providers: { anthropic: 'ok', gemini: 'missing' } };
  const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const withCallId =
    (h: Handler): Handler =>
    async (b, i) => {
      const res = await h(b, i);
      const headers = new Headers(res.headers);
      headers.set(AI_HEADERS.callId, CALL_ID);
      return new Response(res.body, { status: res.status, headers });
    };
  /** Geçidin kendi reddi: sözleşmedeki başlık ve gövde (+ defter kimliği). */
  const rejectWith =
    (code: AiRejectCode, status: number, retryAfter?: number): Handler =>
    () =>
      new Response(JSON.stringify(aiRejectBody('anthropic', code)), { status, headers: { ...aiRejectHeaders(code, retryAfter), [AI_HEADERS.callId]: CALL_ID } });

  beforeEach(() => {
    process.env.AI_GATEWAY_URL = `${GATEWAY}/`;
    process.env.AI_GATEWAY_TOKEN = TOKEN;
    statusReply = json(okStatus);
  });

  it('istek geçidin Anthropic yoluna gider; anahtar başlığı = araç jetonu (Authorization yok, sağlayıcı anahtarı hiç gitmez); X-SOD-* bağlamı; satır kimliği = X-SOD-Request-Id; defter kimliği satırda', async () => {
    handler = withCallId(stream(events({ text: JSON.stringify({ value: 'geçit' }), stop: 'end_turn', input: 1000, output: 1000 })));
    const r = await call('geçit başarılı');
    expect(r).toMatchObject({ data: { value: 'geçit' }, cached: false });
    expect(sent).toHaveLength(1);
    const { url, headers } = sent[0]!;
    expect(url).toBe(`${GATEWAY}/internal/anthropic/v1/messages`);
    expect(headers.get('x-api-key')).toBe(TOKEN);
    expect(headers.get('authorization')).toBeNull();
    for (const [, v] of headers) expect(v).not.toContain('test-key');
    expect(headers.get(AI_HEADERS.org)).toBe(A.companyId);
    expect(headers.get(AI_HEADERS.member)).toBe(A.userId);
    expect(headers.get(AI_HEADERS.purpose)).toBe('deciship.tariff_review');
    expect(headers.get(AI_HEADERS.origin)).toBe('request');
    expect(headers.get(AI_HEADERS.sdkRetryCount)).toBe('0');
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'OK', gatewayCallId: CALL_ID, inputTokens: 1000, outputTokens: 1000 });
    expect(headers.get(AI_HEADERS.requestId)).toBe(row!.id);
    // araç içi hak ve ücret bugünkü gibi (DS-AI-2'ye dek): 1,20 TL
    expect(row!.cost.toString()).toBe('1.2');
    // gövde değişmeden: model, yedek model
    expect(requests[0]).toMatchObject({ model: 'claude-sonnet-5-5', fallbacks: 'default' });
  });

  it('arka plan işi: X-SOD-Origin job; kişi yoksa X-SOD-Member gönderilmez; tür amaca eşlenir', async () => {
    handler = stream(events({ text: JSON.stringify({ value: 'iş' }), stop: 'end_turn', input: 10, output: 10 }));
    await meteredCall(ctx({ origin: 'job', memberId: null, kind: 'INVOICE_PDF' }), { schema, system: 'sys', maxTokens: 50, effort: 'low', content: [{ type: 'text', text: 'iş' }] });
    const h = sent[0]!.headers;
    expect(h.get(AI_HEADERS.origin)).toBe('job');
    expect(h.get(AI_HEADERS.member)).toBeNull();
    expect(h.get(AI_HEADERS.purpose)).toBe('deciship.invoice_pdf');
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'OK', gatewayCallId: null });
    expect(h.get(AI_HEADERS.requestId)).toBe(row!.id);
  });

  /** [ret kodu, HTTP, DeciShip kodu, DeciShip HTTP, geçici mi (arka plan işi yeni istekle dener)] */
  const REJECTS: [AiRejectCode, number, string, number, boolean][] = [
    ['sod_platform_paused', 429, 'AI_PLATFORM_PAUSED', 429, false],
    ['sod_org_cap', 429, 'AI_SPEND_CAP', 429, false],
    ['sod_tool_cap', 429, 'AI_SPEND_CAP', 429, false],
    ['sod_rate_limited', 429, 'AI_BUSY', 503, true],
    ['sod_provider_missing', 503, 'AI_DISABLED', 503, false],
    ['sod_org_closed', 403, 'ORG_CLOSED', 409, false],
    ['sod_unauthorized', 401, 'AI_FAILED', 502, false],
    ['sod_context_invalid', 400, 'AI_FAILED', 502, false],
    ['sod_purpose_unknown', 400, 'AI_FAILED', 502, false],
    ['sod_model_not_allowed', 400, 'AI_FAILED', 502, false],
    ['sod_body_too_large', 413, 'AI_FAILED', 502, false],
  ];

  it.each(REJECTS)('ret %s (%i) → %s (%i): SDK yeniden denemez (tek istek), satır FAILED ücretsiz; geçici: %s', async (reject, status, code, statusCode, transient) => {
    const errors: unknown[] = [];
    const log: MeterLog = { warn: () => undefined, error: (o) => errors.push(o) };
    handler = rejectWith(reject, status, reject === 'sod_rate_limited' ? 7 : undefined);
    const err = await call(`ret ${reject}`, { log }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code, statusCode });
    expect(isTransientJobError(err)).toBe(transient);
    // SDK `x-should-retry: false`'a uydu: geçide tek istek
    expect(requests).toHaveLength(1);
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'FAILED', errorCode: code, inputTokens: 0, outputTokens: 0, gatewayCallId: CALL_ID });
    expect(row!.cost.toString()).toBe('0');
    expect((await aiAllowance(A.companyId, {})).usedMicros).toBe(0);
    if (reject === 'sod_rate_limited') expect(err).toMatchObject({ retryAfter: 7 });
    // kurulum hatası günlükte error (ret kodu ile); kullanıcıya genel metin
    if (code === 'AI_FAILED') expect(errors).toContainEqual(expect.objectContaining({ reject }));
  });

  it('tavan reddi: firmanın hak metni, yeni dönemin günü firmanın saat diliminde; tutar ve yüzde yok; hatırlanmaz (yeni istek yine geçide gider)', async () => {
    handler = rejectWith('sod_org_cap', 429);
    const err = (await call('tavan').catch((e: unknown) => e)) as { message: string; details: Record<string, unknown> };
    const a = await aiAllowance(A.companyId, {});
    const day = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: a.timeZone }).format(a.resetsAt);
    expect(err.message).toContain(day);
    expect(err.details).toEqual({ period: a.period, resetsAt: a.resetsAt.toISOString() });
    await expect(call('tavan')).rejects.toMatchObject({ code: 'AI_SPEND_CAP' });
    expect(requests).toHaveLength(2);
  });

  it('platform durdurulmuş (geçidin durumu): sağlayıcıya gitmeden 429 AI_PLATFORM_PAUSED, satır yok; /me kapalı der; önbellekteki sonuç çalışır', async () => {
    handler = stream(events({ text: JSON.stringify({ value: 'önbellek' }), stop: 'end_turn', input: 10, output: 10 }));
    const cachedCall = () => meteredCall(ctx(), { schema, system: 'sys', maxTokens: 50, effort: 'low', cache: true, content: [{ type: 'text', text: 'aynı' }] });
    await cachedCall();
    resetAiMeterState();
    statusReply = json({ available: false, paused: true, providers: { anthropic: 'ok', gemini: 'missing' } });
    expect(await aiAvailable()).toBe(false);
    expect(aiEnabled()).toBe(true);
    const before = requests.length;
    await expect(call('durdu')).rejects.toMatchObject({ statusCode: 429, code: 'AI_PLATFORM_PAUSED' });
    expect(requests).toHaveLength(before);
    expect((await rows()).filter((r) => r.status === 'FAILED')).toEqual([]);
    await expect(cachedCall()).resolves.toMatchObject({ cached: true, data: { value: 'önbellek' } });
    expect(requests).toHaveLength(before);
    // durum sorusu araç jetonuyla, geçidin durum yoluna
    expect(statusCalls[0]).toMatchObject({ url: `${GATEWAY}/internal/status` });
    expect(statusCalls[0]!.headers.get('x-api-key')).toBe(TOKEN);
  });

  it('geçitte Anthropic anahtarı yok: aiEnabled false, çağrı 503 AI_DISABLED, geçide gitmez; durum 30 sn önbellekte', async () => {
    statusReply = json({ available: false, paused: false, providers: { anthropic: 'missing', gemini: 'missing' } });
    expect(await aiAvailable()).toBe(false);
    expect(aiEnabled()).toBe(false);
    await expect(call('anahtarsız')).rejects.toMatchObject({ statusCode: 503, code: 'AI_DISABLED' });
    expect(requests).toHaveLength(0);
    await aiAvailable();
    expect(statusCalls).toHaveLength(1);
  });

  it('geçit ret verince durum hemen bilinir: anahtar yok reddinden sonra yeni çağrı geçide gitmez', async () => {
    handler = rejectWith('sod_provider_missing', 503);
    await expect(call('ilk')).rejects.toMatchObject({ code: 'AI_DISABLED' });
    expect(aiEnabled()).toBe(false);
    await expect(call('ikinci')).rejects.toMatchObject({ code: 'AI_DISABLED' });
    expect(requests).toHaveLength(1);
  });

  it('geçidin durumuna ulaşılamıyor: durum bilinmez, çağrı geçide gider (geçit de yoksa geçici bağlantı hatası, ücret yok)', async () => {
    statusReply = null;
    expect(await aiAvailable()).toBe(true);
    handler = () => {
      throw new TypeError('fetch failed');
    };
    const err = await call('ulaşılamaz').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'AI_FAILED', statusCode: 503 });
    expect(isTransientJobError(err)).toBe(true);
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'FAILED', inputTokens: 0, outputTokens: 0 });
    expect(row!.cost.toString()).toBe('0');
  });

  it('geçidin durum yanıtı bozuk ya da jeton yanlış (401): durum bilinmez sayılır (çağrı geçide gider, ret doğru koda eşlenir)', async () => {
    statusReply = json({ type: 'error', error: { type: 'sod_unauthorized' } }, 401);
    expect(await aiAvailable()).toBe(true);
    resetAiMeterState();
    statusReply = json({ available: 'evet' });
    expect(await aiAvailable()).toBe(true);
  });

  it('sağlayıcının kendi hatası geçitten değişmeden gelir: 529 → AI_BUSY (geçici); x-sod-ai-reject yoksa geçidin reddi sanılmaz', async () => {
    handler = () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), {
        status: 529,
        headers: { 'content-type': 'application/json', 'x-should-retry': 'false' },
      });
    const err = await call('aşırı yük').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'AI_BUSY' });
    expect(isTransientJobError(err)).toBe(true);
  });

  it('R2: geçidin 5xx\'i "ücret doğmuş olabilir" (x-sod-ai-charged: maybe): SDK yeniden denemez, iş yeniden denemez (kalıcı), satır üst tahminle; başlıksız 5xx geçici kalır', async () => {
    const gatewayError = (charged: boolean) => () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream unreachable' } }), {
        status: 502,
        headers: { 'content-type': 'application/json', [AI_HEADERS.shouldRetry]: 'false', [AI_HEADERS.callId]: CALL_ID, ...(charged ? { [AI_HEADERS.charged]: AI_CHARGED_MAYBE } : {}) },
      });
    handler = gatewayError(true);
    const err = await call('ücret belki').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiMaybeChargedError);
    expect(err).toMatchObject({ code: 'AI_FAILED', statusCode: 502 });
    expect(isTransientJobError(err)).toBe(false);
    expect(requests).toHaveLength(1);
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'FAILED', errorCode: 'AI_FAILED', gatewayCallId: CALL_ID, estimated: true });
    expect(row!.inputTokens).toBeGreaterThan(0);
    expect(Number(row!.cost)).toBeGreaterThan(0);
    // Karşı deneme: aynı 5xx başlıksız (ücretsiz) → bugünkü gibi geçici.
    resetAiMeterState();
    handler = gatewayError(false);
    const plain = await call('ücretsiz 5xx').catch((e: unknown) => e);
    expect(plain).not.toBeInstanceOf(AiMaybeChargedError);
    expect(isTransientJobError(plain)).toBe(true);
  });

  it('R2: yalnız gerçek platform durdurması 30 sn "durdu" sayılır; geçici ret (sod_rate_limited) ve tavan reddi durumu değiştirmez', async () => {
    for (const [code, status] of [['sod_rate_limited', 429], ['sod_tool_cap', 429], ['sod_org_cap', 429]] as const) {
      resetAiMeterState();
      handler = rejectWith(code, status, code === 'sod_rate_limited' ? 15 : undefined);
      await call(`ret ${code}`).catch(() => undefined);
      expect(aiPlatformPaused(), code).toBe(false);
      expect(await aiAvailable(), code).toBe(true);
    }
    resetAiMeterState();
    handler = rejectWith('sod_platform_paused', 429);
    await expect(call('durdu')).rejects.toMatchObject({ code: 'AI_PLATFORM_PAUSED' });
    expect(aiPlatformPaused()).toBe(true);
  });

  it('R2: arka plan işinin çağrıları geçide işin kararlı kimliğiyle gider (job:<iş>): aynı iş içinde her çağrı ve yeniden deneme aynı kimlik; satırların kimliği ayrı', async () => {
    handler = stream(events({ text: JSON.stringify({ value: 'iş' }), stop: 'end_turn', input: 10, output: 10 }));
    const jobId = crypto.randomUUID();
    const jobCall = (text: string) =>
      runInJobScope({ jobId, createdAt: new Date() }, () =>
        meteredCall(ctx({ origin: 'job', memberId: null, kind: 'INVOICE_PDF' }), { schema, system: 'sys', maxTokens: 50, effort: 'low', content: [{ type: 'text', text }] }),
      );
    await jobCall('bir');
    await jobCall('iki');
    expect(sent.map((s) => s.headers.get(AI_HEADERS.requestId))).toEqual([`job:${jobId}`, `job:${jobId}`]);
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(new Set(all.map((r) => r.id)).size).toBe(2);
    expect(all.every((r) => r.id !== `job:${jobId}`)).toBe(true);
    // İstek içi çağrı (iş bağlamı olsa da origin request): satırın kimliği.
    await runInJobScope({ jobId, createdAt: new Date() }, () => call('istek'));
    const last = (await rows()).at(-1)!;
    expect(sent.at(-1)!.headers.get(AI_HEADERS.requestId)).toBe(last.id);
  });

  it('doğrudan yol bugünkü gibi: geçit yokken api.anthropic.com, X-SOD-* gönderilmez; üretimde (SOD_ENV=production) geçit yoksa yapay zekâ kapalı', async () => {
    delete process.env.AI_GATEWAY_URL;
    delete process.env.AI_GATEWAY_TOKEN;
    handler = stream(events({ text: JSON.stringify({ value: 'doğrudan' }), stop: 'end_turn', input: 1, output: 1 }));
    await call('doğrudan');
    expect(new URL(sent[0]!.url).origin).toBe('https://api.anthropic.com');
    expect([...sent[0]!.headers.keys()].filter((k) => k.startsWith('x-sod-'))).toEqual([]);
    expect(statusCalls).toHaveLength(0);
    process.env.SOD_ENV = 'production';
    expect(aiEnabled()).toBe(false);
    expect(await aiAvailable()).toBe(false);
    await expect(call('üretim')).rejects.toMatchObject({ code: 'AI_DISABLED' });
    expect(sent).toHaveLength(1);
  });
});
