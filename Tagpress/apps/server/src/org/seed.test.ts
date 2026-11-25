import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DEFAULT_FONTS, DEFAULT_LANGUAGE_NAME, defaultProfile } from "@tagpress/domain";
import { FontRegistry } from "@tagpress/typeset";
import { afterEach, describe, expect, it } from "vitest";
import { PROJECT_ROOT, dataPaths } from "../config.ts";
import { openDatabase } from "../db/database.ts";
import { type TestApp, makeApp } from "../test/helpers.ts";
import { ManualClock } from "../util/clock.ts";
import { localOrg, runInOrg } from "./context.ts";
import type { OrgResolver } from "./resolver.ts";
import { OrgRoots } from "./roots.ts";
import { DEFAULT_CONTENT_DIR, OrgSeeder, readFontManifest, readTemplateManifest } from "./seed.ts";
import { OrgService } from "./service.ts";
import { TenantDb } from "./tenant-db.ts";
import { Tenancy } from "./tenancy.ts";
import { SettingsService } from "../services/settings.ts";

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const FONT_EXT = /\.(ttf|otf|woff2?|ttc)$/i;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

const fontDir = path.join(DEFAULT_CONTENT_DIR, "fontlar");
const tplDir = path.join(DEFAULT_CONTENT_DIR, "sablonlar");

describe("varsayılan içerik paketi (assets/varsayilan)", () => {
  it("paketteki her fontun yanında OFL ya da Apache lisans metni var; özet ve boyut kayıtla aynı", () => {
    const manifest = readFontManifest();
    const files = readdirSync(fontDir).filter((f) => FONT_EXT.test(f)).sort();
    expect(files).toEqual(manifest.fontlar.map((f) => f.file).sort());
    for (const f of manifest.fontlar) {
      const buf = readFileSync(path.join(fontDir, f.file));
      expect(sha256(buf), f.file).toBe(f.sha256);
      const license = readFileSync(path.join(fontDir, f.licenseFile), "utf8");
      if (f.license === "OFL-1.1") expect(license, f.licenseFile).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
      else expect(license, f.licenseFile).toMatch(/Apache License[\s\S]*Version 2\.0/);
      // Telif satırı lisansın başında (OFL bunu ister).
      expect(license.slice(0, 300), f.licenseFile).toMatch(/Copyright/);
    }
    // Profildeki her font pakette; pakette profilde olmayan font yok.
    expect(DEFAULT_FONTS.map((f) => f.file).sort()).toEqual(files);
  });

  it("fontlar Türkçe harfleri kapsar ve profil kimlikleriyle eşlenir", () => {
    const reg = FontRegistry.createSync({ entries: defaultProfile().fonts.list, fontDir });
    for (const f of DEFAULT_FONTS) {
      expect(reg.has(f.id), f.id).toBe(true);
      expect(reg.missing(f.id, "ğĞşŞıİöÖüÜçÇ âîû & 0123456789"), f.id).toEqual([]);
    }
  });

  it("şablonlar: kayıt listesi ve dosyalar eşleşir; her PNG'nin kaynak SVG'si var; lisans CC0", () => {
    const manifest = readTemplateManifest();
    const pngs = readdirSync(tplDir).filter((f) => f.endsWith(".png")).sort();
    expect(manifest.sablonlar.map((t) => t.file).sort()).toEqual(pngs);
    expect(pngs.length).toBeGreaterThanOrEqual(4);
    expect(pngs.length).toBeLessThanOrEqual(7);
    for (const t of manifest.sablonlar) expect(existsSync(path.join(tplDir, "kaynak", `${t.key}.svg`)), t.key).toBe(true);
    expect(readFileSync(path.join(tplDir, "LISANS.txt"), "utf8")).toMatch(/CC0 1\.0/);
  });

  it("sahibin data/ klasöründeki hiçbir dosyayı içermez (ad ve sha256)", () => {
    const assets = walk(DEFAULT_CONTENT_DIR);
    // Sahibin verisi (data/) yalnız sahibin makinesinde var; CI'da ya da temiz klonda yoktur. O zaman karşılaştırma boş
    // küme üzerinde geçer (test atlanmaz; paket yine de üretilmiş, kendi kaynaklı dosyalardan oluşmalı).
    const owner = walk(path.join(PROJECT_ROOT, "data"));
    const ownerNames = new Set(owner.map((f) => path.basename(f).toLowerCase()));
    const sameName = assets.filter((f) => ownerNames.has(path.basename(f).toLowerCase()));
    expect(sameName.map((f) => path.relative(DEFAULT_CONTENT_DIR, f))).toEqual([]);
    // İçerik: yalnız boyutu bir paket dosyasınınkine eşit olan sahip dosyaları özetlenir (veri klasörü büyük).
    const assetHashes = new Map(assets.map((f) => [sha256(readFileSync(f)), f]));
    const sizes = new Set(assets.map((f) => statSync(f).size));
    const sameContent = owner.filter((f) => sizes.has(statSync(f).size) && assetHashes.has(sha256(readFileSync(f))));
    expect(sameContent.map((f) => path.relative(PROJECT_ROOT, f))).toEqual([]);
  });
});

// ---------------------------------------------------------------- firma kurulumu

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** İsteğin firması `x-test-org` başlığından (yoksa varsayılan firma). */
const headerResolver = (fallback: () => string): OrgResolver => ({
  resolve: (req) => localOrg(String(req.headers["x-test-org"] ?? fallback())),
});

/** Uygulama bağlamının veritabanı ve kökleriyle, varsayılan içerik kuran firma servisi. */
function seededOrgs(app: TestApp, contentDir?: string) {
  const seeder = new OrgSeeder({ db: app.ctx.tdb, clock: app.clock, dataDir: app.dir, rootOf: (id) => app.ctx.roots.rootOf(id), ...(contentDir ? { contentDir } : {}) });
  return { seeder, orgs: new OrgService(app.ctx.tdb, app.clock, () => app.ctx.roots.reload(), seeder) };
}

/** Firmanın kiracı satırları (değişiklik denetimi için). */
function snapshot(app: TestApp, orgId: string) {
  return runInOrg(orgId, () => ({
    languages: app.ctx.tdb.prepare("SELECT * FROM languages WHERE org_id = $org ORDER BY id").all(),
    versions: app.ctx.tdb.prepare("SELECT * FROM profile_versions WHERE org_id = $org ORDER BY id").all(),
    templates: app.ctx.tdb.prepare("SELECT * FROM templates WHERE org_id = $org ORDER BY language_id, key").all(),
    settings: app.ctx.tdb.prepare("SELECT * FROM org_settings WHERE org_id = $org ORDER BY key").all(),
  }));
}

describe("yeni firma: varsayılan içerik", () => {
  it("dil v1 yayınlanmış ve varsayılan; şablonlar eşitlenmiş, fontlar ve lisansları dilin klasöründe; benim-tarzim görünmez", async () => {
    t = await makeApp({ resolver: headerResolver(() => t!.ctx.orgs.defaultOrgId()!) });
    const a = t.ctx.orgs.defaultOrgId()!;
    // Sahibin firması (A): kendi dili ve şablonu var.
    runInOrg(a, () => t!.ctx.languages.createWithTrustedId({ name: "GiftUpStore", id: "benim-tarzim" }));
    const before = snapshot(t, a);

    const { orgs } = seededOrgs(t);
    const b = orgs.create({ name: "Lavanta Atölye" }).id;
    const app = t;
    await runInOrg(b, async () => {
      const langs = app.ctx.languages.list();
      expect(langs).toHaveLength(1);
      const lang = langs[0]!;
      expect(lang).toMatchObject({ name: DEFAULT_LANGUAGE_NAME, activeVersion: 1, hasDraft: false, isDefault: true });
      expect(app.ctx.settings.get().defaultLanguageId).toBe(lang.id);
      expect(app.ctx.profiles.versions(lang.id)).toEqual([expect.objectContaining({ version: 1, status: "published", active: true })]);
      expect(app.ctx.profiles.activeProfile(lang.id).profile).toEqual(defaultProfile());

      const manifest = readTemplateManifest();
      const items = app.ctx.templates.list(lang.id);
      expect(items.map((i) => i.template.key).sort()).toEqual(manifest.sablonlar.map((s) => s.key).sort());
      expect(items.every((i) => !i.fileMissing)).toBe(true);
      expect(items.find((i) => i.template.key === "kurdele")!.template.ribbonTop).toBeGreaterThan(0);
      // Kesim şablon kaydına geçer: dikdörtgen ve kare kendi kesimini taşır, daire şablonları taşımaz.
      expect(items.find((i) => i.template.key === "urun-dikdortgen")!.template.cut).toEqual({ shape: "rect", wMm: 63.5, hMm: 38.1, radiusMm: 0 });
      expect(items.find((i) => i.template.key === "kare")!.template.cut).toEqual({ shape: "rect", wMm: 40, hMm: 40, radiusMm: 0 });
      expect(items.find((i) => i.template.key === "ince-kenar")!.template.cut).toBeNull();
      // Kayıttaki özet ve ölçü diskteki dosyayla aynı: açılıştaki eşitleme hiçbir şeyi değiştirmez.
      expect(await app.ctx.templates.sync(lang.id)).toEqual({ added: [], updated: [], missing: [] });
      for (const i of items) expect(existsSync(app.ctx.templates.imagePath(lang.id, i.template))).toBe(true);

      const fontFiles = readdirSync(app.ctx.paths.fonts(lang.id)).sort();
      for (const f of readFontManifest().fontlar) {
        expect(fontFiles).toContain(f.file);
        expect(fontFiles).toContain(path.basename(f.licenseFile));
      }
      const reg = FontRegistry.createSync({ entries: defaultProfile().fonts.list, fontDir: app.ctx.paths.fonts(lang.id) });
      expect(DEFAULT_FONTS.filter((f) => !reg.has(f.id))).toEqual([]);

      // Sahibin dili bu firmada yok (kimlikle de, listede de).
      expect(app.ctx.languages.exists("benim-tarzim", true)).toBe(false);
      expect(langs.map((l) => l.id)).not.toContain("benim-tarzim");
      // Dosyalar yeni firmanın kökünde (sahibin kökünde değil).
      expect(app.ctx.paths.fonts(lang.id).startsWith(path.join(app.dir, "firmalar", b))).toBe(true);
    });
    const listB = await t.api("GET", "/api/languages", undefined, { "x-test-org": b });
    expect(listB.json.languages.map((l: { name: string }) => l.name)).toEqual([DEFAULT_LANGUAGE_NAME]);
    expect(JSON.stringify(listB.json)).not.toContain("benim-tarzim");
    // Sahibin firması hiç etkilenmedi.
    expect(snapshot(t, a)).toEqual(before);
  });

  it("ikinci çağrıda hiçbir şey yapmaz; dili olan firmaya (sahip) hiç dokunmaz", async () => {
    t = await makeApp();
    const a = t.ctx.orgs.defaultOrgId()!;
    runInOrg(a, () => t!.ctx.languages.createWithTrustedId({ name: "GiftUpStore", id: "benim-tarzim" }));
    const { seeder, orgs } = seededOrgs(t);
    const b = orgs.create({ name: "B" }).id;
    const afterFirst = snapshot(t, b);
    const ownerBefore = snapshot(t, a);
    const files = walk(path.join(t.dir, "firmalar", b)).map((f) => [f, statSync(f).mtimeMs, statSync(f).size]);

    expect(seeder.seed(b)).toBeNull();
    expect(seeder.seed(a)).toBeNull();
    expect(snapshot(t, b)).toEqual(afterFirst);
    expect(snapshot(t, a)).toEqual(ownerBefore);
    expect(walk(path.join(t.dir, "firmalar", b)).map((f) => [f, statSync(f).mtimeMs, statSync(f).size])).toEqual(files);
    // Bütün dilleri silinmiş firma da "dili var" sayılır (yeniden kurulmaz).
    runInOrg(b, () => t!.ctx.languages.softDelete(t!.ctx.languages.list()[0]!.id));
    expect(seeder.seed(b)).toBeNull();
  });

  it("içerik kurulamazsa firma da açılmaz; yarım dil klasörü kalmaz", async () => {
    t = await makeApp();
    const broken = mkdtempSync(path.join(os.tmpdir(), "varsayilan-bozuk-"));
    try {
      cpSync(DEFAULT_CONTENT_DIR, broken, { recursive: true });
      rmSync(path.join(broken, "sablonlar", "kurdele.png"));
      const { orgs } = seededOrgs(t, broken);
      const count = t.ctx.orgs.list().length;
      expect(() => orgs.create({ name: "Bozuk" })).toThrow(/Varsayılan içerik eksik/);
      expect(t.ctx.orgs.list()).toHaveLength(count);
      expect(walk(path.join(t.dir, "firmalar"))).toEqual([]);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});

describe("taze kurulum (ensureLocal) varsayılan içerikle", () => {
  it("'Firmam' içerikle açılır (dosya düzeni 1: sahibin kökü veri klasörü); ikinci açılışta bir şey eklenmez", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "studio-seed-"));
    const open = () => {
      const raw = openDatabase(dataPaths(dir).db, { backupDir: null });
      const tenancy = new Tenancy({ mode: "strict" });
      const db = new TenantDb(raw, tenancy);
      const roots = new OrgRoots(dir, new SettingsService(db), tenancy);
      const clock = new ManualClock();
      const orgs = new OrgService(db, clock, () => roots.reload(), new OrgSeeder({ db, clock, dataDir: dir, rootOf: (id) => roots.rootOf(id) }));
      return { raw, db, orgs };
    };
    try {
      const first = open();
      const { org, created } = first.orgs.ensureLocal();
      expect(created).toBe(true);
      expect(org.name).toBe("Firmam");
      const langs = runInOrg(org.id, () => first.db.prepare("SELECT id, name FROM languages WHERE org_id = $org").all() as { id: string; name: string }[]);
      expect(langs.map((l) => l.name)).toEqual([DEFAULT_LANGUAGE_NAME]);
      const lang = langs[0]!.id;
      expect(existsSync(path.join(dir, "diller", lang, "sablonlar", "duz-daire.png"))).toBe(true);
      expect(existsSync(path.join(dir, "diller", lang, "fontlar", "Parisienne-Regular.ttf"))).toBe(true);
      expect(existsSync(path.join(dir, "firmalar"))).toBe(false);
      first.raw.close();

      const second = open();
      expect(second.orgs.ensureLocal()).toMatchObject({ created: false, org: { id: org.id } });
      expect(runInOrg(org.id, () => second.db.prepare("SELECT COUNT(*) AS n FROM languages WHERE org_id = $org").get())).toEqual({ n: 1 });
      second.raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pnpm firma (betik)", () => {
  it("ekle: geçici veri klasöründe firma + varsayılan içerik kurar; liste gösterir; adlandir; sil yok", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "studio-firma-"));
    const run = promisify(execFile);
    // tsx ile (sunucu kodu TypeScript); PORT=5499: deneme portu, uygulama açık mı denetimi gerçek uygulamaya çarpmaz.
    const firma = (...args: string[]) =>
      run(process.execPath, ["--import", "tsx", path.join(PROJECT_ROOT, "scripts", "firma.mjs"), ...args], {
        cwd: PROJECT_ROOT,
        env: { ...process.env, TAGPRESS_DATA_DIR: dir, PORT: "5499", TAGPRESS_ORG: "" },
      });
    try {
      const added = await firma("ekle", "Lavanta Atölye");
      const id = /Firma açıldı: ([0-9a-f-]{36})/.exec(added.stdout)?.[1];
      expect(id, added.stdout + added.stderr).toBeTruthy();
      expect((await firma("liste")).stdout).toContain(`${id}  Lavanta Atölye  (local`);
      expect((await firma("adlandir", id!, "Sabun Evi")).stdout).toContain("Sabun Evi");
      await expect(firma("sil", id!)).rejects.toMatchObject({ code: 2 });

      const raw = openDatabase(dataPaths(dir).db, { backupDir: null });
      try {
        const db = new TenantDb(raw, new Tenancy({ mode: "strict" }));
        const langs = runInOrg(id!, () => db.prepare("SELECT id, name FROM languages WHERE org_id = $org").all() as { id: string; name: string }[]);
        expect(langs.map((l) => l.name)).toEqual([DEFAULT_LANGUAGE_NAME]);
        const tpl = runInOrg(id!, () => db.prepare("SELECT COUNT(*) AS n FROM templates WHERE org_id = $org AND file_missing = 0").get());
        expect(tpl).toEqual({ n: readTemplateManifest().sablonlar.length });
        expect(db.install.prepare("SELECT name FROM orgs WHERE id = ?").get(id!)).toEqual({ name: "Sabun Evi" });
        const langDir = path.join(dir, "firmalar", id!, "diller", langs[0]!.id);
        expect(readdirSync(path.join(langDir, "fontlar")).filter((f) => FONT_EXT.test(f)).sort()).toEqual(DEFAULT_FONTS.map((f) => f.file!).sort());
      } finally {
        raw.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
