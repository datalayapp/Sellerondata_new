/** Yanıt ve hata okuma. Saf: `fetch`e bağlı değil, RN bilmez. */

export type HubErrorKind = 'network' | 'forbidden' | 'server';

export class HubApiError extends Error {
  status: number;
  code: string;
  kind: HubErrorKind;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.kind = status === 0 ? 'network' : status === 403 ? 'forbidden' : 'server';
  }
}

/** İstemci ağ hatasında `status: 0` taşıyan hata ya da düz `TypeError` atar; ikisi de çevrimdışı sayılır. */
export function toHubError(e: unknown): HubApiError {
  if (e instanceof HubApiError) return e;
  const status = (e as { status?: unknown } | null)?.status;
  const code = (e as { code?: unknown } | null)?.code;
  const message = (e as { message?: unknown } | null)?.message;
  if (typeof status === 'number') return new HubApiError(status, typeof code === 'string' ? code : `HTTP_${status}`, typeof message === 'string' ? message : '');
  if (e instanceof TypeError) return new HubApiError(0, 'NETWORK', e.message);
  return new HubApiError(-1, 'UNKNOWN', typeof message === 'string' ? message : '');
}

/** Hata gövdesi her serviste aynı: `{ error: { code, message } }` (ARCHITECTURE §6). */
export async function readJson<T>(res: Pick<Response, 'ok' | 'status' | 'text'>): Promise<T> {
  const text = await res.text().catch(() => '');
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new HubApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? '');
  }
  if (text && body === undefined) throw new HubApiError(res.status, 'BAD_JSON', '');
  return body as T;
}

export function query(params: Record<string, string | undefined | null>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}
