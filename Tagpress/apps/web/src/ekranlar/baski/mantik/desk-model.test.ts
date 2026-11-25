import { type PrintItem, type PrintSessionDetail as PrintSessionFull, type PrintTemplate, PrintTemplateSchema } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import {
  addPage,
  arrangeItems,
  artBox,
  boardLayout,
  cellLabels,
  centerInSlot,
  diffSession,
  dropItems,
  duplicateItems,
  hitItem,
  itemsInRect,
  itemSize,
  nudgeItems,
  PAGE_GAP_MM,
  PAGE_HEADER_MM,
  pageAt,
  placedByJob,
  placeFromShelf,
  releaseFromSlot,
  removeItems,
  removePage,
  updatePage,
} from "./desk-model.ts";
import { generateGrid } from "./grid.ts";

// 3 × 2 yuva, çap 40, adım 50 × 50, ilk merkez (30, 30).
const T: PrintTemplate = PrintTemplateSchema.parse({
  id: "t1",
  languageId: "l",
  name: "3.8 A4",
  kind: "label",
  paper: { wMm: 210, hMm: 297 },
  sizeId: "3.8",
  slots: generateGrid({ paper: { wMm: 210, hMm: 297 }, columns: 3, rows: 2, diameterMm: 40, pitchXMm: 50, pitchYMm: 50, marginLeftMm: 10, marginTopMm: 10 }).slots,
  createdAt: "2026-10-09T00:00:00Z",
  updatedAt: "2026-10-09T00:00:00Z",
});
const templates = new Map([[T.id, T]]);

const item = (id: string, pageId: string, slotId: string | null, x: number, y: number, jobId = "j1"): PrintItem => ({
  id,
  pageId,
  jobId,
  variantId: `v-${jobId}`,
  slotId,
  xMm: x,
  yMm: y,
  rotation: 0,
  scale: 1,
  extra: false,
  manual: false,
  z: 0,
});

function session(items: PrintItem[] = [], pages = ["p1"]): PrintSessionFull {
  return {
    id: "o1",
    languageId: "l",
    name: "Baskı",
    status: "draft",
    notices: [],
    version: 3,
    createdAt: "",
    updatedAt: "",
    printedAt: null,
    templateId: "t1",
    sourceSessionId: null,
    jobIds: [],
    pages: pages.map((id, index) => ({ id, sessionId: "o1", templateId: "t1", index, name: `S${index + 1}`, copies: 1, kind: "manual", showCellLabels: true, locked: false, items: items.filter((i) => i.pageId === id) })),
  };
}
let n = 0;
const ids = () => `n${++n}`;

describe("raftan yerleştirme", () => {
  it("en yakın boş yuvaya yapışır", () => {
    const s = session([item("a", "p1", "s1", 30, 30)]);
    const r = placeFromShelf(s, T, { pageId: "p1", point: { x: 33, y: 28 }, jobId: "j2", variantId: "v2", count: 1, free: false, quantity: 10, placed: 0 }, ids);
    expect(r.added).toHaveLength(1);
    const added = r.session.pages[0]!.items.find((i) => i.id === r.added[0])!;
    expect(added).toMatchObject({ slotId: "s2", xMm: 80, yMm: 30, manual: true, extra: false });
  });

  it("Shift: kalan adedi okuma sırasıyla doldurur, sığmayanı söyler; fazlalık işaretlenir", () => {
    const s = session();
    const r = placeFromShelf(s, T, { pageId: "p1", point: { x: 80, y: 80 }, jobId: "j1", variantId: "v1", count: 9, free: false, quantity: 4, placed: 1 }, ids);
    expect(r.added).toHaveLength(6);
    expect(r.short).toBe(3);
    const its = r.session.pages[0]!.items;
    expect(its.map((i) => i.slotId)).toEqual(["s5", "s6", "s1", "s2", "s3", "s4"]);
    expect(its.map((i) => i.extra)).toEqual([false, false, false, true, true, true]);
  });

  it("Alt: serbest konum; dolu sayfa: hiçbir şey eklenmez", () => {
    const s = session();
    const free = placeFromShelf(s, T, { pageId: "p1", point: { x: 12.345, y: 200 }, jobId: "j1", variantId: "v1", count: 1, free: true, quantity: 1, placed: 0 }, ids);
    expect(free.session.pages[0]!.items[0]).toMatchObject({ slotId: null, xMm: 12.35, yMm: 200 });
    const full = session(T.slots.map((sl, i) => item(`i${i}`, "p1", sl.id, sl.cx, sl.cy)));
    const r = placeFromShelf(full, T, { pageId: "p1", point: { x: 30, y: 30 }, jobId: "j9", variantId: "v9", count: 1, free: false, quantity: 1, placed: 0 }, ids);
    expect(r.added).toEqual([]);
    expect(r.session).toBe(full);
  });
});

describe("sürükleyip bırakma", () => {
  it("boş yuvaya bırakınca o yuvaya oturur", () => {
    const s = session([item("a", "p1", "s1", 30, 30)]);
    const next = dropItems(s, [{ id: "a", pageId: "p1", x: 128, y: 82 }], templates, false);
    expect(next.pages[0]!.items[0]).toMatchObject({ slotId: "s6", xMm: 130, yMm: 80, manual: true });
  });

  it("dolu yuvaya bırakınca iki öğe yer değiştirir", () => {
    const s = session([item("a", "p1", "s1", 30, 30), item("b", "p1", "s2", 80, 30, "j2")]);
    const next = dropItems(s, [{ id: "a", pageId: "p1", x: 81, y: 31 }], templates, false);
    const by = new Map(next.pages[0]!.items.map((i) => [i.id, i]));
    expect(by.get("a")).toMatchObject({ slotId: "s2", xMm: 80 });
    expect(by.get("b")).toMatchObject({ slotId: "s1", xMm: 30 });
  });

  it("Alt ile serbest; yuvadan uzakta serbest kalır", () => {
    const s = session([item("a", "p1", "s1", 30, 30)]);
    expect(dropItems(s, [{ id: "a", pageId: "p1", x: 81, y: 31 }], templates, true).pages[0]!.items[0]).toMatchObject({ slotId: null, xMm: 81, yMm: 31 });
    expect(dropItems(s, [{ id: "a", pageId: "p1", x: 150, y: 250 }], templates, false).pages[0]!.items[0]).toMatchObject({ slotId: null, xMm: 150, yMm: 250 });
  });

  it("başka sayfaya taşıma; çoklu taşımada her biri ayrı boş yuvaya", () => {
    const s = session([item("a", "p1", "s1", 30, 30), item("b", "p1", "s2", 80, 30)], ["p1", "p2"]);
    const next = dropItems(
      s,
      [
        { id: "a", pageId: "p2", x: 30, y: 30 },
        { id: "b", pageId: "p2", x: 32, y: 30 },
      ],
      templates,
      false,
    );
    expect(next.pages[0]!.items).toEqual([]);
    const p2 = next.pages[1]!.items;
    expect(p2.map((i) => i.pageId)).toEqual(["p2", "p2"]);
    expect(new Set(p2.map((i) => i.slotId)).size).toBe(2);
  });
});

describe("it, sil, çoğalt, hizala", () => {
  it("ok tuşuyla it: yuva içinde ince ayar (öğe yuvasında kalır, ofsetli); merkezi yuvadan çıkınca serbest", () => {
    const s = session([item("a", "p1", "s1", 30, 30)]);
    expect(nudgeItems(s, new Set(["a"]), 0.1, 0, templates).pages[0]!.items[0]).toMatchObject({ slotId: "s1", xMm: 30.1, yMm: 30, manual: true });
    // Yuvanın (çap 40) dışına itilen merkez: yuvadan çıkar.
    expect(nudgeItems(s, new Set(["a"]), 21, 0, templates).pages[0]!.items[0]).toMatchObject({ slotId: null, xMm: 51 });
  });

  it("yuvanın merkezine al / yuvadan çıkar", () => {
    const s = nudgeItems(session([item("a", "p1", "s1", 30, 30), item("b", "p1", "s2", 80, 30)]), new Set(["a", "b"]), 1, -1, templates);
    const c = centerInSlot(s, new Set(["a"]), templates);
    expect(c.pages[0]!.items.map((i) => [i.slotId, i.xMm, i.yMm])).toEqual([["s1", 30, 30], ["s2", 81, 29]]);
    const r = releaseFromSlot(s, new Set(["b"]));
    expect(r.pages[0]!.items[1]).toMatchObject({ slotId: null, xMm: 81, yMm: 29, manual: true });
  });

  it("ince ayarlı öğe dolu yuvaya bırakılınca yerinden edilen eski yuvanın merkezine geçer", () => {
    const s = nudgeItems(session([item("a", "p1", "s1", 30, 30), item("b", "p1", "s2", 80, 30, "j2")]), new Set(["a"]), 2, 2, templates);
    const next = dropItems(s, [{ id: "a", pageId: "p1", x: 81, y: 31 }], templates, false);
    const by = new Map(next.pages[0]!.items.map((i) => [i.id, i]));
    expect(by.get("a")).toMatchObject({ slotId: "s2", xMm: 80, yMm: 30 });
    expect(by.get("b")).toMatchObject({ slotId: "s1", xMm: 30, yMm: 30 });
  });

  it("hizalamada yerinden oynamayan öğe yuvasında kalır", () => {
    const s = session([item("a", "p1", "s1", 30, 30), item("b", "p1", "s4", 30, 80)]);
    const r = arrangeItems(s, new Set(["a", "b"]), templates, { align: "left" });
    expect(r.pages[0]!.items.map((i) => i.slotId)).toEqual(["s1", "s4"]);
  });

  it("sil ve çoğalt (kopya en yakın boş yuvaya)", () => {
    const s = session([item("a", "p1", "s1", 30, 30), item("b", "p1", "s2", 80, 30)]);
    expect(removeItems(s, new Set(["a"])).pages[0]!.items.map((i) => i.id)).toEqual(["b"]);
    const d = duplicateItems(s, new Set(["a"]), templates, () => "c");
    expect(d.added).toEqual(["c"]);
    expect(d.session.pages[0]!.items.find((i) => i.id === "c")).toMatchObject({ slotId: "s4", jobId: "j1" });
  });

  it("hizala: çoklu seçimde birbirine, tekte kağıda", () => {
    const s = session([item("a", "p1", null, 20, 30), item("b", "p1", null, 100, 60)]);
    const left = arrangeItems(s, new Set(["a", "b"]), templates, { align: "left" });
    expect(left.pages[0]!.items.map((i) => i.xMm)).toEqual([20, 20]);
    const one = arrangeItems(s, new Set(["b"]), templates, { align: "hcenter" });
    expect(one.pages[0]!.items[1]!.xMm).toBe(105);
  });
});

describe("sayfalar ve fark → toplu yama", () => {
  it("sayfa ekle / güncelle / sil", () => {
    const s = session();
    const a = addPage(s, "t1", { id: "p2" });
    expect(a.session.pages[1]).toMatchObject({ id: "p2", index: 1, items: [], copies: 1 });
    expect(updatePage(a.session, "p2", { copies: 3 }).pages[1]!.copies).toBe(3);
    expect(removePage(a.session, "p2").pages).toHaveLength(1);
  });

  it("değişiklik yoksa yama yok", () => {
    const s = session([item("a", "p1", "s1", 30, 30)]);
    expect(diffSession(s, s)).toEqual([]);
  });

  it("öğe ekleme, taşıma, silme, güncelleme ve sayfa işlemleri doğru sırada", () => {
    const prev = session([item("a", "p1", "s1", 30, 30), item("b", "p1", "s2", 80, 30)]);
    let next = removeItems(prev, new Set(["b"]));
    next = dropItems(next, [{ id: "a", pageId: "p1", x: 130, y: 80 }], templates, false);
    next = placeFromShelf(next, T, { pageId: "p1", point: { x: 30, y: 30 }, jobId: "j3", variantId: "v3", count: 1, free: false, quantity: 1, placed: 0 }, () => "c").session;
    next = updatePage(next, "p1", { copies: 2, locked: true });
    next = { ...next, name: "Yeni ad" };
    const ops = diffSession(prev, next);
    expect(ops.map((o) => o.op)).toEqual(["renameSession", "removeItem", "updatePage", "moveItem", "addItem"]);
    expect(ops.find((o) => o.op === "moveItem")).toEqual({ op: "moveItem", itemId: "a", slotId: "s6", xMm: 130, yMm: 80, manual: true });
    expect(ops.find((o) => o.op === "updatePage")).toEqual({ op: "updatePage", pageId: "p1", copies: 2, locked: true });
    expect(ops.find((o) => o.op === "addItem")).toMatchObject({ op: "addItem", id: "c", pageId: "p1", jobId: "j3", variantId: "v3", slotId: "s1" });
  });

  it("sayfa silme öğelerini ayrıca silmez; yeni sayfa önce eklenir, öğeleri sonra", () => {
    const prev = session([item("a", "p1", "s1", 30, 30)], ["p1", "p2"]);
    expect(diffSession(prev, removePage(prev, "p1")).map((o) => o.op)).toEqual(["removePage"]);
    const added = addPage(prev, "t1", { id: "p3" }).session;
    const withItem = placeFromShelf(added, T, { pageId: "p3", point: { x: 0, y: 0 }, jobId: "j1", variantId: "v1", count: 1, free: false, quantity: 1, placed: 0 }, () => "x").session;
    expect(diffSession(prev, withItem).map((o) => o.op)).toEqual(["addPage", "updatePage", "addItem"]);
  });

  it("geri alma da fark olarak gider (silinen öğe yeniden eklenir)", () => {
    const prev = session([item("a", "p1", "s1", 30, 30)]);
    const cur = removeItems(prev, new Set(["a"]));
    // Planlayıcının koyduğu öğe (manual false) geri gelirken de plan öğesi kalır.
    expect(diffSession(cur, prev)).toEqual([expect.objectContaining({ op: "addItem", id: "a", slotId: "s1", manual: false })]);
    // Ok tuşuyla itilen plan öğesinin geri alınması: konum ve "elle değil" bayrağı birlikte döner.
    const pushed = nudgeItems(prev, new Set(["a"]), 0.5, 0, templates);
    expect(diffSession(pushed, prev)).toEqual([{ op: "moveItem", itemId: "a", slotId: "s1", xMm: 30, yMm: 30, manual: false }]);
  });
});

describe("masa düzeni, isabet, sayaçlar, hücre etiketleri", () => {
  it("sayfalar satır satır; başlık payı ve boşluk", () => {
    const l = boardLayout(
      [
        { id: "a", wMm: 210, hMm: 297 },
        { id: "b", wMm: 210, hMm: 297 },
        { id: "c", wMm: 297, hMm: 210 },
      ],
      2,
    );
    expect(l.get("a")).toEqual({ x: 0, y: PAGE_HEADER_MM, w: 210, h: 297 });
    expect(l.get("b")!.x).toBe(210 + PAGE_GAP_MM);
    expect(l.get("c")!.y).toBe(PAGE_HEADER_MM + 297 + PAGE_GAP_MM + PAGE_HEADER_MM);
    expect(pageAt(l, { x: 215 + PAGE_GAP_MM, y: 20 })).toEqual({ pageId: "b", local: { x: 5, y: 20 - PAGE_HEADER_MM } });
    expect(pageAt(l, { x: 212, y: 20 })).toBeNull();
  });

  it("öğe isabeti (daire) ve kutu seçimi", () => {
    const s = session([item("a", "p1", "s1", 30, 30)]);
    const page = s.pages[0]!;
    expect(itemSize(page.items[0]!, T)).toEqual({ w: 40, h: 40 });
    expect(hitItem(page, T, { x: 45, y: 30 })?.id).toBe("a");
    expect(hitItem(page, T, { x: 49, y: 49 })).toBeNull();
    const layout = new Map([["p1", { x: 100, y: 100, w: 210, h: 297 }]]);
    expect(itemsInRect(s, layout, templates, { x: 100, y: 100, w: 15, h: 15 })).toEqual(["a"]);
    expect(itemsInRect(s, layout, templates, { x: 0, y: 0, w: 50, h: 50 })).toEqual([]);
  });

  it("sticker: ölçü sunucudan (mürekkep kutusu), görsel kutusu mürekkep merkezine göre; yuvasız sayfada raftan bırakma serbest", () => {
    const ST = PrintTemplateSchema.parse({ ...T, id: "t2", kind: "sticker", slots: [], stickerFlow: { marginTopMm: 8, marginBottomMm: 8, marginSideMm: 7, minGapXMm: 5, minRowGapMm: 4, maxRowGapLastMm: 6 } });
    const sizes = new Map([["v-j1", { wMm: 60, hMm: 20, art: { xMm: -70, yMm: -80, wMm: 155, hMm: 155 } }]]);
    const it0 = item("a", "p1", null, 100, 50);
    expect(itemSize(it0, ST, sizes)).toEqual({ w: 60, h: 20 });
    expect(itemSize(it0, ST)).toEqual({ w: 40, h: 40 });
    expect(artBox(it0, ST, sizes)).toEqual({ x: -70, y: -80, w: 155, h: 155 });
    expect(artBox(it0, T, sizes)).toEqual({ x: -20, y: -20, w: 40, h: 40 });
    const s = session();
    const r = placeFromShelf(s, ST, { pageId: "p1", point: { x: 50, y: 60 }, jobId: "j1", variantId: "v-j1", count: 5, free: false, quantity: 5, placed: 0 }, () => "st");
    expect(r.session.pages[0]!.items).toEqual([expect.objectContaining({ id: "st", slotId: null, xMm: 50, yMm: 60 })]);
  });

  it("yerleşen sayısı kopyaları sayar", () => {
    const s = updatePage(session([item("a", "p1", "s1", 30, 30), item("b", "p1", "s2", 80, 30)]), "p1", { copies: 3 });
    expect(placedByJob(s).get("j1")).toBe(6);
    expect(placedByJob(null).size).toBe(0);
  });

  it("hücre etiketi: siparişin ilk yuvasında; satırın en sağındaysa bir soldakine göre; kapalı sayfada yok", () => {
    const s = session([item("a", "p1", "s3", 130, 30, "j1"), item("b", "p1", "s2", 80, 30, "j1"), item("c", "p1", "s4", 30, 80, "j2")]);
    const orders = new Map([
      ["j1", { orderNo: "4849", quantity: 36 }],
      ["j2", { orderNo: "4850", quantity: 12 }],
    ]);
    const labels = cellLabels(s.pages[0]!, T, orders);
    expect(labels.map((l) => l.text)).toEqual(["4849_36adet", "4850_12adet"]);
    // j1'in ilk yuvası s2 (80,30): sağ alt köşe (100, 50) + dx/dy.
    expect(labels[0]!.xMm).toBeCloseTo(100 + T.cellLabel.dxMm, 6);
    expect(labels[0]!.yMm).toBeCloseTo(50 + T.cellLabel.dyMm, 6);
    expect(cellLabels(updatePage(s, "p1", { showCellLabels: false }).pages[0]!, T, orders)).toEqual([]);
  });
});
