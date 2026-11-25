/**
 * Platform kipi (SellerOnData'nın içinde çalışan TagPress). Yapı bayrağı `VITE_TAGPRESS_PLATFORM=1` (`pnpm --filter
 * @tagpress/web build:platform`): taban `/tagpress/`, sunucu `/api/tagpress/<yol>` (sunucu içeride `/api/<yol>`'a çevirir),
 * oturum kabuğun oturum istemcisiyle (`src/oturum/`). Bayrak yoksa yerel kip: bugünkü üst satır, `/api`, `X-Studio`.
 *
 * Bayrak her çağrıda okunur (Vite derlemede sabite çevirir; testler `vi.stubEnv` ile değiştirir).
 */
export function isPlatform(): boolean {
  return import.meta.env.VITE_TAGPRESS_PLATFORM === "1";
}

/** Aracın kayıttaki anahtarı (`Platform/packages/contracts/src/products.ts`). */
export const TOOL = "tagpress";
/** Platformda web'in adres öneki (Vite `base` ile aynı). */
export const APP_BASE = `/${TOOL}`;
/** Platformda sunucunun dış öneki. */
export const API_PREFIX = `/api/${TOOL}`;

/**
 * Sunucu adresi: yerel kipte olduğu gibi; platformda `/api/x` → `/api/tagpress/x`. İki kez çağrılsa da aynı sonucu verir
 * (zaten önekli adres değişmez). `/api` dışındaki adreslere (veri adresi, karma, tam adres) dokunulmaz.
 */
export function apiUrl(url: string): string {
  if (!isPlatform()) return url;
  if (url === API_PREFIX || url.startsWith(`${API_PREFIX}/`) || url.startsWith(`${API_PREFIX}?`)) return url;
  if (url === "/api" || url.startsWith("/api/") || url.startsWith("/api?")) return `${API_PREFIX}${url.slice(4)}`;
  return url;
}

/** Adres taşıyan alan adı: `imageUrl`, `previewUrl`, `url`, `href` … (müşteri metni bu adlarda durmaz). */
const URL_KEY = /(?:^url|Url|^href|Href)$/;

/**
 * Sunucu yanıtındaki görsel/indirme adresleri (`previewUrl: "/api/variants/…"`) platformda önekli olur. Yalnız adı adres
 * olan alanlar ve `/api/` ile başlayan değerler değişir; başka metne (müşteri metni dahil) dokunulmaz. Yerinde değiştirir.
 */
export function rewriteApiUrls<T>(data: T): T {
  if (!isPlatform()) return data;
  const walk = (v: unknown, depth: number): void => {
    if (depth > 12 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    for (const [k, x] of Object.entries(o)) {
      if (typeof x === "string") {
        if (URL_KEY.test(k) && x.startsWith("/api/")) o[k] = apiUrl(x);
      } else walk(x, depth + 1);
    }
  };
  walk(data, 0);
  return data;
}

/** Oturum yoksa gidilen Merkez girişi; `next` kalınan yeri (karma dahil) taşır. */
export function loginHref(loc: Pick<Location, "pathname" | "search" | "hash"> = window.location): string {
  return `/login?next=${encodeURIComponent(loc.pathname + loc.search + loc.hash)}`;
}

/** "Bu araçta erişimin yok" sayfası Merkez'dedir (rol mobilde mi, hiç rol yok mu orada anlatılır). */
export const toolAccessHref = (): string => `/account/tool-access/${TOOL}`;
/** Firma kapalı: Hesabım › Firmalar. */
export const FIRMS_HREF = "/account/firms";
/** Merkez'de firma bilgileri (ad orada değişir). */
export const COMPANY_HREF = "/account/company";
