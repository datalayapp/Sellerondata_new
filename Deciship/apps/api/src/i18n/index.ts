import { AsyncLocalStorage } from 'node:async_hooks';
import { type Locale } from '@deciship/core';
import { DEFAULT_LOCALE, requestLocaleOf } from '@sellerondata/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MESSAGES, type MessageKey } from './messages.ts';

export type { MessageKey } from './messages.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** `Accept-Language`ten. Yanıt metinleri ve üretilen dosyalar bu dilde. */
    locale: Locale;
  }
}

/**
 * Küresel dil yok: her istek kendi bağlamında (`requestLocale`), her iş kendi kayıtlı dilinde. Bağlam dışında (betik, demo
 * tohumu) Türkçe: demo verisi Türkçe. "Dil bilgisi yok" son çaresi (İngilizce) istekte `requestLocale`'dedir.
 */
const localeStore = new AsyncLocalStorage<Locale>();

export function currentLocale(): Locale {
  return localeStore.getStore() ?? 'tr';
}

export function withLocale<T>(locale: Locale, work: () => T): T {
  return localeStore.run(locale, work);
}

export type MessageParams = Record<string, string | number>;

/** `{ad}` değer koyar; `{ad|tekil|çoğul}` değer bir ise tekili, değilse çoğulu yazar (core'daki t() ile aynı söz dizimi). */
const PLACEHOLDER = /\{(\w+)(?:\|([^|}]*)\|([^}]*))?\}/g;
const isOne = (v: string | number) => Number(String(v).replace(/[.,\s]/g, '')) === 1;

export function isMessageKey(value: string): value is MessageKey {
  return Object.hasOwn(MESSAGES, value);
}

/** Metin, istenen dilde; dil verilmezse isteğin dili. */
export function m(key: MessageKey, params?: MessageParams, locale: Locale = currentLocale()): string {
  const template: string = MESSAGES[key][locale];
  if (!params) return template;
  return template.replace(PLACEHOLDER, (whole, name: string, one?: string, other?: string) => {
    const v = params[name];
    if (v === undefined) return whole;
    return one === undefined ? String(v) : isOne(v) ? one : (other ?? '');
  });
}

/**
 * Tek kural: `Accept-Language`'taki desteklenen dil, yoksa oturumun dili, o da yoksa İngilizce (kullanıcı kararı 2026-11-12).
 * Hata, yanıt ve Merkez aynı kuralı kullanır.
 */
export function requestLocale(req: FastifyRequest): Locale {
  return requestLocaleOf(req.headers['accept-language'], (req as { auth?: { locale?: string } | null }).auth?.locale);
}

/** Her isteğin dili. Gövde okunduktan sonra bağlam düşer: `preHandler`da yeniden açılır (bkz. app.ts). */
export function registerLocale(app: FastifyInstance) {
  app.decorateRequest('locale', DEFAULT_LOCALE);
  app.addHook('onRequest', (req, _reply, done) => {
    req.locale = requestLocale(req);
    withLocale(req.locale, done);
  });
  app.addHook('preHandler', (req, _reply, done) => {
    // Kimlik artık belli: başlık yoksa oturumun dili geçerli.
    req.locale = requestLocale(req);
    withLocale(req.locale, done);
  });
}
