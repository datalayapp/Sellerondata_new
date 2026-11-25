import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_ORIGIN, type TestAuthority, type TestTokenInput, createTestAuthority } from "@sellerondata/auth-kit/testing";
import type { PlatformEvent } from "@sellerondata/contracts";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "../app.ts";
import type { AppContext } from "../context.ts";
import { PLATFORM_MANAGE_READS, PLATFORM_ROUTES, ROUTE_FEATURES } from "../features/route-map.ts";
import { isOrgOpen } from "../org/context.ts";
import { SEEDED_KEY } from "../org/platform-service.ts";
import { TENANT_TABLES } from "../org/tables.ts";
import { KEY_FILE_NAME, fileKeyProvider } from "../services/secret-box.ts";
import type { ApiJson } from "../test/helpers.ts";
import { type TestPgDb, createTestDb } from "../test/pg.ts";
import { ManualClock } from "../util/clock.ts";
import { orgPurgeDir, rewritePlatformUrl } from "./identity.ts";

/**
 * Platform kipi (`TAGPRESS_AUTH=platform`, plan TP-PLAT, §S2, §S3, §S6) gerçek Postgres'le (`pnpm test:pg`): auth-kit test
 * yetkilisi jeton basar, product-kit izdüşümü ve olay alıcısı gerçek şemada (`db/pg/migrations`, uygulama rolü RLS altında).
 * Kapsam: kimliksiz 401 (bütün uçlar), ürün erişimi, CSRF/köken/`X-SOD-Org`, izin eşlemesi (uç tablosu → izin; Kullanıcı rolü
 * yönetim uçlarında 403), `READ_ONLY`, JIT firma + varsayılan içerik, hesap olayları (üye, ad, kapatma, abonelik), kalıcı silme
 * (satırlar + `firmalar/<firma>`), iki firma izolasyonu, yol yeniden yazımı.
 */

let db: TestPgDb;
let su: pg.Client;
let authority: TestAuthority;
let dir: string;
let app: FastifyInstance;
let ctx: AppContext;

beforeAll(async () => {
  // Gerçek platform şeması: göçler var, yerel kipin test eki (`orgs`) yok.
  db = await createTestDb({ template: false, migrate: true, orgs: false });
  su = new pg.Client({ connectionString: db.superUrl });
  await su.connect();
  authority = await createTestAuthority();
  dir = mkdtempSync(path.join(os.tmpdir(), "tagpress-platform-"));
  ({ app, ctx } = await buildApp({
    config: {
      auth: "platform",
      dataDir: dir,
      port: 4200,
      dev: true,
      webDist: path.join(dir, "web-yok"),
      platform: { jwksUrl: authority.jwksUrl, allowedOrigins: [TEST_ORIGIN], production: false, aiGateway: null },
    },
    databaseUrl: db.appUrl,
    platform: { fetch: authority.fetch, purgeRetryEveryMs: 0 },
    clock: new ManualClock(),
    secretKeys: fileKeyProvider(path.join(dir, KEY_FILE_NAME), { protector: null }),
    legacyDpapi: null,
    startQueue: false,
  }));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await su?.end();
  await db?.drop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- yardımcılar

type Who = { orgId: string; membershipId: string; role?: string | null; epoch?: number; perms?: string[]; status?: TestTokenInput["status"]; orgName?: string };
const newMember = (orgId = randomUUID(), role: string | null = "ADMIN"): Who => ({ orgId, membershipId: randomUUID(), role });
const token = (w: Who) =>
  authority.accessToken({
    product: "tagpress",
    orgId: w.orgId,
    membershipId: w.membershipId,
    role: w.role === undefined ? "ADMIN" : w.role,
    epoch: w.epoch ?? 0,
    orgName: w.orgName ?? "Test Firma",
    ...(w.perms ? { perms: w.perms } : {}),
    ...(w.status ? { status: w.status } : {}),
  });

type Res = { status: number; json: ApiJson; body: string };
async function call(method: InjectOptions["method"], url: string, opts: { who?: Who; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  const auth = opts.who ? authority.bearer(await token(opts.who)) : {};
  const res = await app.inject({
    method,
    url,
    headers: { ...auth, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...opts.headers },
    ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
  });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    json = null;
  }
  return { status: res.statusCode, json, body: res.body };
}

const postEvent = async (event: Record<string, unknown>) => {
  const res = await app.inject({
    method: "POST",
    url: "/api/tagpress/internal/events",
    payload: { token: await authority.eventToken({ eventId: randomUUID(), product: "tagpress", ...event } as unknown as PlatformEvent) },
  });
  await ctx.platformOrgs!.settle();
  return { status: res.statusCode, json: res.json() as { ok: boolean; outcome: string } };
};

const count = async (table: string, orgId: string) => Number((await su.query(`SELECT count(*)::int AS n FROM tagpress."${table}" WHERE org_id = $1`, [orgId])).rows[0].n);
const orgFolder = (orgId: string) => orgPurgeDir(dir, orgId)!;

/** Uç tablosu anahtarından dış yol (`:param` → örnek değer; Merkez uçları yeniden yazılmaz). */
const external = (key: string) => {
  const [method, url] = key.split(" ") as [string, string];
  const filled = url.replace(/:[A-Za-z]+/g, "x");
  return { method: method as InjectOptions["method"], url: filled.startsWith("/api/tagpress/") ? filled : filled.replace(/^\/api\//, "/api/tagpress/") };
};

// ---------------------------------------------------------------- testler

describe("yol yeniden yazımı (§S3)", () => {
  it("dış /api/tagpress/<yol> = iç /api/<yol>; Merkez, olay ve sağlık yolları aynen; önek dışı /api 404 yoluna", () => {
    expect(rewritePlatformUrl("/api/tagpress/jobs?x=1")).toBe("/api/jobs?x=1");
    expect(rewritePlatformUrl("/api/tagpress/events")).toBe("/api/events");
    expect(rewritePlatformUrl("/api/tagpress/platform/overview?from=a")).toBe("/api/tagpress/platform/overview?from=a");
    expect(rewritePlatformUrl("/api/tagpress/internal/events")).toBe("/api/tagpress/internal/events");
    expect(rewritePlatformUrl("/api/tagpress/health")).toBe("/api/tagpress/health");
    expect(rewritePlatformUrl("/api/jobs")).toBe("/api/__onek-disi");
    expect(rewritePlatformUrl("/api/health?a=b")).toBe("/api/__onek-disi?a=b");
    expect(rewritePlatformUrl("/api")).toBe("/api/__onek-disi");
    // Olay yolu yalnız tam eşleşmeyle; arkasına eklenen bölüm iç yola çevrilir (orada uç yok).
    expect(rewritePlatformUrl("/api/tagpress/internal/events/../jobs")).toBe("/api/internal/events/../jobs");
  });

  it("önek dışı, büyük harfli ve nokta bölümlü yollar hiçbir uca kimliksiz varmaz", async () => {
    const who = newMember();
    for (const url of ["/api/jobs", "/api/health", "/API/TAGPRESS/jobs", "/api/Tagpress/jobs", "/api/tagpress/%2e%2e/jobs", "/api/tagpress/platform/%2e%2e/%2e%2e/jobs"]) {
      const r = await call("GET", url, { who });
      expect([401, 404], url).toContain(r.status);
      expect(r.status === 200, url).toBe(false);
    }
    // Kimliksiz: nokta bölümü çözülse bile iç uç kimlik ister.
    for (const url of ["/api/tagpress/platform/../jobs", "/api/tagpress/internal/events/../../jobs", "/api/tagpress/x/../jobs"]) {
      const r = await call("GET", url);
      expect([401, 404], url).toContain(r.status);
    }
  });

  it("sağlık kimliksiz açık; olay alıcısı imzasız gövdeyi işlemez", async () => {
    expect((await call("GET", "/api/tagpress/health")).json).toEqual({ ok: true });
    // İç sağlık ucu (dil sayısı, eksik yetenekler) dışarıdan erişilmez.
    expect((await call("GET", "/api/health")).status).toBe(404);
    const r = await call("POST", "/api/tagpress/internal/events", { body: { token: "bozuk" } });
    expect([400, 401]).toContain(r.status);
  });
});

describe("uç tablosu (platform kipi)", () => {
  it("tablosuz uç yok; platform uçlarının hepsi kayıtlı", () => {
    const gate = ctx.featureGate!;
    expect(gate.unmapped, "tabloda olmayan uç").toEqual([]);
    const registered = new Set(gate.registered);
    expect(Object.keys(PLATFORM_ROUTES).filter((k) => !registered.has(k))).toEqual([]);
    expect(Object.keys(ROUTE_FEATURES).filter((k) => !registered.has(k))).toEqual([]);
  });

  it("açık listedekiler dışında her uç kimliksiz 401", async () => {
    const open = Object.entries(PLATFORM_ROUTES)
      .filter(([, v]) => v.public)
      .map(([k]) => k);
    const failures: string[] = [];
    for (const key of ctx.featureGate!.registered) {
      const base = key.startsWith("HEAD ") ? `GET ${key.slice(5)}` : key;
      if (open.includes(base)) continue;
      const { method, url } = external(key);
      // İç sağlık ucu (`/api/health`) dışarıdan yoktur: dış `/api/tagpress/health` yeniden yazılmayan açık platform ucudur
      // (yanıtı yalnız `{ ok: true }`, yukarıda), iç yol önek dışı olduğu için 404 yoluna gider.
      if (base === "GET /api/health") continue;
      const r = await call(method, url, method === "GET" || method === "HEAD" ? {} : { body: {} });
      if (r.status !== 401) failures.push(`${key} → ${r.status}`);
    }
    expect(failures).toEqual([]);
  });
});

describe("kimlik ve izin (§S6)", () => {
  it("ürün erişimi yoksa 403 NO_PRODUCT_ACCESS; firmasız jeton 403", async () => {
    const r = await call("GET", "/api/tagpress/jobs", { who: { ...newMember(), role: null } });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("NO_PRODUCT_ACCESS");
    const res = await app.inject({ method: "GET", url: "/api/tagpress/jobs", headers: authority.bearer(await authority.accessToken({ product: "tagpress", orgId: null })) });
    expect(res.statusCode).toBe(403);
  });

  it("çerezli yazma: CSRF ve köken yoksa 403, X-SOD-Org uyuşmazsa 409; tamsa geçer", async () => {
    const who = newMember();
    const tok = await token(who);
    const post = (headers: Record<string, string>) =>
      app.inject({ method: "POST", url: "/api/tagpress/jobs/delete", headers: { ...headers, "content-type": "application/json" }, payload: JSON.stringify({ ids: [] }) });
    const noCsrf = await post(authority.cookie(tok));
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe("CSRF_FAILED");
    const badOrigin = await post(authority.cookie(tok, { write: true, origin: "https://kotu.example" }));
    expect(badOrigin.statusCode).toBe(403);
    const otherOrg = await post(authority.cookie(tok, { write: true, org: randomUUID() }));
    expect(otherOrg.statusCode).toBe(409);
    expect(otherOrg.json().error.code).toBe("ORG_MISMATCH");
    const ok = await post(authority.cookie(tok, { write: true }));
    expect(ok.statusCode, ok.body).not.toBe(403);
    expect(ok.statusCode).not.toBe(409);
    // Yerel kipin `X-Studio` başlığı platformda bir şey açmaz.
    expect((await post({ "x-studio": "1" })).statusCode).toBe(401);
  });

  it("Kullanıcı rolü yönetim uçlarında 403 FORBIDDEN, Yönetici geçer; GET /api/org yetkiyi söyler", async () => {
    const orgId = randomUUID();
    const admin = newMember(orgId, "ADMIN");
    const user = newMember(orgId, "USER");
    const manage = Object.entries(ROUTE_FEATURES)
      .filter(([, e]) => e.access === "manage")
      .map(([k]) => k);
    expect(manage.sort()).toEqual(
      [
        "DELETE /api/settings/keys/:provider",
        "PATCH /api/features",
        "PATCH /api/org",
        "PATCH /api/settings",
        "POST /api/settings/keys/:provider/test",
        "POST /api/setup/complete",
        "POST /api/setup/restart",
        "POST /api/setup/skip",
        "PUT /api/settings/keys/:provider",
        "PUT /api/setup/answers",
      ].sort(),
    );
    for (const key of manage) {
      const { method, url } = external(key);
      const r = await call(method, url, { who: user, body: {} });
      expect(r.status, key).toBe(403);
      expect(r.json.error.code, key).toBe("FORBIDDEN");
      const a = await call(method, url, { who: admin, body: {} });
      expect(a.status, `${key} (Yönetici) ${a.body}`).not.toBe(401);
      expect(a.json?.error?.code, `${key} (Yönetici)`).not.toBe("FORBIDDEN");
    }
    // Yönetici: platformun yönettiği uçlar 409, firma adı 403 (Merkez'de değişir).
    const key = await call("PUT", "/api/tagpress/settings/keys/anthropic", { who: admin, body: { apiKey: "sk-ant-x" } });
    expect(key.status).toBe(409);
    expect(key.json.code).toBe("managed-by-platform");
    expect((await call("DELETE", "/api/tagpress/settings/keys/anthropic", { who: admin })).json.code).toBe("managed-by-platform");
    expect((await call("POST", "/api/tagpress/settings/keys/anthropic/test", { who: admin, body: {} })).json.code).toBe("managed-by-platform");
    // Kurulum ayarlarında (RLS yok) anahtar kaydı hiç yazılmadı; ana anahtar dosyası açılmadı.
    expect((await su.query(`SELECT key FROM tagpress.settings WHERE key LIKE 'key:%'`)).rows).toEqual([]);
    expect(existsSync(path.join(dir, KEY_FILE_NAME))).toBe(false);
    const rename = await call("PATCH", "/api/tagpress/org", { who: admin, body: { name: "Başka" } });
    expect(rename.status).toBe(403);
    expect(rename.json.code).toBe("name-managed-by-platform");
    // Yetki görünümü.
    const ua = await call("GET", "/api/tagpress/org", { who: user });
    expect(ua.status, ua.body).toBe(200);
    expect(ua.json.platform).toBe(true);
    expect(ua.json.access).toEqual({ edit: true, spend: true, manage: false });
    expect((await call("GET", "/api/tagpress/org", { who: admin })).json.access).toEqual({ edit: true, spend: true, manage: true });
  });

  it("izin eşlemesi: yalnız giriş izni olan üye okur, yazma ve harcama uçlarında 403", async () => {
    const viewer: Who = { ...newMember(), perms: ["tagpress.web.access"] };
    const failures: string[] = [];
    for (const [key, entry] of Object.entries(ROUTE_FEATURES)) {
      if (key === "GET /api/events") continue; // akış açık kalır; kapısı aynı (okuma)
      const { method, url } = external(key);
      const r = await call(method, url, { who: viewer, ...(method === "GET" ? {} : { body: {} }) });
      const forbidden = r.status === 403 && r.json?.error?.code === "FORBIDDEN";
      // Harcama tutarı okuyan uçlar platformda yönetim izni ister (R1): giriş izni yetmez.
      const open = entry.access === "read" && !PLATFORM_MANAGE_READS.has(key);
      if (open ? forbidden || r.status === 401 : !forbidden) failures.push(`${key} (${entry.access}) → ${r.status}`);
    }
    expect(failures).toEqual([]);
    expect((await call("GET", "/api/tagpress/org", { who: viewer })).json.access).toEqual({ edit: false, spend: false, manage: false });
  });

  it("READ_ONLY abonelik: okuma 200, yazma 403 READ_ONLY, sorgu POST'u açık", async () => {
    const who: Who = { ...newMember(), status: "READ_ONLY" };
    expect((await call("GET", "/api/tagpress/jobs", { who })).status).toBe(200);
    const w = await call("POST", "/api/tagpress/jobs/delete", { who, body: { ids: [] } });
    expect(w.status).toBe(403);
    expect(w.json.error.code).toBe("READ_ONLY");
    const preview = await call("POST", "/api/tagpress/setup/preview", { who, body: { answers: {} } });
    expect(preview.status, preview.body).not.toBe(403);
  });
});

describe("anahtarlar platformda tutulmaz", () => {
  it("settings tablosunda yapay zekâ anahtarı kaydı varsa platform kipi açılmaz", async () => {
    await su.query(`INSERT INTO tagpress.settings (key, value) VALUES ('key:anthropic', '"x"')`);
    try {
      const other = mkdtempSync(path.join(os.tmpdir(), "tagpress-platform-2-"));
      await expect(
        buildApp({
          config: { auth: "platform", dataDir: other, port: 4200, dev: true, webDist: path.join(other, "web-yok"), platform: { jwksUrl: authority.jwksUrl, allowedOrigins: [TEST_ORIGIN], production: false, aiGateway: null } },
          databaseUrl: db.appUrl,
          platform: { fetch: authority.fetch, purgeRetryEveryMs: 0 },
          legacyDpapi: null,
          startQueue: false,
        }),
      ).rejects.toThrow(/key:anthropic/);
      rmSync(other, { recursive: true, force: true });
    } finally {
      await su.query(`DELETE FROM tagpress.settings WHERE key = 'key:anthropic'`);
    }
  });
});

describe("firma: JIT, varsayılan içerik, olaylar", () => {
  it("ilk istekte firma ve üye açılır, varsayılan içerik bir kez kurulur (benim-tarzim yok)", async () => {
    const who: Who = { ...newMember(), orgName: "Yeni Firma" };
    const r = await call("GET", "/api/tagpress/languages", { who });
    expect(r.status, r.body).toBe(200);
    expect(r.json.languages.map((l: { id: string }) => l.id)).not.toContain("benim-tarzim");
    expect(r.json.languages).toHaveLength(1);
    const company = (await su.query(`SELECT name, "closedAt" FROM tagpress."Company" WHERE id = $1`, [who.orgId])).rows[0];
    expect(company).toEqual({ name: "Yeni Firma", closedAt: null });
    expect((await su.query(`SELECT role, active FROM tagpress."Member" WHERE id = $1`, [who.membershipId])).rows[0]).toEqual({ role: "ADMIN", active: true });
    const seeded = (await su.query(`SELECT value FROM tagpress.org_settings WHERE org_id = $1 AND key = $2`, [who.orgId, SEEDED_KEY])).rows[0];
    expect(seeded).toBeTruthy();
    expect(existsSync(orgFolder(who.orgId))).toBe(true);
    // Yeni firma: kurulum bekliyor, özellikler kayıt varsayılanları.
    const org = await call("GET", "/api/tagpress/org", { who });
    expect(org.json.org).toEqual({ id: who.orgId, name: "Yeni Firma" });
    expect(org.json.setup.status).toBe("pending");
    // İkinci istek yeniden kurmaz (dil sayısı aynı).
    expect((await call("GET", "/api/tagpress/languages", { who })).json.languages).toHaveLength(1);
  });

  it("member.upserted ve member.removed işlenir; çıkarılan üye 403", async () => {
    const who = newMember();
    expect((await call("GET", "/api/tagpress/jobs", { who })).status).toBe(200);
    const up = await postEvent({ type: "member.upserted", orgId: who.orgId, membershipId: who.membershipId, personId: "p-1", name: "Ayşe", orgRole: "MEMBER", role: "USER", active: true, epoch: 2 });
    expect(up.json.outcome).toBe("processed");
    expect((await su.query(`SELECT role, name, epoch FROM tagpress."Member" WHERE id = $1`, [who.membershipId])).rows[0]).toEqual({ role: "USER", name: "Ayşe", epoch: 2 });
    // Eski jeton (ep 0 < 2) bayat.
    expect((await call("GET", "/api/tagpress/jobs", { who })).json.error.code).toBe("TOKEN_STALE");
    const rm = await postEvent({ type: "member.removed", orgId: who.orgId, membershipId: who.membershipId, epoch: 3 });
    expect(rm.json.outcome).toBe("processed");
    const after = await call("GET", "/api/tagpress/jobs", { who: { ...who, epoch: 3 } });
    expect(after.status).toBe(403);
    expect(after.json.error.code).toBe("FORBIDDEN");
  });

  it("org.updated adı yazar; subscription.updated kabul edilir", async () => {
    const who = newMember();
    await call("GET", "/api/tagpress/org", { who });
    expect((await postEvent({ type: "org.updated", orgId: who.orgId, name: "Merkez Adı", version: 4 })).json.outcome).toBe("processed");
    expect((await call("GET", "/api/tagpress/org", { who })).json.org.name).toBe("Merkez Adı");
    const sub = await postEvent({ type: "subscription.updated", orgId: who.orgId, status: "READ_ONLY", plan: "early_access", version: 1 });
    expect(sub.status).toBe(200);
    expect(sub.json.ok).toBe(true);
  });

  it("org.closed: her uç 409 ORG_CLOSED, arka plan kapısı kapalı; org.reopened geri açar", async () => {
    const who = newMember();
    expect((await call("GET", "/api/tagpress/jobs", { who })).status).toBe(200);
    expect(isOrgOpen(who.orgId)).toBe(true);
    await postEvent({ type: "org.closed", orgId: who.orgId, closedAt: new Date().toISOString(), purgeAfter: new Date(Date.now() + 86_400_000).toISOString(), version: 5 });
    const r = await call("GET", "/api/tagpress/jobs", { who });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("ORG_CLOSED");
    expect((await call("GET", "/api/tagpress/platform/overview", { who })).status).toBe(409);
    expect(isOrgOpen(who.orgId)).toBe(false);
    await postEvent({ type: "org.reopened", orgId: who.orgId, version: 6 });
    expect((await call("GET", "/api/tagpress/jobs", { who })).status).toBe(200);
    expect(isOrgOpen(who.orgId)).toBe(true);
  });
});

describe("iki firma izolasyonu (platform jetonuyla)", () => {
  it("B, A'nın verisini ne listede ne kimlikle görür; A'nın yazması B'yi değiştirmez", async () => {
    const a = newMember();
    const b = newMember();
    const langA = (await call("GET", "/api/tagpress/languages", { who: a })).json.languages[0].id as string;
    expect((await call("PATCH", `/api/tagpress/languages/${langA}`, { who: a, body: { name: "ALFA-GIZLI-DIL" } })).status).toBe(200);
    const listB = await call("GET", "/api/tagpress/languages", { who: b });
    expect(listB.status).toBe(200);
    expect(listB.body).not.toContain("ALFA-GIZLI-DIL");
    const langB = listB.json.languages[0].id as string;
    if (langB !== langA) {
      // Kimlikle erişim: B'nin bağlamında A'nın dili yok.
      expect((await call("GET", `/api/tagpress/languages/${langA}/profile`, { who: b })).status).toBe(404);
      expect((await call("PATCH", `/api/tagpress/languages/${langA}`, { who: b, body: { name: "B yazdı" } })).status).toBe(404);
    }
    // Aynı kimlikli dil (varsayılan dil kimliği firmadan bağımsızsa) yine firma kapsamında: B'nin adı değişmedi.
    expect((await call("GET", "/api/tagpress/languages", { who: a })).body).toContain("ALFA-GIZLI-DIL");
    expect((await call("GET", "/api/tagpress/languages", { who: b })).body).not.toContain("ALFA-GIZLI-DIL");
    // Bütün parametresiz okuma uçlarında A'nın işareti B'ye görünmez.
    for (const [key, entry] of Object.entries(ROUTE_FEATURES)) {
      if (entry.access !== "read" || key.includes(":") || !key.startsWith("GET ") || key === "GET /api/events") continue;
      const { url } = external(key);
      const r = await call("GET", url, { who: b });
      expect(r.body, key).not.toContain("ALFA-GIZLI-DIL");
    }
    // Merkez uçları da firma kapsamında.
    const ov = await call("GET", "/api/tagpress/platform/datasets", { who: b });
    expect(ov.status, ov.body).toBe(200);
    expect(ov.body).not.toContain("ALFA-GIZLI-DIL");
  });

  it("B'nin jetonuyla A'nın firma başlığı yazma açmaz (409)", async () => {
    const a = newMember();
    const b = newMember();
    await call("GET", "/api/tagpress/jobs", { who: a });
    const res = await app.inject({
      method: "POST",
      url: "/api/tagpress/jobs/delete",
      headers: { ...authority.cookie(await token(b), { write: true, org: a.orgId }), "content-type": "application/json" },
      payload: JSON.stringify({ ids: [] }),
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("kalıcı silme (org.purged)", () => {
  it("firmanın satırları ve firmalar/<firma> silinir; başka firmanınki durur", async () => {
    const a = newMember();
    const b = newMember();
    for (const w of [a, b]) expect((await call("GET", "/api/tagpress/languages", { who: w })).status).toBe(200);
    // Kalan her şeyi kapsasın: firmanın klasörüne kayıtsız dosya da konur.
    mkdirSync(path.join(orgFolder(a.orgId), "onizleme"), { recursive: true });
    writeFileSync(path.join(orgFolder(a.orgId), "onizleme", "kayitsiz.png"), "x");
    expect(await count("languages", a.orgId)).toBeGreaterThan(0);
    expect(await count("templates", a.orgId)).toBeGreaterThan(0);

    const ev = await postEvent({ type: "org.purged", orgId: a.orgId });
    expect(ev.json.outcome).toBe("processed");
    await ctx.identity!.settlePurges();

    for (const t of TENANT_TABLES) expect(await count(t, a.orgId), t).toBe(0);
    expect((await su.query(`SELECT count(*)::int AS n FROM tagpress."Company" WHERE id = $1`, [a.orgId])).rows[0].n).toBe(0);
    expect((await su.query(`SELECT "completedAt" FROM tagpress."CompanyPurge" WHERE "orgId" = $1`, [a.orgId])).rows[0].completedAt).not.toBeNull();
    expect(existsSync(orgFolder(a.orgId))).toBe(false);
    expect(isOrgOpen(a.orgId)).toBe(false);
    // B yerinde.
    expect(await count("languages", b.orgId)).toBeGreaterThan(0);
    expect(existsSync(orgFolder(b.orgId))).toBe(true);
    expect(readdirSync(path.join(dir, "firmalar"))).toContain(b.orgId);
    expect((await call("GET", "/api/tagpress/languages", { who: b })).status).toBe(200);
    // Silinen firmanın jetonu firmayı yeniden kurmaz.
    const again = await call("GET", "/api/tagpress/languages", { who: a });
    expect(again.status).toBe(409);
    expect(await count("languages", a.orgId)).toBe(0);
  });

  it("silme listesi katalogla uyumlu, haklar beklenen", async () => {
    expect(await ctx.identity!.checkPurgeTables()).toEqual([]);
    expect(await ctx.identity!.checkGrants()).toEqual([]);
  });

  it("silme klasörü yalnız firmalar/<firma>: veri klasörü, üst klasör ya da geçersiz ad üretmez", () => {
    expect(orgPurgeDir(dir, "ABCDEF01-2345-6789-ABCD-EF0123456789")).toBe(path.join(dir, "firmalar", "abcdef01-2345-6789-abcd-ef0123456789"));
    for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", "con", "NUL", "Büyük", "x".repeat(70), "/etc"]) expect(orgPurgeDir(dir, bad), bad).toBeNull();
  });
});
