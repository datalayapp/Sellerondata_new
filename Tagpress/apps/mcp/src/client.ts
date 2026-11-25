import { tagpressEnv } from "@tagpress/domain/env";

/**
 * TagPress HTTP API istemcisi (MCP araçlarının tek bağlantısı). Uygulama aboneliği ya da AI anahtarı bilmez:
 * yalnızca yerel uygulamayla konuşur. Değiştiren isteklerde `X-Studio: 1` başlığı zorunludur.
 */

export const DEFAULT_URL = "http://127.0.0.1:5420";

export class TagpressError extends Error {
  constructor(
    message: string,
    /** HTTP durumu; 0 = uygulamaya ulaşılamadı. */
    readonly status: number,
    readonly fields?: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Varsayılan istek süresi sınırı (ms). */
  timeoutMs?: number;
}

export class TagpressClient {
  readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? tagpressEnv("URL") ?? DEFAULT_URL).replace(/\/+$/, "");
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  get<T>(path: string, timeoutMs?: number): Promise<T> {
    return this.request<T>("GET", path, undefined, timeoutMs);
  }

  post<T>(path: string, body: unknown = {}, timeoutMs?: number): Promise<T> {
    return this.request<T>("POST", path, body, timeoutMs);
  }

  /** PNG'yi base64 olarak getirir (MCP görsel içeriği için). */
  async image(path: string): Promise<string> {
    const res = await this.raw("GET", path, undefined, this.timeoutMs);
    if (!res.ok) throw await this.errorOf(res);
    return Buffer.from(await res.arrayBuffer()).toString("base64");
  }

  private async request<T>(method: string, path: string, body: unknown, timeoutMs?: number): Promise<T> {
    const res = await this.raw(method, path, body, timeoutMs ?? this.timeoutMs);
    if (!res.ok) throw await this.errorOf(res);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  private async raw(method: string, path: string, body: unknown, timeoutMs: number): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (method !== "GET") headers["x-studio"] = "1";
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      return await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new TagpressError(`TagPress ${Math.round(timeoutMs / 1000)} sn içinde yanıt vermedi (${method} ${path}). İşlem uygulamada sürüyor olabilir; biraz sonra tekrar deneyin.`, 0);
      }
      throw new TagpressError(
        `TagPress uygulamasına ulaşılamadı (${this.baseUrl}). Uygulama kapalı görünüyor: proje klasöründe \`pnpm start\` ile açın, sonra tekrar deneyin.`,
        0,
      );
    }
  }

  private async errorOf(res: Response): Promise<TagpressError> {
    let msg = `İstek başarısız (HTTP ${res.status}).`;
    let fields: TagpressError["fields"];
    try {
      const j = (await res.json()) as { error?: string; fields?: Array<{ path: string; message: string }> };
      if (j.error) msg = j.error;
      fields = j.fields;
    } catch {
      /* gövde JSON değil */
    }
    if (res.status === 404 && msg.startsWith("İstek başarısız")) msg = "Uç bulunamadı (uygulama sürümü bu aracı desteklemiyor olabilir).";
    return new TagpressError(msg, res.status, fields);
  }
}

/** Yol parametrelerini doldurur. */
export const p = (path: string, params: Record<string, string | number>) =>
  path.replace(/:([a-zA-Z]+)/g, (m, k: string) => (k in params ? encodeURIComponent(String(params[k])) : m));
