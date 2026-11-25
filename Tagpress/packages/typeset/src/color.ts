import type { FontRegistry } from "./registry.ts";

/**
 * Renkli glif katmanları (COLR v0: Twemoji, Segoe UI Emoji). Renkli glifin temel çizimi boştur; mürekkep, kutu ve
 * çizim katmanlardan gelir (`shape.ts` kutusu, `svg.ts` çizimi, baskı PDF'i aynı katmanları kullanır).
 */

export interface Layer {
  gid: number;
  /** Katman rengi; null = yazı rengi (paletin "ön plan" girdisi). */
  color: string | null;
}

const layerCache = new Map<string, Layer[] | null>();

/** Renkli glifin katmanları (COLR v0); renkli değilse null. */
export function colorLayers(reg: FontRegistry, fontId: string, gid: number): Layer[] | null {
  const face = reg.get(fontId);
  if (!face.color) return null;
  const key = `${face.source}#${gid}`;
  if (layerCache.has(key)) return layerCache.get(key)!;
  const hbFace = reg.hbFace(fontId);
  const layers = hbFace.getGlyphColorLayers(gid);
  let out: Layer[] | null = null;
  if (layers.length) {
    const palette = hbFace.getColorPalettes()[0]?.colors ?? [];
    out = layers.map((l) => {
      const c = l.colorIndex === undefined ? undefined : palette[l.colorIndex];
      return { gid: l.glyph, color: c ? `rgba(${c.red},${c.green},${c.blue},${Math.round((c.alpha / 255) * 1000) / 1000})` : null };
    });
  }
  layerCache.set(key, out);
  return out;
}
