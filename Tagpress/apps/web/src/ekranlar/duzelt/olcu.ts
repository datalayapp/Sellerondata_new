import type { Box, LabelSize } from "@tagpress/domain";
import type { Rect } from "../../tezgah/index.ts";

/**
 * Düzelt tuvalinin birimleri (saf). Düzeltmenin bütün değerleri tasarım alanı pikselidir (`framePx` × `framePx` kare);
 * tuvalin dünya birimi mm'dir. Dönüşüm etiketin ölçüsünden: tasarım karesinin fiziksel kenarı (mm) / `framePx`.
 * Taşıma adımı (ok tuşu) yine tasarım pikselidir.
 */

/** Boyut bilinmiyorsa (profil okunamadı) kabul edilen kare kenarı; sunucunun son yedeğiyle aynı (38 mm). */
export const FALLBACK_FRAME_MM = 38;

/**
 * Tasarım karesinin fiziksel kenarı (mm): varyasyonun etiket boyutu, yoksa profilin varsayılanı, yoksa ilk boyut.
 * Formül sunucunun `labelDiameterMm`'iyle aynı (iş boyutu kolu): cm × 10 / boyutun çerçevesi × tasarım karesi ×
 * içerik ölçeği (yoksa çerçeve / tasarım karesi; o zaman sonuç cm × 10).
 */
export function frameSideMm(opts: { sizes?: readonly LabelSize[]; labelSize?: string | null; defaultSize?: string | null; designFramePx: number }): number {
  const { sizes, labelSize, defaultSize, designFramePx: F } = opts;
  const s = sizes?.find((x) => x.id === labelSize) ?? sizes?.find((x) => x.id === defaultSize) ?? sizes?.[0];
  if (!s || !(F > 0) || !(s.framePx > 0)) return FALLBACK_FRAME_MM;
  const mm = ((s.cm * 10) / s.framePx) * F * (s.contentScale ?? s.framePx / F);
  return Number.isFinite(mm) && mm > 0 ? mm : FALLBACK_FRAME_MM;
}

/** mm / tasarım pikseli. */
export function mmPerPx(frameMm: number, framePx: number): number {
  return framePx > 0 ? frameMm / framePx : 1;
}

/** Tasarım pikseli kutusu → dünya (mm) dikdörtgeni. */
export function boxToMm(b: Box, k: number): Rect {
  return { x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k };
}

/** Dünya noktası (mm) → tasarım pikseli. */
export function mmToPx(p: { x: number; y: number }, k: number): { x: number; y: number } {
  return k > 0 ? { x: p.x / k, y: p.y / k } : p;
}

/** Ekran pikseli / tasarım pikseli: tuvalin yakınlığı (ekran px / mm) × mm / px. Sürükleme ve tutma payı buna göre. */
export function screenPerPx(zoom: number, k: number): number {
  return zoom * k;
}

/**
 * Sığdırılmış görünümün yakınlığı (ekran px / mm); tuvalin `fit` hesabıyla aynı (kenarda 40 px pay). Ok adımı ve
 * hizalanma eşiği "sığdırılmışa göre ne kadar yakın" oranıyla incelir.
 */
export function fitZoomFor(sideMm: number, w: number, h: number, pad = 40): number {
  const side = Math.max(sideMm, 1e-3);
  return Math.min(Math.max(1, w - 2 * pad) / side, Math.max(1, h - 2 * pad) / side);
}
