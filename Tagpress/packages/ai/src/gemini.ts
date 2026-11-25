import { MODELS, type Usage } from "@tagpress/domain";
import { type AiFailure, backoffMs, classifyHttp, describeKind, makeFailure, sleepMs } from "./errors.ts";
import { type GatewayOptions, gatewayCallIdOf, gatewayRejectOf, gatewaySettledFailure } from "./gateway.ts";

/**
 * Gemini görüntü modeli (Nano Banana, `MODELS.image`) — REST.
 *
 * Uç noktalar (eski sistemde doğrulandı, `packages/ai/src/image/gemini-image.ts`):
 *  1. `POST {base}/interactions` — { model, input: [{type:"text"},{type:"image", mime_type, data}],
 *     response_format: { type:"image", mime_type:"image/png", aspect_ratio, image_size } }
 *  2. olmazsa `POST {base}/models/{model}:generateContent` — contents/parts (inline_data) +
 *     generationConfig { responseModalities: ["IMAGE","TEXT"], imageConfig: { aspectRatio, imageSize } }
 * Hangi uç noktanın çalıştığı istemci ömrü boyunca hatırlanır (gereksiz çift istek olmasın).
 * Anahtar/kota hatası uç noktaya bağlı değildir: ikinci uç nokta denenmez, hemen açık hata döner.
 *
 * Platform kipi (`gateway`): taban adres geçidin Gemini tabanı (`/internal/gemini/v1beta`), `apiKey` araç jetonu
 * (`x-goog-api-key`). Geçit yalnız `:generateContent` / `:streamGenerateContent` iletir: `interactions` denenmez. Her isteğe
 * bağlam başlıkları; geçidin reddi yeniden denenmez; yanıttaki çağrı kimliği kullanıma (`Usage.gatewayCallId`) geçer.
 */

export interface ImageRequest {
  prompt: string;
  /** Girdi görselleri (PNG), sırayla. */
  images?: Buffer[];
  /** "1:1", "3:4"… */
  aspectRatio?: string;
  /** "1K" | "2K" */
  imageSize?: string;
  signal?: AbortSignal;
}

export interface ImageResult {
  ok: boolean;
  png?: Buffer;
  /** Modelin görselle döndürdüğü metin (varsa). */
  note: string;
  usage: Usage;
  error?: AiFailure;
  ms: number;
  endpoint?: "interactions" | "generateContent" | "fake";
}

/** Görüntü üretiminin dış arayüzü ("port"). Sahte sürümü `testing.ts`'te. */
export interface ImagePort {
  readonly model: string;
  generate(req: ImageRequest): Promise<ImageResult>;
}

export interface GeminiOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Hız sınırı/5xx tekrar sayısı (varsayılan 2). */
  maxRetries?: number;
  /** Platform kipi: yapay zekâ geçidi (`gateway.ts`); `baseUrl` zorunlu. */
  gateway?: GatewayOptions;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Headers | null = null,
  ) {
    super(message);
  }
}

/** Gemini çağrısının ortak bilgisi: geçit kipinde bağlam başlıkları için istek kimliği ve deneme sayacı. */
interface CallState {
  requestId: string;
  attempt: number;
  /** Son yanıtın geçit çağrı kimliği. */
  callId?: string;
}

export function createGemini(opts: GeminiOptions): ImagePort {
  const model = opts.model ?? MODELS.image;
  if (opts.gateway && !opts.baseUrl) throw new Error("createGemini: geçit kipinde baseUrl (geçidin Gemini tabanı) zorunlu.");
  const base = (opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? sleepMs;
  const maxRetries = opts.maxRetries ?? 2;
  // Geçit yalnız `generateContent` iletir (sözleşme `AI_GATEWAY_PATHS`).
  let preferred: "interactions" | "generateContent" | null = opts.gateway ? "generateContent" : null;

  async function post(url: string, body: unknown, signal: AbortSignal | undefined, call: CallState): Promise<unknown> {
    // Bağlam başlıkları istekten önce (firma bağlamı yoksa hata yukarı çıkar).
    const context = opts.gateway?.context({ purpose: "image", requestId: call.requestId, attempt: call.attempt++ });
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey, ...(context ?? {}) },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (opts.gateway) call.callId = gatewayCallIdOf(res.headers);
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 400);
      try {
        const j = JSON.parse(text) as { error?: { message?: string; status?: string } | string };
        detail = typeof j.error === "string" ? j.error : [j.error?.status, j.error?.message].filter(Boolean).join(": ") || detail;
      } catch {
        /* düz metin */
      }
      throw new HttpError(res.status, detail, res.headers);
    }
    return text ? JSON.parse(text) : {};
  }

  function failureOf(err: unknown): AiFailure {
    if (err instanceof HttpError && opts.gateway) {
      const reject = gatewayRejectOf("gemini", err.headers, err.status);
      if (reject) return reject;
    }
    let f: AiFailure;
    if (err instanceof HttpError) {
      const kind = classifyHttp("gemini", err.status, err.message);
      f = makeFailure({ kind, provider: "gemini", status: err.status, message: `Gemini ${err.status}: ${describeKind(kind)} — ${err.message}` });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      const kind = err instanceof Error && err.name === "AbortError" ? "aborted" : classifyHttp("gemini", undefined, message);
      f = makeFailure({ kind, provider: "gemini", message: `Gemini: ${message}` });
    }
    // Geçit: istek sağlayıcıya ulaşmış olabilir (`x-should-retry: false`, 5xx + `x-sod-ai-charged: maybe`, kopan bağlantı):
    // ücret alınmış olabilir, yeniden denenmez.
    if (!opts.gateway) return f;
    return err instanceof HttpError ? gatewaySettledFailure(f, { headers: err.headers, status: err.status }) : gatewaySettledFailure(f, { cause: err });
  }

  async function viaInteractions(req: ImageRequest, images: string[], call: CallState): Promise<{ png: Buffer | null; note: string; raw: unknown }> {
    const input: Record<string, unknown>[] = [{ type: "text", text: req.prompt }, ...images.map((data) => ({ type: "image", mime_type: "image/png", data }))];
    const raw = await post(
      `${base}/interactions`,
      { model, input, response_format: { type: "image", mime_type: "image/png", aspect_ratio: req.aspectRatio ?? "1:1", image_size: req.imageSize ?? "1K" } },
      req.signal,
      call,
    );
    return { png: findImage(raw), note: findText(raw), raw };
  }

  async function viaGenerateContent(req: ImageRequest, images: string[], call: CallState): Promise<{ png: Buffer | null; note: string; raw: unknown }> {
    const parts: Record<string, unknown>[] = [{ text: req.prompt }, ...images.map((data) => ({ inline_data: { mime_type: "image/png", data } }))];
    const raw = await post(
      `${base}/models/${encodeURIComponent(model)}:generateContent`,
      {
        contents: [{ role: "user", parts }],
        generationConfig: { responseModalities: ["IMAGE", "TEXT"], imageConfig: { aspectRatio: req.aspectRatio ?? "1:1", imageSize: req.imageSize ?? "1K" } },
      },
      req.signal,
      call,
    );
    return { png: findImage(raw), note: findText(raw), raw };
  }

  async function generate(req: ImageRequest): Promise<ImageResult> {
    const started = Date.now();
    const images = (req.images ?? []).map((b) => b.toString("base64"));
    const emptyUsage: Usage = { model, inputTokens: 0, outputTokens: 0, images: 0 };
    let retries = 0;
    let lastFailure: AiFailure | undefined;
    const call: CallState = { requestId: crypto.randomUUID(), attempt: 0 };
    /** Kullanım + geçit çağrı kimliği (platform kipi). */
    const withCall = (u: Usage): Usage => (call.callId ? { ...u, gatewayCallId: call.callId } : u);
    const failed = (f: AiFailure): AiFailure => (call.callId && !f.gatewayCallId ? { ...f, gatewayCallId: call.callId } : f);
    while (true) {
      const order: Array<"interactions" | "generateContent"> = preferred ? [preferred] : ["interactions", "generateContent"];
      let retryable: AiFailure | undefined;
      for (const endpoint of order) {
        try {
          const out = endpoint === "interactions" ? await viaInteractions(req, images, call) : await viaGenerateContent(req, images, call);
          const usage = withCall({ ...readUsage(out.raw, model), images: out.png ? 1 : 0 });
          if (out.png) {
            preferred = endpoint;
            return { ok: true, png: out.png, note: out.note, usage, ms: Date.now() - started, endpoint };
          }
          // Yanıt geldi ama görsel yok (güvenlik süzgeci, yalnızca metin): uç nokta çalışıyor demektir.
          preferred = endpoint;
          const reason = finishReason(out.raw);
          return {
            ok: false,
            note: out.note,
            usage,
            ms: Date.now() - started,
            endpoint,
            error: makeFailure({
              kind: /SAFETY|PROHIBITED|BLOCK/i.test(reason) ? "refusal" : "other",
              provider: "gemini",
              message: `Model görsel döndürmedi${reason ? ` (${reason})` : ""}${out.note ? `: ${out.note.slice(0, 200)}` : ""}`,
            }),
          };
        } catch (err) {
          const f = failed(failureOf(err));
          lastFailure = f;
          // `interactions`'ta 404 "uç nokta yok" demektir (model değil): klasik uç noktaya geçilir.
          const endpointMissing = endpoint === "interactions" && f.kind === "not-found" && order.length > 1;
          // Geçidin reddi: ne öbür uç nokta ne yeniden deneme (aynı istek yeniden ücret ya da ret doğurur).
          if ((f.config && !endpointMissing) || f.kind === "aborted" || f.reject) return { ok: false, note: "", usage: withCall(emptyUsage), ms: Date.now() - started, error: f, endpoint };
          if (f.retryable) {
            retryable = f;
            break;
          }
          // Uç nokta yok / istek biçimi tanınmadı: sıradakini dene. Geçit kipinde tek uç (`generateContent`) kalır.
          if (preferred === endpoint && !opts.gateway) preferred = null;
        }
      }
      if (retryable && retries < maxRetries) {
        retries++;
        try {
          await sleep(backoffMs(retries, retryable.retryAfterMs), req.signal);
        } catch {
          return { ok: false, note: "", usage: emptyUsage, ms: Date.now() - started, error: makeFailure({ kind: "aborted", provider: "gemini", message: "İptal edildi." }) };
        }
        continue;
      }
      return {
        ok: false,
        note: "",
        usage: withCall(emptyUsage),
        ms: Date.now() - started,
        error: lastFailure ?? makeFailure({ kind: "other", provider: "gemini", message: "Görüntü üretilemedi." }),
      };
    }
  }

  return { model, generate };
}

/** Yanıtın herhangi bir yerindeki ilk görsel (uç noktalara göre alan adları değişiyor; derin arama). */
export function findImage(node: unknown, depth = 0): Buffer | null {
  if (!node || typeof node !== "object" || depth > 12) return null;
  const o = node as Record<string, unknown>;
  const mime = (o.mime_type ?? o.mimeType) as string | undefined;
  if (typeof o.data === "string" && o.data.length > 32 && (!mime || mime.startsWith("image/"))) return Buffer.from(o.data, "base64");
  for (const v of Object.values(o)) {
    const found = Array.isArray(v) ? v.map((x) => findImage(x, depth + 1)).find(Boolean) : findImage(v, depth + 1);
    if (found) return found;
  }
  return null;
}

function findText(node: unknown, depth = 0): string {
  if (!node || typeof node !== "object" || depth > 12) return "";
  const o = node as Record<string, unknown>;
  const own = typeof o.text === "string" && o.thought !== true ? [o.text] : [];
  const rest = Object.entries(o)
    .filter(([k]) => k !== "text")
    .flatMap(([, v]) => (Array.isArray(v) ? v.map((x) => findText(x, depth + 1)) : [findText(v, depth + 1)]));
  return [...own, ...rest].filter(Boolean).join(" ").trim();
}

function finishReason(raw: unknown): string {
  const r = raw as { candidates?: { finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
  return r?.candidates?.[0]?.finishReason ?? r?.promptFeedback?.blockReason ?? "";
}

interface UsageFields {
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  usage_metadata?: { prompt_token_count?: number; candidates_token_count?: number };
  usage?: { input_tokens?: number; output_tokens?: number; total_input_tokens?: number; total_output_tokens?: number };
}

/** Token sayısı uç noktaya göre farklı adla gelir. Bildirilmezse 0 (ücret görsel başına hesaplanır). */
function readUsage(raw: unknown, model: string): Usage {
  const r = (raw ?? {}) as UsageFields & { interaction?: UsageFields };
  const m = r.usageMetadata ?? r.interaction?.usageMetadata;
  if (m) return { model, inputTokens: m.promptTokenCount ?? 0, outputTokens: (m.candidatesTokenCount ?? 0) + (m.thoughtsTokenCount ?? 0) };
  const sm = r.usage_metadata ?? r.interaction?.usage_metadata;
  if (sm) return { model, inputTokens: sm.prompt_token_count ?? 0, outputTokens: sm.candidates_token_count ?? 0 };
  const u = r.usage ?? r.interaction?.usage;
  if (u) return { model, inputTokens: u.input_tokens ?? u.total_input_tokens ?? 0, outputTokens: u.output_tokens ?? u.total_output_tokens ?? 0 };
  return { model, inputTokens: 0, outputTokens: 0 };
}
