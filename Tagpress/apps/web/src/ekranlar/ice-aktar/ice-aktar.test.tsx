// @vitest-environment happy-dom
import { fixMsg, type ImportPreviewResponse, type ImportRow, type Issue, issueMsg } from "@tagpress/domain";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { parseHash } from "../../lib/route.ts";
import { setShortcutsOpen } from "../../tezgah/kisayol/kayit.ts";
import { TezgahApp } from "../../tezgah/rotalar.tsx";
import { click, flush, mockFetch, press, render, type Rendered, waitFor } from "../../tezgah/test/render.tsx";
import { setPendingImport } from "./bekleyen.ts";
import IceAktarEkrani from "./index.tsx";

/**
 * Yalnız yanıt şekli (domain tipleri); iş kuralı yok. Sorunlar sunucunun kurduğu gibi (`issueMsg`/`fixMsg`: kod, sözlük
 * anahtarı, parametre ve Türkçe yedek metin); ekranda beklenen metin sözlükten okunur (`i18n.t`), elle kopyalanmaz.
 */
const STYLED = "𝓢𝓮𝓵𝓲𝓷 & Mert";
const PLAIN = "Selin & Mert";
const SERVER_ONLY = "Sunucunun kendi cümlesi (sözlükte karşılığı yok).";
const issueTr = (key: string, params?: Record<string, unknown>) => i18n.t(`issues:${key}`, params);
const fixTr = (key: string, params?: Record<string, unknown>) => i18n.t(`issues:fix.${key}`, params);

function row(over: Partial<ImportRow> & { index: number }): ImportRow {
  return {
    raw: {},
    include: true,
    textRaw: "Ayşe & Can",
    text: "Ayşe & Can",
    segments: ["Ayşe & Can"],
    templateInput: "a12",
    templateKey: "a12",
    labelSize: "3.8",
    orderNo: `90${over.index}`,
    quantity: 50,
    product: null,
    kind: "label",
    aiNote: "",
    dismissed: [],
    issues: [],
    dedupeKey: `k${over.index}`,
    ...over,
  };
}

const ROWS: ImportRow[] = [
  row({ index: 0 }),
  row({
    index: 1,
    templateInput: "b12",
    templateKey: null,
    issues: [{ ...issueMsg("template-missing"), severity: "error", fixes: [fixMsg("choose-template-key", { value: "b21", params: { key: "b21" } }), fixMsg("skip")] }],
  }),
  row({
    index: 2,
    text: STYLED,
    textRaw: STYLED,
    segments: [STYLED],
    issues: [{ ...issueMsg("text-unicode-styled", { chars: "𝓢 𝓮 𝓵 𝓲 𝓷" }), severity: "warning", fixes: [fixMsg("convert-unicode", { value: PLAIN }), fixMsg("print-as-is")] }],
  }),
  row({ index: 3, include: false, issues: [{ ...issueMsg("duplicate-in-file", { row: 1 }), severity: "warning", fixes: [fixMsg("skip")] }] }),
  // Sözlükte karşılığı olmayan kod ve anahtar: ekran sunucunun metnine düşer.
  row({ index: 4, issues: [{ code: "text-suspicious", severity: "warning", message: SERVER_ONLY, messageKey: "sozlukte-olmayan-anahtar", fixes: [] } satisfies Issue] }),
];

const PREVIEW: ImportPreviewResponse = {
  languageId: "dil-1",
  fileName: "Etiketler.json",
  fields: ["metin", "adet", "sablon", "no"],
  mapping: { text: "metin", template: "sablon", orderNo: "no", quantity: "adet", product: null, size: null },
  mappingSource: { text: "name", template: "name", orderNo: "content", quantity: "name", product: null, size: null },
  format: "array",
  rows: ROWS,
  warnings: [],
  summary: { total: 5, included: 4, errors: 1, warnings: 3, duplicates: 1, stickers: 0, byCode: {} },
  templateKeys: ["a12", "b21"],
  labelSizes: [{ id: "3.8", cm: 3.8 } as ImportPreviewResponse["labelSizes"][number]],
};

let calls: ReturnType<typeof mockFetch>["calls"];
beforeEach(() => {
  calls = mockFetch({
    "/api/languages": { languages: [{ id: "dil-1", name: "GiftUpStore", isDefault: true }] },
    "/api/generate/status": { running: 0, queued: 0 },
    "/api/import/preview": PREVIEW,
    "/api/import/validate": { rows: [], summary: PREVIEW.summary },
    "/api/import/commit": { batchId: "p1", jobIds: ["j1", "j2"], created: 2, skipped: [], queued: ["j1"] },
  }).calls;
});
afterEach(() => {
  setShortcutsOpen(false);
  document.body.innerHTML = "";
  try {
    localStorage.clear();
  } catch {
    /* yok */
  }
});

async function ac(go = vi.fn()): Promise<Rendered> {
  setPendingImport(new File([JSON.stringify([{ metin: "Ayşe & Can" }])], "Etiketler.json", { type: "application/json" }));
  const r = await render(<IceAktarEkrani route={parseHash("#/uretim/ice-aktar")} go={go} />);
  await waitFor(() => document.querySelector(".ia-row"));
  await flush(2);
  return r;
}

const dugme = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
const aktif = () => document.querySelector(".ia-row.is-act")?.getAttribute("data-row");
const satir = (i: number) => document.querySelector<HTMLElement>(`.ia-row[data-row="${i}"]`);

describe("İçe aktarma masası: açılış", () => {
  it("dosya karşılamada; dosya bırakılınca masa açılır", async () => {
    const r = await render(<IceAktarEkrani route={parseHash("#/uretim/ice-aktar")} go={() => {}} />);
    expect(document.body.textContent).toContain("Sipariş dosyasını buraya bırakın");
    expect(document.querySelectorAll(".tz-btn--primary").length).toBe(1);
    const root = r.get(".ia-root");
    const file = new File(["[]"], "Etiketler.json", { type: "application/json" });
    await act(async () => {
      const e = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
      e.dataTransfer = { types: ["Files"], files: [file] };
      root.dispatchEvent(e);
    });
    await waitFor(() => document.querySelector(".ia-row"));
    expect(calls.find((c) => c.url.includes("/api/import/preview"))?.body).toMatchObject({ fileName: "Etiketler.json", content: "[]" });
    await r.unmount();
  });

  it("ana denetimler yerinde; tek mor birincil; her ikon düğmesinin adı var", async () => {
    const r = await ac();
    expect([...document.querySelectorAll(".tz-tabs [role=tab]")].map((b) => b.textContent)).toEqual(["Hepsi5", "Yalnızca sorunlu4", "Tekrarlar1", "Hariç tutulanlar1"]);
    expect(dugme("Sonraki sorunN")).toBeTruthy();
    expect(dugme("Satır ekle")).toBeTruthy();
    expect(dugme("Başka dosya")).toBeTruthy();
    expect(dugme("Vazgeç")).toBeTruthy();
    expect(dugme("İçe aktar")).toBeTruthy();
    expect(document.querySelector(".tz-btn--primary")?.textContent).toContain("İçe aktar ve üret");
    expect(document.querySelectorAll(".tz-btn--primary").length).toBe(1);
    expect(document.querySelector(".tz-cr")?.textContent).toContain("Etiketler.json");
    expect(document.querySelector(".tz-gc-h")?.textContent).toContain("Alan eşlemesi");
    expect(document.querySelector(".tz-gc-h")?.textContent).toContain("JSON dizisi · 4 alan");
    expect(document.querySelector(".ia-sum")?.textContent).toContain("sipariş içe aktarılacak");
    // sorunlu satırların altında düzeltme şeridi; hariç satırda şerit yok, "tekrar · hariç" yazar
    const fix1 = document.querySelector('[data-fix-for="1"]');
    expect(fix1?.textContent).toContain(issueTr("template-missing"));
    expect([...(fix1?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([fixTr("choose-template-key", { key: "b21" }), fixTr("skip")]);
    expect(document.querySelector('[data-fix-for="3"]')).toBeNull();
    expect(satir(3)?.classList.contains("is-exc")).toBe(true);
    expect(satir(3)?.textContent).toContain("tekrar · hariç");
    for (const b of document.querySelectorAll<HTMLButtonElement>(".tz-ib, .tz-cb.is-q, button")) {
      expect(b.getAttribute("aria-label") || b.textContent?.trim(), b.outerHTML.slice(0, 120)).toBeTruthy();
    }
    await r.unmount();
  });
});

describe("İçe aktarma masası: klavye", () => {
  it("N sonraki soruna, Shift N öncekine gider (sarar)", async () => {
    const r = await ac();
    expect(aktif()).toBe("0");
    await press("n");
    expect(aktif()).toBe("1");
    await press("n");
    expect(aktif()).toBe("2");
    await press("n");
    expect(aktif()).toBe("3");
    await press("n");
    expect(aktif()).toBe("4");
    await press("n");
    expect(aktif()).toBe("1");
    await press("N", { shiftKey: true });
    expect(aktif()).toBe("4");
    await r.unmount();
  });

  it("Space etkin satırı hariç tutar ve geri dahil eder; hariç satır üstü çizili sınıfla", async () => {
    const r = await ac();
    expect(satir(0)?.classList.contains("is-exc")).toBe(false);
    await press(" ");
    expect(satir(0)?.classList.contains("is-exc")).toBe(true);
    expect(satir(0)?.textContent).toContain("hariç");
    await press(" ");
    expect(satir(0)?.classList.contains("is-exc")).toBe(false);
    await r.unmount();
  });

  it("Enter metni yerinde düzenler; Ctrl Enter metni kaydeder (gönderim değil)", async () => {
    const r = await ac();
    await press("Enter");
    const ta = await waitFor(() => document.querySelector<HTMLTextAreaElement>('.ia-row[data-row="0"] textarea'));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(ta, "Ayşe ve Can");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press("Enter", { ctrlKey: true, target: ta });
    expect(document.querySelector('.ia-row[data-row="0"] textarea')).toBeNull();
    expect(satir(0)?.textContent).toContain("Ayşe ve Can");
    expect(satir(0)?.textContent).toContain("düzenlendi");
    expect(calls.some((c) => c.url.includes("/api/import/commit"))).toBe(false);
    await r.unmount();
  });

  it("Ctrl Enter içe aktarır ve üretir: gövde bütün satırları, eşlemeyi ve parti adını taşır", async () => {
    const go = vi.fn();
    const r = await ac(go);
    await press("Enter", { ctrlKey: true });
    await waitFor(() => calls.find((c) => c.url.includes("/api/import/commit")));
    const body = calls.find((c) => c.url.includes("/api/import/commit"))?.body as Record<string, unknown> & { rows: Array<Record<string, unknown>> };
    expect(body).toMatchObject({ fileName: "Etiketler.json", languageId: "dil-1", batchName: "Etiketler", generate: true, mapping: PREVIEW.mapping });
    expect(body.rows).toHaveLength(5);
    expect(body.rows[3]?.include).toBe(false);
    expect(body.rows[2]?.text).toBe(STYLED); // müşteri metni kendiliğinden değişmez
    expect(body.rows[0]).not.toHaveProperty("issues");
    await waitFor(() => go.mock.calls.length > 0);
    expect(go).toHaveBeenCalledWith("uretim");
    expect(document.body.textContent).toContain("2 sipariş içe aktarıldı · 1 iş üretime alındı");
    await r.unmount();
  });

  it("yanıtta notQueued varsa bildirim nedeni söyler (işler açıldı, üretim başlamadı)", async () => {
    calls = mockFetch({
      "/api/languages": { languages: [{ id: "dil-1", name: "GiftUpStore", isDefault: true }] },
      "/api/generate/status": { running: 0, queued: 0 },
      "/api/import/preview": PREVIEW,
      "/api/import/validate": { rows: [], summary: PREVIEW.summary },
      "/api/import/commit": { batchId: "p1", jobIds: ["j1", "j2"], created: 2, skipped: [], queued: [], notQueued: { code: "ai-paused", message: "x" } },
    }).calls;
    const go = vi.fn();
    const r = await ac(go);
    await press("Enter", { ctrlKey: true });
    await waitFor(() => document.body.textContent?.includes("üretim başlamadı"));
    expect(document.body.textContent).toContain("2 sipariş içe aktarıldı; üretim başlamadı: Yapay zekâ SellerOnData'da geçici olarak durduruldu");
    await r.unmount();
  });
});

describe("İçe aktarma masası: düzeltme ve seçim", () => {
  it("süslü yazı: iki seçenek ve önizlemesi; Düz harfe çevir uygulanır, Geri al ile döner", async () => {
    const r = await ac();
    const fix = document.querySelector<HTMLElement>('[data-fix-for="2"]');
    expect(fix?.textContent).toContain(issueTr("text-unicode-styled", { chars: "𝓢 𝓮 𝓵 𝓲 𝓷" }));
    expect(fix?.querySelector(".ia-prev")?.textContent).toContain(PLAIN);
    expect(fix?.querySelector(".ia-prev")?.textContent).toContain(STYLED);
    const buttons = [...(fix?.querySelectorAll<HTMLButtonElement>("button") ?? [])].map((b) => b.textContent);
    expect(buttons.slice(0, 2)).toEqual([fixTr("convert-unicode"), fixTr("print-as-is")]);
    expect(satir(2)?.querySelector(".ia-text")?.textContent).toContain(STYLED);
    await click(dugme(fixTr("convert-unicode")) as HTMLButtonElement);
    expect(satir(2)?.querySelector(".ia-text")?.textContent).toContain(PLAIN);
    const undo = await waitFor(() => dugme("Geri al"));
    await click(undo);
    expect(satir(2)?.querySelector(".ia-text")?.textContent).toContain(STYLED);
    await r.unmount();
  });

  it("süslü yazı: ücretsiz motor önizlemesi gelince iki hâl etiket görseli olarak; düz harf seçili çerçevede", async () => {
    const side = (url: string) => ({ previewUrl: url, lines: [], sizesPx: [], issues: 0, issueList: [], costUsd: null, sameBreaksAsReference: null, sizeDiffVsReference: null });
    calls = mockFetch({
      "/api/languages": { languages: [{ id: "dil-1", name: "GiftUpStore", isDefault: true }] },
      "/api/generate/status": { running: 0, queued: 0 },
      "/api/import/preview": PREVIEW,
      "/api/import/validate": { rows: [], summary: PREVIEW.summary },
      "/api/languages/dil-1/profile/try": {
        estimateUsd: 0,
        costUsd: 0,
        mode: "engine",
        results: [
          { sampleId: "plain", published: side("/p/plain.png"), draft: null },
          { sampleId: "raw", published: side("/p/raw.png"), draft: null },
        ],
      },
    }).calls;
    const r = await ac();
    const fix = document.querySelector<HTMLElement>('[data-fix-for="2"]');
    await waitFor(() => fix?.querySelector(".ia-pv"));
    const body = calls.find((c) => c.url.includes("/profile/try"))?.body as { mode: string; samples: Array<{ text: string; templateKey: string }> };
    expect(body.mode).toBe("engine");
    expect(body.samples.map((s) => s.text)).toEqual([PLAIN, STYLED]);
    expect(body.samples[0]?.templateKey).toBe("a12");
    const cards = [...(fix?.querySelectorAll(".ia-pv") ?? [])];
    expect(cards.map((c) => c.querySelector("img")?.getAttribute("src"))).toEqual(["/p/plain.png", "/p/raw.png"]);
    expect(cards.map((c) => c.textContent)).toEqual([i18n.t("importDesk:styled.plain"), i18n.t("importDesk:styled.asIs")]);
    expect(cards[0]?.classList.contains("is-on")).toBe(true);
    expect(fix?.querySelector(".ia-prev")).toBeNull();
    // müşteri metni kendiliğinden değişmez
    expect(satir(2)?.querySelector(".ia-text")?.textContent).toContain(STYLED);
    await r.unmount();
  });

  it("toplu bağlantılarda yalnız yapılabilecekler; yok sayılan uyarı şeritteki tek çipte, Geri getir ile döner", async () => {
    const r = await ac();
    const links = () => [...document.querySelectorAll(".ia-links button")].map((b) => b.textContent);
    expect(links().some((l) => l?.includes("(0)"))).toBe(false);
    expect(document.querySelector(".tz-tb .ia-dis")).toBeNull();
    await click(dugme(fixTr("print-as-is")) as HTMLButtonElement);
    const chip = await waitFor(() => document.querySelector<HTMLButtonElement>(".tz-tb .ia-dis"));
    expect(chip.textContent).toBe(i18n.t("importDesk:row.dismissed", { count: 1 }));
    expect(satir(2)?.querySelector(".ia-dis")).toBeNull();
    await click(chip);
    const restore = await waitFor(() => dugme(i18n.t("importDesk:row.restore")));
    await click(restore);
    await waitFor(() => !document.querySelector(".tz-tb .ia-dis"));
    expect(document.querySelector('[data-fix-for="2"]')).not.toBeNull();
    await r.unmount();
  });

  it("sözlükte olmayan sorun anahtarı ve kodu: sunucunun cümlesi gösterilir; kısa ad masanın sözlüğünden", async () => {
    const r = await ac();
    expect(i18n.exists("issues:sozlukte-olmayan-anahtar")).toBe(false);
    expect(i18n.exists("issues:text-suspicious")).toBe(false);
    expect(document.querySelector('[data-fix-for="4"]')?.textContent).toContain(SERVER_ONLY);
    expect(satir(4)?.querySelector(".ia-c-iss")?.textContent).toContain(i18n.t("importDesk:issueShort.text-suspicious"));
    await r.unmount();
  });

  it("seçim şeridi: Şablon ata, Dahil et, Hariç tut; Esc seçimi kaldırır", async () => {
    const r = await ac();
    const box = (i: number) => satir(i)?.querySelector<HTMLButtonElement>("[role=checkbox]") as HTMLButtonElement;
    await click(box(0));
    await click(box(1));
    expect(document.querySelector(".tz-selbar")?.textContent).toContain("2 satır seçili");
    expect(dugme("Şablon ata")).toBeTruthy();
    await click(dugme("Hariç tut") as HTMLButtonElement);
    expect(satir(0)?.classList.contains("is-exc")).toBe(true);
    expect(satir(1)?.classList.contains("is-exc")).toBe(true);
    await click(dugme("Dahil et") as HTMLButtonElement);
    expect(satir(0)?.classList.contains("is-exc")).toBe(false);
    await press("Escape");
    expect(document.querySelector(".tz-selbar")).toBeNull();
    await r.unmount();
  });

  it("Satır ekle boş satırı açar ve metnini düzenletir", async () => {
    const r = await ac();
    await click(dugme("Satır ekle") as HTMLButtonElement);
    await waitFor(() => document.querySelector('.ia-row[data-row="5"] textarea'));
    expect(document.querySelectorAll(".ia-row").length).toBe(6);
    await r.unmount();
  });
});

describe("İçe aktarma masası: rota ve kısayol listesi", () => {
  it("#/uretim/ice-aktar çerçeveyle açılır; ? listesinde masanın kısayolları var", async () => {
    window.location.hash = "#/uretim/ice-aktar";
    const r = await render(<TezgahApp />);
    await waitFor(() => document.querySelector(".ia-intake"));
    expect(document.querySelector(".tz-nv a[aria-current=page]")?.getAttribute("href")).toBe("#/uretim");
    expect(document.querySelector(".tz-ctx .tz-cr")?.textContent).toContain("İçe aktar");
    await press("?", { shiftKey: true });
    expect(document.querySelector("dialog .tz-kp")?.textContent).toContain(i18n.t("importDesk:shortcuts.close"));
    await act(async () => setShortcutsOpen(false));
    await r.unmount();
  });
});
