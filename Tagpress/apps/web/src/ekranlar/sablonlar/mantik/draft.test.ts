import "../../../i18n/test.ts";
import type { Template } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import { buildPatch, centerSource, changedLabels, editStateOf, effective, isDirty, setDecoration, setField, type EditChanges } from "./draft.ts";

const tpl = {
  key: "a15",
  languageId: "dil",
  ribbonTop: 0.1,
  textCenter: { x: 0.5, y: 0.55 },
  area: { mode: "manual", shape: { kind: "circle", cx: 0.5, cy: 0.5, r: 0.3 } },
  decoration: { source: "alpha", threshold: 20, dilatePx: 3 },
  notes: "çelenk",
  tags: ["çiçek"],
  provenance: [
    { field: "textCenter", source: "migrated", at: "2026-01-01" },
    { field: "textCenter", source: "measured", samples: 12, at: "2026-02-01" },
  ],
} as unknown as Template;

describe("kısmi kayıt (alan kaybı yok)", () => {
  const orig = editStateOf(tpl);
  it("dokunulmadıysa yama boş", () => {
    expect(buildPatch(orig, {})).toEqual({});
    expect(isDirty(orig, {})).toBe(false);
  });
  it("yalnızca değişen alan gider; hedef merkez ve geçmiş asla gönderilmez", () => {
    const ch = setField(orig, {}, "ribbonTop", 0.25);
    const patch = buildPatch(orig, ch);
    expect(patch).toEqual({ ribbonTop: 0.25 });
    expect("textCenter" in patch).toBe(false);
    expect("provenance" in patch).toBe(false);
  });
  it("özgün değere dönmek taslağı temizler", () => {
    let ch: EditChanges = setField(orig, {}, "ribbonTop", 0.3);
    ch = setField(orig, ch, "ribbonTop", 0.1);
    expect(ch).toEqual({});
    expect(isDirty(orig, ch)).toBe(false);
  });
  it("dekor ayarlarında yalnızca değişen alt anahtar gider", () => {
    const ch = setDecoration(orig, {}, "threshold", 30);
    expect(buildPatch(orig, ch)).toEqual({ decoration: { threshold: 30 } });
    expect(setDecoration(orig, ch, "threshold", 20)).toEqual({});
  });
  it("hedef merkezi temizlemek null olarak gider", () => {
    expect(buildPatch(orig, setField(orig, {}, "textCenter", null))).toEqual({ textCenter: null });
  });
  it("alan değişince alan bütün olarak gider", () => {
    const area = { mode: "manual" as const, shape: { kind: "rect" as const, x: 0.2, y: 0.2, w: 0.5, h: 0.5, radius: 0 } };
    expect(buildPatch(orig, setField(orig, {}, "area", area))).toEqual({ area });
  });
  it("sunucuda başka alan güncellenince taslak onu ezmez", () => {
    const ch = setField(orig, {}, "notes", "yeni not");
    const fresh = editStateOf({ ...tpl, textCenter: { x: 0.52, y: 0.6 } } as Template);
    const patch = buildPatch(fresh, ch);
    expect(patch).toEqual({ notes: "yeni not" });
    expect(effective(fresh, ch).textCenter).toEqual({ x: 0.52, y: 0.6 });
  });
  it("etkin durum: özgün + dokunulanlar", () => {
    const ch = setDecoration(orig, setField(orig, {}, "printedText", true), "dilatePx", 6);
    const e = effective(orig, ch);
    expect(e.printedText).toBe(true);
    expect(e.decoration).toEqual({ source: "alpha", threshold: 20, dilatePx: 6 });
    expect(e.notes).toBe("çelenk");
  });
  it("değişen alan adları Türkçe", () => {
    expect(changedLabels({ ribbonTop: 1, area: {}, decoration: {} })).toEqual(["Kurdele", "Yazı alanı", "Dekor ayarları"]);
  });
});

describe("eksik alanlarda varsayılanlar", () => {
  it("boş kayıt", () => {
    const s = editStateOf({});
    expect(s).toMatchObject({ kind: "label", area: { mode: "auto" }, ribbonTop: 0, textCenter: null, printedText: false, tags: [] });
    expect(s.decoration).toEqual({ source: "auto", threshold: 18, dilatePx: 3 });
  });
});

describe("hedef merkez kaynağı", () => {
  it("en son kayıt kazanır", () => {
    expect(centerSource(tpl)).toEqual({ label: "ölçülmüş", source: "measured", samples: 12 });
  });
  it("merkez yoksa null; geçmişsiz merkez bilinmiyor", () => {
    expect(centerSource({ ...tpl, textCenter: null } as Template)).toBeNull();
    expect(centerSource({ ...tpl, provenance: [] } as Template)?.source).toBe("unknown");
  });
});

describe("şablon kesimi (mm)", () => {
  const cut = { shape: "rect" as const, wMm: 63.5, hMm: 38.1, radiusMm: 0 };
  const withCut = editStateOf({ ...tpl, cut } as Template);
  it("kesim okunur; yoksa null", () => {
    expect(editStateOf(tpl).cut).toBeNull();
    expect(withCut.cut).toEqual(cut);
  });
  it("kesim değişince yamada tam nesne gider", () => {
    const next = { shape: "circle" as const, wMm: 38, hMm: 38, radiusMm: 0 };
    expect(buildPatch(withCut, setField(withCut, {}, "cut", next))).toEqual({ cut: next });
    expect(buildPatch(editStateOf(tpl), setField(editStateOf(tpl), {}, "cut", next))).toEqual({ cut: next });
  });
  it("özgün kesime dönmek yamadan düşürür", () => {
    const ch = setField(withCut, setField(withCut, {}, "cut", { ...cut, wMm: 70 }), "cut", { ...cut });
    expect(ch).toEqual({});
  });
  it("kesimi null'a çekmek yamada cut: null olur", () => {
    expect(buildPatch(withCut, setField(withCut, {}, "cut", null))).toEqual({ cut: null });
    expect(changedLabels({ cut: null })).toEqual(["Kesim"]);
  });
});
