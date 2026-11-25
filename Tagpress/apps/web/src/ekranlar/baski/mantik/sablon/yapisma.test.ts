import { describe, expect, it } from "vitest";
import { commonGaps, type SnapInput, snapMove } from "./yapisma.ts";

const A4 = { wMm: 210, hMm: 297 };
/** 40 mm kutu, merkezi (cx, cy). */
const box = (cx: number, cy: number, d = 40) => ({ x: cx - d / 2, y: cy - d / 2, w: d, h: d });
const item = (id: string, cx: number, cy: number) => ({ id, r: box(cx, cy) });
/** 4 sütun, 46 mm adım (6 mm aralık), sol üst yuva merkezi 36 / 33,5 (A4'e ortalı). */
const grid = Array.from({ length: 4 }, (_, c) => item(`s${c + 1}`, 36 + c * 46, 33.5));

const input = (over: Partial<SnapInput>): SnapInput => ({ moving: box(36, 200), others: grid, paper: A4, dx: 0, dy: 0, tol: 2, snap: true, ...over });

describe("yapışma", () => {
  it("kâğıt ortasına yapışır; kılavuz kâğıt boyunca", () => {
    const r = snapMove(input({ dx: 68.6 }));
    expect(r.dx).toBe(69);
    expect(r.guides).toContainEqual({ axis: "x", at: 105, from: 0, to: 297, label: { kind: "paperCenter" } });
  });

  it("öbür yuvanın merkezine ve kenarına yapışır; kılavuz iki yuvayı kapsar", () => {
    const r = snapMove(input({ dx: 45.2, dy: 0 }));
    expect(r.dx).toBe(46);
    const g = r.guides.find((x) => x.axis === "x")!;
    expect(g).toMatchObject({ at: 82, label: { kind: "slot", ref: "s2" } });
    expect([g.from, g.to]).toEqual([13.5, 220]);
    // Kenar: taşınan kutunun solu s1'in soluna.
    const e = snapMove(input({ moving: box(40, 200), dx: -2.5 }));
    expect(e.dx).toBe(-4);
  });

  it("aynı satırda kâğıtta kullanılan aralığa yapışır (6 mm) ve iki komşunun tam ortasına", () => {
    const row = [item("a", 36, 100), item("b", 128, 100)];
    expect(commonGaps([...row, ...grid], "x")).toEqual([6, 52]);
    // a'nın sağına 6 mm aralık: sol kenar 56 + 6 = 62 → merkez 82.
    const r = snapMove({ moving: box(83.5, 100), others: [...row, ...grid], paper: A4, dx: 0, dy: 0, tol: 2, snap: true });
    expect(r.dx).toBe(-1.5);
    expect(r.guides.find((x) => x.axis === "x")?.label).toEqual({ kind: "slot", ref: "s2" });
    // Komşular arası eşit aralık: a (sağ 56) ile b (sol 108) arasında 40 mm kutu → sol 62.
    const eq = snapMove({ moving: box(82.9, 120), others: [item("a", 36, 120), item("b", 128, 120)], paper: A4, dx: 0, dy: 0, tol: 2, snap: true, gaps: { x: [], y: [] } });
    expect(eq.dx).toBe(-0.9);
    expect(eq.guides.find((x) => x.axis === "x")?.label).toEqual({ kind: "equal" });
  });

  it("yapışma kapalı ya da eşik dışında kayma olduğu gibi; Shift ile kilitli eksen yapışmaz", () => {
    expect(snapMove(input({ dx: 68.6, snap: false }))).toMatchObject({ dx: 68.6, guides: [] });
    expect(snapMove(input({ dx: 65 })).dx).toBe(65);
    const r = snapMove(input({ dx: 68.6, dy: 0.4, axes: { x: true, y: false } }));
    expect(r.dy).toBe(0.4);
  });

  it("ölçüler: komşuya ya da kâğıt kenarına uzaklık", () => {
    const r = snapMove(input({ moving: box(82, 79.5), others: grid, snap: false }));
    // Yukarıda s2 (alt kenarı 53,5): 6 mm; solda ve sağda komşu yok: kâğıt kenarı.
    expect(r.measures).toContainEqual({ axis: "y", from: 53.5, to: 59.5, at: 82, mm: 6, edge: false });
    expect(r.measures).toContainEqual({ axis: "x", from: 0, to: 62, at: 79.5, mm: 62, edge: true });
    expect(r.measures).toContainEqual({ axis: "y", from: 99.5, to: 297, at: 82, mm: 197.5, edge: true });
  });
});
