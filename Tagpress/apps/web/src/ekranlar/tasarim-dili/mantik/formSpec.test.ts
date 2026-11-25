import "../../../i18n/test.ts";
import { emptyProfile, PROFILE_DOCS, PROFILE_GROUPS, ProfileSchema } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import { allFields, BOUNDS, controlFor, ENUMS, groupFields, searchFields } from "./formSpec.ts";
import { diffLeaves, getPath, planEdit, setPath } from "./profilePath.ts";

describe("profil yolu", () => {
  const p = emptyProfile("Deneme");
  it("okur", () => {
    expect(getPath(p, "sizing.tiers.secondary")).toBe(0.75);
    expect(getPath(p, "yok.böyle.alan")).toBeUndefined();
  });
  it("kopyalayarak yazar", () => {
    const q = setPath(p, "sizing.tiers.secondary", 0.7);
    expect(q.sizing.tiers.secondary).toBe(0.7);
    expect(p.sizing.tiers.secondary).toBe(0.75);
    expect(q.sizing.tiers.tertiary).toBe(p.sizing.tiers.tertiary);
  });
  it("yaprak farkı", () => {
    const q = setPath(p, "spacing.inkGaps.normal", 0.2);
    expect(diffLeaves(p, q)).toEqual([{ path: "spacing.inkGaps.normal", from: 0.15, to: 0.2 }]);
  });
});

describe("form tanımı PROFILE_DOCS'tan", () => {
  it("her belgelenmiş alan için bir kontrol üretir", () => {
    for (const path of Object.keys(PROFILE_DOCS)) expect(() => controlFor(path)).not.toThrow();
    expect(allFields().length).toBe(Object.values(PROFILE_DOCS).filter((d) => !d.hidden).length);
  });
  it("her grupta en az bir alan var", () => {
    for (const g of PROFILE_GROUPS) expect(groupFields(g.id).length, g.id).toBeGreaterThan(0);
  });
  it("tür ölçüsüne göre kontrol seçer", () => {
    expect(controlFor("sizing.fillLocked").kind).toBe("toggle");
    expect(controlFor("spacing.align").kind).toBe("segmented");
    expect(controlFor("ai.instructions").kind).toBe("textarea");
    expect(controlFor("fonts.list")).toEqual({ kind: "custom", editor: "fonts" });
    const fill = controlFor("sizing.fill");
    expect(fill).toMatchObject({ kind: "number", percent: true, suffix: "%" });
    expect(controlFor("weight.widthEm")).toMatchObject({ kind: "number", suffix: "em" });
    expect(controlFor("sizing.initials.maxCapHeight")).toMatchObject({ kind: "number", nullable: true });
  });
  it("seçenek değerleri şemada geçerli", () => {
    const base = emptyProfile("x");
    for (const [path, options] of Object.entries(ENUMS)) {
      for (const o of options) {
        const r = ProfileSchema.safeParse(setPath(base, path, o.value));
        expect(r.success, `${path}=${o.value}`).toBe(true);
      }
    }
  });
  it("sayı sınırları şemada geçerli", () => {
    const base = emptyProfile("x");
    for (const [path, b] of Object.entries(BOUNDS)) {
      for (const v of [b.min, b.max]) {
        if (v === undefined) continue;
        const r = ProfileSchema.safeParse(setPath(base, path, v));
        expect(r.success, `${path}=${v}`).toBe(true);
      }
    }
  });
  it("arama Türkçe harfe duyarsız", () => {
    expect(searchFields("DOLULUK").some((f) => f.path === "sizing.fill")).toBe(true);
    expect(searchFields("baglac").some((f) => f.path === "connectors.words")).toBe(true);
    expect(searchFields("")).toEqual([]);
  });
});

describe("otomatik kayıt kararı (planEdit)", () => {
  const p = emptyProfile("Deneme");
  it("aynı değeri yazmak kayıt tetiklemez", () => {
    expect(planEdit(p, p, false, [{ path: "sizing.tiers.secondary", value: 0.75 }]).kind).toBe("none");
  });
  it("gerçek değişiklik kaydedilir", () => {
    expect(planEdit(p, p, false, [{ path: "sizing.tiers.secondary", value: 0.7 }]).kind).toBe("save");
  });
  it("taslak yokken yayınlanmışa dönmek taslağı doğurmaz", () => {
    const q = setPath(p, "sizing.tiers.secondary", 0.7);
    expect(planEdit(q, p, false, [{ path: "sizing.tiers.secondary", value: 0.75 }]).kind).toBe("revert");
  });
  it("sunucuda taslak varsa yayınlanmışa dönüş de kaydedilir", () => {
    const q = setPath(p, "sizing.tiers.secondary", 0.7);
    expect(planEdit(q, p, true, [{ path: "sizing.tiers.secondary", value: 0.75 }]).kind).toBe("save");
  });
});
