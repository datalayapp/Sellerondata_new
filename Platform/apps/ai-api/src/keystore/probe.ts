import type { AiProvider } from '@sellerondata/contracts';

/**
 * Anahtarın ücretsiz sınaması: sağlayıcının model listesi (Anthropic `GET /v1/models`, Gemini `GET /v1beta/models`). Belirteç
 * harcamaz, deftere yazılmaz.
 * - 2xx: `ok`. Anthropic 401/403, Gemini 400/401/403 (geçersiz anahtar Gemini'de 400 `API_KEY_INVALID`): `rejected`.
 * - Diğer her durum (429, 5xx, ağ hatası, zaman aşımı): `unreachable`; anahtar hakkında karar verilmez.
 * Yanıt gövdesi okunup atılır: sağlayıcının hata metni anahtarı yansıtabilir, hiçbir yere yazılmaz. Yönlendirme izlenmez
 * (anahtar başlığı başka adrese taşınmasın).
 */
export type ProbeResult = { kind: 'ok' | 'rejected' | 'unreachable'; httpStatus: number | null };
export type ProviderProbe = (provider: AiProvider, key: string) => Promise<ProbeResult>;

export const ANTHROPIC_VERSION = '2023-06-01';
const PROBE_TIMEOUT_MS = 10_000;

export function createProviderProbe(opts: { baseUrls: () => Record<AiProvider, string>; fetch?: typeof fetch; timeoutMs?: number }): ProviderProbe {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  return async (provider, key) => {
    const base = opts.baseUrls()[provider];
    const req: { url: string; headers: Record<string, string> } =
      provider === 'anthropic'
        ? { url: `${base}/v1/models?limit=1`, headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, accept: 'application/json' } }
        : { url: `${base}/v1beta/models?pageSize=1`, headers: { 'x-goog-api-key': key, accept: 'application/json' } };
    let res: Response;
    try {
      res = await doFetch(req.url, { method: 'GET', headers: req.headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      return { kind: 'unreachable', httpStatus: null };
    }
    // Gövde bağlantıyı boşaltmak için okunur, içeriğine bakılmaz.
    await res.arrayBuffer().catch(() => undefined);
    const s = res.status;
    if (s >= 200 && s < 300) return { kind: 'ok', httpStatus: s };
    const rejected = provider === 'anthropic' ? s === 401 || s === 403 : s === 400 || s === 401 || s === 403;
    return { kind: rejected ? 'rejected' : 'unreachable', httpStatus: s };
  };
}
