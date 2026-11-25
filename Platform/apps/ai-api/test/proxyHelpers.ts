import type { FastifyInstance } from 'fastify';
import { AI_HEADERS, type AiProvider } from '@sellerondata/contracts';
import { buildApp, type BuildAppOptions } from '../src/app.ts';
import { getPrisma } from '../src/db.ts';
import { resetKeys, superClient, type TestAccount } from './helpers.ts';

/** Vekil testleri (G2): sahte sağlayıcı, bağlam başlıkları, defter satırları. */

export type UpstreamCall = { url: string; method: string; headers: Record<string, string>; body: Buffer; signal: AbortSignal | null };
export type UpstreamHandler = (call: UpstreamCall) => Response | Promise<Response>;

/** Sahte sağlayıcı: her yukarı akış isteğini kaydeder, yanıtı `handler` verir (testte değiştirilir). */
export function fakeUpstream(initial?: UpstreamHandler) {
  const calls: UpstreamCall[] = [];
  let handler: UpstreamHandler = initial ?? (() => json({ ok: true }));
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const b = init?.body;
    const body = b == null ? Buffer.alloc(0) : typeof b === 'string' ? Buffer.from(b) : Buffer.from(b as Uint8Array);
    const call = { url, method: init?.method ?? 'GET', headers, body, signal: init?.signal ?? null };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    calls,
    set(h: UpstreamHandler) {
      handler = h;
    },
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_up_1', ...headers } });
}

/** Parça parça akan gövde (her parça ayrı `enqueue`; `delayMs` parçalar arası bekleme; `failAfter` o parçadan sonra kopar). */
export function chunked(
  parts: (string | Uint8Array)[],
  opts: { status?: number; headers?: Record<string, string>; delayMs?: number; failAfter?: number; hangAfter?: number; signal?: AbortSignal | null } = {},
) {
  const enc = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      // Gerçek fetch gibi: istek iptal edilince gövde hata verir.
      opts.signal?.addEventListener('abort', () => {
        try {
          c.error(new DOMException('aborted', 'AbortError'));
        } catch {
          /* zaten kapalı */
        }
      });
    },
    async pull(c) {
      if (opts.hangAfter !== undefined && i >= opts.hangAfter) return new Promise<void>(() => {});
      if (opts.failAfter !== undefined && i >= opts.failAfter) {
        c.error(new TypeError('terminated'));
        return;
      }
      if (i >= parts.length) {
        c.close();
        return;
      }
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const p = parts[i++]!;
      c.enqueue(typeof p === 'string' ? enc.encode(p) : p);
    },
  });
  return new Response(stream, { status: opts.status ?? 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_up_sse', ...opts.headers } });
}

type Ev = [string, unknown];
export const sseFrame = ([event, data]: Ev) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** Anthropic akış olayları (kullanım: message_start + message_delta). */
export function anthropicEvents(o: {
  model?: string;
  input: number;
  output: number;
  cacheRead?: number;
  cache5m?: number;
  cache1h?: number;
  text?: string;
  stop?: boolean;
}): Ev[] {
  const cacheCreation = (o.cache5m ?? 0) + (o.cache1h ?? 0);
  const evs: Ev[] = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: o.model ?? 'claude-sonnet-5-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: o.input,
            output_tokens: 1,
            cache_read_input_tokens: o.cacheRead ?? 0,
            cache_creation_input_tokens: cacheCreation,
            cache_creation: { ephemeral_5m_input_tokens: o.cache5m ?? 0, ephemeral_1h_input_tokens: o.cache1h ?? 0 },
          },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['ping', { type: 'ping' }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: o.text ?? 'Merhaba dünya' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: o.output } }],
  ];
  if (o.stop !== false) evs.push(['message_stop', { type: 'message_stop' }]);
  return evs;
}

export function anthropicMessage(o: { model?: string; input: number; output: number; cacheRead?: number; cache5m?: number; cache1h?: number; text?: string }) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: o.model ?? 'claude-sonnet-5-5',
    content: [{ type: 'text', text: o.text ?? 'Merhaba' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: o.input,
      output_tokens: o.output,
      cache_read_input_tokens: o.cacheRead ?? 0,
      cache_creation_input_tokens: (o.cache5m ?? 0) + (o.cache1h ?? 0),
      cache_creation: { ephemeral_5m_input_tokens: o.cache5m ?? 0, ephemeral_1h_input_tokens: o.cache1h ?? 0 },
    },
  };
}

/** Gemini yanıtı: metin + `images` adet görsel parçası. */
export function geminiResponse(o: { prompt: number; output: number; cached?: number; thoughts?: number; images?: number; model?: string; usage?: boolean }) {
  const parts: unknown[] = [{ text: 'işte görsel' }];
  for (let i = 0; i < (o.images ?? 0); i++) parts.push({ inlineData: { mimeType: 'image/png', data: Buffer.alloc(64, i).toString('base64') } });
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
    ...(o.usage === false
      ? {}
      : { usageMetadata: { promptTokenCount: o.prompt, candidatesTokenCount: o.output, cachedContentTokenCount: o.cached ?? 0, thoughtsTokenCount: o.thoughts ?? 0 } }),
    modelVersion: o.model ?? 'gemini-3.1-flash-image',
  };
}

export type Ctx = { org?: string; member?: string | null; purpose?: string; requestId?: string; origin?: string; attempt?: number | null };

let seq = 0;
export function newRequestId() {
  seq += 1;
  return `req-${process.pid}-${Date.now()}-${seq}`;
}

/** Bağlam başlıkları (varsayılan: DeciShip, `deciship.invoice_pdf`). */
export function ctxHeaders(o: Ctx = {}): Record<string, string> {
  const h: Record<string, string> = {
    [AI_HEADERS.org]: o.org ?? 'org-a',
    [AI_HEADERS.purpose]: o.purpose ?? 'deciship.invoice_pdf',
    [AI_HEADERS.requestId]: o.requestId ?? newRequestId(),
    [AI_HEADERS.origin]: o.origin ?? 'request',
  };
  if (o.member !== null) h[AI_HEADERS.member] = o.member ?? 'member-1';
  if (o.attempt !== undefined && o.attempt !== null) h[AI_HEADERS.attempt] = String(o.attempt);
  return h;
}

export async function makeProxyApp(account: TestAccount, upstreamFetch: typeof fetch, opts: Omit<BuildAppOptions, 'jwks' | 'prisma' | 'fetch'> = {}): Promise<FastifyInstance> {
  const app = await buildApp({ prisma: getPrisma(), jwks: account.jwks(), fetch: upstreamFetch, ...opts });
  await app.ready();
  return app;
}

export async function setKey(app: FastifyInstance, provider: AiProvider, key: string) {
  const r = await app.aiDeps.keys.set(provider, key, { id: 'cli:test', name: 'test' }, { skipTest: true });
  if (!r.ok) throw new Error('anahtar yazılamadı');
}

export async function resetLedger() {
  const c = await superClient();
  await c.query('TRUNCATE ai."AiCall"');
}

export async function resetAll() {
  await resetKeys();
  await resetLedger();
}

export type LedgerRow = {
  id: string;
  product: string;
  orgId: string;
  memberId: string | null;
  purpose: string;
  origin: string;
  provider: string;
  requestedModel: string;
  servedModel: string | null;
  stream: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  inputImages: number;
  outputImages: number;
  costMicroUsd: number;
  reservedMicroUsd: number;
  priceVersion: string;
  status: string;
  errorCode: string | null;
  httpStatus: number | null;
  estimated: boolean;
  keySource: string;
  toolRequestId: string;
  attempt: number;
  finishedAt: Date | null;
  durationMs: number | null;
  upstreamRequestId: string | null;
};

export async function ledgerRows(where = 'TRUE', params: unknown[] = []): Promise<LedgerRow[]> {
  const c = await superClient();
  const r = await c.query(`SELECT * FROM ai."AiCall" WHERE ${where} ORDER BY "startedAt", attempt`, params);
  return r.rows.map((x) => ({ ...x, costMicroUsd: Number(x.costMicroUsd), reservedMicroUsd: Number(x.reservedMicroUsd) })) as LedgerRow[];
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 5000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor: süre doldu');
    await new Promise((r) => setTimeout(r, 20));
  }
}
