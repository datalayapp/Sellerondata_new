import { describe, expect, it } from "vitest";
import { ProfileSchema, effectiveCut } from "@tagpress/domain";
import { bleedTemplateMatrix } from "./print.ts";

const apply = (m: readonly number[], x: number, y: number) => ({ x: m[0]! * x + m[2]! * y + m[4]!, y: m[1]! * x + m[3]! * y + m[5]! });

describe("taşma payında şablon büyütmesi (eksen başına)", () => {
  it("dikdörtgende her kenar tam taşma payı kadar dışarı çıkar (kısa kenar oranı uzun kenarı aşırı büyütmez)", () => {
    const rect = effectiveCut({ cut: { shape: "rect", wMm: 63.5, hMm: 38.1 } }, ProfileSchema.parse({ name: "x" })).shape;
    if (rect.kind !== "rect") throw new Error("dikdörtgen bekleniyordu");
    const b = 5;
    const m = bleedTemplateMatrix(rect, b);
    const right = apply(m, rect.x + rect.w, rect.y + rect.h / 2);
    const bottom = apply(m, rect.x + rect.w / 2, rect.y + rect.h);
    expect(right.x).toBeCloseTo(rect.x + rect.w + b, 9);
    expect(bottom.y).toBeCloseTo(rect.y + rect.h + b, 9);
  });

  it("daire ve kesimsiz (profil dairesi) şablonda sonuç eskisiyle aynı: (R + b) / R", () => {
    const cut = ProfileSchema.parse({ name: "x" }).output.cut;
    if (cut.kind !== "circle") throw new Error("daire bekleniyordu");
    const b = 7;
    const k = (cut.r + b) / cut.r;
    const old = [k, 0, 0, k, cut.cx - k * cut.cx, cut.cy - k * cut.cy];
    bleedTemplateMatrix(cut, b).forEach((v, i) => expect(v).toBeCloseTo(old[i]!, 12));
    expect(bleedTemplateMatrix(cut, 0)).toEqual([1, 0, 0, 1, 0, 0]);
  });
});
