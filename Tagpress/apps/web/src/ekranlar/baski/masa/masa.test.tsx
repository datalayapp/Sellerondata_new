// @vitest-environment happy-dom
import { type PrintItem, type PrintPatchOp, type PrintSessionDetail, PrintTemplateSchema, type ShelfItem } from "@tagpress/domain";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateGrid } from "../mantik/grid.ts";
import { setShortcutsOpen } from "../../../tezgah/kisayol/kayit.ts";
import { TezgahApp } from "../../../tezgah/rotalar.tsx";
import { click, flush, mockFetch, press, render, waitFor } from "../../../tezgah/test/render.tsx";

/**
 * Baskı masası duman testi (sahte sunucu): raf ve sayfalar çizilir; raftan sayfaya klavyeyle yerleştirme; seçim
 * şeridi ve Hizala menüsü; Yeniden planla; geri al / ileri al; Enter Düzelt penceresini açar; "Dosyayı üret" isteğinin
 * gövdesi; "Basıldı olarak işaretle"; oturum adı değiştirme; en çok bir mor birincil düğme; her ikon düğmesinin adı var;
 * rafta kesim uyumu (kesime uymayan boyutsuz şablon Planla'da önerilmez, uyarı görünür).
 * Sürükle-bırak kuralları `../mantik/masa.test.ts`'te.
 */

// Tuval kabının boyutu: görünür alan seçimi ve ayrıntı düzeyi gerçek hesapla çalışsın.
const W = 1200;
const H = 800;
class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(el: Element) {
    queueMicrotask(() => this.cb([{ target: el, contentRect: { width: W, height: H } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver));
  }
  unobserve() {}
  disconnect() {}
}

const TPL = {
  ...PrintTemplateSchema.parse({
    id: "t1",
    languageId: "dil-1",
    name: "A4 6'lı Ø 40",
    kind: "label",
    paper: { wMm: 210, hMm: 297 },
    sizeId: "3.8",
    slots: generateGrid({ paper: { wMm: 210, hMm: 297 }, columns: 3, rows: 2, diameterMm: 40, pitchXMm: 50, pitchYMm: 50, marginLeftMm: 10, marginTopMm: 10 }).slots,
    createdAt: "2026-11-21T00:00:00Z",
    updatedAt: "2026-11-21T00:00:00Z",
  }),
  warnings: [],
  capacity: 6,
};

const item = (id: string, pageId: string, slot: string, x: number, y: number, jobId = "j1"): PrintItem => ({ id, pageId, jobId, variantId: `v-${jobId}`, slotId: slot, xMm: x, yMm: y, rotation: 0, scale: 1, extra: false, manual: false, z: 0 });

function freshSession(): PrintSessionDetail {
  return {
    id: "s1",
    languageId: "dil-1",
    name: "21 Kasım oturumu",
    status: "draft",
    version: 1,
    createdAt: "2026-11-21T00:00:00Z",
    updatedAt: "2026-11-21T00:00:00Z",
    printedAt: null,
    templateId: "t1",
    sourceSessionId: null,
    jobIds: ["j1", "j2"],
    itemSizes: {},
    notices: [],
    pages: [
      { id: "p1", sessionId: "s1", templateId: "t1", index: 0, name: "Sayfa 1", copies: 1, kind: "plan", showCellLabels: false, locked: false, items: [item("a", "p1", "s1", 30, 30), item("b", "p1", "s2", 80, 30), item("c", "p1", "s3", 130, 30)] },
      { id: "p2", sessionId: "s1", templateId: "t1", index: 1, name: "Sayfa 2", copies: 1, kind: "plan", showCellLabels: false, locked: false, items: [item("d", "p2", "s1", 30, 30, "j2")] },
    ],
  } as unknown as PrintSessionDetail;
}

const shelf = (jobId: string, orderNo: string, placed: number, needed: number): ShelfItem => ({ jobId, variantId: `v-${jobId}`, orderNo, kind: "label", sizeId: "3.8", quantity: needed, needed, placed, designKey: null, previewUrl: `/api/variants/v-${jobId}/preview.png`, product: null });

let serial = 0;
/**
 * Sahte sunucunun yaması: alanları olduğu gibi yazar (yer değiştirme, planlama gibi kurallar yok). Sunucu gibi her
 * eklemeye YENİ kimlik verir (istemci kimliği geçicidir; SUNUCU-PLANI §10.3) ve `ids` eşlemesini döner.
 */
function applyOps(s: PrintSessionDetail, ops: PrintPatchOp[]): { session: PrintSessionDetail; ids: Record<string, string> } {
  const ids: Record<string, string> = {};
  const real = (id: string) => ids[id] ?? id;
  let pages = s.pages.map((p) => ({ ...p, items: [...p.items] }));
  let name = s.name;
  for (const o of ops) {
    if (o.op === "renameSession") name = o.name;
    else if (o.op === "removeItem") pages = pages.map((p) => ({ ...p, items: p.items.filter((i) => i.id !== real(o.itemId)) }));
    else if (o.op === "addItem") {
      const { op: _op, id: tmp, ...rest } = o;
      const id = `srv-${++serial}`;
      if (tmp) ids[tmp] = id;
      const pageId = real(o.pageId);
      pages = pages.map((p) => (p.id === pageId ? { ...p, items: [...p.items, { rotation: 0, scale: 1, z: 0, extra: false, manual: true, slotId: null, xMm: 0, yMm: 0, variantId: "", ...rest, pageId, id } as PrintItem] } : p));
    } else if (o.op === "moveItem" || o.op === "updateItem") {
      const { op: _op, itemId, ...rest } = o;
      pages = pages.map((p) => ({ ...p, items: p.items.map((i) => (i.id === real(itemId) ? ({ ...i, ...rest } as PrintItem) : i)) }));
    } else if (o.op === "updatePage") {
      const { op: _op, pageId, ...rest } = o;
      pages = pages.map((p) => (p.id === real(pageId) ? { ...p, ...rest } : p));
    }
  }
  return { session: { ...s, name, pages, version: s.version + 1 }, ids };
}

let session: PrintSessionDetail;
let templates: (typeof TPL)[];
let shelfItems: ShelfItem[];
let api: ReturnType<typeof mockFetch>;
const body = (init?: RequestInit) => JSON.parse(String(init?.body ?? "{}"));

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* yok */
  }
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  serial = 0;
  session = freshSession();
  templates = [TPL];
  shelfItems = [{ ...shelf("j1", "9019", 3, 6), product: "Mila 1 yaşında" }, shelf("j2", "9012", 1, 4), shelf("j3", "9001", 0, 0)];
  api = mockFetch(routes());
});

/** Sahte sunucunun uçları (test kendi ucunu üstüne yazabilir). */
function routes(): Record<string, unknown> {
  return {
    "/api/languages": { languages: [{ id: "dil-1", name: "GiftUpStore", isDefault: true }] },
    "/api/generate/status": { running: 0, queued: 0, concurrency: 1, runningJobIds: [] },
    "/api/languages/dil-1/profile": { data: { printing: { dpi: 300 } } },
    "/api/print/templates": () => ({ templates }),
    "/api/print/shelf": () => ({ items: shelfItems }),
    "/api/print/sessions": { sessions: [{ id: "s1", name: session.name, status: "draft", pageCount: 2, sheetCount: 2, itemCount: 4, jobCount: 2, orderNos: [], updatedAt: new Date().toISOString() }] },
    "/api/print/sessions/s1": (_u: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const r = applyOps(session, body(init).ops);
        session = r.session;
        return { session, warnings: [], undo: null, ...(Object.keys(r.ids).length ? { ids: r.ids } : {}) };
      }
      return session;
    },
    "/api/print/sessions/s1/replan": () => {
      session = { ...session, version: session.version + 1 };
      return { session, warnings: [], undo: null, skipped: [] };
    },
    "/api/print/sessions/s1/export": { id: "e1", sessionId: "s1", format: "pdf", status: "queued", done: 0, total: 2, files: [], error: null, createdAt: "2026-11-21T00:00:00Z", finishedAt: null },
    "/api/print/exports/e1": { id: "e1", sessionId: "s1", format: "pdf", status: "done", done: 2, total: 2, files: [{ name: "21-kasim.pdf", url: "/api/print/exports/e1/files/0", bytes: 204800 }], error: null, createdAt: "2026-11-21T00:00:00Z", finishedAt: "2026-11-21T00:01:00Z" },
    "/api/print/sessions/s1/printed": () => ({ ...session, status: "printed" }),
  };
}

afterEach(() => {
  setShortcutsOpen(false);
  document.body.innerHTML = "";
});

async function open(hash = "#/baski/masa/s1") {
  window.location.hash = hash;
  const r = await render(<TezgahApp />);
  await waitFor(() => document.querySelectorAll(".tz-ab").length === 2 && document.querySelectorAll(".bm-it").length === 4 && document.querySelectorAll(".bm-card").length > 0);
  await flush(3);
  return r;
}

const patches = () => api.calls.filter((c) => c.method === "PATCH" && c.url.includes("/api/print/sessions/s1"));
const opsOf = (n: number) => (patches()[n]?.body as { ops: PrintPatchOp[] } | undefined)?.ops ?? [];
const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const buttonByText = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text) ?? null;

/** Dünya (mm) → istemci (px): dünya katmanının dönüşümünden (tuval kabı 0,0'da). */
function toClient(x: number, y: number) {
  const tf = document.querySelector<HTMLElement>(".tz-cv-world")!.style.transform;
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(tf)!;
  return { clientX: Number(m[1]) + x * Number(m[3]), clientY: Number(m[2]) + y * Number(m[3]) };
}
async function pointer(type: "pointerdown" | "pointerup", at: { clientX: number; clientY: number }) {
  const stage = document.querySelector(".bm-stage")!;
  await act(async () => {
    stage.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, ...at }));
  });
}
async function clickAt(x: number, y: number) {
  const at = toClient(x, y);
  await pointer("pointerdown", at);
  await pointer("pointerup", at);
}

function frameChecks() {
  expect(document.querySelectorAll(".tz-btn--primary").length).toBeLessThanOrEqual(1);
  for (const b of document.querySelectorAll<HTMLButtonElement>(".tz-ib, .tz-cb.is-q, .tz-st button")) {
    expect(b.getAttribute("aria-label") || b.textContent?.trim(), b.outerHTML.slice(0, 120)).toBeTruthy();
  }
}

// Sayfaların masadaki yeri: 2 sayfa → 2 sütun; ilk sayfa (0, 12), ikinci (234, 12).
const P2 = { x: 234, y: 12 };

describe("Baskı masası", () => {
  it("raf ve sayfalar çizilir; tek birincil düğme, ikon düğmelerinin adı var", async () => {
    const r = await open();
    expect(document.querySelectorAll(".tz-ab")).toHaveLength(2);
    expect(document.querySelectorAll(".bm-it")).toHaveLength(4);
    expect(document.querySelector(".bm-g .bm-gt b")?.textContent).toBe("3,8 cm etiket");
    expect(document.querySelectorAll(".bm-card")).toHaveLength(2);
    // Raf kartı: sipariş no + ürün adı, altında "yerleşen / gereken" (yerleşen kalın; çubuk yok).
    const j1 = document.querySelector<HTMLElement>('.bm-card[data-job="j1"]')!;
    expect(j1.querySelector(".bm-card-t > b")?.textContent).toBe("9019 Mila 1 yaşında");
    expect(j1.querySelector(".bm-card-t small")?.textContent).toBe("3 / 6 yerleşti");
    expect(j1.querySelector(".bm-card-n")?.textContent).toBe("3");
    expect(document.querySelector('.bm-card[data-job="j2"] .bm-card-t > b')?.textContent).toBe("9012");
    // Bütünüyle dizilmiş iş (9001) tek satırda.
    expect(document.querySelector(".bm-done")?.textContent).toContain("1 iş dizildi");
    expect(document.querySelector(".tz-ctx .tz-cr")?.textContent).toContain("21 Kasım oturumu");
    expect(document.querySelector(".tz-ctx [role=tablist]")?.textContent).toContain("Sayfa şablonları");
    expect(document.querySelector(".tz-pnl--r .tz-pnl-f .tz-btn--primary")?.textContent).toContain("Dosyayı üret");
    expect(buttonByText("Basıldı olarak işaretle")).not.toBeNull();
    expect(document.querySelector(".tz-sb")?.textContent).toContain("Kayıtlı");
    frameChecks();
    await click(document.querySelector<HTMLButtonElement>(".bm-done .bm-lnk")!);
    await waitFor(() => document.querySelectorAll(".bm-card").length === 3);
    await r.unmount();
  });

  it("sayfaya tıklayınca etkin olur; raf kartında Enter etiketi o sayfanın boş yuvasına koyar", async () => {
    const r = await open();
    await clickAt(P2.x + 105, P2.y + 250);
    await waitFor(() => document.querySelector(".tz-pnl--r .tz-pnl-t")?.textContent === "Sayfa 2");
    const card = document.querySelector<HTMLElement>('.bm-card[data-job="j1"]')!;
    card.focus();
    await press("Enter", { target: card });
    await waitFor(() => patches().length === 1);
    const add = opsOf(0).find((o) => o.op === "addItem");
    expect(add).toMatchObject({ op: "addItem", pageId: "p2", jobId: "j1", slotId: "s2", xMm: 80, yMm: 30 });
    await r.unmount();
  });

  it("konan etiket kaydedilince gerçek kimlik alır: seçim kalır, ok tuşu ve geri al gerçek kimlikle gider", async () => {
    const r = await open();
    await clickAt(P2.x + 105, P2.y + 250);
    await waitFor(() => document.querySelector(".tz-pnl--r .tz-pnl-t")?.textContent === "Sayfa 2");
    const card = document.querySelector<HTMLElement>('.bm-card[data-job="j1"]')!;
    card.focus();
    await press("Enter", { target: card });
    await waitFor(() => patches().length === 1);
    const tmp = (opsOf(0).find((o) => o.op === "addItem") as { id: string }).id;
    expect(tmp).not.toBe("srv-1");
    await waitFor(() => document.querySelector('[data-item="srv-1"]'));
    expect(document.querySelector(`[data-item="${tmp}"]`)).toBeNull();
    expect(document.querySelector(".tz-selbar b")?.textContent).toBe("1 etiket seçili");
    // Etkin sayfa da yerinde.
    expect(document.querySelector(".tz-pnl--r .tz-pnl-t")?.textContent).toBe("Sayfa 2");

    (document.activeElement as HTMLElement | null)?.blur();
    await press("ArrowRight", { shiftKey: true });
    await waitFor(() => patches().length === 2);
    expect(opsOf(1)).toEqual([expect.objectContaining({ op: "moveItem", itemId: "srv-1", xMm: 81 })]);

    await press("z", { ctrlKey: true });
    await waitFor(() => patches().length === 3);
    expect(opsOf(2)).toEqual([expect.objectContaining({ op: "moveItem", itemId: "srv-1", xMm: 80 })]);
    await press("z", { ctrlKey: true });
    await waitFor(() => patches().length === 4);
    expect(opsOf(3)).toEqual([{ op: "removeItem", itemId: "srv-1" }]);
    await r.unmount();
  });

  it("seçim şeridi ve Hizala menüsü; sil, geri al ve ileri al", async () => {
    const r = await open();
    await press("a", { ctrlKey: true });
    await waitFor(() => document.querySelector(".tz-selbar"));
    expect(document.querySelector(".tz-selbar b")?.textContent).toBe("4 etiket seçili");
    frameChecks();
    await click(buttonByText("Hizala")!);
    const items = await waitFor(() => (document.querySelectorAll("[role=menuitem]").length ? [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")] : null));
    expect(items.map((b) => b.textContent?.trim())).toEqual(["Sola hizala", "Yatayda ortala", "Sağa hizala", "Üste hizala", "Dikeyde ortala", "Alta hizala", "Yatayda eşit dağıt (en az 3)", "Dikeyde eşit dağıt (en az 3)"]);
    await click(items[3]!);
    await waitFor(() => patches().length === 1);
    expect(opsOf(0).length).toBeGreaterThan(0);

    await press("Delete");
    await waitFor(() => patches().length === 2);
    expect(opsOf(1).filter((o) => o.op === "removeItem")).toHaveLength(4);
    await waitFor(() => document.querySelectorAll(".bm-it").length === 0);

    await press("z", { ctrlKey: true });
    await waitFor(() => patches().length === 3);
    expect(opsOf(2).filter((o) => o.op === "addItem")).toHaveLength(4);
    await waitFor(() => document.querySelectorAll(".bm-it").length === 4);

    await press("y", { ctrlKey: true });
    await waitFor(() => patches().length === 4);
    expect(opsOf(3).filter((o) => o.op === "removeItem")).toHaveLength(4);
    await r.unmount();
  });

  it("Yeniden planla sunucunun planlayıcısını sürümle çağırır", async () => {
    const r = await open();
    await click(buttonByText("Yeniden planla")!);
    await waitFor(() => api.calls.some((c) => c.url.endsWith("/api/print/sessions/s1/replan")));
    expect(api.calls.find((c) => c.url.endsWith("/replan"))?.body).toEqual({ version: 1 });
    await waitFor(() => document.body.textContent?.includes("Yeniden planlandı"));
    await r.unmount();
  });

  it("tek etiket seçiliyken Enter Düzelt penceresini masanın üstünde açar; Kaydet kapatır ve rafı tazeler", async () => {
    // Düzelt uçları (yalnız yanıt şekli): yazı katmanı yok, tek satır.
    const box = { x: 170, y: 200, w: 100, h: 40 };
    let stored: unknown = null;
    api = mockFetch({
      ...routes(),
      "/api/variants/v-j1/edit": () => ({
        variantId: "v-j1",
        jobId: "j1",
        framePx: 440,
        templateImageUrl: null,
        templateBox: { x: 0, y: 0, w: 440, h: 440 },
        cut: { kind: "circle", cx: 220, cy: 220, r: 200 },
        cutBox: { x: 20, y: 20, w: 400, h: 400 },
        areaBox: { x: 80, y: 80, w: 280, h: 280 },
        centers: { textCenter: { x: 220, y: 220, source: "template" }, area: { x: 220, y: 220 }, cut: { x: 220, y: 220 } },
        origin: { x: 220, y: 220 },
        ink: box,
        lines: [{ index: 0, text: "Mila", sizePx: 40, ink: box, strokePx: 0, fontId: "Sans/Regular" }],
        fonts: null,
        fontMixing: "free",
        strokePx: 0,
        strokeAlign: "outside",
        textLayerUrl: null,
        adjust: stored,
        adjustedInk: box,
        issues: [],
        previewUrl: "/p.png",
        limits: { scaleMin: 0.5, scaleMax: 2, shiftMaxPx: 200, strokeMaxPx: 20 },
      }),
      "/api/variants/v-j1": { id: "v-j1", jobId: "j1", no: 1, snapshot: { languageId: "dil-1", labelSize: "3.8" } },
      "/api/jobs/j1": { id: "j1", orderNo: "9019", text: "Mila", languageId: "dil-1", labelSize: "3.8" },
      "/api/variants/v-j1/adjust/check": { adjust: null, ink: box, lineInks: [], lineStrokes: [], issues: [], collision: null, ms: 1 },
      "/api/variants/v-j1/adjust": (_u: string, init?: RequestInit) => {
        stored = body(init).adjust;
        return { variant: { id: "v-j1" }, undo: { undoToken: "u1", label: "geri" } };
      },
    });
    const r = await open();
    await clickAt(80, 12 + 30);
    await waitFor(() => document.querySelector(".tz-selbar b")?.textContent === "1 etiket seçili");
    (document.activeElement as HTMLElement | null)?.blur();
    await press("Enter");
    const dlg = await waitFor(() => document.querySelector("dialog.tz-wd[open]"));
    await waitFor(() => dlg.querySelector(".dz-stage"));
    await flush();
    // Adres değişmez; masa altta kalır.
    expect(window.location.hash).toBe("#/baski/masa/s1");
    expect(document.querySelectorAll(".bm-it")).toHaveLength(4);
    expect(dlg.querySelector(".tz-wd-sub")?.textContent).toBe("№ 9019 · V1 · Mila");
    // Pencere açıkken masanın kısayolları çalışmaz: ok ve Ctrl Z pencerenin yazısında.
    await press("ArrowRight");
    await press("z", { ctrlKey: true });
    await press("ArrowRight");
    await flush();
    expect(patches()).toHaveLength(0);
    const shelfReads = api.calls.filter((c) => c.url.includes("/api/print/shelf")).length;
    await click(buttonByText("KaydetCtrl S")!);
    await waitFor(() => !document.querySelector("dialog.tz-wd"));
    expect(api.calls.find((c) => c.method === "PUT" && c.url.endsWith("/api/variants/v-j1/adjust"))?.body).toEqual({ adjust: { dx: 1, dy: 0, scale: 1 } });
    await waitFor(() => api.calls.filter((c) => c.url.includes("/api/print/shelf")).length > shelfReads);
    expect(window.location.hash).toBe("#/baski/masa/s1");
    await r.unmount();
  });

  it("Düzelt penceresi Vazgeç ile kapanır; masa yerinde kalır", async () => {
    const r = await open();
    await clickAt(80, 12 + 30);
    await waitFor(() => document.querySelector(".tz-selbar b")?.textContent === "1 etiket seçili");
    (document.activeElement as HTMLElement | null)?.blur();
    await press("Enter");
    // Düzelt uçları yok: pencere açılır, iletiyi gösterir; Esc kapatır.
    await waitFor(() => document.querySelector("dialog.tz-wd[open] .dz-msg"));
    await press("Escape", { target: document.querySelector("dialog.tz-wd")! });
    await waitFor(() => !document.querySelector("dialog.tz-wd"));
    expect(window.location.hash).toBe("#/baski/masa/s1");
    expect(document.querySelector(".tz-selbar b")?.textContent).toBe("1 etiket seçili");
    await r.unmount();
  });

  it("'Dosyayı üret' seçeneklerle istek gönderir; dosya hazır olunca bağlantısı görünür", async () => {
    const r = await open();
    await click(document.querySelector<HTMLButtonElement>('[role=radio][aria-checked="false"]')!); // Biçim: PNG
    await click(buttonByText("Dosyayı üret")!);
    await waitFor(() => api.calls.some((c) => c.url.endsWith("/api/print/sessions/s1/export")));
    expect(api.calls.find((c) => c.url.endsWith("/export"))?.body).toEqual({ format: "png" });
    await waitFor(() => document.querySelector(".bm-files a")?.textContent === "21-kasim.pdf");
    expect(document.querySelector(".bm-files small")?.textContent).toBe("200 KB");
    await r.unmount();
  });

  const STALE = { code: "plan-stale", message: "yedek", params: { sheets: 7, replanSheets: 4 } } as const;

  it("bildirim yoksa tuvalde şerit yok; varsa metin sözlükten, parametreli", async () => {
    let r = await open();
    expect(document.querySelector(".bm-notices")).toBeNull();
    await r.unmount();
    session = {
      ...session,
      notices: [STALE, { code: "sticker-small-text", message: "y", params: { orderNo: "9019", pt: 4, minPt: 6 } }, { code: "sticker-small-text", message: "y", params: { orderNo: "9012", pt: 5, minPt: 6 } }],
    };
    r = await open();
    const text = document.querySelector(".bm-notices")?.textContent ?? "";
    expect(text).toContain("7 kağıt");
    expect(text).toContain("yaklaşık 4 kağıt");
    expect(text).toContain("9019 (4 pt, sınır 6 pt) · 9012 (5 pt, sınır 6 pt)");
    await r.unmount();
  });

  it("eski ölçüyle basılmış bildirimi düğmesiz bilgi olarak görünür", async () => {
    session = { ...session, notices: [{ code: "printed-old-scale", message: "y" }] };
    const r = await open();
    expect(document.querySelector(".bm-notices .tz-issue--info")).not.toBeNull();
    expect(document.querySelector(".bm-notices button")).toBeNull();
    await r.unmount();
  });

  it("şerideki 'Yeniden planla' düğmesi yeniden planlamayı çağırır", async () => {
    session = { ...session, notices: [STALE] };
    const r = await open();
    const btn = document.querySelector<HTMLButtonElement>(".bm-notices button")!;
    await click(btn);
    await waitFor(() => api.calls.some((c) => c.url.endsWith("/api/print/sessions/s1/replan")));
    await r.unmount();
  });

  it("eski ölçüyle dizilmiş oturumda 'Dosyayı üret' önce sorar: 'Yine de üret' dosyayı üretir", async () => {
    session = { ...session, notices: [STALE] };
    const r = await open();
    await click(buttonByText("Dosyayı üret")!);
    await waitFor(() => buttonByText("Yine de üret"));
    expect(api.calls.some((c) => c.url.endsWith("/export"))).toBe(false);
    await click(buttonByText("Yine de üret")!);
    await waitFor(() => api.calls.some((c) => c.url.endsWith("/api/print/sessions/s1/export")));
    await r.unmount();
  });

  it("eski ölçüyle dizilmiş oturumda 'Önce yeniden planla' yeniden planlar, dosya üretmez", async () => {
    session = { ...session, notices: [STALE] };
    const r = await open();
    await click(buttonByText("Dosyayı üret")!);
    await click((await waitFor(() => buttonByText("Önce yeniden planla")))!);
    await waitFor(() => api.calls.some((c) => c.url.endsWith("/api/print/sessions/s1/replan")));
    expect(api.calls.some((c) => c.url.endsWith("/export"))).toBe(false);
    await r.unmount();
  });

  it("'Basıldı olarak işaretle' onaydan sonra oturumu arşive geçirir", async () => {
    const r = await open();
    await click(buttonByText("Basıldı olarak işaretle")!);
    const ok = await waitFor(() => buttonByText("Basıldı"));
    await click(ok);
    await waitFor(() => api.calls.some((c) => c.url.endsWith("/api/print/sessions/s1/printed")));
    expect(api.calls.find((c) => c.url.endsWith("/printed"))?.body).toEqual({ printed: true, version: 1 });
    await waitFor(() => document.body.textContent?.includes("“21 Kasım oturumu” arşive geçti."));
    await r.unmount();
  });

  it("'Taslak oturumlar' menüsünde eski ölçülerle dizili taslak kısa uyarı taşır", async () => {
    api = mockFetch({
      ...routes(),
      "/api/print/sessions": {
        sessions: [
          { id: "s1", name: session.name, status: "draft", pageCount: 2, sheetCount: 2, itemCount: 4, jobCount: 2, orderNos: [], updatedAt: new Date().toISOString(), noticeCodes: ["plan-stale"] },
          { id: "s2", name: "Başka taslak", status: "draft", pageCount: 1, sheetCount: 1, itemCount: 1, jobCount: 1, orderNos: [], updatedAt: new Date().toISOString() },
        ],
      },
    });
    const r = await open();
    await click(buttonByText("Taslak oturumlar")!);
    const items = await waitFor(() => (document.querySelectorAll("[role=menuitem]").length ? [...document.querySelectorAll<HTMLElement>("[role=menuitem]")] : null));
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("21 Kasım oturumu");
    expect(items[0]!.textContent).toContain("Eski ölçülerle dizili · yeniden planlayın");
    expect(items[1]!.textContent).toContain("Başka taslak");
    expect(items[1]!.textContent).not.toContain("Eski ölçülerle");
    await press("Escape");
    await r.unmount();
  });

  it("oturum adı iş satırında yerinde değişir", async () => {
    const r = await open();
    const crumb = [...document.querySelectorAll<HTMLElement>(".tz-cr-b")].find((b) => b.textContent === "21 Kasım oturumu")!;
    await click(crumb);
    const input = await waitFor(() => document.querySelector<HTMLInputElement>(".tz-cr-in"));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Yılbaşı baskısı");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press("Enter", { target: input });
    await waitFor(() => patches().length === 1);
    expect(opsOf(0)).toEqual([{ op: "renameSession", name: "Yılbaşı baskısı" }]);
    await r.unmount();
  });

  it("iş satırı: sekmeler önce; 'Taslak oturumlar' taslakları, '⋯' arşivi ve silmeyi açar; ? kısayol listesini açar", async () => {
    const r = await open();
    const row = document.querySelector(".tz-ctx")!;
    const tabs = row.querySelector("[role=tablist]")!;
    const name = row.querySelector(".tz-cr")!;
    expect(tabs.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(name.textContent).not.toContain("Baskı");
    await click(buttonByText("Taslak oturumlar")!);
    const drafts = await waitFor(() => (document.querySelectorAll("[role=menuitem]").length ? [...document.querySelectorAll<HTMLElement>("[role=menuitem]")] : null));
    expect(drafts.map((b) => b.textContent)).toEqual([expect.stringContaining("21 Kasım oturumu")]);
    await press("Escape");
    await click(byLabel("Oturum eylemleri")!);
    const more = await waitFor(() => (document.querySelectorAll("[role=menuitem]").length ? [...document.querySelectorAll<HTMLElement>("[role=menuitem]")] : null));
    expect(more.map((b) => b.textContent?.trim())).toEqual(["Arşive git", "Oturumu sil"]);
    await press("Escape");
    await press("?", { shiftKey: true });
    await waitFor(() => document.querySelector("dialog .tz-kp"));
    expect(document.body.textContent).toContain("Raftan bırakırken");
    expect(byLabel("Baskı önizlemesi: kesim çizgisi ve işaretler")).not.toBeNull();
    await r.unmount();
  });

  it("raf: kesim kimlikli grupta boyutsuz şablon yalnız yuvaları kesime uyuyorsa önerilir; uymayan için uyarı", async () => {
    const loose = (id: string, name: string, slots: ReturnType<typeof generateGrid>["slots"]) => ({ ...TPL, id, name, sizeId: null, slots, capacity: slots.length });
    const daire = loose("t2", "Boyutsuz Ø40", TPL.slots);
    templates = [TPL, daire];
    // Kesimli iş: sunucu raf satırına şablonun kendi kesimini koyar (`cut`); kural bununla ayrılır.
    shelfItems = [...shelfItems, { ...shelf("j4", "9030", 0, 21), sizeId: "63.5x38.1", cut: { shape: "rect", wMm: 63.5, hMm: 38.1, radiusMm: 0 } }];
    let r = await open();
    const group = () => [...document.querySelectorAll<HTMLElement>(".bm-g")].find((g) => g.querySelector(".bm-gt b")?.textContent === "63,5 × 38,1 mm etiket")!;
    await waitFor(() => group());
    expect(group().textContent).toContain("63,5 × 38,1 mm kesimine uyan sayfa şablonu yok: boyutsuz şablonun (Boyutsuz Ø40) yuvaları bu kesime uymuyor.");
    expect([...group().querySelectorAll("button")].map((b) => b.textContent?.trim())).toContain("Şablon kur");
    // 3,8 cm grubunda eski kural: tam uyan şablon (t1) varken uyarı yok.
    const g38 = [...document.querySelectorAll<HTMLElement>(".bm-g")].find((g) => g.querySelector(".bm-gt b")?.textContent === "3,8 cm etiket")!;
    expect(g38.textContent).not.toContain("kesimine uyan");
    await r.unmount();
    document.body.innerHTML = "";

    const urun = loose("t3", "Boyutsuz ürün", generateGrid({ paper: { wMm: 210, hMm: 297 }, columns: 3, rows: 7, shape: "rect", wMm: 63.5, hMm: 38.1, pitchXMm: 66.04, pitchYMm: 38.1, marginLeftMm: 7.21, marginTopMm: 15.15 }).slots);
    templates = [TPL, daire, urun];
    r = await open();
    await waitFor(() => group());
    expect(group().textContent).not.toContain("kesimine uyan");
    const plan = [...group().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Planla")!;
    await click(plan);
    await waitFor(() => api.calls.some((c) => c.method === "POST" && c.url.endsWith("/api/print/sessions")));
    expect((api.calls.find((c) => c.method === "POST" && c.url.endsWith("/api/print/sessions"))?.body as { templateId: string }).templateId).toBe("t3");
    await r.unmount();
  });

  it("raf: daire kesimli iş eski boyutlu işten ayrı grupta; Planla yalnız çapı uyan boyutsuz şablonu kullanır", async () => {
    const loose = (id: string, name: string, slots: ReturnType<typeof generateGrid>["slots"]) => ({ ...TPL, id, name, sizeId: null, slots, capacity: slots.length });
    const urun = loose("t3", "Boyutsuz ürün", generateGrid({ paper: { wMm: 210, hMm: 297 }, columns: 3, rows: 7, shape: "rect", wMm: 63.5, hMm: 38.1, pitchXMm: 66.04, pitchYMm: 38.1, marginLeftMm: 7.21, marginTopMm: 15.15 }).slots);
    templates = [TPL, urun, loose("t2", "Boyutsuz Ø40", TPL.slots)];
    // Aynı boyut kimliği "4": biri Ø40 daire kesimli, biri eski 4 cm.
    shelfItems = [...shelfItems, { ...shelf("j5", "9040", 0, 6), sizeId: "4", cut: { shape: "circle", wMm: 40, hMm: 40, radiusMm: 0 } }, { ...shelf("j6", "9041", 0, 6), sizeId: "4" }];
    const r = await open();
    const titled = (title: string) => [...document.querySelectorAll<HTMLElement>(".bm-g")].find((g) => g.querySelector(".bm-gt b")?.textContent === title);
    const cutGroup = await waitFor(() => titled("Ø 40 mm etiket"));
    expect(titled("4 cm etiket")).toBeTruthy();
    expect(cutGroup.textContent).toContain("9040");
    expect(cutGroup.textContent).not.toContain("9041");
    const plan = [...cutGroup.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Planla")!;
    await click(plan);
    await waitFor(() => api.calls.some((c) => c.method === "POST" && c.url.endsWith("/api/print/sessions")));
    expect(api.calls.find((c) => c.method === "POST" && c.url.endsWith("/api/print/sessions"))?.body).toMatchObject({ templateId: "t2", jobIds: ["j5"] });
    await r.unmount();
  });
});
