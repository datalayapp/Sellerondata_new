import { describe, expect, it } from "vitest";
import { buildBuilderRequest, runBuilderTurn } from "./agent.ts";
import Anthropic from "@anthropic-ai/sdk";
import { BuilderModelError, createBuilderModel, strictToolJsonOk, toBuilderModelError } from "./model.ts";
import { BUILDER_PROMPT_VERSION } from "./prompt.ts";
import { fakeExecutor } from "./testing.ts";

/**
 * Gerçek bağdaştırıcı (Anthropic SDK) sahte fetch ile: SSE akışı ayrıştırılır, istek gövdesi ve başlıklar doğru
 * gider, hatalar sınıflandırılır. Ağa çıkılmaz, para harcanmaz.
 */

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function fakeFetch(responses: Array<{ status?: number; body: string; headers?: Record<string, string> }>) {
  const captured: Captured[] = [];
  let i = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const h: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (h[k] = v));
    captured.push({ url: String(url), headers: h, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const r = responses[i++];
    if (!r) throw new Error("yanıt yok");
    const status = r.status ?? 200;
    return new Response(r.body, { status, headers: { "content-type": status === 200 ? "text/event-stream" : "application/json", "request-id": `req_${i}`, ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return { fn, captured };
}

const usage = { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } };
const start = { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, stop_details: null, usage } };

const toolStream = sse([
  start,
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_real" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "", citations: null } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Ölçümlere " } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "bakıyorum." } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "read_profile", input: {} } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"source":' } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"draft"}' } },
  { type: "content_block_stop", index: 2 },
  { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null, stop_details: null }, usage: { output_tokens: 42, input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  { type: "message_stop" },
]);
const endStream = sse([
  start,
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Bitti." } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
]);

describe("gerçek bağdaştırıcı (sahte fetch)", () => {
  it("akışı ayrıştırır; beta uç noktası, beta başlığı, geçit başlıkları ve önbellek işaretleri gider", async () => {
    const f = fakeFetch([{ body: toolStream }, { body: endStream }]);
    const model = createBuilderModel({ apiKey: "sk-test", baseURL: "http://gateway.local/internal/anthropic", headers: { "X-SOD-Purpose": "builder" }, fetch: f.fn });
    const exec = fakeExecutor();
    const texts: string[] = [];
    const r = await runBuilderTurn({
      model,
      promptVersion: BUILDER_PROMPT_VERSION,
      history: [],
      context: { locale: "tr" },
      input: { kind: "first-draft" },
      executor: exec,
      onEvent: (e) => e.type === "text" && texts.push(e.delta),
      options: { headers: { "X-SOD-Request-Id": "r-1" } },
    });
    expect(r.stopReason).toBe("end_turn");
    expect(texts.join("")).toBe("Ölçümlere bakıyorum.Bitti.");
    expect(exec.calls).toEqual([{ id: "toolu_1", name: "read_profile", input: { source: "draft" } }]);
    const [a, b] = f.captured;
    expect(a!.url).toBe("http://gateway.local/internal/anthropic/v1/messages?beta=true");
    expect(a!.headers["x-api-key"]).toBe("sk-test");
    expect(a!.headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01,thinking-display-updates-2026-08-18");
    expect(a!.headers["x-sod-purpose"]).toBe("builder");
    expect(a!.headers["x-sod-request-id"]).toBe("r-1");
    expect(a!.body).toMatchObject({ stream: true, model: "claude-opus-5-5", fallbacks: [{ model: "claude-opus-5" }], thinking: { type: "adaptive", display: "updates" }, output_config: { effort: "high" } });
    // Üst düzey otomatik işaret 1 saatlik (kullanıcı cevabı 5 dakikayı aşabilir).
    expect(a!.body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(b!.body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(a!.body.betas).toBeUndefined();
    expect((a!.body.system as Array<{ cache_control: unknown }>)[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // Düşünme bloğu imzasıyla aynen geri gider; araç girdisi düz nesne.
    const assistant = (b!.body.messages as Array<{ role: string; content: unknown }>).at(-2)!;
    expect(assistant).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "sig_real" },
        { type: "text", text: "Ölçümlere bakıyorum.", citations: null },
        { type: "tool_use", id: "toolu_1", name: "read_profile", input: { source: "draft" } },
      ],
    });
    expect(r.usage[0]).toMatchObject({ inputTokens: 50, outputTokens: 42 });
  });

  it("429: sınıflandırma ve bekleme süresi; geçit 'x-should-retry: false' derse yeniden denenmez", async () => {
    const f = fakeFetch([
      { status: 429, body: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "rate limit" } }), headers: { "retry-after": "7" } },
      { status: 409, body: JSON.stringify({ type: "error", error: { type: "sod_budget", message: "Bütçe" } }), headers: { "x-should-retry": "false" } },
    ]);
    const model = createBuilderModel({ apiKey: "k", fetch: f.fn });
    const req = buildBuilderRequest(model.model, BUILDER_PROMPT_VERSION, [{ role: "user", content: "x" }]);
    const e1 = await model.stream(req).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(BuilderModelError);
    expect((e1 as BuilderModelError).failure).toMatchObject({ kind: "rate-limit", retryable: true, retryAfterMs: 7000, status: 429 });
    const e2 = await model.stream(req).catch((e: unknown) => e);
    expect((e2 as BuilderModelError).failure).toMatchObject({ status: 409, retryable: false });
  });

  /** Tek araç bloğu olan akış; `parts` ham girdi parçaları. */
  const toolOnly = (parts: string[]) =>
    sse([
      start,
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_bad", name: "propose_changes", input: {} } },
      ...parts.map((p) => ({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: p } })),
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null, stop_details: null }, usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ]);

  it("araç girdisi: SDK'nın sessizce kırptığı bozuk JSON yakalanır (ham metin katı ayrıştırılır), araç çalışmaz", async () => {
    // Kaçışsız iç tırnak: SDK'nın hoşgörülü ayrıştırıcısı hata vermeden {note:"a", changes:[]} üretir.
    const bad = '{"note":"a"b","changes":[]}';
    const f = fakeFetch([{ body: toolOnly(['{"note":"a"b",', '"changes":[]}']) }, { body: endStream }]);
    const model = createBuilderModel({ apiKey: "k", fetch: f.fn });
    const direct = await model.stream(buildBuilderRequest(model.model, BUILDER_PROMPT_VERSION, [{ role: "user", content: "x" }]));
    expect(direct.content[0]).toMatchObject({ type: "tool_use", input: { note: "a", changes: [] } });
    expect(direct.invalidToolInput).toEqual({ toolu_bad: bad });

    const f2 = fakeFetch([{ body: toolOnly([bad]) }, { body: endStream }]);
    const exec = fakeExecutor();
    const r = await runBuilderTurn({ model: createBuilderModel({ apiKey: "k", fetch: f2.fn }), promptVersion: BUILDER_PROMPT_VERSION, history: [], context: { locale: "tr" }, input: { kind: "first-draft" }, executor: exec });
    expect(exec.calls).toEqual([]);
    expect(r.stopReason).toBe("end_turn");
    const result = (f2.captured[1]!.body.messages as Array<{ content: unknown }>).at(-1)!.content as Array<Record<string, unknown>>;
    expect(result).toEqual([{ type: "tool_result", tool_use_id: "toolu_bad", is_error: true, content: [{ type: "text", text: JSON.stringify({ INVALID_JSON: bad }) }] }]);
  });

  it("araç girdisi: SDK ayrıştıramayıp hata atarsa ileti metnine bakmadan araç JSON hatası sayılır; API hataları sayılmaz", async () => {
    const f = fakeFetch([{ body: toolOnly(['{"a":1,,}']) }]);
    const model = createBuilderModel({ apiKey: "k", fetch: f.fn });
    const e = await model.stream(buildBuilderRequest(model.model, BUILDER_PROMPT_VERSION, [{ role: "user", content: "x" }])).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BuilderModelError);
    expect((e as BuilderModelError).toolJson).toBe(true);
    // Sınıflandırma yapısal: ileti metni değişse de akışta bozuk girdi görüldüyse araç JSON hatası.
    expect(toBuilderModelError(new Anthropic.AnthropicError("başka bir ileti"), { badToolJson: true }).toolJson).toBe(true);
    expect(toBuilderModelError(new Anthropic.AnthropicError("başka bir ileti")).toolJson).toBe(false);
    // Tür hatası (ör. 400) bozuk girdi görülmüş olsa bile araç JSON hatası değildir.
    const api = new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "bad" } }, "bad", new Headers());
    expect(toBuilderModelError(api, { badToolJson: true }).toolJson).toBe(false);
    expect(strictToolJsonOk("")).toBe(true);
    expect(strictToolJsonOk('{"source":"draft"} x')).toBe(false);
  });

  it("count_tokens beta ucundan sayar", async () => {
    const f = fakeFetch([{ body: JSON.stringify({ input_tokens: 1234, context_management: null }), headers: { "content-type": "application/json" } }]);
    const model = createBuilderModel({ apiKey: "k", fetch: f.fn });
    const n = await model.countTokens({ model: model.model, messages: [{ role: "user", content: "x" }] });
    expect(n).toBe(1234);
    expect(f.captured[0]!.url).toBe("https://api.anthropic.com/v1/messages/count_tokens?beta=true");
  });
});
