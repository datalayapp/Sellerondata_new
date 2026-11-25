// @vitest-environment happy-dom
import { FEATURE_KEYS, type FeatureKey } from "@tagpress/domain";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRoute } from "../../lib/route.ts";
import { click, flush, mockFetch, press, render, waitFor } from "../../tezgah/test/render.tsx";
import Kurulum from "./index.tsx";
import { featureRows } from "./ozellikler.ts";

const route: AppRoute = { id: "kurulum", rest: [], query: new URLSearchParams() };

/** Yalnız yanıt şekli: önerinin kuralı sunucuda; burada sabit iki yanıt (sticker'lı / sticker'sız). */
const all = (on: readonly FeatureKey[]) => Object.fromEntries(FEATURE_KEYS.map((k) => [k, on.includes(k)])) as Record<FeatureKey, boolean>;
const BASE = all(["core.production", "import.json", "jobs.manual", "adjust", "revise", "print", "templates.editor", "language.builder"]);
const WITH_STICKER = { ...BASE, "print.stickers": true };
const PENDING = { status: "pending", step: 1, answers: { labelTypes: [] }, completedAt: null, skipped: false };
const LANGS = [{ id: "dil-1", name: "GiftUpStore", activeVersion: 1, hasDraft: false, templateCount: 2, isDefault: true, createdAt: "2026-10-01T00:00:00Z" }];

type Call = { url: string; method: string; body?: unknown };
let calls: Call[];
let setupState: unknown;

beforeEach(() => {
  setupState = PENDING;
  calls = mockFetch({
    "/api/languages": { languages: LANGS },
    "/api/setup": () => setupState,
    "/api/setup/preview": (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { answers: { labelTypes: string[] } };
      return { features: body.answers.labelTypes.includes("sticker") ? WITH_STICKER : BASE, changes: [] };
    },
    "/api/setup/answers": (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { step: number; answers: unknown };
      return { ...PENDING, status: "in-progress", step: body.step, answers: body.answers };
    },
    "/api/setup/complete": (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { answers: unknown };
      return { setup: { ...PENDING, status: "completed", step: 3, answers: body.answers, completedAt: "2026-11-22T00:00:00Z" }, features: { registry: [], effective: BASE, explicit: {} } };
    },
    "/api/setup/skip": { setup: { ...PENDING, status: "completed", step: 3, completedAt: "2026-11-22T00:00:00Z", skipped: true }, features: { registry: [], effective: BASE, explicit: {} } },
  }).calls;
});
afterEach(() => {
  document.body.innerHTML = "";
});

const switchOf = (name: string) => document.body.querySelector<HTMLButtonElement>(`[role=switch][aria-label="${name}"]`);
const isOn = (name: string) => switchOf(name)?.getAttribute("aria-checked") === "true";
const card = (name: string) => [...document.body.querySelectorAll<HTMLButtonElement>(".kr-type")].find((b) => b.querySelector("b")?.textContent === name) as HTMLButtonElement;
const radio = (name: string) => [...document.body.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((b) => b.textContent?.includes(name)) as HTMLButtonElement;
const posts = (path: string) => calls.filter((c) => c.url === path && c.method !== "GET");

async function choose(label: string, value: string) {
  const field = [...document.body.querySelectorAll(".tz-field")].find((f) => f.textContent?.includes(label));
  const sel = field?.querySelector("select") as HTMLSelectElement;
  await act(async () => {
    sel.value = value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function open(go = vi.fn()) {
  const r = await render(<Kurulum route={route} go={go} />);
  await waitFor(() => switchOf("Toplu içe aktarma") && !switchOf("Toplu içe aktarma")?.disabled);
  return { r, go };
}

describe("Kurulum: gerçek uçlar", () => {
  it("tür seçimi öneriyi sunucudan alır; elle kapatılan özellik ve baskı cevapları complete'e gider", async () => {
    const { r, go } = await open();
    expect(document.body.querySelectorAll(".kr-type").length).toBe(6);
    expect(isOn("Sticker sayfaları")).toBe(false);

    await click(card("Sticker"));
    await waitFor(() => isOn("Sticker sayfaları"));
    const previews = posts("/api/setup/preview");
    expect(previews.at(-1)?.body).toEqual({ answers: { labelTypes: ["sticker"] } });

    // Elle kapat: "Şunu değiştir" kapanır, diğerleri öneride kalır.
    await click(switchOf("Şunu değiştir") as HTMLElement);
    expect(isOn("Şunu değiştir")).toBe(false);

    await press("Enter");
    expect(posts("/api/setup/answers").at(-1)?.body).toMatchObject({ step: 2, answers: { labelTypes: ["sticker"] } });
    expect(document.body.textContent).toContain("Tasarım diliniz nasıl kurulsun?");

    await press("Enter");
    expect(posts("/api/setup/answers").at(-1)?.body).toMatchObject({ step: 3 });
    expect(document.body.textContent).toContain("Nasıl basıyorsunuz?");

    await choose("Kağıt", "a5");
    await click(radio("Kesim makinesi"));
    await choose("Makine", "plotter");
    expect(document.body.textContent).toContain("Dört köşeye L işareti basılır");
    // Sticker seçili: ölçü sorusu görünür.
    expect(document.body.textContent).toContain("Sticker ölçüsü");

    await press("Enter");
    await flush(3);
    const done = posts("/api/setup/complete");
    expect(done.length).toBe(1);
    const body = done[0]?.body as { answers: Record<string, unknown>; features: string[] };
    expect(body.answers).toMatchObject({
      labelTypes: ["sticker"],
      language: { choice: "default" },
      print: { paperPreset: "a5", paperType: "plain", usesCutter: true, cutter: "plotter" },
    });
    expect(body.features).toContain("print.stickers");
    expect(body.features).toContain("import.json");
    expect(body.features).not.toContain("revise");
    expect(go).toHaveBeenCalledWith("uretim");
    await r.unmount();
  });

  it("özellik kapatınca ona bağlı olan da kapanır; açınca bağlı olduğu açılır", async () => {
    const { r } = await open();
    await click(card("Sticker"));
    await waitFor(() => isOn("Sticker sayfaları"));
    await click(switchOf("Baskı masası, kesim işaretleri") as HTMLElement);
    expect(isOn("Sticker sayfaları")).toBe(false);
    await click(switchOf("Sticker sayfaları") as HTMLElement);
    expect(isOn("Baskı masası, kesim işaretleri")).toBe(true);
    await r.unmount();
  });

  it("tasarım dili: varsayılan seçili gelir ve dilin adını söyler; Oluştur seçilirse bitince Oluştur ekranı açılır", async () => {
    const { r, go } = await open();
    await click(card("Düğün ve nişan"));
    await click(card("Teşekkür ve hatıra"));
    await flush(2);
    await press("Enter");
    expect(radio("Varsayılanla başla").getAttribute("aria-checked")).toBe("true");
    expect(radio("Varsayılanla başla").textContent).toContain("GiftUpStore ile başlar");
    await click(radio("Örneklerimle oluştur"));
    expect(radio("Örneklerimle oluştur").getAttribute("aria-checked")).toBe("true");
    await press("Enter");
    await press("Enter");
    await flush(3);
    expect((posts("/api/setup/complete")[0]?.body as { answers: { language: unknown } }).answers.language).toEqual({ choice: "build" });
    expect(go).toHaveBeenCalledWith("tasarim-dili", ["olustur"], { kurulum: "1", turler: "wedding,thanks", don: "#/uretim" });
    await r.unmount();
  });

  it("oluşturucu kapatılırsa Oluştur seçilemez, varsayılan kalır", async () => {
    const { r } = await open();
    await click(switchOf("Tasarım dili oluşturma") as HTMLElement);
    await press("Enter");
    expect(radio("Örneklerimle oluştur").disabled).toBe(true);
    expect(radio("Varsayılanla başla").getAttribute("aria-checked")).toBe("true");
    await r.unmount();
  });

  it("yarıda kalan kurulum kayıtlı adımdan ve cevaplarla açılır", async () => {
    setupState = { ...PENDING, status: "in-progress", step: 3, answers: { labelTypes: ["wedding"], language: { choice: "default" }, print: { paperPreset: "letter" } } };
    const r = await render(<Kurulum route={route} go={() => {}} />);
    await waitFor(() => document.body.textContent?.includes("Nasıl basıyorsunuz?"));
    expect(document.body.querySelector<HTMLSelectElement>("select")?.value).toBe("letter");
    // Sticker seçili değil: ölçü sorusu yok.
    expect(document.body.textContent).not.toContain("Sticker ölçüsü");
    await click(r.byText("Geri") as HTMLElement);
    await click(r.byText("Geri") as HTMLElement);
    expect(card("Düğün ve nişan").getAttribute("aria-pressed")).toBe("true");
    await r.unmount();
  });

  it("Atla: varsayılanla başlar (skip) ve Üretim'e gider", async () => {
    const { r, go } = await open();
    await click(r.byText("Atla, varsayılanla başla") as HTMLElement);
    await flush(3);
    expect(posts("/api/setup/skip").length).toBe(1);
    expect(go).toHaveBeenCalledWith("uretim");
    await r.unmount();
  });

  it("tamamlanmış kurulum yeniden açılınca Atla yerine Vazgeç; skip çağrılmaz", async () => {
    setupState = { ...PENDING, status: "completed", step: 3, completedAt: "2026-11-01T00:00:00Z", answers: { labelTypes: ["product"] } };
    const go = vi.fn();
    const r = await render(<Kurulum route={route} go={go} />);
    await waitFor(() => r.byText("Vazgeç"));
    expect(card("Ürün etiketi").getAttribute("aria-pressed")).toBe("true");
    await click(r.byText("Vazgeç") as HTMLElement);
    expect(go).toHaveBeenCalledWith("uretim");
    expect(posts("/api/setup/skip").length).toBe(0);
    await r.unmount();
  });

  it("Enter Devam et'i çalıştırır; Geri 1. adıma döner; ekranda en çok bir birincil düğme, her anahtar adlı", async () => {
    const { r } = await open();
    for (const step of [0, 1, 2]) {
      expect(document.body.querySelectorAll(".tz-btn--primary").length).toBeLessThanOrEqual(1);
      for (const b of document.body.querySelectorAll<HTMLElement>(".tz-ib, [role=switch]")) expect(b.getAttribute("aria-label")?.trim(), b.outerHTML).toBeTruthy();
      if (step < 2) await press("Enter");
    }
    expect(document.body.querySelector('.tz-steps li[aria-current="step"]')?.textContent).toContain("Baskı");
    await click(r.byText("Geri") as HTMLElement);
    await click(r.byText("Geri") as HTMLElement);
    expect(document.body.textContent).toContain("Ne tür etiketler yapıyorsunuz?");
    await r.unmount();
  });

  it("satırlar: her zaman açık olan gösterilmez; isteğe bağlılar kapalı grupta, türe bağlı olan ana listede", () => {
    const { main, more } = featureRows();
    expect(main).not.toContain("core.production");
    expect(more).not.toContain("core.production");
    expect(main).toContain("print.stickers");
    expect(main).toContain("language.builder");
    expect(more).toContain("image.onTemplate");
    expect([...main, ...more].length).toBe(FEATURE_KEYS.length - 1);
  });
});
