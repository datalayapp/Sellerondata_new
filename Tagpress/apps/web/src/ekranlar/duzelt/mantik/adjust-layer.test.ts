// @vitest-environment happy-dom
import { IDENTITY_ADJUST, type VariantAdjust } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import { applyLineAttrs } from "./adjust-layer.ts";

const LAYOUT = {
  ink: { x: 0, y: 0, w: 100, h: 40 },
  strokePx: 0,
  strokeAlign: "outside" as const,
  lines: [
    { ink: { x: 0, y: 0, w: 100, h: 20 }, strokePx: 0 },
    { ink: { x: 0, y: 20, w: 100, h: 20 }, strokePx: 0 },
  ],
};

function svg(): SVGSVGElement {
  const host = document.createElement("div");
  host.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg"><g data-line="0"><path fill="#123" stroke="#123" stroke-width="2" d="M0 0"/><path fill="#f00" d="M1 1"/></g><g data-line="1" stroke="#456"><path fill="#456" d="M0 0"/></g><g data-line="7"><path fill="#000" d="M0 0"/></g></svg>';
  return host.querySelector("svg")!;
}

describe("yazı katmanının satır öznitelikleri", () => {
  it("dönüşüm yazılır; yolların konturu kalkar, ana dolgudan farklı renkli katman konturlanmaz", () => {
    const s = svg();
    applyLineAttrs(s, LAYOUT, { ...IDENTITY_ADJUST, lines: [{ index: 1, dx: 4, dy: -2, scale: 1 }] });
    const [g0, g1, g7] = [...s.querySelectorAll<SVGGElement>("g[data-line]")];
    expect(g0!.getAttribute("transform")).toBe("matrix(1 0 0 1 0 0)");
    expect(g1!.getAttribute("transform")).toBe("matrix(1 0 0 1 4 -2)");
    expect(g7!.hasAttribute("transform")).toBe(false); // yerleşimde olmayan satır
    const [main, color] = [...g0!.querySelectorAll("path")];
    expect(main!.hasAttribute("stroke")).toBe(false);
    expect(main!.hasAttribute("stroke-width")).toBe(false);
    expect(color!.getAttribute("stroke")).toBe("none");
    expect(g0!.dataset.color).toBe("#123");
    expect(g1!.dataset.color).toBe("#456");
    // Kalınlık yok: grupta kontur özniteliği yok.
    expect(g0!.hasAttribute("stroke")).toBe(false);
  });

  it("kalınlık artınca grup rengiyle kontur; geri alınınca kalkar", () => {
    const s = svg();
    const thick: VariantAdjust = { ...IDENTITY_ADJUST, strokePx: 1 };
    applyLineAttrs(s, LAYOUT, thick);
    const g0 = s.querySelector<SVGGElement>('g[data-line="0"]')!;
    expect(g0.getAttribute("stroke")).toBe("#123");
    expect(Number(g0.getAttribute("stroke-width"))).toBeGreaterThan(0);
    expect(g0.getAttribute("stroke-linejoin")).toBe("round");
    expect(g0.getAttribute("paint-order")).toBe("stroke");
    applyLineAttrs(s, LAYOUT, IDENTITY_ADJUST);
    expect(g0.hasAttribute("stroke")).toBe(false);
    expect(g0.hasAttribute("stroke-width")).toBe(false);
  });
});
