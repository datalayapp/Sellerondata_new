import { emptyProfile, PROFILE_DOCS, PROFILE_GROUPS } from "@tagpress/domain";
import { afterEach, describe, expect, it } from "vitest";
import { describeProfile } from "./mantik/describe.ts";
import { formatValue, labelFor } from "./mantik/diffView.ts";
import { ENFORCEMENT_VIEW, ENUMS } from "./mantik/formSpec.ts";
import { SECTIONS } from "./mantik/sections.ts";
import { resources } from "../../i18n/index.ts";
import { setTestLocale } from "../../i18n/test.ts";
import { fieldHelp, fieldLabel, groupHelp, groupLabel } from "./profilMetni.ts";
import { joinList, pct, pctOwn } from "./dil.ts";

type Tree = Record<string, unknown>;
const get = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((c, k) => (c && typeof c === "object" ? (c as Tree)[k] : undefined), o);
const profile = (lng: "tr" | "en") => (resources[lng] as Record<string, Tree>).profile!;

afterEach(() => setTestLocale("tr"));

describe("profile sözlüğü bütün alanları ve grupları kapsar", () => {
  for (const lng of ["tr", "en"] as const) {
    it(`${lng}: her PROFILE_DOCS alanının etiketi ve yardımı var`, () => {
      for (const path of Object.keys(PROFILE_DOCS)) {
        for (const k of ["label", "help"] as const) {
          const v = get(profile(lng), `fields.${path}.${k}`);
          expect(typeof v === "string" && v.trim() !== "", `${lng} fields.${path}.${k}`).toBe(true);
        }
      }
    });
    it(`${lng}: her grubun adı ve yardımı var`, () => {
      for (const g of PROFILE_GROUPS) {
        for (const k of ["label", "help"] as const) expect(typeof get(profile(lng), `groups.${g.id}.${k}`), `${lng} groups.${g.id}.${k}`).toBe("string");
      }
    });
  }

  it("TR değerleri domain metniyle aynen aynı", () => {
    for (const [path, doc] of Object.entries(PROFILE_DOCS)) {
      expect(get(profile("tr"), `fields.${path}.label`), path).toBe(doc.label);
      expect(get(profile("tr"), `fields.${path}.help`), path).toBe(doc.help);
    }
    for (const g of PROFILE_GROUPS) {
      expect(get(profile("tr"), `groups.${g.id}.label`)).toBe(g.label);
      expect(get(profile("tr"), `groups.${g.id}.help`)).toBe(g.help);
    }
  });

  it("sözlükte fazladan alan ya da grup yok", () => {
    const paths: string[] = [];
    const walk = (o: Tree, p: string) => {
      for (const [k, v] of Object.entries(o)) {
        if (k === "label" && typeof v === "string") paths.push(p.slice(0, -1));
        else if (v && typeof v === "object") walk(v as Tree, `${p}${k}.`);
      }
    };
    walk(profile("tr").fields as Tree, "");
    expect(paths.sort()).toEqual(Object.keys(PROFILE_DOCS).sort());
    expect(Object.keys(profile("tr").groups as Tree).sort()).toEqual(PROFILE_GROUPS.map((g) => g.id).sort());
  });
});

describe("profilMetni: önce sözlük, yoksa domain metni", () => {
  it("TR ve EN okur", () => {
    expect(fieldLabel("sizing.fill")).toBe("Doluluk");
    expect(groupLabel("boyut")).toBe("Boyut ve doluluk");
    expect(fieldHelp("name")).toBe("Tasarım dilinin adı.");
    expect(groupHelp("genel")).toContain("Tasarım dilinin adı");
    setTestLocale("en");
    expect(fieldLabel("sizing.fill")).toBe("Fill");
    expect(groupLabel("boyut")).toBe("Size and fill");
  });
  it("sözlükte olmayan anahtar için domain metnine ya da yola düşer", () => {
    expect(fieldLabel("yok.boyle.alan")).toBe("yok.boyle.alan");
    expect(groupLabel("yok")).toBe("yok");
  });
});

describe("dile göre biçim ve metin", () => {
  it("yüzde, liste", () => {
    expect(pct(0.97)).toBe("%97");
    expect(pctOwn(0.97)).toBe("%97'si");
    expect(joinList(["a", "b", "c"])).toBe("a, b ve c");
    setTestLocale("en");
    expect(pct(0.97)).toBe("97%");
    expect(pctOwn(0.97)).toBe("97%");
    expect(joinList(["a", "b", "c"])).toBe("a, b, and c");
  });

  it("profil özeti EN'de aynı değerlerden İngilizce cümle üretir", () => {
    const p = emptyProfile("Deneme");
    setTestLocale("en");
    const flat = describeProfile(p).flatMap((g) => g.sentences).join("\n");
    expect(flat).toContain("The text fills 90% of the area");
    expect(flat).toContain("“Deneme” design language.");
    expect(describeProfile(p).map((g) => g.title)).toContain("Line breaking");
  });

  it("fark gösterimi, seçenekler, rozetler ve sekmeler dile göre", () => {
    expect(formatValue("sizing.fill", 0.9)).toBe("%90");
    expect(ENUMS["weight.mode"]?.[0]?.label).toBe("Kontur");
    expect(ENFORCEMENT_VIEW.motor.label).toBe("Kesin");
    expect(SECTIONS.map((s) => s.label)[1]).toBe("Kurallar");
    setTestLocale("en");
    expect(formatValue("sizing.fill", 0.9)).toBe("90%");
    expect(formatValue("connectors.separateDangling", true)).toBe("On");
    expect(ENUMS["weight.mode"]?.[0]?.label).toBe("Stroke");
    expect(ENFORCEMENT_VIEW.motor.label).toBe("Exact");
    expect(SECTIONS.map((s) => s.label)[1]).toBe("Rules");
    expect(labelFor("output.cut.r")).toBe("Cut shape · radius");
  });
});
