import { describe, expect, it } from "vitest";
import "../../../i18n/test.ts";
import { generateGrid, guessGrid, paperPresetId } from "./grid.ts";
import { overlappingPairs, slotsOutside } from "./slot-geometry.ts";

const A4 = { wMm: 210, hMm: 297 };

describe("ızgara üreteci", () => {
  it("adım + kenar: ilk yuva kenardan, sonrakiler adım adım; kimlikler okuma sırasıyla", () => {
    const r = generateGrid({ paper: A4, columns: 3, rows: 2, diameterMm: 40, marginLeftMm: 10, marginTopMm: 20, pitchXMm: 50, pitchYMm: 45 });
    expect(r.error).toBeNull();
    expect(r.slots.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]);
    expect(r.slots[0]).toMatchObject({ shape: "circle", cx: 30, cy: 40, w: 40, h: 40 });
    expect(r.slots[2]).toMatchObject({ cx: 130, cy: 40 });
    expect(r.slots[3]).toMatchObject({ cx: 30, cy: 85 });
    expect(r.gapX).toBe(10);
    expect(r.gapY).toBe(5);
  });

  it("boşluk verilince adım = ölçü + boşluk", () => {
    const r = generateGrid({ paper: A4, columns: 2, rows: 1, diameterMm: 38, gapXMm: 2, gapYMm: 0, marginLeftMm: 5, marginTopMm: 5 });
    expect(r.pitchX).toBe(40);
    expect(r.slots[1]!.cx - r.slots[0]!.cx).toBe(40);
  });

  it("ortala: ızgaranın sınır kutusu kağıdın ortasında", () => {
    const r = generateGrid({ paper: A4, columns: 4, rows: 6, diameterMm: 38, pitchXMm: 48, pitchYMm: 47, center: true });
    const xs = r.slots.map((s) => s.cx);
    const ys = r.slots.map((s) => s.cy);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(105, 6);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(148.5, 6);
    expect(slotsOutside(r.slots, A4)).toEqual([]);
    expect(overlappingPairs(r.slots)).toEqual([]);
  });

  it("adım/boşluk yoksa kenar payları arasında eşit dağıtır; kenar yoksa kağıtta eşit aralık", () => {
    const withMargin = generateGrid({ paper: { wMm: 200, hMm: 100 }, columns: 3, rows: 1, diameterMm: 20, marginLeftMm: 10, marginTopMm: 40 });
    expect(withMargin.slots.map((s) => s.cx)).toEqual([20, 100, 180]);
    const even = generateGrid({ paper: { wMm: 100, hMm: 100 }, columns: 3, rows: 1, diameterMm: 10 });
    // boşluk (100 − 30) / 4 = 17,5 → merkezler 22,5 · 50 · 77,5
    expect(even.slots.map((s) => s.cx)).toEqual([22.5, 50, 77.5]);
    expect(even.slots[0]!.cy).toBe(50);
  });

  it("kaydırmalı dizilim, eşit dağıtım: kayan satır da kağıda sığar", () => {
    const r = generateGrid({ paper: { wMm: 100, hMm: 100 }, columns: 3, rows: 2, diameterMm: 20, stagger: { enabled: true } });
    expect(slotsOutside(r.slots, { wMm: 100, hMm: 100 })).toEqual([]);
    const xs = r.slots.map((s) => s.cx);
    expect(Math.min(...xs) - 10).toBeCloseTo(100 - (Math.max(...xs) + 10), 6);
  });

  it("kaydırmalı dizilim: çift satırlar yarım adım kayar, istenirse son yuva atılır", () => {
    const r = generateGrid({ paper: A4, columns: 3, rows: 3, diameterMm: 30, pitchXMm: 40, pitchYMm: 35, marginLeftMm: 10, marginTopMm: 10, stagger: { enabled: true, dropLast: true } });
    expect(r.slots).toHaveLength(8);
    expect(r.slots[3]!.cx - r.slots[0]!.cx).toBe(20);
    const custom = generateGrid({ paper: A4, columns: 2, rows: 2, diameterMm: 30, pitchXMm: 40, pitchYMm: 35, marginLeftMm: 10, marginTopMm: 10, stagger: { enabled: true, offsetXMm: 7 } });
    expect(custom.slots[2]!.cx - custom.slots[0]!.cx).toBe(7);
  });

  it("dikdörtgen ve elips ölçüleri; köşe yalnızca dikdörtgende", () => {
    const r = generateGrid({ paper: A4, columns: 1, rows: 1, shape: "rect", wMm: 60, hMm: 30, cornerRadiusMm: 3, center: true });
    expect(r.slots[0]).toMatchObject({ shape: "rect", w: 60, h: 30, cornerRadius: 3, cx: 105, cy: 148.5 });
    const e = generateGrid({ paper: A4, columns: 1, rows: 1, shape: "ellipse", diameterMm: 40, hMm: 25, cornerRadiusMm: 3, center: true });
    expect(e.slots[0]).toMatchObject({ w: 40, h: 25, cornerRadius: 0 });
  });

  it("hatalar: çap yok, geçersiz sayı, sığmayan ızgara", () => {
    expect(generateGrid({ paper: A4, columns: 2, rows: 2 }).error).toMatch(/çap/i);
    expect(generateGrid({ paper: A4, columns: 0, rows: 2, diameterMm: 10 }).error).toBeTruthy();
    expect(generateGrid({ paper: { wMm: 30, hMm: 50 }, columns: 2, rows: 1, diameterMm: 20, marginLeftMm: 10, marginTopMm: 0 }).error).toMatch(/sığmıyor/);
    // Birbirine giren ama adımı pozitif ızgara hata değildir: çakışma uyarısı olarak görünür.
    const tight = generateGrid({ paper: { wMm: 50, hMm: 50 }, columns: 5, rows: 1, diameterMm: 20, marginLeftMm: 0, marginTopMm: 0 });
    expect(tight.error).toBeNull();
    expect(overlappingPairs(tight.slots).length).toBeGreaterThan(0);
  });

  it("kağıt ön ayarı tanıma ve mevcut yuvalardan tahmin", () => {
    expect(paperPresetId(A4)).toBe("a4");
    expect(paperPresetId({ wMm: 211, hMm: 297 })).toBe("ozel");
    const r = generateGrid({ paper: A4, columns: 4, rows: 5, diameterMm: 38, pitchXMm: 48, pitchYMm: 50, center: true });
    const g = guessGrid(A4, r.slots);
    expect(g).toMatchObject({ columns: 4, rows: 5, diameterMm: 38, pitchXMm: 48, pitchYMm: 50 });
    const again = generateGrid(g);
    expect(again.slots.map((s) => [s.cx, s.cy])).toEqual(r.slots.map((s) => [s.cx, s.cy]));
  });
});
