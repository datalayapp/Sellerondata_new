import type { PrintSlot } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import {
  alignBoxes,
  alignToRect,
  commonValue,
  distributeBoxes,
  duplicateSlots,
  hitSlot,
  moveSlots,
  nextSlotIds,
  nudgeMm,
  overlappingPairs,
  patchSlots,
  pointInSlot,
  slotBounds,
  slotFromDrag,
  slotsInRect,
  slotsOutside,
  templateWarnings,
} from "./slot-geometry.ts";

const circle = (id: string, cx: number, cy: number, d = 38): PrintSlot => ({ id, shape: "circle", cx, cy, w: d, h: d, rotation: 0, cornerRadius: 0 });
const rect = (id: string, cx: number, cy: number, w: number, h: number, rotation = 0, cornerRadius = 0): PrintSlot => ({ id, shape: "rect", cx, cy, w, h, rotation, cornerRadius });

describe("isabet testi", () => {
  it("daire: içi, kenarı, dışı", () => {
    const s = circle("s1", 50, 50, 20);
    expect(pointInSlot(s, { x: 50, y: 50 })).toBe(true);
    expect(pointInSlot(s, { x: 60, y: 50 })).toBe(true);
    expect(pointInSlot(s, { x: 60.1, y: 50 })).toBe(false);
    expect(pointInSlot(s, { x: 57, y: 57 })).toBe(true);
    expect(pointInSlot(s, { x: 58, y: 58 })).toBe(false);
  });

  it("döndürülmüş dikdörtgen ve köşe yuvarlaklığı", () => {
    const s = rect("r", 0, 0, 40, 10, 90);
    expect(pointInSlot(s, { x: 0, y: 18 })).toBe(true); // döndürünce uzun kenar dikey
    expect(pointInSlot(s, { x: 18, y: 0 })).toBe(false);
    const rr = rect("q", 0, 0, 20, 20, 0, 5);
    expect(pointInSlot(rr, { x: 9.9, y: 9.9 })).toBe(false); // yuvarlatılmış köşenin dışı
    expect(pointInSlot(rr, { x: 9.9, y: 0 })).toBe(true);
  });

  it("en üstteki (sondaki) yuva kazanır", () => {
    const a = circle("a", 0, 0, 20);
    const b = circle("b", 5, 0, 20);
    expect(hitSlot([a, b], { x: 3, y: 0 })?.id).toBe("b");
    expect(hitSlot([a, b], { x: 100, y: 0 })).toBeNull();
  });
});

describe("sınır kutusu, kağıt dışı, çakışma", () => {
  it("döndürülmüş elips/dikdörtgen sınır kutusu", () => {
    const b = slotBounds({ shape: "ellipse", cx: 0, cy: 0, w: 40, h: 20, rotation: 90 });
    expect(b.w).toBeCloseTo(20, 9);
    expect(b.h).toBeCloseTo(40, 9);
    const r = slotBounds({ shape: "rect", cx: 0, cy: 0, w: 10, h: 10, rotation: 45 });
    expect(r.w).toBeCloseTo(Math.SQRT2 * 10, 9);
  });

  it("kağıdın dışına taşan yuvalar", () => {
    const slots = [circle("in", 50, 50, 20), circle("out", 205, 50, 20), circle("edge", 10, 10, 20)];
    expect(slotsOutside(slots, { wMm: 210, hMm: 297 })).toEqual(["out"]);
  });

  it("değen yuvalar çakışma sayılmaz; iç içe geçenler sayılır", () => {
    const slots = [circle("a", 20, 20, 20), circle("b", 40, 20, 20), circle("c", 55, 20, 20)];
    expect(overlappingPairs(slots)).toEqual([["b", "c"]]);
  });

  it("dikdörtgen ve döndürülmüş elips çakışması (çokgen)", () => {
    const a = rect("a", 0, 0, 20, 10);
    const b = rect("b", 19, 0, 20, 10);
    const c = rect("c", 21, 0, 20, 10);
    expect(overlappingPairs([a, b])).toHaveLength(1);
    expect(overlappingPairs([a, c])).toHaveLength(0);
    const e = { ...circle("e", 0, 30, 10), shape: "ellipse" as const, w: 40, h: 6, rotation: 90 };
    expect(overlappingPairs([a, e])).toHaveLength(0); // dikey elips y 10–50, dikdörtgen y −5–5
    expect(overlappingPairs([a, { ...e, cy: 22 }])).toHaveLength(1); // elips y 2–42 → iç içe
  });

  it("şablon uyarıları: yuva yok / kağıt dışı / çakışma / tekrar kimlik / etiket yuvadan büyük", () => {
    const paper = { wMm: 100, hMm: 100 };
    expect(templateWarnings({ kind: "label", paper, slots: [], labelDiameterMm: null }).map((w) => w.code)).toEqual(["no-slots"]);
    const slots = [circle("s1", 20, 20, 20), circle("s1", 25, 20, 20), circle("s3", 99, 50, 20)];
    const codes = templateWarnings({ kind: "label", paper, slots, labelDiameterMm: 25 }).map((w) => w.code);
    expect(codes).toEqual(["slot-outside", "slot-overlap", "slot-duplicate-id", "label-larger-than-slot"]);
  });

  it("kayıt işareti yuvaya (taşma payı + 2 mm) yakınsa mark-overlap; kapalıyken ya da uzakken yok (sunucuyla aynı hesap)", () => {
    const paper = { wMm: 100, hMm: 100 };
    const reg = { enabled: true, style: "corners-l" as const, insetMm: 10, sizeMm: 5, thicknessMm: 0.5 };
    const slots = [circle("k", 12, 12, 10), circle("o", 50, 50, 10)];
    const w = templateWarnings({ kind: "label", paper, slots, labelDiameterMm: null, cut: { registration: reg, bleedMm: 0 } }).find((x) => x.code === "mark-overlap");
    expect(w?.slotIds).toEqual(["k"]);
    expect(templateWarnings({ kind: "label", paper, slots, labelDiameterMm: null, cut: { registration: { ...reg, enabled: false }, bleedMm: 0 } }).map((x) => x.code)).not.toContain("mark-overlap");
    expect(templateWarnings({ kind: "label", paper, slots, labelDiameterMm: null, cut: { registration: { ...reg, insetMm: 0 }, bleedMm: 0 } }).map((x) => x.code)).not.toContain("mark-overlap");
  });
});

describe("seçim, düzenleme", () => {
  it("kutuyla kesişen yuvalar", () => {
    const slots = [circle("a", 20, 20, 10), circle("b", 60, 20, 10)];
    expect(slotsInRect(slots, { x: 0, y: 0, w: 30, h: 30 })).toEqual(["a"]);
    expect(slotsInRect(slots, { x: 24, y: 0, w: 32, h: 30 })).toEqual(["a", "b"]);
  });

  it("yeni kimlikler çakışmaz", () => {
    expect(nextSlotIds([{ id: "s1" }, { id: "s7" }, { id: "x" }], 2)).toEqual(["s8", "s9"]);
  });

  it("taşı, çoğalt, it", () => {
    const slots = [circle("s1", 10, 10), circle("s2", 50, 10)];
    expect(moveSlots(slots, new Set(["s2"]), 0.1, -1)[1]).toMatchObject({ cx: 50.1, cy: 9 });
    const d = duplicateSlots(slots, new Set(["s1"]), { x: 5, y: 5 });
    expect(d.added).toEqual(["s3"]);
    expect(d.slots[2]).toMatchObject({ id: "s3", cx: 15, cy: 15 });
    expect(nudgeMm("ArrowLeft", false)).toEqual({ x: -0.1, y: 0 });
    expect(nudgeMm("ArrowDown", true)).toEqual({ x: 0, y: 1 });
    expect(nudgeMm("a", false)).toBeNull();
  });

  it("sayısal düzenleme: dairede çap iki ölçüye birden; ortak değer", () => {
    const slots = [circle("s1", 0, 0, 30), circle("s2", 0, 0, 30)];
    const p = patchSlots(slots, new Set(["s1"]), { w: 40 });
    expect(p[0]).toMatchObject({ w: 40, h: 40 });
    expect(commonValue([1, 1, 1])).toBe(1);
    expect(commonValue([1, 2])).toBeNull();
    const toEllipse = patchSlots(slots, new Set(["s2"]), { shape: "ellipse" });
    expect(toEllipse[1]).toMatchObject({ shape: "ellipse", w: 30, h: 30 });
  });

  it("tıkla-çiz: kısa sürüklemede varsayılan ölçü; dairede büyük kenar çap", () => {
    expect(slotFromDrag({ x: 50, y: 50 }, { x: 50.2, y: 50.1 }, "circle", { w: 38, h: 38 })).toMatchObject({ cx: 50, cy: 50, w: 38, h: 38 });
    expect(slotFromDrag({ x: 10, y: 10 }, { x: 30, y: 20 }, "circle", { w: 38, h: 38 })).toMatchObject({ cx: 20, cy: 20, w: 20, h: 20 });
    expect(slotFromDrag({ x: 30, y: 20 }, { x: 10, y: 10 }, "rect", { w: 1, h: 1 })).toMatchObject({ cx: 20, cy: 15, w: 20, h: 10 });
    expect(slotFromDrag({ x: 0, y: 0 }, { x: 20, y: 10 }, "ellipse", { w: 1, h: 1 }, { square: true })).toMatchObject({ w: 20, h: 20 });
  });
});

describe("hizala / dağıt", () => {
  const boxes = [
    { id: "a", cx: 10, cy: 10, w: 10, h: 10 },
    { id: "b", cx: 40, cy: 30, w: 20, h: 20 },
    { id: "c", cx: 100, cy: 20, w: 10, h: 10 },
  ];
  it("sola / ortaya / alta hizala (seçimin sınırına)", () => {
    const left = alignBoxes(boxes, "left");
    expect(left.get("b")).toEqual({ x: 15, y: 30 });
    expect(left.get("c")).toEqual({ x: 10, y: 20 });
    expect(left.has("a")).toBe(false);
    const mid = alignBoxes(boxes, "vcenter");
    expect(mid.get("a")?.y).toBe(22.5);
    expect(alignBoxes(boxes, "bottom").get("a")?.y).toBe(35);
    expect(alignBoxes([boxes[0]!], "left").size).toBe(0);
  });

  it("tek öğe kağıda hizalanır", () => {
    expect(alignToRect([boxes[0]!], "hcenter", { x: 0, y: 0, w: 210, h: 297 }).get("a")).toEqual({ x: 105, y: 10 });
  });

  it("dağıt: uçlar yerinde, aralar eşit boşluk", () => {
    const m = distributeBoxes(boxes, "x");
    // 5 → 105 arası 100 mm, toplam genişlik 40, boşluk 30: b'nin solu 5+10+30 = 45 → merkez 55.
    expect(m.get("b")).toEqual({ x: 55, y: 30 });
    expect(m.has("a")).toBe(false);
    expect(m.has("c")).toBe(false);
    expect(distributeBoxes(boxes.slice(0, 2), "x").size).toBe(0);
  });
});
