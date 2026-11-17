import { hubOwnedProductKeys } from '@sellerondata/contracts';

/** Merkez'in kendi yolları. Bunlara kayıtta `deploy.web` olmayan araçların yolları eklenir (`isHubPath`). */
const HUB_OWN_PATHS = ['home', 'analytics', 'data', 'activity', 'account', 'invite'];
const HUB_PATHS = new RegExp(`^/(${[...HUB_OWN_PATHS, ...hubOwnedProductKeys()].join('|')})(/|$)`);
/** Girişten sonra dönülmez: dönülürse giriş sayfası kendine yönlenir. */
const AUTH_PATHS = /^\/(login|register|join|forgot-password|reset-password|verify-email)(\/|$)/;

/** Bu yol Merkez'in router'ında mı? Değilse başka uygulamadır, tam sayfa gidilir (`/deciship/*`). Web'i olmayan araçların yolları Merkez'indir. */
export function isHubPath(href: string): boolean {
  return HUB_PATHS.test(href.split(/[?#]/)[0] ?? '');
}

/**
 * `next` yalnız aynı kökende göreli yol olabilir: açık yönlendirme açılmaz.
 * Sonucun kendisi de denetlenir: `/..//evil.test` çözülünce `//evil.test` olur.
 */
export function safeNext(next: string | null): string {
  const fallback = '/home';
  // eslint-disable-next-line no-control-regex -- kontrol karakteri taşıyan dönüş adresi bilerek reddedilir.
  if (!next || !next.startsWith('/') || /[\\\u0000-\u001f]/.test(next)) return fallback;
  try {
    const url = new URL(next, window.location.origin);
    const to = url.pathname + url.search + url.hash;
    if (url.origin !== window.location.origin || to.startsWith('//') || AUTH_PATHS.test(url.pathname)) return fallback;
    return to;
  } catch {
    return fallback;
  }
}
