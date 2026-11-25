import type Anthropic from "@anthropic-ai/sdk";
import { type AskUserInput, BUILDER_LOOP, BUILDER_SAMPLE_LIMITS, type ProposeChangesResult } from "@tagpress/domain";
import { type AiErrorKind, type AiFailure, backoffMs, makeFailure, sleepMs } from "../errors.ts";
import { pngForModel } from "../images.ts";
import { type BuilderUsage, type CacheSummary, cacheSummary, costOf, usageFromRaw, usageFromResponse, BUILDER_IMAGE_TOKENS_ESTIMATE, type BuilderTokenCounter } from "./cost.ts";
import { formatInvalidToolJson, formatProposalResult, formatToolInputError } from "./format.ts";
import { type BuilderCallOptions, type BuilderMessage, BuilderModelError, type BuilderModelPort, type BuilderRequest, type BuilderResponse, type BuilderStreamEvent, toBuilderModelError } from "./model.ts";
import { type BuilderSessionContext, type BuilderUserInput, builderSystemPrompt, contextTextParts, noticeText, userInputText } from "./prompt.ts";
import { type BuilderToolCall, builderToolDefinitions, validateBuilderToolUse } from "./tools.ts";

/**
 * Oluşturucu döngüsü (plan §4.3, §4.7): Messages API ile sunucuda, el ile yazılmış araç döngüsü. Bir çağrı bir
 * kullanıcı turudur: yeni girdi eklenir, model akış hâlinde çağrılır, araç çağrıları doğrulanıp dışarıdan verilen
 * çalıştırıcıya (`BuilderToolExecutor`, sunucuda C3) gönderilir, sonuçlar tek kullanıcı iletisinde döner; tur
 * `end_turn`, `ask_user` ya da bir sınırla biter.
 *
 * Konuşma yalnız EKLENEREK büyür. Saklanan ileti dizisi (`history` + dönen `messages`) her istekte aynen gönderilir:
 * Opus 5.5'te düşünme blokları modele ve konuşmaya bağlıdır (önek bayt bayt aynı değilse blok geçersiz) ve önbellek
 * de önek eşleşmesidir. Bu yüzden:
 *  - sistem istemi sürüm başına sabittir, araç listesi sabit sıradadır;
 *  - ilk ileti oturum bağlamıdır ve bir daha değişmez (dil, ölçüm özeti, örnek görseller);
 *  - sonradan gelen bilgi konuşma içi sistem iletisi, tur başına özen düzeyi değişikliği içeriksiz sistem iletisidir;
 *  - önbellek işaretleri (`cache_control`) saklanan iletilere yazılmaz, yalnız isteğin kopyasına eklenir.
 *
 * Önbellek kırılma noktaları (en çok 4; burada 3, hepsi 1 sa): sistemin sonu (araçlar sistemden önce gelir, birlikte
 * önbelleğe girer) → oturum bağlamı iletisinin sonu → son ileti (üst düzey otomatik işaret). Kullanıcı cevap verirken
 * 5 dakika geçebilir; uzun TTL kısa olandan önce gelmeli (API kuralı), hepsi 1 sa olunca kural kendiliğinden tutar.
 */

export type BuilderEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type BuilderThinkingDisplay = "omitted" | "summarized" | "updates";
export type BuilderFallbacks = "default" | Array<{ model: string }>;

/** Araç sonucunun içeriği (görsel PNG olarak; modele `BUILDER_SAMPLE_LIMITS.modelEdgePx`'e küçültülüp gider). */
export type BuilderToolContent = { type: "text"; text: string } | { type: "image"; png: Buffer; maxSide?: number };

/**
 * Çalıştırıcının sonucu. `propose_changes` için `proposal` verilirse metin döngüde biçimlenir ve hiçbir değişiklik
 * kabul edilmediyse (`rev: null`) sonuç `is_error` olur; `failedStreak` sınıra ulaşınca tur biter.
 */
export interface BuilderToolResult {
  content?: BuilderToolContent[];
  isError?: boolean;
  proposal?: ProposeChangesResult;
}

/** Araç çalıştırıcı portu (C3). Girdi zod ile DOĞRULANMIŞTIR; bozuk girdi buraya hiç gelmez. */
export interface BuilderToolExecutor {
  execute(call: BuilderToolCall, ctx: { signal: AbortSignal; round: number }): Promise<BuilderToolResult>;
}

/**
 * Döngünün ham olayları (sunucu bunları sözleşmedeki akış olaylarına çevirir: `text`, `step`, `cost`...).
 * `round`: tur içindeki istek sırası (0'dan). `attempt` olayı bir isteğin (yeniden) başladığını söyler: aynı turun
 * önceki denemesinden akmış metin geçersizdir.
 */
export type BuilderEvent =
  | { type: "attempt"; round: number; attempt: number; reason: "first" | "retry" | "max-tokens" | "tool-json" }
  | { type: "text"; round: number; index: number; delta: string }
  | { type: "thinking"; round: number; index: number; delta: string }
  | { type: "fallback"; round: number; from: string; to: string }
  | { type: "step"; phase: "start"; round: number; tool: string; toolUseId: string }
  | { type: "step"; phase: "end"; round: number; tool: string; toolUseId: string; ok: boolean }
  | { type: "retry-wait"; round: number; attempt: number; waitMs: number; kind: AiErrorKind }
  | { type: "usage"; round: number; usage: BuilderUsage[]; requestUsd: number; turnUsd: number; unpriced: string[]; cache: CacheSummary };

export interface BuilderLoopOptions {
  /** Tur başına en çok araç adımı; adım = araç çağrısı içeren bir model yanıtı (paralel çağrılar tek adım). */
  maxSteps?: number;
  /** İlk çıktı tavanı (düşünme dahil). Kesilmede bir kez `maxTokensCeiling` ile yeniden istenir. */
  maxTokens?: number;
  maxTokensCeiling?: number;
  /** Ağ, 5xx ve 429'da en çok yeniden deneme. */
  maxRetries?: number;
  /** Üst üste geçersiz araç girdisi (zod ya da JSON): bu kadar olunca tur biter. */
  maxInvalidInputs?: number;
  /** Oturumun üst düzey özen düzeyi (oturum boyunca SABİT; değişirse mesaj önbelleği düşer). */
  effort?: BuilderEffort;
  /**
   * Düşünme gösterimi: `updates` (varsayılan; beta, araç adımları arasındaki ilerleme notları metin olarak gelir),
   * `omitted` (boş düşünme metni), `summarized`. Opus 5.5 araçlar arasındaki notları düşünme bloğunda yazar;
   * `omitted`'da panel adımlar boyunca sessiz kalır (canlı denemede `updates` ile not metni geldi, 2026-11-22).
   */
  thinkingDisplay?: BuilderThinkingDisplay;
  /**
   * Sunucu tarafı yedek model (beta); null kapatır. Varsayılan `[{ model: "claude-opus-5" }]`: Opus 5.5'in izinli
   * yedekleri `claude-opus-4-8` ve `claude-opus-5` (`/v1/models` → `allowed_fallback_models`), ama Opus 4.8 konuşma
   * içi özen iletisini reddeder (400 "requires a model that supports per-turn effort"); `"default"` 4.8'e yönlenirse
   * özen değiştirilmiş oturumda yedek deneme geçersiz olur. Opus 5 bu isteğin tamamını kabul etti (canlı, 2026-11-22).
   */
  fallbacks?: BuilderFallbacks | null;
  /** Araç girdisi parça parça akar; varsayılan açık. Geçit alanı reddederse kapatılır. */
  eagerInputStreaming?: boolean;
  /** İstek başına ek başlıklar (geçidin `X-SOD-*` bağlam başlıkları). */
  headers?: Record<string, string>;
  /** Test için bekleme. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULTS = {
  maxSteps: BUILDER_LOOP.maxToolStepsPerTurn,
  maxTokens: BUILDER_LOOP.maxTokens,
  maxTokensCeiling: 64_000,
  maxRetries: BUILDER_LOOP.maxRetries,
  maxInvalidInputs: 3,
  effort: "high" as BuilderEffort,
  thinkingDisplay: "updates" as BuilderThinkingDisplay,
  fallbacks: [{ model: "claude-opus-5" }] as BuilderFallbacks | null,
  eagerInputStreaming: true,
};

export const BUILDER_BETAS = {
  fallback: "server-side-fallback-2026-07-01",
  messageEffort: "mid-conversation-output-config-2026-07-01",
  thinkingUpdates: "thinking-display-updates-2026-08-18",
} as const;

export interface BuilderTurnArgs {
  model: BuilderModelPort;
  /** Oturumun başladığı istem sürümü (`design_sessions.prompt_version`). */
  promptVersion: string;
  /** Önceki turların saklanan iletileri (ham; aynen gönderilir). Boşsa `context` zorunlu. */
  history: readonly BuilderMessage[];
  /** Oturum bağlamı: yalnız ilk turda (history boş) kullanılır ve ilk ileti olarak döner. */
  context?: BuilderSessionContext;
  /** Yeni girdi. null: "Devam et", saklanan iletiler olduğu gibi yeniden gönderilir (son ileti kullanıcınınsa). */
  input: BuilderUserInput | null;
  /** Bu turun özen düzeyi; oturumunkinden farklıysa içeriksiz sistem iletisiyle değişir (önbellek korunur). */
  effort?: BuilderEffort;
  executor: BuilderToolExecutor;
  onEvent?: (e: BuilderEvent) => void;
  signal?: AbortSignal;
  /**
   * Kalan bütçe (USD). Sayı: turun başındaki kalan pay; tur içi harcama (`budgetUsd`, fiyatı bilinmeyen model en
   * pahalı fiyatla) buna ulaşınca yeni istek gönderilmez. İşlev: HER model isteğinden önce çağrılır ve o anki kalan
   * payı döner (sunucu kayıtlı harcamadan yeniden hesaplar; bu turun yazılmış harcaması dahil); 0 ya da altıysa
   * istek gönderilmez. Eşzamanlı işlerde sınır en çok iş başına bir istek kadar aşılır.
   */
  budget?: { remainingUsd: number | (() => number) };
  options?: BuilderLoopOptions;
}

export type BuilderStopReason =
  | "end_turn"
  | "ask_user"
  | "max_steps"
  | "proposal_failed"
  | "invalid_tool_input"
  | "budget"
  | "cancelled"
  | "refusal"
  | "max_tokens"
  | "error";

export interface BuilderTurnResult {
  /**
   * Bu turda eklenen iletiler (ham bloklar; düşünme ve yedek model blokları dahil). Her durumda geçerli bir
   * önektir ve olduğu gibi saklanmalıdır: yarım kalan asistan yanıtı hiç eklenmez; çalıştırılan her araç çağrısının
   * sonucu eklidir. "Devam et" bunların üstüne `input: null` ile çağrılır.
   */
  messages: BuilderMessage[];
  stopReason: BuilderStopReason;
  /** `ask_user` ile bittiyse doğrulanmış sorular (sunucu soru girdilerini bundan yazar). */
  questions: AskUserInput["questions"] | null;
  /** Bu turdaki asistan metin blokları (sırayla). */
  text: string[];
  /** İstek başına (yedek model denemeleri ayrı) kullanım; yarıda kesilen akış `partial`. */
  usage: BuilderUsage[];
  /** Kullanımın toplamı (sözleşmenin fiyatı; `unpriced` modeller en pahalı fiyatla sayıldı). */
  costUsd: number;
  unpriced: string[];
  cache: CacheSummary;
  /** Araç adımı sayısı ve gönderilen istek sayısı. */
  steps: number;
  requests: number;
  /** Hata (ret, kesilme, sağlayıcı hatası, iptal). */
  error?: AiFailure;
  /** Ret ayrıntısı (`stop_details`). */
  refusal?: { category: string | null; explanation: string | null };
  /** Yedek model yanıt verdiyse modeli. */
  servedBy?: string;
}

// ---------------------------------------------------------------- ileti kurma

const EMPTY_CONTEXT_ERROR = "İlk turda oturum bağlamı (context) gerekli.";

/** Oturum bağlamı iletisi (ilk ileti; bir kez kurulur ve saklanır). */
export async function buildContextMessage(ctx: BuilderSessionContext): Promise<BuilderMessage> {
  const parts = contextTextParts(ctx);
  const content: Anthropic.Beta.BetaContentBlockParam[] = [{ type: "text", text: parts.head }];
  for (const s of parts.samples) {
    content.push({ type: "text", text: s.text });
    if (s.sample.png) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: await pngForModel(s.sample.png, BUILDER_SAMPLE_LIMITS.modelEdgePx) } });
  }
  content.push({ type: "text", text: parts.tail });
  return { role: "user", content };
}

/** Konuşmadaki son özen düzeyi (son içeriksiz sistem iletisi; yoksa oturumunki). */
export function effectiveEffort(history: readonly BuilderMessage[], sessionEffort: BuilderEffort): BuilderEffort {
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i]!.output_config?.effort;
    if (history[i]!.role === "system" && e) return e;
  }
  return sessionEffort;
}

/** Yeni turun iletileri: (özen değişikliği) → kullanıcı girdisi → (sistem bilgisi). */
function inputMessages(input: BuilderUserInput, effortChange: BuilderEffort | null): BuilderMessage[] {
  const out: BuilderMessage[] = [];
  if (effortChange) out.push({ role: "system", content: [], output_config: { effort: effortChange } });
  out.push({ role: "user", content: [{ type: "text", text: userInputText(input) }] });
  if (input.notices?.length) out.push({ role: "system", content: noticeText(input.notices) });
  return out;
}

const CACHEABLE = new Set(["text", "image", "tool_result", "tool_use", "document"]);

/** İsteğin önbellek işaretli kopyası: oturum bağlamının (ilk ileti) son uygun bloğuna 1 saatlik işaret. */
function markContext(messages: readonly BuilderMessage[]): BuilderMessage[] {
  const out = [...messages];
  const first = out[0];
  if (first && first.role === "user" && Array.isArray(first.content)) {
    const blocks = [...first.content];
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (CACHEABLE.has(blocks[i]!.type)) {
        blocks[i] = { ...blocks[i]!, cache_control: { type: "ephemeral", ttl: "1h" } } as Anthropic.Beta.BetaContentBlockParam;
        break;
      }
    }
    out[0] = { ...first, content: blocks };
  }
  return out;
}

export interface BuilderRequestOptions {
  maxTokens?: number;
  effort?: BuilderEffort;
  thinkingDisplay?: BuilderThinkingDisplay;
  fallbacks?: BuilderFallbacks | null;
  eagerInputStreaming?: boolean;
}

/** Model isteği (saf; sahte modelle istek biçimi böyle denetlenir). */
export function buildBuilderRequest(model: string, promptVersion: string, messages: readonly BuilderMessage[], o: BuilderRequestOptions = {}): BuilderRequest {
  const display = o.thinkingDisplay ?? DEFAULTS.thinkingDisplay;
  const fallbacks = o.fallbacks === undefined ? DEFAULTS.fallbacks : o.fallbacks;
  const betas: string[] = [];
  if (fallbacks) betas.push(BUILDER_BETAS.fallback);
  if (messages.some((m) => m.output_config)) betas.push(BUILDER_BETAS.messageEffort);
  if (display === "updates") betas.push(BUILDER_BETAS.thinkingUpdates);
  // Son işaret otomatik ve 1 saatlik: tur `ask_user` ile bitince kullanıcının cevabı çoğu zaman 5 dakikadan uzun sürer;
  // 5 dakikalıkta araç sonuçlarıyla büyüyen konuşma (canlı oturumda 30–45 bin token) her beklemede yeniden yazılırdı.
  // Bütün işaretler 1 saatlik olduğundan TTL sırası kuralı korunur. Yalnız bağlamdan sonra ileti varken; yoksa son
  // blok bağlamın 1 saatlik işaretidir.
  const autoCache = messages.length > 1;
  return {
    model,
    max_tokens: o.maxTokens ?? DEFAULTS.maxTokens,
    system: [{ type: "text", text: builderSystemPrompt(promptVersion), cache_control: { type: "ephemeral", ttl: "1h" } }],
    tools: builderToolDefinitions({ eagerInputStreaming: o.eagerInputStreaming ?? DEFAULTS.eagerInputStreaming }),
    messages: markContext(messages),
    thinking: { type: "adaptive", ...(display !== "omitted" ? { display } : {}) } as Anthropic.Beta.BetaThinkingConfigParam,
    output_config: { effort: o.effort ?? DEFAULTS.effort },
    ...(autoCache ? { cache_control: { type: "ephemeral" as const, ttl: "1h" as const } } : {}),
    ...(fallbacks ? { fallbacks } : {}),
    ...(betas.length ? { betas } : {}),
  };
}

/** Yanıt içeriğinin saklanacak hâli: düz veri (akışın tembel alanları çözülür) ve yedek model sınırı kuralı. */
export function replayContent(content: BuilderResponse["content"]): Anthropic.Beta.BetaContentBlockParam[] {
  const plain = JSON.parse(JSON.stringify(content)) as Array<{ type: string }>;
  let last = -1;
  plain.forEach((b, i) => {
    if (b.type === "fallback") last = i;
  });
  // Yedek modele geçişte, son geçiş bloğundan ÖNCEKİ düşünme ve araç blokları geri gönderilmez (reddeden modelin
  // yarım çıktısı); metin ve geçiş blokları yerinde kalır (belgedeki geri gönderme kuralı).
  const kept = last < 0 ? plain : plain.filter((b, i) => i >= last || b.type === "text" || b.type === "fallback");
  return kept as Anthropic.Beta.BetaContentBlockParam[];
}

type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };

// ---------------------------------------------------------------- döngü

class Cancelled extends Error {}

/** Bir kullanıcı turunu çalıştırır. Para harcar (gerçek modelle); testler sahte modelle (`testing.ts`) koşar. */
export async function runBuilderTurn(args: BuilderTurnArgs): Promise<BuilderTurnResult> {
  const o = { ...DEFAULTS, ...stripUndefined(args.options ?? {}) };
  const sleep = args.options?.sleep ?? sleepMs;
  const signal = args.signal ?? new AbortController().signal;
  const emit = args.onEvent ?? (() => {});
  const port = args.model;
  builderSystemPrompt(args.promptVersion); // bilinmeyen sürüm baştan hata

  const added: BuilderMessage[] = [];
  if (!args.history.length) {
    if (!args.context) throw new Error(EMPTY_CONTEXT_ERROR);
    added.push(await buildContextMessage(args.context));
  }
  if (args.input) {
    const current = effectiveEffort(args.history, o.effort);
    added.push(...inputMessages(args.input, args.effort && args.effort !== current ? args.effort : null));
  }
  const conversation = (): BuilderMessage[] => [...args.history, ...added];
  const lastRole = conversation().at(-1)?.role;
  if (!lastRole || lastRole === "assistant") throw new Error("Gönderilecek kullanıcı iletisi yok (girdi boş ve son ileti asistanın).");

  const usage: BuilderUsage[] = [];
  const text: string[] = [];
  let questions: AskUserInput["questions"] | null = null;
  let steps = 0;
  let requests = 0;
  let round = 0;
  let maxTokens = o.maxTokens;
  let invalidStreak = 0;
  let servedBy: string | undefined;
  const hardRequestLimit = o.maxSteps * 3 + 6;

  const finish = (stopReason: BuilderStopReason, extra: Partial<BuilderTurnResult> = {}): BuilderTurnResult => {
    const c = costOf(usage);
    return {
      messages: added,
      stopReason,
      questions,
      text,
      usage,
      costUsd: c.usd,
      unpriced: c.unpriced,
      cache: cacheSummary(usage),
      steps,
      requests,
      ...(servedBy ? { servedBy } : {}),
      ...extra,
    };
  };
  const cancelled = () => finish("cancelled", { error: makeFailure({ kind: "aborted", provider: "anthropic", message: "İptal edildi." }) });

  /** Bir istek: akış, yeniden deneme ve bekleme; yarıda kalan akışın görülen kullanımı kaydedilir. */
  const request = async (reason: "first" | "max-tokens" | "tool-json"): Promise<BuilderResponse> => {
    let retries = 0;
    let attempt = 0;
    let why: "first" | "retry" | "max-tokens" | "tool-json" = reason;
    for (;;) {
      if (signal.aborted) throw new Cancelled();
      attempt++;
      requests++;
      emit({ type: "attempt", round, attempt, reason: why });
      const req = buildBuilderRequest(port.model, args.promptVersion, conversation(), {
        maxTokens,
        effort: o.effort,
        thinkingDisplay: o.thinkingDisplay,
        fallbacks: o.fallbacks,
        eagerInputStreaming: o.eagerInputStreaming,
      });
      const seen: { start?: Parameters<typeof usageFromRaw>[0]; outputTokens?: number; model?: string } = {};
      const callOpts: BuilderCallOptions = {
        signal,
        ...(o.headers ? { headers: o.headers } : {}),
        onEvent: (e) => onStreamEvent(e, seen),
      };
      try {
        return await port.stream(req, callOpts);
      } catch (err) {
        const e = toBuilderModelError(err);
        if (seen.start) usage.push({ ...usageFromRaw({ ...seen.start, output_tokens: seen.outputTokens ?? seen.start.output_tokens ?? 0 }, seen.model ?? port.model), partial: true });
        if (e.failure.kind === "aborted" || signal.aborted) throw new Cancelled();
        if (e.toolJson) throw e;
        if (e.failure.retryable && retries < o.maxRetries) {
          retries++;
          const wait = backoffMs(retries, e.failure.retryAfterMs);
          emit({ type: "retry-wait", round, attempt: retries, waitMs: wait, kind: e.failure.kind });
          try {
            await sleep(wait, signal);
          } catch {
            throw new Cancelled();
          }
          why = "retry";
          continue;
        }
        throw e;
      }
    }
  };

  const onStreamEvent = (e: BuilderStreamEvent, seen: { start?: Parameters<typeof usageFromRaw>[0]; outputTokens?: number; model?: string }) => {
    switch (e.type) {
      case "message_start":
        seen.start = e.message.usage;
        seen.model = e.message.model;
        break;
      case "message_delta":
        if (e.usage?.output_tokens != null) seen.outputTokens = e.usage.output_tokens;
        break;
      case "content_block_start": {
        const b = e.content_block as { type: string; from?: { model?: string }; to?: { model?: string } };
        if (b.type === "fallback") emit({ type: "fallback", round, from: b.from?.model ?? "", to: b.to?.model ?? "" });
        break;
      }
      case "content_block_delta":
        if (e.delta.type === "text_delta") emit({ type: "text", round, index: e.index, delta: e.delta.text });
        else if (e.delta.type === "thinking_delta" && e.delta.thinking) emit({ type: "thinking", round, index: e.index, delta: e.delta.thinking });
        break;
      default:
        break;
    }
  };

  let reason: "first" | "max-tokens" | "tool-json" = "first";
  try {
    for (;;) {
      if (signal.aborted) return cancelled();
      if (args.budget) {
        const b = args.budget.remainingUsd;
        const exhausted = typeof b === "function" ? b() <= 1e-9 : costOf(usage).budgetUsd >= b;
        if (exhausted) return finish("budget", { error: makeFailure({ kind: "other", provider: "anthropic", message: "Bütçe bu turda doldu.", retryable: false }) });
      }
      if (requests >= hardRequestLimit) return finish("max_steps");

      let response: BuilderResponse;
      try {
        response = await request(reason);
      } catch (err) {
        if (err instanceof Cancelled) return cancelled();
        const e = toBuilderModelError(err);
        if (e.toolJson) {
          // Girdisi ayrıştırılamayan araç bloğu elde yok: aynı istek yeniden gönderilir (geçersiz girdi sayılır).
          invalidStreak++;
          if (invalidStreak >= o.maxInvalidInputs) return finish("invalid_tool_input", { error: e.failure });
          reason = "tool-json";
          continue;
        }
        return finish("error", { error: e.failure });
      }
      reason = "first";

      const u = usageFromResponse(response, port.model);
      usage.push(...u);
      const requestCost = costOf(u);
      emit({ type: "usage", round, usage: u, requestUsd: requestCost.usd, turnUsd: costOf(usage).usd, unpriced: costOf(usage).unpriced, cache: cacheSummary(usage) });
      if (response.model && response.model !== port.model) servedBy = response.model;

      // Kesilme ve ret araç çalıştırılmadan önce: yarım yanıt eklenmez, araçları çalıştırılmaz.
      if (response.stop_reason === "refusal") {
        const d = response.stop_details;
        return finish("refusal", {
          error: makeFailure({ kind: "refusal", provider: "anthropic", message: "Model isteği reddetti." }),
          refusal: { category: d?.category ?? null, explanation: d?.explanation ?? null },
        });
      }
      if (response.stop_reason === "max_tokens") {
        if (maxTokens < o.maxTokensCeiling) {
          maxTokens = o.maxTokensCeiling;
          reason = "max-tokens";
          continue;
        }
        return finish("max_tokens", { error: makeFailure({ kind: "truncated", provider: "anthropic", message: `Yanıt ${maxTokens} token tavanında kesildi.` }) });
      }
      if (response.stop_reason === "model_context_window_exceeded") {
        return finish("error", { error: makeFailure({ kind: "too-large", provider: "anthropic", message: "Konuşma modelin bağlam penceresini aştı." }) });
      }

      const content = replayContent(response.content);
      added.push({ role: "assistant", content });
      const texts = content.flatMap((b) => (b.type === "text" ? [b.text] : []));
      if (texts.length) text.push(texts.join(""));
      round++;

      if (response.stop_reason === "pause_turn") continue;
      const uses = content.filter((b): b is ToolUseBlock & Anthropic.Beta.BetaContentBlockParam => b.type === "tool_use") as unknown as ToolUseBlock[];
      if (!uses.length) return finish("end_turn");

      // Araç adımı: sırayla çalıştır (öneriler revizyon yazar; sıra önemlidir), sonuçlar tek kullanıcı iletisinde.
      steps++;
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      let asked: AskUserInput["questions"] | null = null;
      let proposalFailed = false;
      for (const tu of uses) {
        emit({ type: "step", phase: "start", round: round - 1, tool: tu.name, toolUseId: tu.id });
        if (signal.aborted) {
          results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: [{ type: "text", text: "Cancelled by the user before this tool ran." }] });
          emit({ type: "step", phase: "end", round: round - 1, tool: tu.name, toolUseId: tu.id, ok: false });
          continue;
        }
        // Ham girdi katı JSON değilse SDK'nın kırptığı nesne çalıştırılmaz (zod'dan geçse bile): model düzeltip yeniden çağırır.
        const badJson = response.invalidToolInput?.[tu.id];
        if (badJson !== undefined) {
          invalidStreak++;
          results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: [{ type: "text", text: formatInvalidToolJson(badJson) }] });
          emit({ type: "step", phase: "end", round: round - 1, tool: tu.name, toolUseId: tu.id, ok: false });
          continue;
        }
        const v = validateBuilderToolUse(tu.id, tu.name, tu.input);
        if (!v.ok) {
          invalidStreak++;
          results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: [{ type: "text", text: formatToolInputError(tu.name, v.issues) }] });
          emit({ type: "step", phase: "end", round: round - 1, tool: tu.name, toolUseId: tu.id, ok: false });
          continue;
        }
        invalidStreak = 0;
        let r: BuilderToolResult;
        try {
          r = await args.executor.execute(v.call, { signal, round: round - 1 });
        } catch {
          r = { isError: true, content: [{ type: "text", text: "The tool failed on the server. Continue without it or try once more." }] };
        }
        const isError = r.isError ?? (r.proposal ? r.proposal.rev === null : false);
        results.push({ type: "tool_result", tool_use_id: tu.id, ...(isError ? { is_error: true } : {}), content: await resultContent(r) });
        if (v.call.name === "propose_changes" && r.proposal && r.proposal.failedStreak >= BUILDER_LOOP.maxFailedProposals) proposalFailed = true;
        if (v.call.name === "ask_user" && !isError) asked = [...(asked ?? []), ...v.call.input.questions];
        emit({ type: "step", phase: "end", round: round - 1, tool: tu.name, toolUseId: tu.id, ok: !isError });
      }
      added.push({ role: "user", content: results });

      if (signal.aborted) return cancelled();
      if (asked) {
        questions = asked;
        return finish("ask_user");
      }
      if (proposalFailed) return finish("proposal_failed");
      if (invalidStreak >= o.maxInvalidInputs) return finish("invalid_tool_input");
      if (steps >= o.maxSteps) return finish("max_steps");
    }
  } catch (err) {
    if (err instanceof Cancelled) return cancelled();
    throw err;
  }
}

async function resultContent(r: BuilderToolResult): Promise<Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam>> {
  const parts: BuilderToolContent[] = r.content?.length ? r.content : r.proposal ? [{ type: "text", text: formatProposalResult(r.proposal) }] : [{ type: "text", text: "(no output)" }];
  const out: Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> = [];
  for (const p of parts) {
    if (p.type === "text") out.push({ type: "text", text: p.text });
    else out.push({ type: "image", source: { type: "base64", media_type: "image/png", data: await pngForModel(p.png, p.maxSide ?? BUILDER_SAMPLE_LIMITS.modelEdgePx) } });
  }
  return out;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ---------------------------------------------------------------- önek sayımı (tahmin için)

/**
 * Araçlar + sistem + oturum bağlamı öneki (token; `count_tokens`, ücretsiz). Bağlam verilmezse (örnekler henüz
 * yüklenmedi) yalnız araçlar ve sistem sayılır, örnek başına yaklaşık görsel payı eklenir (`exact: false`).
 */
export async function countBuilderPrefix(input: {
  counter: BuilderTokenCounter;
  promptVersion: string;
  context?: BuilderSessionContext;
  /** Bağlam yoksa yüklenecek örnek sayısı. */
  samples?: number;
  options?: Pick<BuilderLoopOptions, "eagerInputStreaming" | "headers">;
  signal?: AbortSignal;
}): Promise<{ prefixTokens: number; exact: boolean }> {
  const messages: BuilderMessage[] = input.context ? [await buildContextMessage(input.context)] : [{ role: "user", content: "(estimate)" }];
  const n = await input.counter.countTokens(
    {
      model: input.counter.model,
      system: builderSystemPrompt(input.promptVersion),
      tools: builderToolDefinitions({ eagerInputStreaming: input.options?.eagerInputStreaming ?? DEFAULTS.eagerInputStreaming }),
      messages,
    },
    { ...(input.signal ? { signal: input.signal } : {}), ...(input.options?.headers ? { headers: input.options.headers } : {}) },
  );
  if (input.context) return { prefixTokens: n, exact: true };
  return { prefixTokens: n + (input.samples ?? 0) * BUILDER_IMAGE_TOKENS_ESTIMATE, exact: false };
}

export { BuilderModelError };
