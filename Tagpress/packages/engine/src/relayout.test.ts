import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { type DesignIntent, type LayoutResult, type Profile, type TemplateGeometry, applyAdjustToLayout, boxCenter } from "@tagpress/domain";
import type { FontRegistry } from "@tagpress/typeset";
import { PARISIENNE, testFonts, userProfile } from "./fixtures.ts";
import { checkEdits, EditFontError, layout, lineBaseFont, makeTestGeometry, relayoutLine, renderTextOnly, resolveEdits, textLayerSvg } from "./index.ts";

const GV = "Great Vibes/Regular";
const PF = "Playfair Display/Regular";
const CZ = "Cinzel/Regular";
const intent: DesignIntent = {
  lines: [
    { text: "Anna", role: "name", tier: "primary", fontId: GV },
    { text: "& Marco", role: "name", tier: "primary", fontId: GV },
  ],
  rationale: "",
};

async function renderedInk(r: LayoutResult, fonts: FontRegistry, S = 2) {
  const png = await renderTextOnly(r, fonts, { scale: S, framePx: 440 });
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3]! < 128) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x + 1);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y + 1);
    }
  return { x: x0 / S, y: y0 / S, w: (x1 - x0) / S, h: (y1 - y0) / S };
}

describe("hafif düzeltme: elle metin/font (motor)", () => {
  let profile: Profile;
  let fonts: FontRegistry;
  let g: TemplateGeometry;
  let base: LayoutResult;

  beforeAll(async () => {
    profile = userProfile();
    fonts = await testFonts(profile);
    g = makeTestGeometry({ target: { x: 220, y: 210 } });
    base = await layout({ text: "Anna & Marco", intent, profile, geometry: g, fonts });
    expect(base.ok).toBe(true);
    // Asılı bağlaç ayrılır: "Anna" / "&" / "Marco".
    expect(base.lines.map((l) => l.text)).toEqual(["Anna", "&", "Marco"]);
  });

  it("satırın ana fontu glif kuralı run'larını saymaz (yalnızca & olan satırda komşu satırınki)", () => {
    expect(lineBaseFont(base, 0, profile, fonts)).toBe(GV);
    expect(base.lines[1]!.runs.map((r) => r.fontId)).toEqual(["IM FELL Great Primer SC/Regular"]);
    expect(lineBaseFont(base, 1, profile, fonts)).toBe(GV);
  });

  it("değişmeyen metin ve aynı font düşer; aynı metinle yeniden ölçüm özgün satırı verir", () => {
    const r = resolveEdits(base, [{ index: 0, text: " Anna " }, { index: 2, fontId: GV }], profile, fonts);
    expect(r.edits).toEqual([]);
    expect(r.layout).toBe(base);
    for (const i of [0, 1, 2]) {
      const same = relayoutLine(base, i, {}, profile, fonts).line;
      const old = base.lines[i]!;
      // Punto ve run puntoları 0,01'e yuvarlı saklandığı için kutu ±0,05 px.
      expect(same.x).toBeCloseTo(old.x, 1);
      for (const k of ["x", "y", "w", "h"] as const) expect(Math.abs(same.ink[k] - old.ink[k])).toBeLessThan(0.05);
      expect(same.runs.map((x) => [x.text, x.fontId])).toEqual(old.runs.map((x) => [x.text, x.fontId]));
    }
  });

  it("metin düzenleme: aynı punto ve taban çizgisi, ortalı hizada mürekkep merkezi korunur", () => {
    const r = resolveEdits(base, [{ index: 0, text: "Annabella" }], profile, fonts);
    expect(r.edits).toHaveLength(1);
    const p = r.edits[0]!.placed!;
    const old = base.lines[0]!;
    expect(p.text).toBe("Annabella");
    expect(p.runs.map((x) => x.text).join("")).toBe("Annabella");
    expect(p.sizePx).toBe(old.sizePx);
    expect(p.baselineY).toBe(old.baselineY);
    expect(p.ink.w).toBeGreaterThan(old.ink.w * 1.5);
    expect(boxCenter(p.ink).x).toBeCloseTo(boxCenter(old.ink).x, 1);
    // Glif kuralı (A → Alex Brush, yalnızca Great Vibes ile) yeni metinde de çalışır.
    expect(p.runs[0]!.fontId).toBe("Alex Brush/Regular");
    expect(r.layout.lines[1]).toBe(base.lines[1]);
    expect(r.layout.ink.w).toBeGreaterThanOrEqual(p.ink.w);
  });

  it("satır fontu ve parça fontu: glif kuralı yerinde, aile sayısı uyarısı (engellemez)", () => {
    const r = resolveEdits(base, [{ index: 2, fontId: PF }, { index: 0, spans: [{ start: 2, end: 4, fontId: CZ }] }], profile, fonts);
    expect(r.edits.map((e) => e.index)).toEqual([0, 2]);
    // "A" Great Vibes ile Alex Brush kuralına girer; "na" parçası Cinzel.
    expect(r.edits[0]!.placed!.runs.map((x) => [x.text, x.fontId])).toEqual([
      ["A", "Alex Brush/Regular"],
      ["n", GV],
      ["na", CZ],
    ]);
    expect(r.edits[0]!.placed!.baselineY).toBe(base.lines[0]!.baselineY);
    expect(new Set(r.edits[1]!.placed!.runs.map((x) => x.fontId))).toEqual(new Set([PF]));
    const c = checkEdits({ base, edited: r.layout, edits: r.edits, jobText: "Anna & Marco", profile });
    expect(c.textEdited).toBe(false);
    expect(c.issues.find((i) => i.code === "font-mixing")).toMatchObject({ severity: "warning", field: "adjust" });
    expect(c.issues.some((i) => i.severity === "error")).toBe(false);
  });

  it("kural fontu aynı zamanda satır fontuysa (kalp → ikinci el yazısı fontu) aile sayısına girer: satırı ona çevirmek uyarı verir", async () => {
    const p2 = userProfile({ glyphRules: [...profile.glyphRules, { id: "kalp", match: { type: "chars", chars: "♥" }, fontId: PARISIENNE }] as never });
    const b2 = await layout({ text: "Anna & Marco", intent, profile: p2, geometry: g, fonts });
    const r = resolveEdits(b2, [{ index: 0, fontId: PARISIENNE }], p2, fonts);
    expect(r.edits[0]!.placed!.runs.map((x) => x.fontId)).toEqual([PARISIENNE]);
    expect(lineBaseFont(r.layout, 0, p2, fonts)).toBe(PARISIENNE);
    const c = checkEdits({ base: b2, edited: r.layout, edits: r.edits, jobText: "Anna & Marco", profile: p2 });
    expect(c.issues.find((i) => i.code === "font-mixing")).toMatchObject({ severity: "warning" });
  });

  it("seçilemeyen font reddedilir (glif kuralı fontu, profilde olmayan)", () => {
    expect(() => resolveEdits(base, [{ index: 0, fontId: "Alex Brush/Regular" }], profile, fonts)).toThrow(EditFontError);
    expect(() => resolveEdits(base, [{ index: 0, spans: [{ start: 0, end: 2, fontId: "Yok/Regular" }] }], profile, fonts)).toThrow(EditFontError);
  });

  it("satır bölmesi değişip metin korunursa elle metin işareti yok; metin değişirse bilgi notu, metin hatası yok", async () => {
    const greet: DesignIntent = {
      lines: [
        { text: "Buon compleanno", role: "greeting", tier: "secondary", fontId: GV },
        { text: "Matteo", role: "name", tier: "primary", fontId: GV },
      ],
      rationale: "",
    };
    const gbase = await layout({ text: "Buon compleanno Matteo", intent: greet, profile, geometry: g, fonts });
    expect(gbase.lines).toHaveLength(2);
    const moved = resolveEdits(gbase, [{ index: 0, text: "Buon" }, { index: 1, text: "compleanno Matteo" }], profile, fonts);
    const a = checkEdits({ base: gbase, edited: moved.layout, edits: moved.edits, jobText: "Buon compleanno Matteo", profile });
    expect(a.textEdited).toBe(false);
    expect(a.linesChanged).toBe(true);
    expect(a.issues.some((i) => i.code === "text-edited" || i.code === "text-changed")).toBe(false);
    const typo = resolveEdits(base, [{ index: 2, text: "Marcó" }], profile, fonts);
    const b = checkEdits({ base, edited: typo.layout, edits: typo.edits, jobText: "Anna & Marco", profile });
    expect(b.textEdited).toBe(true);
    expect(b.effectiveText).toBe("Anna\n&\nMarcó");
    expect(b.issues.find((i) => i.code === "text-edited")).toMatchObject({ severity: "info", field: "adjust" });
    expect(b.issues.some((i) => i.code === "text-changed")).toBe(false);
  });

  it("fontta olmayan karakter yedek fontla basılır, silinmez", () => {
    const r = resolveEdits(base, [{ index: 0, text: "Anna ❤" }], profile, fonts);
    const p = r.edits[0]!.placed!;
    expect(p.runs.map((x) => x.text).join("")).toBe("Anna ❤");
    expect(p.runs.some((x) => x.fallback && x.text.includes("❤"))).toBe(true);
    const c = checkEdits({ base, edited: r.layout, edits: r.edits, jobText: "Anna & Marco", profile });
    expect(c.issues.find((i) => i.code === "text-fallback-font")?.message).toContain("❤");
  });

  it("düzenlenmiş + düzeltilmiş yerleşimin çizimi hesaplanan mürekkep kutusuyla örtüşür; yazı katmanı yeni metni taşır", async () => {
    const r = resolveEdits(base, [{ index: 0, text: "Annabella", fontId: PF }], profile, fonts);
    const adj = applyAdjustToLayout(base, { dx: 6, dy: -4, scale: 0.9, edits: r.edits }, { strokeAlign: profile.weight.align });
    expect(adj.lines[0]!.text).toBe("Annabella");
    const ink = await renderedInk(adj, fonts);
    expect(Math.abs(ink.x - adj.ink.x)).toBeLessThan(1.5);
    expect(Math.abs(ink.y - adj.ink.y)).toBeLessThan(1.5);
    expect(Math.abs(ink.w - adj.ink.w)).toBeLessThan(2.5);
    expect(Math.abs(ink.h - adj.ink.h)).toBeLessThan(2.5);
    const svg = textLayerSvg(r.layout, fonts, { profile });
    expect(svg).toContain('data-line="0"');
    expect(svg).toContain('data-line="1"');
  });
});
