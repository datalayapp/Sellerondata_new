import { finished } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DEFAULT_LOCALE, type Locale } from '@sellerondata/contracts';
import { KitError, kitMessage } from '../errors.ts';

/** Merkez uçlarının küçük HTTP yardımcıları (DeciShip `routes/platform.ts`, `services/hub/types.ts`). */

/** Yanıt kişiye ve dile özeldir: paylaşılan önbellekte tutulmaz. */
export function personalCache(reply: FastifyReply): void {
  void reply.header('Cache-Control', 'private, no-store');
  void reply.header('Vary', 'Accept-Language');
}

/**
 * İsteğin dili: `Accept-Language`'ta tr/en varsa o (ağırlık sırasıyla), yoksa jetondaki dil, o da yoksa İngilizce (karar 2026-11-12).
 * contracts `localeFromAcceptLanguage` başlıkta dil bulamayınca jetona düşmediği için ayrı.
 */
export function requestLocale(req: FastifyRequest, fallback?: string | null): Locale {
  const header = req.headers['accept-language'];
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  const ranked = raw
    .split(',')
    .map((part, i) => {
      const [tag, ...rest] = part.trim().toLowerCase().split(';');
      const q = rest.map((r) => /^\s*q=([\d.]+)/.exec(r)?.[1]).find(Boolean);
      return { lang: (tag ?? '').split('-')[0] ?? '', q: q ? Number(q) : 1, i };
    })
    .filter((x) => x.lang && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const r of ranked) if (r.lang === 'tr' || r.lang === 'en') return r.lang;
  return fallback === 'tr' || fallback === 'en' ? fallback : DEFAULT_LOCALE;
}

/** Sayfa parametresi: yalnız pozitif tam sayı. `1e30` ve `Infinity` sessizce kabul edilip veritabanında 500 olmasın. */
export function queryInt(value: unknown, fallback: number, name: string, locale: Locale): number {
  if (value === undefined || value === '') return fallback;
  const text = String(value);
  if (!/^[1-9]\d{0,8}$/.test(text)) throw new KitError(400, 'VALIDATION', kitMessage('filter', locale, { name }));
  return Number(text);
}

/**
 * İlerlemeyen akış kesilir: okumayan istemci yuvayı ve belleği sonsuza kadar tutmasın. Yanıt bitince süre kalkar.
 * Sınama isteğinde (`inject`) gerçek soket yoktur, bir şey yapılmaz.
 */
export function streamIdleTimeout(req: FastifyRequest, reply: FastifyReply, idleMs: number): void {
  const socket = req.raw.socket as (typeof req.raw.socket & { setTimeout?: unknown }) | undefined;
  if (typeof socket?.setTimeout !== 'function') return;
  socket.setTimeout(idleMs, () => socket.destroy());
  finished(reply.raw, () => socket.setTimeout(0));
}
