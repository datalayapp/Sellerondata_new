import Anthropic from "@anthropic-ai/sdk";
import { MODELS, type Usage } from "@tagpress/domain";
import type { z } from "zod";
import { type AiFailure, backoffMs, classifyHttp, describeKind, makeFailure, retryAfterMs, sleepMs } from "./errors.ts";
import { GATEWAY_TIMEOUT_MS, type GatewayOptions, gatewayCallIdOf, gatewayRejectOf, gatewaySettledFailure } from "./gateway.ts";
import { pngForModel } from "./images.ts";
import { extractJson, formatZodIssues, toApiJsonSchema } from "./json.ts";

/**
 * Anthropic istemcisi. Tek iş: istemi gönder, JSON yanıtı al, KENDİMİZ doğrula.
 *
 * Eski sistemin dersleri ve buradaki karşılıkları:
 *  - Ham yanıt kayboluyordu → her denemenin ham metni `calls[]`'ta, sonuncusu `raw`'da durur.
 *  - Onarım turu fiilen sıfırdan denemeydi → onarımda [istek, önceki ham yanıt, sorunlar] birlikte gider.
 *  - `stop_reason: max_tokens` yakalanmıyordu → bütçe ikiye katlanır (en fazla 32k), beklemeden tekrar denenir.
 *  - Önbellek token'ları sayılmıyordu → `Usage.cacheReadTokens/cacheWriteTokens`.
 *  - 429 hız sınırı ile kota ayrılmıyordu → `errors.ts`.
 *  - Şema hem output_config'te hem istemde gidiyordu → yerel yapılandırılmış çıktı varken istemde şema YOK;
 *    API şemayı reddederse bir kez şemasız (istemde şema dökümüyle) denenir.
 */

export type ContentPart =
  | { type: "text"; text: string }
  /** PNG; en uzun kenar `maxSide`'a (varsayılan 768) küçültülür. */
  | { type: "image"; png: Buffer; maxSide?: number };

export type ProgressStage = "request" | "retry" | "truncated" | "repair" | "schema-fallback" | "done" | "failed";

export interface ProgressEvent {
  stage: ProgressStage;
  /** Türkçe, arayüz günlüğüne yazılabilir. */
  message: string;
  detail?: string;
  attempt: number;
}

export interface CallLog {
  attempt: number;
  kind: "first" | "retry" | "truncated" | "repair" | "schema-fallback";
  maxTokens: number;
  nativeSchema: boolean;
  /** Bu denemenin ham yanıt metni (boş olabilir). */
  raw: string;
  stopReason: string | null;
  usage: Usage | null;
  ms: number;
  error?: AiFailure;
  /** Doğrulama sorunları (varsa). */
  issues?: string[];
}

export interface Validation {
  ok: boolean;
  /** Modele onarımda gidecek sorunlar (İngilizce önerilir; model okur). */
  issues: string[];
}

export interface JsonRequest<S extends z.ZodType> {
  system: string;
  content: ContentPart[];
  /** Yanıtın ayrıştırma şeması (hoşgörülü olabilir). */
  schema: S;
  /** API'ye gidecek JSON şeması; yoksa `schema`'dan üretilir. Tel şeması ayrıştırmadan katıysa burada verilir. */
  jsonSchema?: Record<string, unknown>;
  /** İlk denemenin çıktı bütçesi (varsayılan 4096). Kesilmede ikiye katlanır, en fazla 32000. */
  maxTokens?: number;
  /** Sistem istemini önbelleğe al (aynı profille art arda çağrılarda ucuzlar). */
  cacheSystem?: boolean;
  signal?: AbortSignal;
  onProgress?: (e: ProgressEvent) => void;
  /** Anlamsal doğrulama: ok=false ise önceki yanıtla onarım istenir. */
  validate?: (data: z.output<S>) => Validation;
  /** Onarım turu sayısı (varsayılan 2). */
  maxRepairs?: number;
  /** Ağ/5xx/hız sınırı tekrar sayısı (varsayılan 3). */
  maxRetries?: number;
  /** Günlükte görünen amaç ("design", "rank"…). */
  purpose?: string;
}

export interface JsonResult<T> {
  ok: boolean;
  /** Şemaya uyan veri. ok=false olsa da şema geçtiyse dolu olabilir (anlamsal doğrulama tutmadıysa). */
  data?: T;
  /** Son ham yanıt metni (hiç yanıt gelmediyse ""). */
  raw: string;
  /** Son doğrulama sorunları. */
  issues?: string[];
  error?: AiFailure;
  usage: Usage[];
  attempts: number;
  ms: number;
  calls: CallLog[];
}

/** Sunucunun ve diğer paketlerin bağımlı olduğu dış arayüz ("port"). Sahte sürümü `testing.ts`'te. */
export interface ClaudePort {
  readonly model: string;
  callJson<S extends z.ZodType>(req: JsonRequest<S>): Promise<JsonResult<z.output<S>>>;
}

export interface ClaudeOptions {
  apiKey: string;
  model?: string;
  /** Test için sahte fetch. */
  fetch?: typeof fetch;
  baseURL?: string;
  /** Test için bekleme fonksiyonu. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** İstek başına zaman aşımı (ms), varsayılan 120 sn; geçit kipinde `GATEWAY_TIMEOUT_MS` (16 dk). */
  timeoutMs?: number;
  /** Yerel yapılandırılmış çıktı (output_config.format). Varsayılan açık. */
  nativeSchema?: boolean;
  /** Düşünme derinliği. Verilmezse modelin varsayılanı (Haiku 5.5: adaptive + medium). */
  effort?: "low" | "medium" | "high";
  /** "disabled": düşünmeyi kapat (Haiku 5.5'te yalnızca effort ≤ high ile). Verilmezse model varsayılanı. */
  thinking?: "adaptive" | "disabled";
  /**
   * Platform kipi: yapay zekâ geçidi (`gateway.ts`). `baseURL` geçidin Anthropic tabanı, `apiKey` araç jetonu; jeton
   * `x-api-key` başlığına açıkça yazılır, `Authorization` gönderilmez. Her isteğe bağlam başlıkları eklenir; geçidin reddi
   * yeniden denenmez, yanıttaki çağrı kimliği kullanım kaydına geçer.
   */
  gateway?: GatewayOptions;
}

/** Kesilmede çıkılacak bütçe tavanı. */
export const MAX_OUTPUT_TOKENS = 32_000;
const HARD_ATTEMPT_LIMIT = 14;

export function createClaude(opts: ClaudeOptions): ClaudePort {
  const model = opts.model ?? MODELS.daily;
  if (opts.gateway && !opts.baseURL) throw new Error("createClaude: geçit kipinde baseURL (geçidin Anthropic tabanı) zorunlu.");
  const client = new Anthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    // Geçit: jeton `x-api-key`'de, ortamdaki `ANTHROPIC_AUTH_TOKEN` okunmaz ve `Authorization` gönderilmez.
    ...(opts.gateway ? { authToken: null, defaultHeaders: { "x-api-key": opts.apiKey, authorization: null } } : {}),
    // Yeniden denemeyi biz yönetiyoruz (hız sınırı ile kotayı ayırmak, bekleme süresini günlüğe yazmak için).
    maxRetries: 0,
    // Geçit kipi: geçit sağlayıcıyı en çok 15 dk bekler; istemci biraz daha uzun bekler ki süre dolunca yanıtı (ücret
    // bilgisiyle) geçit versin. Yanıtsız zaman aşımı geçit kipinde yeniden denenmez (`toFailure`).
    timeout: opts.timeoutMs ?? (opts.gateway ? GATEWAY_TIMEOUT_MS : 120_000),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const sleep = opts.sleep ?? sleepMs;

  async function callJson<S extends z.ZodType>(req: JsonRequest<S>): Promise<JsonResult<z.output<S>>> {
    const started = Date.now();
    const report = req.onProgress ?? (() => {});
    const maxRetries = req.maxRetries ?? 3;
    const maxRepairs = req.maxRepairs ?? 2;
    const calls: CallLog[] = [];
    const usage: Usage[] = [];
    // Geçit: mantıksal çağrının kimliği (yeniden denemeler, kesilme ve onarım turları aynı zincirde, deneme sırasıyla).
    const requestId = crypto.randomUUID();
    const jsonSchema = req.jsonSchema ?? toApiJsonSchema(req.schema);

    const blocks: Anthropic.ContentBlockParam[] = [];
    for (const part of req.content) {
      if (part.type === "text") blocks.push({ type: "text", text: part.text });
      else blocks.push({ type: "image", source: { type: "base64", media_type: "image/png", data: await pngForModel(part.png, part.maxSide ?? 768) } });
    }

    let native = opts.nativeSchema !== false;
    let maxTokens = Math.min(req.maxTokens ?? 4096, MAX_OUTPUT_TOKENS);
    let messages: Anthropic.MessageParam[] = [{ role: "user", content: blocks }];
    let kind: CallLog["kind"] = "first";
    let retries = 0;
    let repairs = 0;
    let lastRaw = "";
    let lastIssues: string[] | undefined;
    let lastData: z.output<S> | undefined;
    let attempt = 0;

    const finish = (r: Omit<JsonResult<z.output<S>>, "usage" | "attempts" | "ms" | "calls" | "raw"> & { raw?: string }): JsonResult<z.output<S>> => {
      const res = { raw: lastRaw, ...r, usage, attempts: attempt, ms: Date.now() - started, calls };
      report(
        res.ok
          ? { stage: "done", message: `AI yanıtı kullanıldı (${attempt} deneme, ${((Date.now() - started) / 1000).toFixed(1)} sn)`, attempt }
          : { stage: "failed", message: `AI çağrısı başarısız: ${res.error?.message ?? "bilinmeyen"}`, attempt, ...(res.issues?.length ? { detail: res.issues.join("\n") } : {}) },
      );
      return res;
    };

    while (attempt < HARD_ATTEMPT_LIMIT) {
      attempt++;
      const t0 = Date.now();
      const system = native ? req.system : `${req.system}\n\n# Response format\nReturn one JSON object and nothing else. It must validate against this JSON Schema:\n${JSON.stringify(jsonSchema)}`;
      report({
        stage: kind === "first" ? "request" : kind === "repair" ? "repair" : kind === "truncated" ? "truncated" : kind === "schema-fallback" ? "schema-fallback" : "retry",
        message:
          kind === "first"
            ? `AI'a istek gönderiliyor · ${model}`
            : kind === "repair"
              ? `Düzeltilmiş yanıt isteniyor (${repairs}. onarım)`
              : kind === "truncated"
                ? `Yanıt bütçeye sığmadı; ${maxTokens} token bütçeyle yeniden isteniyor`
                : kind === "schema-fallback"
                  ? "API şemayı kabul etmedi; şema istemde yeniden deneniyor"
                  : `Yeniden deneniyor (${retries}/${maxRetries})`,
        attempt,
        ...(kind === "repair" && lastIssues ? { detail: lastIssues.join("\n") } : {}),
      });

      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: maxTokens,
        system: req.cacheSystem ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : system,
        messages,
        ...(native || opts.effort ? { output_config: { ...(native ? { format: { type: "json_schema" as const, schema: jsonSchema } } : {}), ...(opts.effort ? { effort: opts.effort } : {}) } } : {}),
        ...(opts.thinking ? { thinking: opts.thinking === "disabled" ? { type: "disabled" as const } : { type: "adaptive" as const } } : {}),
      };

      let response: Anthropic.Message;
      let gatewayCallId: string | undefined;
      // Bağlam başlıkları denemeden önce (firma bağlamı yoksa hata yukarı çıkar; ağ hatası sayılıp yeniden denenmez).
      const headers = opts.gateway?.context({ purpose: req.purpose ?? "unknown", requestId, attempt: attempt - 1 });
      try {
        const r = await client.messages.create(params, { signal: req.signal, ...(headers ? { headers } : {}) }).withResponse();
        response = r.data;
        if (opts.gateway) gatewayCallId = gatewayCallIdOf(r.response.headers);
      } catch (err) {
        const failure = toFailure(err, !!opts.gateway);
        calls.push({ attempt, kind, maxTokens, nativeSchema: native, raw: "", stopReason: null, usage: null, ms: Date.now() - t0, error: failure });
        if (failure.kind === "aborted") return finish({ ok: false, error: failure });
        if (failure.kind === "bad-request" && !failure.reject && native && /output_config|json_schema|schema|format/i.test(failure.message)) {
          native = false;
          kind = "schema-fallback";
          continue;
        }
        if (failure.retryable && retries < maxRetries) {
          retries++;
          kind = "retry";
          const wait = backoffMs(retries, failure.retryAfterMs);
          report({ stage: "retry", message: `${describeKind(failure.kind)}; ${(wait / 1000).toFixed(0)} sn sonra tekrar denenecek`, attempt, detail: failure.message });
          try {
            await sleep(wait, req.signal);
          } catch {
            return finish({ ok: false, error: makeFailure({ kind: "aborted", provider: "anthropic", message: "İptal edildi." }) });
          }
          continue;
        }
        return finish({ ok: false, error: failure, ...(lastIssues ? { issues: lastIssues } : {}) });
      }

      const u = toUsage(response, model);
      if (gatewayCallId) u.gatewayCallId = gatewayCallId;
      usage.push(u);
      const raw = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      if (raw) lastRaw = raw;
      const log: CallLog = { attempt, kind, maxTokens, nativeSchema: native, raw, stopReason: response.stop_reason, usage: u, ms: Date.now() - t0 };
      calls.push(log);

      if (response.stop_reason === "refusal") {
        return finish({ ok: false, error: makeFailure({ kind: "refusal", provider: "anthropic", message: "Model isteği reddetti." }) });
      }
      if (response.stop_reason === "max_tokens") {
        if (maxTokens < MAX_OUTPUT_TOKENS) {
          maxTokens = Math.min(maxTokens * 2, MAX_OUTPUT_TOKENS);
          kind = "truncated";
          continue; // beklemeden
        }
        return finish({ ok: false, error: makeFailure({ kind: "truncated", provider: "anthropic", message: `Yanıt ${MAX_OUTPUT_TOKENS} token tavanında bile kesildi.` }) });
      }

      // Kendi doğrulamamız.
      let issues: string[];
      let parsedOk = false;
      try {
        const parsed = req.schema.safeParse(extractJson(raw));
        if (parsed.success) {
          parsedOk = true;
          lastData = parsed.data as z.output<S>;
          const v = req.validate?.(lastData) ?? { ok: true, issues: [] };
          issues = v.ok ? [] : v.issues.length ? v.issues : ["The answer did not pass validation."];
        } else issues = formatZodIssues(parsed.error);
      } catch (err) {
        issues = [`Invalid JSON: ${(err as Error).message}`];
      }
      if (!issues.length) return finish({ ok: true, data: lastData });
      log.issues = issues;
      lastIssues = issues;
      if (repairs < maxRepairs) {
        repairs++;
        kind = "repair";
        // Onarım: özgün istek + modelin ÖNCEKİ yanıtı + sorunlar (eski hata: önceki yanıt gitmiyordu).
        messages = [
          { role: "user", content: blocks },
          { role: "assistant", content: raw || "(empty answer)" },
          { role: "user", content: repairText(issues) },
        ];
        continue;
      }
      return finish({
        ok: false,
        ...(parsedOk && lastData !== undefined ? { data: lastData } : {}),
        issues,
        error: makeFailure({ kind: "invalid-response", provider: "anthropic", message: `Yanıt ${repairs} onarımdan sonra da kullanılamadı.` }),
      });
    }
    return finish({ ok: false, error: makeFailure({ kind: "other", provider: "anthropic", message: "Deneme sınırı aşıldı." }) });
  }

  return { model, callJson };
}

export function repairText(issues: readonly string[]): string {
  return [
    "Your previous answer (above) could not be used. Problems found:",
    ...issues.map((i) => `- ${i}`),
    "",
    "Return the complete corrected answer as one JSON object in the same schema. Keep everything that was correct; fix only the problems listed.",
  ].join("\n");
}

function toUsage(r: Anthropic.Message, fallbackModel: string): Usage {
  const u = r.usage;
  return {
    model: r.model || fallbackModel,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

function toFailure(err: unknown, gateway = false): AiFailure {
  if (gateway) {
    // Geçidin reddi (`x-sod-ai-reject`): yeniden denenmez. Sağlayıcının hatası olduğu gibi geçer; çağrı kimliği kayda.
    const apiErr = err instanceof Anthropic.APIError ? err : null;
    const reject = apiErr ? gatewayRejectOf("anthropic", apiErr.headers, apiErr.status) : null;
    if (reject) return reject;
    // İstek sağlayıcıya ulaşmış olabilir (`x-should-retry: false`, 5xx + `x-sod-ai-charged: maybe`, yanıtsız zaman aşımı ya da
    // kopan bağlantı): ücret alınmış olabilir, yeniden denenmez (`gatewaySettledFailure`).
    const callId = gatewayCallIdOf(apiErr?.headers);
    const f = gatewaySettledFailure(toFailure(err, false), { headers: apiErr?.headers, status: apiErr?.status, cause: err });
    return { ...f, ...(callId ? { gatewayCallId: callId } : {}) };
  }
  if (err instanceof Anthropic.APIUserAbortError) return makeFailure({ kind: "aborted", provider: "anthropic", message: "İptal edildi." });
  if (err instanceof Anthropic.APIConnectionTimeoutError) return makeFailure({ kind: "timeout", provider: "anthropic", message: "Anthropic: zaman aşımı." });
  if (err instanceof Anthropic.APIConnectionError) return makeFailure({ kind: "network", provider: "anthropic", message: `Anthropic: bağlantı hatası (${err.message}).` });
  if (err instanceof Anthropic.APIError) {
    const body = err.error as { error?: { message?: string; type?: string } } | undefined;
    const detail = body?.error?.message ?? err.message;
    const kind = classifyHttp("anthropic", err.status, detail, err.type ?? body?.error?.type);
    const after = retryAfterMs(err.headers);
    return makeFailure({
      kind,
      provider: "anthropic",
      status: err.status,
      message: `Anthropic ${err.status ?? ""}: ${describeKind(kind)} — ${detail}`.trim(),
      ...(after !== undefined ? { retryAfterMs: after } : {}),
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return makeFailure({ kind: classifyHttp("anthropic", undefined, message), provider: "anthropic", message: `Anthropic: ${message}` });
}
