import { describe, expect, it } from "vitest";
import { ProfileSchema } from "@tagpress/domain";
import { TEST_FALLBACK_FONTS_DIR, TEST_FONTS_DIR } from "@tagpress/typeset/testing";
import { FontRegistryCache, createFontCoverage } from "./adapters/fonts.ts";
import { textIssues } from "./services/import/text-checks.ts";

/** İçe aktarmada emoji, sembol ve süslü yazı: metin hiçbir adımda kendiliğinden değişmez; sorunlar görünür, düzeltme öneridir. */

const ZWJ = "\u200D";
const profile = ProfileSchema.parse({
  name: "x",
  fonts: { list: [{ id: "Great Vibes/Regular", family: "Great Vibes", style: "Regular", kind: "script", roles: ["primary"], file: "GreatVibes-Regular.ttf" }] },
});
const lang = TEST_FONTS_DIR;
const shared = TEST_FALLBACK_FONTS_DIR;
const cov = createFontCoverage(new FontRegistryCache(shared, () => [lang], false));
const ctx = { languageId: "x", profile, fontsDir: lang, sharedFontsDir: shared };
const check = (text: string) => textIssues(text, profile, cov.check(text, ctx));

describe("içe aktarma: emoji ve semboller", () => {
  it("emoji ve sembol sorun sayılmaz; yalnız yedek fontla basılacağı bilgisi", () => {
    for (const text of ["Elif ❤️ Kerem", "Teşekkürler 🙏🏽✨", "🇹🇷 İyi ki doğdun 🎂", `Aile 👨${ZWJ}👩${ZWJ}👧`, "★ El yapımı ★", "1️⃣", "🎉🎂🎈"]) {
      const issues = check(text);
      expect(issues.filter((i) => i.severity !== "info").map((i) => `${i.code}: ${i.message}`), text).toEqual([]);
      expect(issues.find((i) => i.code === "text-fallback-font")?.severity, text).toBe("info");
    }
  });

  it("fontta tek parça olmayan emoji uyarıyla bildirilir", () => {
    const w = check(`Ali 🐱${ZWJ}🚀`).find((i) => i.severity === "warning" && i.code === "text-fallback-font");
    expect(w?.message).toContain(`🐱${ZWJ}🚀`);
  });

  it("yarım kalmış emoji (eşsiz vekil) hata olarak bildirilir", () => {
    const e = check("Elif \uD83C Kerem").find((i) => i.code === "text-unprintable");
    expect(e?.severity).toBe("error");
    expect(e?.message).toMatch(/yarım/i);
  });

  it("bozuk kodlama (UTF-8 yanlış okunmuş) bulunur; düzeltme öneridir, metin değişmez", () => {
    const original = "Teşekkürler ❤️ 🙏";
    const broken = Buffer.from(original, "utf8").toString("latin1");
    const issues = check(broken);
    const fix = issues.flatMap((i) => i.fixes).find((f) => f.label === "Kodlamayı düzelt");
    expect(fix?.value).toBe(original);
    // Windows-1252 ile okunmuş hâli de (Ÿ, ™ gibi): "TeÅŸekkÃ¼rler".
    expect(check("TeÅŸekkÃ¼rler").flatMap((i) => i.fixes).find((f) => f.label === "Kodlamayı düzelt")?.value).toBe("Teşekkürler");
    // Doğru metinde öneri yok.
    expect(check("Café Ümit").flatMap((i) => i.fixes).some((f) => f.label === "Kodlamayı düzelt")).toBe(false);
  });

  it("� (yerine geçen karakter) uyarı verir", () => {
    expect(check("Elif � Kerem").some((i) => i.severity === "warning" && /bozuk/i.test(i.message))).toBe(true);
  });

  it("kaçışlı yazılmış emoji (\\u2764, &#x1F382;) bulunur; çözülmüş hâli öneri", () => {
    const a = check("Elif \\u2764\\ufe0f Kerem \\ud83c\\udf82").flatMap((i) => i.fixes).find((f) => f.label === "Kaçışları çöz");
    expect(a?.value).toBe("Elif ❤️ Kerem 🎂");
    const b = check("Doğum günün kutlu olsun &#x1F382; &#127881;").flatMap((i) => i.fixes).find((f) => f.label === "Kaçışları çöz");
    expect(b?.value).toBe("Doğum günün kutlu olsun 🎂 🎉");
  });
});

describe("içe aktarma: süslü yazı", () => {
  it("iki yol sunulur: düz harfe çevir (öneri) ya da olduğu gibi bas; metin kendiliğinden değişmez", () => {
    for (const [text, plain] of [
      ["𝓔𝓵𝓲𝓯 ❤️ 𝐊𝐞𝐫𝐞𝐦", "Elif ❤️ Kerem"],
      ["ᴇʟɪꜰ", "elif"],
      ["E̶l̶i̶f̶", "Elif"],
      ["Ａｙşｅ", "Ayşe"],
    ] as const) {
      const i = check(text).find((x) => x.code === "text-unicode-styled");
      expect(i?.severity, text).toBe("warning");
      expect(i!.fixes.map((f) => f.label), text).toEqual(["Düz harfe çevir", "Olduğu gibi bas"]);
      expect(i!.fixes[0]).toMatchObject({ kind: "convert-unicode", value: plain });
      expect(i!.fixes[1]!.kind).toBe("dismiss");
      // Olduğu gibi basılabilir: hiçbir fontta olmayan karakter hatası yok.
      expect(check(text).map((x) => x.code), text).not.toContain("text-unprintable");
    }
  });

  it("emoji süslü yazı sayılmaz (Ⓜ️, 🅰️)", () => {
    expect(check("Ⓜ️ 🅰️ Anna").map((x) => x.code)).not.toContain("text-unicode-styled");
  });
});
