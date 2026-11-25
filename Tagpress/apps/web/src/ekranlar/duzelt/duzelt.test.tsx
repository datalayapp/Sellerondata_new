// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTestLocale } from "../../i18n/test.ts";
import { parseHash } from "../../lib/route.ts";
import { setShortcutsOpen } from "../../tezgah/index.ts";
import { TezgahApp } from "../../tezgah/rotalar.tsx";
import { click, flush, mockFetch, press, render, type Rendered, waitFor } from "../../tezgah/test/render.tsx";
import DuzeltEkrani from "./index.tsx";

/** Yalnız yanıt şekli (domain tipleri): iş kuralı yok. */
const ink = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const MODEL = {
  variantId: "v1",
  jobId: "j1",
  framePx: 440,
  templateImageUrl: null,
  templateBox: ink(0, 0, 440, 440),
  cut: { kind: "circle", cx: 220, cy: 220, r: 200 },
  cutBox: ink(20, 20, 400, 400),
  areaBox: ink(80, 80, 280, 280),
  centers: { textCenter: { x: 220, y: 220, source: "template" }, area: { x: 220, y: 230 }, cut: { x: 220, y: 220 } },
  origin: { x: 220, y: 220 },
  ink: ink(120, 150, 200, 140),
  lines: [
    { index: 0, text: "Elif", sizePx: 40, ink: ink(170, 150, 100, 40), strokePx: 0, fontId: "Sans/Regular" },
    { index: 1, text: "&", sizePx: 30, ink: ink(205, 200, 30, 30), strokePx: 0, fontId: "Sans/Regular" },
    { index: 2, text: "Kerem", sizePx: 40, ink: ink(160, 250, 120, 40), strokePx: 0, fontId: "Script/Regular" },
  ],
  fonts: [
    { id: "Sans/Regular", family: "Sans", style: "Regular", kind: "sans" },
    { id: "Script/Regular", family: "Script", style: "Regular", kind: "script" },
  ],
  fontMixing: "free",
  strokePx: 0,
  strokeAlign: "outside",
  textLayerUrl: null,
  adjust: null,
  adjustedInk: ink(120, 150, 200, 140),
  issues: [],
  previewUrl: "/p.png",
  limits: { scaleMin: 0.5, scaleMax: 2, shiftMaxPx: 200, strokeMaxPx: 20 },
};
const VARIANT = { id: "v1", jobId: "j1", no: 2, snapshot: { languageId: "dil-1", labelSize: "3.8" } };
const JOB = { id: "j1", orderNo: "9014", text: "Elif & Kerem", languageId: "dil-1", labelSize: "3.8" };
const PROFILE = { data: { output: { sizes: [{ id: "3.8", cm: 3.8, framePx: 440 }], defaultSize: "3.8" } } };
const CHECK = { adjust: null, ink: ink(0, 0, 1, 1), lineInks: [], lineStrokes: [], issues: [], collision: null, ms: 1 };

let calls: ReturnType<typeof mockFetch>["calls"];
beforeEach(() => {
  calls = mockFetch({
    "/api/languages": { languages: [] },
    "/api/variants/v1/edit": MODEL,
    "/api/variants/v1": VARIANT,
    "/api/jobs/j1": JOB,
    "/api/languages/dil-1/profile": PROFILE,
    "/api/variants/v1/adjust/check": CHECK,
    "/api/variants/v1/adjust": { variant: VARIANT, undo: { undoToken: "u1", label: "geri" } },
  }).calls;
});
afterEach(() => {
  setShortcutsOpen(false);
  document.body.innerHTML = "";
  setTestLocale("tr");
});

const DON = "#/baski/masa/s1";

async function ac(): Promise<{ r: Rendered; go: ReturnType<typeof vi.fn> }> {
  const go = vi.fn();
  const route = parseHash(`#/duzelt/v1?don=${encodeURIComponent(DON)}`);
  const r = await render(<DuzeltEkrani route={route} go={go} />);
  await waitFor(() => document.querySelector(".dz-stage"));
  await flush();
  return { r, go };
}

const rows = () => [...document.querySelectorAll<HTMLButtonElement>(".tz-lr-b")];
const panelTitle = () => document.querySelector(".tz-pnl--r .tz-pnl-t")?.textContent;
const summary = () => document.querySelector(".dz-sb-sum")?.textContent;

describe("Düzelt ekranı (duman)", () => {
  it("düzenleyici açılır: iş satırı, satırlar, tuval, tek birincil düğme, adı olan ikon düğmeleri", async () => {
    const { r } = await ac();
    expect(document.querySelector(".tz-ctx .tz-cr")?.textContent).toContain("№ 9014 · V2 yazısını düzelt");
    expect(rows().map((b) => b.querySelector("b")?.textContent)).toEqual(["Elif", "&", "Kerem"]);
    expect(panelTitle()).toBe("Bütün yazı");
    expect(summary()).toBe("değişiklik yok");
    expect(document.querySelectorAll(".tz-btn--primary").length).toBe(1);
    for (const b of document.querySelectorAll<HTMLButtonElement>(".tz-ib, .tz-cb.is-q, .tz-rail-b, .tz-st button")) {
      expect(b.getAttribute("aria-label"), b.outerHTML.slice(0, 120)).toBeTruthy();
    }
    // Rozetler: birincil Kaydet ve en çok dört sık iş.
    expect(document.querySelector(".tz-btn--primary .tz-kbd")?.textContent).toBe("Ctrl S");
    // Boyut ve kalınlığın yanında tuş rozetleri (maket "- =", "[ ]"); ortalama düğmeleri çerçevesiz.
    expect([...document.querySelectorAll(".tz-pnl--r .tz-pr-v > .tz-kbd")].map((k) => k.textContent)).toEqual(["-", "=", "[", "]"]);
    expect(document.querySelectorAll(".dz-center .tz-btn--quiet").length).toBe(3);
    // "Bütün yazı" bağlantısı seçiliyken basılı; tuvalde kesim işaretleri.
    expect(document.querySelector(".tz-pnl--l .tz-pnl-h .tz-btn--link")?.getAttribute("aria-pressed")).toBe("true");
    // Satır listesi kart satırı (maket .ln).
    expect(document.querySelectorAll(".dz-lines .tz-lr--card").length).toBeGreaterThan(0);
    expect(document.querySelector(".tz-crop")).not.toBeNull();
    await r.unmount();
  });

  it("satır listeden seçilir; Ctrl + tık ekler; Tab tuvalde satırlarda gezer", async () => {
    const { r } = await ac();
    await click(rows()[0]!);
    expect(panelTitle()).toBe("Satır 1: Elif");
    await act(async () => {
      rows()[2]!.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    });
    expect(panelTitle()).toBe("2 satır: 1, 3");
    const stage = r.get<HTMLElement>(".dz-stage");
    await act(async () => stage.focus());
    await press("Tab", { target: stage });
    expect(panelTitle()).toBe("Bütün yazı");
    await press("Tab", { target: stage });
    expect(panelTitle()).toBe("Satır 1: Elif");
    await r.unmount();
  });

  it("ok tuşu seçili satırı taşır, Ctrl Z geri alır", async () => {
    const { r } = await ac();
    await click(rows()[2]!);
    await press("ArrowRight");
    expect(summary()).toBe("1 satır ayrı");
    const x = document.querySelectorAll<HTMLInputElement>(".tz-pr2 input")[0]!;
    expect(x.value).toBe("1");
    await press("ArrowDown", { shiftKey: true });
    expect(document.querySelectorAll<HTMLInputElement>(".tz-pr2 input")[1]!.value).toBe("10");
    await press("z", { ctrlKey: true });
    expect(summary()).toBe("değişiklik yok");
    await press("y", { ctrlKey: true });
    expect(summary()).toBe("1 satır ayrı");
    await r.unmount();
  });

  it("sürüklerken seçim çerçevesi yazıyla birlikte, yuvarlanmadan ve boyutu değişmeden kayar", async () => {
    const { r } = await ac();
    await click(rows()[2]!);
    const world = r.get<HTMLElement>(".tz-cv-world");
    const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(world.style.transform);
    expect(m).not.toBeNull();
    const [vx, vy, zoom] = [Number(m![1]), Number(m![2]), Number(m![3])];
    const k = 38 / 440; // mm / tasarım px (3,8 cm, 440 px)
    const box = () => {
      const el = r.get<HTMLElement>(".tz-selbox");
      expect([el.style.left, el.style.width]).toEqual(["", ""]);
      return ["--tz-x", "--tz-y", "--tz-w", "--tz-h"].map((p) => Number(el.style.getPropertyValue(p)));
    };
    const before = box();
    // "Kerem" satırının ortası (tasarım px 220, 270) → ekran.
    const at = { clientX: vx + 220 * k * zoom, clientY: vy + 270 * k * zoom };
    const stage = r.get<HTMLElement>(".dz-stage");
    const fire = (type: string, dx: number, dy: number) =>
      stage.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, altKey: true, clientX: at.clientX + dx, clientY: at.clientY + dy }));
    await act(async () => void fire("pointerdown", 0, 0));
    const steps: number[][] = [];
    for (const d of [7, 13.5, 29, 41.25]) {
      await act(async () => void fire("pointermove", d, d / 3));
      steps.push(box());
    }
    await act(async () => void fire("pointerup", 41.25, 41.25 / 3));
    for (const [i, d] of [7, 13.5, 29, 41.25].entries()) {
      const s = steps[i]!;
      // Konum: tasarım px'e çevrilen fare farkı (0,01'e yuvarlı) × k; dünya birimine (mm) yuvarlanmaz.
      expect(s[0]).toBeCloseTo(before[0]! + Math.round((d / (zoom * k)) * 100) / 100 * k, 6);
      expect(s[1]).toBeCloseTo(before[1]! + Math.round((d / 3 / (zoom * k)) * 100) / 100 * k, 6);
      // Boyut: taşırken değişmez.
      expect(s[2]).toBeCloseTo(before[2]!, 9);
      expect(s[3]).toBeCloseTo(before[3]!, 9);
    }
    expect(summary()).toBe("1 satır ayrı");
    await r.unmount();
  });

  it("Enter metni düzenlemeyi açar (alan odakta, metin seçili); Esc vazgeçer", async () => {
    const { r } = await ac();
    await click(rows()[2]!);
    await press("Enter");
    await flush();
    const input = document.activeElement as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(input.getAttribute("aria-label")).toBe("Satır 3 metni");
    expect(input.value).toBe("Kerem");
    await press("Escape", { target: input });
    expect(document.activeElement).toBe(r.get(".dz-stage"));
    expect(panelTitle()).toBe("Satır 3: Kerem");
    await r.unmount();
  });

  it("Ctrl S kaydetme gövdesini gönderir ve don adresine döner", async () => {
    const { r, go } = await ac();
    await click(rows()[2]!);
    await press("ArrowRight");
    await press("s", { ctrlKey: true });
    await flush();
    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/api/variants/v1/adjust"));
    expect(put?.body).toEqual({ adjust: { dx: 0, dy: 0, scale: 1, lines: [{ index: 2, dx: 1, dy: 0, scale: 1 }] } });
    expect(go).toHaveBeenCalledWith("baski", ["masa", "s1"], {}, true);
    await r.unmount();
  });

  it("kaydedilmemiş değişiklikle Esc önce seçimi kaldırır, sonra onay ister", async () => {
    const { r, go } = await ac();
    await click(rows()[0]!);
    await press("ArrowLeft");
    await press("Escape");
    expect(panelTitle()).toBe("Bütün yazı");
    await press("Escape");
    await flush();
    const dlg = await waitFor(() => document.querySelector("dialog[open]"));
    expect(dlg.textContent).toContain("Kaydedilmemiş değişiklik var");
    expect(go).not.toHaveBeenCalled();
    await click(r.byText("Kaydetmeden çık")!);
    await flush();
    expect(go).toHaveBeenCalledWith("baski", ["masa", "s1"], {}, true);
    await r.unmount();
  });

  it("değişiklik yokken Esc onaysız döner", async () => {
    const { r, go } = await ac();
    await press("Escape");
    await flush();
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(go).toHaveBeenCalledWith("baski", ["masa", "s1"], {}, true);
    await r.unmount();
  });

  it("metin elle düzenlenir: motor ölçer, notları (yedek font) görünür; font satıra yazılır", async () => {
    const FALLBACK = { code: "text-fallback-font", severity: "info", message: "Tasarım fontlarında olmayan karakterler yedek fontla basılacak: 🎉.", messageKey: "text-fallback-font", params: { chars: "🎉" }, field: "text" };
    const relayout = vi.fn((_u: string, init?: RequestInit) => {
      const edits = JSON.parse(String(init?.body)).edits;
      return { edits, textSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', issues: edits.some((e: { text?: string }) => e.text) ? [FALLBACK] : [] };
    });
    calls = mockFetch({
      "/api/languages": { languages: [] },
      "/api/variants/v1/edit": MODEL,
      "/api/variants/v1": VARIANT,
      "/api/jobs/j1": JOB,
      "/api/languages/dil-1/profile": PROFILE,
      "/api/variants/v1/adjust/check": CHECK,
      "/api/variants/v1/edit/relayout": relayout,
    }).calls;
    const { r } = await ac();
    await click(rows()[2]!);
    await press("Enter");
    await flush();
    const input = document.activeElement as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Kerem 🎉");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await flush();
    const post = calls.find((c) => c.url.endsWith("/edit/relayout"));
    expect(post?.body).toEqual({ edits: [{ index: 2, text: "Kerem 🎉" }] });
    expect(document.querySelector(".dz-check")?.textContent).toContain("yedek fontla basılacak: 🎉");
    expect(summary()).toBe("1 satırın metni elle");
    // Font: seçili satıra (bütün metin) yazılır, motor yeniden ölçer.
    const sel = r.get<HTMLSelectElement>(".tz-pnl--r select");
    await act(async () => {
      sel.value = "Sans/Regular";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(relayout).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify({ edits: [{ index: 2, text: "Kerem 🎉", fontId: "Sans/Regular" }] }) }));
    expect(summary()).toBe("1 satırın metni elle · 1 satırın fontu elle");
    await r.unmount();
  });

  it("rotadan açılır: etkin menü don adresinin sekmesi; ? listesinde Düzelt'in kısayolları", async () => {
    window.location.hash = `#/duzelt/v1?don=${encodeURIComponent(DON)}`;
    const r = await render(<TezgahApp />);
    await waitFor(() => document.querySelector(".dz-stage"));
    await flush();
    expect(document.querySelector(".tz-nv a[aria-current=page]")?.getAttribute("href")).toBe("#/baski");
    await press("?", { shiftKey: true });
    const panel = await waitFor(() => document.querySelector("dialog .tz-kp"));
    for (const name of ["Kaydet", "Metni düzenle", "Tam ortala", "Kalınlaştır", "Sonraki satır", "Sığdır"]) expect(panel.textContent).toContain(name);
    await act(async () => setShortcutsOpen(false));
    await r.unmount();
    window.location.hash = "";
  });

  it("Türkçe klavye: = (Shift 0) büyütür, [ (AltGr 8) inceltir, , . kalınlık", async () => {
    const { r } = await ac();
    await press("=", { code: "Digit0", shiftKey: true });
    expect(summary()).toBe("boyut %102");
    await press("]", { code: "Digit9", ctrlKey: true, altKey: true });
    expect(summary()).toBe("boyut %102 · kalınlık +0,2");
    await press("[", { code: "Digit8", ctrlKey: true, altKey: true });
    await press(",", { code: "Comma" });
    expect(summary()).toBe("boyut %102 · kalınlık −0,2");
    await press("-", { code: "Minus" });
    expect(summary()).toBe("kalınlık −0,2");
    await r.unmount();
  });

  it("kaydedilmemiş değişiklik: üst menüyle çıkış sorulur; Esc ile çıkışta tek onay", async () => {
    const wait = () => act(async () => void (await new Promise((res) => setTimeout(res, 30))));
    window.location.hash = `#/duzelt/v1?don=${encodeURIComponent(DON)}`;
    await wait();
    const r = await render(<TezgahApp />);
    await waitFor(() => document.querySelector(".dz-stage"));
    await flush();
    await click(rows()[2]!);
    await press("ArrowRight");
    // Üst menüden Üretim'e: adres geri döner, onay sorulur; Vazgeç ile ekranda kalınır.
    await act(async () => {
      window.location.hash = "#/uretim";
    });
    await wait();
    const dlg = await waitFor(() => document.querySelector("dialog[open]"));
    expect(dlg.textContent).toContain("Kaydedilmemiş değişiklik var");
    expect(window.location.hash).toContain("#/duzelt/v1");
    await click(r.byText("Vazgeç", "dialog button")!);
    await flush();
    expect(document.querySelector(".dz-stage")).not.toBeNull();
    // Esc (seçimi kaldırır), Esc (çıkış): tek onay, sonra don adresi.
    await press("Escape");
    await press("Escape");
    await flush();
    expect(document.querySelectorAll("dialog[open]").length).toBe(1);
    await click(r.byText("Kaydetmeden çık")!);
    await wait();
    await flush();
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(window.location.hash).toBe(DON);
    await r.unmount();
    window.location.hash = "";
    await wait();
  });

  it("açılamayan düzeltme iletiyle açılır; Geri dön Üretim'e döner", async () => {
    mockFetch({ "/api/variants/v1/edit": () => Promise.reject(new Error("x")) });
    const go = vi.fn();
    const r = await render(<DuzeltEkrani route={parseHash("#/duzelt/v1")} go={go} />);
    await waitFor(() => document.querySelector(".dz-msg"));
    expect(document.querySelector(".tz-ctx .tz-cr")?.textContent).toContain("Düzelt");
    await click(r.byText("Geri dön")!);
    expect(go).toHaveBeenCalledWith("uretim", [], {}, true);
    await r.unmount();
  });
});
