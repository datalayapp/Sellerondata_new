import { describe, expect, it } from "vitest";
import {
  actualSize,
  clampZoom,
  fitRect,
  lodFor,
  PX_PER_MM,
  rectFromPoints,
  rulerStep,
  rulerTicks,
  thumbWidth,
  toScreen,
  toWorld,
  unionRect,
  visibleIds,
  wheelPan,
  wheelZoomFactor,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomAt,
  zoomLabel,
} from "./canvas-math.ts";

describe("görünüm matematiği", () => {
  it("dünya ↔ ekran dönüşümü birbirinin tersi", () => {
    const v = { zoom: 2.5, x: 40, y: -12 };
    const p = { x: 13.2, y: 77.7 };
    const back = toWorld(toScreen(p, v), v);
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
  });

  it("imlece doğru yakınlaştırma: imlecin altındaki nokta yerinde kalır", () => {
    const v = { zoom: 1, x: 100, y: 50 };
    const anchor = { x: 300, y: 200 };
    const before = toWorld(anchor, v);
    const z = zoomAt(v, 4, anchor);
    expect(z.zoom).toBe(4);
    const after = toWorld(anchor, z);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it("yakınlaştırma sınırlı", () => {
    expect(clampZoom(1e9)).toBe(ZOOM_MAX);
    expect(clampZoom(0)).toBe(ZOOM_MIN);
    expect(zoomAt({ zoom: 1, x: 0, y: 0 }, 1e9, { x: 0, y: 0 }).zoom).toBe(ZOOM_MAX);
  });

  it("sığdır: dikdörtgen kenar payıyla ortalanır", () => {
    const v = fitRect({ x: 0, y: 0, w: 210, h: 297 }, 1000, 800, 50);
    expect(v.zoom).toBeCloseTo(700 / 297, 9);
    const c = toScreen({ x: 105, y: 148.5 }, v);
    expect(c.x).toBeCloseTo(500, 6);
    expect(c.y).toBeCloseTo(400, 6);
  });

  it("%100 = gerçek boyut ve etiketi", () => {
    const v = actualSize({ zoom: 0.5, x: 0, y: 0 }, 800, 600);
    expect(v.zoom).toBeCloseTo(PX_PER_MM, 9);
    expect(zoomLabel(PX_PER_MM)).toBe("%100");
    expect(zoomLabel(PX_PER_MM * 2.5)).toBe("%250");
  });

  it("tekerlek: yakınlaştırma çarpanı ve kaydırma (Shift yatay)", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(1e6)).toBe(0.5);
    expect(wheelPan({ deltaX: 0, deltaY: 30, deltaMode: 0, shiftKey: true })).toEqual({ dx: -30, dy: 0 });
    expect(wheelPan({ deltaX: 5, deltaY: 2, deltaMode: 1, shiftKey: false })).toEqual({ dx: -80, dy: -32 });
  });

  it("görünen sayfalar: görüş alanı dışındakiler DOM'a girmez", () => {
    const rects = new Map([
      ["a", { x: 0, y: 0, w: 210, h: 297 }],
      ["b", { x: 5000, y: 0, w: 210, h: 297 }],
    ]);
    const v = { zoom: 1, x: 0, y: 0 };
    expect([...visibleIds(rects, v, 800, 600, 0)]).toEqual(["a"]);
    const far = { zoom: 1, x: -4900, y: 0 };
    expect([...visibleIds(rects, far, 800, 600, 0)]).toEqual(["b"]);
  });

  it("ayrıntı düzeyi ve küçük resim genişliği", () => {
    expect(lodFor(210, 1)).toBe("thumb");
    expect(lodFor(210, 2)).toBe("detail");
    expect(thumbWidth(210, 0.5)).toBe(128);
    expect(thumbWidth(210, 1)).toBe(256);
    expect(thumbWidth(210, 10)).toBe(1024);
  });

  it("dikdörtgen yardımcıları", () => {
    expect(rectFromPoints({ x: 10, y: 5 }, { x: 2, y: 9 })).toEqual({ x: 2, y: 5, w: 8, h: 4 });
    expect(unionRect([{ x: 0, y: 0, w: 1, h: 1 }, { x: 5, y: -2, w: 1, h: 1 }])).toEqual({ x: 0, y: -2, w: 6, h: 3 });
    expect(unionRect([])).toBeNull();
  });

  it("cetvel: ekrandaki aralık en az 48 px; büyük çizgiler adımın katları", () => {
    expect(rulerStep(PX_PER_MM)).toBe(20);
    expect(rulerStep(PX_PER_MM * 10)).toBe(2);
    const t = rulerTicks(-3, 21, 10);
    expect(t.major).toEqual([0, 10, 20]);
    expect(t.minor).toContain(2);
    expect(t.minor).not.toContain(10);
  });
});
