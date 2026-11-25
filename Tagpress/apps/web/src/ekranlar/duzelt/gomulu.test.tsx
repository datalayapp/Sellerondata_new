// @vitest-environment happy-dom
import { act, createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setShortcutsOpen } from "../../tezgah/index.ts";
import { click, flush, mockFetch, press, render, type Rendered, waitFor } from "../../tezgah/test/render.tsx";
import { AUTOSAVE_MS, DuzeltPenceresi, HizliDuzelt, type HizliDuzeltHandle } from "./gomulu.tsx";

/** Yalnız yanıt şekli (domain tipleri): iş kuralı yok. `duzelt.test.tsx` ile aynı model. */
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
const SAVED = { variant: VARIANT, undo: { undoToken: "u1", label: "geri" } };

let calls: ReturnType<typeof mockFetch>["calls"];
let putFails = false;
/** Sahte sunucuda kayıtlı düzeltme: PUT yazar, model okuması döner. */
let stored: unknown = null;
const relayout = (_u: string, init?: RequestInit) => {
  const edits = JSON.parse(String(init?.body)).edits;
  return { edits, textSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', issues: [] };
};
beforeEach(() => {
  putFails = false;
  stored = null;
  calls = mockFetch({
    "/api/languages": { languages: [] },
    "/api/variants/v1/edit": () => ({ ...MODEL, adjust: stored }),
    "/api/variants/v1": VARIANT,
    "/api/jobs/j1": JOB,
    "/api/languages/dil-1/profile": PROFILE,
    "/api/variants/v1/adjust/check": CHECK,
    "/api/variants/v1/edit/relayout": relayout,
    "/api/variants/v1/adjust": (_u: string, init?: RequestInit) => {
      if (putFails) throw new Error("ağ yok");
      stored = JSON.parse(String(init?.body)).adjust;
      return SAVED;
    },
  }).calls;
});
afterEach(() => {
  setShortcutsOpen(false);
  document.body.innerHTML = "";
});

const puts = () => calls.filter((c) => c.method === "PUT" && c.url.endsWith("/api/variants/v1/adjust"));
const wait = (ms: number) => act(async () => void (await new Promise((res) => setTimeout(res, ms))));
const chip = (text: string) => [...document.querySelectorAll<HTMLButtonElement>(".dz-q-lines button")].find((b) => b.textContent === text)!;

async function hizli(onSaved = vi.fn()): Promise<{ r: Rendered; ref: React.RefObject<HizliDuzeltHandle | null>; onSaved: typeof onSaved }> {
  const ref = createRef<HizliDuzeltHandle>();
  const r = await render(<HizliDuzelt variantId="v1" handleRef={ref} onSaved={onSaved} />);
  await waitFor(() => document.querySelector(".dz-q .dz-stage"));
  await flush();
  return { r, ref, onSaved };
}

/** Küçük tuvalde "Kerem" satırının üstünden tutup (Alt: yapışma yok) sağa sürükler. */
async function dragKerem(dx: number) {
  const world = document.querySelector<HTMLElement>(".dz-q .tz-cv-world")!;
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(world.style.transform)!;
  const [vx, vy, zoom] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const k = 38 / 440;
  const at = { clientX: vx + 220 * k * zoom, clientY: vy + 270 * k * zoom };
  const stage = document.querySelector<HTMLElement>(".dz-q .dz-stage")!;
  const fire = (type: string, x: number) => stage.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, altKey: true, clientX: at.clientX + x, clientY: at.clientY }));
  await act(async () => void fire("pointerdown", 0));
  await act(async () => void fire("pointermove", dx / 2));
  await act(async () => void fire("pointermove", dx));
  await act(async () => void fire("pointerup", dx));
}

describe("Hızlı düzelt (sağ paneldeki küçük tezgâh)", () => {
  it("küçük tuval, satır düğmeleri, metin, yazı tipi, boyut ve ortalama çizilir; seçim çerçevesi var", async () => {
    const { r } = await hizli();
    expect([...document.querySelectorAll(".dz-q-lines button")].map((b) => b.textContent)).toEqual(["Bütün yazı", "Elif", "&", "Kerem"]);
    expect(chip("Bütün yazı").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".dz-q .tz-selbox")).not.toBeNull();
    // Cetvel ve kesim işareti yok (küçük tuval).
    expect(document.querySelector(".dz-q .tz-rl")).toBeNull();
    expect(document.querySelector(".dz-q .tz-crop")).toBeNull();
    expect(document.querySelector(".dz-q-note")?.textContent).toBe("Satırı tutup sürükleyin");
    expect([...document.querySelectorAll(".dz-q-center button")].map((b) => b.textContent)).toEqual(["Yatay", "Dikey", "Tam ortala"]);
    // Tek satır seçilince metin alanı o satırın metniyle açılır.
    await click(chip("Kerem"));
    expect(chip("Kerem").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector<HTMLInputElement>('.dz-q input[aria-label="Satır 3 metni"]')?.value).toBe("Kerem");
    for (const b of document.querySelectorAll<HTMLButtonElement>(".dz-q .tz-ib")) expect(b.getAttribute("aria-label")).toBeTruthy();
    // Genel kısayol bağlamaz: H tuşu ortalamaz.
    await press("h");
    expect(puts()).toHaveLength(0);
    await r.unmount();
  });

  it("sürüklenen satır kısa duraksamadan sonra kendiliğinden kaydedilir; müşteri metni değişmez", async () => {
    const { r, onSaved } = await hizli();
    // Sahte sunucuda yazı katmanı yok (satıra isabet yok): satır düğmeyle seçilir, tuvalde seçim sürüklenir.
    await click(chip("Kerem"));
    await dragKerem(30);
    expect(chip("Kerem").getAttribute("aria-pressed")).toBe("true");
    expect(puts()).toHaveLength(0);
    await waitFor(() => puts().length === 1, AUTOSAVE_MS + 2000);
    const body = puts()[0]!.body as { adjust: { lines?: { index: number; dx: number }[]; edits?: unknown } };
    expect(body.adjust.lines).toHaveLength(1);
    expect(body.adjust.lines![0]!.index).toBe(2);
    expect(body.adjust.lines![0]!.dx).toBeGreaterThan(0);
    expect(body.adjust.edits).toBeUndefined();
    await waitFor(() => onSaved.mock.calls.length === 1);
    expect(document.querySelector(".dz-q-note")?.textContent).toBe("Kaydedildi");
    // Yeni değişiklik yoksa ikinci kayıt gitmez.
    await wait(AUTOSAVE_MS + 100);
    expect(puts()).toHaveLength(1);
    await r.unmount();
  });

  it("flush bekleyen değişikliği hemen kaydeder (beklemeden), sonra ikinci kayıt gitmez", async () => {
    const { r, ref, onSaved } = await hizli();
    await click(chip("Elif"));
    await click(document.querySelector<HTMLButtonElement>('.dz-q button[aria-label="Büyüt (%2)"]')!);
    let ok: boolean | undefined;
    await act(async () => {
      ok = await ref.current!.flush();
    });
    expect(ok).toBe(true);
    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.body).toEqual({ adjust: { dx: 0, dy: 0, scale: 1, lines: [{ index: 0, dx: 0, dy: 0, scale: 1.02 }] } });
    expect(onSaved).toHaveBeenCalledTimes(1);
    await wait(AUTOSAVE_MS + 100);
    expect(puts()).toHaveLength(1);
    // Değişiklik yokken flush istek göndermez ve true döner.
    await act(async () => {
      ok = await ref.current!.flush();
    });
    expect(ok).toBe(true);
    expect(puts()).toHaveLength(1);
    await r.unmount();
  });

  it("flush açık metin taslağını motorla yazar ve kaydeder (metin yalnız kişi düzenleyince değişir)", async () => {
    const { r, ref } = await hizli();
    await click(chip("Kerem"));
    const input = document.querySelector<HTMLInputElement>('.dz-q input[aria-label="Satır 3 metni"]')!;
    await act(async () => input.focus());
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Kerem Can");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Taslak açıkken kendiliğinden kayıt gitmez.
    await wait(AUTOSAVE_MS + 100);
    expect(puts()).toHaveLength(0);
    await act(async () => {
      await ref.current!.flush();
    });
    expect(calls.find((c) => c.url.endsWith("/edit/relayout"))?.body).toEqual({ edits: [{ index: 2, text: "Kerem Can" }] });
    expect(puts()).toHaveLength(1);
    expect((puts()[0]!.body as { adjust: { edits: unknown } }).adjust.edits).toEqual([{ index: 2, text: "Kerem Can" }]);
    await r.unmount();
  });

  it("kayıt hatası görünür, flush false döner; Yeniden dene kaydeder", async () => {
    putFails = true;
    const { r, ref, onSaved } = await hizli();
    await click(chip("Elif"));
    await click(document.querySelector<HTMLButtonElement>('.dz-q button[aria-label="Büyüt (%2)"]')!);
    let ok: boolean | undefined;
    await act(async () => {
      ok = await ref.current!.flush();
    });
    expect(ok).toBe(false);
    const alert = await waitFor(() => document.querySelector(".dz-q [role=alert]"));
    expect(alert.textContent).toContain("Değişiklik kaydedilemedi.");
    expect(onSaved).not.toHaveBeenCalled();
    putFails = false;
    await click(r.byText("Yeniden dene")!);
    await waitFor(() => !document.querySelector(".dz-q [role=alert]"));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(puts().length).toBe(2);
    await r.unmount();
  });

  it("kaldırılırken bekleyen kayıt yazılır", async () => {
    const { r } = await hizli();
    await click(chip("Elif"));
    await click(document.querySelector<HTMLButtonElement>('.dz-q button[aria-label="Büyüt (%2)"]')!);
    await r.unmount();
    await waitFor(() => puts().length === 1);
  });

  it("geri al ve sıfırla küçük tuvalin köşesinde", async () => {
    const { r } = await hizli();
    const undo = document.querySelector<HTMLButtonElement>('.dz-q-tools button[aria-label="Geri al"]')!;
    const reset = document.querySelector<HTMLButtonElement>('.dz-q-tools button[aria-label="Bütün düzeltmeyi sıfırla"]')!;
    expect(undo.disabled).toBe(true);
    expect(reset.disabled).toBe(true);
    await click(r.byText("Tam ortala")!);
    await click(document.querySelector<HTMLButtonElement>('.dz-q button[aria-label="Büyüt (%2)"]')!);
    expect(undo.disabled).toBe(false);
    await click(undo);
    await click(reset);
    expect(reset.disabled).toBe(true);
    await r.unmount();
  });
});

describe("Küçük tezgâh ve büyük pencere birlikte", () => {
  it("pencerede kaydedilen düzeltme küçük tezgâha kendiliğinden gelir", async () => {
    const onClose = vi.fn();
    const r = await render(
      <>
        <HizliDuzelt variantId="v1" />
        <DuzeltPenceresi variantId="v1" onClose={onClose} />
      </>,
    );
    await waitFor(() => document.querySelector(".dz-q .dz-stage") && document.querySelector("dialog.tz-wd[open] .dz-stage"));
    await flush();
    const reset = () => document.querySelector<HTMLButtonElement>('.dz-q-tools button[aria-label="Bütün düzeltmeyi sıfırla"]')!;
    expect(reset().disabled).toBe(true);
    await press("ArrowRight");
    // Pencere açıkken ok tuşu yalnız pencerenin yazısını taşır.
    expect(reset().disabled).toBe(true);
    await press("s", { ctrlKey: true });
    await waitFor(() => onClose.mock.calls.length === 1);
    expect(onClose).toHaveBeenCalledWith(true);
    await waitFor(() => !reset().disabled);
    expect(puts()).toHaveLength(1);
    await r.unmount();
  });
});

describe("Düzelt penceresi (büyük pencere)", () => {
  async function pencere(onClose = vi.fn()) {
    const r = await render(<DuzeltPenceresi variantId="v1" onClose={onClose} />);
    await waitFor(() => document.querySelector("dialog.tz-wd[open] .dz-stage"));
    await flush();
    return { r, onClose };
  }
  const rows = () => [...document.querySelectorAll<HTMLButtonElement>(".tz-wd .tz-lr-b")];

  it("ekranın üstünde açılır: başlık, satırlar, tuval, özellik paneli; Vazgeç ve Kaydet pencerenin altında", async () => {
    const { r } = await pencere();
    const dlg = document.querySelector("dialog.tz-wd")!;
    expect(dlg.querySelector("h2")?.textContent).toBe("Ayrıntılı düzenle");
    expect(dlg.querySelector(".tz-wd-sub")?.textContent).toBe("№ 9014 · V2 · Elif & Kerem");
    expect(rows().map((b) => b.querySelector("b")?.textContent)).toEqual(["Elif", "&", "Kerem"]);
    expect(dlg.querySelector(".tz-pnl--r .tz-pnl-f")).toBeNull();
    const foot = dlg.querySelector(".tz-wd-f")!;
    expect([...foot.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["VazgeçEsc", "KaydetCtrl S"]);
    expect(dlg.querySelectorAll(".tz-btn--primary")).toHaveLength(1);
    // Odak tuvalde (kısayollar hemen çalışsın).
    expect(document.activeElement).toBe(dlg.querySelector(".dz-stage"));
    await r.unmount();
  });

  it("Kaydet gövdeyi gönderir ve onClose(true) verir", async () => {
    const { r, onClose } = await pencere();
    await click(rows()[2]!);
    await press("ArrowRight");
    expect(document.querySelector(".tz-wd .dz-sb-sum")?.textContent).toBe("1 satır ayrı");
    await click(r.byText("KaydetCtrl S")!);
    await flush();
    expect(puts()[0]?.body).toEqual({ adjust: { dx: 0, dy: 0, scale: 1, lines: [{ index: 2, dx: 1, dy: 0, scale: 1 }] } });
    expect(onClose).toHaveBeenCalledWith(true);
    await r.unmount();
  });

  it("Ctrl S pencerede kaydeder", async () => {
    const { r, onClose } = await pencere();
    await press("ArrowDown");
    await press("s", { ctrlKey: true });
    await flush();
    expect(puts()).toHaveLength(1);
    expect(onClose).toHaveBeenCalledWith(true);
    await r.unmount();
  });

  it("Vazgeç değişiklik yokken onaysız kapatır; Esc önce seçimi kaldırır, sonra değişikliği sorar", async () => {
    const { r, onClose } = await pencere();
    await click(r.byText("VazgeçEsc")!);
    await flush();
    expect(onClose).toHaveBeenCalledWith(false);
    expect(puts()).toHaveLength(0);
    await r.unmount();

    const second = await pencere();
    await click(rows()[0]!);
    await press("ArrowLeft");
    await press("Escape");
    expect(second.onClose).not.toHaveBeenCalled();
    await press("Escape");
    await flush();
    const ask = await waitFor(() => [...document.querySelectorAll("dialog[open]")].find((d) => d.textContent?.includes("Kaydedilmemiş değişiklik var")));
    expect(ask).toBeTruthy();
    // Onay açıkken pencerenin kısayolları kapalı: ok tuşu yazıyı taşımaz.
    const before = document.querySelector(".tz-wd .dz-sb-sum")?.textContent;
    await press("ArrowLeft");
    expect(document.querySelector(".tz-wd .dz-sb-sum")?.textContent).toBe(before);
    await click(second.r.byText("Kaydetmeden çık")!);
    await flush();
    expect(second.onClose).toHaveBeenCalledWith(false);
    expect(puts()).toHaveLength(0);
    await second.r.unmount();
  });

  it("kapatma düğmesi Vazgeç gibi davranır", async () => {
    const { r, onClose } = await pencere();
    await click(document.querySelector<HTMLButtonElement>('.tz-wd-h button[aria-label="Kapat"]')!);
    await flush();
    expect(onClose).toHaveBeenCalledWith(false);
    await r.unmount();
  });

  it("açılamayan düzeltmede ileti; Geri dön kapatır", async () => {
    mockFetch({ "/api/variants/v1/edit": () => Promise.reject(new Error("x")) });
    const onClose = vi.fn();
    const r = await render(<DuzeltPenceresi variantId="v1" onClose={onClose} />);
    await waitFor(() => document.querySelector(".tz-wd .dz-msg"));
    await click(r.byText("Geri dön")!);
    expect(onClose).toHaveBeenCalledWith(false);
    await r.unmount();
  });
});
