import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance, type onRequestHookHandler } from "fastify";
import { ZodError } from "zod";
import { type AppConfig, loadConfig, platformConfigProblems } from "./config.ts";
import { type AppContext, type ContextOptions, createContext } from "./context.ts";
import { registerEvents } from "./events.ts";
import { registerFeatureGate, registerPermissionGate } from "./features/gate.ts";
import { AccessDeniedError, accessErrorLocale } from "./org/access.ts";
import { type OrgContext, runInOrg } from "./org/context.ts";
import type { OrgResolver } from "./org/resolver.ts";
import { registerTagpressHub, pgMemberNames } from "./platform/hub/index.ts";
import { registerPlatformIdentity, rewritePlatformUrl } from "./platform/identity.ts";
import { safeJoin } from "./util/safe-path.ts";
import { registerRoutes } from "./routes/index.ts";
import { HttpError, errorBody, fail, failFields, failStatus, zodFields } from "./util/errors.ts";

export interface BuildOptions extends Omit<ContextOptions, "config"> {
  config?: Partial<AppConfig>;
  logger?: boolean;
  /** Platform kipinin test dikişleri: auth-kit sahte JWKS'i (`createTestAuthority().fetch`), product-kit bakım turu (0 kapalı). */
  platform?: { fetch?: typeof fetch; purgeRetryEveryMs?: number };
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** İzin verilen kökenler: uygulamanın kendisi ve geliştirmede Vite (5421). `null` köken (sandbox iframe, file://) kabul edilmez. */
export function allowedOrigins(config: AppConfig): Set<string> {
  const ports = [config.port, ...(config.dev ? [5421] : [])];
  return new Set(ports.flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]));
}

/**
 * Güvenlik (kimlik doğrulama yok, ama):
 * - Host başlığı yalnızca yerel ad (DNS rebinding'e karşı).
 * - Origin varsa izinli listede olmalı; CORS yanıtı yalnızca o kökene açılır.
 * - Değiştiren her /api isteğinde `X-Studio: 1` zorunlu: yabancı site bunu önuçuşsuz gönderemez, önuçuş da reddedilir.
 */
function registerSecurity(app: FastifyInstance, config: AppConfig): (origin: string | undefined) => Record<string, string> {
  const allowed = allowedOrigins(config);
  const cors = (origin: string | undefined): Record<string, string> =>
    origin && allowed.has(origin)
      ? {
          "access-control-allow-origin": origin,
          "access-control-allow-headers": "content-type, x-studio",
          "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "access-control-max-age": "600",
          vary: "Origin",
        }
      : {};
  app.addHook("onRequest", async (req, reply) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    if (!LOCAL_HOSTS.has(host)) return reply.code(403).send(errorBody(fail("host-not-local")));
    const origin = req.headers.origin;
    if (origin !== undefined && !allowed.has(origin)) return reply.code(403).send(errorBody(fail("origin-not-allowed")));
    reply.headers(cors(origin));
    if (req.method === "OPTIONS") return reply.code(204).send();
    if (MUTATING.has(req.method) && req.url.startsWith("/api/") && req.headers["x-studio"] !== "1") {
      return reply.code(403).send(errorBody(fail("studio-header-missing")));
    }
  });
  return cors;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

/** Derlenmiş arayüz: dosya varsa o, yoksa index.html (SPA). /api altı asla. */
function registerStatic(app: FastifyInstance, webDist: string): void {
  app.setNotFoundHandler(async (req, reply) => {
    const url = decodeURIComponent((req.url.split("?")[0] ?? "/").replace(/\+/g, " "));
    if (req.method !== "GET" || url.startsWith("/api/") || !existsSync(webDist)) return reply.code(404).send(errorBody(fail("not-found")));
    const rel = url.replace(/^\/+/, "");
    let file = rel ? safeJoin(webDist, rel) : null;
    if (!file || !existsSync(file) || statSync(file).isDirectory()) file = path.join(webDist, "index.html");
    if (!existsSync(file)) return reply.code(404).send(errorBody(fail("web-not-built")));
    const immutable = file.includes(`${path.sep}assets${path.sep}`);
    return reply
      .type(MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream")
      .header("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache")
      .send(await readFile(file));
  });
}

declare module "fastify" {
  interface FastifyRequest {
    /** İsteğin firması (`registerOrgContext`). */
    org?: OrgContext;
  }
}

/**
 * Firma bağlamı: çözücü (`OrgResolver`) `onRequest`'te isteğin firmasını bulur, isteğin geri kalanı `runInOrg` içinde
 * sürer. Gövde ayrıştırma akış olaylarında bağlam kaybolmasın diye `preHandler`'da aynı firmayla yeniden girilir.
 * Güvenlik kancasından (Host, köken, X-Studio) sonra çalışır.
 */
function orgContextHook(resolver: OrgResolver): onRequestHookHandler {
  return (req, _reply, done) => {
    let resolved: OrgContext | Promise<OrgContext>;
    try {
      resolved = resolver.resolve(req);
    } catch (err) {
      done(err as Error);
      return;
    }
    const enter = (org: OrgContext) => {
      req.org = org;
      runInOrg(org, () => done());
    };
    if (resolved instanceof Promise) resolved.then(enter, (err: Error) => done(err));
    else enter(resolved);
  };
}

/**
 * Yerel kipte bağlam her istekte (`onRequest`, uygulama düzeyi). Platform kipinde (`inRoute`) uç düzeyinde, jeton
 * doğrulandıktan sonra kurulur (`registerPermissionGate` ekler); burada yalnız `preHandler`'daki yeniden giriş kalır.
 */
function registerOrgContext(app: FastifyInstance, resolver: OrgResolver, inRoute = false): void {
  if (!inRoute) app.addHook("onRequest", orgContextHook(resolver));
  app.addHook("preHandler", (req, _reply, done) => {
    if (req.org) runInOrg(req.org, () => done());
    else done();
  });
}

export async function buildApp(opts: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const config = loadConfig(opts.config);
  const platform = config.auth === "platform";
  // Platform kipi Postgres'le, yerel kip SQLite'la (karışık yok; testler yerel kipte Postgres'i `databaseUrl` ile açıkça seçer).
  const databaseUrl = opts.databaseUrl ?? (platform ? config.databaseUrl : null);
  const problems = platformConfigProblems({ ...config, databaseUrl });
  if (problems.length) throw new Error(problems.join(" "));
  const app = Fastify({
    logger: opts.logger ? { level: process.env.LOG_LEVEL ?? "warn" } : false,
    bodyLimit: 60 * 1024 * 1024,
    // Platform: dış yol `/api/tagpress/<yol>` = iç yol `/api/<yol>` (plan §S3).
    ...(platform ? { rewriteUrl: (req: { url?: string }) => rewritePlatformUrl(req.url ?? "/") } : {}),
  });
  const ctx = await createContext({ ...opts, config, databaseUrl });

  // Boş JSON gövdesi {} sayılır (eklentinin gövdesiz POST'ları).
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = String(body ?? "").trim();
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(fail("body-invalid-json"), undefined);
    }
  });

  app.setErrorHandler((err, req, reply) => {
    // Platform izni yok (harcamaya giden ortak noktalar, `org/access.ts`): auth-kit biçiminde 403 `FORBIDDEN`.
    if (err instanceof AccessDeniedError) {
      return reply.header("cache-control", "no-store").code(403).send(err.body(accessErrorLocale(req.headers["accept-language"], req.org?.locale ?? null)));
    }
    if (err instanceof HttpError) return reply.code(err.status).send(errorBody(err));
    if (err instanceof ZodError) return reply.code(400).send(errorBody(failFields("request-invalid", zodFields(err))));
    const status = (err as { statusCode?: number }).statusCode;
    const detail = err instanceof Error ? err.message : String(err);
    if (status && status < 500) return reply.code(status).send(errorBody(failStatus(status, "request-failed", { detail })));
    req.log.error(err);
    return reply.code(500).send(errorBody(fail("server-error", { detail })));
  });

  let cors: (origin: string | undefined) => Record<string, string> = () => ({});
  if (!platform) {
    cors = registerSecurity(app, config);
    registerOrgContext(app, ctx.resolver);
    // Özellik kapısı uçlardan önce (onRoute yalnız sonradan kaydedilen uçları görür).
    ctx.featureGate = registerFeatureGate(app, ctx.features);
  } else {
    // Platform kipi (plan §S2, §S3, §S6): Host/köken/`X-Studio` yerine Hesap jetonu. Sıra: özellik kapısı (bütün uçları
    // görsün) → kimlik izdüşümü ve olay alıcısı (product-kit; `requirePermission`'ı kurar) → uç kapısı (izin + firma bağlamı)
    // → sağlık, Merkez ve TagPress uçları.
    const { pool, platformOrgs } = ctx;
    if (!pool || !platformOrgs || !config.platform) throw new Error("Platform kipi Postgres ister (DATABASE_URL).");
    ctx.featureGate = registerFeatureGate(app, ctx.features);
    ctx.identity = registerPlatformIdentity(app, {
      pool,
      config: config.platform,
      dataDir: config.dataDir,
      orgs: platformOrgs,
      onEvent: (event) => void ctx.liveStreams.handleEvent(event),
      ...(opts.platform?.fetch ? { fetch: opts.platform.fetch } : {}),
      ...(opts.platform?.purgeRetryEveryMs === undefined ? {} : { purgeRetryEveryMs: opts.platform.purgeRetryEveryMs }),
    });
    registerOrgContext(app, ctx.resolver, true);
    registerPermissionGate(app, orgContextHook(ctx.resolver));
    registerTagpressHub(app, { db: ctx.tdb, memberNames: pgMemberNames(pool) });
  }
  registerEvents(app, ctx.events, ctx.tenancy, cors, ctx.liveStreams);
  registerRoutes(app, ctx);
  registerStatic(app, config.webDist);
  app.addHook("onClose", async () => ctx.close());
  return { app, ctx };
}
