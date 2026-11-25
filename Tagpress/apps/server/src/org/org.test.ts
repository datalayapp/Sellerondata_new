import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FEATURES, type ServerEvent, effectiveFeatures } from "@tagpress/domain";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.ts";
import { EventBus } from "../events.ts";
import { PENDING_SETUP } from "../services/setup.ts";
import { type TestApp, makeApp } from "../test/helpers.ts";
import { isUuidv7, uuidv7, uuidv7Time } from "../util/ids.ts";
import { OrgContextError, currentOrg, localOrg, maintenance, runInOrg } from "./context.ts";
import type { OrgResolver } from "./resolver.ts";
import { Tenancy } from "./tenancy.ts";

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const installValue = (app: TestApp, key: string) => (app.raw.get("SELECT value FROM settings WHERE key = ?", key) as { value: string } | undefined)?.value ?? null;

/** İsteğin firması `x-test-org` başlığından (yoksa varsayılan firma); iki firmalı denemeler için. */
const headerResolver = (fallback: () => string): OrgResolver => ({
  resolve: (req) => localOrg(String(req.headers["x-test-org"] ?? fallback())),
});

describe("firma: ilk açılış ve /api/org", () => {
  it("taze kurulumda 'Firmam' açılır ve varsayılan olur (sahip firma yazılmaz); ad PATCH ile verilir", async () => {
    t = await makeApp({ features: "registry" });
    const orgs = t.ctx.orgs.list();
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({ name: "Firmam", source: "local", closedAt: null });
    expect(isUuidv7(orgs[0]!.id)).toBe(true);
    expect(installValue(t, "install.defaultOrgId")).toBe(JSON.stringify(orgs[0]!.id));
    // Eski kökün sahibi sabitlenir: varsayılan firma sonradan değişse de dosya kökü kaymaz.
    expect(installValue(t, "install.ownerOrgId")).toBe(JSON.stringify(orgs[0]!.id));

    // Yanıt: firma + kurulum durumu (taze kurulumda kayıt yok: `pending`) + özellik görünümü (kayıt varsayılanları).
    // Yerel kip: `platform: false`, izinler `all` (bütün yetkiler açık).
    const fresh = {
      setup: PENDING_SETUP,
      features: { registry: Object.values(FEATURES), effective: effectiveFeatures({}), explicit: {} },
      platform: false,
      access: { edit: true, spend: true, manage: true },
    };
    expect((await t.api("GET", "/api/org")).json).toEqual({ org: { id: orgs[0]!.id, name: "Firmam" }, ...fresh });
    const r = await t.api("PATCH", "/api/org", { name: "  GiftUpStore " });
    expect(r.status, r.body).toBe(200);
    expect(r.json).toEqual({ org: { id: orgs[0]!.id, name: "GiftUpStore" }, ...fresh });
    expect((await t.api("PATCH", "/api/org", { name: "" })).status).toBe(400);
    expect((await t.api("PATCH", "/api/org", { name: "A", id: "baska" })).status).toBe(400);
    expect((await t.api("PATCH", "/api/org", { name: "A" }, { "x-studio": "" })).status).toBe(403);
    expect(t.ctx.orgs.get(orgs[0]!.id)?.name).toBe("GiftUpStore");
  });

  it("ikinci açılışta yeni firma açılmaz", async () => {
    t = await makeApp();
    const dir = t.dir;
    const id = t.ctx.orgs.defaultOrgId();
    await t.app.close();
    const again = await makeApp({ dir });
    t = undefined;
    try {
      expect(again.ctx.orgs.list().map((o) => o.id)).toEqual([id]);
    } finally {
      await again.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("varsayılan olmayan firmayla (TAGPRESS_ORG) iki kipte de açılır; istekler o firmada", async () => {
    t = await makeApp();
    const dir = t.dir;
    const b = t.ctx.orgs.create({ name: "B" }).id;
    await t.app.close();
    t = undefined;
    const saved = process.env.TAGPRESS_ORG;
    process.env.TAGPRESS_ORG = b;
    try {
      for (const tenancy of ["strict", "audit"] as const) {
        const app = await makeApp({ dir, tenancy });
        try {
          expect(app.ctx.tenancy.mode).toBe(tenancy);
          expect((await app.api("GET", "/api/org")).json.org).toEqual({ id: b, name: "B" });
        } finally {
          await app.app.close();
        }
      }
    } finally {
      if (saved === undefined) delete process.env.TAGPRESS_ORG;
      else process.env.TAGPRESS_ORG = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bilinmeyen TAGPRESS_ORG ile açılmaz", async () => {
    const saved = process.env.TAGPRESS_ORG;
    const dir = mkdtempSync(path.join(os.tmpdir(), "studio-test-"));
    process.env.TAGPRESS_ORG = "yok-boyle-firma";
    try {
      await expect(makeApp({ dir })).rejects.toThrow(/TAGPRESS_ORG bilinmeyen firma: yok-boyle-firma/);
    } finally {
      if (saved === undefined) delete process.env.TAGPRESS_ORG;
      else process.env.TAGPRESS_ORG = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("firma bağlamı: istek kancası", () => {
  it("istek boyunca (JSON gövdeli POST dahil) firma bağlamı vardır; firma ayarı geçerli firmaya yazılır", async () => {
    // Kayıt varsayılanlarıyla (sahibin özellik kaydı yazılmaz): firma ayarlarında yalnız istekle yazılan kalır.
    t = await makeApp({ features: "registry" });
    const org = t.ctx.orgs.defaultOrgId()!;
    t.app.post("/api/_deneme/firma", async (req) => {
      await new Promise((r) => setTimeout(r, 2));
      return { org: currentOrg().orgId, body: req.body };
    });
    const r = await t.api("POST", "/api/_deneme/firma", { a: 1 });
    expect(r.json).toEqual({ org, body: { a: 1 } });

    expect((await t.api("PATCH", "/api/settings", { variantsPerRun: 2 })).status).toBe(200);
    const rows = t!.raw.all("SELECT org_id, key FROM org_settings");
    expect(rows).toEqual([{ org_id: org, key: "app" }]);
    expect(installValue(t, "app")).toBeNull();
  });

  it("ayarlar firmaya göre: B'nin ayarı A'nınkini değiştirmez", async () => {
    t = await makeApp({ resolver: headerResolver(() => t!.ctx.orgs.defaultOrgId()!) });
    const b = t.ctx.orgs.create({ name: "B" }).id;
    await t.api("PATCH", "/api/settings", { variantsPerRun: 3 }, { "x-test-org": b });
    expect((await t.api("GET", "/api/settings", undefined, { "x-test-org": b })).json.settings.variantsPerRun).toBe(3);
    expect((await t.api("GET", "/api/settings")).json.settings.variantsPerRun).toBe(1);
    expect((await t.api("GET", "/api/org", undefined, { "x-test-org": b })).json.org).toEqual({ id: b, name: "B" });
  });
});

describe("olay yolu ve SSE", () => {
  it("bağlamsız yayın: iki kipte de hata (test/geliştirme), üretimde düşer ve sayılır; varsayılan firmaya gitmez", () => {
    for (const mode of ["strict", "audit"] as const) {
      const bus = new EventBus(new Tenancy({ mode }));
      expect(() => bus.emit({ type: "settings" }), mode).toThrow(OrgContextError);
      expect(() => maintenance(() => bus.emit({ type: "settings" })), mode).toThrow(OrgContextError);
      const got: [string, string][] = [];
      bus.subscribe((e, org) => got.push([e.type, org]));
      runInOrg("b", () => bus.emit({ type: "settings" }));
      expect(got, mode).toEqual([["settings", "b"]]);

      const prodTenancy = new Tenancy({ mode });
      const prod = new EventBus(prodTenancy, { production: true });
      const prodGot: string[] = [];
      prod.subscribe((_e, org) => prodGot.push(org));
      expect(() => prod.emit({ type: "settings" })).not.toThrow();
      expect(prodGot).toEqual([]);
      expect(prodTenancy.audit.list()).toEqual([{ kind: "no-context", site: "events.emit:settings (düştü)", count: 1 }]);
    }
  });

  it("varsayılan kip sıkı; denetim kipi yalnız TAGPRESS_TENANCY=audit ile", () => {
    const saved = process.env.TAGPRESS_TENANCY;
    try {
      const cases: [string | undefined, string][] = [
        [undefined, "strict"],
        ["", "strict"],
        ["strict", "strict"],
        ["siki", "strict"],
        ["audit", "audit"],
        [" audit ", "audit"],
      ];
      for (const [v, want] of cases) {
        if (v === undefined) delete process.env.TAGPRESS_TENANCY;
        else process.env.TAGPRESS_TENANCY = v;
        expect(loadConfig().tenancy, String(v)).toBe(want);
      }
    } finally {
      if (saved === undefined) delete process.env.TAGPRESS_TENANCY;
      else process.env.TAGPRESS_TENANCY = saved;
    }
  });

  it("SSE yalnız isteğin firmasının olaylarını yazar", async () => {
    t = await makeApp({ resolver: headerResolver(() => t!.ctx.orgs.defaultOrgId()!) });
    const a = t.ctx.orgs.defaultOrgId()!;
    const b = t.ctx.orgs.create({ name: "B" }).id;
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = t.app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const ctl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: ctl.signal, headers: { "x-test-org": b } });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    await reader.read(); // retry satırı
    const all: ServerEvent[] = [];
    t.ctx.events.subscribe((e) => all.push(e));
    runInOrg(a, () => t!.ctx.events.emit({ type: "job", jobId: "a-isi" }));
    runInOrg(b, () => t!.ctx.events.emit({ type: "job", jobId: "b-isi" }));
    runInOrg(a, () => t!.ctx.events.emit({ type: "language", languageId: "a-dili" }));
    runInOrg(b, () => t!.ctx.events.emit({ type: "settings" }));
    let buf = "";
    while (!buf.includes("event: settings")) buf += dec.decode((await reader.read()).value);
    ctl.abort();
    expect(buf).toContain('"jobId":"b-isi"');
    expect(buf).not.toContain("a-isi");
    expect(buf).not.toContain("a-dili");
    expect(all).toHaveLength(4); // sunucu içi dinleyici hepsini görür
  });
});

describe("dosya kökleri", () => {
  it("düzen 1: varsayılan (eski kökün sahibi) firma veri klasöründe, diğerleri firmalar/<id>; düzen 2: herkes firmalar/<id>", async () => {
    t = await makeApp();
    const a = t.ctx.orgs.defaultOrgId()!;
    const b = t.ctx.orgs.create({ name: "B" }).id;
    expect(runInOrg(a, () => t!.ctx.paths.previews)).toBe(path.join(t.dir, "onizleme"));
    expect(runInOrg(b, () => t!.ctx.paths.templates("dil"))).toBe(path.join(t.dir, "firmalar", b, "diller", "dil", "sablonlar"));
    expect(runInOrg(b, () => t!.ctx.paths.root)).toBe(path.join(t.dir, "firmalar", b));
    expect(t.ctx.paths.db).toBe(path.join(t.dir, "studio.db"));
    expect(runInOrg(b, () => t!.ctx.paths.sharedFonts)).toBe(path.join(t.dir, "ortak", "fontlar"));

    t.ctx.settings.setInstall("files.layout", 2);
    t.ctx.roots.reload();
    expect(runInOrg(a, () => t!.ctx.paths.references("dil"))).toBe(path.join(t.dir, "firmalar", a, "referanslar", "dil"));
    expect(() => t!.ctx.roots.rootOf("../kacis")).toThrow(/Geçersiz firma kimliği/);
    expect(() => t!.ctx.roots.rootOf("A/B")).toThrow(/Geçersiz firma kimliği/);
    for (const reserved of ["con", "NUL", "aux", "prn", "com1", "LPT9"]) expect(() => t!.ctx.roots.rootOf(reserved), reserved).toThrow(/Geçersiz firma kimliği/);
    // UUID büyük-küçük harf duyarsız: aynı klasör.
    const upper = "0197A000-0000-7000-8000-00000000ABCD";
    expect(t.ctx.roots.rootOf(upper)).toBe(path.join(t.dir, "firmalar", upper.toLowerCase()));
    expect(() => t!.ctx.roots.rootOf("Eski-Ad")).toThrow(/Geçersiz firma kimliği/);
  });
});

describe("yapay zekâ anahtarı: ortam değişkenine düşme yok", () => {
  // YAPAY-ZEKA-GECIDI §6 (TP-AI): ortamdaki sağlayıcı anahtarına hiçbir kipte düşülmez; eski `install.productKey` açması da
  // artık etkisizdir (yerel kipte yalnız kayıtlı anahtar, platform kipinde yalnız geçit).
  it("kayıtlı anahtar yokken ortamdaki anahtar kullanılmaz; install.productKey true olsa da", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ortamdaki-anahtar";
    try {
      t = await makeApp();
      expect(t.ctx.secrets.source).toBe("local");
      expect(t.ctx.secrets.get("anthropic")).toBeNull();
      t.ctx.settings.setInstall("install.productKey", "true");
      expect(t.ctx.secrets.get("anthropic")).toBeNull();
      t.ctx.settings.setInstall("install.productKey", true);
      expect(t.ctx.secrets.get("anthropic")).toBeNull();
      // Kayıtlı anahtar her zaman önce gelir.
      t.ctx.secrets.set("anthropic", "sk-kayitli-anahtar");
      expect(t.ctx.secrets.get("anthropic")).toBe("sk-kayitli-anahtar");
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe("uuidv7", () => {
  it("biçim, zaman damgası ve aynı süreçte artan sıra", () => {
    const now = Date.parse("2026-11-21T12:00:00.000Z");
    const ids = Array.from({ length: 5000 }, () => uuidv7(now));
    expect(ids.every(isUuidv7)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(uuidv7Time(ids[0]!)).toBe(now);
    expect(uuidv7Time(uuidv7(now - 10_000))).toBeGreaterThanOrEqual(now); // saat geri giderse sıra bozulmaz
  });
});
