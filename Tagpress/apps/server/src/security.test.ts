import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TestApp, makeApp } from "./test/helpers.ts";

describe("güvenlik", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(() => t.close());

  const raw = (method: "GET" | "POST" | "OPTIONS" | "PATCH", url: string, headers: Record<string, string>, payload?: unknown) =>
    t.app.inject({ method, url, headers: { ...(payload ? { "content-type": "application/json" } : {}), ...headers }, ...(payload ? { payload: JSON.stringify(payload) } : {}) });

  it("X-Studio başlığı olmadan değiştiren istek reddedilir; GET serbest", async () => {
    expect((await raw("POST", "/api/languages", {}, { name: "x" })).statusCode).toBe(403);
    expect((await raw("POST", "/api/languages", { "x-studio": "0" }, { name: "x" })).statusCode).toBe(403);
    expect((await raw("GET", "/api/languages", {})).statusCode).toBe(200);
    expect((await raw("POST", "/api/languages", { "x-studio": "1" }, { name: "x" })).statusCode).toBe(200);
  });

  it("CORS yalnızca uygulama ve Vite kökenine açılır (null köken reddedilir)", async () => {
    for (const origin of ["http://127.0.0.1:5420", "http://localhost:5420", "http://localhost:5421"]) {
      const r = await raw("OPTIONS", "/api/languages", { origin, "access-control-request-method": "POST", "access-control-request-headers": "x-studio" });
      expect(r.statusCode, origin).toBe(204);
      expect(r.headers["access-control-allow-origin"]).toBe(origin);
      expect(String(r.headers["access-control-allow-headers"])).toContain("x-studio");
    }
    // `null` köken (sandbox iframe, file://) izinli değil.
    expect((await raw("OPTIONS", "/api/languages", { origin: "null", "access-control-request-method": "POST" })).statusCode).toBe(403);
    const evil = await raw("OPTIONS", "/api/languages", { origin: "https://kotu.example", "access-control-request-method": "POST" });
    expect(evil.statusCode).toBe(403);
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    const evilGet = await raw("GET", "/api/settings", { origin: "https://kotu.example" });
    expect(evilGet.statusCode).toBe(403);
    // Yabancı site X-Studio ile istese bile köken reddedilir.
    const evilPost = await raw("POST", "/api/languages", { origin: "http://localhost:5317", "x-studio": "1" }, { name: "x" });
    expect(evilPost.statusCode).toBe(403);
  });

  it("yerel olmayan Host başlığı reddedilir (DNS rebinding)", async () => {
    expect((await raw("GET", "/api/health", { host: "kotu.example:5420" })).statusCode).toBe(403);
    expect((await raw("GET", "/api/health", { host: "127.0.0.1:5420" })).statusCode).toBe(200);
  });

  it("API anahtarı yanıtta asla dönmez; adres değiştirilemez; sağlayıcılar sabit", async () => {
    const put = await t.api("PUT", "/api/settings/keys/anthropic", { apiKey: "sk-ant-gizli-anahtar-123" });
    expect(put.status).toBe(200);
    expect(put.body).not.toContain("gizli");
    expect(put.json).toMatchObject({ provider: "anthropic", hasKey: true, baseUrl: "https://api.anthropic.com", encrypted: true });
    const view = await t.api("GET", "/api/settings");
    expect(view.body).not.toContain("gizli");
    // Her platformda şifreli: "şifrelenmeden saklanıyor" uyarısı yok, kayıtta düz değer yok.
    expect(view.json.warnings).toEqual([]);
    const stored = (t.raw.get("SELECT value FROM settings WHERE key = 'key:anthropic'") as { value: string }).value;
    expect(stored).not.toContain("gizli");
    expect(t.ctx.secrets.get("anthropic")).toBe("sk-ant-gizli-anahtar-123");
    const withUrl = await t.api("PUT", "/api/settings/keys/anthropic", { apiKey: "sk-ant-baska-anahtar", baseUrl: "https://kotu.example" });
    expect(withUrl.status).toBe(400);
    expect(t.ctx.secrets.get("anthropic")).toBe("sk-ant-gizli-anahtar-123");
    expect((await t.api("PUT", "/api/settings/keys/openai", { apiKey: "sk-12345678" })).status).toBe(400);
    const del = await t.api("DELETE", "/api/settings/keys/anthropic");
    expect(del.json.hasKey).toBe(false);
  });

  it("ayarlar kısmi güncellenir, bilinmeyen alan reddedilir", async () => {
    const r = await t.api("PATCH", "/api/settings", { concurrency: 3 });
    expect(r.json.settings).toEqual({ defaultLanguageId: null, concurrency: 3, variantsPerRun: 1 });
    expect((await t.api("PATCH", "/api/settings", { variantsPerRun: 2 })).json.settings.concurrency).toBe(3);
    // Görsel denetim üründen kalktı (SUNUCU-PLANI §9): ayarı artık bilinmeyen alandır.
    expect((await t.api("PATCH", "/api/settings", { visualCritique: true })).status).toBe(400);
    expect((await t.api("PATCH", "/api/settings", { gizli: 1 })).status).toBe(400);
    expect((await t.api("PATCH", "/api/settings", { defaultLanguageId: "yok" })).status).toBe(400);
  });

  it("bozuk JSON gövdesi 400, bilinmeyen API 404, sağlık eksik portları söyler", async () => {
    const bad = await t.app.inject({ method: "POST", url: "/api/languages", headers: { "x-studio": "1", "content-type": "application/json" }, payload: "{bozuk" });
    expect(bad.statusCode).toBe(400);
    expect((await t.api("GET", "/api/yok")).status).toBe(404);
    const h = await t.api("GET", "/api/health");
    expect(h.json.missingPorts).toEqual(["geometry", "engine", "designer", "imageGenerator", "fontCatalog"]);
  });
});

// Anahtarların diskte şifrelenmesi (her platformda) ve DPAPI'den taşıma: secrets.test.ts.

describe("derlenmiş arayüz", () => {
  it("dosya varsa o, yoksa index.html (SPA); /api altı asla", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const path = await import("node:path");
    const t = await makeApp({
      prepare: (dir) => {
        mkdirSync(path.join(dir, "web-yok", "assets"), { recursive: true });
        writeFileSync(path.join(dir, "web-yok", "index.html"), "<!doctype html><title>TagPress</title>");
        writeFileSync(path.join(dir, "web-yok", "assets", "app.js"), "console.log(1)");
      },
    });
    try {
      const home = await t.api("GET", "/");
      expect(home.status).toBe(200);
      expect(home.body).toContain("TagPress");
      expect((await t.api("GET", "/uretim/parti/123")).body).toContain("TagPress");
      const js = await t.api("GET", "/assets/app.js");
      expect(js.headers["content-type"]).toMatch(/javascript/);
      expect(js.headers["cache-control"]).toMatch(/immutable/);
      expect((await t.api("GET", "/../../studio.db")).body).toContain("TagPress");
      const api = await t.api("GET", "/api/olmayan");
      expect(api.status).toBe(404);
      expect(api.json.error).toBeTruthy();
    } finally {
      await t.close();
    }
  });
});
