import type { FastifyInstance } from "fastify";
import { createTestAuthority, type TestAuthority } from "@sellerondata/auth-kit/testing";
import type { HubOverview } from "@sellerondata/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildHubTestApp } from "./test/app.ts";
import { type HubHarness, OCT, ORG_A, ORG_B, TIME_ZONE, seedOrgA, seedOrgB, testHarness } from "./test/scenario.ts";

/**
 * İnce rota modülü product-kit çatısıyla: jeton auth-kit'in test yetkilisinden, izin kapıları kayıttaki `hub` alanından
 * (`tagpress.reports.view`, `tagpress.data.export`). Firma kaynağı bellekte (platform kipinde `registerProductIdentity`).
 */

let authority: TestAuthority;
let h: HubHarness;
let app: FastifyInstance;
let confirmed = true;

beforeAll(async () => {
  authority = await createTestAuthority();
  h = await testHarness();
  seedOrgA(h.insert);
  seedOrgB(h.insert);
  app = await buildHubTestApp(h, authority, () => ({ timeZone: TIME_ZONE, companyConfirmed: confirmed }));
});
afterAll(async () => {
  await app.close();
  await h.close();
});

const token = (o: Parameters<TestAuthority["accessToken"]>[0] = {}) => authority.accessToken({ product: "tagpress", role: "USER", orgId: ORG_A, membershipId: "m-1", ...o });
const get = async (url: string, tok: string | null, headers: Record<string, string> = {}) =>
  app.inject({ url: `/api/tagpress/platform${url}`, headers: { ...(tok ? authority.bearer(tok) : {}), ...headers } });
const period = `from=${OCT.from}&to=${OCT.to}`;

describe("Merkez uçları (product-kit çatısı)", () => {
  it("jetonsuz 401; rapor izni yoksa 403; Kullanıcı rolü 200", async () => {
    expect((await get(`/overview?${period}`, null)).statusCode).toBe(401);
    const noReports = await token({ perms: ["tagpress.web.access", "tagpress.work.edit"] });
    for (const url of [`/overview?${period}`, `/analytics?${period}`, "/datasets", "/datasets/jobs", "/activity"]) {
      const res = await get(url, noReports);
      expect([url, res.statusCode]).toEqual([url, 403]);
    }
    const res = await get(`/overview?${period}`, await token());
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("firma jetondan: B'nin jetonu B'nin sayılarını alır", async () => {
    const b = (await get(`/overview?${period}`, await token({ orgId: ORG_B, membershipId: "m-b" }))).json<HubOverview>();
    expect(b.kpis.find((k) => k.id === "approved")!.value).toBe(3);
    const a = (await get(`/overview?${period}`, await token())).json<HubOverview>();
    expect(a.kpis.find((k) => k.id === "approved")!.value).toBe(2);
  });

  it("dil Accept-Language'tan", async () => {
    const en = (await get(`/overview?${period}`, await token(), { "accept-language": "en-US,en;q=0.9" })).json<HubOverview>();
    expect(en.kpis[0]!.label).toBe("Approved labels");
  });

  it("Merkez onayı yoksa kurulum tamamlanmış sayılmaz", async () => {
    confirmed = false;
    try {
      expect((await get(`/overview?${period}`, await token())).json<HubOverview>().setup!.completed).toBe(false);
    } finally {
      confirmed = true;
    }
    expect((await get(`/overview?${period}`, await token())).json<HubOverview>().setup!.completed).toBe(true);
  });

  it("veri seti: bilinmeyen 404, geçersiz süzgeç 400", async () => {
    const t = await token();
    expect((await get("/datasets/yok", t)).statusCode).toBe(404);
    const bad = await get("/datasets/jobs?filter.status=x", t);
    expect([bad.statusCode, bad.json().error.code]).toEqual([400, "VALIDATION"]);
    expect((await get("/analytics?filter.language=yok", t)).statusCode).toBe(400);
  });

  it("CSV: dışa aktarma izniyle; başlık sütun adları, müşteri metni yok; şablonlar dışa aktarılmaz", async () => {
    const noExport = await token({ perms: ["tagpress.web.access", "tagpress.reports.view"] });
    expect((await get("/datasets/jobs/export", noExport)).statusCode).toBe(403);
    const res = await get("/datasets/jobs/export?filter.status=approved", await token());
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="tagpress-jobs-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = res.body.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    expect(lines[0]).toBe("Sipariş no;Ürün;Tasarım dili;Tür;Durum;Adet;Eklendi;Onaylandı");
    expect(lines).toHaveLength(4);
    expect(res.body).not.toContain("Ayşe");
    expect((await get("/datasets/templates/export", await token())).statusCode).toBe(404);
    expect((await get("/datasets/jobs/export?filter.status=x", await token())).statusCode).toBe(400);
  });
});
