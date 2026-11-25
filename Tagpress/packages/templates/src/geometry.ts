import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type Box,
  type Point,
  type Profile,
  type Shape,
  type Template,
  type TemplateGeometry,
  effectiveCut,
  shapeBounds,
  shapeCutDiameter,
  templateImageBox,
} from "@tagpress/domain";
import { type Composite, compositeTemplate, decorationMask, meanLightness } from "./decoration.ts";
import {
  type Grid,
  and,
  andNot,
  countSet,
  dilate,
  erode,
  largestComponent,
  maskBounds,
  open,
  rasterizeShape,
  toBitmap,
} from "./raster.ts";
import { findLargestShape, toRatioShape } from "./suggest.ts";

/** Zemin bu L* (0..1) değerinin altındaysa koyu sayılır (eski sistemin eşiği: L* < 45). */
export const DARK_LIGHTNESS = 0.45;
/** Alandaki bundan ince şeritler atılır: kesim çapının oranı (yarıçap; şerit genişliği bunun 2 katı). */
const SLIVER = 0.0175;

export interface GeometryOptions {
  imagePath: string;
  /** Maske çözünürlüğü: tasarım px başına piksel. Varsayılan 2 (440 → 880). */
  scale?: number;
}

/**
 * `TemplateGeometry` + önizleme/düzenleyici için ek bilgiler. Motor yalnızca `TemplateGeometry` alanlarını kullanır.
 *
 * Birimler: px alanları tasarım alanı px'idir. `free`, `decoration` maskeleri `scale` kat çözünürlüktedir.
 * `rows[i]` maskenin i. piksel satırına (tasarım y = (i + 0,5) / scale) karşılık gelir; aralıklar tasarım px'idir.
 */
export interface BuiltGeometry extends TemplateGeometry {
  scale: number;
  /** Kurdele bandının alt sınırı (tasarım px, y). null = kurdele yok. */
  ribbonY: number | null;
  /** Alan şekli (tasarım px): elle çizilen ya da otomatik önerilen. */
  areaShape: Shape;
  /** Uygulanan dekor yöntemi. */
  decorationMethod: "alpha" | "color";
}

interface Analysis {
  composite: Composite;
  cut: Uint8Array;
  decoration: Uint8Array;
  method: "alpha" | "color";
}

// --- Önbellek (bellek kısıtlı: küçük, en son kullanılan kalır) ---
const ANALYSIS_LIMIT = 6;
const GEOMETRY_LIMIT = 12;
const analysisCache = new Map<string, Promise<Analysis>>();
const geometryCache = new Map<string, Promise<BuiltGeometry>>();

function remember<T>(cache: Map<string, Promise<T>>, limit: number, key: string, make: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const p = make();
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  while (cache.size > limit) cache.delete(cache.keys().next().value!);
  return p;
}

/** Önbellekleri boşaltır (testler ve şablon dosyası değiştiğinde). */
export function clearGeometryCache(): void {
  analysisCache.clear();
  geometryCache.clear();
}

/** Görselin tasarım alanındaki kutusu: şablona özel kutu; yoksa şablonun kendi kesiminin kutusu ya da profilin şablon kutusu. */
export function imageBoxOf(template: Template, profile: Profile): Box {
  return templateImageBox(template, profile);
}

/** Şablonun kesimi (tasarım px): kendi kesimi ya da profilin `output.cut`'ı (`effectiveCut`). */
const cutOf = (template: Template, profile: Profile): Shape => effectiveCut(template, profile).shape;
/** Kesim çapı (px): oranların (kesim payı, nefes, kurdele) tabanı. Kesimsiz şablonda profilin `cutDiameter`'ı ile aynı. */
const diameterOf = (template: Template, profile: Profile): number => shapeCutDiameter(cutOf(template, profile));

async function loadImage(imagePath: string): Promise<{ bytes: Buffer; hash: string }> {
  const bytes = await readFile(imagePath);
  return { bytes, hash: createHash("sha1").update(bytes).digest("hex") };
}

function analysisKey(hash: string, template: Template, profile: Profile, scale: number): string {
  return JSON.stringify({
    hash,
    box: imageBoxOf(template, profile),
    frame: profile.output.designFramePx,
    cut: cutOf(template, profile),
    deco: template.decoration,
    scale,
  });
}

async function analyze(template: Template, profile: Profile, bytes: Buffer, key: string, scale: number): Promise<Analysis> {
  return remember(analysisCache, ANALYSIS_LIMIT, key, async () => {
    const frame = profile.output.designFramePx;
    const composite = await compositeTemplate(bytes, imageBoxOf(template, profile), frame, scale);
    const cut = rasterizeShape(cutOf(template, profile), composite.grid, scale);
    const deco = decorationMask(composite, cut, {
      source: template.decoration.source,
      threshold: template.decoration.threshold,
      cutDiameterPx: diameterOf(template, profile) * scale,
    });
    return { composite, cut, decoration: deco.mask, method: deco.method };
  });
}

/** Kesim içi, kesim payı (edgeMargin) kadar içeride; kurdele bandının altı. Dekor nefes payı (breathing) kadar genişletilir. */
function baseMasks(a: Analysis, profile: Profile, template: Template, scale: number) {
  const g = a.composite.grid;
  const D = diameterOf(template, profile);
  const inner = erode(a.cut, g, profile.sizing.edgeMargin * D * scale);
  let ribbonY: number | null = null;
  if (template.ribbonTop > 0) {
    const top = shapeBounds(cutOf(template, profile)).y;
    ribbonY = top + template.ribbonTop * D;
    const limit = Math.min(g.h, Math.max(0, Math.round(ribbonY * scale)));
    inner.fill(0, 0, limit * g.w);
  }
  const blockedDeco = dilate(a.decoration, g, (template.decoration.dilatePx + profile.sizing.breathing * D) * scale);
  return { inner, ribbonY, blockedDeco };
}

/** Alanı temizler: ince şeritler atılır, en büyük parça kalır. */
function cleanArea(mask: Uint8Array, g: Grid, diameterPx: number, scale: number): Uint8Array {
  const r = SLIVER * diameterPx * scale;
  const opened = open(mask, g, r);
  // Alan şeritlerden ibaretse açma her şeyi silebilir: o zaman açılmamış hâli kullan.
  return largestComponent(countSet(opened) ? opened : mask, g);
}

/**
 * Otomatik alan önerisi: dekordan nefes payı, kesimden kesim payı kadar uzak serbest bölgeye sığan, merkeze (ya da
 * şablonun hedef merkezine) yakın en büyük elips ya da dikdörtgen. Oran birimiyle döner.
 */
export async function suggestArea(template: Template, profile: Profile, imagePath: string, scale = 2): Promise<Shape> {
  const { bytes, hash } = await loadImage(imagePath);
  const a = await analyze(template, profile, bytes, analysisKey(hash, template, profile, scale), scale);
  return suggestFromAnalysis(a, template, profile, scale);
}

function suggestFromAnalysis(a: Analysis, template: Template, profile: Profile, scale: number): Shape {
  const g = a.composite.grid;
  const { inner, blockedDeco } = baseMasks(a, profile, template, scale);
  const freeHi = cleanArea(andNot(inner, blockedDeco), g, diameterOf(template, profile), scale);
  // Arama tasarım px çözünürlüğünde (hız için): bir tasarım pikseli, altındaki bütün alt pikseller serbestse serbest.
  const F = Math.round(profile.output.designFramePx);
  const lo = new Uint8Array(F * F);
  const s = Math.max(1, Math.round(scale));
  for (let y = 0; y < F; y++) {
    for (let x = 0; x < F; x++) {
      let ok = 1;
      for (let dy = 0; dy < s && ok; dy++) for (let dx = 0; dx < s && ok; dx++) {
        const yy = y * s + dy, xx = x * s + dx;
        if (yy >= g.h || xx >= g.w || !freeHi[yy * g.w + xx]) ok = 0;
      }
      lo[y * F + x] = ok;
    }
  }
  const cb = shapeBounds(cutOf(template, profile));
  const attract: Point = template.textCenter
    ? { x: template.textCenter.x * profile.output.designFramePx, y: template.textCenter.y * profile.output.designFramePx }
    : { x: cb.x + cb.w / 2, y: cb.y + cb.h / 2 };
  const found = findLargestShape(lo, { w: F, h: F }, attract, Math.min(cb.w, cb.h) / 2);
  if (!found) throw new Error(`Şablon ${template.key}: dekordan uzak boş alan bulunamadı; yazı alanını elle çizin.`);
  return toRatioShape(found, profile.output.designFramePx);
}

/** Oran şeklini tasarım px'ine çevirir. */
function ratioToPx(shape: Shape, F: number): Shape {
  switch (shape.kind) {
    case "circle":
      return { ...shape, cx: shape.cx * F, cy: shape.cy * F, r: shape.r * F };
    case "ellipse":
      return { ...shape, cx: shape.cx * F, cy: shape.cy * F, rx: shape.rx * F, ry: shape.ry * F };
    case "rect":
      return { ...shape, x: shape.x * F, y: shape.y * F, w: shape.w * F, h: shape.h * F, radius: (shape.radius ?? 0) * F };
    case "polygon":
      return { ...shape, points: shape.points.map((p) => ({ x: p.x * F, y: p.y * F })) };
  }
}

/** Maske içindeki en yakın dolu pikselin merkezi (tasarım px). */
function nearestInside(mask: Uint8Array, g: Grid, scale: number, p: Point): Point {
  const px = p.x * scale, py = p.y * scale;
  const xi = Math.floor(px), yi = Math.floor(py);
  if (xi >= 0 && yi >= 0 && xi < g.w && yi < g.h && mask[yi * g.w + xi]) return p;
  let best = Infinity, bx = 0, by = 0;
  for (let y = 0; y < g.h; y++) {
    const row = y * g.w;
    const dy = y + 0.5 - py;
    if (dy * dy >= best) continue;
    for (let x = 0; x < g.w; x++) {
      if (!mask[row + x]) continue;
      const dx = x + 0.5 - px;
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; bx = x; by = y; }
    }
  }
  return { x: (bx + 0.5) / scale, y: (by + 0.5) / scale };
}

function centroid(mask: Uint8Array, g: Grid, scale: number): Point {
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      if (!mask[y * g.w + x]) continue;
      sx += x + 0.5;
      sy += y + 0.5;
      n++;
    }
  }
  return { x: sx / n / scale, y: sy / n / scale };
}

/**
 * Şablon geometrisini kurar. Aynı görsel + aynı şablon ayarları + aynı profil çıktı ayarlarıyla ikinci çağrı
 * önbellekten gelir.
 */
export async function buildGeometry(template: Template, profile: Profile, opts: GeometryOptions): Promise<BuiltGeometry> {
  const scale = opts.scale ?? 2;
  const { bytes, hash } = await loadImage(opts.imagePath);
  const aKey = analysisKey(hash, template, profile, scale);
  const gKey = JSON.stringify({
    aKey,
    cutMm: template.cut,
    area: template.area,
    ribbonTop: template.ribbonTop,
    textCenter: template.textCenter,
    ignore: template.ignoreDecorationInArea,
    breathing: profile.sizing.breathing,
    edgeMargin: profile.sizing.edgeMargin,
    key: template.key,
    imagePath: opts.imagePath,
  });
  return remember(geometryCache, GEOMETRY_LIMIT, gKey, async () => {
    const a = await analyze(template, profile, bytes, aKey, scale);
    const g = a.composite.grid;
    const F = profile.output.designFramePx;
    const manual = template.area.mode === "manual";
    const areaRatio = template.area.mode === "manual" ? template.area.shape : suggestFromAnalysis(a, template, profile, scale);
    const areaShape = ratioToPx(areaRatio, F);
    const areaMask = rasterizeShape(areaShape, g, scale);

    const { inner, ribbonY, blockedDeco } = baseMasks(a, profile, template, scale);
    const unrestricted = manual && template.ignoreDecorationInArea;
    let free = and(inner, areaMask);
    if (!unrestricted) free = andNot(free, blockedDeco);
    free = cleanArea(free, g, diameterOf(template, profile), scale);
    const fb = maskBounds(free, g);
    if (!fb) {
      throw new Error(
        unrestricted
          ? `Şablon ${template.key}: çizilen yazı alanı kesimin güvenli iç kısmında boş kaldı (alanı büyütün ya da kurdele payını azaltın).`
          : `Şablon ${template.key}: yazı alanında dekordan uzak boşluk kalmadı (alanı büyütün, kurdele payını azaltın ya da "alandaki dekoru yok say"ı açın).`,
      );
    }

    // Elle çizilen alanın tamamına yazılabiliyorsa alan içindeki dekor çarpışma sayılmaz.
    const decoration = unrestricted ? andNot(a.decoration, areaMask) : a.decoration.slice();

    const rows: Array<Array<[number, number]>> = [];
    for (let y = 0; y < g.h; y++) {
      const spans: Array<[number, number]> = [];
      let start = -1;
      for (let x = 0; x <= g.w; x++) {
        const on = x < g.w && free[y * g.w + x] === 1;
        if (on && start < 0) start = x;
        if (!on && start >= 0) {
          spans.push([start / scale, x / scale]);
          start = -1;
        }
      }
      rows.push(spans);
    }

    const target = template.textCenter
      ? nearestInside(free, g, scale, { x: template.textCenter.x * F, y: template.textCenter.y * F })
      : nearestInside(free, g, scale, centroid(free, g, scale));
    const luminance = Math.round(meanLightness(a.composite, free) * 1000) / 1000;

    const eff = effectiveCut(template, profile);
    const geometry: BuiltGeometry = {
      key: template.key,
      framePx: F,
      cut: eff.shape,
      mmPerPx: eff.mmPerPx,
      free: toBitmap(free, g, scale),
      decoration: toBitmap(decoration, g, scale),
      rows,
      areaBounds: { x: fb.x / scale, y: fb.y / scale, w: fb.w / scale, h: fb.h / scale },
      target,
      manualArea: manual,
      background: { luminance, dark: luminance < DARK_LIGHTNESS },
      imagePath: opts.imagePath,
      templateBox: imageBoxOf(template, profile),
      scale,
      ribbonY,
      areaShape,
      decorationMethod: a.method,
    };
    return geometry;
  });
}
