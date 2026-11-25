import { describe, expect, it } from "vitest";
import {
  CSS_PX_PER_MM,
  MM_PER_INCH,
  PAPER_SIZES,
  PT_PER_INCH,
  mmToPt,
  mmToPx,
  paperSizeId,
  ptToMm,
  pxToMm,
} from "./units.ts";
import { PrintCutSchema } from "./print.ts";
import { ProfileSchema, ptToPx, stickerSheetAreaMm } from "./profile.ts";

describe("birimler (tek kaynak)", () => {
  it("inç, pt, CSS pikseli ve dpi çevirileri", () => {
    expect(MM_PER_INCH).toBe(25.4);
    expect(PT_PER_INCH).toBe(72);
    expect(ptToMm(72)).toBe(25.4);
    expect(mmToPt(210)).toBeCloseTo(595.28, 2); // A4 genişliği pt
    expect(mmToPx(25.4, 300)).toBe(300);
    expect(pxToMm(300, 300)).toBe(25.4);
    expect(CSS_PX_PER_MM * 25.4).toBeCloseTo(96, 9);
  });

  it("kağıt ölçüleri ve kimlik", () => {
    expect(PAPER_SIZES.a4).toEqual({ wMm: 210, hMm: 297 });
    expect(paperSizeId({ wMm: 210, hMm: 297 })).toBe("a4");
    expect(paperSizeId({ wMm: 215.9, hMm: 279.4 })).toBe("letter");
    // Eski eklentinin 595 × 842 pt'si A4 sayılmaz (0,1 mm dar): kimliksiz.
    expect(paperSizeId({ wMm: ptToMm(595), hMm: ptToMm(842) })).toBeNull();
  });

  it("kesim varsayılanları mm: çizgi 0,25, taşma 0, kayıt işareti 10 / 5 / 0,5", () => {
    expect(PrintCutSchema.parse({})).toMatchObject({ outlineWidthMm: 0.25, bleedMm: 0, registration: { insetMm: 10, sizeMm: 5, thicknessMm: 0.5 } });
  });

  it("sticker yazı alanı pt → mm; puntonun tasarım pikseli 3,8 cm etiketle", () => {
    expect(stickerSheetAreaMm({ shape: "circle", maxW: 108, maxH: 50 })).toEqual({ wMm: ptToMm(108), hMm: ptToMm(108) });
    expect(stickerSheetAreaMm({ shape: "rect", maxW: 130, maxH: 96 }).hMm).toBeCloseTo(33.87, 2);
    const p = ProfileSchema.parse({ name: "x" });
    // 38 mm = 440 px → 1 pt (0,3528 mm) = 4,085 px.
    expect(ptToPx(p, 1)).toBeCloseTo((25.4 / 72) * (440 / 38), 9);
  });
});
