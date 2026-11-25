/**
 * DeciShip tek köken altında `/deciship/` yolunda yayınlanır (ARCHITECTURE §3). Router `basename` ile çalışır: uygulama içi
 * yollar `/invoices` gibi yazılır. Kabuk ve tarayıcı tam yolu görür. Vite `base` değeri (vite.config.ts) ile aynı olmalıdır.
 */
export const APP_BASE = '/deciship';

/** Bu `href` DeciShip'in kendi yolu mu? Değilse tam sayfa gezinti olur (Merkez, Hesap). */
export function isAppHref(href: string): boolean {
  return href === APP_BASE || href.startsWith(`${APP_BASE}/`) || href.startsWith(`${APP_BASE}?`);
}

/** `/deciship/invoices?x=1` → `/invoices?x=1` (router yolu). */
export function toRouterPath(href: string): string {
  if (!isAppHref(href)) return href;
  const rest = href.slice(APP_BASE.length);
  return rest.startsWith('/') ? rest : `/${rest}`;
}

/** Router yolu → tarayıcı yolu. Kök için sonda `/` kalır: `/deciship/`. */
export function toFullPath(routerPath: string): string {
  return `${APP_BASE}${routerPath.startsWith('/') ? routerPath : `/${routerPath}`}`;
}

/** Oturum yoksa gidilecek Merkez girişi; `next` kalınan yeri taşır. */
export function loginHref(pathname: string, search = ''): string {
  return `/login?next=${encodeURIComponent(pathname + search)}`;
}
