import type { ProductKey } from '@sellerondata/contracts';

/**
 * Aracın anahtarı ve adres öneki. Kayıttaki anahtarla aynı (`contracts/src/products.ts`); `satisfies` yazım hatasını derlemede yakalar.
 * Vite `base` değeri (vite.config.ts) ve nginx.conf öneki bununla aynı olmalıdır. Karşılığı: Deciship/apps/web/src/lib/base.ts.
 */
export const TOOL = 'ornekarac' satisfies ProductKey;
export const APP_BASE = `/${TOOL}`;

/** Bu `href` aracın kendi yolu mu? Değilse tam sayfa gezinti olur (Merkez, Hesap). */
export function isAppHref(href: string): boolean {
  return href === APP_BASE || href.startsWith(`${APP_BASE}/`) || href.startsWith(`${APP_BASE}?`);
}

/** `/<anahtar>/x?y=1` → `/x?y=1` (router yolu). */
export function toRouterPath(href: string): string {
  if (!isAppHref(href)) return href;
  const rest = href.slice(APP_BASE.length);
  return rest.startsWith('/') ? rest : `/${rest}`;
}

/** Router yolu → tarayıcı yolu. Kök için sonda `/` kalır. */
export function toFullPath(routerPath: string): string {
  return `${APP_BASE}${routerPath.startsWith('/') ? routerPath : `/${routerPath}`}`;
}

/** Oturum yoksa gidilecek Merkez girişi; `next` kalınan yeri taşır. */
export function loginHref(pathname: string, search = ''): string {
  return `/login?next=${encodeURIComponent(pathname + search)}`;
}

/** "Bu araçta web erişimin yok" sayfası Merkez'dedir (rol mobilde mi, hiç rol yok mu orada anlatılır). */
export const toolAccessHref = () => `/account/tool-access/${TOOL}`;
