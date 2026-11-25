import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AI_GATEWAY_KEY_HEADERS, aiRejectBody, aiRejectHeaders, type AiProvider, type ProductKey } from '@sellerondata/contracts';
import { registerSecret } from '../keystore/scrub.ts';

/**
 * Araç kimliği (`/internal/*`, yalnız iç ağ): SDK'nın kendi anahtar başlığı (`x-api-key` Anthropic yolu ve durum uçları,
 * `x-goog-api-key` Gemini yolu) = `AI_GATEWAY_TOKENS` içindeki araç jetonu; ürün jetondan çözülür. Karşılaştırma sabit sürede ve
 * her jetonla yapılır (erken çıkış yok). `Authorization`, sorgu dizgesindeki `key=` ve öbür sağlayıcının başlığı kabul edilmez.
 * Eksik ya da yanlış jeton: `401`, gövde yolun sağlayıcı biçiminde `sod_unauthorized`, `x-sod-ai-reject` + `x-should-retry: false`.
 */

export type ToolIdentity = { product: ProductKey };

declare module 'fastify' {
  interface FastifyRequest {
    tool?: ToolIdentity;
  }
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export type ToolResolver = (presented: string | undefined) => ProductKey | null;

export function createToolResolver(tokens: () => ReadonlyMap<ProductKey, string>): ToolResolver {
  let source: ReadonlyMap<ProductKey, string> | null = null;
  let digests: [ProductKey, Buffer][] = [];
  return (presented) => {
    const current = tokens();
    if (current !== source) {
      source = current;
      digests = [...current].map(([product, token]) => {
        registerSecret(token);
        return [product, digest(token)];
      });
    }
    const value = typeof presented === 'string' ? presented.trim() : '';
    if (!value || value.length > 512) return null;
    const given = digest(value);
    let found: ProductKey | null = null;
    // Her jetonla karşılaştırılır (erken çıkış yok): hangi aracın jetonuna yakın olduğu süreden okunmasın.
    for (const [product, d] of digests) if (timingSafeEqual(given, d) && found === null) found = product;
    return found;
  };
}

/** Yolun sağlayıcısı: Gemini öneki Gemini, diğer her araç yolu (Anthropic, durum, hak) Anthropic başlığı ve biçimi. */
export function providerOfPath(path: string): AiProvider {
  return path.startsWith('/internal/gemini/') || path === '/internal/gemini' ? 'gemini' : 'anthropic';
}

/** Yolun eşleşen rotası (kodlanmış yol da eşleşmiş rotanın şablonuyla gelir), eşleşme yoksa çözülmüş istek yolu. */
export function routePathOf(req: FastifyRequest): string {
  const route = req.routeOptions?.url;
  if (route) return route;
  const raw = req.url.split('?')[0] ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function sendToolReject(reply: FastifyReply, provider: AiProvider, code: 'sod_unauthorized', message = 'gateway token missing or invalid') {
  void reply.headers(aiRejectHeaders(code));
  void reply.header('cache-control', 'no-store');
  return reply.status(401).send(aiRejectBody(provider, code, message));
}

export function toolAuthHook(resolve: ToolResolver) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const provider = providerOfPath(routePathOf(req));
    const header = req.headers[AI_GATEWAY_KEY_HEADERS[provider]];
    const product = resolve(Array.isArray(header) ? undefined : header);
    if (!product) return sendToolReject(reply, provider, 'sod_unauthorized');
    req.tool = { product };
  };
}
