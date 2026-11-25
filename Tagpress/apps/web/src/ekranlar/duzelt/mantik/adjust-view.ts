/**
 * Düzelt penceresinin yakınlaştırma / kaydırma matematiği (saf). Sahne `side × side` ekran px'lik sabit bir çerçevedir;
 * içindeki "dünya" tasarım alanıdır (framePx × framePx). Görünüm: `zoom` = ekran px / tasarım px (1 = %100, gerçek boyut),
 * (`x`, `y`) = dünyanın sol üst köşesinin sahnedeki yeri (ekran px). Ekran → tasarım: (p − (x, y)) / zoom.
 */

import { percentText } from "../metin.ts";

export interface View {
  zoom: number;
  x: number;
  y: number;
}

type Pt = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };

/** Yakınlaştırma sınırları (%25 – %800). */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 8;
/** Ctrl + = / Ctrl + - adımı. */
export const ZOOM_STEP = 1.25;

export const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

/** Sığdır: bütün tasarım alanı sahneye oturur (sınırların dışında kalsa da sığdırma tam oturur). */
export function fitView(side: number, framePx: number): View {
  return { zoom: framePx > 0 ? side / framePx : 1, x: 0, y: 0 };
}

/** Dünya sahnenin dışına kaçmasın: sahnenin merkezi her zaman dünyanın içinde kalır. */
export function clampPan(v: View, side: number, framePx: number): View {
  const W = framePx * v.zoom;
  const lo = side / 2 - W;
  const hi = side / 2;
  return { zoom: v.zoom, x: Math.max(lo, Math.min(hi, v.x)), y: Math.max(lo, Math.min(hi, v.y)) };
}

/** Sahnedeki nokta (ekran px, sahnenin sol üstüne göre) → tasarım px. */
export function stageToDesign(p: Pt, v: View): Pt {
  return { x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom };
}

/** Tasarım px → sahne ekran px. */
export function designToStage(p: Pt, v: View): Pt {
  return { x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y };
}

/** `anchor` (sahne ekran px) altındaki tasarım noktası yerinde kalacak şekilde yakınlaştırır. */
export function zoomAt(v: View, nextZoom: number, anchor: Pt, side: number, framePx: number): View {
  const z = clampZoom(nextZoom);
  const p = stageToDesign(anchor, v);
  return clampPan({ zoom: z, x: anchor.x - p.x * z, y: anchor.y - p.y * z }, side, framePx);
}

/** Kaydırma (ekran px). */
export function panBy(v: View, dx: number, dy: number, side: number, framePx: number): View {
  return clampPan({ zoom: v.zoom, x: v.x + dx, y: v.y + dy }, side, framePx);
}

/**
 * Tekerlek → yakınlaştırma çarpanı. Fare tekerleği (~100 birim) ≈ %16, dokunmatik yüzey kıstırması (küçük delta) yumuşak.
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

/** "%118" (EN "118%"). */
export function zoomLabel(zoom: number): string {
  return percentText(Math.round(zoom * 100));
}

/** İnce ayar basamakları (tasarım px). */
const FINE_STEPS = [1, 0.5, 0.25, 0.1, 0.05] as const;

/**
 * Ok tuşunun adımı (tasarım px): sığdırılmış görünümde 1 px; yakınlaştırdıkça bir ekran pikseline düşen tasarım
 * pikselinin altındaki en büyük "yuvarlak" basamak (2× → 0,5; 4× → 0,25; 10× → 0,1). Uzaklaştırınca 1 px'ten büyümez.
 */
export function fineStep(zoom: number, fitZoom: number): number {
  const rel = fitZoom > 0 ? zoom / fitZoom : 1;
  if (rel <= 1) return 1;
  const target = 1 / rel;
  return FINE_STEPS.find((s) => s <= target + 1e-9) ?? FINE_STEPS[FINE_STEPS.length - 1]!;
}

/** Hizalanma eşiği (tasarım px): yakınlaştırınca küçülür ki kılavuz yalnızca gerçekten hizalıyken görünsün. */
export function alignEpsilon(zoom: number, fitZoom: number, base = 0.5): number {
  const rel = fitZoom > 0 ? zoom / fitZoom : 1;
  return Math.max(0.02, base / Math.max(1, rel));
}

/** Seçime yakınlaştır: kutu sahnenin `fill` oranını kaplar ve ortalanır. */
export function zoomToBox(box: Box, side: number, framePx: number, fill = 0.7): View {
  const w = Math.max(box.w, 1);
  const h = Math.max(box.h, 1);
  const z = clampZoom(Math.min((side * fill) / w, (side * fill) / h));
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return clampPan({ zoom: z, x: side / 2 - cx * z, y: side / 2 - cy * z }, side, framePx);
}

/** Sahne yeniden boyutlanınca görünümü orantılı taşır (sığdırılmış görünüm sığdırılmış kalır). */
export function resizeView(v: View, oldSide: number, newSide: number, framePx: number): View {
  if (oldSide <= 0 || oldSide === newSide) return v;
  const f = newSide / oldSide;
  return clampPan({ zoom: clampZoom(v.zoom * f), x: v.x * f, y: v.y * f }, newSide, framePx);
}
