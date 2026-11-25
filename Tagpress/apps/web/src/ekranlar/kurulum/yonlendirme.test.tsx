// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { TezgahApp } from "../../tezgah/rotalar.tsx";
import { flush, mockFetch, render, waitFor } from "../../tezgah/test/render.tsx";

/** Açılışta `GET /api/org`: kurulum tamamlanmamışsa Kurulum'a gidilir (geçmişe yazmadan); diğer durumlarda yer korunur. */
const FEATURES = { registry: [], effective: {}, explicit: {} };
const org = (status: string) => ({
  org: { id: "org-1", name: "Atölye" },
  setup: { status, step: 1, answers: { labelTypes: [] }, completedAt: status === "completed" ? "2026-11-01T00:00:00Z" : null, skipped: false },
  features: FEATURES,
});

async function open(hash: string, orgBody?: unknown) {
  window.location.hash = hash;
  mockFetch({
    "/api/languages": { languages: [] },
    "/api/generate/status": { running: 0, queued: 0 },
    ...(orgBody ? { "/api/org": orgBody } : {}),
  });
  const r = await render(<TezgahApp />);
  await waitFor(() => document.querySelector(".tz-top"));
  await flush(4);
  return r;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("açılışta kurulum yönlendirmesi", () => {
  it.each(["pending", "in-progress"])("kurulum %s ise Kurulum açılır", async (status) => {
    const r = await open("#/uretim", org(status));
    await waitFor(() => window.location.hash === "#/kurulum");
    await waitFor(() => document.querySelector(".tz-app--full"));
    await r.unmount();
  });

  it("kurulum tamamsa yer korunur", async () => {
    const r = await open("#/ayarlar/dil", org("completed"));
    expect(window.location.hash).toBe("#/ayarlar/dil");
    await r.unmount();
  });

  it("firma okunamazsa (sunucu yok) yönlendirme yapılmaz", async () => {
    const r = await open("#/baski");
    expect(window.location.hash).toBe("#/baski");
    await r.unmount();
  });

  it("yalnız açılışta: sonra başka ekrana geçilirse yeniden yönlendirilmez", async () => {
    const r = await open("#/uretim", org("pending"));
    await waitFor(() => window.location.hash === "#/kurulum");
    window.location.hash = "#/ayarlar/dil";
    await flush(4);
    expect(window.location.hash).toBe("#/ayarlar/dil");
    await r.unmount();
  });
});
