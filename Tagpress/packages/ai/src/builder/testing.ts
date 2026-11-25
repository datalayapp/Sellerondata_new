/**
 * Betiklenebilir sahte oluşturucu modeli: ağsız, ücretsiz, deterministik. Döngü testleri, sunucunun (C3) servis ve
 * senaryo testleri bunu kullanır.
 *
 *   import { FakeBuilderModel, fake } from "@tagpress/ai/builder/testing";
 *   const model = new FakeBuilderModel([
 *     fake.reply([fake.text("Önce ölçümlere bakıyorum."), fake.tool("get_measurements", {})]),
 *     fake.reply([fake.tool("ask_user", { questions: [...] })]),
 *   ]);
 *   const r = await runBuilderTurn({ model, ... });
 *   model.requests[1].messages  // gönderilen istekler (derin kopya)
 *
 * Sıradaki adım istekte tüketilir: yanıt (metin, düşünme, araç çağrısı, yedek model sınırı), hata (429, 5xx, ağ,
 * anahtar...), kesilme (`max_tokens`), ret, iptale kadar asılı kalma ya da isteğe göre yanıt üreten işlev. Akış
 * olayları gerçek SSE sırasıyla (message_start → blok olayları → message_delta → message_stop) yayınlanır.
 */
import { MODELS } from "@tagpress/domain";
import { type AiErrorKind, makeFailure } from "../errors.ts";
import type { BuilderToolResult } from "./agent.ts";
import { type BuilderCallOptions, type BuilderCountRequest, BuilderModelError, type BuilderModelPort, type BuilderRequest, type BuilderResponse, type BuilderStreamEvent, strictToolJsonOk } from "./model.ts";

export type FakeBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  /** `rawJson`: akışta gelen ham girdi metni (verilmezse `input`'un JSON'u); katı ayrışmazsa yanıtta `invalidToolInput`. */
  | { type: "tool_use"; id: string; name: string; input: unknown; rawJson?: string }
  | { type: "fallback"; from: { model: string }; to: { model: string }; trigger?: unknown };

export interface FakeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
  iterations?: Array<Record<string, unknown>>;
}

export type FakeStep =
  | { kind: "reply"; content: FakeBlock[]; stopReason?: BuilderResponse["stop_reason"]; usage?: FakeUsage; model?: string; stopDetails?: { category: string | null; explanation: string | null } }
  /** Sağlayıcı hatası (fırlatılır). `afterEvents`: önce bu kadar yanıt olayı akar (yarıda kesilen akış). */
  | { kind: "error"; error: { kind: AiErrorKind; message?: string; status?: number; retryAfterMs?: number; retryable?: boolean }; afterEvents?: FakeStep & { kind: "reply" } }
  /** SDK'nın araç girdisi JSON'unu ayrıştıramaması (girdinin parça parça aktığı kip). */
  | { kind: "tool-json-error" }
  /** İptal edilene kadar bekler (önce `content` metni akar). */
  | { kind: "hang"; content?: FakeBlock[] };

export type FakeScript = FakeStep | ((req: BuilderRequest, index: number) => FakeStep);

let seq = 0;

/** Betik yardımcıları. */
export const fake = {
  text: (text: string): FakeBlock => ({ type: "text", text }),
  thinking: (thinking = "", signature = `sig_${++seq}`): FakeBlock => ({ type: "thinking", thinking, signature }),
  tool: (name: string, input: unknown, id = `toolu_fake_${++seq}`): FakeBlock => ({ type: "tool_use", id, name, input }),
  /** Ham girdisi bozuk araç çağrısı: `parsed` SDK'nın hoşgörülü ayrıştırıcısının kırptığı nesnedir. */
  badTool: (name: string, raw: string, parsed: unknown = {}, id = `toolu_fake_${++seq}`): FakeBlock => ({ type: "tool_use", id, name, input: parsed, rawJson: raw }),
  fallback: (from: string, to: string): FakeBlock => ({ type: "fallback", from: { model: from }, to: { model: to }, trigger: { type: "refusal" } }),
  /** Yanıt; araç çağrısı varsa durdurma nedeni `tool_use`, yoksa `end_turn`. */
  reply: (content: FakeBlock[], extra: Partial<Omit<FakeStep & { kind: "reply" }, "kind" | "content">> = {}): FakeStep => ({
    kind: "reply",
    content,
    stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    ...extra,
  }),
  truncated: (content: FakeBlock[] = [fake.text("Yarım")]): FakeStep => ({ kind: "reply", content, stopReason: "max_tokens" }),
  refusal: (category: string | null = "cyber", content: FakeBlock[] = []): FakeStep => ({ kind: "reply", content, stopReason: "refusal", stopDetails: { category, explanation: null } }),
  rateLimit: (retryAfterMs?: number): FakeStep => ({ kind: "error", error: { kind: "rate-limit", status: 429, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } }),
  overloaded: (): FakeStep => ({ kind: "error", error: { kind: "overloaded", status: 529 } }),
  network: (): FakeStep => ({ kind: "error", error: { kind: "network" } }),
  auth: (): FakeStep => ({ kind: "error", error: { kind: "auth", status: 401 } }),
  quota: (): FakeStep => ({ kind: "error", error: { kind: "quota", status: 400 } }),
  toolJsonError: (): FakeStep => ({ kind: "tool-json-error" }),
  hang: (content?: FakeBlock[]): FakeStep => ({ kind: "hang", ...(content ? { content } : {}) }),
};

export interface FakeBuilderModelOptions {
  model?: string;
  /** `count_tokens` yanıtı (istek → token); varsayılan: istek metninin uzunluğu / 4. */
  countTokens?: (req: BuilderCountRequest) => number;
}

/** Betikli sahte model (`BuilderModelPort`). */
export class FakeBuilderModel implements BuilderModelPort {
  readonly model: string;
  /** Gönderilen istekler (derin kopya; görseller dahil). */
  readonly requests: BuilderRequest[] = [];
  /** İstek seçenekleri (başlıklar). */
  readonly calls: Array<{ headers?: Record<string, string> }> = [];
  readonly countRequests: BuilderCountRequest[] = [];
  private i = 0;

  constructor(
    private readonly script: FakeScript[],
    private readonly opts: FakeBuilderModelOptions = {},
  ) {
    this.model = opts.model ?? MODELS.builder;
  }

  /** Tüketilmemiş adım sayısı (testin sonunda 0 olmalı). */
  get remaining(): number {
    return this.script.length - this.i;
  }

  async countTokens(req: BuilderCountRequest): Promise<number> {
    this.countRequests.push(structuredClone(req));
    return this.opts.countTokens ? this.opts.countTokens(req) : Math.ceil(JSON.stringify(req).length / 4);
  }

  async stream(req: BuilderRequest, o: BuilderCallOptions = {}): Promise<BuilderResponse> {
    const index = this.i++;
    this.requests.push(structuredClone(req));
    this.calls.push(o.headers ? { headers: { ...o.headers } } : {});
    const src = this.script[index];
    if (!src) throw new Error(`Sahte model: ${index + 1}. istek için betik adımı yok.`);
    const step = typeof src === "function" ? src(req, index) : src;
    const emit = o.onEvent ?? (() => {});
    const abortErr = () => new BuilderModelError(makeFailure({ kind: "aborted", provider: "anthropic", message: "İptal edildi." }));
    if (o.signal?.aborted) throw abortErr();

    if (step.kind === "tool-json-error") {
      throw new BuilderModelError(makeFailure({ kind: "invalid-response", provider: "anthropic", message: "Modelin araç girdisi JSON olarak ayrıştırılamadı." }), { toolJson: true });
    }
    if (step.kind === "error") {
      if (step.afterEvents) playEvents(step.afterEvents, req, index, emit, false);
      const e = step.error;
      throw new BuilderModelError(
        makeFailure({
          kind: e.kind,
          provider: "anthropic",
          message: e.message ?? `Sahte hata: ${e.kind}`,
          ...(e.status !== undefined ? { status: e.status } : {}),
          ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
          ...(e.retryable !== undefined ? { retryable: e.retryable } : {}),
        }),
      );
    }
    if (step.kind === "hang") {
      playEvents({ kind: "reply", content: step.content ?? [] }, req, index, emit, false);
      await new Promise<void>((_, reject) => {
        if (!o.signal) return; // sinyalsiz asılı kalma testte zaman aşımıdır
        o.signal.addEventListener("abort", () => reject(abortErr()), { once: true });
      });
      throw abortErr();
    }
    return playEvents(step, req, index, emit, true);
  }
}

/** Yanıtın akış olaylarını yayınlar ve son hâli döner (`end`: message_delta/stop dahil). */
function playEvents(step: FakeStep & { kind: "reply" }, req: BuilderRequest, index: number, emit: (e: BuilderStreamEvent) => void, end: boolean): BuilderResponse {
  const model = step.model ?? req.model;
  const u = step.usage ?? {};
  const usage = {
    input_tokens: u.input_tokens ?? 1000,
    output_tokens: u.output_tokens ?? 200,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_creation: u.cache_creation ?? null,
    ...(u.iterations ? { iterations: u.iterations } : {}),
  };
  const content = step.content.map((b) => structuredClone(b));
  const message = {
    id: `msg_fake_${index}`,
    type: "message",
    role: "assistant",
    model,
    content: [] as unknown[],
    stop_reason: null,
    stop_sequence: null,
    stop_details: null,
    usage: { ...usage, output_tokens: 1 },
  };
  emit({ type: "message_start", message } as unknown as BuilderStreamEvent);
  content.forEach((b, i) => {
    const start = b.type === "text" ? { type: "text", text: "", citations: null } : b.type === "thinking" ? { type: "thinking", thinking: "", signature: "" } : b.type === "tool_use" ? { type: b.type, id: b.id, name: b.name, input: {} } : b;
    emit({ type: "content_block_start", index: i, content_block: start } as unknown as BuilderStreamEvent);
    if (b.type === "text") emit({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } } as unknown as BuilderStreamEvent);
    if (b.type === "thinking" && b.thinking) emit({ type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: b.thinking } } as unknown as BuilderStreamEvent);
    if (b.type === "tool_use") emit({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: b.rawJson ?? JSON.stringify(b.input) } } as unknown as BuilderStreamEvent);
    emit({ type: "content_block_stop", index: i } as unknown as BuilderStreamEvent);
  });
  const invalid = Object.fromEntries(content.flatMap((b) => (b.type === "tool_use" && b.rawJson !== undefined && !strictToolJsonOk(b.rawJson) ? [[b.id, b.rawJson]] : [])));
  const final = {
    ...message,
    content: content.map((b) => (b.type === "text" ? { ...b, citations: null } : b.type === "tool_use" ? { type: b.type, id: b.id, name: b.name, input: b.input } : b)),
    ...(Object.keys(invalid).length ? { invalidToolInput: invalid } : {}),
    stop_reason: step.stopReason ?? "end_turn",
    stop_details: step.stopReason === "refusal" ? { type: "refusal", category: step.stopDetails?.category ?? null, explanation: step.stopDetails?.explanation ?? null } : null,
    usage,
  };
  if (end) {
    emit({ type: "message_delta", delta: { stop_reason: final.stop_reason, stop_sequence: null, stop_details: final.stop_details }, usage: { output_tokens: usage.output_tokens } } as unknown as BuilderStreamEvent);
    emit({ type: "message_stop" } as unknown as BuilderStreamEvent);
  }
  return final as unknown as BuilderResponse;
}

/** Sahte araç çalıştırıcı: araç adına göre yanıt (yoksa "OK"); çağrılar sırayla kaydedilir. */
export function fakeExecutor(handlers: Partial<Record<string, (input: unknown, call: { id: string; name: string }) => BuilderToolResult | Promise<BuilderToolResult>>> = {}) {
  const calls: Array<{ id: string; name: string; input: unknown }> = [];
  return {
    calls,
    async execute(call: { id: string; name: string; input: unknown }) {
      calls.push({ id: call.id, name: call.name, input: structuredClone(call.input) });
      const h = handlers[call.name];
      return h ? h(call.input, call) : { content: [{ type: "text" as const, text: "OK" }] };
    },
  };
}
