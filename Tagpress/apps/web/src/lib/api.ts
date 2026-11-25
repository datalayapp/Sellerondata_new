import type { ApiError } from "@tagpress/domain";
import { i18n } from "../i18n/index.ts";
import { apiUrl, isPlatform, rewriteApiUrls } from "./platform.ts";

/**
 * Sunucu istemcisi. Hata gövdesi `ApiError` olarak fırlatılır.
 * - Yerel kip: istekler `/api` altında; değiştiren isteklere `X-Studio: 1` (sunucu yabancı kökenli isteği reddeder).
 * - Platform kipi (`lib/platform.ts`): adresler `/api/tagpress` altında; istek kabuğun oturum istemcisiyle gider
 *   (`oturum/istemci.ts` bağlar: çerez, `X-SOD-CSRF: 1`, `X-SOD-Org`, `Accept-Language`, 401'de bir kez yenile + yeniden dene).
 *   Platform hata gövdesi (`{ error: { code, message } }`) `ApiError` biçimine çevrilir; yanıttaki görsel adresleri öneklenir.
 */
export class ApiFailure extends Error {
  constructor(
    public status: number,
    public body: ApiError,
  ) {
    super(body.error);
  }
}

/** "/api/jobs/:id" + { id: "x" } → "/api/jobs/x" (platformda "/api/tagpress/jobs/x"). */
export function path(template: string, params: Record<string, string | number> = {}): string {
  return apiUrl(
    template.replace(/:([a-zA-Z]+)/g, (_, k: string) => {
      const v = params[k];
      if (v === undefined) throw new Error(`Yol parametresi eksik: ${k}`);
      return encodeURIComponent(String(v));
    }),
  );
}

export function withQuery(p: string, q: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  const base = apiUrl(p);
  return s ? `${base}?${s}` : base;
}

/** Platform kipinde isteği gönderen işlev (kabuğun oturum istemcisinin `raw`'ı; `oturum/istemci.ts` bağlar). */
export type PlatformTransport = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;
let transport: PlatformTransport | null = null;
export function bindPlatformTransport(fn: PlatformTransport | null): void {
  transport = fn;
}

/** Platform hatasına tepki (giriş, erişim sayfası, firma uyuşmazlığı; `oturum/hatalar.ts` bağlar). */
let platformErrorHandler: ((f: ApiFailure) => void) | null = null;
export function onPlatformError(fn: ((f: ApiFailure) => void) | null): void {
  platformErrorHandler = fn;
}

/** Platform (auth-kit) hata gövdesi `{ error: { code, message, details } }` → `ApiError` (`{ error, code }`). */
function normalizeError(data: unknown): ApiError | undefined {
  if (!data || typeof data !== "object") return undefined;
  const e = (data as { error?: unknown }).error;
  if (e && typeof e === "object") {
    const pe = e as { code?: unknown; message?: unknown };
    return { error: typeof pe.message === "string" ? pe.message : "", ...(typeof pe.code === "string" ? { code: pe.code } : {}) };
  }
  return typeof e === "string" ? (data as ApiError) : undefined;
}

async function send(method: string, url: string, headers: Record<string, string>, body: string | undefined, signal: AbortSignal | undefined): Promise<Response> {
  if (!isPlatform()) return fetch(url, { method, headers, body, signal });
  if (method !== "GET") headers["X-SOD-CSRF"] = "1";
  if (transport) return transport(url, { method, headers, body, signal });
  return fetch(url, { method, headers, body, signal, credentials: "include" });
}

/**
 * Platform kipinde sunucu akışını (SSE) açar (`lib/sse.ts`): oturum istemcisiyle gider (çerez, `X-SOD-Org`,
 * `Accept-Language`, 401'de bir kez yenile + yeniden dene). `lastEventId` verilirse `Last-Event-ID` başlığı gönderilir.
 */
export function openPlatformStream(url: string, opts: { signal: AbortSignal; lastEventId: string | null }): Promise<Response> {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (opts.lastEventId) headers["Last-Event-ID"] = opts.lastEventId;
  return send("GET", apiUrl(url), headers, undefined, opts.signal);
}

/** Açılamayan akışın yanıtı → `ApiFailure`; platform kipinde sayfa düzeyi tepkiye de verilir (erişim, firma, yetki). */
export async function streamFailure(res: Response): Promise<ApiFailure> {
  let data: unknown;
  try {
    const text = await res.text();
    data = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    data = undefined;
  }
  const failure = new ApiFailure(res.status, normalizeError(data) ?? { error: i18n.t("common:network.httpStatus", { status: res.status }) });
  if (isPlatform()) platformErrorHandler?.(failure);
  return failure;
}

/**
 * Son "anahtar yok" (`code: "missing-key"`) hatası. Hata bildirimi (`ToastProvider`) bu mesajı içeren bir
 * hata gösterirken "Bağlantılar'a git" eylemini ekler.
 */
let lastMissingKey: { error: string; at: number } | null = null;
export function recentMissingKey(): string | null {
  return lastMissingKey && Date.now() - lastMissingKey.at < 10_000 ? lastMissingKey.error : null;
}

/** Ayarlar → Bağlantılar. */
export function goToConnections(): void {
  window.location.hash = "#/ayarlar/baglantilar";
}

/**
 * Son "özellik kapalı" yanıtı (`409 { code: "feature-off", feature }`). Tezgâh hata bildirimi (`ToastProvider`) bu
 * hatayı gösterirken "Aç" eylemini ekler: özellik açılır, ardından aynı istek "Yeniden dene" ile tekrar gönderilebilir
 * (kendiliğinden gönderilmez: ücretli bir istek kullanıcı istemeden tekrarlanmasın).
 */
export interface FeatureOff {
  feature: string;
  /** Sunucunun cümlesi (bildirim metniyle eşleştirmek için). */
  error: string;
  at: number;
  /** Reddedilen isteği aynı yöntem, adres ve gövdeyle yeniden gönderir. */
  retry: () => Promise<unknown>;
}
let lastFeatureOff: FeatureOff | null = null;
export function recentFeatureOff(): FeatureOff | null {
  return lastFeatureOff && Date.now() - lastFeatureOff.at < 10_000 ? lastFeatureOff : null;
}

async function request<T>(method: string, rawUrl: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const url = apiUrl(rawUrl);
  const headers: Record<string, string> = {};
  if (method !== "GET" && !isPlatform()) headers["X-Studio"] = "1";
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await send(method, url, headers, body === undefined ? undefined : JSON.stringify(body), signal);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    // Oturum istemcisi bazı istekleri göndermeden reddeder: başka firmaya geçmiş sekmede okuma (409 `ORG_MISMATCH`). Kabuğun
    // oturum uyarısı o anda açıktır (yenile / bu firmaya dön); sayfa düzeyi tepki yalnız sunucunun yanıtına verilir.
    const se = e as { status?: unknown; code?: unknown; message?: unknown };
    if (typeof se.status === "number" && se.status > 0 && typeof se.code === "string") {
      throw new ApiFailure(se.status, { error: typeof se.message === "string" ? se.message : "", code: se.code });
    }
    throw new ApiFailure(0, { error: i18n.t("common:network.unreachable") });
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const err = normalizeError(data) ?? { error: i18n.t("common:network.httpStatus", { status: res.status }) };
    if (err.code === "missing-key") lastMissingKey = { error: err.error, at: Date.now() };
    if (err.code === "feature-off" && err.feature) lastFeatureOff = { feature: err.feature, error: err.error, at: Date.now(), retry: () => request(method, url, body) };
    const failure = new ApiFailure(res.status, err);
    if (isPlatform()) platformErrorHandler?.(failure);
    throw failure;
  }
  return rewriteApiUrls(data as T);
}

export const api = {
  get: <T>(url: string, signal?: AbortSignal) => request<T>("GET", url, undefined, signal),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>("PUT", url, body ?? {}),
  patch: <T>(url: string, body?: unknown) => request<T>("PATCH", url, body ?? {}),
  del: <T>(url: string, body?: unknown) => request<T>("DELETE", url, body),
};
