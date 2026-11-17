import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveProductDefinition } from '@sellerondata/auth-kit';
import {
  emptyHubActivityPage,
  emptyHubAnalytics,
  emptyHubDatasetList,
  emptyHubOverview,
  HUB_ACTIVITY_PAGE_SIZE,
  type HubActivityPage,
  type HubAnalytics,
  type HubColumn,
  type HubDatasetList,
  type HubDatasetPage,
  type HubOverview,
  type HubRow,
  type Locale,
  type Permission,
  type ProductEntry,
} from '@sellerondata/contracts';
import { KitError, kitMessage, sendKitError } from '../errors.ts';
import { csvHeader, csvRows } from '../pure/csv.ts';
import { personalCache, queryInt, requestLocale, streamIdleTimeout } from './http.ts';
import { createOrgLimiter } from './limiter.ts';
import type { Period } from '../pure/period.ts';
import { parsePeriod } from './period.ts';
import { DEFAULT_TIME_ZONE, isTimeZone, zonedDate } from '../pure/time.ts';

/** Merkez sağlayıcısının bağlamı. Veritabanına sağlayıcı kendisi `withOrg(db, ctx.orgId, …)` ile gider. */
export type HubCtx = {
  orgId: string;
  /** Yerel `Member.id` (= Hesap `Membership.id`, `req.auth.membershipId`). */
  memberId: string | null;
  locale: Locale;
  can(permission: string): boolean;
  now: Date;
  /** Firmanın saat dilimi (yerel firma kaydından, `org.updated`; yoksa `DEFAULT_ORG_TIME_ZONE`). */
  timeZone: string;
  /**
   * Firma bilgileri Merkez'de onaylı mı (`org.updated` `companyConfirmed`). Aracın kurulumu buna bağlıdır: Genel Bakış'ın
   * `setup.completed` alanı onay yoksa `false` döner (sağlayıcı `true` dese de çatı düzeltir).
   */
  companyConfirmed: boolean;
};

/** Merkez çatısının firma kaynağı: saat dilimi ve Merkez onayı. */
export type HubOrgSource = (orgId: string) => Promise<{ timeZone?: string | null; companyConfirmed?: boolean } | null>;

export type HubExport = { columns: HubColumn[]; batches: () => AsyncIterable<HubRow[]> };

/** Verilmeyen uç boş ama geçerli şekil döner (contracts `emptyHub*`): yeni araç Merkez'de hemen görünür. */
export type HubProviders = {
  overview?: (ctx: HubCtx, period: Period) => Promise<HubOverview>;
  analytics?: (ctx: HubCtx, period: Period, query: Record<string, unknown>) => Promise<HubAnalytics>;
  datasets?: {
    list: (ctx: HubCtx) => Promise<HubDatasetList>;
    /** Bilinmeyen `id` için `null`: 404 NOT_FOUND. */
    page: (ctx: HubCtx, id: string, query: Record<string, unknown>) => Promise<HubDatasetPage | null>;
    /** Akış başlamadan çağrılır; denetim izi (`data.export`) burada yazılır. Bilinmeyen ya da dışa aktarılamaz `id` için `null`. */
    export?: (ctx: HubCtx, id: string, query: Record<string, unknown>) => Promise<HubExport | null>;
  };
  activity?: (ctx: HubCtx, query: Record<string, unknown>) => Promise<HubActivityPage>;
};

export type HubRoutesOptions = {
  product: string;
  /** Yalnız test fikstürü; yoksa `PRODUCTS[product]`. `NODE_ENV` `test` değilse açılış durur. */
  definition?: Pick<ProductEntry, 'key' | 'hub'>;
  providers: HubProviders;
  /**
   * Firmanın saat dilimi ve Merkez onayı. Verilmezse `registerProductIdentity`'nin yerel firma kaydı (`productKitOrg`); ikisi de
   * yoksa açılış durur (araç kendi izdüşümünü kullanıyorsa bunu vermeli). Kayıt yoksa saat dilimi varsayılan, onay yok sayılır.
   */
  org?: HubOrgSource;
  limits?: { general?: number; export?: number; idleMs?: number; generalMaxMs?: number; exportMaxMs?: number };
  /** Yol öneki. Varsayılan `/api/<ürün>`. */
  prefix?: string;
};

const DATASET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * Merkez sözleşmesi (ARCHITECTURE §7, contracts `hub.ts`): `<önek>/platform/{overview, analytics, datasets, datasets/:id,
 * datasets/:id/export, activity}`. `registerProductIdentity` (ya da auth-kit `registerProductAuth`) önce kaydedilmiş olmalı.
 *
 * İzinler kaydın `hub` alanından: Genel Bakış, Analiz ve Etkinlik `hub.analytics`; veri kümeleri `hub.data`; CSV ikisi
 * birden (`hub.export` + `hub.data`). Kapıyı geçemeyene 403, Merkez o bölümü gizler. Uçlar yalnız GET'tir: salt okunur
 * abonelikte de açıktır. Yanıtlar kişisel önbellekli (`private, no-store`, `Vary: Accept-Language`).
 * Pahalı uçlar firma başına sınırlıdır (429 + `Retry-After`).
 * Dönem, "bugün" ve CSV'deki anlar firmanın saat dilimiyle; Genel Bakış'ın kurulum durumu Merkez onayına bağlı (`HubCtx`).
 */
export function registerHubRoutes(app: FastifyInstance, opts: HubRoutesOptions): void {
  const def = resolveProductDefinition(opts.product, opts.definition, 'registerHubRoutes');
  const hub = def.hub;
  if (!hub) throw new Error(`registerHubRoutes: "${opts.product}" kaydında "hub" alanı yok (Merkez izinleri).`);
  if (!app.hasDecorator('requirePermission')) throw new Error('registerHubRoutes: önce registerProductIdentity (ya da registerProductAuth) kaydedilmeli.');

  const product = opts.product;
  const base = `${opts.prefix ?? `/api/${product}`}/platform`;
  const { providers } = opts;
  const limiter = createOrgLimiter(opts.limits);
  const idleMs = opts.limits?.idleMs ?? 120_000;
  const orgOf: HubOrgSource | null = opts.org ?? (app.hasDecorator('productKitOrg') ? (orgId) => app.productKitOrg(orgId) : null);
  if (!orgOf) throw new Error('registerHubRoutes: firma kaydı yok: önce registerProductIdentity ya da `org` seçeneği (saat dilimi, Merkez onayı).');
  const guard = (permission: string) => app.requirePermission(permission as Permission);
  const reports = guard(hub.analytics);
  const data = guard(hub.data);
  const exportGuard = guard(hub.export);

  async function context(req: FastifyRequest): Promise<HubCtx> {
    const auth = req.auth;
    const perms = new Set<string>(auth.permissions);
    const org = await orgOf!(auth.orgId);
    const timeZone = org?.timeZone && isTimeZone(org.timeZone) ? org.timeZone : DEFAULT_TIME_ZONE;
    return {
      orgId: auth.orgId,
      memberId: auth.membershipId ?? null,
      locale: requestLocale(req, auth.locale),
      can: (p) => perms.has(p),
      now: new Date(),
      timeZone,
      companyConfirmed: org?.companyConfirmed === true,
    };
  }

  /** Paket ve sağlayıcı hataları sözleşme gövdesiyle döner; beklenmeyen hata Fastify'a kalır (500). */
  const handle =
    <R>(fn: (req: FastifyRequest, reply: FastifyReply) => Promise<R>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await fn(req, reply);
      } catch (err) {
        if (err instanceof KitError) return sendKitError(req, reply, err);
        throw err;
      }
    };
  const route = <R>(fn: (ctx: HubCtx, req: FastifyRequest, reply: FastifyReply) => Promise<R>, pool: 'general' | 'export' = 'general') =>
    handle(
      limiter.limited(async (req, reply) => {
        personalCache(reply);
        return fn(await context(req), req, reply);
      }, pool),
    );
  const query = (req: FastifyRequest) => (req.query ?? {}) as Record<string, unknown>;
  const notFound = (ctx: HubCtx) => new KitError(404, 'NOT_FOUND', kitMessage('datasetNotFound', ctx.locale));
  const datasetId = (req: FastifyRequest, ctx: HubCtx) => {
    const { id } = req.params as { id: string };
    if (!DATASET_ID_RE.test(id)) throw notFound(ctx);
    return id;
  };

  app.get(`${base}/overview`, { onRequest: reports }, route(async (ctx, req) => {
    const period = parsePeriod(req.query, ctx);
    const out = providers.overview ? await providers.overview(ctx, period) : emptyHubOverview(product, period);
    // Kurulumun firma koşulu (contracts `org.updated.companyConfirmed`): onaysız firmada kurulum tamamlanmış sayılmaz.
    if (out.setup?.completed && !ctx.companyConfirmed) return { ...out, setup: { ...out.setup, completed: false } };
    return out;
  }));

  app.get(`${base}/analytics`, { onRequest: reports }, route(async (ctx, req) => {
    const period = parsePeriod(req.query, ctx);
    return providers.analytics ? providers.analytics(ctx, period, query(req)) : emptyHubAnalytics(product, period);
  }));

  app.get(`${base}/datasets`, { onRequest: data }, route(async (ctx) => (providers.datasets ? providers.datasets.list(ctx) : emptyHubDatasetList(product))));

  app.get(`${base}/datasets/:id`, { onRequest: data }, route(async (ctx, req) => {
    const id = datasetId(req, ctx);
    const page = providers.datasets ? await providers.datasets.page(ctx, id, query(req)) : null;
    if (!page) throw notFound(ctx);
    return page;
  }));

  app.get(`${base}/datasets/:id/export`, { onRequest: [exportGuard, data] }, route(async (ctx, req, reply) => {
    const id = datasetId(req, ctx);
    const out = providers.datasets?.export ? await providers.datasets.export(ctx, id, query(req)) : null;
    if (!out) throw notFound(ctx);
    streamIdleTimeout(req, reply, idleMs);
    // Bir parti eksik gelirse üreteç hata verir: başlık gitmiş olduğundan Fastify bağlantıyı keser, dosya tamamlanmış görünmez.
    async function* chunks() {
      yield csvHeader(out!.columns, ctx.locale);
      for await (const rows of out!.batches()) yield csvRows(out!.columns, rows, ctx.locale, ctx.timeZone);
    }
    return reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${product}-${id}-${zonedDate(ctx.now, ctx.timeZone)}.csv"`)
      .send(Readable.from(chunks()));
  }, 'export'));

  app.get(`${base}/activity`, { onRequest: reports }, route(async (ctx, req) => {
    if (providers.activity) return providers.activity(ctx, query(req));
    return emptyHubActivityPage(queryInt(query(req).page, 1, 'page', ctx.locale), HUB_ACTIVITY_PAGE_SIZE);
  }));
}
