import "../../../i18n/test.ts";
import type { Shape } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import {
  addVertexStep,
  areaForMode,
  aspectCheck,
  ASPECT_TOLERANCE,
  cutFor,
  cutWith,
  defaultAreaShape,
  deleteStep,
  doubleClick,
  drawPreview,
  type EditorCtx,
  enterStep,
  escapeStep,
  type Interaction,
  keysActive,
  nudgeStep,
  onToolChange,
  pointerDown,
  pointerMove,
  pointerUp,
  removeVertexStep,
  roundTarget,
  validVertex,
} from "./editor.ts";

const ctx = (over: Partial<EditorCtx> = {}): EditorCtx => ({ manual: true, tool: "select", area: null, targetLayer: false, it: null, selVertex: null, ...over });
const o = { shift: false, detail: 1 };
const tri: Shape = {
  kind: "polygon",
  points: [
    { x: 0.2, y: 0.2 },
    { x: 0.8, y: 0.2 },
    { x: 0.5, y: 0.8 },
  ],
};
const quad: Shape = {
  kind: "polygon",
  points: [
    { x: 0.2, y: 0.2 },
    { x: 0.8, y: 0.2 },
    { x: 0.8, y: 0.8 },
    { x: 0.2, y: 0.8 },
  ],
};
const circle: Shape = { kind: "circle", cx: 0.5, cy: 0.5, r: 0.2 };

describe("pointerDown", () => {
  it("hedef işareti katman açıkken yakalanır", () => {
    expect(pointerDown(ctx({ targetLayer: true }), { role: "target" }, { x: 0.5, y: 0.5 }, o)).toEqual({ capture: true, it: { type: "target" } });
    expect(pointerDown(ctx({ targetLayer: true, manual: false }), { role: "target" }, { x: 0.5, y: 0.5 }, o)).toEqual({ capture: true, it: { type: "target" } });
  });
  it("katman kapalıyken hedef yok sayılır; otomatik kipte null", () => {
    expect(pointerDown(ctx({ manual: false }), { role: "target" }, { x: 0.5, y: 0.5 }, o)).toBeNull();
    expect(pointerDown(ctx({ manual: false }), { role: "shape" }, { x: 0.5, y: 0.5 }, o)).toBeNull();
  });
  it("oval ve dikdörtgen aracı çizim başlatır; Shift kare", () => {
    const p = { x: 0.3, y: 0.3 };
    expect(pointerDown(ctx({ tool: "ellipse" }), null, p, o)).toEqual({ capture: true, it: { type: "draw", kind: "ellipse", start: p, cur: p, square: false } });
    expect(pointerDown(ctx({ tool: "rect" }), null, p, { shift: true, detail: 1 })).toEqual({ capture: true, it: { type: "draw", kind: "rect", start: p, cur: p, square: true } });
  });
  it("çokgen: ilk tıklamada poly başlar", () => {
    const p = { x: 0.3, y: 0.3 };
    expect(pointerDown(ctx({ tool: "polygon" }), null, p, o)).toEqual({ it: { type: "poly", points: [p], hover: p } });
  });
  it("çokgen: üç noktadan sonra ilk noktaya tıklama kapatır", () => {
    const pts = tri.kind === "polygon" ? tri.points : [];
    const it: Interaction = { type: "poly", points: pts, hover: null };
    const r = pointerDown(ctx({ tool: "polygon", it }), null, { x: 0.205, y: 0.2 }, o);
    expect(r).toEqual({ area: { kind: "polygon", points: pts }, it: null, tool: "select" });
  });
  it("çokgen: uzak tıklama nokta ekler", () => {
    const pts = tri.kind === "polygon" ? tri.points : [];
    const it: Interaction = { type: "poly", points: pts, hover: null };
    const r = pointerDown(ctx({ tool: "polygon", it }), null, { x: 0.9, y: 0.9 }, o);
    expect(r?.it).toMatchObject({ type: "poly" });
    expect(r?.it && r.it.type === "poly" ? r.it.points : []).toHaveLength(4);
  });
  it("çokgen: detail >= 2 null", () => {
    expect(pointerDown(ctx({ tool: "polygon" }), null, { x: 0.3, y: 0.3 }, { shift: false, detail: 2 })).toBeNull();
  });
  it("seç: tutamak handle ve selVertex", () => {
    const r = pointerDown(ctx({ area: quad }), { role: "handle", id: "v2" }, { x: 0.8, y: 0.8 }, o);
    expect(r).toEqual({ capture: true, selVertex: 2, it: { type: "handle", id: "v2", orig: quad } });
  });
  it("seç: daire tutamağında selVertex null", () => {
    const r = pointerDown(ctx({ area: circle }), { role: "handle", id: "e" }, { x: 0.7, y: 0.5 }, o);
    expect(r?.selVertex).toBeNull();
    expect(r?.it).toMatchObject({ type: "handle", id: "e" });
  });
  it("seç: şekil move, selVertex null", () => {
    const p = { x: 0.5, y: 0.5 };
    expect(pointerDown(ctx({ area: circle, selVertex: 1 }), { role: "shape" }, p, o)).toEqual({ capture: true, selVertex: null, it: { type: "move", start: p, orig: circle } });
  });
  it("seç: boşluk yalnız selVertex null", () => {
    expect(pointerDown(ctx({ area: circle, selVertex: 1 }), null, { x: 0.9, y: 0.9 }, o)).toEqual({ selVertex: null });
  });
});

describe("pointerMove", () => {
  it("etkileşim yoksa null", () => {
    expect(pointerMove(null, { x: 0.1, y: 0.1 }, false)).toBeNull();
  });
  it("draw: cur ve square güncellenir", () => {
    const it: Interaction = { type: "draw", kind: "rect", start: { x: 0.1, y: 0.1 }, cur: { x: 0.1, y: 0.1 }, square: false };
    expect(pointerMove(it, { x: 0.4, y: 0.5 }, true)).toEqual({ it: { ...it, cur: { x: 0.4, y: 0.5 }, square: true } });
  });
  it("poly: hover güncellenir", () => {
    const it: Interaction = { type: "poly", points: [{ x: 0.1, y: 0.1 }], hover: null };
    expect(pointerMove(it, { x: 0.4, y: 0.5 }, false)).toEqual({ it: { ...it, hover: { x: 0.4, y: 0.5 } } });
  });
  it("move: şekil taşınır", () => {
    const it: Interaction = { type: "move", start: { x: 0.5, y: 0.5 }, orig: circle };
    const r = pointerMove(it, { x: 0.6, y: 0.5 }, false);
    expect(r?.area).toMatchObject({ kind: "circle", cx: expect.closeTo(0.6, 9), cy: 0.5 });
  });
  it("handle: şekil boyutlanır", () => {
    const it: Interaction = { type: "handle", id: "e", orig: circle };
    const r = pointerMove(it, { x: 0.8, y: 0.5 }, false);
    expect(r?.area).toMatchObject({ kind: "circle", r: expect.closeTo(0.3, 9) });
  });
  it("target: hedef noktası", () => {
    expect(pointerMove({ type: "target" }, { x: 0.3, y: 0.4 }, false)).toEqual({ target: { x: 0.3, y: 0.4 } });
  });
});

describe("pointerUp", () => {
  const draw = (end: { x: number; y: number }): Interaction => ({ type: "draw", kind: "rect", start: { x: 0.1, y: 0.1 }, cur: end, square: false });
  it("yeterince büyük çizim alan olur", () => {
    const r = pointerUp(draw({ x: 0.5, y: 0.5 }), { x: 0.5, y: 0.5 }, false);
    expect(r).toMatchObject({ tool: "select", it: null, area: { kind: "rect" } });
  });
  it("çok küçük çizim yok sayılır", () => {
    expect(pointerUp(draw({ x: 0.11, y: 0.11 }), { x: 0.11, y: 0.11 }, false)).toEqual({ it: null });
  });
  it("poly null, move ve null etkileşim", () => {
    expect(pointerUp({ type: "poly", points: [], hover: null }, { x: 0, y: 0 }, false)).toBeNull();
    expect(pointerUp({ type: "move", start: { x: 0, y: 0 }, orig: circle }, { x: 0, y: 0 }, false)).toEqual({ it: null });
    expect(pointerUp(null, { x: 0, y: 0 }, false)).toBeNull();
  });
});

describe("drawPreview", () => {
  it("draw sırasında önizleme, değilse null", () => {
    const it: Interaction = { type: "draw", kind: "ellipse", start: { x: 0.1, y: 0.1 }, cur: { x: 0.5, y: 0.3 }, square: false };
    expect(drawPreview(it)).toMatchObject({ kind: "ellipse" });
    expect(drawPreview(null)).toBeNull();
    expect(drawPreview({ type: "target" })).toBeNull();
  });
});

describe("doubleClick", () => {
  it("otomatik kipte null", () => {
    expect(doubleClick(ctx({ manual: false, area: tri }), { x: 0.5, y: 0.2 }, 0.02)).toBeNull();
  });
  it("poly çizimini bitirir", () => {
    const pts = tri.kind === "polygon" ? tri.points : [];
    const r = doubleClick(ctx({ tool: "polygon", it: { type: "poly", points: pts, hover: null } }), { x: 0.5, y: 0.5 }, 0.02);
    expect(r).toEqual({ area: { kind: "polygon", points: pts }, it: null, tool: "select" });
  });
  it("kenara yakın çift tık nokta ekler", () => {
    const r = doubleClick(ctx({ area: tri }), { x: 0.5, y: 0.205 }, 0.02);
    expect(r?.selVertex).toBe(1);
    expect(r?.area?.kind === "polygon" ? r.area.points : []).toHaveLength(4);
  });
  it("uzak çift tık null", () => {
    expect(doubleClick(ctx({ area: tri }), { x: 0.5, y: 0.5 }, 0.02)).toBeNull();
  });
});

describe("klavye adımları", () => {
  it("esc sırası: çizim, araç, nokta seçimi", () => {
    expect(escapeStep(ctx({ tool: "polygon", it: { type: "poly", points: [], hover: null } }))).toEqual({ it: null });
    expect(escapeStep(ctx({ tool: "rect" }))).toEqual({ tool: "select" });
    expect(escapeStep(ctx({ selVertex: 1 }))).toEqual({ selVertex: null });
  });
  it("enter yalnız çokgen çizerken", () => {
    expect(enterStep(ctx())).toBeNull();
    const pts = tri.kind === "polygon" ? tri.points : [];
    expect(enterStep(ctx({ it: { type: "poly", points: pts, hover: null } }))).toMatchObject({ it: null, tool: "select" });
  });
  it("enter: 2 noktayla alan olmaz", () => {
    const r = enterStep(ctx({ it: { type: "poly", points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }], hover: null } }));
    expect(r).toEqual({ it: null, tool: "select" });
  });
  it("delete: poly çizerken son nokta düşer", () => {
    const it: Interaction = { type: "poly", points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }], hover: null };
    expect(deleteStep(ctx({ it }))).toEqual({ it: { ...it, points: [{ x: 0.1, y: 0.1 }] } });
  });
  it("delete: tek nokta kalınca it null", () => {
    expect(deleteStep(ctx({ it: { type: "poly", points: [{ x: 0.1, y: 0.1 }], hover: null } }))).toEqual({ it: null });
  });
  it("delete: draw sürerken null", () => {
    expect(deleteStep(ctx({ it: { type: "draw", kind: "rect", start: { x: 0, y: 0 }, cur: { x: 0, y: 0 }, square: false } }))).toBeNull();
  });
  it("delete: seçili nokta silinir", () => {
    const r = deleteStep(ctx({ area: quad, selVertex: 1 }));
    expect(r?.selVertex).toBeNull();
    expect(r?.area?.kind === "polygon" ? r.area.points : []).toHaveLength(3);
  });
  it("delete: 3 noktalı çokgende silinmez", () => {
    expect(deleteStep(ctx({ area: tri, selVertex: 1 }))).toBeNull();
    expect(removeVertexStep(tri, 1)).toBeNull();
  });
  it("removeVertexStep: çokgen değilse ya da seçim yoksa null", () => {
    expect(removeVertexStep(circle, 0)).toBeNull();
    expect(removeVertexStep(quad, null)).toBeNull();
    expect(removeVertexStep(null, 0)).toBeNull();
  });
});

describe("addVertexStep", () => {
  it("en uzun kenarın ortasına ekler ve yeni noktayı seçer", () => {
    const rectish: Shape = {
      kind: "polygon",
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.3 },
        { x: 0.1, y: 0.3 },
      ],
    };
    const r = addVertexStep(rectish);
    expect(r?.selVertex).toBe(1);
    const pts = r?.area?.kind === "polygon" ? r.area.points : [];
    expect(pts).toHaveLength(5);
    expect(pts[1]!.x).toBeCloseTo(0.5, 9);
    expect(pts[1]!.y).toBeCloseTo(0.1, 9);
  });
  it("çokgen değilse null", () => {
    expect(addVertexStep(circle)).toBeNull();
    expect(addVertexStep(null)).toBeNull();
  });
});

describe("nudgeStep", () => {
  it("seçili nokta varsa yalnız o nokta kayar", () => {
    const r = nudgeStep({ manual: true, area: quad, selVertex: 0 }, 1, 0, 0.01);
    const pts = r?.area?.kind === "polygon" ? r.area.points : [];
    expect(pts[0]!.x).toBeCloseTo(0.21, 9);
    expect(pts[1]!.x).toBeCloseTo(0.8, 9);
  });
  it("nokta seçili değilse bütün şekil kayar", () => {
    const r = nudgeStep({ manual: true, area: circle, selVertex: null }, 0, 1, 0.01);
    expect(r?.area).toMatchObject({ kind: "circle", cx: 0.5, cy: expect.closeTo(0.51, 9) });
  });
  it("alan yoksa ya da otomatik kipte null", () => {
    expect(nudgeStep({ manual: true, area: null, selVertex: null }, 1, 0, 0.01)).toBeNull();
    expect(nudgeStep({ manual: false, area: circle, selVertex: null }, 1, 0, 0.01)).toBeNull();
  });
});

describe("keysActive, onToolChange, validVertex", () => {
  it("keysActive", () => {
    expect(keysActive(ctx())).toBe(false);
    expect(keysActive(ctx({ tool: "rect" }))).toBe(true);
    expect(keysActive(ctx({ area: circle }))).toBe(true);
    expect(keysActive(ctx({ it: { type: "poly", points: [], hover: null } }))).toBe(true);
    expect(keysActive(ctx({ manual: false, area: circle, tool: "rect" }))).toBe(false);
  });
  it("onToolChange çizimi iptal eder, taşımayı korur", () => {
    expect(onToolChange({ type: "poly", points: [], hover: null })).toBeNull();
    const mv: Interaction = { type: "move", start: { x: 0, y: 0 }, orig: circle };
    expect(onToolChange(mv)).toBe(mv);
    expect(onToolChange(null)).toBeNull();
  });
  it("validVertex", () => {
    expect(validVertex(quad, 2)).toBe(2);
    expect(validVertex(quad, 4)).toBeNull();
    expect(validVertex(quad, null)).toBeNull();
    expect(validVertex(circle, 1)).toBeNull();
    expect(validVertex(null, 1)).toBeNull();
  });
});

describe("alan kipi ve hedef", () => {
  it("defaultAreaShape kesimin ortasında kısa kenarın %30'u", () => {
    const d = defaultAreaShape({ kind: "rect", x: 0, y: 0, w: 1, h: 0.5, radius: 0 });
    expect(d).toMatchObject({ kind: "circle", cx: 0.5, cy: 0.25 });
    expect(d.kind === "circle" ? d.r : 0).toBeCloseTo(0.15, 9);
  });
  it("areaForMode", () => {
    const cutR: Shape = { kind: "circle", cx: 0.5, cy: 0.5, r: 0.5 };
    expect(areaForMode("auto", circle, cutR)).toEqual({ mode: "auto" });
    expect(areaForMode("manual", circle, cutR)).toEqual({ mode: "manual", shape: circle });
    expect(areaForMode("manual", null, cutR)).toEqual({ mode: "manual", shape: defaultAreaShape(cutR) });
  });
  it("roundTarget dört basamak", () => {
    expect(roundTarget({ x: 0.123456, y: 0.987654 })).toEqual({ x: 0.1235, y: 0.9877 });
  });
});

describe("kesim", () => {
  it("kesim yokken varsayılanlar", () => {
    expect(cutFor("circle", null)).toEqual({ shape: "circle", wMm: 38, hMm: 38, radiusMm: 0 });
    expect(cutFor("ellipse", null)).toEqual({ shape: "ellipse", wMm: 50, hMm: 35, radiusMm: 0 });
    expect(cutFor("rect", null)).toEqual({ shape: "rect", wMm: 63.5, hMm: 38.1, radiusMm: 0 });
    expect(cutFor("roundRect", null)).toEqual({ shape: "roundRect", wMm: 63.5, hMm: 38.1, radiusMm: 3 });
  });
  it("daireye geçerken h=w", () => {
    expect(cutFor("circle", { shape: "rect", wMm: 60, hMm: 30, radiusMm: 0 })).toEqual({ shape: "circle", wMm: 60, hMm: 60, radiusMm: 0 });
  });
  it("kare ölçüden dikdörtgene geçerken varsayılan", () => {
    expect(cutFor("rect", { shape: "circle", wMm: 38, hMm: 38, radiusMm: 0 })).toEqual({ shape: "rect", wMm: 63.5, hMm: 38.1, radiusMm: 0 });
    expect(cutFor("ellipse", { shape: "circle", wMm: 38, hMm: 38, radiusMm: 0 })).toEqual({ shape: "ellipse", wMm: 50, hMm: 35, radiusMm: 0 });
  });
  it("farklı en/boy korunur", () => {
    expect(cutFor("ellipse", { shape: "rect", wMm: 70, hMm: 20, radiusMm: 0 })).toEqual({ shape: "ellipse", wMm: 70, hMm: 20, radiusMm: 0 });
  });
  it("cutWith dairede h=w eşitler", () => {
    expect(cutWith({ shape: "circle", wMm: 38, hMm: 38, radiusMm: 0 }, { wMm: 45 })).toEqual({ shape: "circle", wMm: 45, hMm: 45, radiusMm: 0 });
  });
});

describe("aspectCheck", () => {
  const cut = { shape: "rect", wMm: 63.5, hMm: 38.1, radiusMm: 0 } as const;
  it("görsel ya da kesim yoksa null", () => {
    expect(aspectCheck(null, cut)).toBeNull();
    expect(aspectCheck({ w: 1000, h: 600 }, null)).toBeNull();
    expect(aspectCheck({ w: 0, h: 600 }, cut)).toBeNull();
  });
  it("1000x600 görsel 63,5x38,1 kesimle uyuşur", () => {
    const r = aspectCheck({ w: 1000, h: 600 }, cut)!;
    expect(r.ok).toBe(true);
    expect(r.image).toBeCloseTo(1.6667, 3);
    expect(r.cut).toBeCloseTo(63.5 / 38.1, 6);
  });
  it("1000x1000 görsel uyuşmaz", () => {
    expect(aspectCheck({ w: 1000, h: 1000 }, cut)!.ok).toBe(false);
  });
  it("tolerans sınırı", () => {
    const c = 63.5 / 38.1;
    expect(aspectCheck({ w: c * 1.019 * 1000, h: 1000 }, cut)!.ok).toBe(true);
    expect(aspectCheck({ w: c * 1.025 * 1000, h: 1000 }, cut)!.ok).toBe(false);
    expect(aspectCheck({ w: c * 1.025 * 1000, h: 1000 }, cut, 0.05)!.ok).toBe(true);
    expect(ASPECT_TOLERANCE).toBe(0.02);
  });
});
