import { IDENTITY_ADJUST, normalizeAdjust, type VariantAdjust } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import {
  commonFont,
  editOf,
  editedTextCount,
  remapSpans,
  sameEdits,
  setEdit,
  trimRange,
  withEdits,
  withLineFont,
  withoutSpan,
  withSpanFont,
  withText,
} from "./adjust-edit.ts";
import { createHistory, push, redo, undo } from "./adjust-history.ts";
import { sameAdjust } from "./adjust-math.ts";

const placed = (text: string) => ({
  text,
  role: "name" as const,
  tier: "primary" as const,
  sizePx: 40,
  runs: [],
  baselineY: 100,
  x: 0,
  advance: 10,
  ink: { x: 0, y: 70, w: 10, h: 30 },
});

describe("elle metin düzenleme", () => {
  it("metin yazılır, özgün metne dönünce kalkar; kenar boşlukları ve satır sonu atılır", () => {
    const a = withText(IDENTITY_ADJUST, 1, "  Marcello\n", "Marco", "Marco");
    expect(a.edits).toEqual([{ index: 1, text: "Marcello" }]);
    const back = withText(a, 1, "Marco", "Marco", "Marcello");
    expect(back.edits).toBeUndefined();
    expect(sameAdjust(back, IDENTITY_ADJUST)).toBe(true);
  });

  it("setEdit: motorun placed'i atılır (yeniden ölçülecek), etkisiz düzenleme çıkar, sıralı", () => {
    let a: VariantAdjust = { dx: 3, dy: 0, scale: 1, edits: [{ index: 2, text: "B", placed: placed("B") }] };
    a = setEdit(a, { index: 0, fontId: "F/R" });
    expect(a.edits?.map((e) => e.index)).toEqual([0, 2]);
    a = setEdit(a, { index: 2, text: "C", placed: placed("C") });
    expect(editOf(a, 2)).toEqual({ index: 2, text: "C" });
    a = setEdit(a, { index: 0 });
    expect(a.edits?.map((e) => e.index)).toEqual([2]);
    expect(a.dx).toBe(3);
    expect(withEdits(a, []).edits).toBeUndefined();
  });

  it("geri al / yinele: metin düzenlemesi tek adım; konum değişikliği ayrı adım", () => {
    let h = createHistory<VariantAdjust>(IDENTITY_ADJUST);
    h = push(h, { ...IDENTITY_ADJUST, dx: 5 }, { now: 1, eq: sameAdjust });
    h = push(h, withEdits(h.present, [{ index: 0, text: "Ana", placed: placed("Ana") }]), { now: 2, eq: sameAdjust });
    expect(editOf(h.present, 0)?.text).toBe("Ana");
    h = undo(h);
    expect(h.present.edits).toBeUndefined();
    expect(h.present.dx).toBe(5);
    h = redo(h);
    expect(editOf(h.present, 0)?.text).toBe("Ana");
    expect(editedTextCount(h.present)).toBe(1);
  });

  it("aynı düzenleme (placed farklı) aynı sayılır", () => {
    const a = { ...IDENTITY_ADJUST, edits: [{ index: 0, text: "A", placed: placed("A") }] };
    const b = { ...IDENTITY_ADJUST, edits: [{ index: 0, text: "A" }] };
    expect(sameEdits(a, b)).toBe(true);
    expect(sameEdits(a, { ...IDENTITY_ADJUST, edits: [{ index: 0, text: "B" }] })).toBe(false);
  });

  it("taslaktaki seçim aralığı kenar boşluğuna göre kayar", () => {
    expect(trimRange("  Marco ", 2, 4)).toEqual({ text: "Marco", start: 0, end: 2 });
    expect(trimRange("Anna", 3, 1)).toEqual({ text: "Anna", start: 1, end: 3 });
  });
});

describe("parça fontları", () => {
  it("metin değişince parçalar yeni metne taşınır: baş/son korunur, içine yazılan parçada kalır", () => {
    const spans = [{ start: 6, end: 11, fontId: "C" }];
    // "Anna e Marco" → "Anna & Marco": değişen bölge parçanın önünde.
    expect(remapSpans("Anna e Marco", "Anna & Marco", [{ start: 7, end: 12, fontId: "C" }])).toEqual([{ start: 7, end: 12, fontId: "C" }]);
    // Parçanın içine harf eklenir: parça büyür.
    expect(remapSpans("Hello World", "Hello Worrld", spans)).toEqual([{ start: 6, end: 12, fontId: "C" }]);
    // Parça tamamen silinir: atılır.
    expect(remapSpans("Hello World", "Hello ", spans)).toEqual([]);
  });

  it("parçaya font: çakışanda sonraki kazanır; satır fontu parçaları temizler; kaldır", () => {
    let a = withSpanFont(IDENTITY_ADJUST, 0, 0, 4, "A", 10);
    a = withSpanFont(a, 0, 2, 6, "B", 10);
    expect(editOf(a, 0)?.spans).toEqual([
      { start: 0, end: 2, fontId: "A" },
      { start: 2, end: 6, fontId: "B" },
    ]);
    // Boş aralık hiçbir şey yapmaz.
    expect(withSpanFont(a, 0, 3, 3, "C", 10)).toBe(a);
    const b = withoutSpan(a, 0, { start: 0, end: 2, fontId: "A" });
    expect(editOf(b, 0)?.spans).toEqual([{ start: 2, end: 6, fontId: "B" }]);
    const c = withLineFont(a, [0], "Z", () => "G");
    expect(editOf(c, 0)).toEqual({ index: 0, fontId: "Z" });
  });

  it("satır fontu: motorun fontuyla aynıysa düzenleme kalkar; metin düzenlemesi korunur; ortak font", () => {
    const base = (i: number) => (i === 1 ? "H" : "G");
    let a = withText(IDENTITY_ADJUST, 1, "Marcello", "Marco", "Marco");
    a = withLineFont(a, [0, 1], "C", base);
    expect(a.edits).toEqual([
      { index: 0, fontId: "C" },
      { index: 1, text: "Marcello", fontId: "C" },
    ]);
    expect(commonFont(a, [0, 1], base)).toBe("C");
    const g = withLineFont(a, [0], "G", base);
    expect(editOf(g, 0)).toBeUndefined();
    expect(commonFont(g, [0, 1], base)).toBeNull();
    expect(commonFont(withSpanFont(g, 1, 0, 2, "X", 8), [1], base)).toBeNull();
    // Kayıt biçimine (normalizeAdjust) girer.
    expect(normalizeAdjust(a)?.edits?.length).toBe(2);
  });
});
