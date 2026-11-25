// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTestLocale } from "../../i18n/test.ts";
import { parseHash } from "../../lib/route.ts";
import { click, flush, mockFetch, render, type Rendered, waitFor } from "../../tezgah/test/render.tsx";
import AyarlarEkrani from "./index.tsx";

/** Yalnız yanıt şekli: iş kuralı yok. */
const LANGS = [
  { id: "dil-1", name: "GiftUpStore", activeVersion: 2, hasDraft: false, templateCount: 3, isDefault: true, createdAt: "2026-10-01T00:00:00Z" },
  { id: "dil-2", name: "Deneme", activeVersion: null, hasDraft: true, templateCount: 0, isDefault: false, createdAt: "2026-10-02T00:00:00Z" },
];
const SETTINGS = {
  settings: { defaultLanguageId: "dil-1", concurrency: 2, variantsPerRun: 1 },
  keys: [
    { provider: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com", hasKey: false, encrypted: true, updatedAt: null },
    { provider: "gemini", label: "Gemini", baseUrl: "https://generativelanguage.googleapis.com", hasKey: true, encrypted: true, updatedAt: "2026-11-01T10:00:00Z" },
  ],
  warnings: [],
};
const COSTS = {
  todayUsd: 0.5,
  monthUsd: 3.25,
  totalUsd: 12.5,
  byDay: [{ day: new Date().toISOString().slice(0, 10), usd: 0.5, calls: 4 }],
  byModel: [{ model: "claude-haiku-5-5", usd: 1, calls: 5 }],
  byPurpose: [{ purpose: "design", usd: 1, calls: 5 }],
  unpricedCalls: 0,
};
const FONTS = {
  files: [{ file: "a.ttf", scope: "language", family: "Aria", style: "Regular", profileFontId: null, size: 2048, specimenUrl: "/x" }],
  missing: [],
};

let calls: ReturnType<typeof mockFetch>["calls"];
beforeEach(() => {
  calls = mockFetch({
    "/api/languages": { languages: LANGS },
    "/api/generate/status": { running: 0, queued: 0 },
    "/api/settings": SETTINGS,
    "/api/costs": COSTS,
    "/api/languages/dil-1/fonts": FONTS,
    "/api/settings/keys/anthropic": (_u: string, init?: RequestInit) => ({ ...SETTINGS.keys[0], hasKey: init?.method === "PUT", updatedAt: "2026-11-21T10:00:00Z" }),
    "/api/languages/dil-2": { undoToken: "tok", label: "silindi" },
  }).calls;
});
afterEach(() => {
  document.body.innerHTML = "";
  try {
    localStorage.clear();
  } catch {
    /* yok */
  }
  setTestLocale("tr");
});

async function ac(rest: string[]): Promise<Rendered> {
  const route = parseHash(`#/ayarlar/${rest.join("/")}`);
  const r = await render(<AyarlarEkrani route={route} go={() => {}} />);
  await flush(4);
  return r;
}

/** Denetimli giriş alanına yazar. */
async function yaz(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const dugme = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);

describe("Ayarlar: bölüm listesi ve rota", () => {
  it("sekiz bölüm listelenir; adres bölümü açar", async () => {
    const r = await ac(["maliyet"]);
    const items = [...document.querySelectorAll(".ay-gl-b")].map((b) => b.textContent);
    expect(items).toEqual(["Bağlantılar", "Üretim", "Fontlar", "Maliyet", "Tasarım dilleri", "Özellikler", "Firma", "Dil"]);
    expect(document.querySelector(".ay-gl-b[aria-current]")?.textContent).toBe("Maliyet");
    await waitFor(() => document.querySelector(".ay-totals"));
    expect(document.querySelector(".tz-cr")?.textContent).toContain("Maliyet");
    await r.unmount();
  });

  it("bölüm yoksa ilk bölüm; eski görünüm adresi Dil'e gider", async () => {
    let r = await ac([]);
    expect(document.querySelector(".ay-gl-b[aria-current]")?.textContent).toBe("Bağlantılar");
    await r.unmount();
    r = await ac(["gorunum"]);
    expect(document.querySelector(".ay-gl-b[aria-current]")?.textContent).toBe("Dil");
    await r.unmount();
  });
});

describe("Ayarlar: bağlantılar", () => {
  it("anahtar eklenir; alan maskeli, değer hiçbir yerde görünmez", async () => {
    const r = await ac(["baglantilar"]);
    await waitFor(() => dugme("Anahtarı gir"));
    await click(dugme("Anahtarı gir") as HTMLButtonElement);
    const input = r.get<HTMLInputElement>("input[type=password]");
    await yaz(input, "sk-gizli-anahtar-123");
    expect(document.body.textContent).not.toContain("sk-gizli-anahtar-123");
    await click(dugme("Kaydet") as HTMLButtonElement);
    await waitFor(() => calls.some((c) => c.method === "PUT"));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/api/settings/keys/anthropic");
    expect(put?.body).toEqual({ apiKey: "sk-gizli-anahtar-123" });
    await flush(3);
    expect(document.body.textContent).not.toContain("sk-gizli-anahtar-123");
    expect(document.querySelector("input[type=password]")).toBeNull();
    await r.unmount();
  });

  it("kayıtlı anahtarın yalnız durumu görünür; silmek onay ister", async () => {
    const r = await ac(["baglantilar"]);
    await waitFor(() => dugme("Anahtarı değiştir"));
    expect(document.body.textContent).toContain("Kayıtlı");
    await click(dugme("Sil") as HTMLButtonElement);
    await waitFor(() => document.querySelector(".tz-btn--danger[autofocus], dialog .tz-btn--danger"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await r.unmount();
  });
});

describe("Ayarlar: tasarım dilleri", () => {
  it("silme onay ister; onayda DELETE gider, vazgeçince gitmez", async () => {
    const r = await ac(["tasarim-dilleri"]);
    await waitFor(() => document.querySelector(".ay-list"));
    const more = r.get<HTMLButtonElement>('button[aria-label="Deneme için diğer işlemler"]');
    // Vazgeç
    await click(more);
    await click(r.byText("Sil", "[role=menuitem]") as HTMLElement);
    await waitFor(() => dugme("Vazgeç"));
    await click(dugme("Vazgeç") as HTMLButtonElement);
    await flush(2);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    // Onayla
    await click(r.get<HTMLButtonElement>('button[aria-label="Deneme için diğer işlemler"]'));
    await click(r.byText("Sil", "[role=menuitem]") as HTMLElement);
    const confirmBtn = await waitFor(() => document.querySelector<HTMLButtonElement>(".tz-btn--danger"));
    expect(confirmBtn.textContent).toBe("Sil");
    await click(confirmBtn);
    await waitFor(() => calls.some((c) => c.method === "DELETE"));
    expect(calls.find((c) => c.method === "DELETE")?.url).toContain("/api/languages/dil-2");
    await r.unmount();
  });

  it("varsayılan dilin silme öğesi kapalı", async () => {
    const r = await ac(["tasarim-dilleri"]);
    await waitFor(() => document.querySelector(".ay-list"));
    await click(r.get<HTMLButtonElement>('button[aria-label="GiftUpStore için diğer işlemler"]'));
    const del = [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((b) => b.textContent?.includes("Sil"));
    expect(del?.disabled).toBe(true);
    await r.unmount();
  });
});

describe("Ayarlar: dil", () => {
  it("dil değişince ekran anında çevrilir ve seçim yerel kayıtta kalır", async () => {
    const r = await ac(["dil"]);
    expect(document.querySelector(".ay-h")?.textContent).toBe("Dil");
    await click(r.byText("English", "[role=radio]") as HTMLElement);
    await flush(2);
    expect(document.querySelector(".ay-h")?.textContent).toBe("Language");
    expect(document.querySelector(".ay-gl-b[aria-current]")?.textContent).toBe("Language");
    expect(localStorage.getItem("tagpress.arayuzDili")).toBe("en");
    await r.unmount();
  });

  it("tema seçimi yok", async () => {
    const r = await ac(["dil"]);
    expect(document.body.textContent).not.toMatch(/Koyu|Dark/);
    await r.unmount();
  });
});

describe("Ayarlar: her bölümde en çok bir birincil düğme, her ikon düğmesinin adı var", () => {
  for (const id of ["baglantilar", "uretim", "fontlar", "maliyet", "tasarim-dilleri", "dil"]) {
    it(id, async () => {
      const r = await ac([id]);
      await flush(4);
      expect(document.querySelectorAll(".tz-main .tz-btn--primary").length).toBeLessThanOrEqual(1);
      for (const b of document.querySelectorAll<HTMLButtonElement>(".tz-ib, .tz-cb.is-q")) {
        expect(b.getAttribute("aria-label") || b.textContent?.trim(), b.outerHTML.slice(0, 120)).toBeTruthy();
      }
      await r.unmount();
    });
  }
});
