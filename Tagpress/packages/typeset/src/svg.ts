import type { FontRegistry } from "./registry.ts";
import { colorLayers } from "./color.ts";
import { glyphCommands, type ShapedRun } from "./shape.ts";

export { colorLayers } from "./color.ts";

/**
 * SVG çıktısı. Glif konturları tek bir path verisine çevrilir; renkli glifler (emoji, COLR v0) katman
 * katman kendi renkleriyle çizilir ve kontur almaz (kalınlaştırma harf içindir).
 */

export interface SvgStroke {
  widthPx: number;
  align: "outside" | "center";
}

export interface SvgRunOptions {
  color: string;
  stroke?: SvgStroke | null;
  /** Bütün koordinatları çarpan (ör. 2 → 880 px'lik görsel). */
  scale?: number;
  /** true: renkli glifler de düz renkle (maske için). */
  monochrome?: boolean;
}

const fmt = (v: number) => (Math.round(v * 100) / 100).toString();

function glyphPath(reg: FontRegistry, fontId: string, gid: number, ox: number, oy: number, s: number): string {
  let d = "";
  for (const c of glyphCommands(reg, fontId, gid)) {
    const v = c.values;
    d += c.type;
    for (let i = 0; i < v.length; i += 2) d += `${i ? " " : ""}${fmt(ox + v[i]! * s)} ${fmt(oy - v[i + 1]! * s)}`;
  }
  return d;
}

/**
 * Run'ın düz (tek renkli) path verisi. `skipColor`: renkli glifleri atla (onlar katman katman ayrıca çizilir).
 * Atlanmazsa (maske, doğrulama) renkli glif katmanlarının birleşimi olarak çizilir: COLR fontlarında temel glifin
 * kendi çizimi boştur, yalnız katmanlar mürekkep taşır.
 */
export function runPathData(reg: FontRegistry, run: ShapedRun, x: number, baseline: number, scale = 1, skipColor = false): string {
  const s = (run.sizePx / reg.get(run.fontId).upem) * scale;
  let d = "";
  for (const g of run.glyphs) {
    const layers = colorLayers(reg, run.fontId, g.gid);
    if (layers && skipColor) continue;
    const ox = (x + g.x) * scale;
    const oy = (baseline + g.y) * scale;
    if (layers) for (const l of layers) d += glyphPath(reg, run.fontId, l.gid, ox, oy, s);
    else d += glyphPath(reg, run.fontId, g.gid, ox, oy, s);
  }
  return d;
}

function strokeAttrs(stroke: SvgStroke | null | undefined, color: string, scale: number): string {
  if (!stroke || !(stroke.widthPx > 0)) return "";
  return strokeGroupAttrs(stroke, color, scale);
}

/**
 * Kontur öznitelikleri (genişlik 0 olsa da yazılır; yazı katmanında grup düzeyinde kullanılır, istemci yalnızca
 * `stroke-width`'i değiştirir). Dışa hiza: 2× genişlikte kontur, `paint-order` ile dolgunun altında → dışa taşma
 * tam genişlik kadar. Ortada hiza: 1×.
 */
export function strokeGroupAttrs(stroke: SvgStroke, color: string, scale = 1): string {
  const width = Math.max(0, stroke.widthPx);
  const w = (stroke.align === "outside" ? 2 * width : width) * scale;
  return ` stroke="${color}" stroke-width="${fmt(w)}" stroke-linejoin="round" paint-order="stroke"`;
}

/** Konumlu run'ı SVG öğelerine çevirir (x: run başlangıcı, baseline: taban çizgisi, tasarım px). */
export function runToSvg(reg: FontRegistry, run: ShapedRun, x: number, baseline: number, opts: SvgRunOptions): string {
  const scale = opts.scale ?? 1;
  const mono = opts.monochrome ?? false;
  const d = runPathData(reg, run, x, baseline, scale, !mono);
  let out = d ? `<path d="${d}" fill="${opts.color}"${strokeAttrs(opts.stroke, opts.color, scale)}/>` : "";
  if (!mono && reg.get(run.fontId).color) {
    const s = (run.sizePx / reg.get(run.fontId).upem) * scale;
    for (const g of run.glyphs) {
      const layers = colorLayers(reg, run.fontId, g.gid);
      if (!layers) continue;
      const ox = (x + g.x) * scale;
      const oy = (baseline + g.y) * scale;
      for (const layer of layers) {
        const ld = glyphPath(reg, run.fontId, layer.gid, ox, oy, s);
        // stroke="none": üst gruptan kontur miras almasın (yazı katmanı SVG'sinde kontur grup özniteliğidir).
        if (ld) out += `<path d="${ld}" fill="${layer.color ?? opts.color}" stroke="none"/>`;
      }
    }
  }
  return out;
}

export function svgDocument(width: number, height: number, body: string, background?: string): string {
  const bg = background ? `<rect width="100%" height="100%" fill="${background}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${Math.round(height)}" viewBox="0 0 ${Math.round(width)} ${Math.round(height)}">${bg}${body}</svg>`;
}
