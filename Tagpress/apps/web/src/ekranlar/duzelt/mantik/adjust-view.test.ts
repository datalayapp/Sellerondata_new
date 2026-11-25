import "../../../i18n/test.ts";
import { describe, expect, it } from "vitest";
import {
  alignEpsilon,
  clampPan,
  designToStage,
  fineStep,
  fitView,
  panBy,
  resizeView,
  stageToDesign,
  wheelPan,
  wheelZoomFactor,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomAt,
  zoomLabel,
  zoomToBox,
} from "./adjust-view.ts";

const SIDE = 520;
const FRAME = 440;

describe("yakınlaştırma matematiği", () => {
  it("sığdır: bütün alan sahneye oturur; ekran ↔ tasarım dönüşümü tersinir", () => {
    const v = fitView(SIDE, FRAME);
    expect(v).toEqual({ zoom: SIDE / FRAME, x: 0, y: 0 });
    const p = { x: 123.4, y: 56.7 };
    const back = stageToDesign(designToStage(p, v), v);
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
  });

  it("imlecin altındaki tasarım noktası yakınlaştırmada yerinde kalır", () => {
    const v = fitView(SIDE, FRAME);
    const anchor = { x: 300, y: 140 };
    const before = stageToDesign(anchor, v);
    const z = zoomAt(v, v.zoom * 3, anchor, SIDE, FRAME);
    expect(z.zoom).toBeCloseTo(v.zoom * 3, 9);
    const after = stageToDesign(anchor, z);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    // Uzaklaştırınca da (sınır içinde) aynı nokta.
    const out = zoomAt(z, z.zoom / 2, anchor, SIDE, FRAME);
    expect(stageToDesign(anchor, out).x).toBeCloseTo(before.x, 6);
  });

  it("%25 – %800 sınırı ve etiket", () => {
    const v = fitView(SIDE, FRAME);
    expect(zoomAt(v, 100, { x: 0, y: 0 }, SIDE, FRAME).zoom).toBe(ZOOM_MAX);
    expect(zoomAt(v, 0.01, { x: 0, y: 0 }, SIDE, FRAME).zoom).toBe(ZOOM_MIN);
    expect(zoomLabel(1)).toBe("%100");
    expect(zoomLabel(SIDE / FRAME)).toBe("%118");
  });

  it("kaydırma sınırı: sahnenin merkezi dünyanın içinde kalır", () => {
    const v = { zoom: 2, x: 0, y: 0 };
    const far = panBy(v, 5000, -5000, SIDE, FRAME);
    expect(far.x).toBe(SIDE / 2);
    expect(far.y).toBe(SIDE / 2 - FRAME * 2);
    const c = clampPan({ zoom: 1, x: -100, y: 30 }, SIDE, FRAME);
    expect(c).toEqual({ zoom: 1, x: -100, y: 30 });
  });

  it("tekerlek: aşağı uzaklaştırır, yukarı yakınlaştırır; satır kipi ölçeklenir; tek olayda en fazla 2×", () => {
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(-3, 1)).toBeCloseTo(wheelZoomFactor(-48, 0), 9);
    expect(wheelZoomFactor(-100000)).toBe(2);
    expect(wheelPan({ deltaX: 0, deltaY: 40, deltaMode: 0, shiftKey: false })).toEqual({ dx: -0, dy: -40 });
    expect(wheelPan({ deltaX: 0, deltaY: 40, deltaMode: 0, shiftKey: true })).toEqual({ dx: -40, dy: 0 });
  });

  it("ince adım: sığdırılmış görünümde 1 px; yakınlaştıkça 0,5 / 0,25 / 0,1 / 0,05; uzaklaşınca 1", () => {
    const fit = SIDE / FRAME;
    expect(fineStep(fit, fit)).toBe(1);
    expect(fineStep(fit * 0.5, fit)).toBe(1);
    expect(fineStep(fit * 2, fit)).toBe(0.5);
    expect(fineStep(fit * 3, fit)).toBe(0.25);
    expect(fineStep(fit * 4, fit)).toBe(0.25);
    expect(fineStep(fit * 8, fit)).toBe(0.1);
    expect(fineStep(fit * 20, fit)).toBe(0.05);
  });

  it("hizalanma eşiği yakınlaştırınca küçülür", () => {
    expect(alignEpsilon(1, 1)).toBe(0.5);
    expect(alignEpsilon(4, 1)).toBe(0.125);
    expect(alignEpsilon(0.5, 1)).toBe(0.5);
  });

  it("seçime yakınlaştır: kutu ortalanır ve sahnenin %70'ini kaplar", () => {
    const box = { x: 100, y: 200, w: 80, h: 20 };
    const v = zoomToBox(box, SIDE, FRAME);
    expect(v.zoom).toBeCloseTo(Math.min(ZOOM_MAX, (SIDE * 0.7) / 80), 6);
    const c = designToStage({ x: 140, y: 210 }, v);
    expect(c.x).toBeCloseTo(SIDE / 2, 6);
    expect(c.y).toBeCloseTo(SIDE / 2, 6);
  });

  it("sahne yeniden boyutlanınca görünüm orantılı taşınır", () => {
    const v = { zoom: 2, x: -100, y: -50 };
    const r = resizeView(v, 520, 260, FRAME);
    expect(r).toEqual({ zoom: 1, x: -50, y: -25 });
  });
});
