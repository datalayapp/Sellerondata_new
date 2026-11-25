// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import { setTestLocale } from "../../../i18n/test.ts";
import { press, waitFor } from "../../../tezgah/test/render.tsx";
import { ac, kur, ref } from "../ornekler/test-veri.tsx";

const TRY = "/api/languages/dil-1/profile/try";
type Body = { samples: Array<{ id: string; referenceId?: string | null; text: string }>; profiles: Array<"draft" | "published">; mode: string };

let n = 0;
function tryHandler(_u: string, init?: RequestInit) {
  const body = JSON.parse(String(init?.body)) as Body;
  const id = `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`;
  const side = { previewUrl: `/api/trials/${id}/preview.png`, lines: ["Elif & Kerem", "14.06.2027"], sizesPx: [50, 20], issues: 0, issueList: [], costUsd: null, sameBreaksAsReference: null, sizeDiffVsReference: null };
  return { estimateUsd: 0, costUsd: 0, mode: "engine", results: [{ sampleId: body.samples[0]!.id, published: body.profiles.includes("published") ? side : null, draft: body.profiles.includes("draft") ? side : null }] };
}

let calls: ReturnType<typeof kur>;
beforeEach(() => {
  n = 0;
  calls = kur({ refs: [ref("r1", "Elif & Kerem 14.06.2027")], routes: { [TRY]: tryHandler, "/api/languages/dil-1/fonts": { files: [], missing: [] } } });
});
afterEach(() => {
  document.body.innerHTML = "";
  setTestLocale("tr");
});

const tries = () => calls.filter((c) => c.method === "POST" && c.url === TRY).map((c) => c.body as Body);

describe("Tasarım dili: Kurallar ortası canlı önizleme", () => {
  it("ilk örnekle ücretsiz motor önizlemesi; alan değişince taslak kaydedilir ve önizleme taslakla yenilenir", async () => {
    const r = await ac("#/tasarim-dili/kurallar/boyut");
    const first = await waitFor(() => tries()[0]);
    expect(first).toMatchObject({ mode: "engine", profiles: ["published"] });
    expect(first.samples[0]).toMatchObject({ referenceId: "r1", text: "Elif & Kerem 14.06.2027" });
    const img = await waitFor(() => document.querySelector<HTMLImageElement>('img[alt="Önizleme: Elif & Kerem 14.06.2027"]'));
    expect(img.getAttribute("src")).toBe("/api/trials/00000000-0000-0000-0000-000000000001/preview.png");
    expect(document.querySelector(".tz-cv-world")?.textContent).toContain("Şema");

    await press("ArrowUp", { target: document.querySelector<HTMLElement>('[data-field="sizing.fill"] [role=spinbutton]')! });
    await waitFor(() => calls.find((c) => c.method === "PUT" && c.url.endsWith("/profile/draft")));
    const second = await waitFor(() => tries().find((b) => b.profiles.includes("draft")));
    expect(second).toMatchObject({ mode: "engine", profiles: ["draft"] });
    await waitFor(() => document.querySelector('img[alt="Önizleme: Elif & Kerem 14.06.2027"]')?.getAttribute("src")?.includes("000000000002"));
    await r.unmount();
  });

  it("örnek seçici: kısa metin seçilince o metinle istenir", async () => {
    const r = await ac("#/tasarim-dili/kurallar/genel");
    await waitFor(() => tries()[0]);
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Önizlenen örnek"]')!;
    await act(async () => {
      select.value = "__metin__";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const free = await waitFor(() => tries().find((b) => b.samples[0]?.referenceId === null));
    expect(free.samples[0]?.text).toBe(i18n.t("designLanguage:rules.preview.sampleText"));
    await r.unmount();
  });
});
