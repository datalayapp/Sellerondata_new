import { describe, expect, it } from "vitest";
import {
  adjustedInk,
  adjustedLineInks,
  applyAdjustToLayout,
  boxCenter,
  centerAdjust,
  effectiveLineStroke,
  isIdentityAdjust,
  normalizeAdjust,
  stepScale,
  stepStroke,
  svgStrokeWidth,
  VariantAdjustSchema,
  applyLineEdits,
  editedInkLayout,
  editsKey,
  normalizeSpans,
  stripPlaced,
} from "./adjust.ts";
import type { LayoutResult } from "./layout.ts";

/** İki satırlı küçük yerleşim: blok mürekkep kutusu (100,100)-(300,180), merkez (200,140). */
function sample(): LayoutResult {
  const line = (i: number, text: string, x: number, w: number) => ({
    text,
    role: "name" as const,
    tier: "primary" as const,
    sizePx: 40,
    runs: [{ text, fontId: "F/R", family: "F", style: "R", sizePx: 40, baselineShiftPx: 2, fallback: false, trackingEm: 0 }],
    baselineY: 130 + i * 50,
    x,
    advance: w,
    ink: { x, y: 100 + i * 50, w, h: 30 },
  });
  return {
    ok: true,
    lines: [line(0, "Anna", 120, 160), line(1, "Marco", 100, 200)],
    basePx: 40,
    strokePx: 1,
    color: "#000",
    ink: { x: 100, y: 100, w: 200, h: 80 },
    fill: 0.9,
    score: { total: 80, parts: {} },
    issues: [],
    notes: [],
    ms: 1,
  };
}

describe("hafif düzeltme (adjust)", () => {
  it("şema: varsayılanlar, sınırlar, tekrarlanan satır", () => {
    expect(VariantAdjustSchema.parse({})).toEqual({ dx: 0, dy: 0, scale: 1 });
    expect(VariantAdjustSchema.safeParse({ scale: 1.6 }).success).toBe(false);
    expect(VariantAdjustSchema.safeParse({ scale: 0.49 }).success).toBe(false);
    expect(VariantAdjustSchema.safeParse({ dx: 501 }).success).toBe(false);
    expect(VariantAdjustSchema.safeParse({ lines: [{ index: 0, dx: 1 }, { index: 0, dy: 1 }] }).success).toBe(false);
    expect(VariantAdjustSchema.parse({ lines: [{ index: 1, dx: 2 }] }).lines).toEqual([{ index: 1, dx: 2, dy: 0, scale: 1 }]);
  });

  it("normalleştirme: yuvarlar, etkisiz satırları atar, kimlik → null", () => {
    expect(normalizeAdjust({ dx: 0, dy: 0, scale: 1 })).toBeNull();
    expect(normalizeAdjust({ dx: 0.001, dy: -0.001, scale: 1.00001, lines: [{ index: 0, dx: 0, dy: 0, scale: 1 }] })).toBeNull();
    expect(normalizeAdjust({ dx: 1.234, dy: -0, scale: 1.02, lines: [{ index: 2, dx: 1, dy: 0, scale: 1 }, { index: 0, dx: 0, dy: 0, scale: 1 }] })).toEqual({
      dx: 1.23,
      dy: 0,
      scale: 1.02,
      lines: [{ index: 2, dx: 1, dy: 0, scale: 1 }],
    });
    expect(isIdentityAdjust(null)).toBe(true);
  });

  it("kimlik düzeltmesi yerleşimi değiştirmez (aynı nesne)", () => {
    const l = sample();
    expect(applyAdjustToLayout(l, null)).toBe(l);
    expect(applyAdjustToLayout(l, { dx: 0, dy: 0, scale: 1 })).toBe(l);
  });

  it("kaydırma: bütün kutular ve taban çizgileri kayar, punto değişmez", () => {
    const r = applyAdjustToLayout(sample(), { dx: 10, dy: -5, scale: 1 });
    expect(r.ink).toEqual({ x: 110, y: 95, w: 200, h: 80 });
    expect(r.lines[0]!.x).toBe(130);
    expect(r.lines[0]!.baselineY).toBe(125);
    expect(r.lines[1]!.ink).toEqual({ x: 110, y: 145, w: 200, h: 30 });
    expect(r.lines[0]!.sizePx).toBe(40);
    expect(r.lines[0]!.text).toBe("Anna");
  });

  it("ölçek blok merkezine göre: merkez sabit, punto/kontur/taban kayması ölçeklenir", () => {
    const r = applyAdjustToLayout(sample(), { dx: 0, dy: 0, scale: 1.1 });
    expect(boxCenter(r.ink)).toEqual({ x: 200, y: 140 });
    expect(r.ink.w).toBeCloseTo(220, 5);
    expect(r.lines[0]!.sizePx).toBe(44);
    expect(r.lines[0]!.runs[0]!.sizePx).toBe(44);
    expect(r.lines[0]!.runs[0]!.baselineShiftPx).toBe(2.2);
    expect(r.lines[0]!.advance).toBe(176);
    expect(r.basePx).toBe(44);
    expect(r.strokePx).toBe(1.1);
    // p' = c0 + s(p − c0): satır başı x=120 → 200 + 1,1·(−80) = 112
    expect(r.lines[0]!.x).toBe(112);
    expect(r.lines[0]!.baselineY).toBe(129);
  });

  it("satır düzeltmesi önce, blok düzeltmesi sonra", () => {
    const a = { dx: 5, dy: 0, scale: 1, lines: [{ index: 1, dx: 0, dy: 10, scale: 0.5 }] };
    const inks = adjustedLineInks(sample(), a);
    // satır 1: merkez (200,165) etrafında 0,5 → (150,157.5,100,15) → +10 dy → +5 dx
    expect(inks[1]).toEqual({ x: 155, y: 167.5, w: 100, h: 15 });
    expect(inks[0]).toEqual({ x: 125, y: 100, w: 160, h: 30 });
    expect(adjustedInk(sample(), a)).toEqual({ x: 125, y: 100, w: 160, h: 82.5 });
    const r = applyAdjustToLayout(sample(), a);
    expect(r.lines[1]!.sizePx).toBe(20);
    expect(r.lines[0]!.sizePx).toBe(40);
    expect(r.basePx).toBe(40);
  });

  it("ortalama: yatay, dikey, tam; ölçek ve satırlar korunur", () => {
    const centers = { textCenter: { x: 220, y: 230 }, area: { x: 210, y: 210 }, cut: { x: 220, y: 220 } };
    const x = centerAdjust(sample(), centers, null, { axis: "x" });
    expect(x).toEqual({ dx: 20, dy: 0, scale: 1 });
    const both = centerAdjust(sample(), centers, { dx: 3, dy: 3, scale: 1.2 }, { axis: "both" });
    expect(boxCenter(adjustedInk(sample(), both))).toEqual({ x: 220, y: 230 });
    expect(both.scale).toBe(1.2);
    const cut = centerAdjust(sample(), centers, null, { axis: "y", target: "cut" });
    expect(cut).toEqual({ dx: 0, dy: 80, scale: 1 });
    // satır düzeltmesiyle de tam oturur
    const withLine = centerAdjust(sample(), centers, { dx: 0, dy: 0, scale: 1, lines: [{ index: 0, dx: 30, dy: 0, scale: 1 }] }, { axis: "both", target: "area" });
    const c = boxCenter(adjustedInk(sample(), withLine));
    expect(c.x).toBeCloseTo(210, 5);
    expect(c.y).toBeCloseTo(210, 5);
  });

  it("kalınlık: şema, normalleştirme, etkin kontur, mürekkep büyümesi, SVG genişliği", () => {
    expect(VariantAdjustSchema.safeParse({ strokePx: 21 }).success).toBe(false);
    expect(VariantAdjustSchema.safeParse({ lines: [{ index: 0, strokePx: -20 }] }).success).toBe(true);
    expect(normalizeAdjust({ dx: 0, dy: 0, scale: 1, strokePx: 0.001 })).toBeNull();
    expect(normalizeAdjust({ dx: 0, dy: 0, scale: 1, lines: [{ index: 1, dx: 0, dy: 0, scale: 1, strokePx: 0.504 }] })).toEqual({
      dx: 0, dy: 0, scale: 1, lines: [{ index: 1, dx: 0, dy: 0, scale: 1, strokePx: 0.5 }],
    });
    expect(isIdentityAdjust({ dx: 0, dy: 0, scale: 1, strokePx: 1 })).toBe(false);
    const a = { dx: 0, dy: 0, scale: 1.1, strokePx: 2, lines: [{ index: 1, dx: 0, dy: 0, scale: 0.5, strokePx: -1 }] };
    expect(effectiveLineStroke(sample(), a, 0)).toBe(3.1); // 1·1,1 + 2
    expect(effectiveLineStroke(sample(), a, 1)).toBe(1.55); // 1·1,1·0,5 + 2 − 1
    expect(effectiveLineStroke(sample(), { dx: 0, dy: 0, scale: 1, strokePx: -5 }, 0)).toBe(0);
    const r = applyAdjustToLayout(sample(), a);
    expect(r.lines.map((l) => l.strokePx)).toEqual([3.1, 1.55]);
    expect(r.strokePx).toBe(3.1);
    // Satır 0: 1,1 ölçekli kutu her yandan 3,1 − 1,1 = 2 büyür (dışa hiza), merkez korunur.
    const plain = adjustedLineInks(sample(), { ...a, strokePx: 0, lines: [] })[0]!;
    expect(r.lines[0]!.ink.w).toBeCloseTo(plain.w + 4, 2);
    expect(boxCenter(r.lines[0]!.ink).x).toBeCloseTo(boxCenter(plain).x, 2);
    // Ortada hiza: yarısı kadar.
    expect(applyAdjustToLayout(sample(), a, { strokeAlign: "center" }).lines[0]!.ink.w).toBeCloseTo(plain.w + 2, 2);
    expect(svgStrokeWidth(3, "outside", 1.5)).toBe(4);
    expect(svgStrokeWidth(3, "center")).toBe(3);
    expect(stepStroke(stepStroke(null, 0.5), 0.5, 1)).toEqual({ dx: 0, dy: 0, scale: 1, strokePx: 0.5, lines: [{ index: 1, dx: 0, dy: 0, scale: 1, strokePx: 0.5 }] });
    expect(stepStroke({ dx: 0, dy: 0, scale: 1, strokePx: 19.8 }, 1).strokePx).toBe(20);
  });

  it("ortalama ölçekten sonra da merkezi korur (ölçek merkez etrafında)", () => {
    const centers = { textCenter: { x: 230, y: 250 }, area: { x: 0, y: 0 }, cut: { x: 0, y: 0 } };
    const a = stepScale(centerAdjust(sample(), centers, null, { axis: "both" }), 0.02);
    expect(a.scale).toBe(1.02);
    expect(boxCenter(adjustedInk(sample(), a))).toEqual({ x: 230, y: 250 });
    expect(stepScale({ dx: 0, dy: 0, scale: 1.49 }, 0.02).scale).toBe(1.5);
    expect(stepScale(null, -0.02).scale).toBe(0.98);
  });
});

describe("hafif düzeltme: elle metin/font düzenlemesi (edits)", () => {
  const placed = (text: string, x: number, w: number) => ({
    text,
    role: "name" as const,
    tier: "primary" as const,
    sizePx: 40,
    runs: [{ text, fontId: "G/R", family: "G", style: "R", sizePx: 40, baselineShiftPx: 0, fallback: false, trackingEm: 0 }],
    baselineY: 130,
    x,
    advance: w,
    ink: { x, y: 100, w, h: 30 },
  });

  it("şema: boş/çok satırlı metin, ters parça, tekrarlanan satır reddedilir", () => {
    expect(VariantAdjustSchema.safeParse({ edits: [{ index: 0, text: "  " }] }).success).toBe(false);
    expect(VariantAdjustSchema.safeParse({ edits: [{ index: 0, text: "a\nb" }] }).success).toBe(false);
    expect(VariantAdjustSchema.safeParse({ edits: [{ index: 0, spans: [{ start: 3, end: 3, fontId: "X" }] }] }).success).toBe(false);
    expect(VariantAdjustSchema.safeParse({ edits: [{ index: 0, text: "A" }, { index: 0, fontId: "X" }] }).success).toBe(false);
    expect(VariantAdjustSchema.parse({ edits: [{ index: 1, text: "Anna" }] }).edits).toEqual([{ index: 1, text: "Anna" }]);
  });

  it("normalleştirme: etkisiz düzenleme atılır, düzenleme tek başına kimlik değildir, parçalar birleşir", () => {
    expect(normalizeAdjust({ dx: 0, dy: 0, scale: 1, edits: [{ index: 0 }] })).toBeNull();
    expect(isIdentityAdjust({ dx: 0, dy: 0, scale: 1, edits: [{ index: 0, fontId: "X" }] })).toBe(false);
    const n = normalizeAdjust({
      dx: 0,
      dy: 0,
      scale: 1,
      edits: [{ index: 1, text: "Marcoo", spans: [{ start: 0, end: 2, fontId: "A" }, { start: 2, end: 4, fontId: "A" }, { start: 3, end: 9, fontId: "B" }] }],
    });
    expect(n?.edits).toEqual([{ index: 1, text: "Marcoo", spans: [{ start: 0, end: 3, fontId: "A" }, { start: 3, end: 6, fontId: "B" }] }]);
    // Satırın fontuyla aynı fontlu parça etkisizdir.
    expect(normalizeAdjust({ dx: 0, dy: 0, scale: 1, edits: [{ index: 0, fontId: "A", spans: [{ start: 0, end: 2, fontId: "A" }] }] })?.edits).toEqual([{ index: 0, fontId: "A" }]);
    expect(normalizeSpans([{ start: 0, end: 5, fontId: "A" }, { start: 1, end: 2, fontId: "B" }], 4)).toEqual([
      { start: 0, end: 1, fontId: "A" },
      { start: 1, end: 2, fontId: "B" },
      { start: 2, end: 4, fontId: "A" },
    ]);
  });

  it("anahtar ve placed: anahtar placed'i görmez; stripPlaced atar", () => {
    const e = [{ index: 0, text: "Ana", placed: placed("Ana", 120, 100) }];
    expect(editsKey(e)).toBe(editsKey([{ index: 0, text: "Ana" }]));
    expect(editsKey(e)).not.toBe(editsKey([{ index: 0, text: "Anna" }]));
    expect(stripPlaced(e)).toEqual([{ index: 0, text: "Ana" }]);
  });

  it("uygulama: düzenlenen satır yerine geçer, blok merkezi düzenlenmemiş yerleşiminki kalır, metin/font notu düşer", () => {
    const base = sample();
    const edit = { index: 0, text: "Annabella", placed: placed("Annabella", 80, 240) };
    const only = applyLineEdits(base, [edit]);
    expect(only.lines[0]!.text).toBe("Annabella");
    expect(only.ink).toEqual({ x: 80, y: 100, w: 240, h: 80 });
    // placed'siz düzenleme yok sayılır.
    expect(applyLineEdits(base, [{ index: 0, text: "X" }])).toBe(base);
    // Ölçek blok merkezinin (200,140) etrafında: düzenleme olsa da merkez değişmez.
    const r = applyAdjustToLayout(base, { dx: 0, dy: 0, scale: 1.5, edits: [edit] });
    expect(r.lines[0]!.text).toBe("Annabella");
    expect(r.lines[0]!.ink.x).toBeCloseTo(200 + 1.5 * (80 - 200), 5);
    expect(r.lines[1]!.ink.x).toBeCloseTo(200 + 1.5 * (100 - 200), 5);
    expect(r.notes).toContain("Satır metni elle düzenlendi.");
    const f = applyAdjustToLayout(base, { dx: 0, dy: 0, scale: 1, edits: [{ index: 1, fontId: "G/R", placed: placed("Marco", 90, 220) }] });
    expect(f.notes).toContain("Font elle değiştirildi.");
    expect(f.lines[1]!.runs[0]!.fontId).toBe("G/R");
    // Yerleşimin satır konturu korunur.
    expect(effectiveLineStroke(f, null, 1)).toBe(1);
  });

  it("istemci karşılığı: editedInkLayout kutuları değiştirir, origin sabit", () => {
    const m = { ink: { x: 100, y: 100, w: 200, h: 80 }, lines: [{ index: 0, text: "Anna", sizePx: 40, ink: { x: 120, y: 100, w: 160, h: 30 } }, { index: 1, text: "Marco", sizePx: 40, ink: { x: 100, y: 150, w: 200, h: 30 } }] };
    const e = editedInkLayout(m, [{ index: 0, text: "Annabella", placed: placed("Annabella", 80, 240) }]);
    expect(e.origin).toEqual({ x: 200, y: 140 });
    expect(e.lines[0]).toMatchObject({ index: 0, text: "Annabella", ink: { x: 80, y: 100, w: 240, h: 30 } });
    expect(e.ink).toEqual({ x: 80, y: 100, w: 240, h: 80 });
    expect(boxCenter(adjustedInk(e, { dx: 0, dy: 0, scale: 1 }))).toEqual({ x: 200, y: 140 });
  });
});
