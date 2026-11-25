import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FontEntrySchema } from "@tagpress/domain";
import { BUNDLED_FONTS_DIR, FontRegistry, colorLayers, runPathData, runToSvg, shapeRun } from "./index.ts";
import { TEST_FALLBACK_FONTS_DIR, TEST_FONTS_DIR } from "./testing.ts";

/**
 * Emoji ve sembol yedekleri. Uygulamayla gelen yedek fontlar (`packages/typeset/fonts`) sayesinde emoji, sembol ve
 * süslü yazı sistem fontuna ve kullanıcının ortak klasörüne bağlı olmadan basılır (Linux sunucu, yeni kurulum).
 */

const ZWJ = "\u200D";
const GV = "Great Vibes/Regular";
const entries = [{ id: GV, family: "Great Vibes", file: "GreatVibes-Regular.ttf", kind: "script", roles: ["primary"], lockTracking: true }].map((e) => FontEntrySchema.parse(e));

/** Yeni kurulum: ortak yedek klasörü yok, sistem fontu yok; yalnız uygulamayla gelenler. */
const fresh = () => FontRegistry.createSync({ entries, fontDir: TEST_FONTS_DIR, systemFallbacks: false });

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

/** Sahte "sistem" klasörü: içine sistem yedeği adıyla (Windows Segoe UI Symbol) verilen font kopyalanır. */
function fakeSystemDir(from: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tagpress-sistem-"));
  tmp.push(dir);
  copyFileSync(from, path.join(dir, "seguisym.ttf"));
  return dir;
}

/** Kümeyi verilen fontla basınca .notdef (boş kutu) çıkıyor mu? */
function notdef(reg: FontRegistry, fontId: string, g: string): number {
  return shapeRun(reg, g, { fontId, sizePx: 40 }).notdef;
}

describe("uygulamayla gelen yedek fontlar (yeni kurulum, sistem fontu yok)", () => {
  it("emoji, sembol ve süslü yazı basılabilir; hiçbiri boş kutu değil", () => {
    const reg = fresh();
    const cases: Array<[string, string]> = [
      ["❤️", "Twemoji"],
      ["🙏🏽", "Twemoji"],
      ["✨", "Twemoji"],
      ["🇹🇷", "Twemoji"],
      ["🎂", "Twemoji"],
      [`👨${ZWJ}👩${ZWJ}👧`, "Twemoji"],
      ["1️⃣", "Twemoji"],
      ["★", "Noto Sans Symbols 2"],
      ["✿", "Noto Sans Symbols 2"],
      ["♥", "Noto Sans Symbols 2"],
      ["☾", "Noto Sans Symbols"],
      ["∞", "Great Vibes"],
      ["⇒", "Noto Sans Math"],
      ["𝓔", "Noto Sans Math"],
      ["𝐊", "Noto Sans Math"],
      ["Ａ", "M PLUS 1p"],
      ["ᴇ", "Noto Sans"],
      ["E̶", "Great Vibes"], // süs çizgisi (U+0336) tasarım fontunda var
      ["ɢ", "Noto Sans"],
      ["Ⓐ", "Noto Sans Symbols"],
    ];
    for (const [g, family] of cases) {
      const r = reg.resolve(g, GV);
      expect(r, g).not.toBeNull();
      expect(reg.get(r!.fontId).family, g).toBe(family);
      expect(notdef(reg, r!.fontId, g), g).toBe(0);
    }
  });

  it("Arapça yeni kurulumda da basılır (uygulamayla gelen Noto Naskh Arabic), bağlı harflerle", () => {
    const reg = fresh();
    const r = reg.resolve("م", GV);
    expect(r && reg.get(r.fontId).family).toBe("Noto Naskh Arabic");
    const run = shapeRun(reg, "مرحبا", { fontId: r!.fontId, sizePx: 40 });
    expect(run.notdef).toBe(0);
  });

  it("güncel emojiler (2023 sonrası) uygulamayla gelen Twemoji'de tek parça ve renkli", () => {
    const reg = fresh();
    const Z = ZWJ;
    const cases = [
      "🩷", // Unicode 15.0
      "🪿",
      `🐦${Z}🔥`, // 15.1
      `🙂${Z}↕️`,
      "🫩", // 16.0
      "🇹🇷",
      `❤️${Z}🔥`, // seçicili ZWJ dizisi
      `🏳️${Z}🌈`,
      "1️⃣",
      "#️⃣",
      "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
      `👩🏽${Z}❤️${Z}👨🏻`,
    ];
    for (const g of cases) {
      const r = reg.resolve(g, GV);
      expect(r, g).not.toBeNull();
      expect(reg.get(r!.fontId).family, g).toBe("Twemoji");
      expect(r, g).toMatchObject({ partial: false, monochrome: false });
      const run = shapeRun(reg, g, { fontId: r!.fontId, sizePx: 40 });
      expect(run.notdef, g).toBe(0);
      expect(run.glyphs.filter((x) => x.advance > 0).length, g).toBe(1);
      expect(colorLayers(reg, r!.fontId, run.glyphs.find((x) => x.advance > 0)!.gid)?.length, g).toBeGreaterThanOrEqual(1);
    }
  });

  it("emoji fontunun boş (çizimsiz) glifi seçilmez: tuş kapaksız \"1️\" rakam olarak basılır", () => {
    const reg = fresh();
    expect(reg.resolve("1️", GV)).toMatchObject({ fontId: GV, fallback: false });
    // Emoji fontu boşluk basmaz (1 em genişliğindeki boşluğu emojileri birbirinden uzaklaştırıp küçültürdü);
    // emojiler arasındaki boşluk satırın tasarım fontundan gelir.
    const id = reg.resolve("🎉", GV)!.fontId;
    expect(reg.covers(id, " ")).toBe(false);
  });

  it("hiçbir fontta olmayan karakter null (silinmez, çağıran raporlar)", () => {
    expect(fresh().resolve("𓀀", GV)).toBeNull();
  });

  it("emoji sunumlu küme tasarım fontunda olsa da renkli emoji fontuna gider; seçicisiz sembol tasarım fontunda kalır", () => {
    const reg = fresh();
    expect(reg.covers(GV, "©")).toBe(true);
    expect(reg.resolve("©", GV)).toMatchObject({ fontId: GV, fallback: false });
    const emoji = reg.resolve("©️", GV)!;
    expect(emoji.fallback).toBe(true);
    expect(reg.get(emoji.fontId).color).toBe(true);
    // Metin seçicili (U+FE0E) kalp renkli olmaz; seçicisiz kalp renkli (kullanıcı kararı); süs sembolleri tek renk.
    expect(reg.get(reg.resolve("❤︎", GV)!.fontId).color).toBe(false);
    expect(reg.resolve("❤", GV)).toMatchObject({ fallback: true, monochrome: false });
    expect(reg.get(reg.resolve("❤", GV)!.fontId).color).toBe(true);
    for (const g of ["♥", "★", "✿", "☾"]) expect(reg.get(reg.resolve(g, GV)!.fontId).color, g).toBe(false);
  });

  it("ZWJ dizisini fontta tek parça yoksa parçalı (partial) bildirir; tam olanı bildirmez", () => {
    const reg = fresh();
    // Unicode'da olmayan (font yapımcısının birleştirmediği) ZWJ dizisi: bileşenler yan yana basılır.
    expect(reg.resolve(`🐱${ZWJ}🚀`, GV)).toMatchObject({ fallback: true, partial: true, monochrome: false });
    expect(reg.resolve(`👨${ZWJ}👩${ZWJ}👧`, GV)).toMatchObject({ fallback: true, partial: false });
    expect(reg.resolve("🇹🇷", GV)!.partial).toBe(false);
  });

  it("emoji renkli katmanlarla çizilir", () => {
    const reg = fresh();
    for (const g of ["❤️", "🙏🏽", "🇹🇷", "1️⃣"]) {
      const id = reg.resolve(g, GV)!.fontId;
      const run = shapeRun(reg, g, { fontId: id, sizePx: 40 });
      const visible = run.glyphs.filter((x) => x.advance > 0);
      expect(visible.length, g).toBe(1);
      const layers = colorLayers(reg, id, visible[0]!.gid);
      expect(layers?.length, g).toBeGreaterThanOrEqual(1);
      expect(layers!.some((l) => l.color && !/^rgba\(0,0,0,/.test(l.color)), g).toBe(true);
    }
  });

  it("renkli glifin mürekkep kutusu katmanlarından ölçülür; maske (tek renk) çiziminde de görünür", () => {
    const reg = fresh();
    const id = reg.resolve("❤️", GV)!.fontId;
    const run = shapeRun(reg, "❤️", { fontId: id, sizePx: 100 });
    expect(run.ink).not.toBeNull();
    expect(run.ink!.x1 - run.ink!.x0).toBeGreaterThan(50);
    expect(run.ink!.y1 - run.ink!.y0).toBeGreaterThan(50);
    expect(runPathData(reg, run, 0, 100)).toMatch(/\d/);
    expect(runToSvg(reg, run, 0, 100, { color: "#000", monochrome: true })).toMatch(/<path d="M/);
  });

  it("yedek fontlar uygulamanın içinde", () => {
    expect(BUNDLED_FONTS_DIR).toBe(path.resolve(import.meta.dirname, "..", "fonts"));
  });
});

describe("yedek zinciri belirlenimci", () => {
  it("sonuç, sistem yedeklerinin daha önce yüklenip yüklenmediğine bağlı değil", () => {
    // Sahte sistem fontu: yazı sembolü yedeği (☀ U+2600'ü siyah basar; test Twemoji alt kümesi renkli basar).
    const sys = fakeSystemDir(path.join(BUNDLED_FONTS_DIR, "NotoSansSymbols2-Regular.ttf"));
    const make = () => FontRegistry.createSync({ entries, fontDir: TEST_FONTS_DIR, fallbackDirs: [TEST_FALLBACK_FONTS_DIR], bundledFallbacks: false, systemFontDirs: [sys] });
    const a = make();
    const first = a.fallbackFor("☀");
    const b = make();
    expect(b.fallbackFor("𓀀")).toBeNull(); // sistem yedeklerini yükletir
    expect(b.fallbackFor("☀")).toBe(first);
    // Seçicisiz ☀ metin sunumludur: yazı yedeği (renksiz) önce gelir.
    expect(a.get(first!).color).toBe(false);
  });

  it("seçicisiz ❤ her iki yükleme sırasında da renkli emoji fontuyla basılır", () => {
    const sys = fakeSystemDir(path.join(BUNDLED_FONTS_DIR, "NotoSansSymbols2-Regular.ttf"));
    const make = () => FontRegistry.createSync({ entries, fontDir: TEST_FONTS_DIR, fallbackDirs: [TEST_FALLBACK_FONTS_DIR], bundledFallbacks: false, systemFontDirs: [sys] });
    const a = make();
    const first = a.fallbackFor("❤")!;
    const b = make();
    expect(b.fallbackFor("𓀀")).toBeNull();
    expect(b.fallbackFor("❤")).toBe(first);
    expect(a.get(first).color).toBe(true);
  });

  it("aynı aileden iki yedek font: kimlikler ayrı, her biri kendi dosyasıyla basar", () => {
    // Test klasöründeki Twemoji Mozilla alt kümesinin (🎂 yok) kopyası ikinci klasörde: aynı aile, ayrı kimlik ve dosya.
    const second = mkdtempSync(path.join(os.tmpdir(), "tagpress-ortak2-"));
    tmp.push(second);
    copyFileSync(path.join(TEST_FALLBACK_FONTS_DIR, "Twemoji.Mozilla.ttf"), path.join(second, "Kopya.ttf"));
    const reg = FontRegistry.createSync({ entries, fontDir: TEST_FONTS_DIR, fallbackDirs: [TEST_FALLBACK_FONTS_DIR, second], systemFallbacks: false });
    expect(reg.fallbackFor("😀")).toBe("Twemoji Mozilla/Regular");
    expect(reg.has("Twemoji Mozilla/Regular (2)")).toBe(true);
    expect(path.basename(reg.get("Twemoji Mozilla/Regular (2)").file)).toBe("Kopya.ttf");
    // Alt kümede olmayan emoji uygulamayla gelen tam Twemoji'den, kendi dosyasıyla basılır.
    const id = reg.fallbackFor("🎂")!;
    expect(reg.get(id).family).toBe("Twemoji");
    expect(notdef(reg, id, "🎂")).toBe(0);
  });


  it("dış hatsız (bitmap/boş) font yedek olarak kullanılmaz, sorun olarak bildirilir", () => {
    const reg = FontRegistry.createSync({ fallbackDirs: [path.join(TEST_FONTS_DIR, "bozuk-yedek")], bundledFallbacks: false, systemFallbacks: false });
    expect(reg.fallbackFor("❤️")).toBeNull();
    expect(reg.problems.join(" ")).toMatch(/DenemeBitmapEmoji\.ttf/);
  });
});
