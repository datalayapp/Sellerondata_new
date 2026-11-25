import { describe, expect, it } from "vitest";
import { ReferenceSchema } from "./reference.ts";

const base = {
  id: "r1",
  languageId: "l",
  orderNo: null,
  quantity: null,
  templateKey: null,
  labelFramePx: 440,
  text: "Elena",
  user: [{ text: "Elena", family: "Great Vibes", style: "Regular", sizePx: 60, segments: [{ text: "Elena", family: "Great Vibes", style: "Regular", sizePx: 60 }], ink: { x: 1, y: 2, w: 3, h: 4 } }],
  program: null,
  programMeta: null,
  image: null,
  split: "train",
  createdAt: "2026-01-01T00:00:00Z",
};

describe("ReferenceSchema: yüklenen örnek", () => {
  it("eski kayıtlar (kalitesiz) okunmaya devam eder", () => {
    for (const source of ["figma", "migrated", "printed"]) {
      const r = ReferenceSchema.parse({ ...base, source });
      expect(r.quality).toBeUndefined();
      expect(r.approx).toBeUndefined();
      expect(r.sizesKnown).toBeUndefined();
    }
  });

  it("uploaded kaynak ve kalite alanları", () => {
    const r = ReferenceSchema.parse({ ...base, source: "uploaded", quality: "ink", approx: false, sizesKnown: false });
    expect(r).toMatchObject({ source: "uploaded", quality: "ink", approx: false, sizesKnown: false });
    expect(ReferenceSchema.safeParse({ ...base, source: "uploaded", quality: "tahmin" }).success).toBe(false);
    expect(ReferenceSchema.safeParse({ ...base, source: "yapay" }).success).toBe(false);
  });
});
