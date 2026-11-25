import "../../../i18n/test.ts";
import { adjustedInk, boxCenter, centerAdjust, IDENTITY_ADJUST, stepScale } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import {
  adjustSummary,
  alignment,
  dragAdjust,
  layerStyle,
  nudge,
  nudgeStep,
  sameAdjust,
  scaleKeyStep,
  screenScale,
  screenToDesign,
  snapToTarget,
} from "./adjust-math.ts";

const layout = { ink: { x: 120, y: 184, w: 200, h: 50 }, lines: [{ ink: { x: 120, y: 184, w: 200, h: 50 } }] };
const centers = { textCenter: { x: 220, y: 220 }, area: { x: 220, y: 220 }, cut: { x: 220, y: 220 } };

describe("ekran ↔ tasarım px", () => {
  it("ölçek ve fare farkı dönüşümü", () => {
    const k = screenScale(220, 440);
    expect(k).toBe(0.5);
    expect(screenToDesign(10, k)).toBe(20);
  });
  it("sürükleme farkı tasarım px'e çevrilir, mevcut düzeltmeye eklenir", () => {
    const next = dragAdjust({ dx: 4, dy: -2, scale: 1.1 }, 10, -5, 0.5);
    expect(next).toEqual({ dx: 24, dy: -12, scale: 1.1 });
  });
  it("sürükleme ±500 px sınırında durur", () => {
    expect(dragAdjust(IDENTITY_ADJUST, 9999, -9999, 1)).toMatchObject({ dx: 500, dy: -500 });
  });
});

describe("CSS dönüşümü", () => {
  it("origin ve kaydırma ekran px'e çevrilir; ölçek çarpanı değişmez", () => {
    const s = layerStyle({ x: 220, y: 209 }, { dx: 10, dy: -4, scale: 1.04 }, 0.5);
    expect(s.transformOrigin).toBe("110px 104.5px");
    expect(s.transform).toBe("translate(5px, -2px) scale(1.04)");
  });
});

describe("hizalanma", () => {
  it("0,5 px içinde hizalı sayılır", () => {
    expect(alignment({ x: 220.4, y: 221 }, { x: 220, y: 220 })).toEqual({ x: true, y: false });
  });
  it("domain ortalaması sonrası iki eksen de hizalıdır", () => {
    const a = centerAdjust(layout, centers, { dx: 7, dy: 9, scale: 1.1 }, { axis: "both" });
    const c = boxCenter(adjustedInk(layout, a));
    expect(alignment(c, centers.textCenter)).toEqual({ x: true, y: true });
  });
  it("yatay ortalama yalnızca x'i hizalar", () => {
    const a = centerAdjust(layout, centers, { dx: 7, dy: 9, scale: 1 }, { axis: "x" });
    expect(alignment(boxCenter(adjustedInk(layout, a)), centers.textCenter)).toEqual({ x: true, y: false });
  });
  it("boyut adımı ortalamayı bozmaz (satır düzeltmesi yokken)", () => {
    const a = stepScale(centerAdjust(layout, centers, null, { axis: "both" }), 0.02);
    expect(alignment(boxCenter(adjustedInk(layout, a)), centers.textCenter)).toEqual({ x: true, y: true });
  });
  it("yapışma menzilindeki eksen hedefe oturur, uzaktaki oturmaz", () => {
    const start = { dx: 0, dy: 0, scale: 1 };
    const center = { x: 222, y: 240 };
    const snapped = snapToTarget(start, center, { x: 220, y: 220 }, 4);
    expect(snapped.dx).toBe(-2);
    expect(snapped.dy).toBe(0);
  });
});

describe("klavye", () => {
  it("ok 1 px, Shift ile 10 px (tasarım px)", () => {
    expect(nudgeStep("ArrowLeft", false)).toEqual({ dx: -1, dy: 0 });
    expect(nudgeStep("ArrowDown", true)).toEqual({ dx: 0, dy: 10 });
    expect(nudgeStep("a", false)).toBeNull();
  });
  it("nudge birikir ve ölçeği korur", () => {
    let a = nudge({ dx: 0, dy: 0, scale: 1.04 }, "ArrowRight", true);
    a = nudge(a, "ArrowUp", false);
    expect(a).toEqual({ dx: 10, dy: -1, scale: 1.04 });
  });
  it("boyut tuşları %2", () => {
    expect(scaleKeyStep("-")).toBe(-0.02);
    expect(scaleKeyStep("=")).toBe(0.02);
    expect(scaleKeyStep("+")).toBe(0.02);
    expect(scaleKeyStep("x")).toBeNull();
  });
});

describe("kayıt durumu", () => {
  it("null ile kimlik düzeltmesi aynıdır; küçük fark değişiklik sayılır", () => {
    expect(sameAdjust(null, IDENTITY_ADJUST)).toBe(true);
    expect(sameAdjust(null, { dx: 0.001, dy: 0, scale: 1 })).toBe(true);
    expect(sameAdjust(null, { dx: 1, dy: 0, scale: 1 })).toBe(false);
  });
  it("özet metni", () => {
    expect(adjustSummary(IDENTITY_ADJUST)).toBe("değişiklik yok");
    expect(adjustSummary({ dx: 12, dy: -3, scale: 1.04 })).toBe("sağa 12 px · yukarı 3 px · boyut %104");
  });
});
