import "../../../../i18n/test.ts";
import { PrintCutSchema, PrintTemplateSchema, type PrintTemplateView } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import { generateGrid } from "../grid.ts";
import { draftOf, draftPatch, newTemplateBody, sameDraft } from "./draft.ts";
import { readingNumbers, registrationMarks, sampleCellLabel } from "./marks.ts";

const view: PrintTemplateView = {
  ...PrintTemplateSchema.parse({
    id: "t1",
    languageId: "l",
    name: "A4 3.8",
    kind: "label",
    paper: { wMm: 210, hMm: 297 },
    slots: generateGrid({ paper: { wMm: 210, hMm: 297 }, columns: 2, rows: 2, diameterMm: 40, pitchXMm: 50, pitchYMm: 50, marginLeftMm: 10, marginTopMm: 10 }).slots,
    createdAt: "",
    updatedAt: "",
  }),
  warnings: [],
  capacity: 4,
};

describe("şablon taslağı", () => {
  it("değişmeyen taslak eşit; alan sırası önemsiz", () => {
    const d = draftOf(view);
    expect(sameDraft(d, { ...d, cut: { ...d.cut } })).toBe(true);
    const reordered = Object.fromEntries(Object.entries(d).reverse()) as typeof d;
    expect(sameDraft(d, reordered)).toBe(true);
    expect(sameDraft(d, { ...d, name: "x" })).toBe(false);
  });

  it("kaydet yalnızca değişen alanları gönderir", () => {
    const d = draftOf(view);
    expect(draftPatch(d, d)).toEqual({});
    const moved = { ...d, slots: d.slots.map((s, i) => (i === 0 ? { ...s, cx: s.cx + 1 } : s)), cut: { ...d.cut, bleedMm: 1 } };
    const p = draftPatch(d, moved);
    expect(Object.keys(p).sort()).toEqual(["cut", "slots"]);
    expect(p.slots).toHaveLength(4);
    expect(draftPatch(d, { ...d, name: "   " }).name).toBe(d.name);
  });

  it("yeni şablon gövdesi: yuvasız; kağıt gönderilmez (sunucu kurulumdaki kağıdı koyar)", () => {
    const body = newTemplateBody("l", "label", 2);
    expect(body).toEqual({ languageId: "l", kind: "label", name: "Etiket sayfası 2", slots: [] });
    expect(body).not.toHaveProperty("paper");
    expect(newTemplateBody("l", "sticker", 1)).not.toHaveProperty("paper");
  });
});

describe("kesim işaretleri ve önizleme", () => {
  const reg = PrintCutSchema.parse({}).registration;
  it("kapalıyken işaret yok; açıkken köşe başına şekiller kağıdın içinde", () => {
    expect(registrationMarks({ wMm: 210, hMm: 297 }, reg)).toEqual([]);
    const l = registrationMarks({ wMm: 210, hMm: 297 }, { ...reg, enabled: true, style: "corners-l", insetMm: 10, sizeMm: 5, thicknessMm: 0.5 });
    expect(l).toHaveLength(8);
    for (const m of l) {
      if (m.kind !== "rect") throw new Error("L işareti dikdörtgenlerden oluşur");
      expect(m.x).toBeGreaterThanOrEqual(5);
      expect(m.x + m.w).toBeLessThanOrEqual(200 + 1e-9);
    }
    const sq = registrationMarks({ wMm: 100, hMm: 100 }, { ...reg, enabled: true, style: "corner-square", insetMm: 5, sizeMm: 4 });
    // Motorla aynı: yalnızca sol üstte kare, diğer üç köşede L (iki kol).
    expect(sq).toHaveLength(7);
    expect(sq[0]).toEqual({ kind: "rect", x: 5, y: 5, w: 4, h: 4 });
    expect(registrationMarks({ wMm: 100, hMm: 100 }, { ...reg, enabled: true, style: "crosshair" })).toHaveLength(12);
  });

  it("hücre etiketi örneği ilk yuvanın sağ altına göre; okuma sırası numaraları", () => {
    const d = draftOf(view);
    const pos = sampleCellLabel(d)!;
    expect(pos.xMm).toBeCloseTo(30 + 20 + d.cellLabel.dxMm, 6);
    expect(pos.yMm).toBeCloseTo(30 + 20 + d.cellLabel.dyMm, 6);
    expect(sampleCellLabel({ ...d, slots: [] })).toBeNull();
    const nums = readingNumbers([...d.slots].reverse());
    expect(nums.get("s1")).toBe(1);
    expect(nums.get("s4")).toBe(4);
  });
});
