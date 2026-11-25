import path from "node:path";
import { PRODUCTS } from "@sellerondata/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.ts";
import { authModeFromEnv, loadConfig, platformConfigFromEnv, platformConfigProblems } from "../config.ts";
import { permissionFor, permissionsFor } from "../features/gate.ts";
import { PLATFORM_MANAGED_ROUTES, ROUTE_FEATURES, type RouteAccess } from "../features/route-map.ts";
import { isOrgOpen, setOrgGate } from "../org/context.ts";
import { FairScheduler } from "../services/generation/fair.ts";

/** Platform kipinin veritabanısız parçaları (`pnpm test`); uçtan uca davranış `platform.pg.test.ts`'te (Postgres). */

describe("kip ve ortam (§S2)", () => {
  it("TAGPRESS_AUTH: boş → platform, local → yerel; başka değer açılışı durdurur", () => {
    expect(authModeFromEnv({})).toBe("platform");
    expect(authModeFromEnv({ TAGPRESS_AUTH: " Platform " })).toBe("platform");
    expect(authModeFromEnv({ TAGPRESS_AUTH: "local" })).toBe("local");
    expect(() => authModeFromEnv({ TAGPRESS_AUTH: "lokal" })).toThrow(/TAGPRESS_AUTH/);
  });

  it("platform ayarları ortamdan; zorunlular eksikse null", () => {
    expect(platformConfigFromEnv({ ACCOUNT_JWKS_URL: "http://a/jwks" })).toBeNull();
    expect(platformConfigFromEnv({ ACCOUNT_JWKS_URL: "http://a/jwks", ALLOWED_ORIGINS: " https://app.x , http://localhost:8088 " })).toEqual({
      jwksUrl: "http://a/jwks",
      allowedOrigins: ["https://app.x", "http://localhost:8088"],
      production: false,
      aiGateway: null,
    });
    expect(
      platformConfigFromEnv({ ACCOUNT_JWKS_URL: "j", ALLOWED_ORIGINS: "o", SOD_ENV: "production", AI_GATEWAY_URL: "http://ai-api:4300", AI_GATEWAY_TOKEN: "t" }),
    ).toMatchObject({ production: true, aiGateway: { url: "http://ai-api:4300", token: "t" } });
  });

  it("platform kipinde eksik değişken ve üretimde ortamdaki sağlayıcı anahtarı açılışı durdurur; yerel kipte sorun yok", () => {
    const base = loadConfig({ auth: "platform", databaseUrl: null, platform: null });
    const [missing] = platformConfigProblems(base, {});
    expect(missing).toContain("DATABASE_URL");
    expect(missing).toContain("ACCOUNT_JWKS_URL");
    expect(missing).toContain("TAGPRESS_AUTH=local");
    const prod = { ...base, databaseUrl: "postgres://x", platform: { jwksUrl: "j", allowedOrigins: ["o"], production: true, aiGateway: null } };
    expect(platformConfigProblems(prod, {})).toEqual([]);
    expect(platformConfigProblems(prod, { ANTHROPIC_API_KEY: "sk-ant" })[0]).toContain("ANTHROPIC_API_KEY");
    expect(platformConfigProblems({ ...base, auth: "local" }, {})).toEqual([]);
  });

  it("platform kipinde gerekli değişken yoksa uygulama kurulmaz (yerel kip ipucuyla)", async () => {
    const dir = path.join(process.cwd(), "yok-platform");
    await expect(buildApp({ config: { auth: "platform", dataDir: dir, databaseUrl: null, platform: null } })).rejects.toThrow(/TAGPRESS_AUTH=local/);
  });
});

describe("uç erişimi → izin (§S6)", () => {
  it("her erişim kayıttaki bir izne bağlanır; yönetim izni Kullanıcı rolünde yok", () => {
    const tagpress = PRODUCTS.tagpress;
    const catalog = Object.keys(tagpress.permissions);
    for (const access of ["read", "write", "spend", "manage"] as RouteAccess[]) {
      expect(permissionsFor(access)[0]).toBe(permissionFor(access));
      for (const p of permissionsFor(access)) expect(catalog).toContain(p);
    }
    // Harcama iki izin ister (R1 kararı): yapay zekâ + iş düzenleme.
    expect([...permissionsFor("spend")].sort()).toEqual(["tagpress.ai.use", "tagpress.work.edit"]);
    const user = tagpress.roles.find((r) => r.key === "USER")!;
    expect(user.permissions).not.toContain(permissionFor("manage"));
    // İki hazır rolde değişiklik yok: Kullanıcı da Yönetici de harcayabilir.
    for (const role of tagpress.roles) for (const p of permissionsFor("spend")) expect(role.permissions, role.key).toContain(p);
    for (const a of ["read", "write", "spend"] as RouteAccess[]) for (const p of permissionsFor(a)) expect(user.permissions).toContain(p);
  });

  it("platformun yönettiği uçlar tabloda ve yönetim erişimli", () => {
    for (const k of PLATFORM_MANAGED_ROUTES) expect(ROUTE_FEATURES[k]?.access, k).toBe("manage");
  });
});

describe("arka plan kapısı", () => {
  let ungate: (() => void) | null = null;
  afterEach(() => {
    ungate?.();
    ungate = null;
  });

  it("kapı yoksa her firma açık; kapalı firmanın bellek içi işi başlamaz", async () => {
    expect(isOrgOpen("a")).toBe(true);
    ungate = setOrgGate((id) => id !== "kapali");
    const ran: string[] = [];
    const s = new FairScheduler({ maxTotal: () => 2, maxPerOrg: () => 1 });
    await Promise.all([s.submit("acik", async () => void ran.push("acik")), s.submit("kapali", async () => void ran.push("kapali"))]);
    expect(ran).toEqual(["acik"]);
    ungate();
    ungate = null;
    expect(isOrgOpen("kapali")).toBe(true);
  });

  it("durumu okunmamış firma (kapı `null`) kapalı; başka kapı açık biliyorsa açık; biri kapalı derse kapalı (R1)", () => {
    ungate = setOrgGate((id) => (id === "acik" ? true : id === "kapali" ? false : null));
    expect(isOrgOpen("bilinmeyen")).toBe(false);
    expect(isOrgOpen("acik")).toBe(true);
    expect(isOrgOpen("kapali")).toBe(false);
    const second = setOrgGate((id) => (id === "bilinmeyen" ? true : null));
    try {
      expect(isOrgOpen("bilinmeyen")).toBe(true);
      expect(isOrgOpen("acik")).toBe(true);
      expect(isOrgOpen("kapali")).toBe(false);
    } finally {
      second();
    }
  });
});
