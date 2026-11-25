import "../../i18n/test.ts";
import { IDENTITY_ADJUST, type VariantAdjust } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import { selectionBox } from "./mantik/adjust-select.ts";
import { backRoute } from "./donus.ts";
import { dragHandle, formatOffset, isHandle, offsetOf, parseOffset, withOffset } from "./konum.ts";
import { boxToMm, FALLBACK_FRAME_MM, fitZoomFor, frameSideMm, mmPerPx, mmToPx, screenPerPx } from "./olcu.ts";

describe("tasarım pikseli ↔ mm", () => {
  const sizes = [
    { id: "2.5", cm: 2.5, framePx: 290 },
    { id: "3.8", cm: 3.8, framePx: 440 },
    { id: "5.2", cm: 5.2, framePx: 600, contentScale: 1.2 },
  ];

  it("kare kenarı varyasyonun boyutundan; içerik ölçeği yoksa cm × 10", () => {
    expect(frameSideMm({ sizes, labelSize: "3.8", designFramePx: 440 })).toBeCloseTo(38);
    expect(frameSideMm({ sizes, labelSize: "2.5", designFramePx: 440 })).toBeCloseTo(25);
  });

  it("içerik ölçeği varsa sunucunun formülü (cm × 10 / çerçeve × tasarım karesi × ölçek)", () => {
    expect(frameSideMm({ sizes, labelSize: "5.2", designFramePx: 440 })).toBeCloseTo(((52 / 600) * 440 * 1.2) as number);
  });

  it("boyut yoksa varsayılan, o da yoksa ilk boyut; profil yoksa 38 mm", () => {
    expect(frameSideMm({ sizes, labelSize: null, defaultSize: "2.5", designFramePx: 440 })).toBeCloseTo(25);
    expect(frameSideMm({ sizes, labelSize: "9.9", designFramePx: 440 })).toBeCloseTo(25);
    expect(frameSideMm({ sizes: [], labelSize: "3.8", designFramePx: 440 })).toBe(FALLBACK_FRAME_MM);
    expect(frameSideMm({ labelSize: "3.8", designFramePx: 440 })).toBe(FALLBACK_FRAME_MM);
    expect(frameSideMm({ sizes, labelSize: "3.8", designFramePx: 0 })).toBe(FALLBACK_FRAME_MM);
  });

  it("kutu ve nokta dönüşümü, ekran ölçeği", () => {
    const k = mmPerPx(38, 440);
    expect(k).toBeCloseTo(0.086364, 5);
    expect(boxToMm({ x: 220, y: 110, w: 44, h: 22 }, k)).toEqual({ x: 19, y: 9.5, w: 3.8, h: 1.9 });
    const p = mmToPx({ x: 19, y: 9.5 }, k);
    expect(p.x).toBeCloseTo(220);
    expect(p.y).toBeCloseTo(110);
    expect(screenPerPx(10, k)).toBeCloseTo(0.86364, 4);
    expect(mmPerPx(38, 0)).toBe(1);
  });

  it("sığdırılmış yakınlık tuvalin sığdırmasıyla aynı (40 px pay)", () => {
    expect(fitZoomFor(38, 800, 600)).toBeCloseTo(520 / 38);
    expect(fitZoomFor(38, 0, 0)).toBeCloseTo(1 / 38);
  });
});

describe("konum alanları", () => {
  const a: VariantAdjust = { dx: 3, dy: -2, scale: 1.1, lines: [{ index: 1, dx: 10, dy: 0, scale: 1 }] };

  it("bütün yazıda blok kaydırması; satırda satır kaydırması × blok ölçeği", () => {
    expect(offsetOf(a, null)).toEqual({ x: 3, y: -2 });
    expect(offsetOf(a, [1])).toEqual({ x: 11, y: 0 });
    expect(offsetOf(a, [0])).toEqual({ x: 0, y: 0 });
    expect(offsetOf(a, [1, 0])).toEqual({ x: 11, y: 0 });
  });

  it("yeni değer farkı kadar taşır (çoklu seçimde hepsine aynı fark)", () => {
    expect(withOffset(a, null, "x", 5)).toMatchObject({ dx: 5, dy: -2 });
    const b = withOffset(a, [1], "x", 22);
    expect(offsetOf(b, [1]).x).toBeCloseTo(22);
    const c = withOffset(IDENTITY_ADJUST, [0, 2], "y", 4);
    expect(offsetOf(c, [0]).y).toBe(4);
    expect(offsetOf(c, [2]).y).toBe(4);
    expect(withOffset(a, null, "x", 3)).toBe(a);
  });

  it("yazılan sayı: virgül, eksi işareti, boşluk; geçersiz null", () => {
    expect(parseOffset("2,5")).toBe(2.5);
    expect(parseOffset(" −3 ")).toBe(-3);
    expect(parseOffset("-0.25")).toBe(-0.25);
    expect(parseOffset("")).toBeNull();
    expect(parseOffset("-")).toBeNull();
    expect(parseOffset("abc")).toBeNull();
  });

  it("gösterilen sayı TR biçiminde, en çok iki ondalık", () => {
    expect(formatOffset(2.5)).toBe("2,5");
    expect(formatOffset(-0.004)).toBe("0");
    expect(formatOffset(12.345)).toBe("12,35");
  });
});

describe("tutamaklar", () => {
  const layout = {
    ink: { x: 100, y: 100, w: 200, h: 100 },
    lines: [
      { ink: { x: 100, y: 100, w: 200, h: 50 } },
      { ink: { x: 100, y: 150, w: 200, h: 50 } },
    ],
  };

  it("sekiz tutamak adı tanınır", () => {
    expect(["nw", "n", "ne", "e", "se", "s", "sw", "w"].every((h) => isHandle(h))).toBe(true);
    expect(isHandle("x")).toBe(false);
    expect(isHandle(undefined)).toBe(false);
  });

  it("kenar tutamağı: karşı kenar sabit, oran dik uzaklıktan", () => {
    // Sağ kenarı 100 px dışarı çek: genişlik 200 → 300 (×1.5), sol kenar yerinde.
    const r = dragHandle(layout, IDENTITY_ADJUST, null, "e", { x: 400, y: 0 });
    expect(r.scale).toBeCloseTo(1.5);
    const b = selectionBox(layout, r, null);
    expect(b.x).toBeCloseTo(100);
    expect(b.w).toBeCloseTo(300);
    // Üst kenarı aşağı çek: yükseklik 100 → 50, alt kenar yerinde.
    const u = dragHandle(layout, IDENTITY_ADJUST, null, "n", { x: 0, y: 150 });
    const ub = selectionBox(layout, u, null);
    expect(ub.y + ub.h).toBeCloseTo(200);
    expect(ub.h).toBeCloseTo(50);
  });

  it("köşe tutamağı bugünkü gibi (karşı köşe sabit)", () => {
    const r = dragHandle(layout, IDENTITY_ADJUST, [0], "se", { x: 500, y: 200 });
    const b = selectionBox(layout, r, [0]);
    expect(b.x).toBeCloseTo(100);
    expect(b.y).toBeCloseTo(100);
    expect(b.w).toBeGreaterThan(200);
  });
});

describe("geri dönüş adresi", () => {
  it("don adresine; yoksa ya da geçersizse Üretim", () => {
    expect(backRoute("#/baski/masa/s1")).toEqual({ id: "baski", rest: ["masa", "s1"], query: {} });
    expect(backRoute("#/uretim?parti=p1&is=j1")).toEqual({ id: "uretim", rest: [], query: { parti: "p1", is: "j1" } });
    expect(backRoute(null)).toEqual({ id: "uretim", rest: [], query: {} });
    expect(backRoute("https://example.com")).toEqual({ id: "uretim", rest: [], query: {} });
    expect(backRoute("#/duzelt/v1")).toEqual({ id: "uretim", rest: [], query: {} });
  });
});
