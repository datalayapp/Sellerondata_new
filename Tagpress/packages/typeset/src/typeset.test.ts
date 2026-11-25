import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { FontEntrySchema } from "@tagpress/domain";
import { FontRegistry, isEmojiGrapheme, runToSvg, shapeRun, strokeOutset } from "./index.ts";
import { TEST_FALLBACK_FONTS_DIR, TEST_FONTS_DIR } from "./testing.ts";

const entries = [
  { id: "Great Vibes/Regular", family: "Great Vibes", file: "GreatVibes-Regular.ttf", kind: "script", roles: ["primary"], lockTracking: true },
  { id: "Playfair Display/Regular", family: "Playfair Display", file: "PlayfairDisplay[wght].ttf", kind: "serif", roles: ["primary"] },
  { id: "Nunito Özel/Regular", family: "Nunito", kind: "sans", roles: ["primary"] },
  { id: "Yok/Regular", family: "Yok", kind: "sans", roles: ["primary"] },
].map((e) => FontEntrySchema.parse(e));

describe("typeset", () => {
  let reg: FontRegistry;
  beforeAll(async () => {
    reg = await FontRegistry.create({ entries, fontDir: TEST_FONTS_DIR, fallbackDirs: [TEST_FALLBACK_FONTS_DIR], systemFallbacks: false });
  });

  it("profil girdilerini dosyalara eşler; tür ve kilit profilden gelir", () => {
    const gv = reg.get("Great Vibes/Regular");
    expect(gv.kind).toBe("script");
    expect(gv.lockTracking).toBe(true);
    expect(gv.upem).toBe(1000);
    expect(gv.capHeight).toBeGreaterThan(0);
    // Dosya adı verilmeyen girdi aile adından eşlenir; variable fontta Regular örneği (wght 400).
    expect(reg.get("Nunito Özel/Regular").weight).toBe(400);
    expect(reg.get("Nunito Özel/Regular").family).toBe("Nunito");
    expect(reg.has("Yok/Regular")).toBe(false);
    expect(reg.problems.some((p) => p.includes("Yok/Regular"))).toBe(true);
    // Profil dışı dosya yüzlerinde tür yok (ad tahmini yapılmaz).
    expect(reg.get("Original Surfer/Regular").kind).toBeNull();
  });

  it("variable fontta daha ağır stil bulunur; ağırı olmayan fontta null", () => {
    expect(reg.heavier("Playfair Display/Regular")?.style).toBe("Bold");
    expect(reg.heavier("Great Vibes/Regular")).toBeNull();
  });

  it("şekillendirme: ilerleme ve mürekkep kutusu doğrusal ölçeklenir; kerning uygulanır", () => {
    const a = shapeRun(reg, "Anna", { fontId: "Playfair Display/Regular", sizePx: 10 });
    const b = shapeRun(reg, "Anna", { fontId: "Playfair Display/Regular", sizePx: 20 });
    expect(b.advance).toBeCloseTo(2 * a.advance, 6);
    expect(b.ink!.x1).toBeCloseTo(2 * a.ink!.x1, 6);
    expect(a.ink!.y0).toBeLessThan(0); // y aşağı pozitif: harf taban çizgisinin üstünde
    expect(a.notdef).toBe(0);
    // "AV" çifti kerning ile glif ilerlemelerinin toplamından dar.
    const av = shapeRun(reg, "AV", { fontId: "Playfair Display/Regular", sizePx: 100 });
    const sum = shapeRun(reg, "A", { fontId: "Playfair Display/Regular", sizePx: 100 }).advance + shapeRun(reg, "V", { fontId: "Playfair Display/Regular", sizePx: 100 }).advance;
    expect(av.advance).toBeLessThan(sum);
  });

  it("mürekkep kutusu konturlardan: raster mürekkebiyle 1 px içinde örtüşür", async () => {
    for (const [font, text] of [["Great Vibes/Regular", "Anna gy"], ["Playfair Display/Regular", "Qualità"]] as const) {
      const r = shapeRun(reg, text, { fontId: font, sizePx: 100 });
      const ox = 50, base = 150;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300">${runToSvg(reg, r, ox, base, { color: "#000" })}</svg>`;
      const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let y = 0; y < info.height; y++)
        for (let x = 0; x < info.width; x++)
          if (data[(y * info.width + x) * 4 + 3]! > 0) {
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x + 1);
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y + 1);
          }
      expect(Math.abs(x0 - (ox + r.ink!.x0))).toBeLessThan(1.5);
      expect(Math.abs(x1 - (ox + r.ink!.x1))).toBeLessThan(1.5);
      expect(Math.abs(y0 - (base + r.ink!.y0))).toBeLessThan(1.5);
      expect(Math.abs(y1 - (base + r.ink!.y1))).toBeLessThan(1.5);
    }
  });

  it("harf aralığı em cinsinden; lockTracking fontta uygulanmaz", () => {
    const p0 = shapeRun(reg, "abc", { fontId: "Playfair Display/Regular", sizePx: 50 });
    const p1 = shapeRun(reg, "abc", { fontId: "Playfair Display/Regular", sizePx: 50, trackingEm: 0.1 });
    expect(p1.advance - p0.advance).toBeCloseTo(2 * 5, 6); // iki aralık × 0,1 em × 50 px
    const g0 = shapeRun(reg, "abc", { fontId: "Great Vibes/Regular", sizePx: 50 });
    const g1 = shapeRun(reg, "abc", { fontId: "Great Vibes/Regular", sizePx: 50, trackingEm: 0.1 });
    expect(g1.advance).toBeCloseTo(g0.advance, 6);
  });

  it("yedek zinciri grafem bazında: Arapça yazı yedeğine, emoji emoji fontuna; basılamayan null", () => {
    expect(reg.covers("Great Vibes/Regular", "م")).toBe(false);
    expect(reg.fallbackFor("م")).toBe("Noto Naskh Arabic/Regular");
    expect(isEmojiGrapheme("❤️")).toBe(true);
    expect(reg.fallbackFor("❤️")).toBe("Twemoji Mozilla/Regular");
    expect(reg.fallbackFor("🇹🇷")).toBe("Twemoji Mozilla/Regular");
    expect(reg.fallbackFor("𓀀")).toBeNull();
    expect(reg.missing("Great Vibes/Regular", "Ali 😀")).toEqual(["😀"]);
  });

  it("Arapça RTL şekillenir (bağlı harfler, .notdef yok)", () => {
    const r = shapeRun(reg, "مرحبا", { fontId: "Noto Naskh Arabic/Regular", sizePx: 40 });
    expect(r.notdef).toBe(0);
    expect(r.glyphs.length).toBeGreaterThan(0);
    expect(r.advance).toBeGreaterThan(0);
  });

  it("emoji renkli katmanlarla çizilir, kontur almaz", () => {
    const r = shapeRun(reg, "❤️", { fontId: "Twemoji Mozilla/Regular", sizePx: 40 });
    const svg = runToSvg(reg, r, 0, 40, { color: "#000", stroke: { widthPx: 2, align: "outside" } });
    expect(svg).toMatch(/fill="rgba\(/);
  });

  it("kontur çıkıntısı: dışa = genişlik, ortada = yarısı", () => {
    expect(strokeOutset(2, "outside")).toBe(2);
    expect(strokeOutset(2, "center")).toBe(1);
    expect(strokeOutset(0, "outside")).toBe(0);
    const r = shapeRun(reg, "A", { fontId: "Playfair Display/Regular", sizePx: 40 });
    expect(runToSvg(reg, r, 0, 40, { color: "#123", stroke: { widthPx: 1.5, align: "outside" } })).toContain('stroke-width="3"');
  });
});
