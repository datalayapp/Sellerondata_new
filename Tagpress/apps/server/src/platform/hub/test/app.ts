/** Yalnız test: Merkez uçlarını product-kit çatısıyla ve auth-kit'in test yetkilisiyle sunan küçük Fastify uygulaması. */
import Fastify, { type FastifyInstance } from "fastify";
import { registerProductAuth } from "@sellerondata/auth-kit";
import { TEST_ORIGIN, type TestAuthority } from "@sellerondata/auth-kit/testing";
import { registerTagpressHub } from "../index.ts";
import { type HubHarness, MEMBER_NAMES } from "./scenario.ts";

export async function buildHubTestApp(harness: HubHarness, auth: TestAuthority, org: () => { timeZone: string; companyConfirmed: boolean }): Promise<FastifyInstance> {
  const app = Fastify();
  registerProductAuth(app, { product: "tagpress", ...auth.authOptions, allowedOrigins: [TEST_ORIGIN], loadMember: async () => ({ epoch: 0, active: true }) });
  registerTagpressHub(app, {
    db: harness.db,
    memberNames: async (_org, ids) => new Map(ids.filter((id) => MEMBER_NAMES[id]).map((id) => [id, MEMBER_NAMES[id]!])),
    org: async () => org(),
  });
  await app.ready();
  return app;
}
