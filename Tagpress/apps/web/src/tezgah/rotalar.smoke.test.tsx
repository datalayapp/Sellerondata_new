// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setShortcutsOpen } from "./kisayol/kayit.ts";
import { TezgahApp } from "./rotalar.tsx";
import { flush, mockFetch, press, render, waitFor } from "./test/render.tsx";

/**
 * Duman testi: her rota çerçeveyle (üst satır, beş menü, iş satırı ya da tam bant) açılır; en çok bir mor birincil
 * düğme; her ikon düğmesinin adı var; `?` kısayol listesini açar.
 */
const API = {
  "/api/languages": { languages: [{ id: "dil-1", name: "GiftUpStore", isDefault: true }] },
  "/api/generate/status": { running: 2, queued: 3 },
};

beforeEach(() => {
  mockFetch(API);
});
afterEach(() => {
  setShortcutsOpen(false);
  document.body.innerHTML = "";
});

async function open(hash: string) {
  window.location.hash = hash;
  const r = await render(<TezgahApp />);
  await waitFor(() => document.querySelector(".tz-top"));
  await flush(3);
  return r;
}

function frameChecks({ onePrimary = true } = {}) {
  expect(document.querySelector(".tz-top")).not.toBeNull();
  expect(document.querySelectorAll(".tz-nv a").length).toBe(5);
  if (onePrimary) expect(document.querySelectorAll(".tz-btn--primary").length).toBeLessThanOrEqual(1);
  for (const b of document.querySelectorAll<HTMLButtonElement>(".tz-ib, .tz-cb.is-q, .tz-rail-b")) {
    expect(b.getAttribute("aria-label") || b.textContent?.trim(), b.outerHTML.slice(0, 120)).toBeTruthy();
  }
}

const WORK_ROUTES: Array<[string, string, string | null]> = [
  ["#/uretim", "Üretim", "uretim"],
  ["#/uretim?parti=p1&is=j1", "Üretim", "uretim"],
  ["#/uretim/ice-aktar", "İçe aktar", "uretim"],
  ["#/duzelt/x", "Düzelt", "uretim"],
  ["#/duzelt/x?don=%23%2Fbaski%2Fmasa%2Fs1", "Düzelt", "baski"],
  // Tasarım dili iş satırında yer adı yalnız dilin adı (maket T2 td bölümleri), "Tasarım dili" menüde.
  ["#/tasarim-dili/kurallar", "GiftUpStore", "tasarim-dili"],
  ["#/sablonlar/a15", "Şablonlar", "sablonlar"],
  // Baskı masası iş satırında sekmeler önce gelir (maket T1, `tabsFirst`); oturum yokken yer adı yok, seçili sekme denetlenir.
  ["#/baski", "sekme:Masa", "baski"],
  ["#/baski/masa/s1", "sekme:Masa", "baski"],
  ["#/baski/sablonlar", "Sayfa şablonları", "baski"],
  ["#/baski/arsiv", "Arşiv", "baski"],
  ["#/ayarlar/baglantilar", "Ayarlar", "ayarlar"],
];

/** Yer tutucusu gerçek ekranla değişen rotalar (dalga dalga büyür). */
const GERCEK_EKRANLAR = new Set(["#/sablonlar/a15", "#/baski/sablonlar", "#/baski/arsiv", "#/uretim", "#/uretim?parti=p1&is=j1", "#/ayarlar/baglantilar", "#/tasarim-dili/kurallar", "#/uretim/ice-aktar", "#/baski", "#/baski/masa/s1", "#/duzelt/x", "#/duzelt/x?don=%23%2Fbaski%2Fmasa%2Fs1"]);

describe("Tezgâh rotaları (duman)", () => {
  it.each(WORK_ROUTES)("%s çerçeve ve yer tutucuyla açılır", async (hash, crumb, nav) => {
    const r = await open(hash);
    frameChecks();
    if (crumb.startsWith("sekme:")) expect(document.querySelector(".tz-ctx [role=tablist] [aria-selected=true]")?.textContent).toContain(crumb.slice(6));
    else expect(document.querySelector(".tz-ctx .tz-cr")?.textContent).toContain(crumb);
    expect(document.querySelector(".tz-nv a[aria-current=page]")?.getAttribute("href")).toBe(nav ? `#/${nav}` : null);
    // Gerçek ekranı yazılmış rotalarda yer tutucu yoktur; kalanlarda yer tutucu beklenir.
    if (!GERCEK_EKRANLAR.has(hash)) expect(document.body.textContent).toContain("Bu ekran hazırlanıyor");
    await r.unmount();
  });

  it("#/kurulum tam bantla açılır, menüde etkin sekme yok", async () => {
    const r = await open("#/kurulum");
    frameChecks();
    expect(document.querySelector(".tz-app--full .tz-ttl")?.textContent).toBe("Ne tür etiketler yapıyorsunuz?");
    expect(document.querySelector(".tz-nv a[aria-current=page]")).toBeNull();
    await r.unmount();
  });

  it("#/vitrin ve #/vitrin/tuval bileşenleri gösterir", async () => {
    let r = await open("#/vitrin");
    frameChecks({ onePrimary: false }); // vitrin bütün düğme türlerini yan yana gösterir
    expect(document.querySelectorAll(".tz-vitrin-sec").length).toBeGreaterThanOrEqual(4);
    await r.unmount();
    r = await open("#/vitrin/tuval");
    await waitFor(() => document.querySelector(".tz-cv"));
    expect(document.querySelector(".tz-zm")).not.toBeNull();
    await r.unmount();
  });

  it("üst satır üretim durumunu ve tasarım dilini gösterir", async () => {
    const r = await open("#/uretim");
    expect(document.querySelector(".tz-tr")?.textContent).toContain("Üretiliyor 2 · sırada 3");
    expect(document.querySelector(".or-dls")?.textContent).toContain("GiftUpStore");
    await r.unmount();
  });

  it("? kısayol listesini açar; Alt 4 Ayarlar'a gider", async () => {
    const r = await open("#/uretim");
    await press("?", { shiftKey: true });
    expect(document.querySelector("dialog .tz-kp")).not.toBeNull();
    expect(document.body.textContent).toContain("Klavye kısayolları");
    await act(async () => setShortcutsOpen(false));
    await press("4", { altKey: true });
    await flush(6);
    expect(window.location.hash).toBe("#/ayarlar");
    await r.unmount();
  });
});
