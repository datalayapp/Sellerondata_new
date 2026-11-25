import { type Locale, type Permission, errorMessage, requestLocaleOf } from "@sellerondata/contracts";
import type { RouteAccess } from "../features/route-map.ts";
import { type OrgContext, maybeOrg } from "./context.ts";

/**
 * Erişim türünün platform izinleri (plan §S6; tek kaynak). Yerel kipte izinler `all` (denetim yok).
 * - `spend` (yapay zekâ harcaması): `tagpress.ai.use` VE `tagpress.work.edit` (harcama iş de yazar; iki hazır rolde
 *   ikisi de var, özel rolde biri eksikse harcama yok).
 * - Harcama tutarları (`GET /api/costs`, çağrı ayrıntısı, iş günlüğündeki tutarlar) yalnız `manage` (TagPress Yöneticisi).
 */
export const ACCESS_PERMISSIONS = {
  read: ["tagpress.web.access"],
  write: ["tagpress.work.edit"],
  spend: ["tagpress.ai.use", "tagpress.work.edit"],
  manage: ["tagpress.settings.manage"],
} as const satisfies Record<RouteAccess, readonly Permission[]>;

/** İzin listesi erişimi karşılıyor mu (`all`: yerel kip). */
export function hasAccess(permissions: OrgContext["permissions"], access: RouteAccess): boolean {
  if (permissions === "all") return true;
  return ACCESS_PERMISSIONS[access].every((p) => permissions.includes(p));
}

/** Erişimin eksik izinleri (yoksa boş). */
export function missingPermissions(permissions: OrgContext["permissions"], access: RouteAccess): Permission[] {
  if (permissions === "all") return [];
  return ACCESS_PERMISSIONS[access].filter((p) => !permissions.includes(p));
}

/**
 * Platform izni yok: 403 `FORBIDDEN`, gövde auth-kit'inkiyle aynı biçimde (`{ error: { code, message, details } }`; arayüz
 * platform hatalarını tek yoldan okur: yetkiyi tazeler). `app.ts` hata işleyicisi yazar.
 */
export class AccessDeniedError extends Error {
  readonly status = 403;
  constructor(
    readonly access: RouteAccess,
    readonly missing: readonly Permission[],
  ) {
    super(`İzin yok (${access}: ${missing.join(", ")}).`);
    this.name = "AccessDeniedError";
  }

  body(locale: Locale): { error: { code: "FORBIDDEN"; message: string; details: { access: RouteAccess; missing: Permission[] } } } {
    return { error: { code: "FORBIDDEN", message: errorMessage("FORBIDDEN", locale), details: { access: this.access, missing: [...this.missing] } } };
  }
}

/** Hata gövdesinin dili: `Accept-Language`, yoksa oturumun dili (auth-kit kuralı). */
export function accessErrorLocale(acceptLanguage: string | undefined, sessionLocale: string | null | undefined): Locale {
  return requestLocaleOf(acceptLanguage, sessionLocale);
}

/**
 * Geçerli firma bağlamında erişim yoksa `AccessDeniedError`. Harcamaya giden ortak noktalar (üretim kuyruğu, şablon
 * görevi, oluşturucunun payı, deneme) uç kapısından bağımsız olarak bunu çağırır: başka uçtan (ör. içe aktarma
 * `generate: true`) gelen harcama da aynı izni ister. Bağlam yoksa denetlemez (firma kapsamlı veritabanı zaten hata verir).
 */
export function requireAccess(access: RouteAccess): void {
  const org = maybeOrg();
  if (!org) return;
  const missing = missingPermissions(org.permissions, access);
  if (missing.length) throw new AccessDeniedError(access, missing);
}

/** Geçerli firma bağlamı harcama tutarlarını görebilir mi (yerel kip ve bağlamsız: evet; platformda `manage`). */
export function canSeeAmounts(): boolean {
  const org = maybeOrg();
  return !org || hasAccess(org.permissions, "manage");
}
