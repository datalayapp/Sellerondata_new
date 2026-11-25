import { existsSync } from "node:fs";
import sharp, { type OverlayOptions } from "sharp";
import type { LayoutResult, PlacedLine, Profile, TemplateGeometry } from "@tagpress/domain";
import { type FontRegistry, runToSvg, shapeRun, strokeGroupAttrs, svgDocument } from "@tagpress/typeset";

/**
 * render: yerleşim sonucunu SVG/PNG'ye çevirir. Run konumları sonuçtaki satır başından şekillendirme ile yeniden
 * hesaplanır (şekillendirme belirlenimci; motorla birebir aynı).
 */

export interface RenderOptions {
  /** Tasarım alanı → görsel çarpanı (ör. 2 → 880 px). */
  scale?: number;
  /** Kontur hizası (profilden). Varsayılan: dışa. */
  strokeAlign?: "outside" | "center";
  profile?: Profile;
}

/** Satırın etkin konturu: satırın kendi değeri (hafif düzeltme), yoksa yerleşiminki. */
export function lineStrokePx(result: LayoutResult, line: PlacedLine): number {
  return line.strokePx ?? result.strokePx;
}

/** Yazı katmanının SVG öğeleri (tasarım alanı, `scale` uygulanmış). Her satır kendi konturuyla çizilir. */
export function layoutSvgBody(result: LayoutResult, fonts: FontRegistry, opts: RenderOptions = {}): string {
  const scale = opts.scale ?? 1;
  const align = opts.strokeAlign ?? opts.profile?.weight.align ?? "outside";
  let body = "";
  for (const line of result.lines) {
    const w = lineStrokePx(result, line);
    const stroke = w > 0 ? { widthPx: w, align } : null;
    let pen = line.x;
    line.runs.forEach((r, i) => {
      const shaped = shapeRun(fonts, r.text, { fontId: r.fontId, sizePx: r.sizePx, trackingEm: r.trackingEm });
      body += runToSvg(fonts, shaped, pen, line.baselineY - r.baselineShiftPx, { color: result.color, stroke, scale });
      pen += shaped.advance + (i < line.runs.length - 1 ? shaped.trackingPx : 0);
    });
  }
  return body;
}

/**
 * Yalnızca yazı katmanı, saydam SVG belgesi (viewBox = tasarım alanı). Her satır `<g data-line="i">` içindedir:
 * düzenleme katmanı bloğu ya da tek satırı istemcide transform ile taşıyabilir. Glifler yol (path) olarak çizilir.
 * Kontur GRUP özniteliğidir (genişlik 0 olsa da yazılır; `stroke`, `stroke-width`, `stroke-linejoin`,
 * `paint-order="stroke"`): istemci yalnızca `stroke-width`'i değiştirerek kalınlığı günceller
 * (domain `svgStrokeWidth`; dışa hizada 2× genişlik). `data-stroke-px`: satırın konturu (tasarım px).
 */
export function textLayerSvg(result: LayoutResult, fonts: FontRegistry, opts: RenderOptions & { framePx?: number } = {}): string {
  const size = opts.framePx ?? opts.profile?.output.designFramePx ?? 440;
  const align = opts.strokeAlign ?? opts.profile?.weight.align ?? "outside";
  let body = "";
  result.lines.forEach((line, li) => {
    const w = Math.max(0, lineStrokePx(result, line));
    let pen = line.x;
    let g = "";
    line.runs.forEach((r, i) => {
      const shaped = shapeRun(fonts, r.text, { fontId: r.fontId, sizePx: r.sizePx, trackingEm: r.trackingEm });
      // Yolların kendi konturu yok; gruptan miras alır (renkli emoji katmanları `stroke="none"`).
      g += runToSvg(fonts, shaped, pen, line.baselineY - r.baselineShiftPx, { color: result.color, stroke: null, scale: 1 });
      pen += shaped.advance + (i < line.runs.length - 1 ? shaped.trackingPx : 0);
    });
    body += `<g data-line="${li}" data-stroke-px="${Math.round(w * 100) / 100}"${strokeGroupAttrs({ widthPx: w, align }, result.color)}>${g}</g>`;
  });
  return svgDocument(size, size, body);
}

/** Saydam zeminde yalnızca yazı (PNG). */
export async function renderTextOnly(result: LayoutResult, fonts: FontRegistry, opts: RenderOptions & { framePx?: number } = {}): Promise<Buffer> {
  const scale = opts.scale ?? 1;
  const size = (opts.framePx ?? opts.profile?.output.designFramePx ?? 440) * scale;
  return sharp(Buffer.from(svgDocument(size, size, layoutSvgBody(result, fonts, opts)))).png().toBuffer();
}

/** Şablon görseli + yazı (PNG). Şablon görseli yoksa beyaz zemin. `showCut`: kesim çizgisini ince çizer. */
export async function renderPreview(
  result: LayoutResult,
  geometry: TemplateGeometry,
  fonts: FontRegistry,
  opts: RenderOptions & { background?: string; showCut?: boolean } = {},
): Promise<Buffer> {
  const scale = opts.scale ?? 1;
  const size = Math.round(geometry.framePx * scale);
  const layers: OverlayOptions[] = [];
  if (geometry.imagePath && existsSync(geometry.imagePath)) {
    const layer = await templateLayer(geometry.imagePath, geometry.templateBox, scale, size);
    if (layer) layers.push(layer);
  }
  let overlay = layoutSvgBody(result, fonts, opts);
  if (opts.showCut) overlay += cutOutline(geometry, scale);
  layers.push({ input: Buffer.from(svgDocument(size, size, overlay)), left: 0, top: 0 });
  return sharp({ create: { width: size, height: size, channels: 4, background: opts.background ?? "#ffffff" } })
    .composite(layers)
    .png()
    .toBuffer();
}

/**
 * Şablon görseli katmanı: görsel kutusuna (tasarım px) ölçeklenir. Kutu tasarım alanından taşıyorsa (ör. şablona
 * özel `imageBox` x < 0) taşan kısım kırpılır; sharp bindirmesi tuvalden büyük/dışarıda olamaz.
 */
export async function templateLayer(imagePath: string, box: { x: number; y: number; w: number; h: number }, scale: number, canvas: number): Promise<OverlayOptions | null> {
  const w = Math.max(1, Math.round(box.w * scale));
  const h = Math.max(1, Math.round(box.h * scale));
  const left = Math.round(box.x * scale);
  const top = Math.round(box.y * scale);
  const x0 = Math.max(0, -left);
  const y0 = Math.max(0, -top);
  const cw = Math.min(w - x0, canvas - Math.max(0, left));
  const ch = Math.min(h - y0, canvas - Math.max(0, top));
  if (cw <= 0 || ch <= 0) return null;
  let img = await sharp(imagePath).resize(w, h, { fit: "fill" }).png().toBuffer();
  if (x0 || y0 || cw < w || ch < h) img = await sharp(img).extract({ left: x0, top: y0, width: cw, height: ch }).png().toBuffer();
  return { input: img, left: Math.max(0, left), top: Math.max(0, top) };
}

function cutOutline(g: TemplateGeometry, s: number): string {
  const c = g.cut;
  const attrs = `fill="none" stroke="#e0457b" stroke-width="1" stroke-dasharray="4 3"`;
  switch (c.kind) {
    case "circle":
      return `<circle cx="${c.cx * s}" cy="${c.cy * s}" r="${c.r * s}" ${attrs}/>`;
    case "ellipse":
      return `<ellipse cx="${c.cx * s}" cy="${c.cy * s}" rx="${c.rx * s}" ry="${c.ry * s}" ${attrs}/>`;
    case "rect":
      return `<rect x="${c.x * s}" y="${c.y * s}" width="${c.w * s}" height="${c.h * s}" rx="${c.radius * s}" ${attrs}/>`;
    case "polygon":
      return `<polygon points="${c.points.map((p) => `${p.x * s},${p.y * s}`).join(" ")}" ${attrs}/>`;
  }
}
