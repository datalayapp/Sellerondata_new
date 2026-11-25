/**
 * Merkez'in TagPress için kayıtlı gerçek yanıtları: `Platform/apps/hub-web/e2e/fixtures/tagpress-real/*.json`
 * (`Platform/docs/mimari/06-merkez.md` §7 "Merkez sahte API'si"). Bu test TagPress'in gerçek Merkez uçlarının yanıtını
 * üretir ve depodaki kayıtla birebir karşılaştırır; uçlar değişince burada kırılır. Merkez sahte API'si kaydı olduğu gibi
 * sunar (`hub-web/src/mocks/hub.ts` `recordedProvider`); Merkez'de `npm test` (`test/hub-providers.test.mjs`) klasörü denetler.
 *
 * Bilerek yenileme (Tagpress içinde): `pnpm vitest run apps/server/src/platform/hub/hubWebFixtures.test.ts -u`, sonra
 * `git diff Platform/apps/hub-web/e2e/fixtures/tagpress-real` ile bakın ve Merkez'de `npm test` koşun.
 *
 * Değişkenler sabit: saat (`ctx.now`, jetonlar da) `NOW`'a dondurulur, senaryo `test/scenario.ts` (A firması; B aynı
 * veritabanında, yanıta girmemeli). Kimlikler (UUID) `<id>`, kayıt anları `<zaman>` yazılır. Veritabanı bugün SQLite; Postgres
 * düzeni aynı senaryoyu yazdığında aynı dosyalar beklenir.
 */
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { createTestAuthority, type TestAuthority } from "@sellerondata/auth-kit/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildHubTestApp } from "./test/app.ts";
import { type HubHarness, NOW, OCT, ORG_A, TIME_ZONE, seedOrgA, seedOrgB, testHarness } from "./test/scenario.ts";

const OUT = path.resolve(import.meta.dirname, "../../../../../../Platform/apps/hub-web/e2e/fixtures/tagpress-real");
const PERIOD = `from=${OCT.from}&to=${OCT.to}`;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Koşudan koşuya değişebilen değerler: kimlik (bağlantı içinde de) ve kayıt anı. Anahtarlar da aynı kurala uyar. */
function normalize(value: unknown): unknown {
  if (typeof value === "string") return STAMP.test(value) ? "<zaman>" : value.replace(UUID, "<id>");
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.replace(UUID, "<id>"), normalize(v)]));
  return value;
}

let authority: TestAuthority;
let h: HubHarness;
let app: FastifyInstance;

beforeAll(async () => {
  authority = await createTestAuthority();
  h = await testHarness();
  seedOrgA(h.insert);
  seedOrgB(h.insert);
  app = await buildHubTestApp(h, authority, () => ({ timeZone: TIME_ZONE, companyConfirmed: true }));
});
afterAll(async () => {
  await app.close();
  await h.close();
});

/** Merkez'in kullandığı uçlar: dosya adı → [yol, dil]. Dosya adları sahte API'nin okuduğu adlar (`overview.<dil>` …). */
const CASES: [string, string, string][] = [
  ["overview.tr", `/overview?${PERIOD}`, "tr"],
  ["overview.en", `/overview?${PERIOD}`, "en"],
  ["analytics.tr", `/analytics?${PERIOD}&compare=previous`, "tr"],
  ["datasets.tr", "/datasets", "tr"],
  ["activity.tr", "/activity?page=1&pageSize=5", "tr"],
];

describe("Merkez kayıtlı gerçek yanıtlar (hub-web e2e/fixtures/tagpress-real)", () => {
  it("yanıtlar kayıtla aynı (bilerek değişiklikte -u ile yenilenir)", async () => {
    const written = new Set<string>();
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    try {
      // Jeton dondurulmuş saatle basılır (geçerlilik `NOW`'a göre).
      const tok = await authority.accessToken({ product: "tagpress", role: "ADMIN", orgId: ORG_A, membershipId: "m-1" });
      const record = async (name: string, url: string, locale: string) => {
        const res = await app.inject({ url: `/api/tagpress/platform${url}`, headers: { ...authority.bearer(tok), "accept-language": locale } });
        expect(res.statusCode, `${name}: ${res.body}`).toBe(200);
        expect(res.body, name).not.toContain("Ayşe");
        written.add(`${name}.json`);
        await expect.soft(`${JSON.stringify({ status: res.statusCode, body: normalize(res.json()) }, null, 2)}\n`, name).toMatchFileSnapshot(path.join(OUT, `${name}.json`));
        return res;
      };
      for (const c of CASES) await record(...c);
      const list = await app.inject({ url: "/api/tagpress/platform/datasets", headers: authority.bearer(tok) });
      for (const d of (list.json() as { datasets: { id: string }[] }).datasets) await record(`dataset.${d.id}.tr`, `/datasets/${d.id}?page=1&pageSize=4`, "tr");
    } finally {
      vi.useRealTimers();
    }
    // Uç kalkınca kaydı da kalkmalı: klasörde üretilmeyen dosya kalmaz.
    expect(fs.readdirSync(OUT).filter((f) => f.endsWith(".json")).sort()).toEqual([...written].sort());
  });
});
