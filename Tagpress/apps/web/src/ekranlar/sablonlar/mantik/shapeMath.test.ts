import type { Shape } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import {
  areaCenter,
  cropBox,
  cutDiameterOf,
  handlesOf,
  insertPoint,
  moveShape,
  moveVertex,
  nearestEdge,
  nudgeStep,
  pointInShape,
  polygonClick,
  pxToRatio,
  ratioToPx,
  removePoint,
  resizeShape,
  ribbonLimitY,
  shapeFromDrag,
  shapeToPath,
  toPolygon,
} from "./shapeMath.ts";

type Poly = Extract<Shape, { kind: "polygon" }>;
type Ell = Extract<Shape, { kind: "ellipse" }>;
type Rect = Extract<Shape, { kind: "rect" }>;
type Circ = Extract<Shape, { kind: "circle" }>;

const ell: Shape = { kind: "ellipse", cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.1 };
const sq: Poly = { kind: "polygon", points: [{ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.2 }, { x: 0.6, y: 0.6 }, { x: 0.2, y: 0.6 }] };

describe("oran ve px dönüşümü", () => {
  it("gidiş dönüş aynı şekli verir", () => {
    const px = ratioToPx(ell, 440);
    expect(px).toMatchObject({ cx: 220, cy: 220, rx: 88, ry: 44 });
    expect((pxToRatio(px, 440) as Ell).rx).toBeCloseTo(0.2);
  });
});

describe("shapeFromDrag", () => {
  it("iki köşeden dikdörtgen, ters yönde de", () => {
    const r = shapeFromDrag("rect", { x: 0.6, y: 0.7 }, { x: 0.2, y: 0.3 }) as Rect;
    expect(r.x).toBeCloseTo(0.2);
    expect(r.y).toBeCloseTo(0.3);
    expect(r.w).toBeCloseTo(0.4);
    expect(r.h).toBeCloseTo(0.4);
  });
  it("oval ve Shift ile daire", () => {
    expect(shapeFromDrag("ellipse", { x: 0.2, y: 0.2 }, { x: 0.6, y: 0.4 })).toMatchObject({ kind: "ellipse" });
    const c = shapeFromDrag("ellipse", { x: 0.2, y: 0.2 }, { x: 0.6, y: 0.4 }, true) as Circ;
    expect(c.kind).toBe("circle");
    expect(c.r).toBeCloseTo(0.2);
  });
  it("çok küçük çizim yok sayılır, sınırdan taşmaz", () => {
    expect(shapeFromDrag("rect", { x: 0.5, y: 0.5 }, { x: 0.51, y: 0.52 })).toBeNull();
    const r = shapeFromDrag("rect", { x: 0.8, y: 0.8 }, { x: 1.4, y: 1.4 }) as Rect;
    expect(r.x + r.w).toBeLessThanOrEqual(1);
  });
});

describe("tutamaçlar", () => {
  it("oval 8, daire 4, çokgen nokta sayısı kadar tutamaç", () => {
    expect(handlesOf(ell)).toHaveLength(8);
    expect(handlesOf({ kind: "circle", cx: 0.5, cy: 0.5, r: 0.2 })).toHaveLength(4);
    expect(handlesOf(sq)).toHaveLength(4);
  });
  it("dikdörtgenin köşesini sürüklemek karşı köşeyi sabit tutar", () => {
    const r: Shape = { kind: "rect", x: 0.2, y: 0.2, w: 0.4, h: 0.4, radius: 0 };
    const out = resizeShape(r, "se", { x: 0.8, y: 0.7 }) as Rect;
    expect(out.x).toBe(0.2);
    expect(out.y).toBe(0.2);
    expect(out.w).toBeCloseTo(0.6);
    expect(out.h).toBeCloseTo(0.5);
  });
  it("karşı kenarın ötesine geçemez (en az boyut)", () => {
    const r: Shape = { kind: "rect", x: 0.2, y: 0.2, w: 0.4, h: 0.4, radius: 0 };
    const out = resizeShape(r, "e", { x: 0.1, y: 0.4 }) as Rect;
    expect(out.w).toBeGreaterThanOrEqual(0.03);
    expect(out.x).toBe(0.2);
  });
  it("ovalin yan tutamağı karşı kenarı sabit tutar", () => {
    const out = resizeShape(ell, "e", { x: 0.9, y: 0.5 }) as Ell;
    expect(out.cx - out.rx).toBeCloseTo(0.3);
    expect(out.cx + out.rx).toBeCloseTo(0.9);
    expect(out.ry).toBeCloseTo(0.1);
  });
  it("dairenin yarıçapı değişir, merkez sabit", () => {
    const out = resizeShape({ kind: "circle", cx: 0.5, cy: 0.5, r: 0.2 }, "n", { x: 0.5, y: 0.35 }) as Circ;
    expect(out.r).toBeCloseTo(0.15);
    expect(out.cx).toBe(0.5);
  });
  it("çokgen noktası taşınır", () => {
    const out = resizeShape(sq, "v2", { x: 0.9, y: 0.9 }) as Poly;
    expect(out.points[2]).toEqual({ x: 0.9, y: 0.9 });
    expect(out.points[0]).toEqual({ x: 0.2, y: 0.2 });
  });
});

describe("taşıma", () => {
  it("tasarım alanından çıkmaz", () => {
    const out = moveShape(ell, 5, -5) as Ell;
    expect(out.cx + out.rx).toBeCloseTo(1);
    expect(out.cy - out.ry).toBeCloseTo(0);
  });
  it("1 px ve 10 px adımı", () => {
    expect(nudgeStep(440, false)).toBeCloseTo(1 / 440);
    expect(nudgeStep(440, true)).toBeCloseTo(10 / 440);
    expect((moveShape(ell, nudgeStep(440, true), 0) as Ell).cx).toBeCloseTo(0.5 + 10 / 440);
  });
  it("tek çokgen noktası", () => {
    const out = moveVertex(sq, 1, 0.1, 0) as Poly;
    expect(out.points[1]!.x).toBeCloseTo(0.7);
    expect(out.points[0]!.x).toBe(0.2);
  });
});

describe("çokgen düzenleme", () => {
  it("ilk noktaya yakın tıklama çokgeni kapatır (3 noktadan sonra)", () => {
    let pts = [{ x: 0.2, y: 0.2 }];
    for (const p of [{ x: 0.6, y: 0.2 }, { x: 0.6, y: 0.6 }]) pts = polygonClick(pts, p).points;
    expect(polygonClick(pts, { x: 0.21, y: 0.21 }).closed).toBe(true);
    expect(polygonClick(pts.slice(0, 2), { x: 0.21, y: 0.21 }).closed).toBe(false);
  });
  it("en yakın kenarı bulur ve nokta ekler", () => {
    const e = nearestEdge(sq.points, { x: 0.4, y: 0.15 });
    expect(e.index).toBe(0);
    expect(e.point.x).toBeCloseTo(0.4);
    expect(e.point.y).toBeCloseTo(0.2);
    const pts = insertPoint(sq.points, e.index, e.point);
    expect(pts).toHaveLength(5);
    expect(pts[1]!.x).toBeCloseTo(0.4);
  });
  it("3 noktanın altına silmez", () => {
    expect(removePoint(sq.points, 0)).toHaveLength(3);
    expect(removePoint(sq.points.slice(0, 3), 0)).toBeNull();
  });
  it("ovali çokgene çevirir", () => {
    const p = toPolygon(ell, 16) as Poly;
    expect(p.points).toHaveLength(16);
    expect(pointInShape(p, { x: 0.5, y: 0.5 })).toBe(true);
    expect(pointInShape(p, { x: 0.9, y: 0.9 })).toBe(false);
  });
});

describe("içinde mi / yol verisi", () => {
  it("içeride ve dışarıda", () => {
    expect(pointInShape(ell, { x: 0.5, y: 0.55 })).toBe(true);
    expect(pointInShape(ell, { x: 0.5, y: 0.7 })).toBe(false);
    expect(pointInShape({ kind: "rect", x: 0.1, y: 0.1, w: 0.2, h: 0.2, radius: 0 }, { x: 0.2, y: 0.2 })).toBe(true);
  });
  it("yol verisi", () => {
    expect(shapeToPath({ kind: "rect", x: 1, y: 2, w: 3, h: 4, radius: 0 })).toBe("M1 2h3v4h-3Z");
    expect(shapeToPath(sq)).toBe("M0.2 0.2L0.6 0.2L0.6 0.6L0.2 0.6Z");
    expect(shapeToPath({ kind: "circle", cx: 5, cy: 5, r: 2 })).toContain("a2 2 0 1 0 4 0");
  });
});

describe("kurdele bandı", () => {
  const cut: Shape = { kind: "circle", cx: 219.82, cy: 219.82, r: 218.82 };
  it("kesim çapı", () => {
    expect(cutDiameterOf(cut)).toBeCloseTo(437.64);
    expect(cutDiameterOf({ kind: "ellipse", cx: 0, cy: 0, rx: 10, ry: 20 })).toBe(20);
    expect(cutDiameterOf({ kind: "rect", x: 0, y: 0, w: 30, h: 50, radius: 0 })).toBe(30);
  });
  it("bandın alt sınırı kesimin üstünden oran x çap", () => {
    expect(ribbonLimitY(cut, 0)).toBeCloseTo(1);
    expect(ribbonLimitY(cut, 0.25)).toBeCloseTo(1 + 0.25 * 437.64);
    expect(ribbonLimitY(cut, 0.9)).toBeCloseTo(ribbonLimitY(cut, 0.6));
  });
});

describe("hedef merkez", () => {
  it("alan yoksa kesim merkezi, varsa alan sınır kutusu merkezi", () => {
    const cutR: Shape = { kind: "circle", cx: 0.5, cy: 0.5, r: 0.5 };
    expect(areaCenter(null, cutR)).toEqual({ x: 0.5, y: 0.5 });
    const c = areaCenter({ kind: "rect", x: 0.2, y: 0.4, w: 0.4, h: 0.2, radius: 0 }, cutR);
    expect(c.x).toBeCloseTo(0.4);
    expect(c.y).toBeCloseTo(0.5);
  });
  it("yakın görünüm kutusu tasarım alanında kalır", () => {
    expect(cropBox({ x: 0.5, y: 0.5 }, 0.5)).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(cropBox({ x: 0.95, y: 0.05 }, 0.5)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    expect(cropBox({ x: 0.5, y: 0.5 }, 3)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});
