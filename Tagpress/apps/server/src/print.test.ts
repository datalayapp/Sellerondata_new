import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_FALLBACK_FONTS_DIR, TEST_FONTS_DIR } from "@tagpress/typeset/testing";
import { generateGrid } from "./services/print/geometry.ts";
import { pageTemplateFor } from "./services/print/shelf.ts";
import type { PlannedPage, PrintPlanner, PrintRenderPage, PrintRenderer } from "./services/print/ports.ts";
import { TEST_PROFILE, type TestApp, fakeLayout, fullPorts, importJobs, makeApp, png, seedLanguage } from "./test/helpers.ts";
import type { PrintItem, PrintPageFull, PrintPreset, PrintSessionFull, PrintSessionNotice, PrintSlot, PrintTemplateView, PrintTemplateWarning, PrintExport, ServerEvent, ShelfItem } from "@tagpress/domain";
import { PrintGridSpecSchema, PrintTemplateSchema, ProfileSchema, slotFitsCut } from "@tagpress/domain";
import { clearingInset, markOverlappingSlots, registrationBoxes } from "@tagpress/print";

let t: TestApp;
let lang: string;
let rendered: PrintRenderPage[];
let renderedDpi: number[] = [];
let planCalls: { kind: string; orders: { jobId: string; quantity: number; wMm?: number }[] }[];

/** Sahte planlayıcı: her siparişe adet + 2 fazlalık; yuvaları sırayla doldurur, dolunca yeni sayfa. */
function fakePlanner(): PrintPlanner {
  return {
    planLabelPages: ({ orders, template }) => {
      planCalls.push({ kind: "label", orders: orders.map((o) => ({ jobId: o.jobId, quantity: o.quantity })) });
      const pages: PlannedPage[] = [];
      let cur: PlannedPage | null = null;
      for (const o of orders) {
        for (let i = 0; i < o.quantity + 2; i++) {
          if (!cur || cur.items.length >= template.slots.length) {
            cur = { name: `${o.orderNo}_1sayfa`, kind: "mixed", copies: 1, items: [], cellLabels: [] };
            pages.push(cur);
          }
          const slot = template.slots[cur.items.length]!;
          cur.items.push({ jobId: o.jobId, variantId: o.variantId, slotId: slot.id, xMm: slot.cx, yMm: slot.cy, extra: i >= o.quantity });
        }
      }
      return pages;
    },
    planStickerPages: ({ orders, template }) => {
      planCalls.push({ kind: "sticker", orders: orders.map((o) => ({ jobId: o.jobId, quantity: o.quantity, wMm: o.wMm })) });
      return [
        {
          name: "sticker_1sayfa",
          kind: "mixed" as const,
          copies: 1,
          items: orders.flatMap((o) => Array.from({ length: o.quantity }, (_, i) => ({ jobId: o.jobId, variantId: o.variantId, slotId: null, xMm: 20 + i * (o.wMm + 2), yMm: 20, extra: false }))),
        },
      ].filter(() => template.kind === "sticker");
    },
    neededCount: ({ quantity }) => quantity + 2,
  };
}

function fakeRenderer(): PrintRenderer {
  return {
    renderPagePng: async ({ page, dpi, widthPx }) => {
      rendered.push(page);
      renderedDpi.push(dpi);
      return png(widthPx ?? 30, 40);
    },
    renderPdf: async ({ pages, onPage }) => {
      pages.forEach((_, i) => onPage?.(i + 1, pages.length));
      return Buffer.from("%PDF-1.7 sahte");
    },
  };
}

async function approvedJobs(records: Record<string, unknown>[]) {
  const { commit } = await importJobs(t, records);
  await t.api("POST", "/api/generate", { jobIds: commit.jobIds });
  await t.ctx.queue.idle();
  await t.api("POST", "/api/jobs/approve-best", { ids: commit.jobIds });
  return commit.jobIds as string[];
}

/** 2 × 2 Ø37 yuvalı A4 etiket şablonu (ızgara). */
async function gridTemplate(over: Record<string, unknown> = {}) {
  const r = await t.api("POST", "/api/print/templates/grid", { languageId: lang, paper: { wMm: 210, hMm: 297 }, columns: 2, rows: 2, diameterMm: 37, center: true, sizeId: "3.8", ...over });
  expect(r.status).toBe(200);
  return r.json.template;
}

beforeEach(async () => {
  rendered = [];
  renderedDpi = [];
  planCalls = [];
  t = await makeApp({ ports: fullPorts({ printPlanner: fakePlanner(), printRenderer: fakeRenderer() }), startQueue: true });
  lang = await seedLanguage(t);
});
afterEach(async () => t.close());

describe("baskı şablonları", () => {
  it("elle oluştur: kimliksiz yuvalara kimlik, okuma sırası, uyarılar (taşma, çakışma) engellemez", async () => {
    const r = await t.api("POST", "/api/print/templates", {
      languageId: lang,
      name: "Elle A4",
      paper: { wMm: 210, hMm: 297 },
      slots: [
        { cx: 100, cy: 50, w: 40, h: 40 },
        { id: "sol", cx: 30, cy: 50, w: 40, h: 40 },
        { cx: 205, cy: 150, w: 20, h: 20 },
        { cx: 115, cy: 50, w: 40, h: 40 },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ source: "manual", kind: "label", capacity: 4, archived: false, cut: { outlineVisible: true, outlineWidthMm: 0.25 } });
    expect(r.json.slots.map((s: PrintSlot) => s.id)).toEqual(["sol", "s1", "s2", "s3"]);
    expect(r.json.slots.map((s: PrintSlot) => s.cx)).toEqual([30, 100, 115, 205]);
    const codes = r.json.warnings.map((w: PrintTemplateWarning) => w.code);
    expect(codes).toEqual(["slot-outside", "slot-overlap"]);
    expect(r.json.warnings[0].slotIds).toEqual(["s3"]);
    expect(r.json.warnings[1].slotIds).toEqual(["s1", "s2"]);
  });

  it("kayıt işareti yuvaya (taşma payı + 2 mm) çakışırsa mark-overlap uyarısı; kenardan pay önerisi", async () => {
    const body = { languageId: lang, name: "İşaretli", paper: { wMm: 100, hMm: 100 }, slots: [{ id: "k", cx: 12, cy: 12, w: 10, h: 10 }, { id: "o", cx: 50, cy: 50, w: 10, h: 10 }] };
    const off = await t.api("POST", "/api/print/templates", body);
    expect(off.json.warnings.map((w: PrintTemplateWarning) => w.code)).not.toContain("mark-overlap");
    const on = await t.api("POST", "/api/print/templates", { ...body, cut: { registration: { enabled: true, insetMm: 10, sizeMm: 5 } } });
    const w = on.json.warnings.find((x: PrintTemplateWarning) => x.code === "mark-overlap");
    expect(w.slotIds).toEqual(["k"]);
    // Yama ile pay 0'a çekilince uyarı gider (işaret kutusu 0–5 mm, yuva güvenli alanı 5 mm'de başlar: değme çakışma sayılmaz).
    const fixed = await t.api("PATCH", `/api/print/templates/${on.json.id}`, { cut: { registration: { insetMm: 0 } } });
    expect(fixed.json.warnings.map((x: PrintTemplateWarning) => x.code)).not.toContain("mark-overlap");
    // Taşma payı güvenli alanı büyütür.
    const bleed = await t.api("PATCH", `/api/print/templates/${on.json.id}`, { cut: { bleedMm: 4 } });
    expect(bleed.json.warnings.map((x: PrintTemplateWarning) => x.code)).toContain("mark-overlap");
  });

  it("yama derin birleşir, slots tamamen değişir; arşiv listede gizli; çoğalt; geçersiz → 400", async () => {
    const created = (await t.api("POST", "/api/print/templates", { languageId: lang, name: "A", paper: { wMm: 100, hMm: 100 }, slots: [{ cx: 50, cy: 50, w: 30, h: 30 }] })).json;
    const p = await t.api("PATCH", `/api/print/templates/${created.id}`, { cut: { outlineVisible: false, registration: { enabled: true } }, cellLabel: { sizePt: 9 } });
    expect(p.status).toBe(200);
    expect(p.json.cut).toMatchObject({ outlineVisible: false, outlineColor: "#000000", registration: { enabled: true, style: "corners-l", insetMm: 10 } });
    expect(p.json.cellLabel).toMatchObject({ sizePt: 9, color: "#1A4DB3" });
    expect(p.json.slots).toHaveLength(1);
    const p2 = await t.api("PATCH", `/api/print/templates/${created.id}`, { slots: [{ id: "x", shape: "rect", cx: 20, cy: 20, w: 10, h: 5, cornerRadius: 1 }, { cx: 60, cy: 20, w: 10, h: 10 }] });
    expect(p2.json.slots.map((s: PrintSlot) => [s.id, s.shape])).toEqual([["x", "rect"], ["s1", "circle"]]);
    expect((await t.api("PATCH", `/api/print/templates/${created.id}`, { paper: { wMm: -1, hMm: 10 } })).status).toBe(400);
    expect((await t.api("PATCH", `/api/print/templates/${created.id}`, { bilinmeyen: 1 })).status).toBe(400);

    const dup = await t.api("POST", `/api/print/templates/${created.id}/duplicate`, {});
    expect(dup.json).toMatchObject({ name: "A (kopya)", capacity: 2 });
    expect(dup.json.id).not.toBe(created.id);

    expect((await t.api("POST", `/api/print/templates/${created.id}/archive`, {})).json.archived).toBe(true);
    const list = (await t.api("GET", `/api/print/templates?languageId=${lang}`)).json.templates;
    expect(list.map((x: PrintTemplateView) => x.id)).toEqual([dup.json.id]);
    const all = (await t.api("GET", `/api/print/templates?languageId=${lang}&archived=1`)).json.templates;
    expect(all).toHaveLength(2);
    expect((await t.api("GET", `/api/print/templates?languageId=yok`)).status).toBe(404);
  });

  it("ızgara: ortala (eşit aralık), kenar + adım, boşluk, kaydırmalı dizilim, çakışma uyarısı", async () => {
    const even = generateGrid(PrintGridSpecSchema.parse({ paper: { wMm: 210, hMm: 297 }, columns: 5, rows: 7, diameterMm: 37, center: true }));
    expect(even).toHaveLength(35);
    const gx = (210 - 5 * 37) / 6;
    expect(even[0]!.cx).toBeCloseTo(gx + 18.5, 1);
    expect(even[1]!.cx - even[0]!.cx).toBeCloseTo(37 + gx, 1);
    expect(even[4]!.cx).toBeCloseTo(210 - gx - 18.5, 1);
    expect(even[34]!.cy).toBeCloseTo(297 - (297 - 7 * 37) / 8 - 18.5, 1);
    expect(even.map((s) => s.id).slice(0, 3)).toEqual(["s1", "s2", "s3"]);

    const fixed = generateGrid(PrintGridSpecSchema.parse({ paper: { wMm: 210, hMm: 297 }, columns: 3, rows: 2, diameterMm: 30, marginLeftMm: 10, marginTopMm: 12, pitchXMm: 40, gapYMm: 5 }));
    expect(fixed.map((s) => [s.cx, s.cy])).toEqual([[25, 27], [65, 27], [105, 27], [25, 62], [65, 62], [105, 62]]);

    const st = generateGrid(PrintGridSpecSchema.parse({ paper: { wMm: 210, hMm: 297 }, columns: 3, rows: 3, diameterMm: 30, marginLeftMm: 10, marginTopMm: 10, pitchXMm: 40, pitchYMm: 35, stagger: { enabled: true, dropLast: true } }));
    expect(st).toHaveLength(8);
    expect(st.filter((s) => s.cy === 60).map((s) => s.cx)).toEqual([45, 85]);

    const dry = await t.api("POST", "/api/print/templates/grid", { languageId: lang, paper: { wMm: 100, hMm: 100 }, columns: 3, rows: 1, diameterMm: 30, pitchXMm: 25, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.json.template).toBeNull();
    expect(dry.json.warnings.map((w: PrintTemplateWarning) => w.code)).toEqual(["slot-overlap"]);
    expect((await t.api("GET", `/api/print/templates?languageId=${lang}`)).json.templates).toHaveLength(0);

    expect((await t.api("POST", "/api/print/templates/grid", { languageId: lang, paper: { wMm: 50, hMm: 50 }, columns: 3, rows: 1, diameterMm: 30, marginLeftMm: 15 })).status).toBe(400);
    expect((await t.api("POST", "/api/print/templates/grid", { languageId: lang, paper: { wMm: 50, hMm: 50 }, columns: 1, rows: 1, shape: "rect" })).status).toBe(400);

    const tpl = await gridTemplate();
    expect(tpl).toMatchObject({ source: "grid", capacity: 4, sizeId: "3.8", name: "210×297 · Ø37 mm · 4'li" });
  });

  it("ön ayarlar: veri olarak tohumlanır, eklenir/düzenlenir/silinir, silinen geri gelmez", async () => {
    const seed = (await t.api("GET", `/api/print/presets?languageId=${lang}`)).json.presets;
    expect(seed.map((p: PrintPageFull) => p.name)).toEqual(["A4 · Ø37 mm · 35'li", "A4 · Ø25 mm", "A4 · Ø50 mm", "A4 · 63,5 × 38,1 mm · 21'li", "A4 · 40 × 40 mm kare · 24'lü"]);
    // Dikdörtgen ürün etiketi kağıdı: 21 yuva, kağıt içinde, çakışmasız; kenar payı yazıcının basamadığı 4 mm'den geniş.
    const rect = await t.api("POST", "/api/print/templates/grid", { languageId: lang, ...seed[3].grid, dryRun: true });
    expect(rect.json.slots).toHaveLength(21);
    expect(rect.json.warnings).toEqual([]);
    expect(rect.json.slots[0]).toMatchObject({ shape: "rect", w: 63.5, h: 38.1, cx: 38.96, cy: 34.2 });
    expect(rect.json.slots.every((x: PrintSlot) => slotFitsCut(x, { shape: "rect", wMm: 63.5, hMm: 38.1, radiusMm: 0 }))).toBe(true);
    const square = await t.api("POST", "/api/print/templates/grid", { languageId: lang, ...seed[4].grid, dryRun: true });
    expect(square.json.slots).toHaveLength(24);
    expect(square.json.warnings).toEqual([]);
    expect(seed[0].grid).toMatchObject({ columns: 5, rows: 7, diameterMm: 37, center: true });
    expect(seed[0].note).toMatch(/Başlangıç değeri/);
    // Ön ayar = ızgara üretecinin başlangıç değerleri
    const g = await t.api("POST", "/api/print/templates/grid", { languageId: lang, ...seed[0].grid, dryRun: true });
    expect(g.json.slots).toHaveLength(35);
    expect(g.json.warnings).toEqual([]);

    const c = await t.api("POST", "/api/print/presets", { languageId: lang, name: "Benim kağıdım", grid: { paper: { wMm: 200, hMm: 280 }, columns: 4, rows: 6, diameterMm: 40, marginLeftMm: 8 } });
    expect(c.status).toBe(200);
    const u = await t.api("PATCH", `/api/print/presets/${c.json.id}`, { languageId: lang, grid: { columns: 5 } });
    expect(u.json.grid).toMatchObject({ columns: 5, rows: 6, marginLeftMm: 8 });
    for (const p of [...seed, c.json]) expect((await t.api("DELETE", `/api/print/presets/${p.id}?languageId=${lang}`)).status).toBe(200);
    expect((await t.api("GET", `/api/print/presets?languageId=${lang}`)).json.presets).toEqual([]);
  });
});

describe("raf ve oturumlar", () => {
  it("raf: onaylı işler, needed (planlayıcı), placed, basılınca raftan düşer", async () => {
    const [a, b] = await approvedJobs([
      { siparis: "4849", etiket: "a1", adet: 3, text: "Anna Marco" },
      { siparis: "4850", etiket: "a2", adet: 1, text: "Lidia Chris" },
    ]);
    await importJobs(t, [{ siparis: "9", etiket: "a1", adet: 1, text: "Onaysız" }]);
    let shelf = (await t.api("GET", `/api/print/shelf?languageId=${lang}`)).json.items;
    expect(shelf).toHaveLength(2);
    expect(shelf[0]).toMatchObject({ jobId: a, orderNo: "4849", kind: "label", sizeId: "3.8", quantity: 3, needed: 5, placed: 0, designKey: "a1", product: null });
    expect(shelf[0].previewUrl).toMatch(/^\/api\/variants\/.+\/preview\.png\?v=\d+$/);

    const tpl = await gridTemplate();
    const s = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id })).json.session;
    shelf = (await t.api("GET", `/api/print/shelf?languageId=${lang}`)).json.items;
    expect(shelf.map((x: ShelfItem) => x.placed)).toEqual([5, 3]);

    await t.api("POST", `/api/print/sessions/${s.id}/printed`, {});
    shelf = (await t.api("GET", `/api/print/shelf?languageId=${lang}`)).json.items;
    expect(shelf).toEqual([]);
    expect(b).toBeTruthy();
  });

  it("oturum kur: planlayıcı çağrısı, sayfalar/öğeler, uymayan iş atlanır; planlayıcı yoksa 501", async () => {
    const [a, b, big] = await approvedJobs([
      { siparis: "1", etiket: "a1", adet: 3, text: "Anna" },
      { siparis: "2", etiket: "a2 5.2", adet: 1, text: "Mia" },
      { siparis: "3", etiket: "a15", adet: 1, text: "Lea" },
    ]);
    const tpl = await gridTemplate();
    const r = await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id, jobIds: [a, b, big, "yok"] });
    expect(r.status).toBe(200);
    expect(r.json.skipped).toEqual([
      { jobId: "yok", reason: "İş bulunamadı ya da onaylı varyasyonu yok." },
      { jobId: b, reason: "Boyut uyuşmuyor (iş 5.2, şablon 3.8)." },
    ]);
    expect(planCalls[0]!.orders).toEqual([
      { jobId: a, quantity: 3 },
      { jobId: big, quantity: 1 },
    ]);
    const s = r.json.session;
    expect(s).toMatchObject({ status: "draft", version: 0, templateId: tpl.id, jobIds: [a, big], name: "1_3 · 210×297 · Ø37 mm · 4'li" });
    expect(s.pages.map((p: PrintPageFull) => [p.index, p.items.length, p.kind, p.showCellLabels])).toEqual([[0, 4, "mixed", true], [1, 4, "mixed", true]]);
    expect(s.pages[0].items[0]).toMatchObject({ jobId: a, slotId: "s1", xMm: tpl.slots[0].cx, extra: false, manual: false });

    const t2 = await makeApp({ ports: fullPorts() });
    try {
      const l2 = await seedLanguage(t2);
      const tp = (await t2.api("POST", "/api/print/templates/grid", { languageId: l2, paper: { wMm: 210, hMm: 297 }, columns: 1, rows: 1, diameterMm: 37 })).json.template;
      const { commit } = await importJobs(t2, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna" }]);
      await t2.api("POST", "/api/generate", { jobIds: commit.jobIds });
      await t2.ctx.queue.idle();
      await t2.api("POST", "/api/jobs/approve-best", { ids: commit.jobIds });
      expect((await t2.api("POST", "/api/print/sessions", { languageId: l2, templateId: tp.id })).status).toBe(501);
      expect((await t2.api("GET", `/api/print/shelf?languageId=${l2}`)).json.items[0]).toMatchObject({ quantity: 1, needed: 1 });
    } finally {
      await t2.close();
    }
  });

  it("toplu yama: sayfa ekle, öğe ekle/taşı (yer değiştir)/güncelle/sil, sürüm çakışması 409", async () => {
    const [a, b] = await approvedJobs([
      { siparis: "1", etiket: "a1", adet: 1, text: "Anna" },
      { siparis: "2", etiket: "a2", adet: 1, text: "Mia" },
    ]);
    const tpl = await gridTemplate({ columns: 3, rows: 2 });
    const s = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id, jobIds: [a] })).json.session;
    expect(s.pages[0].items).toHaveLength(3);
    const first = s.pages[0].items[0];

    const r = await t.api("PATCH", `/api/print/sessions/${s.id}`, {
      version: 0,
      ops: [
        { op: "addPage", id: "yeni-sayfa", name: "Elle", copies: 2 },
        { op: "addItem", id: "o1", pageId: "yeni-sayfa", jobId: b },
        { op: "addItem", id: "o2", pageId: s.pages[0].id, jobId: b },
        { op: "moveItem", itemId: "o2", slotId: "s1" },
        { op: "updateItem", itemId: first.id, rotation: 15, scale: 0.9 },
        { op: "addItem", id: "o3", pageId: "yeni-sayfa", jobId: b, slotId: null, xMm: 300, yMm: 10 },
        { op: "removeItem", itemId: "o3" },
        { op: "renameSession", name: "Cuma baskısı" },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.json.warnings).toEqual(["Eklenen öğe kağıdın dışında."]);
    expect(r.json.undo).toBeNull();
    const ss = r.json.session;
    // İstemci kimlikleri geçici (SUNUCU-PLANI §10.3): gerçek kimlikler `ids`'te; aynı yamadaki başvurular çevrildi.
    const real = (x: string) => r.json.ids[x] as string;
    expect(Object.keys(r.json.ids).sort()).toEqual(["o1", "o2", "o3", "yeni-sayfa"]);
    expect(ss).toMatchObject({ version: 1, name: "Cuma baskısı" });
    expect(ss.pages.map((p: PrintPageFull) => [p.name, p.copies, p.kind])).toEqual([["1_1sayfa", 1, "mixed"], ["Elle", 2, "manual"]]);
    const p0 = ss.pages[0].items;
    const o2 = p0.find((i: PrintItem) => i.id === real("o2"));
    expect(o2).toMatchObject({ slotId: "s1", manual: true, xMm: tpl.slots[0].cx });
    // Yer değiştirme: s1'deki öğe o2'nin eski yuvasına (ilk boş yuva s4) geçti.
    expect(p0.find((i: PrintItem) => i.id === first.id)).toMatchObject({ slotId: "s4", rotation: 15, scale: 0.9, manual: true });
    expect(ss.pages[1]).toMatchObject({ id: real("yeni-sayfa") });
    expect(ss.pages[1].items).toEqual([expect.objectContaining({ id: real("o1"), slotId: "s1", jobId: b })]);
    // Aynı yamada eklenip silinen öğe kayıtta yok.
    expect(ss.pages.flatMap((p: PrintPageFull) => p.items).some((i: PrintItem) => i.id === real("o3"))).toBe(false);

    const stale = await t.api("PATCH", `/api/print/sessions/${s.id}`, { version: 0, ops: [{ op: "renameSession", name: "x" }] });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe("version-conflict");
    // Hatalı işlem: hepsi geri alınır (işlem bütünlüğü)
    const bad = await t.api("PATCH", `/api/print/sessions/${s.id}`, { version: 1, ops: [{ op: "renameSession", name: "y" }, { op: "addItem", pageId: "yok", jobId: b }] });
    expect(bad.status).toBe(404);
    const now = (await t.api("GET", `/api/print/sessions/${s.id}`)).json;
    expect(now).toMatchObject({ name: "Cuma baskısı", version: 1 });
    const full = await t.api("PATCH", `/api/print/sessions/${s.id}`, { version: 1, ops: [{ op: "addItem", pageId: real("yeni-sayfa"), jobId: b, slotId: "s1" }] });
    expect(full.status).toBe(409);
  });

  it("sayfa sil → geri al; şablon değiştir; yeniden planla kilitli/elle konanı korur", async () => {
    const [a] = await approvedJobs([{ siparis: "7", etiket: "a1", adet: 5, text: "Anna Marco" }]);
    const tpl = await gridTemplate();
    const s = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id })).json.session;
    expect(s.pages).toHaveLength(2); // 5 + 2 fazlalık = 7 → 4 + 3

    const del = await t.api("PATCH", `/api/print/sessions/${s.id}`, { version: 0, ops: [{ op: "removePage", pageId: s.pages[1].id }] });
    expect(del.json.session.pages).toHaveLength(1);
    expect(del.json.undo.label).toBe("Baskı sayfası silindi");
    expect((await t.api("POST", `/api/undo/${del.json.undo.undoToken}`)).status).toBe(200);
    const back = (await t.api("GET", `/api/print/sessions/${s.id}`)).json;
    expect(back.pages.map((p: PrintPageFull) => p.id)).toEqual(s.pages.map((p: PrintPageFull) => p.id));
    expect(back.version).toBe(2);

    const small = (await t.api("POST", "/api/print/templates/grid", { languageId: lang, paper: { wMm: 210, hMm: 297 }, columns: 3, rows: 1, diameterMm: 37, center: true, sizeId: "3.8" })).json.template;
    const ch = await t.api("PATCH", `/api/print/sessions/${s.id}`, {
      version: 2,
      ops: [
        { op: "setPageTemplate", pageId: s.pages[0].id, templateId: small.id },
        { op: "updatePage", pageId: s.pages[0].id, locked: true, copies: 3 },
      ],
    });
    expect(ch.json.warnings).toEqual(["Yeni şablonda yuva az: 1 öğe sayfadan çıkarıldı."]);
    expect(ch.json.session.pages[0]).toMatchObject({ templateId: small.id, locked: true, copies: 3 });
    expect(ch.json.session.pages[0].items.map((i: PrintItem) => i.xMm)).toEqual(small.slots.map((x: PrintSlot) => x.cx));

    // Elle bir öğe ikinci sayfada; yeniden planlamada kalır, kalan adet = 5 - (3 yuva × 3 kopya) - 1 < 0 → plan yok.
    const p2 = ch.json.session.pages[1];
    const man = await t.api("PATCH", `/api/print/sessions/${s.id}`, { version: 3, ops: [{ op: "moveItem", itemId: p2.items[0].id, xMm: 100, yMm: 100 }] });
    expect(man.status).toBe(200);
    planCalls = [];
    const re = await t.api("POST", `/api/print/sessions/${s.id}/replan`, { version: 4 });
    expect(re.status).toBe(200);
    expect(planCalls).toEqual([]);
    expect(re.json.session.pages.map((p: PrintPageFull) => [p.locked, p.items.length])).toEqual([[true, 3], [false, 1]]);
    expect(re.json.session.pages[1].items[0]).toMatchObject({ manual: true, xMm: 100, slotId: null });

    // Kilit açılınca tam yeniden plan: 5 - 1 (elle) = 4 adet planlanır.
    await t.api("PATCH", `/api/print/sessions/${s.id}`, { version: 5, ops: [{ op: "updatePage", pageId: s.pages[0].id, locked: false }] });
    const re2 = await t.api("POST", `/api/print/sessions/${s.id}/replan`, { version: 6 });
    expect(planCalls).toEqual([{ kind: "label", orders: [{ jobId: a, quantity: 4 }] }]);
    expect(re2.json.session.pages.map((p: PrintPageFull) => p.items.length)).toEqual([1, 4, 2]);
    expect((await t.api("POST", `/api/print/sessions/${s.id}/replan`, { version: 0 })).status).toBe(409);
  });

  it("basıldı → arşiv (arama), değişmez/silinmez; yeniden bas → yeni taslak; taslak sil → geri al", async () => {
    await approvedJobs([{ siparis: "4849", etiket: "a1", adet: 1, text: "Anna Marco" }]);
    const tpl = await gridTemplate();
    const s = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id, name: "Ekim" })).json.session;
    t.clock.advance(60_000);
    const pr = await t.api("POST", `/api/print/sessions/${s.id}/printed`, { version: 0 });
    expect(pr.json).toMatchObject({ status: "printed", printedAt: "2026-10-09T10:01:00.000Z", version: 1 });
    expect((await t.api("PATCH", `/api/print/sessions/${s.id}`, { version: 1, ops: [{ op: "renameSession", name: "x" }] })).json.code).toBe("printed");
    expect((await t.api("DELETE", `/api/print/sessions/${s.id}`)).status).toBe(409);

    const arch = (await t.api("GET", `/api/print/sessions?languageId=${lang}&status=printed&q=anna`)).json.sessions;
    expect(arch).toEqual([expect.objectContaining({ id: s.id, pageCount: 1, sheetCount: 1, itemCount: 3, jobCount: 1, orderNos: ["4849"] })]);
    expect((await t.api("GET", `/api/print/sessions?status=printed&q=yok-boyle`)).json.sessions).toEqual([]);
    expect((await t.api("GET", `/api/print/sessions?status=draft`)).json.sessions).toEqual([]);

    const copy = await t.api("POST", `/api/print/sessions/${s.id}/reprint`, {});
    expect(copy.json).toMatchObject({ status: "draft", name: "Ekim (yeniden basım)", sourceSessionId: s.id, version: 0 });
    expect(copy.json.pages[0].items).toHaveLength(3);
    expect(copy.json.pages[0].id).not.toBe(s.pages[0].id);

    const del = await t.api("DELETE", `/api/print/sessions/${copy.json.id}`);
    expect(del.json.label).toBe("Baskı oturumu silindi");
    expect((await t.api("GET", `/api/print/sessions/${copy.json.id}`)).status).toBe(404);
    await t.api("POST", `/api/undo/${del.json.undoToken}`);
    expect((await t.api("GET", `/api/print/sessions/${copy.json.id}`)).json.version).toBe(1);
  });

  it("şablon yuvaları değişince taslak öğeler yeni yuva merkezine geçer", async () => {
    await approvedJobs([{ siparis: "1", etiket: "a1", adet: 1, text: "Anna" }]);
    const tpl = await gridTemplate();
    const s = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id })).json.session;
    await t.api("POST", "/api/print/templates/grid", { languageId: lang, templateId: tpl.id, paper: { wMm: 210, hMm: 297 }, columns: 2, rows: 2, diameterMm: 37, marginLeftMm: 10, marginTopMm: 10, pitchXMm: 50, pitchYMm: 50 });
    const after = (await t.api("GET", `/api/print/sessions/${s.id}`)).json;
    expect(after.version).toBe(1);
    expect(after.pages[0].items.map((i: PrintItem) => [i.slotId, i.xMm, i.yMm])).toEqual([["s1", 28.5, 28.5], ["s2", 78.5, 28.5], ["s3", 28.5, 78.5]]);
  });
});

describe("sayfa şablonu silme", () => {
  /** Şablon satırı veritabanında var mı (silme gerçekten kalıcı mı). */
  const rowExists = (id: string) => t.inOrg(() => !!t.ctx.tdb.prepare("SELECT 1 AS x FROM print_templates WHERE id = ? AND org_id = $org").get(id));
  const ids = async (archived: boolean) => (await t.api("GET", `/api/print/templates?languageId=${lang}${archived ? "&archived=1" : ""}`)).json.templates.map((x: PrintTemplateView) => x.id);

  it("hiç kullanılmamış şablon kalıcı silinir (arşivli olsa da); ikinci silme 404; servis aynı sonucu verir", async () => {
    const tpl = await gridTemplate();
    const keep = await gridTemplate({ name: "Kalan" });
    const r = await t.api("DELETE", `/api/print/templates/${tpl.id}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ result: "deleted" });
    expect(rowExists(tpl.id)).toBe(false);
    expect(rowExists(keep.id)).toBe(true);
    expect((await t.api("GET", `/api/print/templates/${tpl.id}`)).json.code).toBe("print-template-not-found");
    expect(await ids(true)).toEqual([keep.id]);
    const again = await t.api("DELETE", `/api/print/templates/${tpl.id}`);
    expect([again.status, again.json.code]).toEqual([404, "print-template-not-found"]);
    expect((await t.api("DELETE", "/api/print/templates/yok")).status).toBe(404);

    // Arşivlenmiş ama kullanılmamış şablon da kalıcı silinir (servis doğrudan).
    await t.api("POST", `/api/print/templates/${keep.id}/archive`, { archived: true });
    expect(t.inOrg(() => t.ctx.printTemplates.remove(keep.id))).toEqual({ result: "deleted" });
    expect(rowExists(keep.id)).toBe(false);
    expect(await ids(true)).toEqual([]);
  });

  it("taslak oturumda kullanılan şablon silinmez, arşivlenir; oturum ve önizleme çalışır; tekrar silme yine arşiv", async () => {
    await approvedJobs([{ siparis: "4849", etiket: "a1", adet: 1, text: "Anna Marco" }]);
    const tpl = await gridTemplate();
    const s = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id })).json.session;
    const r = await t.api("DELETE", `/api/print/templates/${tpl.id}`);
    expect([r.status, r.json]).toEqual([200, { result: "archived" }]);
    expect(rowExists(tpl.id)).toBe(true);
    expect((await t.api("GET", `/api/print/templates/${tpl.id}`)).json).toMatchObject({ id: tpl.id, archived: true, slots: tpl.slots });
    expect(await ids(false)).toEqual([]);
    expect(await ids(true)).toEqual([tpl.id]);
    const detail = (await t.api("GET", `/api/print/sessions/${s.id}`)).json;
    expect(detail.pages.map((p: PrintPageFull) => [p.id, p.templateId, p.items.length])).toEqual(s.pages.map((p: PrintPageFull) => [p.id, tpl.id, p.items.length]));
    expect((await t.app.inject({ method: "GET", url: `/api/print/pages/${s.pages[0].id}/preview.png?w=200` })).statusCode).toBe(200);
    expect((await t.api("DELETE", `/api/print/templates/${tpl.id}`)).json).toEqual({ result: "archived" });
    expect(rowExists(tpl.id)).toBe(true);
  });

  it("basılmış oturumun şablonu arşivlenir; geçmiş baskı sayfası, önizlemesi ve yeniden basımı bozulmaz", async () => {
    await approvedJobs([{ siparis: "4849", etiket: "a1", adet: 1, text: "Anna Marco" }]);
    const tpl = await gridTemplate();
    const s = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id, name: "Ekim" })).json.session;
    await t.api("POST", `/api/print/sessions/${s.id}/printed`, { version: 0 });
    expect((await t.api("DELETE", `/api/print/templates/${tpl.id}`)).json).toEqual({ result: "archived" });
    expect(rowExists(tpl.id)).toBe(true);
    const detail = (await t.api("GET", `/api/print/sessions/${s.id}`)).json;
    expect(detail).toMatchObject({ status: "printed", templateId: tpl.id });
    expect(detail.pages.map((p: PrintPageFull) => [p.id, p.templateId, p.items.length])).toEqual(s.pages.map((p: PrintPageFull) => [p.id, tpl.id, p.items.length]));
    expect((await t.app.inject({ method: "GET", url: `/api/print/pages/${s.pages[0].id}/preview.png?w=200` })).statusCode).toBe(200);
    const copy = await t.api("POST", `/api/print/sessions/${s.id}/reprint`, {});
    expect(copy.status).toBe(200);
    expect(copy.json.pages[0].items).toHaveLength(s.pages[0].items.length);
  });

  it("silinmiş (geri alınabilir) oturumun ve sayfanın şablonu da kullanılmış sayılır; geri alınca oturum açılır", async () => {
    await approvedJobs([{ siparis: "7", etiket: "a1", adet: 5, text: "Anna Marco" }]);
    const tpl = await gridTemplate();
    const other = await gridTemplate({ name: "Diğer" });
    const s = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: other.id })).json.session;
    // İkinci sayfa `tpl`'e geçer, sonra silinir: yalnız silinmiş sayfa `tpl`'i kullanıyor.
    const ch = await t.api("PATCH", `/api/print/sessions/${s.id}`, { version: 0, ops: [{ op: "setPageTemplate", pageId: s.pages[1].id, templateId: tpl.id }] });
    expect(ch.status).toBe(200);
    const rm = await t.api("PATCH", `/api/print/sessions/${s.id}`, { version: ch.json.session.version, ops: [{ op: "removePage", pageId: s.pages[1].id }] });
    expect(rm.json.session.pages.map((p: PrintPageFull) => p.templateId)).toEqual([other.id]);
    expect((await t.api("DELETE", `/api/print/templates/${tpl.id}`)).json).toEqual({ result: "archived" });
    expect((await t.api("POST", `/api/undo/${rm.json.undo.undoToken}`)).status).toBe(200);
    expect((await t.api("GET", `/api/print/sessions/${s.id}`)).json.pages.map((p: PrintPageFull) => p.templateId)).toEqual([other.id, tpl.id]);

    const del = await t.api("DELETE", `/api/print/sessions/${s.id}`);
    expect((await t.api("DELETE", `/api/print/templates/${other.id}`)).json).toEqual({ result: "archived" });
    expect((await t.api("POST", `/api/undo/${del.json.undoToken}`)).status).toBe(200);
    expect((await t.api("GET", `/api/print/sessions/${s.id}`)).status).toBe(200);
  });

  it("yalnız basılmış oturumun anlık kopyasında geçen şablon arşivlenir; kopyada yalnız benzer kimlik (`<kimlik>x`) varsa silinir", async () => {
    await approvedJobs([{ siparis: "4849", etiket: "a1", adet: 1, text: "Anna Marco" }]);
    const other = await gridTemplate({ name: "Oturumun" });
    const snapOnly = await gridTemplate({ name: "Yalnız kopyada" });
    const lookalike = await gridTemplate({ name: "Benzer kimlik" });
    const s = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: other.id })).json.session;
    await t.api("POST", `/api/print/sessions/${s.id}/printed`, { version: 0 });
    // Kopyaya iki kayıt: `snapOnly` kendi kimliğiyle; `lookalike` yalnız sonuna "x" eklenmiş kimlikle (kendi kimliği hiç geçmez).
    const snapshots = {
      [other.id]: (await t.api("GET", `/api/print/templates/${other.id}`)).json,
      [snapOnly.id]: (await t.api("GET", `/api/print/templates/${snapOnly.id}`)).json,
      [`${lookalike.id}x`]: { name: "Benzer kimlik" },
    };
    t.inOrg(() => t.ctx.tdb.prepare("UPDATE print_sessions SET template_snapshots = ? WHERE id = ? AND org_id = $org").run(JSON.stringify(snapshots), s.id));
    const used = t.inOrg(() =>
      t.ctx.tdb
        .prepare("SELECT (SELECT COUNT(*) FROM print_pages WHERE org_id = $org AND template_id = ?) + (SELECT COUNT(*) FROM print_sessions WHERE org_id = $org AND template_id = ?) AS n")
        .get(snapOnly.id, snapOnly.id),
    ) as { n: number | string };
    expect(Number(used.n)).toBe(0); // sayfa ve oturum planında kullanılmıyor: yalnız kopyada
    const usedList = (await t.api("GET", `/api/print/templates?languageId=${lang}`)).json.templates as PrintTemplateView[];
    expect(usedList.find((x) => x.id === snapOnly.id)?.usedIn).toBe(1);
    expect(usedList.find((x) => x.id === lookalike.id)?.usedIn).toBe(0);

    expect((await t.api("DELETE", `/api/print/templates/${snapOnly.id}`)).json).toEqual({ result: "archived" });
    expect(rowExists(snapOnly.id)).toBe(true);
    expect((await t.api("GET", `/api/print/templates/${snapOnly.id}`)).json.archived).toBe(true);

    expect((await t.api("DELETE", `/api/print/templates/${lookalike.id}`)).json).toEqual({ result: "deleted" });
    expect(rowExists(lookalike.id)).toBe(false);
  });

  it("liste, tek şablon ve PATCH yanıtı `usedIn` (kaç oturumda kullanıldı) taşır; silme sonucuyla tutarlıdır", async () => {
    await approvedJobs([{ siparis: "4849", etiket: "a1", adet: 1, text: "Anna Marco" }]);
    const used = await gridTemplate({ name: "Kullanılan" });
    const free = await gridTemplate({ name: "Boşta" });
    const counts = async () => {
      const list = (await t.api("GET", `/api/print/templates?languageId=${lang}`)).json.templates as PrintTemplateView[];
      return [list.find((x) => x.id === used.id)?.usedIn, list.find((x) => x.id === free.id)?.usedIn];
    };
    expect(await counts()).toEqual([0, 0]);
    const s1 = await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: used.id });
    expect(s1.status).toBe(200);
    expect(await counts()).toEqual([1, 0]);
    await approvedJobs([{ siparis: "4850", etiket: "a1", adet: 1, text: "Anna Marco" }]); // ilk oturum işleri aldı
    expect((await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: used.id })).status).toBe(200);
    expect(await counts()).toEqual([2, 0]);
    expect((await t.api("GET", `/api/print/templates/${used.id}`)).json.usedIn).toBe(2);
    expect((await t.api("GET", `/api/print/templates/${free.id}`)).json.usedIn).toBe(0);
    expect((await t.api("PATCH", `/api/print/templates/${used.id}`, { name: "Kullanılan 2" })).json.usedIn).toBe(2);
    expect((await t.api("DELETE", `/api/print/templates/${used.id}`)).json).toEqual({ result: "archived" });
    expect((await t.api("DELETE", `/api/print/templates/${free.id}`)).json).toEqual({ result: "deleted" });
  });

  it("baskı özelliği kapalıyken silme 409 feature-off; şablon yerinde kalır", async () => {
    const tpl = await gridTemplate();
    expect((await t.api("PATCH", "/api/features", { print: false })).json.effective.print).toBe(false);
    const r = await t.api("DELETE", `/api/print/templates/${tpl.id}`);
    expect([r.status, r.json.code, r.json.feature]).toEqual([409, "feature-off", "print"]);
    expect(rowExists(tpl.id)).toBe(true);
  });
});

describe("çizim girdisi ve çıktı", () => {
  it("önizleme: mm ölçeği, kesim merkezi, hücre etiketi; çizici yoksa 501", async () => {
    const [a] = await approvedJobs([{ siparis: "4849", etiket: "a1", adet: 1, text: "Anna Marco" }]);
    const tpl = await gridTemplate();
    const s = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id })).json.session;
    const res = await t.app.inject({ method: "GET", url: `/api/print/pages/${s.pages[0].id}/preview.png?w=200` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    const page = rendered[0]!;
    expect(page).toMatchObject({ name: "4849_1sayfa", copies: 1, paper: { wMm: 210, hMm: 297 }, printKind: "label", cellLabel: { show: true } });
    expect(page.items).toHaveLength(3);
    const it0 = page.items.find((i) => i.centerMm.x === tpl.slots[0].cx && i.centerMm.y === tpl.slots[0].cy)!;
    // Tasarım karesi (440 px) yuva ölçüsünde (37 mm), yuvaya ortalanır.
    expect(it0).toMatchObject({ jobId: a, printKind: "label", variantKind: "text", framePx: 440, anchorPx: { x: 220, y: 220 }, diameterMm: 37 });
    expect(it0.mmPerPx).toBeCloseTo(37 / 440, 4);
    expect(it0.centerMm).toEqual({ x: tpl.slots[0].cx, y: tpl.slots[0].cy });
    expect(it0.layout?.lines.length).toBeGreaterThan(0);
    expect(it0.templatePath).toMatch(/a1\.png$/);
    expect(it0.fontsDir).toMatch(/fontlar$/);
    // Hücre etiketi: ilk yuva (s1) satırın en sağında değil → s1'in sağ alt köşesi + (-11,3; -1,6)
    expect(page.cellLabels).toEqual([{ text: "4849_1adet", slotId: "s1", xMm: Math.round((tpl.slots[0].cx + 18.5 - 11.3) * 100) / 100, yMm: Math.round((tpl.slots[0].cy + 18.5 - 1.6) * 100) / 100 }]);

    await t.api("PATCH", `/api/print/sessions/${s.id}`, { version: 0, ops: [{ op: "updatePage", pageId: s.pages[0].id, showCellLabels: false }] });
    await t.app.inject({ method: "GET", url: `/api/print/pages/${s.pages[0].id}/preview.png` });
    expect(rendered[1]!.cellLabels).toEqual([]);
    expect((await t.api("GET", `/api/print/pages/${s.pages[0].id}/preview.png?w=5`)).status).toBe(400);
    expect((await t.api("GET", `/api/print/pages/yok/preview.png`)).status).toBe(404);

    const t2 = await makeApp({ ports: fullPorts({ printPlanner: fakePlanner() }) });
    try {
      const l2 = await seedLanguage(t2);
      const tp = (await t2.api("POST", "/api/print/templates/grid", { languageId: l2, paper: { wMm: 210, hMm: 297 }, columns: 2, rows: 2, diameterMm: 37 })).json.template;
      const { commit } = await importJobs(t2, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna" }]);
      await t2.api("POST", "/api/generate", { jobIds: commit.jobIds });
      await t2.ctx.queue.idle();
      await t2.api("POST", "/api/jobs/approve-best", { ids: commit.jobIds });
      const ss = (await t2.api("POST", "/api/print/sessions", { languageId: l2, templateId: tp.id })).json.session;
      expect((await t2.api("GET", `/api/print/pages/${ss.pages[0].id}/preview.png`)).status).toBe(501);
      expect((await t2.api("POST", `/api/print/sessions/${ss.id}/export`, { format: "png" })).status).toBe(501);
    } finally {
      await t2.close();
    }
  });

  it("çıktı: PNG (sayfa başına dosya) ve PDF; ilerleme olayları; indirme", async () => {
    await approvedJobs([{ siparis: "4849", etiket: "a1", adet: 5, text: "Anna Marco" }]);
    const tpl = await gridTemplate();
    const s = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id, name: "Ekim / 1" })).json.session;
    const events: Extract<ServerEvent, { type: "printExport" }>[] = [];
    const off = t.ctx.events.subscribe((e) => {
      if (e.type === "printExport") events.push(e);
    });
    const r = await t.api("POST", `/api/print/sessions/${s.id}/export`, { format: "png" });
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ status: "queued", total: 2, done: 0 });
    await t.ctx.printExports.idle();
    expect(renderedDpi).toEqual([300, 300]); // etiket: profil `printing.dpi`
    const done = (await t.api("GET", `/api/print/exports/${r.json.id}`)).json;
    expect(done).toMatchObject({ status: "done", done: 2, total: 2, error: null });
    expect(done.files.map((f: PrintExport["files"][number]) => f.name)).toEqual(["01 4849_1sayfa.png", "02 4849_1sayfa.png"]);
    const file = await t.app.inject({ method: "GET", url: done.files[0].url });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-disposition"]).toMatch(/attachment/);
    expect(events.map((e) => e.status)).toEqual(["queued", "running", "running", "running", "done"]);

    const pdf = await t.api("POST", `/api/print/sessions/${s.id}/export`, { format: "pdf", pages: [s.pages[1].id] });
    await t.ctx.printExports.idle();
    const pd = (await t.api("GET", `/api/print/exports/${pdf.json.id}`)).json;
    expect(pd).toMatchObject({ status: "done", total: 1, files: [expect.objectContaining({ name: "Ekim _ 1.pdf" })] });
    const body = await t.app.inject({ method: "GET", url: pd.files[0].url });
    expect(body.headers["content-type"]).toBe("application/pdf");
    expect(body.body).toBe("%PDF-1.7 sahte");
    expect((await t.api("POST", `/api/print/sessions/${s.id}/export`, { format: "pdf", pages: ["yok"] })).status).toBe(404);
    off();
  });

  it("basılmış oturum şablonun basıldığı anki kopyasını kullanır (önizleme, çıktı, yeniden basım); taslağa dönünce günceli", async () => {
    await approvedJobs([{ siparis: "4849", etiket: "a1", adet: 1, text: "Anna Marco" }]);
    const tpl = await gridTemplate();
    const s = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id })).json.session;
    const pageId = s.pages[0].id;
    // Değişmeden yeniden basım: aynı şablon (kopya şablon üretilmez).
    const pr = await t.api("POST", `/api/print/sessions/${s.id}/printed`, {});
    expect(pr.json.templateSnapshots[tpl.id]).toMatchObject({ id: tpl.id, paper: tpl.paper, slots: tpl.slots });
    const same = (await t.api("POST", `/api/print/sessions/${s.id}/reprint`, {})).json;
    expect(same.pages[0].templateId).toBe(tpl.id);
    expect(same.templateSnapshots).toBeNull();

    // Şablon basıldıktan sonra değişir: kağıt, yuvalar, kesim, hücre etiketi.
    await t.api("POST", "/api/print/templates/grid", { languageId: lang, templateId: tpl.id, paper: { wMm: 200, hMm: 280 }, columns: 3, rows: 1, diameterMm: 30, marginLeftMm: 5, marginTopMm: 5, pitchXMm: 40 });
    await t.api("PATCH", `/api/print/templates/${tpl.id}`, { cut: { outlineVisible: false }, cellLabel: { sizePt: 12, dxMm: 1 } });
    const live = (await t.api("GET", `/api/print/templates/${tpl.id}`)).json;
    expect(live.slots).toHaveLength(3);

    rendered = [];
    expect((await t.app.inject({ method: "GET", url: `/api/print/pages/${pageId}/preview.png?w=200` })).statusCode).toBe(200);
    const exp = await t.api("POST", `/api/print/sessions/${s.id}/export`, { format: "png" });
    await t.ctx.printExports.idle();
    expect((await t.api("GET", `/api/print/exports/${exp.json.id}`)).json.status).toBe("done");
    expect(rendered).toHaveLength(2);
    for (const page of rendered) {
      expect(page.paper).toEqual(tpl.paper);
      expect(page.slots).toEqual(tpl.slots);
      expect(page.cut.outlineVisible).toBe(true);
      expect(page.cellLabel).toMatchObject({ sizePt: tpl.cellLabel.sizePt, dxMm: tpl.cellLabel.dxMm });
      expect(page.cellLabels[0]!.slotId).toBe("s1");
      // Öğe konumu basıldığı gibi (taslaklar gibi yeni yuva merkezine taşınmadı).
      expect(page.items.map((i) => i.centerMm.x).sort()).toEqual(s.pages[0].items.map((i: PrintItem) => i.xMm).sort());
    }
    expect((await t.api("GET", `/api/print/sessions/${s.id}`)).json.templateSnapshots[tpl.id].slots).toEqual(tpl.slots);

    // "Aynen yeniden bas": şablon değiştiği için kopya arşivli yeni şablon olarak gelir; güncel şablona geçiş setPageTemplate ile.
    const again = (await t.api("POST", `/api/print/sessions/${s.id}/reprint`, {})).json;
    const tid = again.pages[0].templateId;
    expect(tid).not.toBe(tpl.id);
    expect(again.templateId).toBe(tid);
    const restored = (await t.api("GET", `/api/print/templates/${tid}`)).json;
    expect(restored).toMatchObject({ archived: true, paper: tpl.paper, slots: tpl.slots, cut: { outlineVisible: true }, cellLabel: { sizePt: tpl.cellLabel.sizePt } });
    expect(restored.name).toContain(tpl.name);
    expect((await t.api("GET", `/api/print/templates?languageId=${lang}`)).json.templates.map((x: PrintTemplateView) => x.id)).toEqual([tpl.id]);
    rendered = [];
    await t.app.inject({ method: "GET", url: `/api/print/pages/${again.pages[0].id}/preview.png?w=200` });
    expect(rendered[0]!.slots).toEqual(tpl.slots);
    const sw = await t.api("PATCH", `/api/print/sessions/${again.id}`, { version: 0, ops: [{ op: "setPageTemplate", pageId: again.pages[0].id, templateId: tpl.id }] });
    expect(sw.json.session.pages[0].templateId).toBe(tpl.id);

    // Taslağa geri: kopya bırakılır, güncel şablon kullanılır; yeniden basıldı → yeni kopya (güncel hâl).
    const back = await t.api("POST", `/api/print/sessions/${s.id}/printed`, { printed: false });
    expect(back.json).toMatchObject({ status: "draft", templateSnapshots: null });
    rendered = [];
    await t.app.inject({ method: "GET", url: `/api/print/pages/${pageId}/preview.png?w=200` });
    expect(rendered[0]!.slots).toEqual(live.slots);
    const re = await t.api("POST", `/api/print/sessions/${s.id}/printed`, {});
    expect(re.json.templateSnapshots[tpl.id].slots).toEqual(live.slots);
  });

  it("sticker: mürekkep ölçüsü mm'ye çevrilip planlayıcıya gider", async () => {
    const [st] = await approvedJobs([{ siparis: "5", etiket: "", adet: 2, text: "Teşekkürler", urun: "Oyster" }]);
    const shelf = (await t.api("GET", `/api/print/shelf?languageId=${lang}`)).json.items;
    expect(shelf[0]).toMatchObject({ jobId: st, kind: "sticker", sizeId: "istiridye", designKey: null, product: "Oyster" });
    const tpl = (
      await t.api("POST", "/api/print/templates", {
        languageId: lang,
        name: "Sticker A4",
        kind: "sticker",
        sizeId: "istiridye",
        paper: { wMm: 210, hMm: 297 },
        stickerFlow: { marginTopMm: 7.8, marginBottomMm: 8.5, marginSideMm: 7, minGapXMm: 5.3, minRowGapMm: 4.6, maxRowGapLastMm: 6.4 },
      })
    ).json;
    expect(tpl.warnings).toEqual([]);
    const r = await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id });
    expect(r.status).toBe(200);
    // Sahte yerleşimin mürekkebi 200 px genişliğinde → 200 × 25,4/72 mm.
    expect(planCalls[0]).toEqual({ kind: "sticker", orders: [{ jobId: st, quantity: 2, wMm: Math.round(200 * (25.4 / 72) * 100) / 100 }] });
    await t.app.inject({ method: "GET", url: `/api/print/pages/${r.json.session.pages[0].id}/preview.png` });
    expect(rendered[0]!.items[0]).toMatchObject({ printKind: "sticker", anchorPx: { x: 220, y: 194 } });
    expect(rendered[0]!.items[0]!.mmPerPx).toBeCloseTo(25.4 / 72, 4);
    expect(rendered[0]!.cellLabels).toEqual([]); // sticker sayfasında sipariş adı basılmaz (masa da göstermez)
    // Sticker sayfası profil `printing.stickerDpi` ile çizilir: varsayılan 300 (eski 72 dpi "1 px 1 pt" baskı için düşüktü;
    // sticker'ın mm ölçüsü dpi'den bağımsızdır).
    expect(renderedDpi.at(-1)).toBe(300);
    const ex = await t.api("POST", `/api/print/sessions/${r.json.session.id}/export`, { format: "png" });
    expect(ex.status).toBe(202);
    await t.ctx.printExports.idle();
    expect(renderedDpi.at(-1)).toBe(300);
  });
});

describe("sticker fiziksel ölçüsü (mm): tasarım pikseli yazı alanına ölçeklenir", () => {
  const PT = 25.4 / 72;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  it("mürekkep profildeki yazı alanına sığar; raf, oturum ölçüsü, planlayıcı ve çizim AYNI mm'yi kullanır", async () => {
    await t.close();
    t = await makeApp({ ports: fullPorts({ printPlanner: fakePlanner(), printRenderer: fakeRenderer() }), startQueue: true });
    // Yazı alanı 100 × 60 pt (35,28 × 21,17 mm); sahte mürekkep 200 × 20 px → genişlik sınırlar: 0,5 pt/px.
    const sheets = [{ id: "istiridye", frameName: "İSTİRİDYE", productKeywords: ["oyster"], shape: "rect" as const, maxW: 100, maxH: 60, slotW: 110, slotH: 70 }];
    lang = await seedLanguage(t, undefined, { ...TEST_PROFILE, stickers: { enabled: true, detect: "empty-template", sheets } });
    const [st] = await approvedJobs([{ siparis: "5", etiket: "", adet: 2, text: "Teşekkürler", urun: "Oyster" }]);
    const shelf = (await t.api("GET", `/api/print/shelf?languageId=${lang}`)).json.items;
    const wMm = r2(100 * PT);
    expect(shelf[0]).toMatchObject({ jobId: st, wMm, hMm: r2(10 * PT) }); // eski hata: 200 px = 200 pt = 70,56 mm
    const tpl = (
      await t.api("POST", "/api/print/templates", {
        languageId: lang,
        name: "Sticker A4",
        kind: "sticker",
        sizeId: "istiridye",
        paper: { wMm: 210, hMm: 297 },
        stickerFlow: { marginTopMm: 7.8, marginBottomMm: 8.5, marginSideMm: 7, minGapXMm: 5.3, minRowGapMm: 4.6, maxRowGapLastMm: 6.4 },
      })
    ).json;
    const s = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id })).json.session;
    expect(planCalls[0]!.orders[0]!.wMm).toBe(wMm);
    const size = s.itemSizes[s.pages[0].items[0].variantId];
    expect(size).toMatchObject({ wMm, hMm: r2(10 * PT) });
    expect(size.art.wMm).toBeCloseTo(440 * 0.5 * PT, 2);
    await t.app.inject({ method: "GET", url: `/api/print/pages/${s.pages[0].id}/preview.png` });
    const item = rendered[0]!.items[0]!;
    // Çizim: mm/px aynı, tasarım karesinin mm'si masadaki görsel kutusuyla aynı.
    expect(item.mmPerPx).toBeCloseTo(0.5 * PT, 4);
    expect(item.diameterMm).toBeCloseTo(size.art.wMm, 1);
    expect(item.anchorPx).toEqual({ x: 220, y: 194 });
    // Sticker sayfası da baskı çözünürlüğünde (300 dpi; eski 72 dpi baskı için düşüktü).
    expect(renderedDpi.at(-1)).toBe(300);
  });
});

describe("şablonun kendi kesimi (mm): dikdörtgen etiket aynı tasarım dilinde", () => {
  it("dil paketi kesimi taşır; kesimsiz eski kayıt null okunur", async () => {
    const cut = { shape: "roundRect", wMm: 50, hMm: 30, radiusMm: 3 };
    expect((await t.api("PATCH", `/api/languages/${lang}/templates/a2`, { cut })).status).toBe(200);
    const pkg = await t.inOrg(() => t.ctx.languagePackages.export(lang));
    const recs = Object.fromEntries(pkg.templates.map((x) => [x.record.key, x.record]));
    expect(recs.a2.cut).toEqual(cut);
    expect(recs.a1.cut).toBeNull();
    // Eski paket (kesim alanı yok) okunur.
    const old = { ...pkg, name: "Eski paket", templates: pkg.templates.map((x) => ({ ...x, record: Object.fromEntries(Object.entries(x.record).filter(([k]) => k !== "cut")) })) };
    const imp = await t.inOrg(() => t.ctx.languagePackages.import(old));
    const back = await t.inOrg(() => t.ctx.languagePackages.import({ ...pkg, name: "Yeni paket" }));
    const list = (id: string) => t.inOrg(() => t.ctx.templates.list(id)).map((i) => i.template);
    expect(list(imp.language.id).every((x) => x.cut === null)).toBe(true);
    expect(list(back.language.id).find((x) => x.key === "a2")!.cut).toEqual(cut);
    // Kesim kaldırılabilir (null yama).
    const cleared = await t.api("PATCH", `/api/languages/${lang}/templates/a2`, { cut: null });
    expect(cleared.json.template.cut).toBeNull();
  });

  it("şablon görseli eksikse (geometri kurulamaz) ölçek ve kırpma şablon kaydındaki kesimden gelir", async () => {
    const cut = { shape: "rect", wMm: 63.5, hMm: 38.1, radiusMm: 0 };
    expect((await t.api("PATCH", `/api/languages/${lang}/templates/a2`, { cut })).status).toBe(200);
    const [a] = await approvedJobs([{ siparis: "7101", etiket: "a2", adet: 2, text: "Lavanta" }]);
    const rect = await gridTemplate({ columns: 3, rows: 7, shape: "rect", diameterMm: undefined, wMm: 63.5, hMm: 38.1, sizeId: "63.5x38.1" });
    const s = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: rect.id, jobIds: [a] })).json.session;
    const tpl = t.inOrg(() => t.ctx.templates.find(lang, "a2"))!;
    rmSync(t.inOrg(() => t.ctx.templates.imagePath(lang, tpl)));
    await t.app.inject({ method: "GET", url: `/api/print/pages/${s.pages[0].id}/preview.png` });
    const item = rendered.at(-1)!.items[0]!;
    expect(item.geometry).toBeNull();
    const itemCut = item.cut;
    expect(itemCut?.kind).toBe("rect");
    if (itemCut?.kind !== "rect") throw new Error("rect bekleniyordu");
    expect(itemCut.w * item.mmPerPx).toBeCloseTo(63.5, 1);
  });

  it("boyut kimliği şablondan; dikdörtgen yuvada kesim ölçüsünde basılır; daire yuvada görünür uyarı; masa ölçüsü çizimle aynı", async () => {
    // Gerçek şablon geometrisi (templates paketi): kesim ve mm/px şablondan.
    const { templatesGeometry } = await import("./adapters/templates.ts");
    await t.close();
    t = await makeApp({ ports: fullPorts({ geometry: templatesGeometry, printPlanner: fakePlanner(), printRenderer: fakeRenderer() }), startQueue: true });
    lang = await seedLanguage(t);
    const cut = { shape: "rect", wMm: 63.5, hMm: 38.1, radiusMm: 0 };
    const patched = await t.api("PATCH", `/api/languages/${lang}/templates/a2`, { cut });
    expect(patched.status, patched.body).toBe(200);
    expect(patched.json.template.cut).toEqual(cut);
    const [a] = await approvedJobs([{ siparis: "7001", etiket: "a2", adet: 3, text: "Lavanta sabunu" }]);
    const shelf = (await t.api("GET", `/api/print/shelf?languageId=${lang}`)).json.items;
    expect(shelf.find((x: ShelfItem) => x.jobId === a)).toMatchObject({ kind: "label", sizeId: "63.5x38.1" });

    // Dikdörtgen yuvalı sayfa (A4 3 × 7 = 21'li 63,5 × 38,1).
    const rect = await gridTemplate({ columns: 3, rows: 7, shape: "rect", diameterMm: undefined, wMm: 63.5, hMm: 38.1, sizeId: "63.5x38.1" });
    const r = await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: rect.id, jobIds: [a] });
    expect(r.status, r.body).toBe(200);
    expect(r.json.warnings.filter((w: string) => w.includes("yuvası"))).toEqual([]);
    const s = r.json.session;
    const size = s.itemSizes[s.pages[0].items[0].variantId];
    expect(size).toMatchObject({ kind: "label", wMm: 63.5, hMm: 38.1 });
    await t.app.inject({ method: "GET", url: `/api/print/pages/${s.pages[0].id}/preview.png` });
    const item = rendered[0]!.items[0]!;
    // Tasarım alanındaki kesim genişliği × mm/px = 63,5 mm; tasarım karesi (çizimde) = masadaki görsel kutusu.
    const itemCut = item.cut;
    expect(itemCut?.kind).toBe("rect");
    if (itemCut?.kind !== "rect") throw new Error("rect bekleniyordu");
    const cutPx = itemCut.w;
    expect(cutPx * item.mmPerPx).toBeCloseTo(63.5, 1);
    expect(item.diameterMm).toBeCloseTo(size.art.wMm, 1);

    // Daire yuvalı (boyutsuz) sayfaya: engellenmez, görünür uyarı.
    const round = await gridTemplate({ sizeId: null });
    const w = await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: round.id, jobIds: [a] });
    expect(w.status, w.body).toBe(200);
    expect(w.json.warnings.some((x: string) => x.includes("63.5 × 38.1 mm dikdörtgen") && x.includes("Ø37 mm daire"))).toBe(true);
    // Kesimsiz şablonun işi eski kuralla (boyut listesi) kalır.
    const [b] = await approvedJobs([{ siparis: "7002", etiket: "a1", adet: 2, text: "Anna" }]);
    const shelf2 = (await t.api("GET", `/api/print/shelf?languageId=${lang}`)).json.items;
    expect(shelf2.find((x: ShelfItem) => x.jobId === b).sizeId).toBe("3.8");
  });
});

describe("inceleme bulguları: plan sürümü, eski ölçüyle basılmış arşiv, küçük yazı, yuva yönü, şablon seçimi, yazıcı kenarı", () => {
  const PT = 25.4 / 72;
  async function stickerSession(profile = TEST_PROFILE) {
    await t.close();
    t = await makeApp({ ports: fullPorts({ printPlanner: fakePlanner(), printRenderer: fakeRenderer() }), startQueue: true });
    lang = await seedLanguage(t, undefined, profile);
    await approvedJobs([{ siparis: "5", etiket: "", adet: 2, text: "Teşekkürler", urun: "Oyster" }]);
    const tpl = (
      await t.api("POST", "/api/print/templates", {
        languageId: lang,
        name: "Sticker A4",
        kind: "sticker",
        sizeId: "istiridye",
        paper: { wMm: 210, hMm: 297 },
        stickerFlow: { marginTopMm: 7.8, marginBottomMm: 8.5, marginSideMm: 7, minGapXMm: 5.3, minRowGapMm: 4.6, maxRowGapLastMm: 6.4 },
      })
    ).json;
    return (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id })).json.session;
  }

  it("yeni oturum güncel ölçüyle (uyarı yok); eski ölçüyle dizilmiş taslak 'yeniden planla' uyarısı alır, yeniden planlayınca kalkar", async () => {
    const s = await stickerSession();
    expect(s.notices).toEqual([]);
    expect(t.raw.get("SELECT plan_version FROM print_sessions WHERE id = ?", s.id)).toEqual({ plan_version: 2 });
    t.raw.run("UPDATE print_sessions SET plan_version = 1 WHERE id = ?", s.id);
    const d = (await t.api("GET", `/api/print/sessions/${s.id}`)).json;
    expect(d.notices).toEqual([{ code: "plan-stale", message: expect.stringContaining("eski ölçülerle"), params: { sheets: 1, replanSheets: 1 } }]);
    const r = (await t.api("POST", `/api/print/sessions/${s.id}/replan`, { version: d.version })).json;
    expect(r.session.notices).toEqual([]);
    expect(t.raw.get("SELECT plan_version FROM print_sessions WHERE id = ?", s.id)).toEqual({ plan_version: 2 });
  });

  it("eski ölçüyle basılmış arşiv basıldığı gibi (eski ölçek) çıkar ve not taşır; yeniden basım kopyası 'yeniden planla' uyarısı alır", async () => {
    const s = await stickerSession();
    expect((await t.api("POST", `/api/print/sessions/${s.id}/printed`, {})).status).toBe(200);
    t.raw.run("UPDATE print_sessions SET plan_version = 1 WHERE id = ?", s.id);
    const d = (await t.api("GET", `/api/print/sessions/${s.id}`)).json;
    expect(d.notices.map((n: PrintSessionNotice) => n.code)).toEqual(["printed-old-scale"]);
    // Eski ölçü: 1 tasarım px = 1 pt (mürekkep 200 px → 70,56 mm); masa ve çizim aynı.
    expect(d.itemSizes[d.pages[0].items[0].variantId].wMm).toBeCloseTo(200 * PT, 2);
    rendered = [];
    await t.app.inject({ method: "GET", url: `/api/print/pages/${d.pages[0].id}/preview.png` });
    expect(rendered[0]!.items[0]!.mmPerPx).toBeCloseTo(PT, 4);
    const copy = (await t.api("POST", `/api/print/sessions/${s.id}/reprint`, {})).json;
    expect(copy.notices.map((n: PrintSessionNotice) => n.code)).toEqual(["plan-stale"]);
  });

  it("sticker'daki en küçük yazı okunurluk sınırının altındaysa uyarı (tasarım dilinin `quality.readableMinPt` kuralı)", async () => {
    const s = await stickerSession({ ...TEST_PROFILE, quality: { readableMinPt: 30 } });
    const n = s.notices.find((x: PrintSessionNotice) => x.code === "sticker-small-text");
    // Sahte yerleşim: satır 20 px; 200 × 20 px mürekkep 200 × 120 pt alana 1 pt/px sığar → 20 pt < 30 pt.
    expect(n).toMatchObject({ params: { orderNo: "5", pt: 20, minPt: 30 } });
    expect((await stickerSession()).notices).toEqual([]);
  });

  it("dikey dikdörtgen yuvada kesimli etiket çeyrek tur döner (plan ve çizim aynı açı); yatay yuvada dönmez", async () => {
    const cut = { shape: "rect", wMm: 63.5, hMm: 38.1, radiusMm: 0 };
    expect((await t.api("PATCH", `/api/languages/${lang}/templates/a2`, { cut })).status).toBe(200);
    const [a] = await approvedJobs([{ siparis: "8001", etiket: "a2", adet: 1, text: "Sabun" }]);
    const tall = await gridTemplate({ columns: 4, rows: 3, shape: "rect", diameterMm: undefined, wMm: 38.1, hMm: 63.5, sizeId: null });
    const s = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tall.id, jobIds: [a] })).json;
    expect(s.warnings.filter((w: string) => w.includes("yuvası"))).toEqual([]);
    expect(s.session.pages[0].items.every((i: PrintItem) => i.rotation === 90)).toBe(true);
    rendered = [];
    await t.app.inject({ method: "GET", url: `/api/print/pages/${s.session.pages[0].id}/preview.png` });
    expect(rendered[0]!.items[0]!.rotation).toBe(90);
    const wide = await gridTemplate({ columns: 3, rows: 7, shape: "rect", diameterMm: undefined, wMm: 63.5, hMm: 38.1, sizeId: null });
    const w = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: wide.id, jobIds: [a] })).json;
    expect(w.session.pages[0].items.every((i: PrintItem) => i.rotation === 0)).toBe(true);
    // Elle açı verilirse korunur.
    const it0 = w.session.pages[0].items[0];
    const p = (await t.api("PATCH", `/api/print/sessions/${w.session.id}`, { version: w.session.version, ops: [{ op: "updateItem", itemId: it0.id, rotation: 12 }] })).json;
    expect(p.session.pages[0].items.find((i: PrintItem) => i.id === it0.id).rotation).toBe(12);
  });

  it("daire etiket dikdörtgen yuvaya, köşesi yuvarlak etiket köşesiz yuvaya konunca görünür uyarı", async () => {
    const [a] = await approvedJobs([{ siparis: "8101", etiket: "a1", adet: 1, text: "Anna" }]);
    const rect = await gridTemplate({ columns: 3, rows: 7, shape: "rect", diameterMm: undefined, wMm: 63.5, hMm: 38.1, sizeId: null });
    const r = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: rect.id, jobIds: [a] })).json;
    expect(r.warnings.some((w: string) => w.includes("daire etiket") && w.includes("63.5 × 38.1 mm dikdörtgen"))).toBe(true);
    expect((await t.api("PATCH", `/api/languages/${lang}/templates/a2`, { cut: { shape: "roundRect", wMm: 63.5, hMm: 38.1, radiusMm: 3 } })).status).toBe(200);
    const [b] = await approvedJobs([{ siparis: "8102", etiket: "a2", adet: 1, text: "Marco" }]);
    const c = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: rect.id, jobIds: [b] })).json;
    expect(c.warnings.some((w: string) => w.includes("köşe yarıçapı 3 mm") && w.includes("yuvanınki 0 mm"))).toBe(true);
  });

  it("kesimli iş yalnız şekli ve ölçüsü uyan sayfa şablonuna kendiliğinden gider; uyan yoksa boyutsuz şablona sessizce düşmez", () => {
    const base = { languageId: "l", createdAt: "x", updatedAt: "x", kind: "label" as const };
    const mk = (id: string, sizeId: string | null, slot: Record<string, unknown>) => PrintTemplateSchema.parse({ ...base, id, name: id, paper: { wMm: 210, hMm: 297 }, sizeId, slots: [{ id: "s1", cx: 50, cy: 50, rotation: 0, ...slot }] });
    const round = mk("daire", null, { shape: "circle", w: 38, h: 38 });
    const rect = mk("dikdortgen", null, { shape: "rect", w: 63.5, h: 38.1 });
    const exact = mk("tam", "63.5x38.1", { shape: "rect", w: 63.5, h: 38.1 });
    const cut = { shape: "rect" as const, wMm: 63.5, hMm: 38.1, radiusMm: 0 };
    expect(pageTemplateFor({ kind: "label", cut }, "63.5x38.1", [round, rect, exact])?.id).toBe("tam");
    expect(pageTemplateFor({ kind: "label", cut }, "63.5x38.1", [round, rect])?.id).toBe("dikdortgen");
    expect(pageTemplateFor({ kind: "label", cut }, "63.5x38.1", [round])).toBeNull();
    // Kesimsiz (eski) iş: eski kural (boyutsuz ilk şablon).
    expect(pageTemplateFor({ kind: "label", cut: null }, "3.8", [round, rect])?.id).toBe("daire");
  });

  it("hazır ayarlar boyut kimliği taşır; yuva yazıcının basamadığı kenara (taşma payı dahil) girerse uyarı", async () => {
    const seed = (await t.api("GET", `/api/print/presets?languageId=${lang}`)).json.presets;
    expect(seed.slice(3).map((p: PrintPreset) => p.sizeId)).toEqual(["63.5x38.1", "40x40"]);
    const near = await t.api("POST", "/api/print/templates/grid", { languageId: lang, paper: { wMm: 210, hMm: 297 }, columns: 4, rows: 5, diameterMm: 50, center: true, dryRun: true });
    expect(near.json.warnings.map((w: PrintTemplateWarning) => w.code)).toEqual(["slot-in-printer-margin"]);
    expect(near.json.warnings[0].params).toMatchObject({ marginMm: 4 });
    const ok = await t.api("POST", "/api/print/templates/grid", { languageId: lang, ...seed[3].grid, dryRun: true });
    expect(ok.json.warnings).toEqual([]);
    // Taşma payı 4 mm ile 21'li kağıdın kenar yuvaları (7,2 mm) kenara girer.
    const tpl = await t.api("POST", "/api/print/templates", { languageId: lang, name: "Taşmalı", paper: { wMm: 210, hMm: 297 }, slots: ok.json.slots, cut: { bleedMm: 4 } });
    expect(tpl.json.warnings.map((w: PrintTemplateWarning) => w.code)).toContain("slot-in-printer-margin");
  });
});

describe("gerçek paketlere bağlantı (@tagpress/print, engine)", () => {
  it("gerçek planlayıcı: 36 adet, 35'li şablon → tam sayfa + karışık sayfa, yuvalar geçerli", async () => {
    const { createPrintPlanner } = await import("./adapters/print.ts");
    await t.close();
    t = await makeApp({ ports: fullPorts({ printPlanner: createPrintPlanner(), printRenderer: fakeRenderer() }) });
    lang = await seedLanguage(t);
    const [a] = await approvedJobs([{ siparis: "4849", etiket: "a1", adet: 36, text: "Anna Marco" }]);
    const tpl = await gridTemplate({ columns: 5, rows: 7 });
    const r = await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id });
    expect(r.status, r.body).toBe(200);
    const pages = r.json.session.pages;
    expect(pages[0]).toMatchObject({ kind: "full", copies: 1 });
    expect(pages[0].items).toHaveLength(35);
    const slotIds = new Set(tpl.slots.map((s: PrintSlot) => s.id));
    for (const p of pages) for (const i of p.items) expect(slotIds.has(i.slotId)).toBe(true);
    const shelf = (await t.api("GET", `/api/print/shelf?languageId=${lang}`)).json.items;
    expect(shelf[0].jobId).toBe(a);
    expect(shelf[0].needed).toBeGreaterThan(36);
    expect(shelf[0].placed).toBeGreaterThanOrEqual(36);
  });

  /** İş başına basılacak toplam (öğe × kopya) ve fazlalık olmayan. */
  const totalsOf = (session: PrintSessionFull) => {
    const m: Record<string, { all: number; real: number }> = {};
    for (const p of session.pages)
      for (const i of p.items) {
        const x = (m[i.jobId] ??= { all: 0, real: 0 });
        x.all += p.copies;
        if (!i.extra) x.real += p.copies;
      }
    return m;
  };
  const shape = (session: PrintSessionFull) => session.pages.map((p) => [p.name, p.kind, p.copies, p.items.map((i) => [i.jobId, i.slotId, i.extra])]);

  it("gerçek planlayıcı, yeniden planla: elle yoksa ilk plan; elle taşınan etiket fazlalığı ikinci kez eklemez; kilitli sayfa korunur; raf tutarlı", async () => {
    const { createPrintPlanner } = await import("./adapters/print.ts");
    await t.close();
    t = await makeApp({ ports: fullPorts({ printPlanner: createPrintPlanner(), printRenderer: fakeRenderer() }) });
    lang = await seedLanguage(t);
    const [a, b] = (await approvedJobs([
      { siparis: "4849", etiket: "a1", adet: 34, text: "Anna Marco" },
      { siparis: "4850", etiket: "a2", adet: 6, text: "Lidia Chris" },
    ])) as [string, string];
    const tpl = await gridTemplate({ columns: 5, rows: 7 });
    const s = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id })).json.session;
    const first = totalsOf(s);
    expect(first[a]!.real).toBe(34);
    expect(first[b]!.real).toBe(6);
    const placedOnShelf = async () =>
      Object.fromEntries((await t.api("GET", `/api/print/shelf?languageId=${lang}`)).json.items.map((x: ShelfItem) => [x.jobId, x.placed]));
    expect(await placedOnShelf()).toEqual({ [a]: first[a]!.all, [b]: first[b]!.all });

    // (a) Elle öğe yok: yeniden plan = ilk plan.
    const r0 = (await t.api("POST", `/api/print/sessions/${s.id}/replan`, { version: 0 })).json;
    expect(shape(r0.session)).toEqual(shape(s));

    // (b) Bir etiket elle serbest konuma: toplam ilk plandaki kadar kalır (eski hata: kalan yeniden fazlalıkla planlanırdı).
    const pageA = r0.session.pages.find((p: PrintPageFull) => p.items.some((i: PrintItem) => i.jobId === a));
    const moved = pageA.items.find((i: PrintItem) => i.jobId === a);
    await t.api("PATCH", `/api/print/sessions/${s.id}`, { version: 1, ops: [{ op: "moveItem", itemId: moved.id, xMm: 5, yMm: 5 }] });
    const r1 = (await t.api("POST", `/api/print/sessions/${s.id}/replan`, { version: 2 })).json;
    expect(r1.warnings).toEqual([]);
    expect(totalsOf(r1.session)).toEqual(first);
    expect(r1.session.pages.length).toBe(s.pages.length);
    const keptPage = r1.session.pages.find((p: PrintPageFull) => p.id === pageA.id);
    expect(keptPage.items.find((i: PrintItem) => i.id === moved.id)).toMatchObject({ manual: true, slotId: null, xMm: 5, yMm: 5 });
    for (const p of r1.session.pages) {
      const ids = p.items.map((i: PrintItem) => i.slotId).filter(Boolean);
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(await placedOnShelf()).toEqual({ [a]: first[a]!.all, [b]: first[b]!.all });
    // Tekrar planlamak bir şey değiştirmez.
    const r2 = (await t.api("POST", `/api/print/sessions/${s.id}/replan`, { version: 3 })).json;
    expect(totalsOf(r2.session)).toEqual(first);

    // (c) Kilitli sayfa: kimliği ve öğeleri aynen kalır; toplam yine ilk plandaki kadar.
    const lockedPage = r2.session.pages[r2.session.pages.length - 1];
    await t.api("PATCH", `/api/print/sessions/${s.id}`, { version: 4, ops: [{ op: "updatePage", pageId: lockedPage.id, locked: true }] });
    const r3 = (await t.api("POST", `/api/print/sessions/${s.id}/replan`, { version: 5 })).json;
    const still = r3.session.pages.find((p: PrintPageFull) => p.id === lockedPage.id);
    expect(still).toMatchObject({ locked: true, name: lockedPage.name, copies: lockedPage.copies });
    expect(still.items).toEqual(lockedPage.items);
    expect(totalsOf(r3.session)).toEqual(first);
    expect(await placedOnShelf()).toEqual({ [a]: first[a]!.all, [b]: first[b]!.all });
  });

  // Depodaki açık lisanslı font fikstürü (dil klasörü + ortak yedekler); salt okunur kullanılır.
  const fontsDir = TEST_FONTS_DIR;
  const sharedFonts = TEST_FALLBACK_FONTS_DIR;

  it("gerçek çizici: sayfa PNG (dpi), küçük resim, PDF — fontlar salt okunur", async () => {
    const { createPrintRenderer } = await import("./adapters/print.ts");
    const { FontRegistryCache } = await import("./adapters/fonts.ts");
    const renderer = createPrintRenderer(new FontRegistryCache(sharedFonts, () => [fontsDir], false));
    const profile = ProfileSchema.parse({
      name: "x",
      fonts: { list: [{ id: "Great Vibes/Regular", family: "Great Vibes", style: "Regular", kind: "script", roles: ["primary"], file: "GreatVibes-Regular.ttf" }] },
    });
    const tplPng = path.join(t.dir, "sablon.png");
    writeFileSync(tplPng, await png(420, 420, { r: 240, g: 200, b: 200, alpha: 1 }));
    const layout = fakeLayout({ lines: [{ text: "Anna", role: "name", tier: "primary", fontId: "Great Vibes/Regular" }], rationale: "" });
    const tpl = await gridTemplate();
    const slot = tpl.slots[0];
    const page: PrintRenderPage = {
      pageId: "p",
      sessionId: "s",
      name: "4849_1sayfa",
      index: 0,
      copies: 2,
      templateId: tpl.id,
      templateName: tpl.name,
      printKind: "label",
      paper: tpl.paper,
      slots: tpl.slots,
      cut: tpl.cut,
      cellLabel: { ...tpl.cellLabel, show: true },
      cellLabels: [{ text: "4849_1adet", xMm: slot.cx + 7, yMm: slot.cy + 17, slotId: slot.id }],
      items: [
        {
          itemId: "i",
          jobId: "j",
          variantId: "v",
          orderNo: "4849",
          variantKind: "text",
          printKind: "label",
          centerMm: { x: slot.cx, y: slot.cy },
          rotation: 0,
          mmPerPx: 37 / 440,
          framePx: 440,
          anchorPx: { x: 220, y: 220 },
          diameterMm: 37,
          bleedMm: 0,
          layout,
          geometry: null,
          templatePath: tplPng,
          templateBox: { x: 10, y: 10, w: 420, h: 420 },
          cut: { kind: "circle", cx: 220, cy: 220, r: 218 },
          profile,
          profileVersion: 1,
          fontsDir,
          previewPath: null,
          textLayerPath: null,
          textBox: null,
          extra: false,
          z: 0,
        },
      ],
    };
    const full = await renderer.renderPagePng({ page, dpi: 50 });
    expect(full.subarray(1, 4).toString()).toBe("PNG");
    const meta = await sharp(full).metadata();
    expect(meta.width).toBe(Math.round((210 * 50) / 25.4));
    const thumb = await sharp(await renderer.renderPagePng({ page, dpi: 300, widthPx: 160 })).metadata();
    expect(thumb.width).toBe(160);
    const pdf = await renderer.renderPdf!({ pages: [page], dpi: 50 });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("baskı masası: yuva içi ofset, iş ekleme, adetsiz sipariş, raf toplamı", () => {
  const realApp = async () => {
    const { createPrintPlanner } = await import("./adapters/print.ts");
    await t.close();
    t = await makeApp({ ports: fullPorts({ printPlanner: createPrintPlanner(), printRenderer: fakeRenderer() }) });
    lang = await seedLanguage(t);
  };
  const itemsOf = (s: PrintSessionFull) => s.pages.flatMap((p) => p.items.map((i) => ({ ...i, pageId: p.id })));
  const r2 = (v: number) => Math.round(v * 100) / 100;

  it("yuva içinde ince ayar: aynı yuvada konum korunur, yuva değişince merkeze; yerinden edilen eski yuvanın merkezine; yeniden planlama ve şablon değişikliği ofseti korur", async () => {
    await realApp();
    await approvedJobs([{ siparis: "4849", etiket: "a1", adet: 10, text: "Anna Marco" }]);
    const tpl = await gridTemplate({ columns: 5, rows: 7 });
    const s = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id })).json.session;
    const [a] = s.pages[0].items;
    const sa = tpl.slots.find((x: PrintSlot) => x.id === a.slotId);
    const r1 = await t.api("PATCH", `/api/print/sessions/${s.id}`, { version: 0, ops: [{ op: "moveItem", itemId: a.id, slotId: a.slotId, xMm: sa.cx + 1.5, yMm: sa.cy - 0.7 }] });
    expect(r1.status, r1.body).toBe(200);
    expect(itemsOf(r1.json.session).find((i: PrintItem) => i.id === a.id)).toMatchObject({ slotId: a.slotId, xMm: r2(sa.cx + 1.5), yMm: r2(sa.cy - 0.7), manual: true });
    // Yeniden planlama elle (ofsetli) öğeye dokunmaz.
    const re = (await t.api("POST", `/api/print/sessions/${s.id}/replan`, { version: 1 })).json;
    expect(itemsOf(re.session).find((i: PrintItem) => i.id === a.id)).toMatchObject({ slotId: a.slotId, xMm: r2(sa.cx + 1.5) });
    // Şablonun yuvaları kayınca ofset korunur.
    const shifted = tpl.slots.map((x: PrintSlot) => ({ ...x, cx: x.cx + 2 }));
    expect((await t.api("PATCH", `/api/print/templates/${tpl.id}`, { slots: shifted })).status).toBe(200);
    const after = (await t.api("GET", `/api/print/sessions/${s.id}`)).json;
    expect(itemsOf(after).find((i: PrintItem) => i.id === a.id)!.xMm).toBeCloseTo(sa.cx + 3.5, 2);
    // Ofsetli öğe dolu yuvaya: yer değiştirir; yerinden edilen eski yuvanın MERKEZİNE, taşınan yeni yuvanın merkezine.
    const t2 = (await t.api("GET", `/api/print/templates/${tpl.id}`)).json;
    const c = (id: string) => t2.slots.find((x: PrintSlot) => x.id === id);
    // Yeniden planlama plan öğelerini yeniden yaratır: komşu öğe güncel hâlden.
    const bb = itemsOf(after).find((i: PrintItem) => i.slotId && i.slotId !== a.slotId && i.pageId === s.pages[0].id);
    const b2 = bb!;
    const sw = await t.api("PATCH", `/api/print/sessions/${s.id}`, { version: after.version, ops: [{ op: "moveItem", itemId: a.id, slotId: b2.slotId, xMm: 1, yMm: 1 }] });
    const items = itemsOf(sw.json.session);
    expect(items.find((i: PrintItem) => i.id === a.id)).toMatchObject({ slotId: b2.slotId, xMm: c(b2.slotId!).cx, yMm: c(b2.slotId!).cy });
    expect(items.find((i: PrintItem) => i.id === b2.id)).toMatchObject({ slotId: a.slotId, xMm: c(a.slotId).cx, yMm: c(a.slotId).cy, manual: true });
  });

  it("manual:false (geri al) plan öğesi olarak geri gelir; sticker etiket sayfasına konmaz", async () => {
    const [a] = await approvedJobs([{ siparis: "7", etiket: "a1", adet: 2, text: "Anna Marco" }]);
    const [st] = await approvedJobs([{ siparis: "8", etiket: "", adet: 2, text: "Teşekkürler", urun: "Oyster" }]);
    const tpl = await gridTemplate();
    const s = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id, jobIds: [a] })).json.session;
    const it = s.pages[0].items[0];
    const r = await t.api("PATCH", `/api/print/sessions/${s.id}`, {
      version: 0,
      ops: [
        { op: "removeItem", itemId: it.id },
        { op: "addItem", id: "geri", pageId: s.pages[0].id, jobId: a, slotId: it.slotId, xMm: it.xMm + 1, yMm: it.yMm, manual: false },
        { op: "updateItem", itemId: s.pages[0].items[1].id, rotation: 0, manual: false },
      ],
    });
    expect(r.status, r.body).toBe(200);
    const items = itemsOf(r.json.session);
    expect(items.find((i: PrintItem) => i.id === r.json.ids.geri)).toMatchObject({ manual: false, slotId: it.slotId, xMm: r2(it.xMm + 1) });
    expect(items.find((i: PrintItem) => i.id === s.pages[0].items[1].id)).toMatchObject({ manual: false });
    const bad = await t.api("PATCH", `/api/print/sessions/${s.id}`, { version: 1, ops: [{ op: "addItem", pageId: s.pages[0].id, jobId: st }] });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/Sticker etiket sayfasına konmaz/);
  });

  it("adedi olmayan sipariş: rafta 'adet yok', Planla / yeniden planla / oturuma ekle atlar (gerekçeli); adet girilince planlanır", async () => {
    await realApp();
    const [a, none] = (await approvedJobs([
      { siparis: "100", etiket: "a1", adet: 3, text: "Anna Marco" },
      { siparis: "101", etiket: "a2", text: "Lidia Chris" },
    ])) as [string, string];
    const shelf = (await t.api("GET", `/api/print/shelf?languageId=${lang}`)).json.items;
    expect(shelf.find((x: ShelfItem) => x.jobId === none)).toMatchObject({ quantity: 0, needed: 0, quantityMissing: true });
    const tpl = await gridTemplate({ columns: 5, rows: 7 });
    const cr = await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id, jobIds: [a, none] });
    expect(cr.status, cr.body).toBe(200);
    expect(cr.json.skipped).toEqual([{ jobId: none, reason: expect.stringMatching(/adet yok/) }]);
    expect(itemsOf(cr.json.session).every((i: PrintItem) => i.jobId === a)).toBe(true);
    const only = await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id, jobIds: [none] });
    expect(only.status).toBe(400);
    expect(only.json.error).toMatch(/adedi yok/);
    const sid = cr.json.session.id;
    const add = await t.api("POST", `/api/print/sessions/${sid}/jobs`, { version: 0, jobIds: [none] });
    expect(add.status, add.body).toBe(200);
    expect(add.json.skipped).toEqual([{ jobId: none, reason: expect.stringMatching(/adet yok/) }]);
    expect(add.json.session.version).toBe(0);
    // Adet girilince normal akış: oturuma eklenir.
    expect((await t.api("PATCH", `/api/jobs/${none}`, { quantity: 4 })).status).toBe(200);
    const add2 = await t.api("POST", `/api/print/sessions/${sid}/jobs`, { version: 0, jobIds: [none] });
    expect(add2.json.skipped).toEqual([]);
    expect(itemsOf(add2.json.session).filter((i: PrintItem) => i.jobId === none).length).toBeGreaterThanOrEqual(4);
    expect(add2.json.session.jobIds).toEqual([a, none]);
    const re = (await t.api("POST", `/api/print/sessions/${sid}/replan`, { version: 1 })).json;
    expect(re.skipped).toEqual([]);
  });

  it("açık oturuma iş ekleme: sayfadakiler yerinde kalır, yeni iş boş yuvalara sonra yeni sayfaya; raf needed = ilk plan toplamı", async () => {
    await realApp();
    const [a, b] = (await approvedJobs([
      { siparis: "4849", etiket: "a1", adet: 20, text: "Anna Marco" },
      { siparis: "4850", etiket: "a2", adet: 12, text: "Lidia Chris" },
    ])) as [string, string];
    const tpl = await gridTemplate({ columns: 5, rows: 7 });
    const shelf0 = (await t.api("GET", `/api/print/shelf?languageId=${lang}`)).json.items;
    expect(shelf0.every((x: ShelfItem) => x.neededApprox === false)).toBe(true);
    const s = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id, jobIds: [a] })).json.session;
    const before = itemsOf(s).map((i: PrintItem) => [i.id, i.pageId, i.slotId, i.xMm]);
    const totalA = itemsOf(s).reduce((n: number, i: PrintItem & { pageId: string }) => n + s.pages.find((p: PrintPageFull) => p.id === i.pageId).copies, 0);
    const shelf1 = (await t.api("GET", `/api/print/shelf?languageId=${lang}`)).json.items;
    expect(shelf1.find((x: ShelfItem) => x.jobId === a)).toMatchObject({ needed: totalA, placed: totalA, neededApprox: false });
    const r = await t.api("POST", `/api/print/sessions/${s.id}/jobs`, { version: 0, jobIds: [b] });
    expect(r.status, r.body).toBe(200);
    const after = itemsOf(r.json.session);
    expect(after.filter((i: PrintItem) => i.jobId === a).map((i: PrintItem) => [i.id, i.pageId, i.slotId, i.xMm])).toEqual(before);
    const mixed = r.json.session.pages.find((p: PrintPageFull) => p.items.some((i: PrintItem) => i.jobId === a) && p.items.some((i: PrintItem) => i.jobId === b));
    expect(mixed).toBeTruthy();
    for (const p of r.json.session.pages) {
      const ids = p.items.map((i: PrintItem) => i.slotId);
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(r.json.session.jobIds).toEqual([a, b]);
    const bCount = after.filter((i: PrintItem) => i.jobId === b).length;
    expect(bCount).toBeGreaterThanOrEqual(12);
    const shelf2 = (await t.api("GET", `/api/print/shelf?languageId=${lang}`)).json.items;
    expect(shelf2.find((x: ShelfItem) => x.jobId === b)).toMatchObject({ neededApprox: false, placed: bCount });
    // Eklenen iş oturumun ilk planındaki toplam kadar yerleşti (raf göstergesi ve yeniden planlama ile aynı sayı).
    expect(shelf2.find((x: ShelfItem) => x.jobId === b).needed).toBe(bCount);
    const re = (await t.api("POST", `/api/print/sessions/${s.id}/replan`, { version: 1 })).json;
    const sum = (id: string) => re.session.pages.reduce((n: number, p: PrintPageFull) => n + p.items.filter((i: PrintItem) => i.jobId === id).length * p.copies, 0);
    expect(sum(a)).toBe(shelf2.find((x: ShelfItem) => x.jobId === a).needed);
    expect(sum(b)).toBe(shelf2.find((x: ShelfItem) => x.jobId === b).needed);
    // Şablon yoksa formül ("≈").
    await t.api("POST", `/api/print/templates/${tpl.id}/archive`, {});
    await t.api("DELETE", `/api/print/sessions/${s.id}`);
    const shelf3 = (await t.api("GET", `/api/print/shelf?languageId=${lang}`)).json.items;
    expect(shelf3.every((x: ShelfItem) => x.neededApprox === true)).toBe(true);
  });

  it("sticker ölçüsü: raf ve oturum ayrıntısı mürekkep kutusunu (mm) ve görsel kutusunu taşır", async () => {
    const [st] = await approvedJobs([{ siparis: "5", etiket: "", adet: 2, text: "Teşekkürler", urun: "Oyster" }]);
    const k = 25.4 / 72;
    const shelf = (await t.api("GET", `/api/print/shelf?languageId=${lang}`)).json.items;
    expect(shelf[0]).toMatchObject({ jobId: st, wMm: r2(200 * k) });
    const tpl = (
      await t.api("POST", "/api/print/templates", {
        languageId: lang,
        name: "Sticker A4",
        kind: "sticker",
        sizeId: "istiridye",
        paper: { wMm: 210, hMm: 297 },
        stickerFlow: { marginTopMm: 7.8, marginBottomMm: 8.5, marginSideMm: 7, minGapXMm: 5.3, minRowGapMm: 4.6, maxRowGapLastMm: 6.4 },
      })
    ).json;
    const s = (await t.api("POST", "/api/print/sessions", { languageId: lang, templateId: tpl.id })).json.session;
    const size = s.itemSizes[s.pages[0].items[0].variantId];
    expect(size).toMatchObject({ wMm: shelf[0].wMm, hMm: shelf[0].hMm });
    expect(size.art.wMm).toBeCloseTo(440 * k, 1);
    expect(size.art.xMm).toBeCloseTo(-220 * k, 1);
  });
});

describe("kayıt işareti kutuları", () => {
  const reg = { enabled: true, style: "corners-l" as const, insetMm: 10, sizeMm: 5, thicknessMm: 0.5 };
  const paper = { wMm: 100, hMm: 100 };
  it("dört köşede, motorun çizimiyle aynı ölçüde kutu verir; kapalıyken boş", () => {
    expect(registrationBoxes(paper, { ...reg, enabled: false })).toEqual([]);
    const b = registrationBoxes(paper, reg);
    expect(b).toHaveLength(4);
    expect(b[0]).toEqual({ x0: 10, y0: 10, x1: 15, y1: 15 });
    expect(b[3]).toEqual({ x0: 85, y0: 85, x1: 90, y1: 90 });
    // Kayıt hedefinde çizgi kalınlığının yarısı kadar dışa taşar.
    expect(registrationBoxes(paper, { ...reg, style: "crosshair" })[0]).toEqual({ x0: 9.75, y0: 9.75, x1: 15.25, y1: 15.25 });
  });
  it("çakışan yuvaları bulur; en yakın çözen payı önerir; çözüm yoksa null", () => {
    const slot = { id: "k", shape: "circle" as const, cx: 12, cy: 12, w: 10, h: 10, rotation: 0, cornerRadius: 0 };
    const cut = { registration: reg, bleedMm: 0 };
    expect(markOverlappingSlots(paper, cut, [slot])).toEqual(["k"]);
    expect(clearingInset(paper, cut, [slot])).toBe(2); // daire köşesi kutunun köşesine 7,07 mm uzaklıkta (güvenli alanlı yarıçap 7)
    expect(clearingInset(paper, cut, [{ ...slot, cx: 50, cy: 50 }])).toBe(10);
    expect(clearingInset(paper, cut, [{ ...slot, shape: "rect" as const, cx: 50, cy: 50, w: 98, h: 98 }])).toBeNull();
  });
});
