// @vitest-environment happy-dom
import { errorText } from "@tagpress/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatUsd } from "../../../i18n/bicim.ts";
import { i18n } from "../../../i18n/index.ts";
import { setTestLocale } from "../../../i18n/test.ts";
import { click, flush, waitFor } from "../../../tezgah/test/render.tsx";
import { ac, denetle, DRAFT, dugme, gorsel, hataVer, kur, ref } from "../ornekler/test-veri.tsx";

const TRY = "/api/languages/dil-1/profile/try";
const R1 = ref("r1", "Elif & Kerem 14.06.2027");

type Body = { samples: Array<{ id: string; referenceId?: string | null; text: string }>; profiles: string[]; mode: string; dryRun?: boolean };

/** Sahte deneme ucu: tahminde 0,09 $; üretimde her örnek için iki yan. Taslak bir satır daha böler. */
function tryHandler(_u: string, init?: RequestInit) {
  const body = JSON.parse(String(init?.body)) as Body;
  if (body.dryRun) return { estimateUsd: 0.09, costUsd: 0, mode: body.mode, results: [] };
  const side = (id: string, lines: string[]) => ({ previewUrl: `/api/trials/${id}/preview.png`, lines, sizesPx: lines.map(() => 50), issues: 0, issueList: [], costUsd: null, sameBreaksAsReference: null, sizeDiffVsReference: null });
  return {
    estimateUsd: body.mode === "ai" ? 0.09 : 0,
    costUsd: body.mode === "ai" ? 0.08 : 0,
    mode: body.mode,
    results: body.samples.map((s, i) => ({ sampleId: s.id, published: side(`00000000-0000-0000-0000-00000000000${i}`, ["Elif & Kerem", "14.06.2027"]), draft: body.profiles.includes("draft") ? side(`10000000-0000-0000-0000-00000000000${i}`, ["Elif", "& Kerem", "14.06.2027"]) : null })),
  };
}

let calls: ReturnType<typeof kur>;
beforeEach(() => {
  localStorage.setItem("studio.dene.dil-1", JSON.stringify({ refIds: ["r1"], free: [{ id: "f1", text: "Grazie Giulia", templateKey: "B21" }] }));
  calls = kur({ draft: DRAFT, refs: [R1], routes: { [TRY]: tryHandler } });
});
afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  setTestLocale("tr");
});

const tries = () => calls.filter((c) => c.url.startsWith(TRY) && c.method === "POST");
const runs = () => tries().filter((c) => !(c.body as Body).dryRun);
const radio = (label: string) => [...document.querySelectorAll<HTMLElement>("[role=radio]")].find((b) => b.textContent?.trim() === label)!;

describe("Tasarım dili: Dene", () => {
  it("solda deneme kümesi; Motor denemesi onaysız çağrılır ve sonuçlar yan yana çizilir, farklar işaretli", async () => {
    const r = await ac("#/tasarim-dili/dene");
    const panel = document.querySelector(".tz-pnl--l")!;
    expect(panel.textContent).toContain("Deneme kümesi");
    expect(panel.textContent).toContain("Elif & Kerem 14.06.2027");
    expect(panel.textContent).toContain("Grazie Giulia");
    expect(tries()).toHaveLength(0);

    await click(dugme("Taslağı motorla dene")!);
    const post = await waitFor(() => runs()[0]);
    expect(document.querySelector("dialog")).toBeNull();
    expect(post.body).toMatchObject({ mode: "engine", profiles: ["published", "draft"] });
    expect((post.body as Body).samples.map((s) => [s.id, s.referenceId])).toEqual([
      ["ref:r1", "r1"],
      ["free:f1", null],
    ]);

    await waitFor(() => gorsel("Yayınlanmış: Elif & Kerem 14.06.2027"));
    expect(gorsel("Yayınlanmış: Elif & Kerem 14.06.2027")?.getAttribute("src")).toBe("/api/trials/00000000-0000-0000-0000-000000000000/preview.png");
    expect(gorsel("Taslak: Grazie Giulia")).not.toBeNull();
    const world = document.querySelector(".tz-cv-world")!;
    expect(world.textContent).toContain("Yayınlanmış · sürüm 3");
    expect(world.textContent).toContain("Son hâl · örnek");
    expect(world.textContent).toContain("Satır bölmesi farklı");
    expect(document.querySelectorAll(".tz-selbox").length).toBe(2);
    expect(document.body.textContent).toContain("Motorla üretildi (ücretsiz).");
    expect(denetle("dene")).toEqual({ label: "dene", primary: 1, unnamed: [] });
    await r.unmount();
  });

  it("AI'da önce tahmini maliyet yazar; onaylanmadan çağrı gitmez, onayla AI denemesi gider", async () => {
    const r = await ac("#/tasarim-dili/dene");
    await click(radio("AI · ücretli"));
    const dry = await waitFor(() => tries().find((c) => (c.body as Body).dryRun));
    expect(dry.body).toMatchObject({ dryRun: true, mode: "ai" });
    await waitFor(() => document.body.textContent?.includes(formatUsd(0.09, { approx: true })));
    expect(document.querySelector(".td-dn-maliyet")?.textContent).toContain("2 örnek, iki profille");

    await click(dugme("Taslağı AI ile dene")!);
    let dialog = await waitFor(() => document.querySelector("dialog"));
    expect(dialog.textContent).toContain("AI ile denensin mi?");
    expect(dialog.textContent).toContain(formatUsd(0.09, { approx: true }));
    expect(runs()).toHaveLength(0);
    await click(dugme(i18n.t("common:actions.cancel"), dialog)!);
    await flush(2);
    expect(runs()).toHaveLength(0);

    await click(dugme("Taslağı AI ile dene")!);
    dialog = await waitFor(() => document.querySelector("dialog"));
    await click(dugme("Dene", dialog)!);
    const post = await waitFor(() => runs()[0]);
    expect(post.body).toMatchObject({ mode: "ai", profiles: ["published", "draft"] });
    expect((post.body as Body).dryRun).toBeUndefined();
    expect((post.body as Body).samples).toHaveLength(2);
    await waitFor(() => document.body.textContent?.includes("AI ile üretildi"));
    await r.unmount();
  });

  it("anahtar yoksa (409 missing-key) Bağlantılar'a yönlendiren bildirim", async () => {
    const params = { providerName: "Anthropic" };
    hataVer(TRY, 409, { error: errorText("missing-key", params), code: "missing-key", params, provider: "anthropic" }, (init) => !(JSON.parse(String(init?.body)) as Body).dryRun);
    const r = await ac("#/tasarim-dili/dene");
    await click(radio("AI · ücretli"));
    await click(dugme("Taslağı AI ile dene")!);
    const dialog = await waitFor(() => document.querySelector("dialog"));
    await click(dugme("Dene", dialog)!);
    const note = await waitFor(() => document.querySelector(".tz-pnl--l .tz-issue--warn"));
    expect(note.textContent).toContain(i18n.t("errors:missing-key", params));
    await click(dugme(i18n.t("common:actions.goToConnections"), note)!);
    expect(window.location.hash).toBe("#/ayarlar/baglantilar");
    await r.unmount();
  });

  it("serbest metin eklenir, kümeden çıkarılır; küme tarayıcıda saklanır", async () => {
    const r = await ac("#/tasarim-dili/dene");
    const input = document.querySelector<HTMLInputElement>('.tz-pnl--l input[aria-label="Serbest metin"]')!;
    const { act } = await import("react");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Mila 1 yasinda");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(dugme("Ekle")!);
    expect(document.querySelector(".tz-pnl--l")?.textContent).toContain("Mila 1 yasinda");
    await click(document.querySelector<HTMLElement>('[aria-label="Kümeden çıkar: Grazie Giulia"]')!);
    expect(document.querySelector(".tz-pnl--l")?.textContent).not.toContain("Grazie Giulia");
    const saved = JSON.parse(localStorage.getItem("studio.dene.dil-1") ?? "{}") as { free: Array<{ text: string }> };
    expect(saved.free.map((f) => f.text)).toEqual(["Mila 1 yasinda"]);
    await r.unmount();
  });
});
