/**
 * AI çağrılarının hata modeli. Eski sistemin iki dersi burada:
 *  - 429 "hız sınırı" (beklenip tekrar denenir) ile "kota/bakiye bitti" (tekrar denemek boşuna, kullanıcı
 *    ayarı düzeltmeli) AYRI türlerdir.
 *  - Anahtar/kota/model hatası sessizce yedek sonuca düşmez; `isConfigError` ile açıkça yukarı bildirilir.
 */

export type AiErrorKind =
  | "rate-limit" // 429 hız sınırı: beklenip tekrar denenir
  | "overloaded" // 529 / 503 aşırı yük
  | "server" // 5xx, 408, 409
  | "network" // bağlantı hatası
  | "timeout"
  | "quota" // kota / bakiye / harcama sınırı bitti (ayar)
  | "auth" // anahtar geçersiz (ayar)
  | "permission" // anahtarın yetkisi yok (ayar)
  | "not-found" // model bulunamadı (ayar)
  | "bad-request"
  | "too-large"
  | "refusal" // model isteği reddetti
  | "truncated" // yanıt bütçe tavanında bile kesildi
  | "invalid-response" // onarımlardan sonra da şemaya/kurallara uymayan yanıt
  | "aborted"
  | "other";

export type AiProvider = "anthropic" | "gemini";

export interface AiFailure {
  kind: AiErrorKind;
  provider: AiProvider;
  /** Kullanıcıya gösterilecek Türkçe cümle. */
  message: string;
  status?: number;
  /** Beklenip tekrar denenebilir mi? */
  retryable: boolean;
  /** Kullanıcının ayarı (anahtar, kota, model) düzeltmesi gerekiyor mu? */
  config: boolean;
  /** Sunucunun önerdiği bekleme (ms), varsa. */
  retryAfterMs?: number;
  /**
   * Platform kipi: yapay zekâ geçidinin reddi (`x-sod-ai-reject`, `sod_*`). Ret hiçbir zaman aynı istekte yeniden denenmez
   * (`retryable: false`); anlamı sözleşmenin `AI_REJECT_KIND` tablosunda (`gatewayRejectFailure`).
   */
  reject?: string;
  /** Platform kipi: geçidin çağrı kimliği (`x-sod-ai-call-id`; ret yanıtında da gelir). */
  gatewayCallId?: string;
}

const RETRYABLE: ReadonlySet<AiErrorKind> = new Set(["rate-limit", "overloaded", "server", "network", "timeout"]);
const CONFIG: ReadonlySet<AiErrorKind> = new Set(["quota", "auth", "permission", "not-found"]);

/** Kota/bakiye bittiğini söyleyen ileti kalıpları (Anthropic 400/402, Gemini 429 RESOURCE_EXHAUSTED). */
const QUOTA_RE = /credit balance|billing|insufficient|quota|usage limit|spend(ing)? limit|exceeded your current|payment/i;
/** Dakikalık/saniyelik sınır: kota sözcüğü geçse de hız sınırıdır (Gemini ücretsiz katman iletileri). */
const PER_TIME_RE = /per[ _-]?(minute|second|day)|PerMinute|PerSecond|rate limit|retry in|retryDelay|too many requests/i;

export function makeFailure(f: Omit<AiFailure, "retryable" | "config"> & Partial<Pick<AiFailure, "retryable" | "config">>): AiFailure {
  return { ...f, retryable: f.retryable ?? RETRYABLE.has(f.kind), config: f.config ?? CONFIG.has(f.kind) };
}

/** HTTP durumu + sağlayıcı hata türü + iletiden hata türü. */
export function classifyHttp(provider: AiProvider, status: number | undefined, message: string, errorType?: string | null): AiErrorKind {
  const t = errorType ?? "";
  if (status === undefined) {
    if (/abort/i.test(message) || t === "aborted") return "aborted";
    if (/timeout|timed out/i.test(message)) return "timeout";
    return "network";
  }
  if (status === 401 || t === "authentication_error") return "auth";
  if (status === 402 || t === "billing_error") return "quota";
  if (status === 403 || t === "permission_error") return QUOTA_RE.test(message) ? "quota" : "permission";
  if (status === 404 || t === "not_found_error") return "not-found";
  if (status === 413 || t === "request_too_large") return "too-large";
  if (status === 429 || t === "rate_limit_error") {
    // Önce hız sınırı kalıbı: Gemini dakikalık sınırda da "quota" der.
    if (PER_TIME_RE.test(message)) return "rate-limit";
    if (QUOTA_RE.test(message)) return "quota";
    return "rate-limit";
  }
  if (status === 529 || t === "overloaded_error" || status === 503) return "overloaded";
  if (status >= 500 || status === 408 || status === 409) return "server";
  if (status === 400 && QUOTA_RE.test(message) && !/schema|output_config|json/i.test(message)) return "quota";
  if (status === 400 || status === 422) return "bad-request";
  return "other";
}

const KIND_TEXT: Record<AiErrorKind, string> = {
  "rate-limit": "hız sınırı aşıldı",
  overloaded: "servis aşırı yüklü",
  server: "sunucu hatası",
  network: "bağlantı hatası",
  timeout: "zaman aşımı",
  quota: "kota ya da bakiye bitti (Ayarlar'dan hesabı kontrol edin)",
  auth: "API anahtarı geçersiz (Ayarlar'dan anahtarı kontrol edin)",
  permission: "anahtarın bu işleme yetkisi yok",
  "not-found": "model bulunamadı ya da hesaba açık değil",
  "bad-request": "geçersiz istek",
  "too-large": "istek çok büyük",
  refusal: "model isteği reddetti",
  truncated: "yanıt uzunluk tavanında bile kesildi",
  "invalid-response": "yanıt şemaya ya da kurallara uymuyor",
  aborted: "iptal edildi",
  other: "beklenmeyen hata",
};

export function describeKind(kind: AiErrorKind): string {
  return KIND_TEXT[kind];
}

/** Bir hata ayar sorunu mu (anahtar, kota, yetki, model)? Bu durumda iş açıkça başarısız olmalı. */
export function isConfigError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const f = e as Partial<AiFailure>;
  if (typeof f.config === "boolean") return f.config;
  return typeof f.kind === "string" && CONFIG.has(f.kind as AiErrorKind);
}

/** `retry-after` başlığından bekleme (ms). */
export function retryAfterMs(headers: Headers | Record<string, string> | undefined | null): number | undefined {
  if (!headers) return undefined;
  const raw = headers instanceof Headers ? headers.get("retry-after") : (headers["retry-after"] ?? headers["Retry-After"]);
  if (!raw) return undefined;
  const sec = Number(raw);
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

export const sleepMs = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });

/** Üstel bekleme: 1 sn, 3 sn, 9 sn…; sunucu `retry-after` verdiyse o (en fazla 30 sn). */
export function backoffMs(retry: number, suggested?: number): number {
  if (suggested !== undefined) return Math.min(30_000, suggested);
  return 1000 * 3 ** Math.max(0, retry - 1);
}
