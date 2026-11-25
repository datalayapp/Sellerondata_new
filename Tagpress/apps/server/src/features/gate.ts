import type { Permission } from "@sellerondata/contracts";
import type { FastifyInstance, onRequestHookHandler, preHandlerAsyncHookHandler, RouteOptions } from "fastify";
import { ACCESS_PERMISSIONS, AccessDeniedError, accessErrorLocale } from "../org/access.ts";
import { fail } from "../util/errors.ts";
import { PLATFORM_MANAGED_ROUTES, PLATFORM_MANAGE_READS, type RouteAccess, gated, platformRoute, routeFeature } from "./route-map.ts";
import type { FeatureService } from "./service.ts";

/** Kayıtlı uçların özellik tablosuyla eşleşmesi (`route-map.test.ts`). */
export interface FeatureGateReport {
  /** Kaydedilen bütün uçlar (`METOT yol`; HEAD kopyaları dahil). */
  registered: string[];
  /** Tabloda olmayan uçlar (çekirdek sayılır, kapanmaz; test boş olmasını ister). Platform uçları (`PLATFORM_ROUTES`) sayılmaz. */
  unmapped: string[];
}

/**
 * Özellik kapısı (SUNUCU-PLANI §3.3): `onRoute` her uca tablodaki kaydını bağlar; kaydı olan yazma/harcama uçlarına
 * `preHandler` eklenir ve özellik kapalıysa istek 409 `feature-off` ile durur (gövde işlenmeden, hiçbir şey yazılmadan).
 * Okuma uçları ve çekirdek uçlar açık kalır. Firma bağlamı kurulduktan sonra çalışır (`registerOrgContext`'in
 * `preHandler`'ı uygulama düzeyindedir, uç düzeyindeki bu kancadan önce koşar). Uçlardan ÖNCE kaydedilmelidir.
 */
export function registerFeatureGate(app: FastifyInstance, features: FeatureService): FeatureGateReport {
  const report: FeatureGateReport = { registered: [], unmapped: [] };
  app.addHook("onRoute", (route: RouteOptions) => {
    let anyGated = false;
    for (const method of [route.method].flat()) {
      const key = `${method} ${route.url}`;
      report.registered.push(key);
      const entry = routeFeature(method, route.url);
      if (!entry) {
        if (!platformRoute(method, route.url)) report.unmapped.push(key);
      } else if (gated(entry)) anyGated = true;
    }
    if (!anyGated) return;
    const url = route.url;
    const check: preHandlerAsyncHookHandler = async (req) => {
      const entry = routeFeature(req.method, url);
      if (gated(entry)) features.require(entry.feature);
    };
    // Özellik denetimi ucun kendi kancalarından önce.
    const own = route.preHandler;
    route.preHandler = own ? [check, ...[own].flat()] : [check];
  });
  return report;
}

/**
 * Uç erişiminin platform izinleri (plan §S6; tek kaynak `org/access.ts` `ACCESS_PERMISSIONS`). `permissionFor`: auth-kit
 * `requirePermission`'a verilen ilk izin; `spend`'in ikinci izni (`tagpress.work.edit`) uç kapısında ayrıca denetlenir.
 */
export function permissionFor(access: RouteAccess): Permission {
  return ACCESS_PERMISSIONS[access][0];
}

/** Erişimin bütün izinleri (hepsi gerekir). */
export function permissionsFor(access: RouteAccess): readonly Permission[] {
  return ACCESS_PERMISSIONS[access];
}

/** İlk izinden sonraki izinler (auth-kit kancasından sonra): eksikse auth-kit biçiminde 403 `FORBIDDEN`. */
function requireRest(access: RouteAccess): onRequestHookHandler | null {
  const rest = ACCESS_PERMISSIONS[access].slice(1);
  if (!rest.length) return null;
  return (req, reply, done) => {
    const held = req.auth?.permissions ?? [];
    const missing = rest.filter((p) => !held.includes(p));
    if (!missing.length) return done();
    const err = new AccessDeniedError(access, missing);
    void reply.header("cache-control", "no-store").code(403).send(err.body(accessErrorLocale(req.headers["accept-language"], req.auth?.locale)));
  };
}

const managedByPlatform: onRequestHookHandler = (_req, _reply, done) => done(fail("managed-by-platform"));

/** Tabloda olmayan uca verilen izin: kimsede yoktur (varsayılan reddet; tablosuz uç testi zaten boş ister). */
const UNMAPPED_PERMISSION = "tagpress.unmapped-route" as Permission;

/**
 * Platform kipinin uç kapısı: `onRoute` her uca, ucun kendi `onRequest` kancalarından önce iki kanca ekler:
 * 1. auth-kit `requirePermission(<uç tablosundaki erişimin ilk izni>)`: jeton, CSRF/köken/`X-SOD-Org`, kapalı firma (409
 *    `ORG_CLOSED`), ürün erişimi, izin (403 `FORBIDDEN`), yazmada abonelik (403 `READ_ONLY`). Tablodaki `read` erişimli POST
 *    (sorgu POST'u) salt okunur abonelikte açıktır. Erişimin öbür izinleri (`spend` → `tagpress.work.edit`) hemen ardından
 *    (`requireRest`, aynı 403 `FORBIDDEN`). Harcama tutarı okuyan uçlar (`PLATFORM_MANAGE_READS`) `manage` ister.
 * 2. `orgHook`: firma bağlamı (`PlatformOrgResolver`) jeton doğrulandıktan sonra kurulur; isteğin geri kalanı onun içinde.
 * 3. Platformun yönettiği uçlar (`PLATFORM_MANAGED_ROUTES`: yapay zekâ anahtarları geçitte) izinden sonra 409
 *    `managed-by-platform`.
 * Platform uçları (`PLATFORM_ROUTES`) kendi kapılarını taşır, dokunulmaz. Tabloda olmayan uç herkese 403 (varsayılan reddet).
 * `registerProductIdentity`'den SONRA, uçlardan ÖNCE kaydedilir.
 */
export function registerPermissionGate(app: FastifyInstance, orgHook: onRequestHookHandler): void {
  if (!app.hasDecorator("requirePermission")) throw new Error("registerPermissionGate: önce registerProductIdentity (auth-kit) kaydedilmeli.");
  app.addHook("onRoute", (route: RouteOptions) => {
    const methods = [route.method].flat();
    if (methods.every((m) => platformRoute(m, route.url))) return;
    const entries = methods.map((m) => routeFeature(m, route.url));
    const keyOf = (m: string) => `${m === "HEAD" ? "GET" : m} ${route.url}`;
    // Platformda erişim: tablodaki erişim; harcama tutarı okuyan uçlar (`PLATFORM_MANAGE_READS`) yönetim izni ister.
    const accesses = new Set(entries.map((e, i) => (e ? (PLATFORM_MANAGE_READS.has(keyOf(methods[i]!)) ? "manage" : e.access) : null)));
    // Tek uçta tek erişim: farklı erişimli metotları birleştiren uç (`app.all`, `method: [GET, POST]`) yazılmaz.
    if (accesses.size !== 1) throw new Error(`registerPermissionGate: ${methods.join(",")} ${route.url} farklı erişimli metotları birleştiriyor.`);
    const access = [...accesses][0] as RouteAccess | null;
    const readOnlyExempt = entries.every((e) => e?.access === "read");
    const auth = app.requirePermission(access ? permissionFor(access) : UNMAPPED_PERMISSION, { readOnlyExempt });
    const rest = access ? requireRest(access) : null;
    const managed = methods.some((m) => PLATFORM_MANAGED_ROUTES.has(keyOf(m)));
    const own = route.onRequest;
    route.onRequest = [auth, ...(rest ? [rest] : []), ...(managed ? [managedByPlatform] : []), orgHook, ...(own ? [own].flat() : [])];
  });
}
