/**
 * Baskı tuvallerinin (sayfa şablonu düzenleyici ve baskı masası) görünüm matematiği — SAF.
 *
 * Dünya birimi mm (kağıdın / masanın sol üstü 0,0; x sağa, y aşağı). Görünüm: `zoom` = ekran px / mm,
 * (`x`, `y`) = dünyanın (0,0) noktasının tuvaldeki yeri (ekran px). Ekran → dünya: (p − (x, y)) / zoom.
 * Masa "sonsuzdur": kaydırma sınırsız, yalnızca yakınlaştırma sınırlıdır.
 */
import { CSS_PX_PER_MM } from "@tagpress/domain";

export interface View {
  zoom: number;
  x: number;
  y: number;
}
export interface Pt {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** %100 = gerçek boyut: CSS'te 1 mm = 96 / 25,4 px (`@tagpress/domain` `CSS_PX_PER_MM`; baskı ölçüsüyle aynı mm). */
export const PX_PER_MM = CSS_PX_PER_MM;
/** Yakınlaştırma sınırları (%2 – %3200). */
export const ZOOM_MIN = PX_PER_MM * 0.02;
export const ZOOM_MAX = PX_PER_MM * 32;
/** Ctrl + = / Ctrl + - adımı. */
export const ZOOM_STEP = 1.25;

export const clampZoom = (z: number): number => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

export function toWorld(p: Pt, v: View): Pt {
  return { x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom };
}

export function toScreen(p: Pt, v: View): Pt {
  return { x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y };
}

/** `anchor` (tuval ekran px) altındaki dünya noktası yerinde kalacak şekilde yakınlaştırır (imlece doğru). */
export function zoomAt(v: View, nextZoom: number, anchor: Pt): View {
  const z = clampZoom(nextZoom);
  const p = toWorld(anchor, v);
  return { zoom: z, x: anchor.x - p.x * z, y: anchor.y - p.y * z };
}

export function panBy(v: View, dx: number, dy: number): View {
  return { zoom: v.zoom, x: v.x + dx, y: v.y + dy };
}

/** Dikdörtgeni (mm) `w × h` tuvale `pad` ekran px kenar payıyla sığdırır ve ortalar. */
export function fitRect(r: Rect, w: number, h: number, pad = 40): View {
  const rw = Math.max(r.w, 1e-3);
  const rh = Math.max(r.h, 1e-3);
  const z = clampZoom(Math.min(Math.max(1, w - 2 * pad) / rw, Math.max(1, h - 2 * pad) / rh));
  return { zoom: z, x: w / 2 - (r.x + rw / 2) * z, y: h / 2 - (r.y + rh / 2) * z };
}

/** Gerçek boyut (%100), tuvalin ortasındaki dünya noktası yerinde kalır. */
export function actualSize(v: View, w: number, h: number): View {
  return zoomAt(v, PX_PER_MM, { x: w / 2, y: h / 2 });
}

/**
 * Tekerlek → yakınlaştırma çarpanı. Fare tekerleği (~100 birim) ≈ %16, dokunmatik yüzey kıstırması yumuşak.
 * `deltaMode`: 0 piksel, 1 satır (×16), 2 sayfa (×400).
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const d = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1);
  return Math.max(0.5, Math.min(2, Math.exp(-d * 0.0015)));
}

/** Tekerlek → kaydırma (ekran px); Shift ile dikey tekerlek yatay kaydırır. */
export function wheelPan(e: { deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean }): { dx: number; dy: number } {
  const m = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const dx = e.deltaX * m;
  const dy = e.deltaY * m;
  return e.shiftKey && !dx ? { dx: -dy, dy: 0 } : { dx: -dx, dy: -dy };
}

/** "%118" (gerçek boyuta göre). */
export function zoomLabel(zoom: number): string {
  return `%${Math.round((zoom / PX_PER_MM) * 100)}`;
}

/** Tuvalin gördüğü dünya dikdörtgeni (mm). */
export function worldViewport(v: View, w: number, h: number): Rect {
  return { x: -v.x / v.zoom, y: -v.y / v.zoom, w: w / v.zoom, h: h / v.zoom };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** İki köşeden normalleştirilmiş dikdörtgen (kutu seçimi). */
export function rectFromPoints(a: Pt, b: Pt): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function unionRect(rs: readonly Rect[]): Rect | null {
  if (!rs.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rs) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Görünen öğeler: dünya görüş alanıyla (kenarlarda `marginPx` ekran px pay) kesişen dikdörtgenlerin kimlikleri.
 * Masada yalnızca bunlar DOM'a girer.
 */
export function visibleIds(rects: ReadonlyMap<string, Rect>, v: View, w: number, h: number, marginPx = 200): Set<string> {
  const vp = worldViewport(v, w, h);
  const m = marginPx / v.zoom;
  const area = { x: vp.x - m, y: vp.y - m, w: vp.w + 2 * m, h: vp.h + 2 * m };
  const out = new Set<string>();
  for (const [id, r] of rects) if (rectsIntersect(r, area)) out.add(id);
  return out;
}

/** Ayrıntı düzeyi: sayfa ekranda bu genişliğin altındaysa sunucunun küçük resmi, üstündeyse etiket önizlemeleri. */
export const DETAIL_MIN_PAGE_PX = 360;
export type Lod = "thumb" | "detail";
export function lodFor(pageWidthMm: number, zoom: number, threshold = DETAIL_MIN_PAGE_PX): Lod {
  return pageWidthMm * zoom >= threshold ? "detail" : "thumb";
}

/** Küçük resim genişliği (px): ekrandaki boyutun bir üst basamağı (önbellek dostu; 128–1024). */
export function thumbWidth(pageWidthMm: number, zoom: number, dpr = 1): number {
  const want = pageWidthMm * zoom * dpr;
  for (const s of [128, 256, 512, 1024]) if (want <= s) return s;
  return 1024;
}

/** Cetvel: ekrandaki aralığı en az `minPx` olan "yuvarlak" mm adımı (1, 2, 5, 10, 20, 50 …). */
export function rulerStep(zoom: number, minPx = 48): number {
  const steps = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  return steps.find((s) => s * zoom >= minPx) ?? 1000;
}

/** Cetvel çizgileri: [from, to] dünya aralığında `step` katları (büyük) ve ara çizgiler (küçük; adımın 1/5'i, 2'li adımlarda 1/4'ü). */
export function rulerTicks(from: number, to: number, step: number): { major: number[]; minor: number[] } {
  const major: number[] = [];
  const minor: number[] = [];
  const sub = String(step).startsWith("2") ? step / 4 : step / 5;
  const start = Math.floor(from / sub) * sub;
  for (let v = start, i = 0; v <= to && i < 4000; v = start + ++i * sub) {
    const r = Math.round(v * 1000) / 1000;
    if (Math.abs(r / step - Math.round(r / step)) < 1e-6) major.push(r);
    else minor.push(r);
  }
  return { major, minor };
}
