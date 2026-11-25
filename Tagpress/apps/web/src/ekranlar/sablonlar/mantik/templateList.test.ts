import "../../../i18n/test.ts";
import type { TemplateItem } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import { compareKeys, FILTERS, filterCounts, flagsOf, isPng, keyFromFileName, MAIN_FILTERS, OTHER_FILTERS, siblingsOf, SORTS, splitPngs, syncSummary, validKey, visibleTemplates } from "./templateList.ts";
import { decorationMask, dilateBox, resolveSource } from "./decor.ts";

function item(key: string, over: Record<string, unknown> = {}, extra: Partial<TemplateItem> = {}): TemplateItem {
  return {
    template: { key, languageId: "d", kind: "label", area: { mode: "auto" }, ribbonTop: 0, textCenter: null, tags: [], notes: "", provenance: [], ...over },
    fileMissing: false,
    imageUrl: "",
    overlayUrl: "",
    updatedAt: "2026-01-01T00:00:00Z",
    ...extra,
  } as unknown as TemplateItem;
}

describe("doğal anahtar sırası", () => {
  it("1,2,…,30 sonra a1…", () => {
    const keys = ["a10", "30", "b1", "2", "a2", "1", "a1", "10"];
    expect([...keys].sort(compareKeys)).toEqual(["1", "2", "10", "30", "a1", "a2", "a10", "b1"]);
  });
});

describe("süzgeç ve arama", () => {
  const items = [
    item("1"),
    item("a1", { area: { mode: "manual", shape: { kind: "circle", cx: 0.5, cy: 0.5, r: 0.3 } }, tags: ["çiçek"] }),
    item("a2", {}, { fileMissing: true }),
    item("g1", { kind: "generated" }),
    item("sticker-1", { kind: "sticker" }),
  ];
  it("sayılar", () => {
    expect(filterCounts(items)).toEqual({ all: 5, manual: 1, auto: 4, missing: 1, generated: 1, sticker: 1 });
  });
  it("süzgeç + sıralama", () => {
    expect(visibleTemplates(items, "manual", "", "key").map((i) => i.template.key)).toEqual(["a1"]);
    expect(visibleTemplates(items, "all", "", "key").map((i) => i.template.key)).toEqual(["1", "a1", "a2", "g1", "sticker-1"]);
    expect(visibleTemplates(items, "all", "", "key-desc").map((i) => i.template.key)[0]).toBe("sticker-1");
  });
  it("arama anahtar ve etiketlerde, Türkçe harf duyarsız büyük/küçük", () => {
    expect(visibleTemplates(items, "all", "ÇİÇEK", "key").map((i) => i.template.key)).toEqual(["a1"]);
    expect(visibleTemplates(items, "all", "a2", "key")).toHaveLength(1);
  });
});

describe("geçici şablon", () => {
  const items = [item("1"), item("uretilen-x", { kind: "generated", tags: ["uretilen", "gecici"] }), item("uretilen-y", { kind: "generated", tags: ["uretilen"] })];
  it("listede ve sayılarda gizlenir, kalıcı üretilen görünür", () => {
    expect(visibleTemplates(items, "all", "", "key").map((i) => i.template.key)).toEqual(["1", "uretilen-y"]);
    expect(visibleTemplates(items, "generated", "uretilen", "key").map((i) => i.template.key)).toEqual(["uretilen-y"]);
    expect(filterCounts(items)).toMatchObject({ all: 2, generated: 1 });
  });
});

describe("işaretler", () => {
  it("merkez yalnız ölçülmüş/öğrenilmişse işaretlenir", () => {
    const measured = item("m", { textCenter: { x: 0.5, y: 0.5 }, ribbonTop: 0.18, provenance: [{ field: "textCenter", source: "measured", at: "x" }] });
    expect(flagsOf(measured)).toMatchObject({ centerMeasured: true, ribbonPct: 18, manualArea: false });
    const manual = item("u", { textCenter: { x: 0.5, y: 0.5 }, provenance: [{ field: "textCenter", source: "user", at: "x" }] });
    expect(flagsOf(manual).centerMeasured).toBe(false);
  });
});

describe("anahtar ve dosya", () => {
  it("dosya adından anahtar", () => {
    expect(keyFromFileName("A15.PNG")).toBe("a15");
    expect(keyFromFileName("İkon 03.png")).toBe("ikon 03");
  });
  it("geçerli anahtar", () => {
    expect(validKey("a15")).toBe(true);
    expect(validKey(" ")).toBe(false);
    expect(validKey("a/b")).toBe(false);
  });
  it("png denetimi", () => {
    expect(isPng({ name: "x.PNG", type: "" })).toBe(true);
    expect(isPng({ name: "x.jpg", type: "image/jpeg" })).toBe(false);
  });
});

describe("dekor maskesi yaklaşığı", () => {
  const rgba = (px: Array<[number, number, number, number]>) => Uint8ClampedArray.from(px.flat());
  it("alpha: dolu pikseller dekor", () => {
    const data = rgba([[0, 0, 0, 0], [10, 10, 10, 255], [0, 0, 0, 0], [0, 0, 0, 0]]);
    expect(Array.from(decorationMask(data, 4, 1, { source: "alpha", threshold: 18, dilatePx: 0 }))).toEqual([0, 1, 0, 0]);
  });
  it("color: beyazdan ΔE eşiğinden uzak olan dekor", () => {
    const data = rgba([[255, 255, 255, 255], [250, 250, 250, 255], [200, 30, 30, 255]]);
    expect(Array.from(decorationMask(data, 3, 1, { source: "color", threshold: 18, dilatePx: 0 }))).toEqual([0, 0, 1]);
    // düşük eşik silik griyi de yakalar
    expect(Array.from(decorationMask(data, 3, 1, { source: "color", threshold: 1, dilatePx: 0 }))[1]).toBe(1);
  });
  it("auto: saydam bölge çoksa alpha", () => {
    const transp = rgba([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 255]]);
    expect(resolveSource(transp, 3, "auto")).toBe("alpha");
    const opaque = rgba([[255, 255, 255, 255], [255, 255, 255, 255], [0, 0, 0, 255]]);
    expect(resolveSource(opaque, 3, "auto")).toBe("color");
  });
  it("auto: yuvarlak PNG'nin saydam köşeleri ve beyaz iç zemini dekor sayılmaz", () => {
    // 10 piksel: 1 saydam köşe, 7 beyaz iç zemin, 2 kırmızı süs
    const data = rgba([[0, 0, 0, 0], ...Array.from({ length: 7 }, () => [255, 255, 255, 255] as [number, number, number, number]), [200, 30, 30, 255], [200, 30, 30, 255]]);
    expect(resolveSource(data, 10, "auto")).toBe("color");
    const m = Array.from(decorationMask(data, 10, 1, { source: "auto", threshold: 18, dilatePx: 0 }));
    expect(m).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
  });
  it("color: baskın renkli zemin (kraft) dekor sayılmaz", () => {
    const kraft: [number, number, number, number] = [200, 160, 110, 255];
    const data = rgba([kraft, kraft, kraft, kraft, [30, 30, 30, 255]]);
    expect(Array.from(decorationMask(data, 5, 1, { source: "color", threshold: 18, dilatePx: 0 }))).toEqual([0, 0, 0, 0, 1]);
  });
  it("genişletme komşuları da kapsar", () => {
    const m = Uint8Array.from([0, 0, 0, 1, 0, 0, 0]);
    expect(Array.from(dilateBox(m, 7, 1, 2))).toEqual([0, 1, 1, 1, 1, 1, 0]);
    expect(dilateBox(m, 7, 1, 0)).toBe(m);
  });
});

describe("PNG ayrımı", () => {
  it("png olanlar ok, kalanlar bad", () => {
    const a = { name: "a.png", type: "image/png" };
    const b = { name: "b.jpg", type: "image/jpeg" };
    const c = { name: "C.PNG", type: "" };
    expect(splitPngs([a, b, c])).toEqual({ ok: [a, c], bad: [b] });
    expect(splitPngs([])).toEqual({ ok: [], bad: [] });
  });
});

describe("komşu şablonlar", () => {
  const order = ["1", "2", "a1", "a2"];
  it("ortada", () => expect(siblingsOf(order, "2")).toEqual({ prev: "1", next: "a1" }));
  it("başta", () => expect(siblingsOf(order, "1")).toEqual({ prev: null, next: "2" }));
  it("sonda", () => expect(siblingsOf(order, "a2")).toEqual({ prev: "a1", next: null }));
  it("listede yok", () => expect(siblingsOf(order, "zz")).toEqual({ prev: null, next: null }));
});

describe("klasör tarama özeti", () => {
  it("hepsi boşsa none", () => {
    expect(syncSummary({ added: [], updated: [], missing: [] })).toEqual({ none: true, tone: "info", groups: [] });
  });
  it("missing varsa uyarı tonu", () => {
    expect(syncSummary({ added: [], updated: [], missing: ["x"] }).tone).toBe("warn");
  });
  it("missing yoksa info; boş gruplar atlanır, sıra added/updated/missing", () => {
    const s = syncSummary({ added: ["a"], updated: ["b"], missing: [] });
    expect(s.tone).toBe("info");
    expect(s.none).toBe(false);
    expect(s.groups).toEqual([
      { id: "added", keys: ["a"] },
      { id: "updated", keys: ["b"] },
    ]);
    expect(syncSummary({ added: ["a"], updated: [], missing: ["m"] }).groups.map((g) => g.id)).toEqual(["added", "missing"]);
  });
});

describe("süzgeç ve sıralama adları", () => {
  it("adlar TR sözlükten gelir", () => {
    expect(FILTERS.find((f) => f.id === "manual")?.label).toBe("Elle alan");
    expect(SORTS[1]?.label).toBe("Anahtar, tersten");
  });
  it("ana ve diğer süzgeçler bütün kimlikleri kapsar", () => {
    expect([...MAIN_FILTERS, ...OTHER_FILTERS].sort()).toEqual(FILTERS.map((f) => f.id).sort());
  });
});
