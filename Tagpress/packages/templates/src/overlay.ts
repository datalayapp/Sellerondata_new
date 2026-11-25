import sharp from "sharp";
import type { TemplateGeometry } from "@tagpress/domain";
import { compositeTemplate } from "./decoration.ts";
import { rasterizeShape } from "./raster.ts";

export interface OverlayOptions {
  /** Çıktı çözünürlüğü (tasarım px başına piksel). Varsayılan: geometrinin maske ölçeği. */
  scale?: number;
  /** Kurdele bandının alt sınırı (tasarım px). `buildGeometry` sonucunda `ribbonY` olarak gelir. */
  ribbonY?: number | null;
  /** Hangi katmanlar çizilsin (varsayılan hepsi). */
  show?: { area?: boolean; decoration?: boolean; ribbon?: boolean; target?: boolean; cut?: boolean };
}

type RGBA = [number, number, number, number];
const AREA: RGBA = [34, 170, 85, 0.38];
const DECO: RGBA = [220, 38, 38, 0.5];
const RIBBON: RGBA = [250, 204, 21, 0.5];
const TARGET: RGBA = [20, 60, 200, 1];
const CUT: RGBA = [90, 90, 90, 0.9];

/**
 * Şablon düzenleyicisi için PNG: şablon + yazı alanı (yeşil, yarı saydam) + dekor (kırmızı) + kurdele bandı
 * (sarı) + hedef merkez (artı) + kesim çizgisi (gri).
 */
export async function renderOverlay(geometry: TemplateGeometry & { ribbonY?: number | null }, opts: OverlayOptions = {}): Promise<Buffer> {
  const S = opts.scale ?? geometry.free.scale;
  const show = { area: true, decoration: true, ribbon: true, target: true, cut: true, ...opts.show };
  const base = await compositeTemplate(geometry.imagePath, geometry.templateBox, geometry.framePx, S);
  const { w, h } = base.grid;
  const out = new Uint8Array(w * h * 3);
  out.set(base.rgb);

  const blend = (i: number, c: RGBA) => {
    const a = c[3];
    for (let k = 0; k < 3; k++) out[i * 3 + k] = Math.round(out[i * 3 + k]! * (1 - a) + c[k]! * a);
  };
  /** Maskeyi çıktı çözünürlüğünde örnekler (en yakın komşu). */
  const sample = (bm: TemplateGeometry["free"], x: number, y: number) => {
    const mx = Math.floor(((x + 0.5) / S) * bm.scale);
    const my = Math.floor(((y + 0.5) / S) * bm.scale);
    if (mx < 0 || my < 0 || mx >= bm.width || my >= bm.height) return 0;
    return bm.data[my * bm.width + mx]!;
  };

  const cutMask = rasterizeShape(geometry.cut, base.grid, S);
  const ribbonY = opts.ribbonY ?? (geometry as { ribbonY?: number | null }).ribbonY ?? null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const deco = show.decoration && sample(geometry.decoration, x, y);
      // Kurdele bandı dekorun olduğu yerde çizilmez: sarı + kırmızı karışıp turuncu/kırmızıya dönmesin.
      if (show.ribbon && ribbonY !== null && cutMask[i] && (y + 0.5) / S < ribbonY && !deco) blend(i, RIBBON);
      if (deco) blend(i, DECO);
      if (show.area && sample(geometry.free, x, y)) blend(i, AREA);
    }
  }
  if (show.cut) {
    // Kesim çizgisi: maskenin sınır pikselleri.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!cutMask[i]) continue;
        const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 || !cutMask[i - 1] || !cutMask[i + 1] || !cutMask[i - w] || !cutMask[i + w];
        if (edge) blend(i, CUT);
      }
    }
  }
  if (show.target) {
    const cx = Math.round(geometry.target.x * S), cy = Math.round(geometry.target.y * S);
    const arm = Math.round(10 * S), th = Math.max(1, Math.round(S / 2));
    for (let d = -arm; d <= arm; d++) {
      for (let t = -th; t <= th; t++) {
        for (const [x, y] of [[cx + d, cy + t], [cx + t, cy + d]] as const) {
          if (x >= 0 && y >= 0 && x < w && y < h) blend(y * w + x, TARGET);
        }
      }
    }
  }
  return sharp(Buffer.from(out.buffer, out.byteOffset, out.byteLength), { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}
