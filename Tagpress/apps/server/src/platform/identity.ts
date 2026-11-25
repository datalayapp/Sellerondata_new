import { existsSync, lstatSync, rmSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import { type ProductIdentity, pgDb, registerProductIdentity } from "@sellerondata/product-kit";
import type { FastifyInstance } from "fastify";
import type { PlatformConfig } from "../config.ts";
import { PG_PURGE_TABLES } from "../org/tables.ts";
import type { PlatformOrgService } from "../org/platform-service.ts";
import { type StreamEvent, eventFromReceiverBody } from "./live-streams.ts";

/** Platform kipinin şeması (kayıt anahtarı; `init.sql`/`upgrade.sql` açar, göç `db/pg/migrations`). */
export const PLATFORM_SCHEMA = "tagpress";
export const PRODUCT_KEY = "tagpress";
/** Yeniden yazılmayan yollar (plan §S3; `features/route-map.ts` `PLATFORM_ROUTES`). */
export const PLATFORM_PREFIX = "/api/tagpress";
export const EVENTS_PATH = `${PLATFORM_PREFIX}/internal/events`;
export const HEALTH_PATH = `${PLATFORM_PREFIX}/health`;
const HUB_PREFIX = `${PLATFORM_PREFIX}/platform/`;
/** Platform kipinde önek dışı `/api/…` isteğinin gittiği yol (hiçbir uç yok: 404). Dış yol tek: `/api/tagpress/…`. */
export const OUTSIDE_PREFIX_PATH = "/api/__onek-disi";

/**
 * Dış yol → iç yol (plan §S3, Fastify `rewriteUrl`): `/api/tagpress/<yol>` → `/api/<yol>` (uç tablosu anahtarları bugünkü
 * biçimde kalır). Yeniden yazılmayanlar: `/api/tagpress/platform/…` (Merkez), olay alıcısı ve sağlık (tam yol). Önek dışı
 * `/api/…` (`/api/jobs` gibi doğrudan iç yol) hiçbir uca varmaz: tek dış yol öneklisidir. Yol çözülmez ve küçültülmez:
 * `..`, `%2e` ya da büyük harf hiçbir uçla eşleşmez (yönlendirici harf duyarlı, nokta bölümlerini çözmez); kimlik kapısı uç
 * kaydına (`routeOptions.url`) bağlıdır, ham adrese değil.
 */
export function rewritePlatformUrl(url: string): string {
  const q = url.indexOf("?");
  const pathname = q < 0 ? url : url.slice(0, q);
  const query = q < 0 ? "" : url.slice(q);
  if (pathname === EVENTS_PATH || pathname === HEALTH_PATH || pathname.startsWith(HUB_PREFIX)) return url;
  if (pathname.startsWith(`${PLATFORM_PREFIX}/`)) return `/api/${pathname.slice(PLATFORM_PREFIX.length + 1)}${query}`;
  if (pathname === "/api" || pathname.startsWith("/api/")) return `${OUTSIDE_PREFIX_PATH}${query}`;
  return url;
}

/** Firma klasörü adı (`org/roots.ts` ile aynı kural: UUID küçük harf, ya da küçük harfli kısa çizgili ad; Windows adları yok). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORG_DIR = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Kalıcı silmede firmanın dosya klasörü: YALNIZ `<veri>/firmalar/<firma>` (tek bölüm, `firmalar/`in kendisi ya da veri
 * klasörü asla). `OrgRoots.rootOf` kullanılmaz: dosya düzeni 1'de eski kökün sahibinin kökü veri klasörünün kendisidir.
 * Klasör adı olamayacak kimlik ya da dışarı çıkan yol null (hiçbir şey silinmez).
 */
export function orgPurgeDir(dataDir: string, orgId: string): string | null {
  const name = UUID.test(orgId) ? orgId.toLowerCase() : ORG_DIR.test(orgId) && !WINDOWS_RESERVED.test(orgId) ? orgId : null;
  if (!name) return null;
  const base = path.resolve(dataDir, "firmalar");
  const target = path.resolve(base, name);
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) return null;
  return target;
}

/** Firma klasörünü siler (yoksa bir şey yapmaz). Klasör bir bağlantıysa (junction, sembolik bağ) yalnız bağlantı kaldırılır. */
export function removeOrgFiles(dataDir: string, orgId: string): void {
  const dir = orgPurgeDir(dataDir, orgId);
  if (!dir) throw new Error(`Kalıcı silme: firma klasörü kimlikten kurulamadı (${JSON.stringify(orgId).slice(0, 80)}).`);
  if (!existsSync(dir) && !isLink(dir)) return;
  if (isLink(dir)) {
    rmSync(dir, { force: true });
    return;
  }
  rmSync(dir, { recursive: true, force: true });
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export interface PlatformIdentityOptions {
  pool: pg.Pool;
  config: PlatformConfig;
  dataDir: string;
  orgs: PlatformOrgService;
  /** Testler: auth-kit sahte JWKS'i (`createTestAuthority().fetch`). */
  fetch?: typeof fetch;
  /** Bakım turu aralığı (product-kit; 0 kapalı). */
  purgeRetryEveryMs?: number;
  /** Olay alıcısı 2xx yanıt verdikten sonra (imza doğrulanmış) olayın kendisi: açık akışları kapatmak için (R1). */
  onEvent?: (event: StreamEvent) => void;
}

/**
 * Kimlik izdüşümü ve hesap olayları (product-kit `registerProductIdentity`, `Platform/docs/mimari/06-merkez.md` "Yeni araç
 * ekleme" madde 3): jeton doğrulama (auth-kit), JIT firma ve üye, `member.*`, `org.updated/closed/reopened/purged`,
 * `subscription.updated` (`POST /api/tagpress/internal/events`). Kalıcı silme parça parça: kiracı tabloları
 * `PG_PURGE_TABLES` sırasıyla (`org_id`), sonra firmanın klasörü (`onPurged`). Her olaydan sonra firma durumları tazelenir
 * (arka plan kapısı, `PlatformOrgService`).
 */
export function registerPlatformIdentity(app: FastifyInstance, opts: PlatformIdentityOptions): ProductIdentity {
  const identity = registerProductIdentity(app, {
    product: PRODUCT_KEY,
    db: pgDb(opts.pool),
    schema: PLATFORM_SCHEMA,
    jwksUrl: opts.config.jwksUrl,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    allowedOrigins: opts.config.allowedOrigins,
    eventPath: EVENTS_PATH,
    purge: {
      tables: PG_PURGE_TABLES,
      orgColumn: "org_id",
      onPurged: async (orgId) => {
        opts.orgs.forget(orgId);
        removeOrgFiles(opts.dataDir, orgId);
      },
    },
    ...(opts.purgeRetryEveryMs === undefined ? {} : { purgeRetryEveryMs: opts.purgeRetryEveryMs }),
  });
  // Olay işlendi (kapanış, açılış, ad): arka plan kapısı hemen tazelenir; açık akışlar olaya göre kapanır (üye çıkarma,
  // firma kapanışı; `platform/live-streams.ts`). Yalnız 2xx: imzayı alıcı doğrulamıştır.
  app.addHook("onResponse", async (req, reply) => {
    if (req.routeOptions.url !== EVENTS_PATH) return;
    opts.orgs.refreshSoon();
    if (reply.statusCode >= 200 && reply.statusCode < 300 && opts.onEvent) {
      const event = eventFromReceiverBody(req.body);
      if (event) opts.onEvent(event);
    }
  });
  app.get(HEALTH_PATH, async () => ({ ok: true }));
  return identity;
}
