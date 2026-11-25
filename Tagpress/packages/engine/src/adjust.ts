import {
  type Box,
  type CenterAxis,
  type CenterPoints,
  type CenterTarget,
  type Issue,
  type LayoutResult,
  type Profile,
  type TemplateGeometry,
  type VariantAdjust,
  applyAdjustToLayout,
  boxCenter,
  centerAdjust as centerAdjustPure,
  issueMsg,
  ptToPx,
  shapeBounds,
} from "@tagpress/domain";
import { type FontRegistry, shapeRun } from "@tagpress/typeset";
import { issue } from "./compose.ts";
import { type CollisionReport, type PositionedRun, verifyRaster } from "./verify.ts";

/**
 * Hafif düzeltme (motor tarafı). Dönüşüm matematiği domain'dedir (`applyAdjustToLayout`, arayüz de kullanabilir);
 * burada uygulanmış yerleşimin raster denetimi ve geometriye göre ortalama vardır.
 */

/** Yerleşime düzeltmeyi uygular (saf; bkz. domain `applyAdjustToLayout`). */
export const applyAdjust = applyAdjustToLayout;

/**
 * Yerleşimin run'larını önizlemeyle birebir aynı biçimde konumlandırır (render.ts `layoutSvgBody` ile aynı kalem).
 * `strokeAlign` verilirse her run kendi satırının konturunu taşır (`line.strokePx ?? result.strokePx`).
 */
export function positionLayoutRuns(result: LayoutResult, fonts: FontRegistry, strokeAlign?: "outside" | "center"): PositionedRun[] {
  const out: PositionedRun[] = [];
  for (const line of result.lines) {
    let pen = line.x;
    const w = line.strokePx ?? result.strokePx;
    const stroke = strokeAlign ? (w > 0 ? { widthPx: w, align: strokeAlign } : null) : undefined;
    line.runs.forEach((r, i) => {
      const shaped = shapeRun(fonts, r.text, { fontId: r.fontId, sizePx: r.sizePx, trackingEm: r.trackingEm });
      out.push({ shaped, x: pen, baseline: line.baselineY - r.baselineShiftPx, ...(stroke !== undefined ? { stroke } : {}) });
      pen += shaped.advance + (i < line.runs.length - 1 ? shaped.trackingPx : 0);
    });
  }
  return out;
}

export interface PlacementCheck {
  report: CollisionReport;
  /** Yalnızca yerleşimden doğan sorunlar (`field: "adjust"`). */
  issues: Issue[];
  ms: number;
}

/**
 * (Düzeltilmiş) yerleşimin raster denetimi: kesim dışı mürekkep → hata, süslemeye değme → uyarı, okunurluk
 * sınırının altına inen satır → uyarı. Kaydetmeyi engellemez; sorun rozeti olarak gösterilir.
 */
export async function checkPlacement(result: LayoutResult, geometry: TemplateGeometry, fonts: FontRegistry, profile: Profile): Promise<PlacementCheck> {
  const t0 = performance.now();
  // Her satır kendi etkin konturuyla çizilir (kalınlaşan satır kesime/süslemeye değerse sorun düşer).
  const stroke = result.strokePx > 0 ? { widthPx: result.strokePx, align: profile.weight.align } : null;
  const report = await verifyRaster(fonts, geometry, positionLayoutRuns(result, fonts, profile.weight.align), stroke);
  const issues: Issue[] = [];
  if (report.outsideCutPx > 0)
    issues.push(issue("collision", "error", issueMsg("collision-cut"), "adjust"));
  if (!report.ok && report.outsideCutPx === 0)
    issues.push(issue("collision", "warning", issueMsg("collision-decoration"), "adjust"));
  const smallest = result.lines.length ? Math.min(...result.lines.map((l) => l.sizePx)) : 0;
  const readable = ptToPx(profile, profile.quality.readableMinPt);
  if (smallest > 0 && smallest < readable) {
    const pt = (smallest / ptToPx(profile, 1)).toFixed(1);
    issues.push(issue("text-too-small", "warning", issueMsg("text-too-small-adjust", { pt, min: profile.quality.readableMinPt }), "adjust"));
  }
  return { report, issues, ms: Math.round(performance.now() - t0) };
}

/** Geometriden ortalama hedefleri: hedef merkez (`target`), yazı alanı kutusunun merkezi, kesim kutusunun merkezi. */
export function centerPoints(g: Pick<TemplateGeometry, "target" | "areaBounds" | "cut">): CenterPoints {
  return { textCenter: { x: g.target.x, y: g.target.y }, area: boxCenter(g.areaBounds), cut: boxCenter(shapeBounds(g.cut)) };
}

/**
 * Mürekkep kutusunun merkezini hedefe oturtan düzeltme: varsayılan hedef şablonun hedef merkezi (`textCenter`,
 * şablonda yoksa geometri yazı alanından hesaplar), seçenek olarak yazı alanı ya da kesim merkezi.
 */
export function centerAdjust(
  layout: { ink: Box; lines: ReadonlyArray<{ ink: Box }> },
  geometry: Pick<TemplateGeometry, "target" | "areaBounds" | "cut">,
  opts: { axis: CenterAxis; target?: CenterTarget; adjust?: VariantAdjust | null },
): VariantAdjust {
  return centerAdjustPure(layout, centerPoints(geometry), opts.adjust ?? null, { axis: opts.axis, target: opts.target ?? "textCenter" });
}
