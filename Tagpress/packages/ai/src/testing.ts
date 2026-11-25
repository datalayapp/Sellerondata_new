/**
 * Sahte sağlayıcılar: deterministik, ağsız. Sunucu ve diğer paketlerin testleri kullanır.
 *
 *   import { createFakeClaude, createFakeGemini, reply } from "@tagpress/ai/testing";
 *
 * Sahte Claude GERÇEK istemciyi (`createClaude`) sahte bir fetch ile çalıştırır: yeniden deneme, kesilme,
 * onarım ve doğrulama mantığı testte de aynen çalışır. Kaydedilen istekler `requests` dizisindedir.
 */
import { MODELS, type Usage } from "@tagpress/domain";
import { type ClaudeOptions, type ClaudePort, createClaude } from "./claude.ts";
import type { ImagePort, ImageRequest, ImageResult } from "./gemini.ts";
import { makeFailure } from "./errors.ts";

export interface FakeReply {
  /** Yanıt metni. */
  text?: string;
  /** Yanıt nesnesi (JSON.stringify edilir). `text` ile birlikte verilmez. */
  json?: unknown;
  stopReason?: "end_turn" | "max_tokens" | "refusal";
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  /** HTTP hata yanıtı. */
  status?: number;
  error?: { type: string; message: string };
  headers?: Record<string, string>;
  /** Bağlantı hatası (fetch istisna fırlatır). */
  network?: boolean;
}

/** İstek gövdesine göre yanıt üreten fonksiyon da verilebilir. */
export type FakeReplySource = FakeReply | ((body: AnthropicRequestBody, index: number) => FakeReply);

export interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  system: string | Array<{ type: string; text: string; cache_control?: unknown }>;
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; source?: { data: string } }> }>;
  output_config?: { format?: { type: string; schema: unknown }; effort?: string };
  thinking?: unknown;
}

export const reply = {
  json: (json: unknown, extra: Partial<FakeReply> = {}): FakeReply => ({ json, ...extra }),
  text: (text: string, extra: Partial<FakeReply> = {}): FakeReply => ({ text, ...extra }),
  truncated: (text = '{"candidates": [', extra: Partial<FakeReply> = {}): FakeReply => ({ text, stopReason: "max_tokens", ...extra }),
  rateLimit: (retryAfterSec?: number): FakeReply => ({
    status: 429,
    error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit" },
    ...(retryAfterSec !== undefined ? { headers: { "retry-after": String(retryAfterSec) } } : {}),
  }),
  quota: (): FakeReply => ({ status: 400, error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }),
  auth: (): FakeReply => ({ status: 401, error: { type: "authentication_error", message: "invalid x-api-key" } }),
  overloaded: (): FakeReply => ({ status: 529, error: { type: "overloaded_error", message: "Overloaded" } }),
  network: (): FakeReply => ({ network: true }),
};

/** Anthropic Messages API'sini taklit eden fetch. */
export function fakeAnthropicFetch(replies: FakeReplySource[]): { fetch: typeof fetch; requests: AnthropicRequestBody[] } {
  const requests: AnthropicRequestBody[] = [];
  let i = 0;
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as AnthropicRequestBody;
    requests.push(body);
    const index = i++;
    const src = replies[index];
    if (!src) throw new Error(`Sahte Claude: ${index + 1}. istek için kayıtlı yanıt yok.`);
    const r = typeof src === "function" ? src(body, index) : src;
    if (r.network) throw new TypeError("fetch failed");
    const headers = { "content-type": "application/json", "request-id": `req_fake_${index}`, ...(r.headers ?? {}) };
    if (r.status && r.status >= 400) {
      return new Response(JSON.stringify({ type: "error", error: r.error ?? { type: "api_error", message: "error" } }), { status: r.status, headers });
    }
    const text = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : "");
    const msg = {
      id: `msg_fake_${index}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text }],
      stop_reason: r.stopReason ?? "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...(r.usage ?? {}) },
    };
    return new Response(JSON.stringify(msg), { status: 200, headers });
  }) as typeof fetch;
  return { fetch: fetchFn, requests };
}

export interface FakeClaude {
  claude: ClaudePort;
  requests: AnthropicRequestBody[];
  /** Bekleme çağrıları (ms). */
  sleeps: number[];
}

/** Gerçek istemci + sahte fetch + anında bekleme. */
export function createFakeClaude(replies: FakeReplySource[], opts: Partial<ClaudeOptions> = {}): FakeClaude {
  const f = fakeAnthropicFetch(replies);
  const sleeps: number[] = [];
  const claude = createClaude({
    apiKey: "sk-test",
    model: MODELS.daily,
    fetch: f.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...opts,
  });
  return { claude, requests: f.requests, sleeps };
}

/** İstekteki kullanıcı metinlerini birleştirir (test denetimleri için). */
export function requestText(body: AnthropicRequestBody): string {
  return body.messages
    .flatMap((m) => (typeof m.content === "string" ? [m.content] : m.content.map((c) => c.text ?? "")))
    .join("\n");
}

export function systemText(body: AnthropicRequestBody): string {
  return typeof body.system === "string" ? body.system : body.system.map((s) => s.text).join("\n");
}

// ── Sahte Gemini ───────────────────────────────────────────────────────────────────────────────────

export type FakeImageReply = Buffer | { png?: Buffer; error?: Parameters<typeof makeFailure>[0]; note?: string } | ((req: ImageRequest, index: number) => Buffer | Promise<Buffer>);

export interface FakeGemini extends ImagePort {
  requests: ImageRequest[];
}

/** Kayıtlı görselleri sırayla döndüren görüntü portu. */
export function createFakeGemini(replies: FakeImageReply[], model: string = MODELS.image): FakeGemini {
  const requests: ImageRequest[] = [];
  let i = 0;
  return {
    model,
    requests,
    async generate(req: ImageRequest): Promise<ImageResult> {
      requests.push(req);
      const index = i++;
      const src = replies[index];
      const usage: Usage = { model, inputTokens: 0, outputTokens: 0, images: 1 };
      if (!src) throw new Error(`Sahte Gemini: ${index + 1}. istek için kayıtlı görsel yok.`);
      if (typeof src === "function") return { ok: true, png: await src(req, index), note: "", usage, ms: 1, endpoint: "fake" };
      if (Buffer.isBuffer(src)) return { ok: true, png: src, note: "", usage, ms: 1, endpoint: "fake" };
      if (src.error) return { ok: false, note: "", usage: { ...usage, images: 0 }, ms: 1, error: makeFailure(src.error), endpoint: "fake" };
      return { ok: true, png: src.png!, note: src.note ?? "", usage, ms: 1, endpoint: "fake" };
    },
  };
}

export interface GeminiFakeRoute {
  /** "interactions" ya da "generateContent". */
  endpoint: "interactions" | "generateContent";
  status?: number;
  body?: unknown;
}

/** Gemini REST uç noktalarını taklit eden fetch (istemci testleri için). */
export function fakeGeminiFetch(routes: GeminiFakeRoute[]): { fetch: typeof fetch; requests: Array<{ url: string; body: unknown }> } {
  const requests: Array<{ url: string; body: unknown }> = [];
  let i = 0;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    requests.push({ url: u, body: JSON.parse(String(init?.body ?? "{}")) });
    const route = routes[i++];
    if (!route) throw new Error(`Sahte Gemini fetch: ${i}. istek için yanıt yok (${u}).`);
    const expected = route.endpoint === "interactions" ? /\/interactions$/ : /:generateContent$/;
    if (!expected.test(u)) throw new Error(`Sahte Gemini fetch: beklenen ${route.endpoint}, gelen ${u}`);
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fetchFn, requests };
}
