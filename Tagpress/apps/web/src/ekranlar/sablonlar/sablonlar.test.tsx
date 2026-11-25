// @vitest-environment happy-dom
import type { TemplateItem } from "@tagpress/domain";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setShortcutsOpen } from "../../tezgah/kisayol/kayit.ts";
import { TezgahApp } from "../../tezgah/rotalar.tsx";
import { click, flush, mockFetch, press, render, waitFor } from "../../tezgah/test/render.tsx";

/**
 * Şablonlar ekranı duman testi (sahte sunucu; gerçek AI çağrısı yok): kütüphane, arama, büyük ızgara; tuval ve sağ
 * panel; alan değişikliği → kirli → Ctrl S gövdesi (kesim dahil); kesimi dikdörtgene çevirip mm girme; Otomatik öneri;
 * "Bu şablonla dene"; yükleme penceresi doğrulaması; kirliyken başka şablona geçişte onay; kesim kaydından önce
 * `cut-preview` (onayı düşecek iş varsa onay penceresi, yoksa doğrudan kayıt).
 */

const L = "/api/languages/dil-1";

const item = (key: string, over: Record<string, unknown> = {}): TemplateItem =>
  ({
    template: {
      key,
      languageId: "dil-1",
      kind: "label",
      cut: null,
      file: `${key}.png`,
      hash: "h",
      width: 880,
      height: 880,
      imageBox: null,
      area: { mode: "auto" },
      ribbonTop: 0.17,
      textCenter: null,
      ignoreDecorationInArea: false,
      decoration: { source: "auto", threshold: 18, dilatePx: 3 },
      printedText: false,
      notes: "çelenk",
      tags: ["çiçek"],
      provenance: [],
      generatedFrom: null,
      ...over,
    },
    fileMissing: false,
    imageUrl: "",
    overlayUrl: "",
    updatedAt: "2026-11-21T10:00:00.000Z",
  }) as unknown as TemplateItem;

let items: TemplateItem[] = [];
/** `cut-preview` yanıtı (sözleşme: `{ changed, approvals }`); `null` = uç hata verir. */
let cutPreview: { changed: boolean; approvals: number } | null = { changed: true, approvals: 0 };
let api: ReturnType<typeof mockFetch>;

beforeEach(() => {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* yok */
  }
  cutPreview = { changed: true, approvals: 0 };
  items = [item("a15"), item("a16", { tags: ["altın"] }), item("b02", { area: { mode: "manual", shape: { kind: "circle", cx: 0.5, cy: 0.5, r: 0.3 } } })];
  const byKey = (url: string) => items.find((i) => url.split("?")[0]!.endsWith(`/templates/${i.template.key}`));
  const routes: Record<string, unknown> = {
    "/api/languages": { languages: [{ id: "dil-1", name: "GiftUpStore", isDefault: true }] },
    "/api/generate/status": { running: 0, queued: 0, concurrency: 1, runningJobIds: [] },
    [`${L}/templates`]: () => ({ templates: items }),
    [`${L}/profile`]: { data: { output: { designFramePx: 440, sizes: [{ id: "3.8", cm: 3.8, framePx: 440 }], defaultSize: "3.8" } } },
    [`${L}/templates/sync`]: { added: ["c01"], updated: [], missing: ["a16"] },
    [`${L}/templates/a15/suggest-area`]: { shape: { kind: "ellipse", cx: 0.5, cy: 0.55, rx: 0.3, ry: 0.2 } },
    [`${L}/templates/a15/cut-preview`]: () => {
      if (!cutPreview) throw new Error("bağlantı yok");
      return cutPreview;
    },
    [`${L}/templates/a15/try`]: { png: "AAAA", lines: ["Sevgiyle", "Ayşe & Ali"], basePt: 12, sizesPx: [], issues: [] },
  };
  for (const it of items) {
    routes[`${L}/templates/${it.template.key}`] = (url: string, init?: RequestInit) => {
      const cur = byKey(url)!;
      if (init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
        const next = { ...cur, template: { ...cur.template, ...patch }, updatedAt: "2026-11-21T11:00:00.000Z" } as TemplateItem;
        items = items.map((x) => (x.template.key === cur.template.key ? next : x));
        return next;
      }
      return cur;
    };
  }
  api = mockFetch(routes);
});

afterEach(async () => {
  setShortcutsOpen(false);
  document.body.innerHTML = "";
  await act(async () => {
    window.location.hash = "";
  });
});

async function open(hash: string) {
  window.location.hash = hash;
  const r = await render(<TezgahApp />);
  await waitFor(() => document.querySelectorAll(".sb-tile, .sb-card").length === 3);
  await flush(3);
  return r;
}

async function openEditor(key = "a15") {
  const r = await open(`#/sablonlar/${key}`);
  await waitFor(() => document.querySelector(".sb-stage") && document.querySelector(".tz-pnl--r"));
  await flush();
  return r;
}

const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const byText = (text: string, sel = "button") => [...document.querySelectorAll<HTMLElement>(sel)].find((b) => b.textContent?.trim() === text) ?? null;

async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function choose(sel: HTMLSelectElement, value: string) {
  await act(async () => {
    sel.value = value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function frameChecks() {
  expect(document.querySelectorAll(".tz-btn--primary").length).toBeLessThanOrEqual(1);
  for (const b of document.querySelectorAll<HTMLButtonElement>(".tz-ib, .tz-cb.is-q, .tz-rail-b")) {
    expect(b.getAttribute("aria-label") || b.textContent?.trim(), b.outerHTML.slice(0, 120)).toBeTruthy();
  }
}

const previewCalls = () => api.calls.filter((c) => c.method === "POST" && c.url.endsWith(`${L}/templates/a15/cut-preview`));
const patchCall = () => api.calls.find((c) => c.method === "PATCH" && c.url.endsWith(`${L}/templates/a15`));

describe("Şablonlar ekranı", () => {
  it("kütüphane listelenir, arama süzer, ızgara görünümüne geçilir ve karttan düzenleyici açılır", async () => {
    const r = await openEditor();
    expect([...document.querySelectorAll(".sb-tile")].map((t) => t.textContent)).toEqual(["a15", "a16", "b02"]);
    expect(document.querySelector(".sb-tile.is-cur")?.textContent).toBe("a15");
    frameChecks();
    await press("/");
    const search = document.querySelector<HTMLInputElement>(".sb-lib-head input[type=search]")!;
    expect(document.activeElement).toBe(search);
    await typeInto(search, "altın");
    await waitFor(() => document.querySelectorAll(".sb-tile").length === 1);
    expect(document.querySelector(".sb-tile")?.textContent).toBe("a16");
    await typeInto(search, "");
    await click(byLabel("Izgara görünümü")!);
    await waitFor(() => document.querySelector(".sb-grid"));
    expect(window.location.hash).toBe("#/sablonlar");
    expect(document.querySelectorAll(".sb-grid .sb-card")).toHaveLength(3);
    expect(document.querySelector(".sb-stage")).toBeNull();
    frameChecks();
    expect(document.querySelector(".tz-btn--primary")?.textContent).toContain("Şablon yükle");
    await click(byLabel("a16 şablonunu aç")!);
    await waitFor(() => window.location.hash === "#/sablonlar/a16" && document.querySelector(".sb-stage"));
    expect(document.querySelector(".sb-tile.is-cur")?.textContent).toBe("a16");
    await r.unmount();
  });

  it("şablon seçince tuval (görsel, kesim çizgisi) ve sağ panel çizilir; tek birincil Kaydet", async () => {
    const r = await openEditor();
    expect(document.querySelector(".tz-ctx .tz-cr")?.textContent).toContain("Şablonlar");
    expect(document.querySelector(".tz-ctx .tz-cr")?.textContent).toContain("a15 · Etiket");
    expect(document.querySelector(".sb-svg image")?.getAttribute("href")).toContain(`${L}/templates/a15/image.png`);
    expect(document.querySelector(".sb-cutline")).not.toBeNull();
    expect(document.querySelector(".sb-ribbon")).not.toBeNull();
    expect(document.querySelectorAll(".tz-rail-b")).toHaveLength(5);
    const panel = document.querySelector(".tz-pnl--r")!;
    expect(panel.querySelector(".tz-pnl-t")?.textContent).toBe("a15 · Etiket");
    expect([...panel.querySelectorAll(".tz-sec-h h3")].map((x) => x.textContent)).toEqual(["Yazı alanı"]);
    // Kurdele ve hedef merkez tek bölümde iki satır; Kesim kapalı grup.
    expect([...panel.querySelectorAll(".tz-pr > span")].map((x) => x.textContent)).toEqual(expect.arrayContaining(["Kurdele", "Hedef merkez"]));
    expect([...panel.querySelectorAll(".tz-gc-h b")].map((x) => x.textContent)).toEqual(["Kesim", "Şablon bilgisi", "Dekor ayarları", "Değişiklik geçmişi"]);
    expect(document.querySelector(".sb-paper")).toBeNull();
    expect(document.querySelector(".tz-crop")).not.toBeNull();
    expect(document.querySelectorAll(".tz-btn--primary")).toHaveLength(1);
    expect(document.querySelector(".tz-btn--primary")?.textContent).toContain("Kaydet");
    expect(document.querySelector<HTMLButtonElement>(".tz-btn--primary")?.disabled).toBe(true);
    expect(document.querySelector(".tz-sb")?.textContent).toContain("Alan: otomatik");
    frameChecks();
    await r.unmount();
  });

  it("alan Elle'ye çevrilince kirli olur; Ctrl S yalnız değişen alanları (kesim dahil) gönderir; Ctrl Z geri alır", async () => {
    const r = await openEditor();
    await click(byText("Elle", "[role=radio]")!);
    await waitFor(() => document.querySelector(".sb-unsaved"));
    expect(document.querySelector(".sb-unsaved")?.textContent).toBe("Kaydedilmedi: yazı alanı");
    expect(document.querySelector(".sb-area")).not.toBeNull();
    expect(document.querySelectorAll(".sb-hdl[data-role=handle]")).toHaveLength(4);
    // Ctrl Z alanı geri alır, sonra yeniden Elle.
    await press("z", { ctrlKey: true });
    await waitFor(() => !document.querySelector(".sb-unsaved"));
    await click(byText("Elle", "[role=radio]")!);
    await choose(byLabel("Kesim şekli") as HTMLSelectElement, "circle");
    await waitFor(() => document.querySelector(".sb-unsaved")?.textContent?.includes("kesim"));
    await press("s", { ctrlKey: true });
    await waitFor(() => patchCall());
    expect(patchCall()?.body).toEqual({
      area: { mode: "manual", shape: { kind: "circle", cx: expect.any(Number), cy: expect.any(Number), r: expect.any(Number) } },
      cut: { shape: "circle", wMm: 38, hMm: 38, radiusMm: 0 },
    });
    await waitFor(() => document.body.textContent?.includes("Kaydedildi: Yazı alanı, Kesim."));
    expect(document.querySelector(".sb-unsaved")).toBeNull();
    await r.unmount();
  });

  it("kesim dikdörtgene çevrilip mm girilir; boyut adı ve en/boy uyarısı görünür", async () => {
    const r = await openEditor();
    await choose(byLabel("Kesim şekli") as HTMLSelectElement, "rect");
    await waitFor(() => byLabel("Genişlik"));
    expect(document.querySelector(".tz-pnl--r .tz-pnl-c")?.textContent).toBe("63,5 × 38,1 mm");
    // 880 × 880 görsel 63,5 × 38,1 kesimle uyuşmaz.
    expect(document.querySelector(".tz-pnl--r")?.textContent).toContain("Görselin en/boy oranı kesimle uyuşmuyor.");
    const w = byLabel("Genişlik") as HTMLInputElement;
    await act(async () => w.focus());
    await typeInto(w, "70");
    await press("Enter", { target: w });
    await waitFor(() => document.querySelector(".tz-pnl--r .tz-pnl-c")?.textContent === "70 × 38,1 mm");
    expect(document.querySelector(".tz-sb")?.textContent).not.toContain("38,1 mm");
    await press("s", { ctrlKey: true });
    await waitFor(() => patchCall());
    expect(patchCall()?.body).toEqual({ cut: { shape: "rect", wMm: 70, hMm: 38.1, radiusMm: 0 } });
    await r.unmount();
  });

  it("Otomatik öneri sunucudan alanı ister; Uygula alanı Elle'ye çevirir", async () => {
    const r = await openEditor();
    await click(byText("Otomatik öneri")!);
    await waitFor(() => api.calls.some((c) => c.url.endsWith(`${L}/templates/a15/suggest-area`)));
    expect(api.calls.find((c) => c.url.endsWith("/suggest-area"))?.body).toEqual({});
    await waitFor(() => document.querySelector(".sb-ghost"));
    expect(document.querySelector(".tz-pnl--r")?.textContent).toContain("Önerilen alan kesikli çizgiyle gösteriliyor.");
    await click(byText("Uygula")!);
    await waitFor(() => !document.querySelector(".sb-ghost") && document.querySelector(".sb-unsaved"));
    expect(document.querySelector(".tz-sb")?.textContent).toContain("Alan: oval, elle");
    expect(document.querySelectorAll(".tz-btn--primary")).toHaveLength(1);
    await r.unmount();
  });

  it("Bu şablonla dene ücretsiz motor denemesini çağırır (AI çağrısı yok)", async () => {
    const r = await openEditor();
    await click(byText("Bu şablonla dene")!);
    await waitFor(() => document.querySelector(".sb-try-fig img"));
    const call = api.calls.find((c) => c.url.endsWith(`${L}/templates/a15/try`));
    expect(call?.body).toEqual({ text: "Sevgiyle\nAyşe & Ali" });
    expect(document.querySelector(".sb-try-fig")?.textContent).toContain("Sonuç");
    expect(document.querySelector(".sb-try-fig")?.textContent).toContain("12 pt");
    expect(api.calls.some((c) => c.url.includes("/generate") && c.method === "POST")).toBe(false);
    await r.unmount();
  });

  it("yükleme: PNG olmayan dosya atlanır; var olan anahtar uyarısı; geçersiz ve yinelenen anahtar yüklemeyi kapatır", async () => {
    const r = await openEditor();
    const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
    const files = [new File(["x"], "A15.png", { type: "image/png" }), new File(["y"], "yeni.png", { type: "image/png" }), new File(["z"], "foto.jpg", { type: "image/jpeg" })];
    await act(async () => {
      Object.defineProperty(input, "files", { value: files, configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const dlg = await waitFor(() => document.querySelector("dialog[open]"));
    expect(document.body.textContent).toContain("Yalnızca PNG yüklenebilir. Atlanan: foto.jpg");
    expect(dlg.querySelector(".tz-dlg-t, h2")?.textContent).toBe("2 şablon yükle");
    expect(dlg.textContent).toContain("a15 zaten var.");
    const keys = [...dlg.querySelectorAll<HTMLInputElement>(".sb-up input")];
    const submit = () => [...dlg.querySelectorAll<HTMLButtonElement>(".tz-btn--primary")][0]!;
    expect(submit().textContent).toContain("2 dosyayı yükle");
    expect(submit().disabled).toBe(false);
    await typeInto(keys[1]!, "a/b");
    await waitFor(() => dlg.textContent?.includes("Anahtar boş olamaz"));
    expect(submit().disabled).toBe(true);
    await typeInto(keys[1]!, "a15");
    await waitFor(() => dlg.textContent?.includes("Aynı anahtar iki dosyada kullanılıyor."));
    expect(submit().disabled).toBe(true);
    await typeInto(keys[1]!, "c09");
    await waitFor(() => !submit().disabled);
    expect(api.calls.some((c) => c.method === "POST" && c.url.endsWith(`${L}/templates`))).toBe(false);
    await r.unmount();
  });

  it("Temadan şablon üret yalnız düğmeyle çağrılır; gövde tema ve anahtarı taşır", async () => {
    const r = await openEditor();
    await click(byLabel("Temadan şablon üret")!);
    const dlg = await waitFor(() => document.querySelector("dialog[open]"));
    expect(dlg.textContent).toContain("her üretim ücretlidir");
    const [theme] = [...dlg.querySelectorAll<HTMLTextAreaElement>("textarea")];
    await typeInto(theme!, "pastel çelenk");
    const key = dlg.querySelector<HTMLInputElement>("input")!;
    await typeInto(key, "a15");
    await waitFor(() => dlg.textContent?.includes("Bu anahtar zaten var."));
    expect(dlg.querySelector<HTMLButtonElement>(".tz-btn--primary")?.disabled).toBe(true);
    await typeInto(key, "yeni-1");
    expect(api.calls.some((c) => c.url.endsWith("/templates/generate"))).toBe(false);
    await r.unmount();
  });

  it("kaydedilmemiş değişiklikle sonraki şablona geçiş onay ister", async () => {
    const r = await openEditor();
    await click(byText("Elle", "[role=radio]")!);
    await waitFor(() => document.querySelector(".sb-unsaved"));
    await press("]");
    const dlg = await waitFor(() => document.querySelector("dialog[open]"));
    expect(dlg.textContent).toContain("Değişiklikler kaydedilmedi");
    expect(dlg.textContent).toContain("Yazı alanı henüz kaydedilmedi.");
    expect(window.location.hash).toBe("#/sablonlar/a15");
    await click(byText("Kaydetmeden çık", "dialog button")!);
    await waitFor(() => window.location.hash === "#/sablonlar/a16" && document.querySelector(".sb-tile.is-cur")?.textContent === "a16");
    await r.unmount();
  });

  it("kesim kaydından önce cut-preview: onayı düşecek iş varsa pencere; Vazgeç kaydetmez, Kaydet gönderir", async () => {
    cutPreview = { changed: true, approvals: 2 };
    const r = await openEditor();
    await choose(byLabel("Kesim şekli") as HTMLSelectElement, "rect");
    await waitFor(() => document.querySelector(".sb-unsaved")?.textContent?.includes("kesim"));
    await press("s", { ctrlKey: true });
    let dlg = await waitFor(() => document.querySelector("dialog[open]"));
    expect(previewCalls().map((c) => c.body)).toEqual([{ cut: { shape: "rect", wMm: 63.5, hMm: 38.1, radiusMm: 0 } }]);
    expect(dlg.textContent).toContain("Kesim değişikliği kaydedilsin mi?");
    expect(dlg.textContent).toContain("2 onaylı iş yeniden kontrol isteyecek");
    await click(byText("Vazgeç", "dialog button")!);
    await waitFor(() => !document.querySelector("dialog[open]"));
    await flush();
    expect(patchCall()).toBeUndefined();
    expect(document.querySelector(".sb-unsaved")?.textContent).toContain("kesim");
    await press("s", { ctrlKey: true });
    dlg = await waitFor(() => document.querySelector("dialog[open]"));
    await click(byText("Kaydet", "dialog button")!);
    await waitFor(() => patchCall());
    expect(patchCall()?.body).toEqual({ cut: { shape: "rect", wMm: 63.5, hMm: 38.1, radiusMm: 0 } });
    expect(previewCalls()).toHaveLength(2);
    await r.unmount();
  });

  it("onayı düşecek iş yoksa doğrudan kaydedilir; kesimi dile bırakmak cut: null sorar; kesimsiz kayıt sormaz", async () => {
    items = items.map((x) => (x.template.key === "a15" ? ({ ...x, template: { ...x.template, cut: { shape: "circle", wMm: 38, hMm: 38, radiusMm: 0 } } } as TemplateItem) : x));
    const r = await openEditor();
    await choose(byLabel("Kesim şekli") as HTMLSelectElement, "inherit");
    await waitFor(() => document.querySelector(".sb-unsaved")?.textContent?.includes("kesim"));
    await press("s", { ctrlKey: true });
    await waitFor(() => patchCall());
    expect(previewCalls().map((c) => c.body)).toEqual([{ cut: null }]);
    expect(patchCall()?.body).toEqual({ cut: null });
    expect(document.querySelector("dialog[open]")).toBeNull();
    api.calls.length = 0;
    await click(byText("Elle", "[role=radio]")!);
    await waitFor(() => document.querySelector(".sb-unsaved"));
    await press("s", { ctrlKey: true });
    await waitFor(() => patchCall());
    expect(previewCalls()).toEqual([]);
    await r.unmount();
  });

  it("etkilenecek iş sayısı alınamazsa yine sorulur (onay sessizce düşmesin)", async () => {
    cutPreview = null;
    const r = await openEditor();
    await choose(byLabel("Kesim şekli") as HTMLSelectElement, "circle");
    await waitFor(() => document.querySelector(".sb-unsaved")?.textContent?.includes("kesim"));
    await press("s", { ctrlKey: true });
    const dlg = await waitFor(() => document.querySelector("dialog[open]"));
    expect(dlg.textContent).toContain("Etkilenecek iş sayısı alınamadı.");
    await click(byText("Kaydet", "dialog button")!);
    await waitFor(() => patchCall());
    expect(patchCall()?.body).toEqual({ cut: { shape: "circle", wMm: 38, hMm: 38, radiusMm: 0 } });
    await r.unmount();
  });
});
