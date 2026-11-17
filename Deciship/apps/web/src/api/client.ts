import i18next from 'i18next';
import type { ApiErrorBody } from './types';

/**
 * DeciShip API istemcisi. Oturum, çerez, CSRF, dil ve 401 yenilemesi kabuğun oturum istemcisindedir (`api/session.ts`).
 * Burada kalanlar: API tabanı, sorgu dizesi, hata çevirisi, "sunucu meşgul" tekrarı ve indirme. Tarayıcı deposunda jeton yoktur.
 */
const API_BASE = '/api/deciship';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface SessionRequestInit {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** sayfadan çıkarken de yarıda kalmaz (vazgeçme çağrısı) */
  keepalive?: boolean;
}
export type SessionFetch = (path: string, init: SessionRequestInit) => Promise<Response>;

let sessionFetch: SessionFetch | null = null;

/** `api/session.ts` çağırır. Böylece bu modül kabuğu yüklemeden, tarayıcısız test edilir. */
export function bindSessionFetch(fn: SessionFetch) {
  sessionFetch = fn;
}

const FALLBACK_STATUSES = [400, 401, 403, 404, 409, 413, 502, 503, 504];

function fallbackMessage(status: number): string {
  const key = FALLBACK_STATUSES.includes(status) ? `apiError.${status}` : 'apiError.other';
  return i18next.t(key, { ns: 'common', status, defaultValue: `HTTP ${status}` });
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error */
  }
  const err = (body as ApiErrorBody | null)?.error;
  if (err && typeof err.message === 'string') {
    return new ApiError(res.status, err.code || 'ERROR', err.message, err.details);
  }
  return new ApiError(res.status, `HTTP_${res.status}`, fallbackMessage(res.status));
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** sayfadan çıkarken de yarıda kalmaz (vazgeçme çağrısı) */
  keepalive?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const qs = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, String(v));
    }
  }
  const s = qs.toString();
  return `${API_BASE}${path}${s ? `?${s}` : ''}`;
}

async function sendOnce(path: string, opts: RequestOptions, method: string): Promise<Response> {
  if (!sessionFetch) throw new Error('api/session.ts is not loaded');
  try {
    return await sessionFetch(buildUrl(path, opts.query), { method, body: opts.body, headers: opts.headers, signal: opts.signal, keepalive: opts.keepalive });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    // Kabuk kendi kararıyla reddettiyse (ORG_MISMATCH, NETWORK_UNAVAILABLE) kodu ve metni olduğu gibi kalır.
    const known = e as { status?: unknown; code?: unknown; message?: unknown; details?: unknown };
    if (typeof known.code === 'string' && typeof known.status === 'number') {
      throw new ApiError(known.status, known.code, String(known.message), known.details);
    }
    throw new ApiError(0, 'NETWORK', i18next.t('apiError.network', { ns: 'common', defaultValue: 'Network error' }));
  }
}

/** Kısa süreli DB yoğunluğunda (503 DB_UNAVAILABLE) GET'in tek yeniden denemesinden önceki bekleme. */
export const DB_BUSY_RETRY_MS = 1500;

async function isDbBusy(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  try {
    const body = (await res.clone().json()) as ApiErrorBody | null;
    return body?.error?.code === 'DB_UNAVAILABLE';
  } catch {
    return false;
  }
}

/**
 * GET only: "Sunucu meşgul" (503 DB_UNAVAILABLE) is retried once after a short pause, reads are safe to repeat.
 * POST/PATCH/DELETE are NEVER repeated automatically (could create/change twice).
 */
async function send(path: string, opts: RequestOptions = {}): Promise<Response> {
  const method = (opts.method ?? (opts.body !== undefined ? 'POST' : 'GET')).toUpperCase();
  const res = await sendOnce(path, opts, method);
  if (method !== 'GET' || !(await isDbBusy(res))) return res;
  await new Promise((r) => setTimeout(r, DB_BUSY_RETRY_MS));
  return sendOnce(path, opts, method);
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(path, opts);
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function filenameFromDisposition(h: string | null): string | null {
  if (!h) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(h);
  if (star) return decodeURIComponent(star[1]);
  const plain = /filename="?([^";]+)"?/i.exec(h);
  return plain ? plain[1] : null;
}

/** Çerezle dosya indirme (Excel/PDF/şablon). `headers`: ek istek başlıkları (itiraz ZIP'inde imza). */
export async function download(path: string, fallbackName: string, query?: RequestOptions['query'], headers?: Record<string, string>): Promise<void> {
  const res = await send(path, { query, method: 'GET', headers: { ...headers, Accept: '*/*' } });
  if (!res.ok) throw await toApiError(res);
  const blob = await res.blob();
  const name = filenameFromDisposition(res.headers.get('Content-Disposition')) ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Lists may come back as a bare array or as `{ items }`. */
export function asItems<T>(res: T[] | { items: T[] } | null | undefined): T[] {
  if (!res) return [];
  return Array.isArray(res) ? res : (res.items ?? []);
}

/** Single resources may come back wrapped (`{ measurement }`) or bare. */
export function unwrap<T>(res: unknown, key: string): T {
  if (res && typeof res === 'object' && key in (res as Record<string, unknown>)) {
    return (res as Record<string, T>)[key];
  }
  return res as T;
}
