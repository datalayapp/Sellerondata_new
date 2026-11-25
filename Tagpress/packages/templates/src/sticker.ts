import { type Box, type Profile, type Shape, type StickerSheet, type TemplateGeometry, cutDiameter, shapeBounds } from "@tagpress/domain";
import { type Grid, and, erode, maskBounds, rasterizeShape, toBitmap } from "./raster.ts";

/**
 * Sticker sayfası geometrisi: şablon görseli ve dekor YOK (zeminsiz yazı). Tasarım, etiketlerle aynı tasarım
 * alanında (profilin kesim şekli içinde) yapılır; yazı alanı sayfanın yazı kutusunun (maxW × maxH) en/boy
 * oranındadır: yuvarlak sayfada kesimin ortasında bir daire, dikdörtgen sayfada aynı oranda bir dikdörtgen.
 * İkisinde de çap/köşegen kesim çapının %90'ı. Figma eklentisi yazıyı sayfadaki yuvaya (maxW × maxH) ölçekler.
 */
export const STICKER_AREA_RATIO = 0.9;

/** Sticker yazı alanı (tasarım px). */
export function stickerAreaShape(sheet: Pick<StickerSheet, "shape" | "maxW" | "maxH">, profile: Profile): Shape {
  const cb = shapeBounds(profile.output.cut);
  const cx = cb.x + cb.w / 2;
  const cy = cb.y + cb.h / 2;
  const d = cutDiameter(profile) * STICKER_AREA_RATIO;
  if (sheet.shape === "circle") return { kind: "circle", cx, cy, r: d / 2 };
  const aspect = sheet.maxW / sheet.maxH;
  const diag = Math.sqrt(aspect * aspect + 1);
  const w = (d * aspect) / diag;
  const h = d / diag;
  return { kind: "rect", x: cx - w / 2, y: cy - h / 2, w, h, radius: 0 };
}

export function buildStickerGeometry(sheet: StickerSheet, profile: Profile, opts: { scale?: number } = {}): TemplateGeometry {
  const scale = opts.scale ?? 2;
  const F = profile.output.designFramePx;
  const W = Math.round(F * scale);
  const g: Grid = { w: W, h: W };
  const D = cutDiameter(profile);
  // Kesimden kesim payı kadar içeride ∧ sticker yazı alanı.
  const cut = rasterizeShape(profile.output.cut, g, scale);
  const inner = erode(cut, g, profile.sizing.edgeMargin * D * scale);
  const area = stickerAreaShape(sheet, profile);
  const free = and(inner, rasterizeShape(area, g, scale));
  const fb = maskBounds(free, g);
  if (!fb) throw new Error(`Sticker sayfası ${sheet.id}: yazı alanı boş kaldı (kesim payını ya da sayfa ölçülerini kontrol edin).`);
  const rows: Array<Array<[number, number]>> = [];
  for (let y = 0; y < W; y++) {
    const spans: Array<[number, number]> = [];
    let start = -1;
    for (let x = 0; x <= W; x++) {
      const on = x < W && free[y * W + x] === 1;
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        spans.push([start / scale, x / scale]);
        start = -1;
      }
    }
    rows.push(spans);
  }
  const areaBounds: Box = { x: fb.x / scale, y: fb.y / scale, w: fb.w / scale, h: fb.h / scale };
  return {
    key: `sticker-${sheet.id}`,
    framePx: F,
    cut: profile.output.cut,
    free: toBitmap(free, g, scale),
    // Dekor yok: boş maske.
    decoration: toBitmap(new Uint8Array(W * W), g, scale),
    rows,
    areaBounds,
    target: { x: areaBounds.x + areaBounds.w / 2, y: areaBounds.y + areaBounds.h / 2 },
    manualArea: true,
    background: { luminance: 1, dark: false },
    imagePath: "",
    templateBox: profile.output.templateBox,
  };
}
