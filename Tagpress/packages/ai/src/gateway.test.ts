import { AI_HEADERS, MODELS, aiContextHeaders } from "@tagpress/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildBuilderRequest, runBuilderTurn } from "./builder/agent.ts";
import { BuilderModelError, createBuilderModel } from "./builder/model.ts";
import { BUILDER_PROMPT_VERSION } from "./builder/prompt.ts";
import { createClaude } from "./claude.ts";
import { createGemini } from "./gemini.ts";
import { GATEWAY_TIMEOUT_MS, type GatewayCall, type GatewayOptions } from "./gateway.ts";

/**
 * Platform kipi (TP-AI): GERÇEK istemciler (Anthropic SDK, Gemini REST) sahte bir geçide karşı. Giden istek gerçekten
 * SDK'nın gönderdiği başlıklarla incelenir: adres geçidin tabanı, anahtar başlığı = araç jetonu, `Authorization` yok
 * (ortamda `ANTHROPIC_AUTH_TOKEN` olsa da), `X-SOD-*` bağlam başlıkları, aynı mantıksal çağrıda aynı istek kimliği ve
 * artan deneme; yanıttaki `x-sod-ai-call-id` kullanıma geçer; geçidin reddi ve `x-should-retry: false` yeniden denenmez.
 */

const GW = "http://ai-gateway.test:4300";
const TOKEN = "tp-arac-jetonu";
const ORG = "org-a";
const MEMBER = "uye-1";

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
type FakeResponse = { status?: number; body: unknown; headers?: Record<string, string>; contentType?: string };

function fakeGateway(responses: FakeResponse[]) {
  const captured: Captured[] = [];
  let i = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const h: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (h[k] = v));
    captured.push({ url: String(url), headers: h, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const r = responses[i++];
    if (!r) throw new Error("sahte geçit: yanıt yok");
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(body, { status: r.status ?? 200, headers: { "content-type": r.contentType ?? "application/json", "request-id": `req_${i}`, ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return { fn, captured };
}

/** Sunucunun verdiği bağlamın yerine geçen sabit bağlam (gerçeğinde `AiGateway.headers`, firma bağlamından). */
function context(seen: GatewayCall[] = []): GatewayOptions {
  return {
    context: (call) => {
      seen.push(call);
      return aiContextHeaders({ orgId: ORG, memberId: MEMBER, purpose: `tagpress.${call.purpose.replace(/-/g, "_")}`, requestId: call.requestId, origin: "request", attempt: call.attempt });
    },
  };
}

const message = (text: string, extra: Record<string, unknown> = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: MODELS.daily,
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ...extra,
});

const reject = (code: string, status = 429) => ({
  status,
  body: { type: "error", error: { type: code, message: code } },
  headers: { [AI_HEADERS.reject]: code, [AI_HEADERS.shouldRetry]: "false", [AI_HEADERS.callId]: "gc-ret" },
});

let savedAuthToken: string | undefined;
beforeEach(() => {
  // SDK ortamdaki `ANTHROPIC_AUTH_TOKEN`'ı okursa `Authorization` sızardı: geçit kipinde okunmamalı.
  savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = "sizmamali";
});
afterEach(() => {
  if (savedAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  else process.env.ANTHROPIC_AUTH_TOKEN = savedAuthToken;
});

const schema = z.object({ ok: z.boolean() });

describe("Claude geçit kipi (gerçek SDK, sahte geçit)", () => {
  it("istek geçidin Anthropic tabanına gider; x-api-key = jeton, Authorization yok, X-SOD-* var; çağrı kimliği kullanıma geçer", async () => {
    const f = fakeGateway([{ body: message('{"ok":true}'), headers: { [AI_HEADERS.callId]: "gc-1" } }]);
    const seen: GatewayCall[] = [];
    const claude = createClaude({ apiKey: TOKEN, baseURL: `${GW}/internal/anthropic`, fetch: f.fn, gateway: context(seen), sleep: async () => {} });
    const r = await claude.callJson({ system: "s", content: [{ type: "text", text: "x" }], schema, purpose: "design" });
    expect(r.ok).toBe(true);
    expect(f.captured).toHaveLength(1);
    const req = f.captured[0]!;
    expect(req.url).toBe(`${GW}/internal/anthropic/v1/messages`);
    expect(req.headers["x-api-key"]).toBe(TOKEN);
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers[AI_HEADERS.org]).toBe(ORG);
    expect(req.headers[AI_HEADERS.member]).toBe(MEMBER);
    expect(req.headers[AI_HEADERS.purpose]).toBe("tagpress.design");
    expect(req.headers[AI_HEADERS.origin]).toBe("request");
    expect(req.headers[AI_HEADERS.requestId]).toBe(seen[0]!.requestId);
    expect(req.headers[AI_HEADERS.attempt]).toBe("0");
    expect(r.usage[0]!.gatewayCallId).toBe("gc-1");
  });

  it("onarım ve yeniden deneme aynı istek kimliğiyle, artan denemeyle gider", async () => {
    const f = fakeGateway([
      { status: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } },
      { body: message("bozuk") },
      { body: message('{"ok":true}') },
    ]);
    const claude = createClaude({ apiKey: TOKEN, baseURL: `${GW}/internal/anthropic`, fetch: f.fn, gateway: context(), sleep: async () => {} });
    const r = await claude.callJson({ system: "s", content: [{ type: "text", text: "x" }], schema, purpose: "rank" });
    expect(r.ok).toBe(true);
    expect(f.captured).toHaveLength(3);
    const ids = new Set(f.captured.map((c) => c.headers[AI_HEADERS.requestId]));
    expect(ids.size).toBe(1);
    expect(f.captured.map((c) => c.headers[AI_HEADERS.attempt])).toEqual(["0", "1", "2"]);
    for (const c of f.captured) expect(c.headers[AI_HEADERS.purpose]).toBe("tagpress.rank");
  });

  it("geçidin reddi (sod_org_cap, 429) yeniden denenmez; ret kodu ve çağrı kimliği hatada", async () => {
    const f = fakeGateway([reject("sod_org_cap"), { body: message('{"ok":true}') }]);
    const claude = createClaude({ apiKey: TOKEN, baseURL: `${GW}/internal/anthropic`, fetch: f.fn, gateway: context(), sleep: async () => {} });
    const r = await claude.callJson({ system: "s", content: [{ type: "text", text: "x" }], schema, purpose: "design" });
    expect(r.ok).toBe(false);
    expect(f.captured).toHaveLength(1);
    expect(r.error).toMatchObject({ reject: "sod_org_cap", retryable: false, config: true, kind: "quota", gatewayCallId: "gc-ret" });
  });

  it("geçit isteği iletip düştüyse (502, x-should-retry: false) yeniden denenmez (olası çift ücret)", async () => {
    const f = fakeGateway([{ status: 502, body: { type: "error", error: { type: "api_error", message: "upstream" } }, headers: { [AI_HEADERS.shouldRetry]: "false" } }, { body: message('{"ok":true}') }]);
    const claude = createClaude({ apiKey: TOKEN, baseURL: `${GW}/internal/anthropic`, fetch: f.fn, gateway: context(), sleep: async () => {} });
    const r = await claude.callJson({ system: "s", content: [{ type: "text", text: "x" }], schema, purpose: "design" });
    expect(r.ok).toBe(false);
    expect(f.captured).toHaveLength(1);
    expect(r.error).toMatchObject({ retryable: false, config: true });
  });

  it("yerel kip değişmez: bağlam başlığı yok, anahtar x-api-key'de", async () => {
    const f = fakeGateway([{ body: message('{"ok":true}') }]);
    const claude = createClaude({ apiKey: "sk-yerel", baseURL: "https://api.anthropic.test", fetch: f.fn, sleep: async () => {} });
    await claude.callJson({ system: "s", content: [{ type: "text", text: "x" }], schema, purpose: "design" });
    const h = f.captured[0]!.headers;
    expect(h["x-api-key"]).toBe("sk-yerel");
    expect(Object.keys(h).filter((k) => k.startsWith("x-sod-"))).toEqual([]);
  });
});

describe("Gemini geçit kipi (sahte geçit)", () => {
  const png = Buffer.alloc(64, 7).toString("base64");
  const image = { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1290 } };

  it("yalnız generateContent (interactions denenmez); x-goog-api-key = jeton, X-SOD-* var, amaç image", async () => {
    const f = fakeGateway([{ body: image, headers: { [AI_HEADERS.callId]: "gc-g" } }]);
    const g = createGemini({ apiKey: TOKEN, baseUrl: `${GW}/internal/gemini/v1beta`, fetch: f.fn, gateway: context(), sleep: async () => {} });
    const r = await g.generate({ prompt: "p" });
    expect(r.ok).toBe(true);
    expect(f.captured).toHaveLength(1);
    const req = f.captured[0]!;
    expect(req.url).toBe(`${GW}/internal/gemini/v1beta/models/${MODELS.image}:generateContent`);
    expect(req.headers["x-goog-api-key"]).toBe(TOKEN);
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers[AI_HEADERS.purpose]).toBe("tagpress.image");
    expect(req.headers[AI_HEADERS.org]).toBe(ORG);
    expect(r.usage).toMatchObject({ images: 1, gatewayCallId: "gc-g" });
  });

  it("ret (sod_platform_paused) ve x-should-retry: false yeniden denenmez", async () => {
    const f = fakeGateway([{ ...reject("sod_platform_paused"), body: { error: { code: 429, message: "paused", status: "RESOURCE_EXHAUSTED", reason: "sod_platform_paused" } } }]);
    const g = createGemini({ apiKey: TOKEN, baseUrl: `${GW}/internal/gemini/v1beta`, fetch: f.fn, gateway: context(), sleep: async () => {} });
    const r = await g.generate({ prompt: "p" });
    expect(r.ok).toBe(false);
    expect(f.captured).toHaveLength(1);
    expect(r.error).toMatchObject({ reject: "sod_platform_paused", retryable: false, config: true, gatewayCallId: "gc-ret" });

    const f2 = fakeGateway([{ status: 504, body: { error: { code: 504, message: "timeout" } }, headers: { [AI_HEADERS.shouldRetry]: "false" } }, { body: image }]);
    const g2 = createGemini({ apiKey: TOKEN, baseUrl: `${GW}/internal/gemini/v1beta`, fetch: f2.fn, gateway: context(), sleep: async () => {} });
    const r2 = await g2.generate({ prompt: "p" });
    expect(r2.ok).toBe(false);
    expect(f2.captured).toHaveLength(1);
  });
});

describe("oluşturucu modeli geçit kipi (gerçek SDK)", () => {
  const sse = (events: Array<Record<string, unknown>>) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const usage = { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const stream = sse([
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: MODELS.builder, content: [], stop_reason: null, stop_sequence: null, usage } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Tamam." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ]);

  it("sayım ve akış aynı istek kimliğiyle; jeton x-api-key'de, Authorization yok; çağrı kimliği yanıtta", async () => {
    const f = fakeGateway([
      { body: { input_tokens: 1234 } },
      { body: stream, contentType: "text/event-stream", headers: { [AI_HEADERS.callId]: "gc-b" } },
    ]);
    const model = createBuilderModel({ apiKey: TOKEN, baseURL: `${GW}/internal/anthropic`, fetch: f.fn, gateway: { ...context(), purpose: "builder-turn" } });
    expect(await model.countTokens({ model: model.model, messages: [{ role: "user", content: "x" }] })).toBe(1234);
    const msg = await model.stream(buildBuilderRequest(model.model, BUILDER_PROMPT_VERSION, [{ role: "user", content: "x" }]));
    expect(msg.gatewayCallId).toBe("gc-b");
    expect(f.captured[0]!.url).toBe(`${GW}/internal/anthropic/v1/messages/count_tokens?beta=true`);
    expect(f.captured[1]!.url).toBe(`${GW}/internal/anthropic/v1/messages?beta=true`);
    for (const c of f.captured) {
      expect(c.headers["x-api-key"]).toBe(TOKEN);
      expect(c.headers.authorization).toBeUndefined();
      expect(c.headers[AI_HEADERS.purpose]).toBe("tagpress.builder_turn");
    }
    expect(f.captured[0]!.headers[AI_HEADERS.requestId]).toBe(f.captured[1]!.headers[AI_HEADERS.requestId]);
    expect(f.captured.map((c) => c.headers[AI_HEADERS.attempt])).toEqual(["0", "1"]);
  });

  it("geçidin reddi oluşturucuda yeniden denenmez (BuilderModelError, retryable false)", async () => {
    const f = fakeGateway([reject("sod_tool_cap")]);
    const model = createBuilderModel({ apiKey: TOKEN, baseURL: `${GW}/internal/anthropic`, fetch: f.fn, gateway: { ...context(), purpose: "builder-turn" } });
    const e = await model.stream(buildBuilderRequest(model.model, BUILDER_PROMPT_VERSION, [{ role: "user", content: "x" }])).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BuilderModelError);
    expect((e as BuilderModelError).failure).toMatchObject({ reject: "sod_tool_cap", retryable: false, kind: "quota", gatewayCallId: "gc-ret" });
  });
});

/**
 * Para incelemesi R2b: istek sağlayıcıya ulaşmış olabilecekken (yanıtsız zaman aşımı, akış başladıktan sonra kopma, geçidin
 * 5xx'i + `x-sod-ai-charged: maybe`) geçit kipinde yeniden deneme yok (olası çift ücret). Ücretsiz 5xx (başlıksız) ve hiç
 * kurulmamış bağlantı yeniden denenir; yerel kip bugünkü gibi.
 */
describe("geçit kipinde olası çift ücret yok (R2b)", () => {
  const charged = (status: number) => ({ status, body: { type: "error", error: { type: "api_error", message: "upstream lost" } }, headers: { [AI_HEADERS.charged]: "maybe", [AI_HEADERS.callId]: "gc-5xx" } });
  const free5xx = (status: number) => ({ status, body: { type: "error", error: { type: "api_error", message: "gateway down" } } });

  /** Yanıt vermeyen ağ: istek iptal edilince (zaman aşımı) düşer. */
  function hangingFetch() {
    let n = 0;
    const fn = (async (_url: string | URL | Request, init?: RequestInit) => {
      n++;
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })));
      });
    }) as typeof fetch;
    return { fn, count: () => n };
  }

  it("Claude: yanıtsız zaman aşımı geçit kipinde yeniden denenmez (1 istek); yerel kipte bugünkü gibi denenir", async () => {
    const f = hangingFetch();
    const claude = createClaude({ apiKey: TOKEN, baseURL: `${GW}/internal/anthropic`, gateway: context(), fetch: f.fn, sleep: async () => {}, timeoutMs: 50 });
    const r = await claude.callJson({ system: "s", content: [{ type: "text", text: "x" }], schema, purpose: "design" });
    expect(f.count()).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ kind: "timeout", retryable: false });

    const local = hangingFetch();
    const c2 = createClaude({ apiKey: "sk-yerel", baseURL: "https://api.anthropic.test", fetch: local.fn, sleep: async () => {}, timeoutMs: 50 });
    const r2 = await c2.callJson({ system: "s", content: [{ type: "text", text: "x" }], schema, purpose: "design", maxRetries: 2 });
    expect(local.count()).toBe(3);
    expect(r2.error).toMatchObject({ kind: "timeout", retryable: true });
  });

  it("geçit kipinde zaman aşımı geçidin sınırına uygun (15 dk + pay)", () => {
    expect(GATEWAY_TIMEOUT_MS).toBe(16 * 60_000);
  });

  it("Claude: geçidin 5xx'i + x-sod-ai-charged: maybe yeniden denenmez; başlıksız 5xx ücretsizdir, denenir", async () => {
    const f = fakeGateway([charged(502), { body: message('{"ok":true}') }]);
    const claude = createClaude({ apiKey: TOKEN, baseURL: `${GW}/internal/anthropic`, fetch: f.fn, gateway: context(), sleep: async () => {} });
    const r = await claude.callJson({ system: "s", content: [{ type: "text", text: "x" }], schema, purpose: "design" });
    expect(f.captured).toHaveLength(1);
    expect(r.error).toMatchObject({ retryable: false, config: true, gatewayCallId: "gc-5xx" });

    const f2 = fakeGateway([free5xx(503), { body: message('{"ok":true}') }]);
    const c2 = createClaude({ apiKey: TOKEN, baseURL: `${GW}/internal/anthropic`, fetch: f2.fn, gateway: context(), sleep: async () => {} });
    const r2 = await c2.callJson({ system: "s", content: [{ type: "text", text: "x" }], schema, purpose: "design" });
    expect(f2.captured).toHaveLength(2);
    expect(r2.ok).toBe(true);
  });

  it("Claude: bağlantı hiç kurulmadıysa (ECONNREFUSED) geçit kipinde de yeniden denenir", async () => {
    const ok = fakeGateway([{ body: message('{"ok":true}') }]);
    let n = 0;
    const fn = (async (url: string | URL | Request, init?: RequestInit) => {
      if (n++ === 0) throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
      return ok.fn(url, init);
    }) as typeof fetch;
    const claude = createClaude({ apiKey: TOKEN, baseURL: `${GW}/internal/anthropic`, fetch: fn, gateway: context(), sleep: async () => {} });
    const r = await claude.callJson({ system: "s", content: [{ type: "text", text: "x" }], schema, purpose: "design" });
    expect(n).toBe(2);
    expect(r.ok).toBe(true);
  });

  const png = Buffer.alloc(64, 7).toString("base64");
  const image = { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png } }] }, finishReason: "STOP" }] };

  it("Gemini: 400'den sonra geçit kipinde uç generateContent kalır (interactions'a gidilmez)", async () => {
    const f = fakeGateway([
      { status: 400, body: { error: { code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT" } }, headers: { [AI_HEADERS.callId]: "gc-1" } },
      { body: image, headers: { [AI_HEADERS.callId]: "gc-2" } },
    ]);
    const g = createGemini({ apiKey: TOKEN, baseUrl: `${GW}/internal/gemini/v1beta`, fetch: f.fn, gateway: context(), sleep: async () => {} });
    const a = await g.generate({ prompt: "x" });
    const b = await g.generate({ prompt: "y" });
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(true);
    expect(f.captured.map((c) => c.url.replace(GW, ""))).toEqual([
      `/internal/gemini/v1beta/models/${MODELS.image}:generateContent`,
      `/internal/gemini/v1beta/models/${MODELS.image}:generateContent`,
    ]);
  });

  it("Gemini: 5xx + x-sod-ai-charged: maybe yeniden denenmez; başlıksız 5xx denenir", async () => {
    const f = fakeGateway([{ ...charged(504), body: { error: { code: 504, message: "upstream lost" } } }, { body: image }]);
    const g = createGemini({ apiKey: TOKEN, baseUrl: `${GW}/internal/gemini/v1beta`, fetch: f.fn, gateway: context(), sleep: async () => {} });
    const r = await g.generate({ prompt: "p" });
    expect(f.captured).toHaveLength(1);
    expect(r.error).toMatchObject({ retryable: false, config: true });

    const f2 = fakeGateway([{ status: 503, body: { error: { code: 503, message: "gateway down" } } }, { body: image }]);
    const g2 = createGemini({ apiKey: TOKEN, baseUrl: `${GW}/internal/gemini/v1beta`, fetch: f2.fn, gateway: context(), sleep: async () => {} });
    const r2 = await g2.generate({ prompt: "p" });
    expect(f2.captured).toHaveLength(2);
    expect(r2.ok).toBe(true);
  });

  describe("oluşturucu: akış başladıktan sonraki kopma", () => {
    const start = { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: MODELS.builder, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20000, output_tokens: 1 } } };
    const blockStart = { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
    const delta = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Merhaba" } };

    /** Akış `message_start`'tan sonra kopar: `eof` (geçit `out.destroy()`, gövde biter) ya da `reset` (bağlantı sıfırlanır). */
    function cutStream(mode: "eof" | "reset") {
      let n = 0;
      const fn = (async () => {
        n++;
        const enc = new TextEncoder();
        const body = new ReadableStream({
          start(c) {
            for (const e of [start, blockStart, delta]) c.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
            if (mode === "eof") c.close();
            else c.error(Object.assign(new TypeError("terminated"), { cause: { code: "ECONNRESET" } }));
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", [AI_HEADERS.callId]: "gc-1" } });
      }) as unknown as typeof fetch;
      return { fn, count: () => n };
    }

    for (const mode of ["eof", "reset"] as const) {
      it(`${mode}: hata yeniden denenemez; tur tek istekle durur ("Devam et" kullanıcıda)`, async () => {
        const f = cutStream(mode);
        const model = createBuilderModel({ apiKey: TOKEN, baseURL: `${GW}/internal/anthropic`, fetch: f.fn, gateway: { ...context(), purpose: "builder-turn" } });
        const e = await model.stream(buildBuilderRequest(model.model, BUILDER_PROMPT_VERSION, [{ role: "user", content: "x" }])).catch((x: unknown) => x);
        expect(e).toBeInstanceOf(BuilderModelError);
        expect((e as BuilderModelError).failure).toMatchObject({ retryable: false, gatewayCallId: "gc-1" });

        const f2 = cutStream(mode);
        const m2 = createBuilderModel({ apiKey: TOKEN, baseURL: `${GW}/internal/anthropic`, fetch: f2.fn, gateway: { ...context(), purpose: "builder-turn" } });
        const r = await runBuilderTurn({
          model: m2,
          promptVersion: BUILDER_PROMPT_VERSION,
          history: [{ role: "user", content: "x" }],
          input: null,
          executor: { execute: async () => ({}) },
          options: { sleep: async () => {} },
        });
        expect(f2.count()).toBe(1);
        expect(r.stopReason).toBe("error");
        expect(r.error?.retryable).toBe(false);
        // Görülen kullanım (yarım akış) harcama olarak kalır (sahte akış `reset`te olayları teslim etmeden düşer).
        if (mode === "eof") expect(r.usage.some((u) => u.partial)).toBe(true);
      });
    }

    it("akış içindeki hata olayı (overloaded_error, ücretsiz geçici hata türü) başladıktan sonra yeniden denenmez; yerel kipte denenir", async () => {
      const sseErr = (gateway: boolean) => {
        let n = 0;
        const fn = (async () => {
          n++;
          const events = [start, blockStart, delta].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
          const err = `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`;
          return new Response(events + err, { status: 200, headers: { "content-type": "text/event-stream" } });
        }) as unknown as typeof fetch;
        const model = gateway
          ? createBuilderModel({ apiKey: TOKEN, baseURL: `${GW}/internal/anthropic`, fetch: fn, gateway: { ...context(), purpose: "builder-turn" } })
          : createBuilderModel({ apiKey: "sk-yerel", baseURL: "https://api.anthropic.test", fetch: fn });
        return { model, count: () => n };
      };
      const g = sseErr(true);
      const e = await g.model.stream(buildBuilderRequest(g.model.model, BUILDER_PROMPT_VERSION, [{ role: "user", content: "x" }])).catch((x: unknown) => x);
      expect((e as BuilderModelError).failure).toMatchObject({ retryable: false });
      const l = sseErr(false);
      const el = await l.model.stream(buildBuilderRequest(l.model.model, BUILDER_PROMPT_VERSION, [{ role: "user", content: "x" }])).catch((x: unknown) => x);
      expect((el as BuilderModelError).failure).toMatchObject({ retryable: true });
    });

    it("yerel kipte akış kopması bugünkü gibi yeniden denenebilir", async () => {
      const f = cutStream("eof");
      const model = createBuilderModel({ apiKey: "sk-yerel", baseURL: "https://api.anthropic.test", fetch: f.fn });
      const e = await model.stream(buildBuilderRequest(model.model, BUILDER_PROMPT_VERSION, [{ role: "user", content: "x" }])).catch((x: unknown) => x);
      expect((e as BuilderModelError).failure.retryable).toBe(true);
    });

    it("akıştan önce geçidin 5xx'i: charged maybe ise kalıcı, başlıksızsa yeniden denenebilir", async () => {
      const a = createBuilderModel({ apiKey: TOKEN, baseURL: `${GW}/internal/anthropic`, fetch: fakeGateway([charged(502)]).fn, gateway: { ...context(), purpose: "builder-turn" } });
      const ea = await a.stream(buildBuilderRequest(a.model, BUILDER_PROMPT_VERSION, [{ role: "user", content: "x" }])).catch((x: unknown) => x);
      expect((ea as BuilderModelError).failure).toMatchObject({ retryable: false, gatewayCallId: "gc-5xx" });
      const b = createBuilderModel({ apiKey: TOKEN, baseURL: `${GW}/internal/anthropic`, fetch: fakeGateway([free5xx(503)]).fn, gateway: { ...context(), purpose: "builder-turn" } });
      const eb = await b.stream(buildBuilderRequest(b.model, BUILDER_PROMPT_VERSION, [{ role: "user", content: "x" }])).catch((x: unknown) => x);
      expect((eb as BuilderModelError).failure.retryable).toBe(true);
    });
  });
});
