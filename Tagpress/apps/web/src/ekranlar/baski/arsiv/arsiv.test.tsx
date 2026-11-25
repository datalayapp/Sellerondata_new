// @vitest-environment happy-dom
import type { PrintSessionSummary } from "@tagpress/domain";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setShortcutsOpen } from "../../../tezgah/kisayol/kayit.ts";
import { TezgahApp } from "../../../tezgah/rotalar.tsx";
import { click, flush, mockFetch, render, waitFor } from "../../../tezgah/test/render.tsx";

/**
 * Baskı arşivi duman testi (sahte sunucu): basılmış oturumların listesi, arama isteği, Aç (masaya), Basılmadı
 * (taslağa döner), Yeniden bas (yeni taslak masada açılır); tek birincil düğme kuralı ve ikon düğmelerinin adı.
 */

const summary = (id: string, name: string, over: Partial<PrintSessionSummary> = {}): PrintSessionSummary =>
  ({
    id,
    languageId: "dil-1",
    name,
    status: "printed",
    version: 3,
    createdAt: "2026-11-20T10:00:00Z",
    updatedAt: "2026-11-20T10:00:00Z",
    printedAt: "2026-11-20T15:20:00Z",
    templateId: "t1",
    pageCount: 3,
    sheetCount: 5,
    itemCount: 127,
    jobCount: 4,
    orderNos: ["9014", "9015", "9021", "9030"],
    sourceSessionId: null,
    ...over,
  }) as PrintSessionSummary;

let api: ReturnType<typeof mockFetch>;

beforeEach(() => {
  api = mockFetch({
    "/api/languages": { languages: [{ id: "dil-1", name: "GiftUpStore", isDefault: true }] },
    "/api/generate/status": { running: 0, queued: 0, concurrency: 1, runningJobIds: [] },
    "/api/print/sessions": (url: string) => {
      const q = new URL(url, "http://x").searchParams.get("q");
      const all = [
        summary("s1", "21 Kasım oturumu", { noticeCodes: ["printed-old-scale"] }),
        summary("s2", "Yurt dışı siparişleri", { sourceSessionId: "s0", orderNos: ["8990"], pageCount: 2, sheetCount: 2, itemCount: 50 }),
      ];
      return { sessions: q ? all.filter((s) => s.orderNos.some((n) => n.includes(q))) : all };
    },
    "/api/print/sessions/s1/printed": () => ({ id: "s1", name: "21 Kasım oturumu", status: "draft" }),
    "/api/print/sessions/s1/reprint": () => ({ id: "s9", name: "21 Kasım oturumu (yeniden)", status: "draft", pages: [] }),
  });
});

afterEach(() => {
  setShortcutsOpen(false);
  document.body.innerHTML = "";
});

async function open() {
  window.location.hash = "#/baski/arsiv";
  const r = await render(<TezgahApp />);
  await waitFor(() => document.querySelectorAll(".bs-ar-tbl tbody tr").length === 2);
  await flush(2);
  return r;
}

const rowButton = (row: number, text: string) => {
  const tr = document.querySelectorAll<HTMLTableRowElement>(".bs-ar-tbl tbody tr")[row]!;
  return [...tr.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text)!;
};

function frameChecks() {
  expect(document.querySelectorAll(".tz-btn--primary").length).toBeLessThanOrEqual(1);
  for (const b of document.querySelectorAll<HTMLButtonElement>(".tz-ib, .tz-cb.is-q")) {
    expect(b.getAttribute("aria-label") || b.textContent?.trim(), b.outerHTML.slice(0, 120)).toBeTruthy();
  }
}

describe("Baskı arşivi", () => {
  it("basılmış oturumları listeler (yalnız basılmışlar istenir); arama sunucuya gider", async () => {
    const r = await open();
    const first = api.calls.find((c) => c.url.includes("/api/print/sessions"))!;
    expect(new URL(first.url, "http://x").searchParams.get("status")).toBe("printed");
    expect(document.querySelector(".tz-ctx .tz-cr")?.textContent).toContain("Arşiv");
    expect(document.querySelector(".tz-ctx [role=tablist] [aria-selected=true]")?.textContent).toBe("Arşiv");
    const rows = [...document.querySelectorAll<HTMLTableRowElement>(".bs-ar-tbl tbody tr")];
    expect(rows[0]!.textContent).toContain("21 Kasım oturumu");
    expect(rows[0]!.textContent).toContain("3 sayfa · 5 kağıt · 127 etiket");
    expect(rows[0]!.textContent).toContain("№ 9014 · № 9015 · № 9021 +1");
    expect(rows[1]!.textContent).toContain("yeniden basım");
    expect(document.querySelector(".bs-ar-n")?.textContent).toBe("2 oturum");
    frameChecks();

    const input = document.querySelector<HTMLInputElement>('input[aria-label="Arşivde ara"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "8990");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await waitFor(() => api.calls.some((c) => new URL(c.url, "http://x").searchParams.get("q") === "8990"));
    await waitFor(() => document.querySelectorAll(".bs-ar-tbl tbody tr").length === 1);
    await r.unmount();
  });

  it("eski sticker ölçüsüyle basılmış oturumda kısa işaret; ipucu açıklar (metin sözlükten)", async () => {
    const r = await open();
    const rows = [...document.querySelectorAll<HTMLTableRowElement>(".bs-ar-tbl tbody tr")];
    const flag = rows[0]!.querySelector<HTMLElement>(".bs-ar-flag");
    expect(flag?.textContent).toBe("eski ölçü");
    expect(flag?.querySelector(".tz-tag--info")).not.toBeNull();
    // Bildirim kodu olmayan (ya da eski sunucudan alanı gelmeyen) satırda işaret yok.
    expect(rows[1]!.querySelector(".bs-ar-flag")).toBeNull();
    await act(async () => {
      // React fare girişini pointerover'dan çıkarır.
      flag!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
    });
    await waitFor(() => document.body.textContent?.includes("Eski sticker ölçüsüyle basıldı; dosya basıldığı gibi çıkar."));
    await r.unmount();
  });

  it("Aç oturumu masada açar", async () => {
    const r = await open();
    await click(rowButton(0, "Aç"));
    await waitFor(() => window.location.hash === "#/baski/masa/s1");
    await r.unmount();
  });

  it("Basılmadı oturumu taslağa döndürür", async () => {
    const r = await open();
    await click(rowButton(0, "Basılmadı"));
    await waitFor(() => api.calls.some((c) => c.url.endsWith("/api/print/sessions/s1/printed")));
    expect(api.calls.find((c) => c.url.endsWith("/printed"))?.body).toEqual({ printed: false });
    await waitFor(() => document.body.textContent?.includes("Oturum yeniden taslak oldu; masada düzenlenebilir."));
    await r.unmount();
  });

  it("Yeniden bas yeni taslak kurar ve masada açar", async () => {
    const r = await open();
    await click(rowButton(0, "Yeniden bas"));
    await waitFor(() => api.calls.some((c) => c.method === "POST" && c.url.endsWith("/api/print/sessions/s1/reprint")));
    await waitFor(() => window.location.hash === "#/baski/masa/s9");
    await r.unmount();
  });
});
