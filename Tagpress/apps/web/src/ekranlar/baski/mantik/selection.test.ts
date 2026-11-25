import { describe, expect, it } from "vitest";
import { boxSelect, clickSelect, pressSelect, pruneSelection, sameSelection } from "./selection.ts";

describe("seçim", () => {
  it("tık tek seçer, Shift/Ctrl aç-kapa, boşluk temizler", () => {
    expect(clickSelect(["a", "b"], "c")).toEqual(["c"]);
    expect(clickSelect(["a"], "b", { shift: true })).toEqual(["a", "b"]);
    expect(clickSelect(["a", "b"], "a", { ctrl: true })).toEqual(["b"]);
    expect(clickSelect(["a"], null)).toEqual([]);
    expect(clickSelect(["a"], null, { shift: true })).toEqual(["a"]);
  });

  it("basılı tutma: seçili gruba basınca grup korunur (birlikte taşınır)", () => {
    expect(pressSelect(["a", "b"], "b")).toEqual(["a", "b"]);
    expect(pressSelect(["a", "b"], "c")).toEqual(["c"]);
    expect(pressSelect(["a"], "c", { ctrl: true })).toEqual(["a", "c"]);
  });

  it("kutu seçimi: değiştiricisiz değiştirir, Shift ile birleştirir", () => {
    expect(boxSelect(["a"], ["b", "c"])).toEqual(["b", "c"]);
    expect(boxSelect(["a", "b"], ["b", "c"], { shift: true })).toEqual(["a", "b", "c"]);
  });

  it("var olmayanları düşür; değişmediyse aynı dizi", () => {
    const cur = ["a", "b"];
    expect(pruneSelection(cur, () => true)).toBe(cur);
    expect(pruneSelection(cur, (x) => x === "b")).toEqual(["b"]);
    expect(sameSelection(["a"], ["a"])).toBe(true);
    expect(sameSelection(["a"], ["b"])).toBe(false);
  });
});
