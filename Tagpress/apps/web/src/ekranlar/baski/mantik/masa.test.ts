import { type PrintItem, type PrintSessionDetail, type PrintTemplate, PrintTemplateSchema, type PrintTemplateView } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import "../../../i18n/test.ts";
import { boardLayout, PAGE_HEADER_MM } from "./desk-model.ts";
import { generateGrid } from "./grid.ts";
import {
  addTargetOf,
  boardBounds,
  canAddTo,
  dpiInput,
  dropGhost,
  editableIds,
  escapeStep,
  exportKey,
  exportPhase,
  exportProgress,
  exportRequest,
  filterShelf,
  hiddenDoneCount,
  itemCount,
  itemSizesMap,
  keyboardDropPoint,
  layoutKey,
  markWarnings,
  missingQuantity,
  missingQuantityCount,
  movableIds,
  moveTargets,
  pageFill,
  pageSizes,
  pickSessionId,
  remainingJobIds,
  rowState,
  selectAllIds,
  sheetCount,
  shelfDropPlan,
  shelfTotals,
  singleItem,
  skippedSummary,
  slotState,
  targetsLocked,
} from "./masa.ts";
import { groupShelf, type ShelfRow, shelfRows } from "./shelf.ts";

// 3 × 2 yuva, çap 40, adım 50 × 50, ilk merkez (30, 30) — desk-model.test.ts ile aynı şablon.
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
const STICKER: PrintTemplate = PrintTemplateSchema.parse({ ...T, id: "st", name: "Sticker A4", kind: "sticker", sizeId: null, slots: [] });
const templates = new Map([
  [T.id, T],
  [STICKER.id, STICKER],
]);

const item = (id: string, o: Partial<PrintItem> = {}): PrintItem => ({ id, pageId: "p1", jobId: "j1", variantId: "v1", slotId: null, xMm: 30, yMm: 30, rotation: 0, scale: 1, extra: false, manual: false, z: 0, ...o });

function session(pages: Array<{ id: string; templateId?: string; locked?: boolean; copies?: number; items?: PrintItem[] }>): PrintSessionDetail {
  return {
    id: "s1",
    languageId: "l",
    name: "21 Kasım oturumu",
    status: "draft",
    notices: [],
    version: 1,
    createdAt: "2026-11-21T00:00:00Z",
    updatedAt: "2026-11-21T00:00:00Z",
    printedAt: null,
    templateId: "t1",
    sourceSessionId: null,
    jobIds: [],
    pages: pages.map((p, i) => ({
      id: p.id,
      sessionId: "s1",
      templateId: p.templateId ?? "t1",
      index: i,
      name: `Sayfa ${i + 1}`,
      copies: p.copies ?? 1,
      kind: "manual",
      showCellLabels: true,
      locked: p.locked ?? false,
      items: (p.items ?? []).map((it) => ({ ...it, pageId: p.id })),
    })),
  } as PrintSessionDetail;
}

const row = (jobId: string, o: Partial<ShelfRow> = {}): ShelfRow => ({
  jobId,
  variantId: `v${jobId}`,
  orderNo: jobId,
  kind: "label",
  sizeId: "3.8",
  quantity: 4,
  needed: 4,
  placed: 0,
  designKey: null,
  previewUrl: `/p/${jobId}`,
  product: null,
  placedNow: 0,
  remaining: 4,
  ...o,
});

let n = 0;
const ids = () => `n${++n}`;

describe("oturum", () => {
  it("açılacak taslak: adres, sonra hatırlanan (hâlâ taslaksa), sonra ilk", () => {
    const drafts = [{ id: "a" }, { id: "b" }];
    expect(pickSessionId("x", drafts, "b")).toBe("x");
    expect(pickSessionId(null, drafts, "b")).toBe("b");
    expect(pickSessionId(null, drafts, "silinmis")).toBe("a");
    expect(pickSessionId(undefined, [], "b")).toBeNull();
  });

  it("kağıt ve etiket sayısı, planın şablonu ve 'Oturuma ekle' hedefi", () => {
    const s = session([
      { id: "p1", copies: 3, items: [item("a"), item("b")] },
      { id: "p2", items: [item("c")] },
    ]);
    expect(sheetCount(s)).toBe(4);
    expect(itemCount(s)).toBe(3);
    expect(addTargetOf(s, templates, false)).toEqual({ kind: "label", sizeId: "3.8", name: "21 Kasım oturumu" });
    expect(addTargetOf(s, templates, true)).toBeNull();
    expect(addTargetOf(null, templates, false)).toBeNull();
    // Planın şablonu yoksa ilk sayfanınki.
    expect(addTargetOf({ ...s, templateId: null, pages: s.pages.map((p) => ({ ...p, templateId: "st" })) }, templates, false)?.kind).toBe("sticker");
  });

  it("'Oturuma ekle': tür aynı, boyut aynı ya da plan boyutsuz, kalan var", () => {
    const g = { kind: "label" as const, sizeId: "3.8", remaining: 5 };
    expect(canAddTo({ kind: "label", sizeId: "3.8", name: "x" }, g)).toBe(true);
    expect(canAddTo({ kind: "label", sizeId: null, name: "x" }, g)).toBe(true);
    expect(canAddTo({ kind: "label", sizeId: "5.2", name: "x" }, g)).toBe(false);
    expect(canAddTo({ kind: "sticker", sizeId: null, name: "x" }, g)).toBe(false);
    expect(canAddTo({ kind: "label", sizeId: "3.8", name: "x" }, { ...g, remaining: 0 })).toBe(false);
    expect(canAddTo(null, g)).toBe(false);
  });

  it("kayıt işareti uyarısı yalnız oturumda kullanılan şablonlar için", () => {
    const view = (id: string, overlap: boolean) => ({ id, name: id.toUpperCase(), warnings: overlap ? [{ code: "mark-overlap" }] : [] }) as unknown as PrintTemplateView;
    const s = session([{ id: "p1" }]);
    expect(markWarnings(s, [view("t1", true), view("t9", true), view("st", false)])).toEqual([{ id: "t1", name: "T1" }]);
    expect(markWarnings(null, [view("t1", true)])).toEqual([]);
  });
});

describe("raf", () => {
  const groups = groupShelf(
    shelfRows(
      [
        { ...row("9019"), placed: 0 },
        { ...row("9012"), placed: 0 },
        { ...row("9001"), needed: 2, quantity: 2 },
        { ...row("9002"), quantity: 0, needed: 0, quantityMissing: true },
      ],
      new Map(),
      new Map([["9001", 2]]),
    ),
  );

  it("yalnızca kalanlar ve sipariş no araması; dizilmiş işler tek satırda sayılır", () => {
    const only = filterShelf(groups, { query: "", onlyRemaining: true });
    expect(only[0]!.rows.map((r) => r.jobId)).toEqual(["9002", "9012", "9019"]);
    expect(hiddenDoneCount(groups, { query: "", onlyRemaining: true })).toBe(1);
    expect(hiddenDoneCount(groups, { query: "", onlyRemaining: false })).toBe(0);
    expect(hiddenDoneCount(groups, { query: "901", onlyRemaining: true })).toBe(0);
    expect(filterShelf(groups, { query: " 9001 ", onlyRemaining: false })[0]!.rows.map((r) => r.jobId)).toEqual(["9001"]);
    expect(filterShelf(groups, { query: "yok", onlyRemaining: false })).toEqual([]);
  });

  it("sayılar: sipariş, kalan, adetsiz, Planla'ya giden işler, kart durumu", () => {
    expect(shelfTotals(groups)).toEqual({ orders: 4, remaining: 8 });
    expect(missingQuantityCount(groups[0]!)).toBe(1);
    expect(remainingJobIds(groups[0]!)).toEqual(["9012", "9019"]);
    expect(groups[0]!.rows.map(rowState)).toEqual(["done", "missing", "open", "open"]);
  });
});

describe("raftan sayfaya", () => {
  it("tek etiket en yakın boş yuvaya; Shift kalanların hepsi okuma sırasıyla, sığmayan sayılır", () => {
    const s = session([{ id: "p1", items: [item("a", { slotId: "s1", xMm: 30, yMm: 30 })] }]);
    const one = shelfDropPlan(s, templates, { pageId: "p1", point: { x: 82, y: 78 }, row: row("9019"), shift: false, alt: false }, ids);
    expect(one.ok && one.added.length).toBe(1);
    expect(one.ok && one.session.pages[0]!.items.at(-1)?.slotId).toBe("s5");
    const all = shelfDropPlan(s, templates, { pageId: "p1", point: { x: 82, y: 30 }, row: row("9019", { remaining: 7 }), shift: true, alt: false }, ids);
    expect(all.ok && all.added.length).toBe(5);
    expect(all.ok && all.short).toBe(2);
    // Shift yoksa eksik sayılmaz.
    expect(one.ok && one.short).toBe(0);
  });

  it("Alt yuvaya yapışmadan serbest konuma koyar", () => {
    const s = session([{ id: "p1" }]);
    const r = shelfDropPlan(s, templates, { pageId: "p1", point: { x: 100, y: 200 }, row: row("9019"), shift: false, alt: true }, ids);
    expect(r.ok && r.session.pages[0]!.items[0]).toMatchObject({ slotId: null, xMm: 100, yMm: 200, manual: true });
  });

  it("kilitli, türü uymayan ve dolu sayfa reddedilir", () => {
    const full = session([{ id: "p1", items: T.slots.map((sl, i) => item(`x${i}`, { slotId: sl.id, xMm: sl.cx, yMm: sl.cy })) }, { id: "p2", locked: true }, { id: "p3", templateId: "st" }]);
    const d = (pageId: string, r = row("9019")) => shelfDropPlan(full, templates, { pageId, point: { x: 30, y: 30 }, row: r, shift: false, alt: false }, ids);
    expect(d("p1")).toEqual({ ok: false, reason: "no-free-slot" });
    expect(d("p2")).toEqual({ ok: false, reason: "locked" });
    expect(d("p3")).toEqual({ ok: false, reason: "label-on-sticker" });
    expect(d("p1", row("s1", { kind: "sticker" }))).toEqual({ ok: false, reason: "sticker-on-label" });
    expect(d("yok")).toEqual({ ok: false, reason: "no-page" });
  });

  it("fazlalık işareti: siparişin adedinden sonrakiler 'fazla'", () => {
    const s = session([{ id: "p1" }]);
    const r = shelfDropPlan(s, templates, { pageId: "p1", point: { x: 30, y: 30 }, row: row("9019", { quantity: 2, placedNow: 1, remaining: 3 }), shift: true, alt: false }, ids);
    expect(r.ok && r.session.pages[0]!.items.map((i) => i.extra)).toEqual([false, true, true]);
  });

  it("klavyeyle koyma noktası: okuma sırasındaki ilk boş yuva; yuvasız sayfada orta", () => {
    const s = session([{ id: "p1", items: [item("a", { slotId: "s1" })] }, { id: "p2", templateId: "st" }]);
    expect(keyboardDropPoint(s.pages[0], T)).toEqual({ x: 80, y: 30 });
    expect(keyboardDropPoint(s.pages[1], STICKER)).toEqual({ x: 105, y: 148.5 });
    expect(keyboardDropPoint(undefined, T)).toBeNull();
  });

  it("sürüklerken hayalet: en yakın boş yuvanın merkezi (masa mm); Alt ile imleç; kilitli ve türü uymayan sayfada yok", () => {
    const s = session([{ id: "p1", items: [item("a", { slotId: "s1" })] }, { id: "p2", locked: true }, { id: "p3", templateId: "st" }]);
    const layout = boardLayout(pageSizes(s.pages, templates), 3);
    const at = layout.get("p1")!;
    const g = dropGhost(s, layout, templates, new Map(), { x: at.x + 33, y: at.y + 31 }, row("9019"), false);
    expect(g).toEqual({ pageId: "p1", x: at.x + 80, y: at.y + 30, w: 40, h: 40 });
    expect(dropGhost(s, layout, templates, new Map(), { x: at.x + 33, y: at.y + 31 }, row("9019"), true)).toMatchObject({ x: at.x + 33, y: at.y + 31 });
    const p2 = layout.get("p2")!;
    expect(dropGhost(s, layout, templates, new Map(), { x: p2.x + 30, y: p2.y + 30 }, row("9019"), false)).toBeNull();
    const p3 = layout.get("p3")!;
    expect(dropGhost(s, layout, templates, new Map(), { x: p3.x + 30, y: p3.y + 30 }, row("9019"), false)).toBeNull();
    // Sticker sayfasında raf satırının mürekkep ölçüsü.
    expect(dropGhost(s, layout, templates, new Map(), { x: p3.x + 30, y: p3.y + 30 }, row("k", { kind: "sticker", wMm: 50, hMm: 30 }), false)).toMatchObject({ w: 50, h: 30 });
    expect(dropGhost(s, layout, templates, new Map(), { x: -500, y: -500 }, row("9019"), false)).toBeNull();
  });
});

describe("tuvalde taşıma", () => {
  const s = session([
    { id: "p1", items: [item("a", { xMm: 30, yMm: 30 }), item("b", { xMm: 80, yMm: 30 })] },
    { id: "p2", locked: true, items: [item("c")] },
  ]);
  const layout = boardLayout(pageSizes(s.pages, templates), 2);

  it("her öğe kendi merkezinin düştüğü sayfaya; dışarı düşen imlecin sayfasına göre", () => {
    const p2 = layout.get("p2")!;
    const dx = p2.x - layout.get("p1")!.x;
    const t = moveTargets(s, layout, ["a", "b"], dx, 0, "p2");
    expect(t).toEqual([
      { id: "a", pageId: "p2", x: 30, y: 30 },
      { id: "b", pageId: "p2", x: 80, y: 30 },
    ]);
    expect(targetsLocked(s, t)).toBe(true);
    const out = moveTargets(s, layout, ["a"], 0, -100, "p1");
    expect(out).toEqual([{ id: "a", pageId: "p1", x: 30, y: -70 }]);
    expect(targetsLocked(s, out)).toBe(false);
  });

  it("kilitli sayfadakiler taşınmaz, basılmış oturumda hiçbiri", () => {
    expect(movableIds(s, ["a", "c", "yok"], false)).toEqual(["a"]);
    expect(movableIds(s, ["a"], true)).toEqual([]);
  });
});

describe("seçim şeridi", () => {
  const s = session([
    { id: "p1", items: [item("a", { slotId: "s1", xMm: 30, yMm: 30 }), item("b", { slotId: "s2", xMm: 81, yMm: 30 }), item("f", { xMm: 150, yMm: 200 })] },
    { id: "p2", locked: true, items: [item("c", { slotId: "s1" })] },
  ]);

  it("hedef: kilitsiz sayfadaki seçili öğeler", () => {
    expect([...editableIds(s, ["a", "c"])]).toEqual(["a"]);
    expect(editableIds(null, ["a"]).size).toBe(0);
  });

  it("yuvaya al yalnız kaymış öğe varken, yuvadan çıkar yuvadaki öğe varken", () => {
    expect(slotState(s, new Set(["a"]), templates)).toEqual({ any: true, offset: false });
    expect(slotState(s, new Set(["b"]), templates)).toEqual({ any: true, offset: true });
    expect(slotState(s, new Set(["f"]), templates)).toEqual({ any: false, offset: false });
  });

  it("Ctrl A etkin sayfayla sınırlı; Enter tek seçimde; Esc önce seçim sonra sayfa", () => {
    expect(selectAllIds(s, "p1")).toEqual(["a", "b", "f"]);
    expect(selectAllIds(s, null)).toEqual(["a", "b", "f", "c"]);
    expect(singleItem(s, ["b"])?.id).toBe("b");
    expect(singleItem(s, ["a", "b"])).toBeNull();
    expect(singleItem(s, ["yok"])).toBeNull();
    expect(escapeStep(2, "p1")).toBe("selection");
    expect(escapeStep(0, "p1")).toBe("page");
    expect(escapeStep(0, null)).toBe("none");
  });
});

describe("sayfalar ve masa", () => {
  it("ölçüler (bilinmeyen şablon A4), düzen anahtarı, sığdırma dikdörtgeni başlık payıyla", () => {
    const s = session([{ id: "p1" }, { id: "p2", templateId: "yok" }]);
    const sizes = pageSizes(s.pages, templates);
    expect(sizes).toEqual([
      { id: "p1", wMm: 210, hMm: 297 },
      { id: "p2", wMm: 210, hMm: 297 },
    ]);
    expect(layoutKey(sizes)).toBe("p1:210x297|p2:210x297");
    const b = boardBounds(boardLayout(sizes, 2));
    expect(b).toEqual({ x: 0, y: 0, w: 210 * 2 + 24, h: 297 + PAGE_HEADER_MM });
    expect(boardBounds(new Map())).toBeNull();
  });

  it("doluluk: yuvasız (sticker) sayfada kapasite yok, '0/0 dolu' yazılmaz", () => {
    expect(pageFill({ items: [item("a"), item("b", { extra: true })] }, T)).toEqual({ count: 2, capacity: 6, extras: 1 });
    expect(pageFill({ items: [] }, STICKER)).toEqual({ count: 0, capacity: null, extras: 0 });
    expect(pageFill({ items: [item("a")] }, undefined).capacity).toBeNull();
  });

  it("sticker ölçüleri: raftaki mürekkep kutusu, oturumdaki (görsel kutulu) önce gelir", () => {
    const m = itemSizesMap(
      [
        { variantId: "v1", wMm: 50, hMm: 30 },
        { variantId: "v2", wMm: 10, hMm: 10 },
        { variantId: "v3" },
      ],
      { v2: { wMm: 12, hMm: 11, art: { xMm: -6, yMm: -6, wMm: 12, hMm: 12 } } },
    );
    expect(m.get("v1")).toEqual({ wMm: 50, hMm: 30, art: null });
    expect(m.get("v2")?.wMm).toBe(12);
    expect(m.has("v3")).toBe(false);
  });
});

describe("planlama yanıtları", () => {
  it("atlananların özeti ve adedi olmayan siparişler", () => {
    const skipped = [
      { jobId: "1", reason: "4849: adet yok" },
      { jobId: "2", reason: "4850: şablona uymuyor" },
      { jobId: "3", reason: "4851: adet yok" },
      { jobId: "4", reason: "x" },
    ];
    expect(skippedSummary(skipped)).toEqual({ count: 4, reasons: ["4849: adet yok", "4850: şablona uymuyor", "4851: adet yok"] });
    expect(missingQuantity(skipped)).toEqual({ count: 2, orders: ["4849", "4851"] });
    expect(skippedSummary(undefined)).toEqual({ count: 0, reasons: [] });
  });
});

describe("dosya", () => {
  const base = { format: "pdf" as const, pdfMode: "vector" as const, scope: "all" as const, pageId: "p3", dpi: null };

  it("'Dosyayı üret' isteğinin gövdesi", () => {
    expect(exportRequest(base)).toEqual({ format: "pdf", pages: undefined, dpi: undefined, pdfMode: "vector" });
    expect(exportRequest({ ...base, format: "png", scope: "page", dpi: 600 })).toEqual({ format: "png", pages: ["p3"], dpi: 600 });
    // Seçili sayfa yoksa bütün sayfalar.
    expect(exportRequest({ ...base, scope: "page", pageId: null }).pages).toBeUndefined();
  });

  it("seçenek imzası yalnız sonucu değiştiren alanlarla değişir", () => {
    expect(exportKey(base)).toBe(exportKey({ ...base, pageId: "p9" }));
    expect(exportKey({ ...base, format: "png" })).toBe(exportKey({ ...base, format: "png", pdfMode: "raster" }));
    expect(exportKey({ ...base, scope: "page" })).not.toBe(exportKey({ ...base, scope: "page", pageId: "p9" }));
    expect(exportKey(base)).not.toBe(exportKey({ ...base, dpi: 300 }));
  });

  it("çözünürlük alanı: tasarım dilindekiyle aynı ya da 72'den küçük değer 'tasarım dilindeki' sayılır", () => {
    expect(dpiInput(600, 300)).toBe(600);
    expect(dpiInput(299.6, 300)).toBeNull();
    expect(dpiInput(50, 300)).toBeNull();
    expect(dpiInput(null, 300)).toBeNull();
    expect(dpiInput(450.4, null)).toBe(450);
  });

  it("üretimin evresi ve ilerlemesi", () => {
    expect(exportPhase(null, undefined)).toBe("idle");
    expect(exportPhase("e1", undefined)).toBe("running");
    expect(exportPhase("e1", { status: "running", files: [] })).toBe("running");
    expect(exportPhase("e1", { status: "done", files: [{ name: "a.pdf", url: "/a", bytes: 1 }] })).toBe("done");
    expect(exportPhase("e1", { status: "done", files: [] })).toBe("failed");
    expect(exportPhase("e1", { status: "interrupted", files: [] })).toBe("failed");
    expect(exportProgress("running", { done: 2, total: 5 }, { done: 1, total: 5 })).toEqual({ done: 2, total: 5 });
    expect(exportProgress("done", { done: 2, total: 5 }, { done: 5, total: 5 })).toEqual({ done: 5, total: 5 });
    expect(exportProgress("idle", null, undefined)).toEqual({ done: 0, total: 0 });
  });
});
