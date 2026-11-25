import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ProfileSchema, emptyProfile } from "@tagpress/domain";
import { afterEach, describe, expect, it } from "vitest";
import { productionPorts } from "./adapters/index.ts";
import { FontRegistryCache, createFontCatalog, createFontCoverage } from "./adapters/fonts.ts";
import { templatesResolver } from "./adapters/templates.ts";
import { TEST_FALLBACK_FONTS_DIR, TEST_FONTS_DIR } from "@tagpress/typeset/testing";
import { type TestApp, makeApp, png, seedLanguage } from "./test/helpers.ts";

const sizes = emptyProfile("x").output.sizes;

describe("templates paketi adaptörü", () => {
  let t: TestApp;
  afterEach(() => t?.close());

  it("şablon çözümü: bilinen anahtar, boyut, bilinmeyen anahtar + öneriler, profilde olmayan boyut", () => {
    const keys = ["a1", "a15", "12"];
    expect(templatesResolver.resolve("A01 5,2 cm", { keys, sizes })).toMatchObject({ key: "a1", size: "5.2", unknownSize: null });
    expect(templatesResolver.resolve("(2.5) 12", { keys, sizes })).toMatchObject({ key: "12", size: "2.5" });
    const unknown = templatesResolver.resolve("a16", { keys, sizes });
    expect(unknown.key).toBe("a16");
    expect(unknown.suggestions).toContain("a15");
    expect(templatesResolver.resolve("a1 4.5", { keys, sizes })).toMatchObject({ key: "a1", unknownSize: "4.5" });
  });

  it("içe aktarma ve şablon bindirmesi gerçek paketle çalışır", async () => {
    t = await makeApp({ ports: productionPorts() });
    const lang = await seedLanguage(t);
    const dir = t.inOrg(() => t.ctx.paths.templates(lang));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "b1.png"), await png(840, 840, { r: 255, g: 255, b: 255, alpha: 1 }));
    await t.inOrg(() => t.ctx.templates.sync(lang));
    const p = await t.api("POST", "/api/import/preview", { content: JSON.stringify([{ siparis: "1", etiket: "B-01 3.8", adet: 1, text: "Anna" }, { siparis: "2", etiket: "a16", adet: 1, text: "x" }]) });
    expect(p.json.rows[0]).toMatchObject({ templateKey: "b1", labelSize: "3.8", issues: [] });
    expect(p.json.rows[1].issues[0]).toMatchObject({ code: "template-unknown" });
    const ov = await t.api("GET", `/api/languages/${lang}/templates/b1/overlay.png`);
    expect(ov.status, ov.body.slice(0, 200)).toBe(200);
    expect(ov.headers["content-type"]).toBe("image/png");
  });
});

describe("typeset adaptörü (gerçek fontlar)", () => {
  // Depodaki açık lisanslı font fikstürü: dil klasörü + ortak yedek klasörü (Noto Naskh Arabic, Twemoji).
  const lang = TEST_FONTS_DIR;
  const shared = TEST_FALLBACK_FONTS_DIR;
  const profile = ProfileSchema.parse({
    name: "x",
    fonts: { list: [{ id: "Great Vibes/Regular", family: "Great Vibes", style: "Regular", kind: "script", roles: ["primary"], file: "GreatVibes-Regular.ttf" }] },
  });

  it("kapsam: yedek fonta düşenler bilgi, hiçbir fontta olmayan hata; kayıt önbellekten gelir", () => {
    const cache = new FontRegistryCache(shared, () => [lang], false);
    const cov = createFontCoverage(cache);
    const ctx = { languageId: "x", profile, fontsDir: lang, sharedFontsDir: shared };
    const r = cov.check("Anna مريم \u{E000}", ctx);
    expect(r.fallback).toEqual(expect.arrayContaining(["م"]));
    expect(r.missing).toEqual(["\u{E000}"]);
    expect(cov.check("Anna & Marco", ctx)).toEqual({ fallback: [], missing: [] });
    expect(cache.forProfile(lang, profile)).toBe(cache.forProfile(lang, profile));
    // Profil font listesi değişince yeni kayıt.
    const other = ProfileSchema.parse({ ...profile, fonts: { list: [...profile.fonts.list, { id: "Alex Brush/Regular", family: "Alex Brush", style: "Regular", kind: "script", file: "AlexBrush-Regular.ttf" }] } });
    expect(cache.forProfile(lang, other)).not.toBe(cache.forProfile(lang, profile));
  });

  it("katalog: ad çözümü, örnek görsel", async () => {
    const cache = new FontRegistryCache(shared, () => [lang], false);
    const cat = createFontCatalog();
    expect(await cat.describe(path.join(lang, "GreatVibes-Regular.ttf"))).toEqual({ family: "Great Vibes", style: "Regular" });
    expect(await cat.describe(path.join(lang, "yok.ttf"))).toBeNull();
    const png = await cat.specimen!(path.join(lang, "GreatVibes-Regular.ttf"), "Anna & Marco", 48);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(cache.resolveFace("Great Vibes", "Regular")?.id).toBe("Great Vibes/Regular");
    expect(cache.resolveFace("Olmayan Font", "Regular")).toBeNull();
  });
});
