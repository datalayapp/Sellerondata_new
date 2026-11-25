import { describe, expect, it } from "vitest";
import { ProfileSchema, type StickerSheet, StickerSheetSchema, cutDiameter } from "@tagpress/domain";
import { buildStickerGeometry, stickerAreaShape } from "./index.ts";

const profile = ProfileSchema.parse({ name: "x" });
const sheet = (o: Partial<StickerSheet>): StickerSheet =>
  StickerSheetSchema.parse({ id: "s", frameName: "S", maxW: 130, maxH: 96, slotW: 138, slotH: 104, ...o });

describe("sticker geometrisi", () => {
  it("dikdörtgen sayfa: yazı alanı sayfa kutusunun en/boy oranında, kesimin ortasında; dekor yok", () => {
    const g = buildStickerGeometry(sheet({ shape: "rect" }), profile);
    expect(g.key).toBe("sticker-s");
    expect(g.framePx).toBe(440);
    expect(g.imagePath).toBe("");
    expect(g.background.dark).toBe(false);
    expect(g.decoration.data.some((v) => v)).toBe(false);
    // En/boy oranı ≈ 130/96.
    expect(g.areaBounds.w / g.areaBounds.h).toBeCloseTo(130 / 96, 1);
    // Ortada.
    expect(g.target.x).toBeCloseTo(219.8, 0);
    expect(g.target.y).toBeCloseTo(219.8, 0);
    // Köşegen kesim çapının %90'ından büyük değil.
    expect(Math.hypot(g.areaBounds.w, g.areaBounds.h)).toBeLessThanOrEqual(0.9 * cutDiameter(profile) + 1);
    // Satır aralıkları dolu ve alan içinde.
    const mid = g.rows[Math.round(g.target.y * 2)]!;
    expect(mid.length).toBe(1);
    expect(mid[0]![1] - mid[0]![0]).toBeCloseTo(g.areaBounds.w, 0);
  });

  it("yuvarlak sayfa: kesimin ortasında daire, kesim payı kadar içeride", () => {
    const g = buildStickerGeometry(sheet({ shape: "circle", maxW: 108, maxH: 108 }), profile);
    const shape = stickerAreaShape({ shape: "circle", maxW: 108, maxH: 108 }, profile);
    expect(shape.kind).toBe("circle");
    expect(g.areaBounds.w).toBeCloseTo(g.areaBounds.h, 0);
    const margin = profile.sizing.edgeMargin * cutDiameter(profile);
    // Alan = min(%90 daire, kesim − pay) → %90 daire (pay küçük).
    expect(g.areaBounds.w).toBeLessThanOrEqual(0.9 * cutDiameter(profile) + 1);
    expect(g.areaBounds.w).toBeLessThanOrEqual(cutDiameter(profile) - 2 * margin + 1);
  });
});
