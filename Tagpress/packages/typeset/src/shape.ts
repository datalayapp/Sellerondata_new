import * as hb from "harfbuzzjs";
import { colorLayers } from "./color.ts";
import type { FontRegistry } from "./registry.ts";

/**
 * Şekillendirme (harfbuzz: kerning, ligatür, aksan yerleşimi) ve mürekkep ölçüsü.
 * Koordinatlar: run başlangıcı x = 0, taban çizgisi y = 0, y AŞAĞI pozitif (SVG gibi).
 * Şekillendirme birim boyutta bir kez yapılır ve önbelleğe alınır; her punto için yalnızca ölçeklenir
 * (ipucu/hinting yok, dolayısıyla ölçek doğrusal).
 */

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ShapedGlyph {
  gid: number;
  /** Glif orijini (px), run başlangıcına göre. */
  x: number;
  /** Taban çizgisine göre dikey kayma (px, aşağı pozitif). */
  y: number;
  advance: number;
  /** Kaynak metindeki UTF-16 konumu. */
  cluster: number;
  /** Glifin mürekkep kutusu (px, run koordinatı); boş glifte null. */
  ink: Box | null;
}

export interface ShapedRun {
  fontId: string;
  text: string;
  sizePx: number;
  /** Her glif arasına eklenen harf aralığı (px). */
  trackingPx: number;
  glyphs: ShapedGlyph[];
  /** Toplam ilerleme (son glifin ardındaki harf aralığı hariç). */
  advance: number;
  /** Bütün mürekkebin kutusu; yalnızca boşluksa null. */
  ink: Box | null;
  /** Fontta karşılığı olmayan (.notdef) glif sayısı. */
  notdef: number;
}

export interface ShapeOptions {
  fontId: string;
  sizePx: number;
  /** Harf aralığı (em). Fontun `lockTracking` kilidi varsa yok sayılır. */
  trackingEm?: number;
  /** BCP-47 dil etiketi (yerelleştirilmiş glif biçimleri için). */
  language?: string;
}

interface UnitGlyph {
  gid: number;
  x: number;
  y: number;
  advance: number;
  cluster: number;
}

/** Birim boyutta (1 em = 1) şekillendirilmiş metin; harf aralığı hariç. */
interface UnitRun {
  glyphs: UnitGlyph[];
}

const MAX_CACHE = 20000;
const unitCache = new Map<string, UnitRun>();
const bboxCache = new Map<string, Box | null>();
const pathCache = new Map<string, Array<{ type: string; values: number[] }>>();

function shapeUnit(reg: FontRegistry, text: string, fontId: string, language?: string): UnitRun {
  const key = `${reg.get(fontId).source}\u0000${language ?? ""}\u0000${text}`;
  const hit = unitCache.get(key);
  if (hit) return hit;
  const font = reg.hbFont(fontId);
  const upem = reg.get(fontId).upem;
  const buffer = new hb.Buffer();
  buffer.addText(text);
  buffer.guessSegmentProperties();
  if (language) buffer.setLanguage(language);
  hb.shape(font, buffer);
  let pen = 0;
  const glyphs: UnitGlyph[] = buffer.getGlyphInfosAndPositions().map((g) => {
    const x = pen + (g.xOffset ?? 0) / upem;
    const y = -(g.yOffset ?? 0) / upem;
    const advance = (g.xAdvance ?? 0) / upem;
    pen += advance;
    return { gid: g.codepoint, x, y, advance, cluster: g.cluster };
  });
  const run = { glyphs };
  if (unitCache.size > MAX_CACHE) unitCache.clear();
  unitCache.set(key, run);
  return run;
}

/** Glif çizim komutları (font birimi, y yukarı). */
export function glyphCommands(reg: FontRegistry, fontId: string, gid: number): Array<{ type: string; values: number[] }> {
  const key = `${reg.get(fontId).source}#${gid}`;
  let cmds = pathCache.get(key);
  if (!cmds) {
    cmds = reg.hbFont(fontId).glyphToJson(gid);
    if (pathCache.size > MAX_CACHE) pathCache.clear();
    pathCache.set(key, cmds);
  }
  return cmds;
}

/**
 * Glifin konturlardan hesaplanan gerçek kutusu (em oranı, y AŞAĞI). Eğrilerin uç noktaları hesaplanır;
 * kontrol noktaları kutuya katılmaz (glyf başlığındaki kutu kontrol noktalarını da içerebilir).
 */
function glyphBox(reg: FontRegistry, fontId: string, gid: number): Box | null {
  const face = reg.get(fontId);
  const key = `${face.source}#${gid}`;
  if (bboxCache.has(key)) return bboxCache.get(key)!;
  // Renkli glif (emoji): temel çizimi boş, mürekkep katmanlarda. Kutu katmanların birleşimidir; yoksa emoji sığdırmada
  // ve ortalamada yok sayılır, yazı alanından (kesim çizgisinden) taşardı.
  const layers = colorLayers(reg, fontId, gid);
  if (layers) {
    let box: Box | null = null;
    for (const l of layers) {
      const b = l.gid === gid ? null : glyphBox(reg, fontId, l.gid);
      if (b) box = box ? unionBox(box, b) : b;
    }
    if (bboxCache.size > MAX_CACHE) bboxCache.clear();
    bboxCache.set(key, box);
    return box;
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  let cx = 0, cy = 0;
  for (const c of glyphCommands(reg, fontId, gid)) {
    const v = c.values;
    if (c.type === "M" || c.type === "L") {
      add(v[0]!, v[1]!);
      cx = v[0]!;
      cy = v[1]!;
    } else if (c.type === "Q") {
      const [qx, qy, ex, ey] = v as [number, number, number, number];
      add(ex, ey);
      for (const t of quadExtrema(cx, qx, ex)) add(quad(cx, qx, ex, t), quad(cy, qy, ey, t));
      for (const t of quadExtrema(cy, qy, ey)) add(quad(cx, qx, ex, t), quad(cy, qy, ey, t));
      cx = ex;
      cy = ey;
    } else if (c.type === "C") {
      const [ax, ay, bx, by, ex, ey] = v as [number, number, number, number, number, number];
      add(ex, ey);
      for (const t of [...cubicExtrema(cx, ax, bx, ex), ...cubicExtrema(cy, ay, by, ey)]) add(cubic(cx, ax, bx, ex, t), cubic(cy, ay, by, ey, t));
      cx = ex;
      cy = ey;
    }
  }
  const upem = face.upem;
  const box = x0 === Infinity ? null : { x0: x0 / upem, x1: x1 / upem, y0: -y1 / upem, y1: -y0 / upem };
  if (bboxCache.size > MAX_CACHE) bboxCache.clear();
  bboxCache.set(key, box);
  return box;
}

const quad = (a: number, b: number, c: number, t: number) => (1 - t) * (1 - t) * a + 2 * (1 - t) * t * b + t * t * c;
function quadExtrema(a: number, b: number, c: number): number[] {
  const d = a - 2 * b + c;
  if (d === 0) return [];
  const t = (a - b) / d;
  return t > 0 && t < 1 ? [t] : [];
}
const cubic = (a: number, b: number, c: number, d: number, t: number) => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};
function cubicExtrema(a: number, b: number, c: number, d: number): number[] {
  // Türev: 3[(b-a)(1-t)² + 2(c-b)(1-t)t + (d-c)t²] → at² + bt + c
  const A = -a + 3 * b - 3 * c + d;
  const B = 2 * (a - 2 * b + c);
  const C = b - a;
  const out: number[] = [];
  if (Math.abs(A) < 1e-12) {
    if (Math.abs(B) > 1e-12) out.push(-C / B);
  } else {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      out.push((-B + s) / (2 * A), (-B - s) / (2 * A));
    }
  }
  return out.filter((t) => t > 0 && t < 1);
}

export function shapeRun(reg: FontRegistry, text: string, opts: ShapeOptions): ShapedRun {
  const face = reg.get(opts.fontId);
  const unit = shapeUnit(reg, text, opts.fontId, opts.language);
  const s = opts.sizePx;
  const trackingPx = face.lockTracking ? 0 : (opts.trackingEm ?? 0) * s;
  let ink: Box | null = null;
  let notdef = 0;
  const glyphs: ShapedGlyph[] = unit.glyphs.map((g, i) => {
    if (g.gid === 0) notdef++;
    const x = g.x * s + i * trackingPx;
    const y = g.y * s;
    const b = glyphBox(reg, opts.fontId, g.gid);
    const gInk = b ? { x0: x + b.x0 * s, x1: x + b.x1 * s, y0: y + b.y0 * s, y1: y + b.y1 * s } : null;
    if (gInk) ink = ink ? unionBox(ink, gInk) : gInk;
    return { gid: g.gid, x, y, advance: g.advance * s, cluster: g.cluster, ink: gInk };
  });
  const advance = sumAdvance(unit) * s + Math.max(0, unit.glyphs.length - 1) * trackingPx;
  return { fontId: opts.fontId, text, sizePx: s, trackingPx, glyphs, advance, ink, notdef };
}

function sumAdvance(u: UnitRun): number {
  let a = 0;
  for (const g of u.glyphs) a += g.advance;
  return a;
}

export function unionBox(a: Box, b: Box): Box {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

export function offsetBox(b: Box, dx: number, dy: number): Box {
  return { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy };
}

export function inflateBox(b: Box, d: number): Box {
  return { x0: b.x0 - d, y0: b.y0 - d, x1: b.x1 + d, y1: b.y1 + d };
}

/** Fontun dikey ölçüleri (px) verilen puntoda. */
export function fontMetricsPx(reg: FontRegistry, fontId: string, sizePx: number) {
  const f = reg.get(fontId);
  const k = sizePx / f.upem;
  return { ascender: f.ascender * k, descender: f.descender * k, capHeight: f.capHeight * k, xHeight: f.xHeight * k };
}

/**
 * Kontur (sahte kalın) çıkıntısı: dışa hizada çıkıntı = genişlik (SVG'de 2× kontur, iç yarısı dolgunun altında),
 * ortada hizada genişliğin yarısı. Mürekkep kutusuna eklenir.
 */
export function strokeOutset(widthPx: number, align: "outside" | "center"): number {
  if (!(widthPx > 0)) return 0;
  return align === "outside" ? widthPx : widthPx / 2;
}
