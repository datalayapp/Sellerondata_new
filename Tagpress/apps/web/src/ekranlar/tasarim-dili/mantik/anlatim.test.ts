import "../../../i18n/test.ts";
import { emptyProfile, ProfileSchema } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import { compareSides, sameBreaks, sizeDiff } from "./compare.ts";
import { describeProfile } from "./describe.ts";
import { describeChange, formatValue, labelFor } from "./diffView.ts";
import { proposalChanges, readEvidence } from "./learnRead.ts";
import { setPath } from "./profilePath.ts";
import { buildSchematic } from "./schematic.ts";
import { pctOwn } from "../../../i18n/dil/tr.ts";

describe("yüzde ekleri", () => {
  it("ek uyumu", () => {
    expect(pctOwn(0.97)).toBe("%97'si");
    expect(pctOwn(0.73)).toBe("%73'ü");
    expect(pctOwn(0.11)).toBe("%11'i");
    expect(pctOwn(0.29)).toBe("%29'u");
    expect(pctOwn(0.64)).toBe("%64'ü");
    expect(pctOwn(0.6)).toBe("%60'ı");
    expect(pctOwn(0.5)).toBe("%50'si");
    expect(pctOwn(1)).toBe("%100'ü");
    expect(pctOwn(0.9)).toBe("%90'ı");
  });
});

describe("profil özeti", () => {
  const base = ProfileSchema.parse({
    name: "Deneme",
    fonts: {
      mixing: "single",
      list: [
        { id: "Ana/Regular", family: "Ana", kind: "script", roles: ["primary"] },
        { id: "Sembol/Regular", family: "Sembol", kind: "serif", roles: [] },
      ],
    },
    glyphRules: [{ id: "g1", match: { type: "chars", chars: "&" }, fontId: "Sembol/Regular", scale: 0.5 }],
    sizing: { fill: 0.97, tiers: { primary: 1, secondary: 0.73, tertiary: 0.6, connector: 0.55 } },
    spacing: { inkGaps: { normal: 0.11, beforeLast: 0.29, connector: 0.1 } },
  });
  const all = describeProfile(base);
  const flat = all.flatMap((g) => g.sentences).join("\n");
  it("değerlerden cümle üretir", () => {
    expect(flat).toContain("Yazı alanın %97'si kadarını doldurur");
    expect(flat).toContain("ana satırın %73'ü");
    expect(flat).toContain("küçük satırın %11'i, son tarih satırından önce %29");
    expect(flat).toContain("“&” her zaman Sembol ile, yarım boyutta.");
  });
  it("her grup için bölüm verir", () => {
    expect(all.map((g) => g.group)).toContain("satir-bolme");
    for (const g of all) expect(g.sentences.length, g.group).toBeGreaterThan(0);
  });
  it("boş profil de çökmez", () => {
    expect(() => describeProfile(emptyProfile("Boş"))).not.toThrow();
  });
});

describe("ölçü şeması", () => {
  it("oranlar profilden gelir", () => {
    const p = emptyProfile("x");
    const s = buildSchematic(p, 40);
    expect(s.lines).toHaveLength(5);
    expect(s.lines[0]?.sizePx).toBe(40);
    expect(s.lines[3]?.sizePx).toBeCloseTo(30);
    expect(s.gaps.map((g) => g.kind)).toEqual(["connector", "connector", "normal", "beforeLast"]);
    for (let i = 1; i < s.lines.length; i++) expect(s.lines[i]!.capTop).toBeGreaterThan(s.lines[i - 1]!.baseline - 1e-9);
  });
});

describe("iki profil farkı gösterimi", () => {
  it("etiketi PROFILE_DOCS'tan alır", () => {
    expect(labelFor("sizing.fill")).toBe("Doluluk");
    expect(labelFor("sizing.connectorScales.e")).toBe("Bağlaca özel oran · e");
    expect(labelFor("output.cut.r")).toBe("Kesim şekli · yarıçap");
  });
  it("değerleri birimiyle yazar", () => {
    expect(formatValue("sizing.fill", 0.9)).toBe("%90");
    expect(formatValue("weight.mode", "stroke")).toBe("Kontur");
    expect(formatValue("sizing.minPt", 4)).toBe("4 pt");
    expect(formatValue("connectors.separateDangling", true)).toBe("Açık");
    expect(formatValue("connectors.words", ["&", "ve"])).toBe("&, ve");
    expect(formatValue("lineBreaking.typicalLines", [1, 4])).toBe("1–4 satır");
  });
  it("değişikliği özetler", () => {
    const c = describeChange({ path: "sizing.fill", from: 0.9, to: 0.97 });
    expect(c).toMatchObject({ label: "Doluluk", from: "%90", to: "%97", group: "boyut" });
  });
});

describe("deneme ölçüleri", () => {
  it("satır bölmesi", () => {
    expect(sameBreaks(["Anna", "& Marco"], ["anna ", "& marco"])).toBe(true);
    expect(sameBreaks(["Anna & Marco"], ["Anna", "& Marco"])).toBe(false);
  });
  it("boyut farkı", () => {
    expect(sizeDiff([40, 30], [40, 30])).toBe(0);
    expect(sizeDiff([44, 30], [40, 30])).toBeCloseTo(0.05);
    expect(sizeDiff([40], [40, 30])).toBe(0);
    expect(sizeDiff([], [1])).toBeNull();
    expect(compareSides(null, { lines: ["a"], sizesPx: [1] })).toBeNull();
  });
});

describe("öğrenme önerisi okuma", () => {
  const cur = setPath(emptyProfile("x"), "sizing.tiers.secondary", 0.75);
  it("kısmi profil yamasını yaprak değişikliğe çevirir", () => {
    const ch = proposalChanges({ sizing: { tiers: { secondary: 0.7 } }, spacing: { inkGaps: { normal: 0.15 } } }, cur);
    expect(ch).toEqual([{ path: "sizing.tiers.secondary", from: 0.75, to: 0.7 }]);
  });
  it("yol listesini okur ve profil dışı yolları atar", () => {
    const ch = proposalChanges({ changes: [{ path: "sizing.fill", to: 0.95 }, { path: "template.a1.zone", to: 1 }] }, cur);
    expect(ch).toEqual([{ path: "sizing.fill", from: 0.9, to: 0.95 }]);
  });
  it("kanıtı okur", () => {
    const e = readEvidence({ count: 12, heldOut: { before: { lineMatch: 0.6, sizeError: 0.1 }, after: { lineMatch: 0.8, sizeError: 0.05 } }, examples: ["r1", { referenceId: "r2" }] });
    expect(e.count).toBe(12);
    expect(e.exampleIds).toEqual(["r1", "r2"]);
    expect(e.heldOut.map((m) => m.key)).toEqual(["lineMatch", "sizeError"]);
    expect(readEvidence(null).heldOut).toEqual([]);
  });
});

describe("rota", () => {
  it("bölüm ve grubu çözer", async () => {
    const { parseSection, sectionPath } = await import("./sections.ts");
    expect(parseSection([])).toEqual({ section: "ozet", group: "genel" });
    expect(parseSection(["kurallar", "boyut"])).toEqual({ section: "kurallar", group: "boyut" });
    expect(parseSection(["kurallar", "yok"]).group).toBe("genel");
    expect(parseSection(["bilinmeyen"]).section).toBe("ozet");
    expect(sectionPath("kurallar", "fontlar")).toEqual(["kurallar", "fontlar"]);
    expect(sectionPath("dene", "fontlar")).toEqual(["dene"]);
  });
});
