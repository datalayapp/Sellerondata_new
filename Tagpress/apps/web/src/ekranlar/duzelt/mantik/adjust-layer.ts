import type { Box, StrokeAlign, VariantAdjust } from "@tagpress/domain";
import { lineAdjustOf, lineStrokeAttrs, lineTransformAttr } from "./adjust-select.ts";

/**
 * Gömülü yazı katmanının (sunucunun SVG'si, `<g data-line="i">` satır grupları) satır dönüşümü ve kalınlığı.
 * Eski Düzelt penceresinden çıkarıldı; yeni ekran da aynı yolu kullanır. Blok dönüşümü dıştaki kapta uygulanır.
 */
type Layout = { ink: Box; origin?: { x: number; y: number }; strokePx?: number; strokeAlign?: StrokeAlign; lines: ReadonlyArray<{ ink: Box; strokePx?: number }> };

const STROKE_ATTRS = ["stroke", "stroke-width", "stroke-linejoin", "paint-order"] as const;

/**
 * Her satır grubuna `transform` ve (etkin kontur varsa) kontur özniteliklerini yazar. İlk geçişte grubun rengi
 * saklanır ve yolların kendi kontur öznitelikleri kalkar (kontur grup düzeyinden yönetilir); ana dolgudan farklı
 * renkteki katmanlar (renkli emoji parçaları gibi) konturlanmaz.
 */
export function applyLineAttrs(svg: SVGSVGElement | Element, layout: Layout, cur: VariantAdjust): void {
  svg.querySelectorAll<SVGGElement>("g[data-line]").forEach((g) => {
    const i = Number(g.dataset.line);
    const line = layout.lines[i];
    if (!line) return;
    g.setAttribute("transform", lineTransformAttr(line.ink, lineAdjustOf(cur, i)));
    if (!g.dataset.color) {
      const main = g.querySelector("path[fill]");
      g.dataset.color = g.getAttribute("stroke") ?? main?.getAttribute("stroke") ?? main?.getAttribute("fill") ?? "#000";
      g.querySelectorAll("path").forEach((p) => {
        STROKE_ATTRS.forEach((n) => p.removeAttribute(n));
        if (p.getAttribute("fill") !== main?.getAttribute("fill")) p.setAttribute("stroke", "none");
      });
    }
    const st = lineStrokeAttrs(layout, cur, i);
    if (st) {
      g.setAttribute("stroke", g.dataset.color);
      g.setAttribute("stroke-width", String(st.width));
      g.setAttribute("stroke-linejoin", "round");
      g.setAttribute("paint-order", "stroke");
    } else {
      STROKE_ATTRS.forEach((n) => g.removeAttribute(n));
    }
  });
}
