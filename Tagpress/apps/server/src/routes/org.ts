import { ORG_API, OrgPatchBodySchema, type OrgAccess, type OrgResponse } from "@tagpress/domain";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { hasAccess } from "../org/access.ts";
import { currentOrg } from "../org/context.ts";
import { fail, parseBody } from "../util/errors.ts";

/**
 * İsteğin firmadaki yetkisi (arayüz yönetim bölümlerini buna göre gösterir). Yerel kipte izinler `all`. `spend`:
 * `tagpress.ai.use` + `tagpress.work.edit`; `manage` harcama tutarlarını da açar (`org/access.ts`).
 */
function accessOf(permissions: "all" | readonly string[]): OrgAccess {
  return { edit: hasAccess(permissions, "write"), spend: hasAccess(permissions, "spend"), manage: hasAccess(permissions, "manage") };
}

/**
 * Geçerli firma: `GET /api/org`, `PATCH /api/org` (`{ name }`). Yanıt firma + kurulum durumu + özellik görünümü + kip
 * (`platform`) + isteğin yetkisi (`access`). Platform kipinde firma adı Merkez'de değişir: `PATCH` 403
 * `name-managed-by-platform` (uç kapısı `manage` iznini önce denetler).
 */
export function orgRoutes(app: FastifyInstance, ctx: AppContext): void {
  const platform = ctx.config.auth === "platform";
  const view = async (): Promise<OrgResponse> => {
    const orgId = ctx.tenancy.orgId("api.org");
    const org = ctx.platformOrgs ? await ctx.platformOrgs.view(orgId) : ctx.orgs.view(orgId);
    if (!org) throw fail("not-found");
    return { org, setup: ctx.setup.state(), features: ctx.features.view(), platform, access: accessOf(currentOrg().permissions) };
  };
  app.get(ORG_API.get.path, async () => view());
  app.patch(ORG_API.patch.path, async (req) => {
    if (platform) throw fail("name-managed-by-platform");
    const body = parseBody(OrgPatchBodySchema, req.body);
    if (!ctx.orgs.rename(ctx.tenancy.orgId("api.org"), body.name)) throw fail("not-found");
    return view();
  });
}
