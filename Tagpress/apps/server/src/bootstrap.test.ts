import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TemplateItem } from "@tagpress/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInOrg } from "./org/context.ts";
import { type TestApp, makeApp, png } from "./test/helpers.ts";
import { isUuidv7 } from "./util/ids.ts";

const ref = (id: string, split: "train" | "test") => ({
  id,
  languageId: "eski-dil",
  source: "migrated",
  orderNo: "1",
  quantity: 1,
  templateKey: "1",
  labelFramePx: 440,
  text: "Anna",
  user: [{ text: "Anna", family: "Great Vibes", style: "Regular", sizePx: 30, segments: [], ink: { x: 1, y: 2, w: 3, h: 4 } }],
  program: null,
  programMeta: null,
  image: null,
  split,
  createdAt: "2026-01-01T00:00:00.000Z",
});

/** Aktarım paketi biçiminde sahte paket. */
async function writePackage(dir: string) {
  const base = path.join(dir, "aktarim", "eski-dil");
  mkdirSync(path.join(base, "sablonlar"), { recursive: true });
  const img = await png(84, 84);
  writeFileSync(path.join(base, "sablonlar", "1.png"), img);
  const { sha1 } = await import("./util/files.ts");
  writeFileSync(
    path.join(base, "paket.json"),
    JSON.stringify({
      language: { id: "eski-dil", name: "Eski tarz" },
      profile: { name: "Eski tarz", sizing: { fill: 0.86 } },
      templates: [
        { key: "1", languageId: "eski-dil", file: "1.png", hash: sha1(img), width: 84, height: 84, textCenter: { x: 0.5, y: 0.41 }, imageBox: null, notes: "çiçek", figma: { nodeId: "271:2483", name: "1" } },
        { key: "2", languageId: "eski-dil", file: "2.png", hash: "", width: 84, height: 84 },
      ],
      calibration: { fonts: {} },
      createdAt: "2026-10-09",
      source: { system: "Etiket-Generator" },
    }),
  );
  writeFileSync(path.join(base, "kalibrasyon.json"), JSON.stringify({ _aciklama: {}, fonts: { "Great Vibes/Regular": { figmaAsc: 0.46, lineDyEm: 0.006, lineDxEm: 0, lineSamples: 20 } } }));
  writeFileSync(path.join(base, "referanslar.json"), JSON.stringify([ref("r1", "train"), ref("r2", "test"), { bozuk: true }]));
}

describe("ilk açılış içe alımı", () => {
  let t: TestApp | undefined;
  let dir: string;
  const KEYS = ["TAGPRESS_BOOTSTRAP", "STUDIO_BOOTSTRAP"] as const;
  const saved = KEYS.map((k) => process.env[k]);
  beforeEach(() => {
    delete process.env.STUDIO_BOOTSTRAP;
    process.env.TAGPRESS_BOOTSTRAP = "1";
  });
  afterEach(async () => {
    await t?.close();
    t = undefined;
    rmSync(dir, { recursive: true, force: true });
    KEYS.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  });

  it("ayar kapalıyken (varsayılan) paket içe alınmaz", async () => {
    delete process.env.TAGPRESS_BOOTSTRAP;
    dir = mkdtempSync(path.join(os.tmpdir(), "studio-aktar-"));
    await writePackage(dir);
    t = await makeApp({ dir });
    expect(t.ctx.config.bootstrapPackages).toBe(false);
    expect(t.ctx.bootstrap).toEqual({ imported: [], errors: [] });
    expect((await t.api("GET", "/api/languages")).json.languages).toEqual([]);
  });

  it("eski ad (STUDIO_BOOTSTRAP=1) da kabul edilir (geriye uyum)", async () => {
    delete process.env.TAGPRESS_BOOTSTRAP;
    process.env.STUDIO_BOOTSTRAP = "1";
    dir = mkdtempSync(path.join(os.tmpdir(), "studio-aktar-"));
    await writePackage(dir);
    t = await makeApp({ dir });
    expect(t.ctx.config.bootstrapPackages).toBe(true);
    expect(t.ctx.bootstrap!.imported.map((x) => x.languageId)).toEqual(["eski-dil"]);
  });

  it("yalnız firmanın kendi aktarim/ klasörü: B'nin paketi B'ye, A'nınki A'ya; kimlik başka firmada doluysa yeni kimlik", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "studio-aktar-"));
    await writePackage(dir); // varsayılan firma (A, dosya düzeni 1: kök = veri klasörü)
    t = await makeApp({ dir });
    const a = t.ctx.orgs.defaultOrgId()!;
    expect(t.ctx.bootstrap!.imported.map((x) => x.languageId)).toEqual(["eski-dil"]);
    const b = t.ctx.orgs.create({ name: "B" }).id;
    await t.close();
    t = undefined;
    // B'nin kökü `firmalar/<b>`: aynı paket (aynı dil kimliği) B'nin klasörüne konur.
    await writePackage(path.join(dir, "firmalar", b));
    t = await makeApp({ dir });
    const imported = t.ctx.bootstrap!.imported;
    expect(imported).toHaveLength(1);
    const bLang = imported[0]!.languageId;
    expect(bLang).not.toBe("eski-dil");
    expect(isUuidv7(bLang)).toBe(true);
    expect(imported[0]).toMatchObject({ templates: 2, references: 2 });
    const app = t;
    const inB = runInOrg(b, () => ({ langs: app.ctx.languages.list().map((l) => l.id), refs: app.ctx.references.list().length, flag: app.ctx.settings.getValue("imported:eski-dil", null) }));
    expect(inB.langs).toEqual([bLang]);
    expect(inB.refs).toBe(2);
    expect(inB.flag).not.toBeNull();
    expect(existsSync(runInOrg(b, () => path.join(app.ctx.paths.templates(bLang), "1.png")))).toBe(true);
    const inA = runInOrg(a, () => ({ langs: app.ctx.languages.list().map((l) => l.id), refs: app.ctx.references.list().length }));
    expect(inA).toEqual({ langs: ["eski-dil"], refs: 2 });
  });

  it("paket bir kez içe alınır: dil + yayınlanmış profil + şablonlar + referanslar (eski paketteki font kalibrasyonu yok sayılır)", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "studio-aktar-"));
    await writePackage(dir);
    t = await makeApp({ dir });
    const b = t.ctx.bootstrap!;
    expect(b.errors).toEqual([]);
    expect(b.imported[0]).toMatchObject({ languageId: "eski-dil", templates: 2, references: 2 });
    expect(b.imported[0]!.warnings[0]).toMatch(/Referans atlandı/);
    const langs = (await t.api("GET", "/api/languages")).json.languages;
    expect(langs).toMatchObject([{ id: "eski-dil", activeVersion: 1, isDefault: true, templateCount: 2 }]);
    const profile = (await t.api("GET", "/api/languages/eski-dil/profile")).json;
    expect(profile).toMatchObject({ status: "published", note: "Eski sistemden aktarıldı", data: { sizing: { fill: 0.86 } } });
    const tpls = (await t.api("GET", "/api/languages/eski-dil/templates")).json.templates;
    expect(tpls.map((x: TemplateItem) => [x.template.key, x.fileMissing])).toEqual([["1", false], ["2", true]]);
    expect(tpls[0].template).toMatchObject({ textCenter: { x: 0.5, y: 0.41 }, imageBox: null, notes: "çiçek", provenance: [] });
    // Eski paketteki şablonun Figma bağlantısı kayda yazılmaz.
    expect(tpls[0].template).not.toHaveProperty("figma");
    const stored = t.raw.get("SELECT data FROM templates WHERE key = '1'") as { data: string };
    expect(JSON.parse(stored.data)).not.toHaveProperty("figma");
    expect(JSON.parse(stored.data)).toMatchObject({ notes: "çiçek" });
    // Paketteki kalibrasyon (eski eklentinin ölçümü) okunmaz: tutulacak tablo da uç da yok.
    const tables =
      t.dialect === "pg"
        ? "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'tagpress' AND (table_name LIKE '%figma%' OR table_name LIKE '%calibration%')"
        : "SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%figma%' OR name LIKE '%calibration%'";
    expect((t.raw.get(tables) as { n: number }).n).toBe(0);
    expect((await t.api("GET", "/api/figma/calibration")).status).toBe(404);
    expect((await t.api("GET", "/api/references?languageId=eski-dil")).json.references).toHaveLength(2);
    await t.close();

    // Yeniden açılış: tekrar içe alınmaz; silinen dil geri gelmez.
    t = await makeApp({ dir });
    expect(t.ctx.bootstrap!.imported).toEqual([]);
    const del = await t.api("DELETE", "/api/languages/eski-dil");
    expect(del.status).toBe(200);
    await t.close();
    t = await makeApp({ dir });
    expect(t.ctx.bootstrap!.imported).toEqual([]);
    expect((await t.api("GET", "/api/languages")).json.languages).toEqual([]);
  });

  it("bozuk paket açılışı engellemez, hata raporlanır", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "studio-aktar-"));
    mkdirSync(path.join(dir, "aktarim", "bozuk"), { recursive: true });
    writeFileSync(path.join(dir, "aktarim", "bozuk", "paket.json"), "{ bozuk");
    t = await makeApp({ dir });
    expect(t.ctx.bootstrap!.errors[0]).toMatch(/^bozuk:/);
    expect((await t.api("GET", "/api/health")).json.ok).toBe(true);
  });
});
