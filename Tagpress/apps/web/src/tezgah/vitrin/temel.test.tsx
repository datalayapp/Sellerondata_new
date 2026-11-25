// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import "../../i18n/test.ts";
import { mockFetch, render } from "../test/render.tsx";
import TemelVitrin from "./temel.tsx";

describe("temel vitrin", () => {
  it("çizilir ve her ikon düğmesinin erişilebilir adı vardır", async () => {
    mockFetch({ "/api/languages": { languages: [] }, "/api/generate/status": { running: 0, queued: 0 } });
    const r = await render(<TemelVitrin />);
    const icons = [...r.container.querySelectorAll<HTMLButtonElement>(".tz-ib")];
    expect(icons.length).toBeGreaterThan(8);
    const unnamed = icons.filter((b) => !(b.getAttribute("aria-label") ?? "").trim());
    expect(unnamed).toHaveLength(0);
    // bütün bölümler çizildi
    expect(r.container.querySelectorAll(".tz-vitrin-sec").length).toBe(7);
    await r.unmount();
  });
});
