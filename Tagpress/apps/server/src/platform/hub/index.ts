import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { type HubCtx, type HubOrgSource, type HubProviders, pgDb, registerHubRoutes, sqlIdent, withOrg } from "@sellerondata/product-kit";
import { type OrgContext, runInOrg } from "../../org/context.ts";
import { activityPage, activityRows } from "./activity.ts";
import { buildAnalytics } from "./analytics.ts";
import { PRODUCT, withT } from "./common.ts";
import { datasetExport, datasetPage, listDatasets } from "./datasets.ts";
import { buildOverview } from "./overview.ts";
import type { HubSqlDb } from "./sql.ts";

export type { HubSqlDb } from "./sql.ts";

/** Üye kimliği → ad (Merkez'in izdüşümü `tagpress."Member"`). Bulunmayan kimlik haritada yok. */
export type MemberNames = (orgId: string, ids: readonly string[]) => Promise<ReadonlyMap<string, string>>;

export type HubProvidersDeps = {
  /**
   * TagPress'in veritabanı katmanı (`TenantDb` / `TenantDbLike`, plan §S5): sorgular `$org` ile kapsamlı, firma bağlamı
   * sağlayıcının açtığı `runInOrg`'dan. Platform kipinde `PgTenantDb` (Postgres + RLS), yerel kipte SQLite.
   */
  db: HubSqlDb;
  /** Etkinlikte kişi adı. Verilmezse `actor` null (yerel kip). Platform kipinde `pgMemberNames(pool)`. */
  memberNames?: MemberNames;
};

/** Merkez bağlamından TagPress firma bağlamı. Merkez uçları yalnız okur: izin listesi boş (kapı product-kit çatısında). */
function orgContext(ctx: HubCtx): OrgContext {
  return { orgId: ctx.orgId, memberId: ctx.memberId, permissions: [], locale: ctx.locale, source: "platform" };
}

/**
 * Merkez sağlayıcıları (plan §S7, `Platform/docs/mimari/06-merkez.md` §7). Saf işlevler: Fastify'a bağlanmaz, product-kit
 * `registerHubRoutes` (ya da `registerTagpressHub`) sunar. Sayılar TagPress'in kendi verisinden, istekteki firmanın kapsamında;
 * dönem ve "bugün" firmanın saat dilimiyle (`HubCtx.timeZone`). Etiketler isteğin dilinde (`i18n/hub.ts`).
 */
export function createHubProviders(deps: HubProvidersDeps): HubProviders {
  const run = async <T>(ctx: HubCtx, fn: (db: HubSqlDb) => T): Promise<T> => runInOrg(orgContext(ctx), () => fn(deps.db));
  const names = async (ctx: HubCtx, ids: (string | null)[]): Promise<ReadonlyMap<string, string>> => {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    return unique.length && deps.memberNames ? deps.memberNames(ctx.orgId, unique) : new Map();
  };
  return {
    overview: (ctx, period) => run(ctx, (db) => buildOverview(db, withT(ctx), period)),
    analytics: (ctx, period, query) => run(ctx, (db) => buildAnalytics(db, withT(ctx), period, query)),
    datasets: {
      list: (ctx) => run(ctx, (db) => listDatasets(db, withT(ctx))),
      page: (ctx, id, query) => run(ctx, (db) => datasetPage(db, withT(ctx), id, query)),
      export: (ctx, id, query) => datasetExport((fn) => run(ctx, fn), withT(ctx), id, query),
    },
    activity: async (ctx, query) => {
      const raw = await run(ctx, (db) => activityRows(db, withT(ctx), query));
      return activityPage(raw, await names(ctx, raw.items.map((i) => i.memberId)));
    },
  };
}

/** Platform kipinde üye adları: product-kit izdüşümünden (`"Member"`, RLS altında firma bağlamıyla). Çıkarılmış üyenin adı da kalır. */
export function pgMemberNames(pool: pg.Pool, schema = PRODUCT): MemberNames {
  const db = pgDb(pool);
  const table = `${sqlIdent(schema, "schema")}."Member"`;
  return async (orgId, ids) => {
    if (!ids.length) return new Map();
    const rows = await withOrg(db, orgId, (tx) => tx.query<{ id: string; name: string }>(`SELECT "id", "name" FROM ${table} WHERE "orgId" = $1 AND "id" = ANY($2::text[])`, [orgId, [...ids]]));
    return new Map(rows.filter((r) => r.name).map((r) => [r.id, r.name]));
  };
}

export type RegisterTagpressHubOptions = HubProvidersDeps & {
  /** Firmanın saat dilimi ve Merkez onayı. Verilmezse `registerProductIdentity`'nin firma kaydı (platform kipinin olağan yolu). */
  org?: HubOrgSource;
};

/**
 * İnce rota modülü: `/api/tagpress/platform/{overview, analytics, datasets, datasets/:id, datasets/:id/export, activity}`
 * (yeniden yazılmayan yol, plan §S3). Önce `registerProductIdentity` (ya da auth-kit `registerProductAuth`) kaydedilmiş
 * olmalı: izin kapıları (`hub.analytics`, `hub.data`, `hub.export`) ve 403'ler product-kit çatısında.
 */
export function registerTagpressHub(app: FastifyInstance, opts: RegisterTagpressHubOptions): void {
  registerHubRoutes(app, { product: PRODUCT, providers: createHubProviders(opts), ...(opts.org ? { org: opts.org } : {}) });
}
