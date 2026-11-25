import { AI_CHARGED_MAYBE, AI_HEADERS, AI_REJECT_KIND, type AiRejectCode, aiRejectCodeOf } from "@tagpress/domain";
import { type AiErrorKind, type AiFailure, type AiProvider, makeFailure, retryAfterMs } from "./errors.ts";

/**
 * Platform kipi: istemcilerin SellerOnData yapay zekâ geçidine (`Platform/apps/ai-api`) bağlanması. Sözleşme
 * `@sellerondata/contracts` `ai.ts` (yollar, `X-SOD-*` bağlam başlıkları, `sod_*` retleri):
 * - Taban adres `aiGatewayBaseUrl(AI_GATEWAY_URL, sağlayıcı)`; araç kimliği SDK'nın anahtar başlığında (`x-api-key` /
 *   `x-goog-api-key`) = `AI_GATEWAY_TOKEN`. `Authorization` gönderilmez (geçit kabul etmez).
 * - Her istekte bağlam başlıkları; değerleri çağıran sunucu verir (`context`), istemci yalnız istek kimliğini ve deneme
 *   sayısını ekler (`x-sod-request-id` mantıksal çağrı başına, `x-sod-attempt` aynı çağrının deneme sırası).
 * - Yanıttaki `x-sod-ai-call-id` kullanım kaydına (`Usage.gatewayCallId`) geçer; ret (`x-sod-ai-reject`) yeniden denenmez.
 */
export interface GatewayCall {
  /** Aracın yerel amaç adı (`design`, `rank`, `transcribe`, `image`, `builder-turn` …). */
  purpose: string;
  /** Mantıksal çağrı kimliği (aynı çağrının yeniden denemeleri ve onarımları ortak). */
  requestId: string;
  /** Aynı çağrıda kaçıncı deneme (0'dan). */
  attempt: number;
}

export interface GatewayOptions {
  /** Bağlam başlıkları (`aiContextHeaders`): firma, üye, amaç, istek kimliği, çıkış, deneme. Firma bağlamı yoksa hata fırlatır. */
  context(call: GatewayCall): Record<string, string>;
}

/**
 * Geçit kipinde istemcinin istek başına zaman aşımı: geçit sağlayıcıyı en çok 15 dk bekler; istemci biraz daha uzun bekler
 * ki süre dolunca yanıtı (ücret bilgisiyle, `x-sod-ai-charged`) geçit versin.
 */
export const GATEWAY_TIMEOUT_MS = 16 * 60_000;

/**
 * Geçit "yeniden deneme" dedi mi (`x-should-retry: false`): retlerde ve geçidin isteği sağlayıcıya ilettikten sonra düştüğü
 * 502/504'te (ücret alınmış olabilir) gelir. İstemcinin kendi döngüsü de yeniden denemez (olası çift ücret).
 */
export function gatewaySaysNoRetry(headers: Headers | null | undefined): boolean {
  return headers?.get(AI_HEADERS.shouldRetry)?.trim().toLowerCase() === "false";
}

/**
 * Geçidin kendi 5xx'i, istek sağlayıcıya gittikten sonra (`x-sod-ai-charged: maybe`; bağlantı koptu, süre doldu, aktarım
 * hatası): ücret doğmuş olabilir. Araç bunu kendiliğinden yeniden DENEMEZ (iş kuyruğu dahil). Başlık yoksa geçidin 5xx'i
 * ücretsizdir, yeniden denenebilir.
 */
export function gatewayChargedMaybe(headers: Headers | null | undefined, status: number | undefined): boolean {
  return status !== undefined && status >= 500 && headers?.get(AI_HEADERS.charged)?.trim().toLowerCase() === AI_CHARGED_MAYBE;
}

/** Bağlantı hiç kurulmadı (istek geçide ulaşmadı): bu ağ hataları geçit kipinde de güvenle yeniden denenir. */
const NOT_SENT_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

/** Hatanın (ya da nedenler zincirinin) kodu bağlantının hiç kurulmadığını mı söylüyor. */
export function requestNeverSent(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 6 && e && typeof e === "object"; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && NOT_SENT_CODES.has(code)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Geçit kipi: isteğin sağlayıcıya ulaşmış olabileceği hatalar kalıcıdır (`retryable: false`, `config: true`: akışlar da yeni
 * bir istekle tekrar denemez; kullanıcı isterse yeniden başlatır). Olası çift ücreti önler:
 * - geçit `x-should-retry: false` dedi;
 * - geçidin 5xx'inde `x-sod-ai-charged: maybe`;
 * - yanıt gelmeden zaman aşımı ya da bağlantı koptu (bağlantı hiç kurulmadıysa, `requestNeverSent`, yeniden denenebilir).
 * Ret (`reject`) ve iptal olduğu gibi kalır. Yerel kipte çağrılmaz.
 */
export function gatewaySettledFailure(f: AiFailure, o: { headers?: Headers | null | undefined; status?: number | undefined; cause?: unknown }): AiFailure {
  if (f.reject || f.kind === "aborted") return f;
  const lost = o.status === undefined && (f.kind === "timeout" || f.kind === "network") && !requestNeverSent(o.cause);
  if (gatewaySaysNoRetry(o.headers) || gatewayChargedMaybe(o.headers, o.status) || lost) return { ...f, retryable: false, config: true };
  return f;
}

/** Yanıt başlıklarından geçidin çağrı kimliği. */
export function gatewayCallIdOf(headers: Headers | null | undefined): string | undefined {
  return headers?.get(AI_HEADERS.callId)?.trim() || undefined;
}

/** Ret türünün istemcideki hata türü (oluşturucu ve üretim akışları bu türlere bakar). */
const KIND_OF_REJECT: Record<(typeof AI_REJECT_KIND)[AiRejectCode], AiErrorKind> = {
  cap: "quota",
  paused: "overloaded",
  busy: "rate-limit",
  unavailable: "auth",
  closed: "permission",
  misconfigured: "bad-request",
};

const REJECT_TEXT: Record<(typeof AI_REJECT_KIND)[AiRejectCode], string> = {
  cap: "yapay zekâ harcama hakkı doldu",
  paused: "yapay zekâ platformda geçici olarak durduruldu",
  busy: "yapay zekâ şu an yoğun; biraz sonra yeniden deneyin",
  unavailable: "yapay zekâ şu an kullanılamıyor (platformda sağlayıcı anahtarı yok)",
  closed: "firma kapalı",
  misconfigured: "yapay zekâ geçidi isteği reddetti (kurulum hatası)",
};

/**
 * Geçidin reddi → hata. Ret yeniden denenmez (`retryable: false`) ve akışı açıkça durdurur (`config: true`: görüntü ve
 * tasarım akışları yeni bir istekle tekrar denemez, sessiz yedek sonuca düşülmez). `busy` için iş sonra yeni bir istekle
 * yeniden başlatılır (kullanıcı ya da kuyruk).
 */
export function gatewayRejectFailure(provider: AiProvider, code: AiRejectCode, opts: { status?: number; callId?: string; retryAfterMs?: number } = {}): AiFailure {
  const kind = AI_REJECT_KIND[code];
  return makeFailure({
    kind: KIND_OF_REJECT[kind],
    provider,
    message: `Yapay zekâ geçidi: ${REJECT_TEXT[kind]} (${code}).`,
    ...(opts.status !== undefined ? { status: opts.status } : {}),
    ...(opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
    retryable: false,
    config: true,
    reject: code,
    ...(opts.callId ? { gatewayCallId: opts.callId } : {}),
  });
}

/** Hata yanıtının başlıkları geçidin reddiyse ret hatası, değilse null. */
export function gatewayRejectOf(provider: AiProvider, headers: Headers | null | undefined, status?: number): AiFailure | null {
  if (!headers) return null;
  const code = aiRejectCodeOf(headers);
  if (!code) return null;
  const callId = gatewayCallIdOf(headers);
  // `retry-after` (hız sınırı `sod_rate_limited`): iş kuyruğu bu kadar bekleyip yeni bir istekle dener.
  const after = retryAfterMs(headers);
  return gatewayRejectFailure(provider, code, { ...(status !== undefined ? { status } : {}), ...(callId ? { callId } : {}), ...(after !== undefined ? { retryAfterMs: after } : {}) });
}
