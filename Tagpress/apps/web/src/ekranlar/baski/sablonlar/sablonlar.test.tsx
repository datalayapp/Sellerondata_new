// @vitest-environment happy-dom
import { type PrintPreset, PrintPresetSchema, type PrintSlot, type PrintTemplatePatch, PrintTemplateSchema, type PrintTemplateView } from "@tagpress/domain";
import { clearingInset } from "@tagpress/print";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatMm } from "../../../i18n/bicim.ts";
import { generateGrid } from "../mantik/grid.ts";
import { newTemplateBody } from "../mantik/sablon/draft.ts";
import { layoutMargins } from "../mantik/sablon/yerlesim.ts";
import { setShortcutsOpen } from "../../../tezgah/kisayol/kayit.ts";
import { TezgahApp } from "../../../tezgah/rotalar.tsx";
import { click, flush, mockFetch, press, render, waitFor } from "../../../tezgah/test/render.tsx";

/**
 * Sayfa şablonları duman testi (sahte sunucu).
 * Liste: kartlar, kullanım sayısı, arama ve tür, görünür Sil (kullanılmamış kalıcı silinir, kullanılmış arşive kalkar),
 * Yeni şablon. Düzenleyici: sol liste yok, iş satırında Sil ve Kaydet; boş şablonda dizilişi yerleştirme; yuvayı mm ile
 * taşıma ve geri alma; sürüklerken kâğıt ortasına yapışma, kılavuz ve mm (Alt ile yapışmaz); hep görünen Ortala şeridi;
 * kâğıt değişince ortalı yerleşim ortada kalır; diziliş değişince yeniden dizme (elle taşınmışsa sorar); uyarılar;
 * Hizala menüsü; Ctrl S gövdesi; kirliyken çıkışta onay; hazır ayar; en çok bir mor birincil düğme.
 */

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

const A4 = { wMm: 210, hMm: 297 };
const circle = (id: string, cx: number, cy: number, d = 40): PrintSlot => ({ id, shape: "circle", cx, cy, w: d, h: d, rotation: 0, cornerRadius: 0 });
/** A4'e ortalı 4 × 6, Ø 40, 6 mm aralık (kenar payları 16 / 13,5). */
const GRID24 = generateGrid({ paper: A4, columns: 4, rows: 6, shape: "circle", diameterMm: 40, gapXMm: 6, gapYMm: 6, center: true }).slots;

function tpl(id: string, name: string, over: Record<string, unknown> = {}): PrintTemplateView {
  const { usedIn, ...rest } = over as { usedIn?: number };
  const t = PrintTemplateSchema.parse({ id, languageId: "dil-1", name, kind: "label", paper: A4, sizeId: "3.8", createdAt: "2026-11-21T00:00:00Z", updatedAt: "2026-11-21T00:00:00Z", ...rest });
  return { ...t, warnings: [], capacity: t.slots.length, usedIn: usedIn ?? 0 };
}

const REG = { enabled: true, style: "corners-l", insetMm: 10, sizeMm: 5, thicknessMm: 0.5 };
let templates: PrintTemplateView[];
let presets: PrintPreset[];
let api: ReturnType<typeof mockFetch>;
const body = (init?: RequestInit) => JSON.parse(String(init?.body ?? "{}"));

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* yok */
  }
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  templates = [
    tpl("t1", "A4 3'lü Ø 40", { slots: [circle("s1", 30, 30), circle("s2", 80, 40), circle("s3", 130, 50)], usedIn: 3 }),
    tpl("t2", "Boş sayfa"),
    tpl("t3", "İşaretli", { paper: { wMm: 100, hMm: 100 }, slots: [circle("k", 12, 12, 10), circle("o", 50, 50, 10)], cut: { registration: REG } }),
  ];
  presets = [];
  const one = (id: string) => (_u: string, init?: RequestInit) => {
    const i = templates.findIndex((x) => x.id === id);
    if (init?.method === "DELETE") {
      const cur = templates[i]!;
      if (cur.usedIn) {
        templates[i] = { ...cur, archived: true };
        return { result: "archived" };
      }
      templates = templates.filter((x) => x.id !== id);
      return { result: "deleted" };
    }
    if (init?.method === "PATCH") {
      const p = body(init) as PrintTemplatePatch;
      const cur = templates[i]!;
      templates[i] = { ...cur, ...(p as object), cut: { ...cur.cut, ...(p.cut ?? {}), registration: { ...cur.cut.registration, ...(p.cut?.registration ?? {}) } }, updatedAt: `2026-11-21T00:00:0${i + 1}Z` } as PrintTemplateView;
    }
    return templates[i];
  };
  const archive = (id: string) => (_u: string, init?: RequestInit) => {
    const i = templates.findIndex((x) => x.id === id);
    templates[i] = { ...templates[i]!, archived: body(init).archived };
    return templates[i];
  };
  api = mockFetch({
    "/api/languages": { languages: [{ id: "dil-1", name: "GiftUpStore", isDefault: true }] },
    "/api/generate/status": { running: 0, queued: 0, concurrency: 1, runningJobIds: [] },
    "/api/print/presets": () => ({ presets }),
    "/api/print/templates": (u: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const v = tpl("t9", body(init).name);
        templates = [...templates, v];
        return v;
      }
      return { templates: u.includes("archived=1") ? templates : templates.filter((x) => !x.archived) };
    },
    ...Object.fromEntries(["t1", "t2", "t3", "t4", "t5"].flatMap((id) => [[`/api/print/templates/${id}`, one(id)], [`/api/print/templates/${id}/archive`, archive(id)]])),
  });
});

afterEach(() => {
  setShortcutsOpen(false);
  document.body.innerHTML = "";
});

async function open(hash: string, ready: () => unknown) {
  window.location.hash = hash;
  const r = await render(<TezgahApp />);
  await waitFor(() => document.querySelector(".tz-top") && ready());
  await flush(3);
  return r;
}
const cards = () => [...document.querySelectorAll<HTMLElement>(".bs-tcard:not(.is-new)")];
const listReady = (n: number) => () => cards().length === n;
const editorReady = () => document.querySelector(".bs-sheet") && document.querySelector(".tz-pnl--r [role=tab]");

const patches = (id: string) => api.calls.filter((c) => c.method === "PATCH" && c.url.endsWith(`/api/print/templates/${id}`));
const deletes = (id: string) => api.calls.filter((c) => c.method === "DELETE" && c.url.endsWith(`/api/print/templates/${id}`));
const buttonByText = (text: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text) ?? null;
const field = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
const meta = () => document.querySelector(".bs-meta")?.textContent;
const selLabel = () => document.querySelector(".tz-selbar b")?.textContent;
const tab = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".tz-pnl--r [role=tab]")].find((b) => b.textContent?.startsWith(name))!;
const sw = (label: string) => document.querySelector<HTMLButtonElement>(`[role=switch][aria-label="${label}"]`)!;
const dialogTitle = () => document.querySelector("dialog h2")?.textContent ?? "";

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** Dünya (mm) → istemci (px): dünya katmanının dönüşümünden (tuval kabı 0,0'da). */
function toClient(x: number, y: number) {
  const tf = document.querySelector<HTMLElement>(".tz-cv-world")!.style.transform;
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(tf)!;
  return { clientX: Number(m[1]) + x * Number(m[3]), clientY: Number(m[2]) + y * Number(m[3]) };
}
async function pointer(type: "pointerdown" | "pointermove" | "pointerup", x: number, y: number, init: PointerEventInit = {}) {
  const stage = document.querySelector(".bs-stage")!;
  await act(async () => {
    stage.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, ...toClient(x, y), ...init }));
  });
}
async function clickAt(x: number, y: number, init: PointerEventInit = {}) {
  await pointer("pointerdown", x, y, init);
  await pointer("pointerup", x, y, init);
}
const pills = () => [...document.querySelectorAll(".bs-pill")].map((p) => p.textContent);

function frameChecks() {
  expect(document.querySelectorAll(".tz-btn--primary").length).toBeLessThanOrEqual(1);
  for (const b of document.querySelectorAll<HTMLButtonElement>(".tz-ib, .tz-cb.is-q, .tz-rail-b, .tz-st button")) {
    expect(b.getAttribute("aria-label") || b.textContent?.trim(), b.outerHTML.slice(0, 120)).toBeTruthy();
  }
}

describe("Sayfa şablonları · liste", () => {
  it("kartlar: kullanım sayısı, arama ve tür; Yeni şablon → etiket sayfası oluşturulup açılır", async () => {
    const r = await open("#/baski/sablonlar", listReady(3));
    expect(document.querySelector(".tz-ctx [role=tablist] [aria-selected=true]")?.textContent).toBe("Sayfa şablonları");
    // Sol şablon listesi yok: liste kendi sayfası.
    expect(document.querySelector(".tz-pnl--l")).toBeNull();
    const t1 = cards().find((c) => c.textContent?.includes("A4 3'lü Ø 40"))!;
    expect(t1.querySelector(".bs-tcard-b small")?.textContent).toBe("Etiket · 3,8 cm · 3 yuva");
    expect(t1.querySelector(".bs-used")?.textContent).toBe("3 baskıda kullanıldı");
    expect(cards().find((c) => c.textContent?.includes("Boş sayfa"))!.querySelector(".bs-used")?.textContent).toBe("Hiç kullanılmadı");
    // Her kartta görünür Sil.
    expect(cards().every((c) => buttonByText("Sil", c))).toBe(true);
    frameChecks();

    await type(document.querySelector<HTMLInputElement>('input[aria-label="Şablon ara"]')!, "boş");
    await waitFor(() => cards().length === 1);
    await type(document.querySelector<HTMLInputElement>('input[aria-label="Şablon ara"]')!, "");
    await click([...document.querySelectorAll<HTMLButtonElement>(".bs-tl-tb [role=tab]")].find((b) => b.textContent?.startsWith("Sticker"))!);
    await waitFor(() => cards().length === 0);
    expect(document.body.textContent).toContain("Aramaya uyan şablon yok.");

    await click(document.querySelector<HTMLButtonElement>('.tz-ctx [aria-label="Yeni şablon"]') ?? buttonByText("Yeni şablon")!);
    const item = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((b) => b.textContent?.includes("Etiket sayfası (yuvalı)")));
    await click(item);
    await waitFor(() => api.calls.some((c) => c.method === "POST" && c.url.endsWith("/api/print/templates")));
    // Kağıt gönderilmez: sunucu firmanın kurulumdaki kağıdını koyar.
    const sent = api.calls.find((c) => c.method === "POST")?.body;
    expect(sent).toEqual(newTemplateBody("dil-1", "label", 4));
    expect(sent).not.toHaveProperty("paper");
    await waitFor(() => window.location.hash === "#/baski/sablonlar/t9");
    await r.unmount();
  });

  it("Sil: kullanılmamış şablon kalıcı silinir, baskıda kullanılmış olan arşive kalkar; pencere metni önceden doğru, sonuç bildirimde", async () => {
    const r = await open("#/baski/sablonlar", listReady(3));
    const del = (name: string) => buttonByText("Sil", cards().find((c) => c.textContent?.includes(name))!)!;

    await click(del("Boş sayfa"));
    await waitFor(() => buttonByText("Vazgeç"));
    expect(dialogTitle()).toContain("“Boş sayfa” silinsin mi?");
    expect(document.body.textContent).toContain("Bu şablon hiçbir baskıda kullanılmadı. Kalıcı olarak silinir; geri alınamaz.");
    // Vazgeç: hiçbir şey gitmez.
    await click(buttonByText("Vazgeç")!);
    await flush(2);
    expect(deletes("t2")).toHaveLength(0);
    await click(del("Boş sayfa"));
    await click(await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((b) => b.textContent?.trim() === "Sil")));
    await waitFor(() => deletes("t2").length === 1);
    await waitFor(() => document.body.textContent?.includes("“Boş sayfa” silindi."));
    await waitFor(() => cards().length === 2);

    await click(del("A4 3'lü Ø 40"));
    await waitFor(() => buttonByText("Arşive kaldır"));
    expect(dialogTitle()).toContain("“A4 3'lü Ø 40” arşive kaldırılsın mı?");
    expect(document.body.textContent).toContain("Bu şablon 3 baskıda kullanıldı. Geçmiş baskılar bozulmasın diye silinmez");
    await click(buttonByText("Arşive kaldır")!);
    await waitFor(() => deletes("t1").length === 1);
    await waitFor(() => document.body.textContent?.includes("“A4 3'lü Ø 40” arşive kaldırıldı."));
    await waitFor(() => cards().length === 1);
    // Arşivdekiler görünür; arşivde ve kullanılmış şablonda Sil yerine "Arşivden çıkar".
    await click(sw("Arşivdekileri göster"));
    await waitFor(() => cards().length === 2);
    const archived = cards().find((c) => c.textContent?.includes("A4 3'lü Ø 40"))!;
    expect(archived.textContent).toContain("Arşivde");
    expect(buttonByText("Sil", archived)).toBeNull();
    await click(buttonByText("Arşivden çıkar", archived)!);
    await waitFor(() => api.calls.some((c) => c.method === "POST" && c.url.endsWith("/api/print/templates/t1/archive")));
    await r.unmount();
  });
});

describe("Sayfa şablonları · boş liste", () => {
  it("hiç şablon yokken kurulum düğmeleri; arşivdekileri göster anahtarı yerinde kalır", async () => {
    templates = [tpl("t1", "Eski", { archived: true, usedIn: 2 })];
    const r = await open("#/baski/sablonlar", () => document.body.textContent?.includes("Henüz sayfa şablonu yok"));
    expect(buttonByText("Etiket sayfası kur")).toBeTruthy();
    await click(sw("Arşivdekileri göster"));
    await waitFor(() => cards().length === 1);
    await r.unmount();
  });
});

describe("Sayfa şablonları · düzenleyici", () => {
  it("kâğıt ortada (sol liste yok); iş satırında Sil ve Kaydet; ⋯ menüsünde Çoğalt ve Arşivle; rayda araçlar; ? listesi", async () => {
    const r = await open("#/baski/sablonlar/t1", editorReady);
    expect(document.querySelector(".tz-pnl--l")).toBeNull();
    expect([...document.querySelectorAll(".tz-pnl--r [role=tab]")].map((b) => b.textContent)).toEqual(["Temel", "Gelişmiş"]);
    expect(buttonByText("Sil", document.querySelector(".tz-ctx")!)).toBeTruthy();
    expect(document.querySelector(".tz-ctx")?.textContent).toContain("Kaydet");
    expect(document.querySelector(".tz-ctx")?.textContent).toContain("A4 3'lü Ø 40");
    frameChecks();
    const rail = [...document.querySelectorAll<HTMLButtonElement>(".tz-rail-b")].map((b) => b.getAttribute("aria-label"));
    expect(rail).toEqual(["Seç ve taşı", "Daire yuva çiz", "Elips yuva çiz", "Dikdörtgen yuva çiz", expect.any(String)]);
    await press("e");
    await waitFor(() => document.querySelector('.tz-rail-b[aria-pressed="true"]')?.getAttribute("aria-label") === "Elips yuva çiz");
    await press("Escape");
    await waitFor(() => document.querySelector('.tz-rail-b[aria-pressed="true"]')?.getAttribute("aria-label") === "Seç ve taşı");
    await click(document.querySelector<HTMLButtonElement>('.tz-ctx [aria-label="Şablon işlemleri"]')!);
    const items = await waitFor(() => (document.querySelectorAll("[role=menuitem]").length ? [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")] : null));
    expect(items.map((b) => b.textContent?.trim())).toEqual(["Çoğalt", "Arşivle"]);
    await press("Escape");
    await press("?", { shiftKey: true });
    await waitFor(() => document.querySelector("dialog .tz-kp"));
    expect(document.body.textContent).toContain("Daire yuva çiz");
    expect(document.body.textContent).toContain("Kaydet");
    await r.unmount();
  });

  it("düzenleyiciden Sil: baskıda kullanılmış şablon arşive kalkar, bildirim ve listeye dönüş", async () => {
    const r = await open("#/baski/sablonlar/t1", editorReady);
    await click(buttonByText("Sil", document.querySelector(".tz-ctx")!)!);
    await click(await waitFor(() => buttonByText("Arşive kaldır")));
    await waitFor(() => deletes("t1").length === 1);
    await waitFor(() => window.location.hash === "#/baski/sablonlar");
    await waitFor(() => document.body.textContent?.includes("“A4 3'lü Ø 40” arşive kaldırıldı."));
    await r.unmount();
  });

  it("boş şablon: dizilişin önizlemesi, Yuvaları yerleştir, Ctrl S ile yuvalar gider", async () => {
    const r = await open("#/baski/sablonlar/t2", editorReady);
    expect(document.querySelectorAll(".bs-ghost")).toHaveLength(24);
    expect(document.querySelectorAll("[data-slot]")).toHaveLength(0);
    expect(field("Çap")?.value).toBe("38");
    frameChecks();
    await click(buttonByText("Yuvaları yerleştir (24)")!);
    await waitFor(() => document.querySelectorAll("[data-slot]").length === 24);
    expect(meta()).toBe("Kaydedilmedi");
    await press("s", { ctrlKey: true });
    await waitFor(() => patches("t2").length === 1);
    const sent = patches("t2")[0]!.body as PrintTemplatePatch;
    expect(Object.keys(sent).sort()).toEqual(["slots"]);
    expect(sent.slots).toHaveLength(24);
    await waitFor(() => meta() === "Kayıtlı");
    expect(document.body.textContent).toContain("“Boş sayfa” kaydedildi.");
    await r.unmount();
  });

  it("yuva seçip mm ile taşıma (alan ve oklar) ve geri alma", async () => {
    const r = await open("#/baski/sablonlar/t1", editorReady);
    expect(selLabel()).toBe("Seçim yok · bütün yerleşim");
    await clickAt(30, 30);
    await waitFor(() => selLabel() === "Yuva 1 seçili");
    expect(field("Merkez X")?.value).toBe("30");
    (document.activeElement as HTMLElement | null)?.blur();
    await press("ArrowRight", { shiftKey: true });
    await waitFor(() => field("Merkez X")?.value === "31");
    await press("ArrowDown");
    await waitFor(() => field("Merkez Y")?.value === "30,1");
    expect(meta()).toBe("Kaydedilmedi");
    // Art arda itmeler tek geri al adımıdır.
    await press("z", { ctrlKey: true });
    await waitFor(() => field("Merkez X")?.value === "30" && field("Merkez Y")?.value === "30");
    expect(meta()).toBe("Kayıtlı");
    await press("y", { ctrlKey: true });
    await waitFor(() => field("Merkez X")?.value === "31" && field("Merkez Y")?.value === "30,1");

    await type(field("Merkez X")!, "35,5");
    await act(async () => field("Merkez X")!.blur());
    expect(field("Merkez X")?.value).toBe("35,5");
    await press("s", { ctrlKey: true });
    await waitFor(() => patches("t1").length === 1);
    const sent = patches("t1")[0]!.body as PrintTemplatePatch;
    expect(sent.slots?.find((s) => s.id === "s1")).toMatchObject({ cx: 35.5, cy: 30.1 });
    await r.unmount();
  });

  it("sürükleme: kâğıt ortasına yapışır, kılavuz ve mm konumu çıkar; Alt basılıyken ve anahtar kapalıyken yapışmaz", async () => {
    const r = await open("#/baski/sablonlar/t1", editorReady);
    expect(sw("Kılavuz ve yapışma").getAttribute("aria-checked")).toBe("true");
    // Alt ile: yapışmaz, imlecin bıraktığı yerde kalır (0,1 mm adımla).
    await pointer("pointerdown", 30, 30);
    await pointer("pointermove", 70, 30, { altKey: true });
    await pointer("pointermove", 104.6, 30, { altKey: true });
    expect(document.querySelectorAll(".bs-gl")).toHaveLength(0);
    await pointer("pointerup", 104.6, 30, { altKey: true });
    await waitFor(() => field("Merkez X")?.value === "104,6");
    await press("z", { ctrlKey: true });
    await waitFor(() => field("Merkez X")?.value === "30");

    // Yapışma: kâğıt ortası (105); sürüklerken pembe kılavuz, etiketi ve konum.
    await pointer("pointerdown", 30, 30);
    await pointer("pointermove", 70, 30);
    await pointer("pointermove", 104.6, 30);
    expect(document.querySelectorAll(".bs-gl").length).toBeGreaterThan(0);
    expect(pills()).toContain("kâğıt ortası");
    expect(pills()).toContain("X 105 · Y 30 mm");
    await pointer("pointerup", 104.6, 30);
    expect(document.querySelectorAll(".bs-gl, .bs-pill")).toHaveLength(0);
    await waitFor(() => field("Merkez X")?.value === "105");

    // Anahtar kapalı: yapışmaz (tercih yerelde kalır).
    await click(sw("Kılavuz ve yapışma"));
    expect(localStorage.getItem("tagpress.baskiSablon.yapisma")).toBe("0");
    await pointer("pointerdown", 105, 30);
    await pointer("pointermove", 105, 60);
    await pointer("pointermove", 105, 148.2);
    await pointer("pointerup", 105, 148.2);
    await waitFor(() => field("Merkez Y")?.value === "148,2");
    await r.unmount();
  });

  it("Ortala şeridi hep görünür: seçim yokken bütün yerleşimi, seçimde yalnız seçimi kâğıda ortalar", async () => {
    const r = await open("#/baski/sablonlar/t1", editorReady);
    await click(buttonByText("Yerleşimi kâğıda ortala")!);
    await waitFor(() => meta() === "Kaydedilmedi");
    await clickAt(55, 138.5);
    await waitFor(() => selLabel() === "Yuva 1 seçili");
    expect(field("Merkez Y")?.value).toBe("138,5");
    await click(buttonByText("Dikeyde")!);
    await waitFor(() => field("Merkez Y")?.value === "148,5");
    await click(buttonByText("Kâğıda tam ortala")!);
    await waitFor(() => field("Merkez X")?.value === "105");
    await press("s", { ctrlKey: true });
    await waitFor(() => patches("t1").length === 1);
    const slots = (patches("t1")[0]!.body as PrintTemplatePatch).slots!;
    expect(slots.map((s) => [s.id, s.cx, s.cy])).toEqual([
      ["s1", 105, 148.5],
      ["s2", 105, 148.5],
      ["s3", 155, 158.5],
    ]);
    await r.unmount();
  });

  it("Hizala menüsü: çoklu seçimde seçime göre; Ortala ile grup kâğıda ortalanır", async () => {
    const r = await open("#/baski/sablonlar/t1", editorReady);
    await press("a", { ctrlKey: true });
    await waitFor(() => selLabel() === "3 yuva seçili");
    frameChecks();
    await click(buttonByText("Hizala")!);
    const items = await waitFor(() => (document.querySelectorAll("[role=menuitem]").length ? [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")] : null));
    expect(items.map((b) => b.textContent?.trim())).toEqual([
      "Sola hizala",
      "Yatayda ortala",
      "Sağa hizala",
      "Üste hizala",
      "Dikeyde ortala",
      "Alta hizala",
      "Yatayda eşit aralıkla dağıt (en az 3)",
      "Dikeyde eşit aralıkla dağıt (en az 3)",
    ]);
    await click(items[3]!);
    await click(buttonByText("Yatayda")!);
    await press("s", { ctrlKey: true });
    await waitFor(() => patches("t1").length === 1);
    const slots = (patches("t1")[0]!.body as PrintTemplatePatch).slots!;
    expect(slots.map((s) => s.cy)).toEqual([30, 30, 30]);
    expect(slots.map((s) => s.cx)).toEqual([55, 105, 155]);
    await r.unmount();
  });

  it("kâğıt değişince: ortalı tutulan yerleşim yeni kâğıda ortalanır; anahtar kapalıyken yuvalar yerinde kalır; kenar payları görünür", async () => {
    templates = [...templates, tpl("t5", "A4 24'lü", { slots: GRID24 })];
    const r = await open("#/baski/sablonlar/t5", editorReady);
    expect(sw("Kâğıda ortalı tut").getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector(".bs-mgn")?.textContent).toBe("Sol16Sağ16Üst13,5Alt13,5");
    await choose(document.querySelector<HTMLSelectElement>('select[aria-label="Boyut"]')!, "letter");
    await press("s", { ctrlKey: true });
    await waitFor(() => patches("t5").length === 1);
    const sent = patches("t5")[0]!.body as PrintTemplatePatch;
    expect(sent.paper).toEqual({ wMm: 215.9, hMm: 279.4 });
    expect(layoutMargins(sent.slots as PrintSlot[], sent.paper!)).toEqual({ left: 18.95, right: 18.95, top: 4.7, bottom: 4.7 });

    await click(sw("Kâğıda ortalı tut"));
    expect(sw("Kâğıda ortalı tut").getAttribute("aria-checked")).toBe("false");
    await choose(document.querySelector<HTMLSelectElement>('select[aria-label="Boyut"]')!, "a4");
    await press("s", { ctrlKey: true });
    await waitFor(() => patches("t5").length === 2);
    expect(Object.keys(patches("t5")[1]!.body as object)).toEqual(["paper"]);
    await r.unmount();
  });

  it("diziliş değişince yuvalar yeniden dizilir; elle taşınan yuva varsa önce sorulur", async () => {
    templates = [...templates, tpl("t5", "A4 24'lü", { slots: GRID24 })];
    const r = await open("#/baski/sablonlar/t5", editorReady);
    expect([field("Sütun")?.value, field("Satır")?.value, field("Yatay aralık")?.value, field("Adet")?.value]).toEqual(["4", "6", "6", "24"]);
    await type(field("Sütun")!, "3");
    await waitFor(() => document.querySelectorAll("[data-slot]").length === 18);
    expect(document.querySelector(".bs-mgn")?.textContent).toBe("Sol39Sağ39Üst13,5Alt13,5");
    (document.activeElement as HTMLElement | null)?.blur();
    // Bir yuvayı elle kaydır: sonraki diziliş değişikliği sorar.
    await clickAt(GRID24[0]!.cx + 23, GRID24[0]!.cy);
    await waitFor(() => selLabel() === "Yuva 1 seçili");
    await press("ArrowRight", { shiftKey: true });
    await type(field("Satır")!, "5");
    await waitFor(() => buttonByText("Yeniden diz"));
    await click(buttonByText("Vazgeç")!);
    await flush(2);
    expect(document.querySelectorAll("[data-slot]")).toHaveLength(18);
    await type(field("Satır")!, "5");
    await click(await waitFor(() => buttonByText("Yeniden diz")));
    await waitFor(() => document.querySelectorAll("[data-slot]").length === 15);
    // Geri al diziliş alanlarını da geri getirir.
    (document.activeElement as HTMLElement | null)?.blur();
    await press("z", { ctrlKey: true });
    await waitFor(() => document.querySelectorAll("[data-slot]").length === 18 && field("Satır")?.value === "6");
    await r.unmount();
  });

  it("uyarılı yuva: metin sözlükten, Seç uyarılı yuvayı seçer, önerilen kenar payı uygulanır ve kaydedilir", async () => {
    const r = await open("#/baski/sablonlar/t3", editorReady);
    const fix = clearingInset({ wMm: 100, hMm: 100 }, { registration: REG as never, bleedMm: 0 }, templates[2]!.slots)!;
    expect(tab("Temel").getAttribute("aria-selected")).toBe("true");
    expect(document.body.textContent).toContain("Kayıt işaretleri 1 yuvaya çakışıyor ya da taşma payı + 2 mm güvenli alana giriyor: k. Kenardan payı değiştirin.");
    expect(document.querySelectorAll(".bs-ring.is-warn")).toHaveLength(1);
    await click(buttonByText("Seç")!);
    await waitFor(() => selLabel() === "Yuva 1 seçili");
    await click(buttonByText(`Kenardan payını ${formatMm(fix, 2)} mm yap`)!);
    await waitFor(() => !document.body.textContent?.includes("Kayıt işaretleri 1 yuvaya çakışıyor"));
    await press("s", { ctrlKey: true });
    await waitFor(() => patches("t3").length === 1);
    expect((patches("t3")[0]!.body as PrintTemplatePatch).cut?.registration?.insetMm).toBe(fix);
    await r.unmount();
  });

  it("yazıcının basamadığı kenara giren yuva sarı uyarı alır (sunucuyla aynı metin); Seç o yuvayı seçer", async () => {
    templates = [...templates, tpl("t4", "Kenarda", { slots: [circle("e", 22, 100), circle("m", 105, 150)] })];
    const r = await open("#/baski/sablonlar/t4", editorReady);
    const text = "1 yuva (taşma payı dahil) yazıcının basamadığı 4 mm'lik kenara giriyor: e. Kenarı eksik basılabilir.";
    await waitFor(() => document.body.textContent?.includes(text));
    expect(document.querySelectorAll(".bs-ring.is-warn")).toHaveLength(1);
    expect(tab("Temel").textContent).toContain("1");
    await click(buttonByText("Seç")!);
    await waitFor(() => selLabel() === "Yuva 1 seçili");
    expect(field("Merkez X")?.value).toBe("22");
    await r.unmount();
  });

  it("Gelişmiş: Ctrl S yalnız değişen alanı gönderir (Kimlikler › Ad, yazı alanındayken de)", async () => {
    const r = await open("#/baski/sablonlar/t1", editorReady);
    await click(tab("Gelişmiş"));
    const name = await waitFor(() => field("Ad"));
    await type(name, "A4 üçlü");
    await press("s", { ctrlKey: true, target: name });
    await waitFor(() => patches("t1").length === 1);
    expect(patches("t1")[0]!.body).toEqual({ name: "A4 üçlü" });
    await waitFor(() => document.body.textContent?.includes("“A4 üçlü” kaydedildi."));
    await r.unmount();
  });

  it("Gelişmiş › Hazır ayarlar: seçilen hazır ayar uygulanır, boyut kimliğiyle kaydedilir", async () => {
    presets = [
      PrintPresetSchema.parse({
        id: "a4-635x381-21",
        name: "A4 · 63,5 × 38,1 mm · 21'li",
        kind: "label",
        sizeId: "63.5x38.1",
        grid: { paper: A4, columns: 3, rows: 7, shape: "rect", wMm: 63.5, hMm: 38.1, pitchXMm: 66.04, pitchYMm: 38.1, marginLeftMm: 7.21, marginTopMm: 15.15 },
      }),
    ];
    const r = await open("#/baski/sablonlar/t2", editorReady);
    await click(tab("Gelişmiş"));
    await choose(await waitFor(() => document.querySelector<HTMLSelectElement>('select[aria-label="Ön ayar"]')), "a4-635x381-21");
    await waitFor(() => document.querySelectorAll("[data-slot]").length === 21);
    await press("s", { ctrlKey: true });
    await waitFor(() => patches("t2").length === 1);
    const sent = patches("t2")[0]!.body as PrintTemplatePatch;
    expect(Object.keys(sent).sort()).toEqual(["sizeId", "slots"]);
    expect(sent.sizeId).toBe("63.5x38.1");
    expect(sent.slots?.every((x) => x.shape === "rect" && x.w === 63.5 && x.h === 38.1)).toBe(true);
    // Temel sekmesi hazır ayarın dizilişini gösterir.
    await click(tab("Temel"));
    expect([field("Sütun")?.value, field("Satır")?.value]).toEqual(["3", "7"]);
    await r.unmount();
  });

  it("kaydedilmemiş değişiklikle ayrılmak onay ister; Vazgeç'te kalınır, onayda gidilir", async () => {
    const r = await open("#/baski/sablonlar/t1", editorReady);
    await press("a", { ctrlKey: true });
    await press("ArrowRight");
    await waitFor(() => meta() === "Kaydedilmedi");
    await click([...document.querySelectorAll<HTMLButtonElement>(".tz-ctx [role=tab]")].find((b) => b.textContent === "Masa")!);
    await waitFor(() => buttonByText("Kaydetmeden çık"));
    expect(window.location.hash).toBe("#/baski/sablonlar/t1");
    await click(buttonByText("Vazgeç")!);
    await flush(2);
    expect(window.location.hash).toBe("#/baski/sablonlar/t1");
    expect(meta()).toBe("Kaydedilmedi");
    await click([...document.querySelectorAll<HTMLButtonElement>(".tz-ctx [role=tab]")].find((b) => b.textContent === "Masa")!);
    await click(await waitFor(() => buttonByText("Kaydetmeden çık")));
    await waitFor(() => window.location.hash === "#/baski/masa");
    await r.unmount();
  });
});
