import "../../../i18n/test.ts";
import type { Box } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import { OUTPUT_DEFAULTS, outputOf, templateScale } from "./olcu.ts";

describe("çıktı ayarları", () => {
  it("boş ya da eksik profil varsayılana düşer", () => {
    expect(outputOf(null)).toEqual(OUTPUT_DEFAULTS);
    expect(outputOf(undefined)).toEqual(OUTPUT_DEFAULTS);
    expect(outputOf({})).toEqual(OUTPUT_DEFAULTS);
  });
  it("verilen alanlar korunur", () => {
    const o = outputOf({ output: { designFramePx: 500, defaultSize: "5.2" } });
    expect(o.designFramePx).toBe(500);
    expect(o.defaultSize).toBe("5.2");
    expect(o.cut).toEqual(OUTPUT_DEFAULTS.cut);
  });
  it("designFramePx 0 ise varsayılan", () => {
    expect(outputOf({ output: { designFramePx: 0 } }).designFramePx).toBe(440);
  });
});

describe("şablon ölçeği", () => {
  const out = { ...OUTPUT_DEFAULTS, sizes: [{ id: "3.8", cm: 3.8, framePx: 440 }], defaultSize: "3.8", designFramePx: 440 } as unknown as typeof OUTPUT_DEFAULTS;

  it("şablon kesimi yokken ölçek varsayılan boyuttan, kesim profilden", () => {
    const s = templateScale(out, { cut: null, imageBox: null });
    expect(s.framePx).toBe(440);
    expect(s.frameMm).toBeCloseTo(38, 6);
    expect(s.mmPerPx).toBeCloseTo(38 / 440, 8);
    expect(s.cutPx).toEqual(out.cut);
    expect(s.imageBox).toEqual(out.templateBox);
  });
  it("kesim varken ölçek kesimden gelir", () => {
    const s = templateScale(out, { cut: { shape: "rect", wMm: 63.5, hMm: 38.1, radiusMm: 0 }, imageBox: null });
    expect(s.cutPx.kind).toBe("rect");
    if (s.cutPx.kind !== "rect") return;
    expect(s.cutPx.w * s.mmPerPx).toBeCloseTo(63.5, 4);
    expect(s.cutPx.h * s.mmPerPx).toBeCloseTo(38.1, 4);
    expect(s.imageBox).toEqual({ x: s.cutPx.x, y: s.cutPx.y, w: s.cutPx.w, h: s.cutPx.h });
    expect(s.frameMm).toBeCloseTo(440 * s.mmPerPx, 8);
  });
  it("şablonun kendi imageBox'ı varsa o", () => {
    const box: Box = { x: 5, y: 6, w: 100, h: 90 };
    expect(templateScale(out, { cut: { shape: "rect", wMm: 63.5, hMm: 38.1, radiusMm: 0 }, imageBox: box }).imageBox).toEqual(box);
    expect(templateScale(out, { cut: null, imageBox: box }).imageBox).toEqual(box);
  });
});
