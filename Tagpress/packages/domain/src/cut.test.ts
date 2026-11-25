import { describe, expect, it } from "vitest";
import { cornerMismatchMm, cutLabel, cutMarginPx, cutRotationForSlot, cutShapePx, parseCutSizeId, cutSizeId, cutSlotShape, normalizeCut, slotFitsCut } from "./cut.ts";
import { shapeBounds } from "./geometry.ts";
import { ProfileSchema, cutDiameter } from "./profile.ts";
import { TemplateSchema, effectiveCut, templateImageBox } from "./template.ts";

const profile = ProfileSchema.parse({ name: "x" });
const RECT = { shape: "rect" as const, wMm: 63.5, hMm: 38.1 };
const base = { key: "k", languageId: "l", file: "k.png", width: 840, height: 504 };

describe("şablon kesimi (mm)", () => {
  it("kesimsiz şablon profilin kesimini AYNEN kullanır (eski çıktı değişmez)", () => {
    const t = TemplateSchema.parse(base);
    expect(t.cut).toBeNull();
    const e = effectiveCut(t, profile);
    expect(e.shape).toBe(profile.output.cut);
    expect(e).toMatchObject({ cut: null, mmPerPx: null, sizeId: null });
    expect(templateImageBox(t, profile)).toBe(profile.output.templateBox);
  });

  it("dikdörtgen 63,5 × 38,1: uzun kenar tasarım alanına (profil payıyla) sığar, ortada; mm/px tutarlı", () => {
    const e = effectiveCut(TemplateSchema.parse({ ...base, cut: RECT }), profile);
    const b = shapeBounds(e.shape);
    const margin = cutMarginPx(profile.output.cut, 440); // varsayılan profil kesimi: merkez 219,82, r 218,82 → 1 px
    expect(margin).toBeCloseTo(1, 6);
    expect(b.w).toBeCloseTo(440 - 2 * margin, 3);
    expect(b.x + b.w / 2).toBeCloseTo(220, 6);
    expect(b.y + b.h / 2).toBeCloseTo(220, 6);
    expect(b.w * e.mmPerPx!).toBeCloseTo(63.5, 6);
    expect(b.h * e.mmPerPx!).toBeCloseTo(38.1, 6);
    expect(e.sizeId).toBe("63.5x38.1");
    // Görsel kutusu kesim kutusu (görsel etiketin tamamını kaplar).
    expect(templateImageBox({ imageBox: null, cut: RECT }, profile)).toEqual(b);
  });

  it("daire, kare, oval, köşesi yuvarlak: şekil, boyut kimliği, yuva karşılığı", () => {
    expect(cutShapePx({ shape: "circle", wMm: 38, hMm: 1 }, 440, 1).shape).toEqual({ kind: "circle", cx: 220, cy: 220, r: 219 });
    expect(cutSizeId({ shape: "circle", wMm: 38, hMm: 38, radiusMm: 0 })).toBe("3.8");
    expect(cutSizeId({ shape: "circle", wMm: 40, hMm: 40, radiusMm: 0 })).toBe("4");
    expect(cutSizeId({ shape: "rect", wMm: 40, hMm: 40, radiusMm: 0 })).toBe("40x40");
    expect(cutSizeId({ shape: "roundRect", wMm: 50, hMm: 30, radiusMm: 3 })).toBe("50x30r3");
    expect(cutSizeId({ shape: "ellipse", wMm: 50, hMm: 30, radiusMm: 0 })).toBe("50x30-oval");
    const rr = cutShapePx({ shape: "roundRect", wMm: 50, hMm: 30, radiusMm: 40 }, 440, 0);
    expect(rr.shape).toMatchObject({ kind: "rect", radius: 15 / rr.mmPerPx }); // yarıçap kısa kenarın yarısıyla sınırlı
    expect(normalizeCut({ shape: "rect", wMm: 10, hMm: 5, radiusMm: 2 }).radiusMm).toBe(0);
    expect(cutSlotShape(RECT as never)).toEqual({ shape: "rect", w: 63.5, h: 38.1, cornerRadius: 0 });
    expect(cutLabel(normalizeCut(RECT))).toBe("63.5 × 38.1 mm dikdörtgen");
  });

  it("yuva uyumu: şekil ve ölçü (±0,5 mm); 90° dönük dikdörtgen kabul; daire yuvaya dikdörtgen uymaz", () => {
    const cut = normalizeCut(RECT);
    expect(slotFitsCut({ shape: "rect", w: 63.5, h: 38.1 }, cut)).toBe(true);
    expect(slotFitsCut({ shape: "rect", w: 38.1, h: 63.5 }, cut)).toBe(true);
    expect(slotFitsCut({ shape: "rect", w: 63.5, h: 38.1, rotation: 90 }, cut)).toBe(true);
    expect(slotFitsCut({ shape: "circle", w: 38, h: 38 }, cut)).toBe(false);
    expect(slotFitsCut({ shape: "rect", w: 70, h: 38.1 }, cut)).toBe(false);
    const round = normalizeCut({ shape: "circle", wMm: 38, hMm: 38 });
    expect(slotFitsCut({ shape: "circle", w: 38.3, h: 38.3 }, round)).toBe(true);
    expect(slotFitsCut({ shape: "rect", w: 38, h: 38 }, round)).toBe(false);
  });

  it("dikdörtgende kesim çapı kısa kenar (oranlar buna göre)", () => {
    const e = effectiveCut({ cut: RECT as never }, profile);
    expect(cutDiameter({ ...profile, output: { ...profile.output, cut: e.shape } })).toBeCloseTo(shapeBounds(e.shape).h, 9);
  });
});

describe("yuva yönü, boyut kimliğinin tersi, köşe farkı", () => {
  const RECTC = { shape: "rect" as const, wMm: 63.5, hMm: 38.1 };
  it("dikey yuvada çeyrek tur; yatay yuvada yuvanın dönüşü; yazı baş aşağı kalmaz; uymayan yuvada null", () => {
    expect(cutRotationForSlot({ shape: "rect", w: 63.5, h: 38.1 }, RECTC)).toBe(0);
    expect(cutRotationForSlot({ shape: "rect", w: 38.1, h: 63.5 }, RECTC)).toBe(90);
    expect(cutRotationForSlot({ shape: "rect", w: 63.5, h: 38.1, rotation: 90 }, RECTC)).toBe(90);
    expect(cutRotationForSlot({ shape: "rect", w: 38.1, h: 63.5, rotation: 90 }, RECTC)).toBe(0);
    expect(cutRotationForSlot({ shape: "circle", w: 38, h: 38 }, RECTC)).toBeNull();
    expect(cutRotationForSlot({ shape: "rect", w: 40, h: 40, rotation: 15 }, { shape: "rect", wMm: 40, hMm: 40 })).toBe(15);
  });
  it("boyut kimliğinden kesim; dairenin kimliği eski boyutla aynı (null)", () => {
    for (const c of [RECTC, { shape: "roundRect" as const, wMm: 50, hMm: 30, radiusMm: 3 }, { shape: "ellipse" as const, wMm: 50, hMm: 30 }]) {
      expect(parseCutSizeId(cutSizeId(c))).toEqual(normalizeCut(c));
    }
    expect(parseCutSizeId("3.8")).toBeNull();
    expect(parseCutSizeId(null)).toBeNull();
  });
  it("köşesi yuvarlak kesim köşesiz yuvada fark verir", () => {
    expect(cornerMismatchMm({ shape: "rect", cornerRadius: 0 }, { shape: "roundRect", wMm: 50, hMm: 30, radiusMm: 3 })).toBe(3);
    expect(cornerMismatchMm({ shape: "rect", cornerRadius: 3 }, { shape: "roundRect", wMm: 50, hMm: 30, radiusMm: 3 })).toBe(0);
    expect(cornerMismatchMm({ shape: "circle" }, RECTC)).toBe(0);
  });
});
