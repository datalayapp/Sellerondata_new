// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTestLocale } from "../../../i18n/test.ts";
import { click, waitFor } from "../../../tezgah/test/render.tsx";
import { ac, denetle, dugme, gorsel, kur, proposal, ref } from "../ornekler/test-veri.tsx";

const R1 = ref("r1", "Elif & Kerem 14.06.2027");
const P1 = proposal("p1", {
  title: "Ikincil satir biraz kuculsun",
  evidence: {
    source: "learn-run",
    origin: "reference",
    count: 14,
    examples: ["r1"],
    heldOut: { n: 12, before: { lineMatch: 0.82, sizeError: 0.061 }, after: { lineMatch: 0.86, sizeError: 0.07 } },
    before: { score: 0.74 },
    after: { score: 0.79 },
    previews: [{ referenceId: "r1", url: "/api/learn/previews/run1/a-r1.png" }],
  },
});
const P2 = proposal("p2", { status: "accepted", title: "Applied one", createdAt: "2026-11-01T10:00:00Z" });
const P3 = proposal("p3", { title: "Second open", createdAt: "2026-11-01T09:00:00Z", patch: [{ target: "template", key: "A15", field: "textCenter", path: "template:A15.textCenter", from: { x: 0.5, y: 0.5 }, to: { x: 0.5, y: 0.48 } }] });

let calls: ReturnType<typeof kur>;
beforeEach(() => {
  calls = kur({
    refs: [R1],
    proposals: [P1, P2, P3],
    routes: {
      "/api/learn/proposals/p1/apply": { proposal: { ...P1, status: "accepted" }, draft: null, templates: [] },
      "/api/learn/proposals/p1": { ...P1, status: "rejected" },
      "/api/learn/proposals/p2/revert": { proposal: { ...P2, status: "open" }, draft: null, templates: [] },
    },
  });
});
afterEach(() => {
  document.body.innerHTML = "";
  setTestLocale("tr");
});

const satirlar = () => [...document.querySelectorAll<HTMLButtonElement>(".tz-pnl--l .tz-lr-b")];
const sag = () => document.querySelector(".tz-pnl--r")!;

describe("Tasarım dili: Öğren", () => {
  it("solda bekleyen öneriler, ortada önce/sonra ve test kümesi ölçüleri, sağda değişecek alan ve dayanağı", async () => {
    const r = await ac("#/tasarim-dili/ogren");
    await waitFor(() => satirlar().length === 2);
    expect(document.querySelector('.tz-btabs [data-tab-id="ogren"]')?.textContent).toContain("2");
    expect(satirlar()[0]?.textContent).toContain("Ikincil satir biraz kuculsun");
    expect(satirlar()[0]?.textContent).toContain("14 düzeltmenizde aynı örüntü");
    expect(gorsel("Aynı örneğin son hâli, öneriden önce ve sonra")?.getAttribute("src")).toBe("/api/learn/previews/run1/a-r1.png");
    const dock = document.querySelector(".td-og-olcu")!;
    expect(dock.textContent).toContain("Ayrılmış test kümesinde, önce ve sonra");
    expect(dock.textContent).toContain("Satır bölmesi tutma oranı");
    expect(dock.textContent).toContain("%82");
    expect(dock.textContent).toContain("%86");
    expect(dock.textContent).toContain("Daha iyi");
    expect(dock.textContent).toContain("Ortalama boyut sapması");
    expect(dock.textContent).toContain("Daha kötü");
    expect(sag().textContent).toContain("Değişecek alanlar");
    expect(sag().textContent).toContain("Doluluk");
    expect(sag().textContent).toContain("%95");
    expect(sag().textContent).toContain("14 düzeltmenizde aynı örüntü görüldü.");
    expect(sag().textContent).toContain("Öğrenme örneklerinde");
    expect(denetle("ogren")).toEqual({ label: "ogren", primary: 1, unnamed: [] });
    await r.unmount();
  });

  it("Taslağa uygula ve Reddet sunucuya gider", async () => {
    const r = await ac("#/tasarim-dili/ogren");
    await waitFor(() => satirlar().length === 2);
    await click(dugme("Taslağa uygula", sag())!);
    const apply = await waitFor(() => calls.find((c) => c.url === "/api/learn/proposals/p1/apply"));
    expect(apply.method).toBe("POST");
    await waitFor(() => document.body.textContent?.includes("Öneri taslağa uygulandı"));

    await click(dugme("Reddet", sag())!);
    const patch = await waitFor(() => calls.find((c) => c.method === "PATCH" && c.url === "/api/learn/proposals/p1"));
    expect(patch.body).toEqual({ status: "rejected" });
    await r.unmount();
  });

  it("şablon önerisi: eski ve yeni yazı merkezi; uygulanan öneride Geri al", async () => {
    const r = await ac("#/tasarim-dili/ogren");
    await waitFor(() => satirlar().length === 2);
    await click(satirlar().find((b) => b.textContent?.includes("Second open"))!);
    expect(sag().textContent).toContain("Şablon A15: yazı merkezi");
    expect(dugme("Uygula", sag())).toBeDefined();

    await click(document.querySelector<HTMLElement>('.tz-pnl--l [data-tab-id="accepted"]')!);
    await waitFor(() => satirlar().length === 1);
    expect(sag().textContent).toContain("Uygulandı");
    expect(dugme("Taslağa uygula")).toBeUndefined();
    await click(dugme("Geri al", sag())!);
    const revert = await waitFor(() => calls.find((c) => c.url === "/api/learn/proposals/p2/revert"));
    expect(revert.method).toBe("POST");
    await r.unmount();
  });

  it("Önerileri yeniden hesapla ücretsiz koşuyu başlatır", async () => {
    const r = await ac("#/tasarim-dili/ogren");
    await click(document.querySelector<HTMLElement>('[aria-label="Önerileri yeniden hesapla (ücretsiz)"]')!);
    const post = await waitFor(() => calls.find((c) => c.method === "POST" && c.url === "/api/languages/dil-1/learn/run"));
    expect(post.body).toEqual({ base: "published" });
    await r.unmount();
  });
});
