// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "../test/render.tsx";
import { Icon, ICON_NAMES } from "./Icon.tsx";

describe("ikonlar", () => {
  it("75 adın hepsi süs olarak çizilir (lucide ya da özel çizim)", async () => {
    expect(ICON_NAMES.length).toBe(75);
    const r = await render(
      <div>
        {ICON_NAMES.map((n) => (
          <Icon key={n} name={n} size={15} />
        ))}
      </div>,
      { providers: false },
    );
    const svgs = [...r.container.querySelectorAll("svg")];
    expect(svgs.map((s) => s.getAttribute("data-icon"))).toEqual(ICON_NAMES);
    for (const s of svgs) {
      expect(s.getAttribute("aria-hidden"), s.getAttribute("data-icon") ?? "").toBe("true");
      expect(s.getAttribute("width")).toBe("15");
      expect(s.innerHTML.length).toBeGreaterThan(10);
    }
    await r.unmount();
  });
});
