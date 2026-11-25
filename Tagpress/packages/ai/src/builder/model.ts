import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "@tagpress/domain";
import { type AiFailure, classifyHttp, describeKind, makeFailure, retryAfterMs } from "../errors.ts";
import { GATEWAY_TIMEOUT_MS, type GatewayOptions, gatewayCallIdOf, gatewayRejectOf, gatewaySettledFailure } from "../gateway.ts";

/**
 * Oluşturucu döngüsünün model portu (`BuilderModelPort`) ve gerçek Anthropic bağdaştırıcısı. Döngü (`agent.ts`)
 * yalnız bu porta bağlıdır; testler ve sunucunun senaryo testleri sahte modeli (`testing.ts`) kullanır, para harcamaz.
 *
 * Bağdaştırıcı yeniden denemez (`maxRetries: 0`): bekleme ve deneme sayısı döngünündür (bekleme süresi olay olarak
 * bildirilir). `baseURL` ve `apiKey` dışarıdan gelir. Platform kipinde (`gateway`) taban adres yapay zekâ geçidinin
 * Anthropic tabanı (`/internal/anthropic`), `apiKey` araç jetonu (`x-api-key`; `Authorization` gönderilmez); her isteğe bağlam
 * başlıkları (`X-SOD-*`) eklenir. Bir model nesnesi bir iştir (oluşturucu turu, ölçüm): bütün istekleri aynı istek kimliğini
 * taşır (geçidin süren iş payı bu zincire bakar), deneme sayısı istek istek artar.
 */

/** Saklanan ve aynen geri gönderilen ileti (ham içerik blokları, düşünme blokları dahil). */
export type BuilderMessage = Anthropic.Beta.BetaMessageParam;
/**
 * Modelin yanıtı (akışın son hâli). `invalidToolInput`: girdisi KATI `JSON.parse`'tan geçmeyen araç blokları
 * (kimlik → akıştan gelen ham metin). SDK'nın hoşgörülü ayrıştırıcısı bozuk JSON'u çoğu zaman hata vermeden kırpar
 * (`{"note":"a"b"}` → `{note:"a"}`); bu yüzden girdi akıştaki ham metinden ayrıca denetlenir. API alanı değildir,
 * saklanan iletilere girmez.
 */
export type BuilderResponse = Anthropic.Beta.BetaMessage & { invalidToolInput?: Record<string, string>; gatewayCallId?: string };
/** Akışın ham olayı. */
export type BuilderStreamEvent = Anthropic.Beta.BetaRawMessageStreamEvent;
/** Akış hâlinde istek gövdesi (`stream` alanı bağdaştırıcının işi). */
export type BuilderRequest = Omit<Anthropic.Beta.MessageCreateParamsStreaming, "stream">;
/** Token sayımı isteği (`count_tokens`). */
export type BuilderCountRequest = Anthropic.Beta.MessageCountTokensParams;

export interface BuilderCallOptions {
  signal?: AbortSignal;
  /** İstek başına ek başlıklar (geçidin bağlam başlıkları gibi). */
  headers?: Record<string, string>;
  /** Akışın her ham olayı (metin parçası, araç bloğu, kullanım). */
  onEvent?: (e: BuilderStreamEvent) => void;
}

export interface BuilderModelPort {
  /** İstekte kullanılan model kimliği. */
  readonly model: string;
  /** Akış hâlinde istek; akış bitince tam yanıt. Hata `BuilderModelError` olarak fırlatılır. */
  stream(req: BuilderRequest, opts?: BuilderCallOptions): Promise<BuilderResponse>;
  /** Önek sayımı (`count_tokens`, ücretsiz). */
  countTokens(req: BuilderCountRequest, opts?: Omit<BuilderCallOptions, "onEvent">): Promise<number>;
}

/**
 * Model hatası. `failure` bugünkü sınıflandırmadır (`errors.ts`). `toolJson`: akış, modelin araç girdisi JSON'u
 * ayrıştırılamadığı için kesildi (girdinin parça parça aktığı kipte); blok elde olmadığı için istek yeniden gönderilir.
 */
export class BuilderModelError extends Error {
  readonly failure: AiFailure;
  readonly toolJson: boolean;
  constructor(failure: AiFailure, opts: { toolJson?: boolean } = {}) {
    super(failure.message);
    this.name = "BuilderModelError";
    this.failure = failure;
    this.toolJson = opts.toolJson ?? false;
  }
}

export interface BuilderModelOptions {
  apiKey: string;
  model?: string;
  /** Geçit ya da test sunucusu. Verilmezse Anthropic. */
  baseURL?: string;
  /** Her isteğe eklenen başlıklar. */
  headers?: Record<string, string>;
  /** Test için sahte fetch. */
  fetch?: typeof fetch;
  /** İstek başına zaman aşımı (ms), varsayılan 10 dk (akışta uzun turlar olabilir). */
  timeoutMs?: number;
  /** Platform kipi: yapay zekâ geçidi; `baseURL` zorunlu. `purpose` bu modelin amacı (`builder-turn`). */
  gateway?: GatewayOptions & { purpose: string };
}

/**
 * SDK'nın araç girdisi JSON'unu ayrıştıramadığında attığı hatanın iletisi (ayrı sınıfı yok). Yalnız yedek işarettir:
 * asıl sınıflandırma yapısaldır (`toolJsonFailed`): API hatası olmayan bir SDK hatası VE akışta katı ayrışmayan bir
 * araç girdisi.
 */
const TOOL_JSON_RE = /Unable to parse tool parameter JSON/;

const toolJsonFailure = () => new BuilderModelError(makeFailure({ kind: "invalid-response", provider: "anthropic", message: "Modelin araç girdisi JSON olarak ayrıştırılamadı." }), { toolJson: true });

/** Akıştaki araç girdisi ham metni katı JSON mu (boş metin = girdisiz araç, `{}`). */
export function strictToolJsonOk(raw: string): boolean {
  if (!raw.trim()) return true;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * SDK ve ağ hatalarını bugünkü sınıflandırmaya çevirir. Geçit `x-should-retry: false` derse yeniden denenmez.
 * `ctx.badToolJson`: akışta katı ayrışmayan araç girdisi görüldü (bağdaştırıcı izler); o zaman API'nin tür hatası
 * olmayan SDK hatası araç JSON hatasıdır. Tür hataları (`APIError` ve altları) hiçbir zaman araç JSON hatası sayılmaz.
 */
export function toBuilderModelError(err: unknown, ctx: { badToolJson?: boolean; gateway?: boolean; streamStarted?: boolean } = {}): BuilderModelError {
  const e = classifyBuilderError(err, ctx);
  if (!ctx.gateway || e.toolJson || err instanceof BuilderModelError) return e;
  // Geçit kipi: istek sağlayıcıya ulaşmış olabilecek hata yeniden denenmez (olası çift ücret; `gatewaySettledFailure`).
  // Akış başladıktan sonraki her kopma da (sağlayıcı yanıt vermeye başlamıştı: ücret doğdu) kullanıcıya bırakılır ("Devam et").
  const api = err instanceof Anthropic.APIError ? err : null;
  let f = gatewaySettledFailure(e.failure, { headers: api?.headers, status: api?.status, cause: err });
  if (ctx.streamStarted && f.kind !== "aborted" && !f.reject) f = { ...f, retryable: false };
  const callId = f.gatewayCallId ? undefined : gatewayCallIdOf(api?.headers);
  if (callId) f = { ...f, gatewayCallId: callId };
  return f === e.failure ? e : new BuilderModelError(f);
}

function classifyBuilderError(err: unknown, ctx: { badToolJson?: boolean }): BuilderModelError {
  if (err instanceof BuilderModelError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new BuilderModelError(makeFailure({ kind: "aborted", provider: "anthropic", message: "İptal edildi." }));
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new BuilderModelError(makeFailure({ kind: "timeout", provider: "anthropic", message: "Anthropic: zaman aşımı." }));
  if (err instanceof Anthropic.APIConnectionError) return new BuilderModelError(makeFailure({ kind: "network", provider: "anthropic", message: `Anthropic: bağlantı hatası (${err.message}).` }));
  if (err instanceof Anthropic.APIError) {
    // Geçidin reddi (`x-sod-ai-reject`): yeniden denenmez; anlamı sözleşmede (`gateway.ts`).
    const reject = gatewayRejectOf("anthropic", err.headers, err.status);
    if (reject) return new BuilderModelError(reject);
    const body = err.error as { error?: { message?: string; type?: string }; message?: string; type?: string } | undefined;
    // Akış içindeki hata olayında gövde doğrudan `{ type, message }` olabilir.
    const detail = body?.error?.message ?? body?.message ?? err.message;
    const kind = classifyHttp("anthropic", err.status, detail, err.type ?? body?.error?.type ?? body?.type);
    const after = retryAfterMs(err.headers);
    const noRetry = err.headers?.get?.("x-should-retry") === "false";
    return new BuilderModelError(
      makeFailure({
        kind,
        provider: "anthropic",
        ...(err.status !== undefined ? { status: err.status } : {}),
        message: `Anthropic ${err.status ?? ""}: ${describeKind(kind)} — ${detail}`.trim(),
        ...(after !== undefined ? { retryAfterMs: after } : {}),
        ...(noRetry ? { retryable: false } : {}),
      }),
    );
  }
  if (err instanceof Anthropic.AnthropicError && (ctx.badToolJson || TOOL_JSON_RE.test(err.message))) return toolJsonFailure();
  const message = err instanceof Error ? err.message : String(err);
  return new BuilderModelError(makeFailure({ kind: classifyHttp("anthropic", undefined, message), provider: "anthropic", message: `Anthropic: ${message}` }));
}

/** Gerçek model: Anthropic SDK'sı, beta uç noktası (yedek model ve konuşma içi ayarlar beta başlıklarıyla). */
export function createBuilderModel(opts: BuilderModelOptions): BuilderModelPort {
  const model = opts.model ?? MODELS.builder;
  const gateway = opts.gateway;
  if (gateway && !opts.baseURL) throw new Error("createBuilderModel: geçit kipinde baseURL (geçidin Anthropic tabanı) zorunlu.");
  const client = new Anthropic({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    maxRetries: 0,
    // Geçit kipinde geçidin sağlayıcı sınırı (15 dk) + pay: süre dolunca yanıtı geçit versin.
    timeout: opts.timeoutMs ?? (gateway ? GATEWAY_TIMEOUT_MS : 600_000),
    // Geçit: jeton `x-api-key`'de açıkça; ortamdaki `ANTHROPIC_AUTH_TOKEN` okunmaz, `Authorization` gönderilmez.
    ...(opts.headers || gateway ? { defaultHeaders: { ...(opts.headers ?? {}), ...(gateway ? { "x-api-key": opts.apiKey, authorization: null } : {}) } } : {}),
    ...(gateway ? { authToken: null } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  // Geçit: bu modelin (işin) istek kimliği ve deneme sayacı.
  const requestId = crypto.randomUUID();
  let attempt = 0;
  const headersFor = (extra?: Record<string, string>): Record<string, string> | undefined => {
    const ctx = gateway?.context({ purpose: gateway.purpose, requestId, attempt: attempt++ });
    return ctx || extra ? { ...(extra ?? {}), ...(ctx ?? {}) } : undefined;
  };
  return {
    model,
    async stream(req, o = {}) {
      // Araç girdisinin ham metni (blok sırası → metin): SDK'nın hoşgörülü ayrıştırmasından bağımsız katı denetim için.
      const raw = new Map<number, { id: string; json: string }>();
      const badToolJson = () => [...raw.values()].some((b) => !strictToolJsonOk(b.json));
      const headers = headersFor(o.headers);
      /** Akışın yanıt başlıkları (geçidin çağrı kimliği; hata yolunda da). */
      let responseHeaders: () => Headers | undefined = () => undefined;
      /** Akış başladı mı (ilk olay geldi): geçit kipinde bundan sonraki kopma yeniden denenmez. */
      let started = false;
      try {
        const s = client.beta.messages.stream(req, { ...(o.signal ? { signal: o.signal } : {}), ...(headers ? { headers } : {}) });
        responseHeaders = () => s.response?.headers;
        s.on("streamEvent", (e) => {
          started = true;
          if (e.type === "content_block_start" && e.content_block.type === "tool_use") raw.set(e.index, { id: e.content_block.id, json: "" });
          else if (e.type === "content_block_delta" && e.delta.type === "input_json_delta") {
            const b = raw.get(e.index);
            if (b) b.json += e.delta.partial_json;
          }
          o.onEvent?.(e);
        });
        const msg: BuilderResponse = await s.finalMessage();
        const callId = gateway ? gatewayCallIdOf(s.response?.headers) : undefined;
        if (callId) msg.gatewayCallId = callId;
        const invalid = Object.fromEntries([...raw.values()].filter((b) => !strictToolJsonOk(b.json)).map((b) => [b.id, b.json]));
        return Object.keys(invalid).length ? Object.assign(msg, { invalidToolInput: invalid }) : msg;
      } catch (err) {
        const e = toBuilderModelError(err, { badToolJson: badToolJson(), gateway: !!gateway, streamStarted: started });
        const callId = gateway && !e.failure.gatewayCallId ? gatewayCallIdOf(responseHeaders()) : undefined;
        if (callId) (e.failure as { gatewayCallId?: string }).gatewayCallId = callId;
        throw e;
      }
    },
    async countTokens(req, o = {}) {
      const headers = headersFor(o.headers);
      try {
        const r = await client.beta.messages.countTokens(req, { ...(o.signal ? { signal: o.signal } : {}), ...(headers ? { headers } : {}) });
        return r.input_tokens;
      } catch (err) {
        throw toBuilderModelError(err);
      }
    },
  };
}
