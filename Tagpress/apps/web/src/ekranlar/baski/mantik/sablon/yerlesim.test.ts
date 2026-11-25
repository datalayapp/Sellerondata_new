import "../../../../i18n/test.ts";
import { describe, expect, it } from "vitest";
import { generateGrid } from "../grid.ts";
import {
  centerOnPaper,
  evenLayout,
  gapFromPitch,
  isCentered,
  type Layout,
  layoutCount,
  layoutMargins,
  layoutMatches,
  layoutOf,
  layoutSlots,
  moveLayoutTo,
  slotsForPaper,
} from "./yerlesim.ts";

const A4 = { wMm: 210, hMm: 297 };
const LETTER = { wMm: 215.9, hMm: 279.4 };
const L: Layout = { columns: 4, rows: 6, shape: "circle", wMm: 40, hMm: 40, cornerRadiusMm: 0, gapXMm: 6, gapYMm: 6, center: true, stagger: { enabled: false, dropLast: false } };

describe("yerleşim: kâğıda ortalama ve kenar payları", () => {
  const grid = layoutSlots(L, A4).slots;

  it("ortalı dizilişin payları eşit; ortalı sayılır", () => {
    expect(grid).toHaveLength(24);
    expect(layoutMargins(grid, A4)).toEqual({ left: 16, right: 16, top: 13.5, bottom: 13.5 });
    expect(isCentered(grid, A4)).toBe(true);
    expect(layoutMargins([], A4)).toBeNull();
    expect(isCentered([], A4)).toBe(true);
  });

  it("seçim yoksa bütün yerleşim, varsa seçim grup olarak ortalanır; yatayda, dikeyde ya da ikisi", () => {
    const off = grid.map((s) => ({ ...s, cx: s.cx + 7, cy: s.cy - 3 }));
    expect(isCentered(off, A4)).toBe(false);
    expect(layoutMargins(centerOnPaper(off, null, A4, "x"), A4)).toEqual({ left: 16, right: 16, top: 10.5, bottom: 16.5 });
    expect(layoutMargins(centerOnPaper(off, new Set(), A4, "y"), A4)).toEqual({ left: 23, right: 9, top: 13.5, bottom: 13.5 });
    expect(isCentered(centerOnPaper(off, null, A4, "xy"), A4)).toBe(true);
    // Seçim: iki yuva birlikte (aralarındaki 6 mm korunur), öbürleri yerinde.
    const two = centerOnPaper(grid, new Set(["s1", "s2"]), A4, "xy");
    expect(two.filter((s) => s.id === "s1" || s.id === "s2").map((s) => [s.cx, s.cy])).toEqual([
      [82, 148.5],
      [128, 148.5],
    ]);
    expect(two.find((s) => s.id === "s3")).toBe(grid.find((s) => s.id === "s3"));
    // Zaten ortalıysa aynı dizi.
    expect(centerOnPaper(grid, null, A4, "xy")).toBe(grid);
  });

  it("kâğıt değişince: ortalı tutuluyorsa yeni kâğıda ortalanır, değilse yerinde kalır", () => {
    const letter = slotsForPaper(grid, LETTER, true);
    expect(isCentered(letter, LETTER)).toBe(true);
    expect(layoutMargins(letter, LETTER)).toEqual({ left: 18.95, right: 18.95, top: 4.7, bottom: 4.7 });
    expect(slotsForPaper(grid, LETTER, false)).toBe(grid);
    const land = slotsForPaper(grid, { wMm: 297, hMm: 210 }, true);
    expect(isCentered(land, { wMm: 297, hMm: 210 })).toBe(true);
  });

  it("kenar payını elle vermek bütün yerleşimi kaydırır", () => {
    const moved = moveLayoutTo(grid, "left", 10);
    expect(layoutMargins(moved, A4)?.left).toBe(10);
    expect(layoutMargins(moved, A4)?.top).toBe(13.5);
    expect(layoutMargins(moveLayoutTo(grid, "top", 20), A4)?.top).toBe(20);
  });
});

describe("yerleşim: diziliş", () => {
  it("yuvalardan diziliş okunur (sütun, satır, aralık, ortalı); yeniden dizince aynı yuvalar", () => {
    const grid = layoutSlots(L, A4).slots;
    expect(layoutOf(A4, grid, { w: 30, h: 30 })).toEqual(L);
    expect(layoutMatches(L, A4, grid)).toBe(true);
    const rect = generateGrid({ paper: A4, columns: 3, rows: 7, shape: "rect", wMm: 63.5, hMm: 38.1, cornerRadiusMm: 2, pitchXMm: 66.04, pitchYMm: 38.1, marginLeftMm: 10, marginTopMm: 20 }).slots;
    const l = layoutOf(A4, rect, { w: 30, h: 30 });
    expect(l).toMatchObject({ columns: 3, rows: 7, shape: "rect", wMm: 63.5, hMm: 38.1, cornerRadiusMm: 2, gapXMm: 2.54, gapYMm: 0, center: false });
    expect(layoutMatches(l, A4, rect)).toBe(true);
    // Ortalı değil: yeniden dizince sol üst köşe yerinde kalır.
    const more = layoutSlots({ ...l, columns: 2 }, A4, rect).slots;
    expect(layoutMargins(more, A4)).toMatchObject({ left: 10, top: 20 });
  });

  it("boş şablonda varsayılan: 4 × 6, verilen ölçüde daire, 6 mm aralık, ortalı", () => {
    expect(layoutOf(A4, [], { w: 38, h: 38 })).toMatchObject({ columns: 4, rows: 6, shape: "circle", wMm: 38, hMm: 38, gapXMm: 6, gapYMm: 6, center: true });
  });

  it("elle taşınan yuva dizilişe uymaz; bütün yerleşimi taşımak uyar", () => {
    const grid = layoutSlots(L, A4).slots;
    expect(layoutMatches(L, A4, grid.map((s) => ({ ...s, cx: s.cx + 5, cy: s.cy + 1 })))).toBe(true);
    expect(layoutMatches(L, A4, grid.map((s) => (s.id === "s7" ? { ...s, cx: s.cx + 5 } : s)))).toBe(false);
    expect(layoutMatches(L, A4, grid.slice(1))).toBe(false);
    expect(layoutMatches(L, A4, [])).toBe(true);
  });

  it("kaydırmalı dizilim okunur; yuva sayısı son yuvası atılan satırları düşer", () => {
    const st: Layout = { ...L, rows: 5, stagger: { enabled: true, offsetXMm: 23, dropLast: true } };
    const slots = layoutSlots(st, A4).slots;
    expect(slots).toHaveLength(layoutCount(st));
    expect(layoutCount(st)).toBe(18);
    expect(layoutOf(A4, slots, { w: 30, h: 30 })).toMatchObject({ columns: 4, rows: 5, stagger: { enabled: true, offsetXMm: 23, dropLast: true } });
    expect(layoutCount(L)).toBe(24);
  });

  it("kâğıda eşit dağıt: kenar payı = aralık; adım → aralık", () => {
    const e = evenLayout(L, A4)!;
    const slots = layoutSlots(e, A4).slots;
    const m = layoutMargins(slots, A4)!;
    expect(m.left).toBeCloseTo(e.gapXMm, 1);
    expect(m.top).toBeCloseTo(e.gapYMm, 1);
    expect(evenLayout({ ...L, columns: 9 }, A4)).toBeNull();
    expect(gapFromPitch(46, 40)).toBe(6);
    expect(gapFromPitch(30, 40)).toBe(0);
  });
});
