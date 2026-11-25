import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { AI_GATEWAY_KEY_HEADERS, type AiProvider } from '@sellerondata/contracts';

/**
 * Başlık süzgeci. İstek: aracın başlıkları olduğu gibi gider (`anthropic-version`, `anthropic-beta`, `content-type`, SDK'nın
 * `x-stainless-*` başlıkları dahil); yalnız bağlantı başlıkları, kimlik (araç jetonu, `authorization`, çerez), vekil izleri ve bağlam
 * (`x-sod-*`) silinir, gerçek anahtar eklenir. `accept-encoding: identity`: yanıt sıkıştırılmadan gelir, araca bayt bayt aynı geçer.
 * Yanıt: sağlayıcının başlıkları (durum, `request-id`, `retry-after`, `anthropic-ratelimit-*`, `x-should-retry`) olduğu gibi; bağlantı
 * başlıkları, `content-length`/`content-encoding` (Node yeniden çerçeveler), `set-cookie` ve `x-sod-*` silinir.
 */

const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization'];

const DROP_REQUEST = new Set([
  ...HOP,
  'host',
  'content-length',
  'accept-encoding',
  'expect',
  'authorization',
  'cookie',
  'x-api-key',
  'x-goog-api-key',
  'forwarded',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-prefix',
  'x-real-ip',
]);

const DROP_RESPONSE = new Set([...HOP, 'content-length', 'content-encoding', 'set-cookie', 'set-cookie2']);

export function upstreamRequestHeaders(incoming: IncomingHttpHeaders, provider: AiProvider, key: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    const n = name.toLowerCase();
    if (value === undefined || DROP_REQUEST.has(n) || n.startsWith('x-sod-') || n.startsWith('x-envoy-')) continue;
    out[n] = Array.isArray(value) ? value.join(', ') : value;
  }
  out['accept-encoding'] = 'identity';
  out[AI_GATEWAY_KEY_HEADERS[provider]] = key;
  return out;
}

export function clientResponseHeaders(upstream: Headers): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  upstream.forEach((value, name) => {
    const n = name.toLowerCase();
    if (DROP_RESPONSE.has(n) || n.startsWith('x-sod-')) return;
    out[n] = value;
  });
  return out;
}

/** Sağlayıcıya giden sorgu: yalnız izinli parametreler (Anthropic `beta`, Gemini `alt`); `key=` ve diğerleri hiç gitmez. */
export function upstreamQuery(url: string, provider: AiProvider): string {
  const q = url.indexOf('?');
  if (q < 0) return '';
  const allowed = provider === 'anthropic' ? ['beta'] : ['alt'];
  const src = new URLSearchParams(url.slice(q + 1));
  const out = new URLSearchParams();
  for (const name of allowed) {
    const v = src.get(name);
    if (v !== null && /^[A-Za-z0-9_-]{1,16}$/.test(v)) out.set(name, v);
  }
  const s = out.toString();
  return s ? `?${s}` : '';
}
