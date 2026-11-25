import "../../../../i18n/test.ts";
import { PRINT_WARNING_MESSAGES, PrintCutSchema, type PrintSlot, PrintTemplateSchema, type PrintTemplateView, printWarningMsg } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import { setTestLocale } from "../../../../i18n/test.ts";
import { generateGrid } from "../grid.ts";
import { templateWarnings } from "../slot-geometry.ts";
import { draftOf } from "./draft.ts";
import {
  alignSelection,
  canDelete,
  deleteMode,
  defaultSlotSize,
  distributeSelection,
  dragDelta,
  duplicateSelection,
  filterTemplates,
  markFixInset,
  nudgeSelection,
  numbersReadable,
  orientationOf,
  parseMmText,
  presetName,
  removeSlots,
  selectionBounds,
  slotNumberFontMm,
  templateShortSummary,
  templateSummary,
  toolForKey,
  warnedSlotIds,
  warningText,
  withOrientation,
} from "./editor.ts";

const view = (over: Partial<PrintTemplateView> = {}): PrintTemplateView => ({
  ...PrintTemplateSchema.parse({
    id: "t1",
    languageId: "l",
    name: "A4 3.8",
    kind: "label",
    paper: { wMm: 210, hMm: 297 },
    sizeId: "3.8",
    slots: generateGrid({ paper: { wMm: 210, hMm: 297 }, columns: 2, rows: 2, diameterMm: 40, pitchXMm: 50, pitchYMm: 50, marginLeftMm: 10, marginTopMm: 10 }).slots,
    createdAt: "",
    updatedAt: "",
  }),
  warnings: [],
  capacity: 4,
  ...over,
});

const slot = (id: string, cx: number, cy: number, d = 20): PrintSlot => ({ id, shape: "circle", cx, cy, w: d, h: d, rotation: 0, cornerRadius: 0 });

describe("düzenleyici: açılış ve liste", () => {
  it("silme penceresi: kullanılmamış kalıcı silinir, kullanılmış arşive kalkar, sayı yoksa genel metin", () => {
    expect(deleteMode(view({ usedIn: 0 }))).toBe("delete");
    expect(deleteMode(view({ usedIn: 3 }))).toBe("archive");
    expect(deleteMode(view())).toBe("unknown");
    expect(canDelete(view({ usedIn: 3 }))).toBe(true);
    expect(canDelete(view({ usedIn: 3, archived: true }))).toBe(false);
    expect(canDelete(view({ usedIn: 0, archived: true }))).toBe(true);
  });

  it("liste süzgeci: arşiv, tür, arama; arşivdekiler sonda", () => {
    const all = [view({ id: "a", name: "Zeta", archived: true }), view({ id: "b", name: "Beta", kind: "sticker", sizeId: "s1" }), view({ id: "c", name: "Alfa", sizeId: "5.2" })];
    expect(filterTemplates(all, { query: "", kind: "all", showArchived: false }).map((x) => x.id)).toEqual(["c", "b"]);
    expect(filterTemplates(all, { query: "", kind: "all", showArchived: true }).map((x) => x.id)).toEqual(["c", "b", "a"]);
    expect(filterTemplates(all, { query: "", kind: "sticker", showArchived: true }).map((x) => x.id)).toEqual(["b"]);
    expect(filterTemplates(all, { query: "5.2", kind: "all", showArchived: false }).map((x) => x.id)).toEqual(["c"]);
    expect(filterTemplates(all, { query: "alf", kind: "all", showArchived: false }).map((x) => x.id)).toEqual(["c"]);
  });

  it("liste satırının kısa özeti: tür · etiket boyu · yuva (boyutsuzda tek tip yuvanın ölçüsü)", () => {
    expect(templateShortSummary(view())).toBe("Etiket · 3,8 cm · 4 yuva");
    expect(templateShortSummary(view({ sizeId: null }))).toBe("Etiket · Ø 40 mm · 4 yuva");
    expect(templateShortSummary(view({ sizeId: null, slots: [slot("a", 10, 10, 20), { ...slot("b", 40, 10, 20), shape: "rect" }], capacity: 2 }))).toBe("Etiket · 2 yuva");
    expect(templateShortSummary(view({ sizeId: null, kind: "sticker", slots: [], capacity: 0 }))).toBe("Sticker · 0 yuva");
  });

  it("özet satırı (TR aynı; EN sözlükten)", () => {
    expect(templateSummary(view())).toBe("Etiket · 3,8 cm · 210 × 297 mm · 4 yuva");
    expect(templateSummary(view({ sizeId: null, kind: "sticker", capacity: 0 }))).toBe("Sticker · 210 × 297 mm · 0 yuva");
    expect(templateSummary(view({ sizeId: "63.5x38.1", paper: { wMm: 215.9, hMm: 279.4 } }))).toBe("Etiket · 63.5x38.1 · 215,9 × 279,4 mm · 4 yuva");
    setTestLocale("en");
    try {
      expect(templateSummary(view({ capacity: 1 }))).toBe("Label · 3.8 cm · 210 × 297 mm · 1 slot");
    } finally {
      setTestLocale("tr");
    }
  });

  it("ön ayar adı eskisiyle aynı", () => {
    expect(presetName({ paper: { wMm: 210, hMm: 297 }, columns: 5, rows: 7, shape: "circle", diameterMm: 38 })).toBe("210 × 297 · 5 × 7 · 38 mm daire");
    expect(presetName({ paper: { wMm: 210, hMm: 297 }, columns: 3, rows: 7, shape: "rect", wMm: 63.5, hMm: 38.1 })).toBe("210 × 297 · 3 × 7 · 63.5 × 38.1 mm");
  });

  it("araç tuşları", () => {
    expect(toolForKey("v")).toBe("select");
    expect(toolForKey("c")).toBe("circle");
    expect(toolForKey("e")).toBe("ellipse");
    expect(toolForKey("r")).toBe("rect");
    expect(toolForKey("x")).toBeNull();
    expect(toolForKey("constructor")).toBeNull();
  });
});

describe("düzenleyici: uyarılar", () => {
  it("canlı uyarılar sunucunun cümlesi ve anahtarıyla; ekran metni sözlükten (TR = sunucu)", () => {
    const paper = { wMm: 100, hMm: 100 };
    const ws = templateWarnings({ kind: "label", paper, slots: [slot("s1", 20, 20), slot("s2", 25, 20), slot("s3", 99, 50)], labelDiameterMm: 25 });
    for (const w of ws) {
      expect(w.messageKey).toBeTruthy();
      expect(warningText(w)).toBe(w.message);
    }
    expect(ws.find((w) => w.code === "slot-outside")?.message).toBe("1 yuva kağıt dışına taşıyor: s3.");
    expect(warnedSlotIds(ws)).toEqual(new Set(["s3", "s1", "s2"]));
    expect(templateWarnings({ kind: "sticker", paper, slots: [], labelDiameterMm: null, stickerFlow: null }).map((w) => w.messageKey)).toEqual(["no-slots-sticker"]);
  });

  it("sözlük her sunucu uyarı anahtarını kapsar; yoksa sunucunun cümlesi; EN çoğul", () => {
    for (const key of Object.keys(PRINT_WARNING_MESSAGES) as Array<keyof typeof PRINT_WARNING_MESSAGES>) {
      const w = { ...printWarningMsg(key, { slots: "s1, s2", count: 2, diameter: 38, safeMm: 2, marginMm: 4 } as never), slotIds: [] };
      expect(warningText(w), key).toBe(w.message);
    }
    expect(warningText({ code: "slot-overlap", message: "Sunucu cümlesi", messageKey: "bilinmeyen-anahtar", params: { count: 2, slots: "s1, s2" } })).toBe("2 yuva üst üste biniyor: s1, s2.");
    expect(warningText({ code: "slot-overlap", message: "Sunucu cümlesi", messageKey: "bilinmeyen-anahtar" })).toBe("Sunucu cümlesi");
    expect(warningText({ code: "no-such" as never, message: "Sunucu cümlesi" })).toBe("Sunucu cümlesi");
    setTestLocale("en");
    try {
      expect(warningText(printWarningMsg("slot-overlap", { count: 1, slots: "s1" }))).toBe("1 slot overlaps: s1.");
      expect(warningText(printWarningMsg("slot-overlap", { count: 2, slots: "s1, s2" }))).toBe("2 slots overlap: s1, s2.");
    } finally {
      setTestLocale("tr");
    }
  });

  it("kayıt işareti çakışmasında önerilen kenar payı; çakışma yoksa null", () => {
    const d = { ...draftOf(view()), paper: { wMm: 100, hMm: 100 }, slots: [slot("k", 12, 12, 10), slot("o", 50, 50, 10)] };
    const reg = { ...PrintCutSchema.parse({}).registration, enabled: true, insetMm: 10, sizeMm: 5 };
    const fix = markFixInset({ ...d, cut: { ...d.cut, registration: reg } });
    expect(fix).not.toBeNull();
    expect(templateWarnings({ ...d, cut: { ...d.cut, registration: { ...reg, insetMm: fix! } } }).map((w) => w.code)).not.toContain("mark-overlap");
    expect(markFixInset({ ...d, cut: { ...d.cut, registration: { ...reg, enabled: false } } })).toBeNull();
  });
});

describe("düzenleyici: yuvalar", () => {
  const d = draftOf(view());
  const ids = (...x: string[]) => new Set(x);

  it("varsayılan yuva ölçüsü: seçili/ilk yuva, etiket çapı, boyut (cm), 30 mm", () => {
    expect(defaultSlotSize(d, [])).toEqual({ w: 40, h: 40 });
    expect(defaultSlotSize({ ...d, slots: [] }, [])).toEqual({ w: 38, h: 38 });
    expect(defaultSlotSize({ ...d, slots: [], labelDiameterMm: 25 }, [])).toEqual({ w: 25, h: 25 });
    expect(defaultSlotSize({ ...d, slots: [], sizeId: null }, [])).toEqual({ w: 30, h: 30 });
  });

  it("sil, çoğalt (5 mm kayık, yeni kimlik), it (değişmezse aynı taslak)", () => {
    expect(removeSlots(d, ids("s1")).slots.map((s) => s.id)).toEqual(["s2", "s3", "s4"]);
    expect(removeSlots(d, ids())).toBe(d);
    const r = duplicateSelection(d, ids("s1"));
    expect(r.added).toEqual(["s5"]);
    expect(r.draft.slots.at(-1)).toMatchObject({ id: "s5", cx: 35, cy: 35 });
    expect(nudgeSelection(d, ids("s1"), { x: 0.1, y: 0 }).slots[0]!.cx).toBe(30.1);
    expect(nudgeSelection(d, ids(), { x: 1, y: 0 })).toBe(d);
  });

  it("hizala: tek yuvada kağıda, çokta seçime; dağıt", () => {
    expect(alignSelection(d, ids("s1"), "right").slots[0]!.cx).toBe(190);
    const top = alignSelection(d, ids("s1", "s3"), "top");
    expect(top.slots.find((s) => s.id === "s3")!.cy).toBe(30);
    expect(alignSelection(d, ids("s1", "s2"), "top")).toBe(d);
    const spread = { ...d, slots: [slot("a", 10, 10), slot("b", 20, 10), slot("c", 100, 10)] };
    expect(distributeSelection(spread, ids("a", "b", "c"), "x").slots[1]!.cx).toBe(55);
  });

  it("seçim kutusu, sürükleme kayması, numaraların okunurluğu", () => {
    expect(selectionBounds([])).toBeNull();
    expect(selectionBounds(d.slots.slice(0, 2))).toEqual({ x: 10, y: 10, w: 90, h: 40 });
    expect(dragDelta(3.14, 1.01, false)).toEqual({ x: 3.1, y: 1 });
    expect(dragDelta(3.14, 1.01, true)).toEqual({ x: 3.1, y: 0 });
    expect(dragDelta(0.5, -2, true)).toEqual({ x: 0, y: -2 });
    expect(numbersReadable(2.5)).toBe(true);
    expect(numbersReadable(2)).toBe(false);
    // Yuvaya göre büyüyen numara (maket: 38 mm yuvada ≈ 8 mm): sığdır görünümünde (≈ 2 px/mm) de okunur.
    expect(slotNumberFontMm([slot("a", 0, 0, 38), slot("b", 0, 0, 40)])).toBe(8);
    expect(numbersReadable(2, slotNumberFontMm([slot("a", 0, 0, 38)]))).toBe(true);
    expect(slotNumberFontMm([slot("a", 0, 0, 10)])).toBe(3.2);
    expect(slotNumberFontMm([])).toBe(3.2);
  });
});

describe("düzenleyici: kağıt, alanlar", () => {
  it("yön: en ve boy yer değiştirir", () => {
    expect(orientationOf({ wMm: 210, hMm: 297 })).toBe("portrait");
    expect(withOrientation({ wMm: 210, hMm: 297 }, "landscape")).toEqual({ wMm: 297, hMm: 210 });
    const p = { wMm: 297, hMm: 210 };
    expect(withOrientation(p, "landscape")).toBe(p);
  });

  it("ölçü yazımı: virgül, nokta, birim, eksi", () => {
    expect(parseMmText("28,5")).toBe(28.5);
    expect(parseMmText("28.5 mm")).toBe(28.5);
    expect(parseMmText("-3°")).toBe(-3);
    expect(parseMmText("1.250,5")).toBe(1250.5);
    expect(parseMmText("")).toBeNull();
    expect(parseMmText("-")).toBeNull();
    expect(parseMmText("abc")).toBeNull();
  });
});
