import { ADJUST_LIMITS, IDENTITY_ADJUST, normalizeAdjust, type VariantAdjust } from "@tagpress/domain";
import { moveText, noChangeText, percentText, scalePartText } from "../metin.ts";

/**
 * Hafif düzeltme katmanının saf mantığı (ekran ↔ tasarım px, hizalanma, klavye adımı).
 * Birim: tasarım alanı px (framePx × framePx kare, sol üst 0,0). Ekran px = tasarım px × k.
 */

/** Hizalanma eşiği (tasarım px): mürekkep merkezi hedefe bu kadar yakınsa kılavuz çizgisi belirir. */
export const ALIGN_EPSILON = 0.5;
/** Sürüklerken hedefe yapışma menzili (ekran px). Alt tuşu yapışmayı kapatır. */
export const SNAP_SCREEN_PX = 5;
/** Boyut adımı (%2). */
export const SCALE_STEP = 0.02;

const r2 = (v: number) => Math.round(v * 100) / 100;
const clampShift = (v: number) => Math.max(-ADJUST_LIMITS.shiftMaxPx, Math.min(ADJUST_LIMITS.shiftMaxPx, v));

/** Ekran/tasarım ölçeği: k = ekranKenarı / framePx. */
export function screenScale(screenSide: number, framePx: number): number {
  return framePx > 0 ? screenSide / framePx : 1;
}

/** Fare farkını (ekran px) tasarım px'e çevirir. */
export function screenToDesign(deltaScreen: number, k: number): number {
  return k > 0 ? deltaScreen / k : 0;
}

/** Sürüklemenin sonucu: başlangıç düzeltmesine ekran farkı eklenir, sınırlar içinde tutulur. */
export function dragAdjust(start: VariantAdjust, dxScreen: number, dyScreen: number, k: number): VariantAdjust {
  return { ...start, dx: r2(clampShift(start.dx + screenToDesign(dxScreen, k))), dy: r2(clampShift(start.dy + screenToDesign(dyScreen, k))) };
}

/** Yazı katmanının CSS karşılığı (domain `applyAdjustToLayout` ile birebir): önce kaydır, sonra origin etrafında ölç. */
export function layerStyle(origin: { x: number; y: number }, adjust: VariantAdjust, k: number): { transformOrigin: string; transform: string } {
  return {
    transformOrigin: `${origin.x * k}px ${origin.y * k}px`,
    transform: `translate(${adjust.dx * k}px, ${adjust.dy * k}px) scale(${adjust.scale})`,
  };
}

/** Merkez hedefe yatayda/dikeyde oturmuş mu? */
export function alignment(center: { x: number; y: number }, target: { x: number; y: number }, eps = ALIGN_EPSILON): { x: boolean; y: boolean } {
  return { x: Math.abs(center.x - target.x) <= eps, y: Math.abs(center.y - target.y) <= eps };
}

/**
 * Sürükleme sırasında hedefe yapışma: merkez hedefe `snapDesign` içindeyse kaydırma o eksende hedefe oturacak şekilde düzeltilir.
 * `center` düzeltilmiş mürekkep merkezidir; dönen düzeltme yalnızca dx/dy'yi oynatır.
 */
export function snapToTarget(adjust: VariantAdjust, center: { x: number; y: number }, target: { x: number; y: number }, snapDesign: number): VariantAdjust {
  const out = { ...adjust };
  if (Math.abs(center.x - target.x) <= snapDesign) out.dx = r2(clampShift(adjust.dx + target.x - center.x));
  if (Math.abs(center.y - target.y) <= snapDesign) out.dy = r2(clampShift(adjust.dy + target.y - center.y));
  return out;
}

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * Ok tuşu → kaydırma adımı (tasarım px): `step` (varsayılan 1 px; yakınlaştırınca daha ince, bkz. `fineStep`), Shift ile 10 katı.
 * Ok tuşu değilse null.
 */
export function nudgeStep(key: string, shift: boolean, step = 1): { dx: number; dy: number } | null {
  const a = ARROWS[key];
  if (!a) return null;
  const n = (shift ? 10 : 1) * step;
  return { dx: a[0] * n, dy: a[1] * n };
}

/** Ok tuşu adımını uygular. */
export function nudge(adjust: VariantAdjust, key: string, shift: boolean): VariantAdjust {
  const s = nudgeStep(key, shift);
  if (!s) return adjust;
  return { ...adjust, dx: r2(clampShift(adjust.dx + s.dx)), dy: r2(clampShift(adjust.dy + s.dy)) };
}

/** Boyut tuşları: `-` küçültür; `=`/`+` büyütür. */
export function scaleKeyStep(key: string): number | null {
  if (key === "-" || key === "_") return -SCALE_STEP;
  if (key === "=" || key === "+") return SCALE_STEP;
  return null;
}

/** İki düzeltme kayıt biçimine göre aynı mı? (null = düzeltme yok) */
export function sameAdjust(a: VariantAdjust | null | undefined, b: VariantAdjust | null | undefined): boolean {
  return JSON.stringify(normalizeAdjust(a ?? IDENTITY_ADJUST)) === JSON.stringify(normalizeAdjust(b ?? IDENTITY_ADJUST));
}

/** Boyut yüzdesi ("%102"; EN "102%"). */
export function scaleLabel(scale: number): string {
  return percentText(Math.round(scale * 100));
}

/** Özetin parçaları: kaydırma, boyut. Değişiklik yoksa boş. */
export function adjustParts(a: VariantAdjust): string[] {
  const parts: string[] = [];
  // İnce adımlar (0,05 px) görünsün diye iki ondalık.
  if (Math.abs(a.dx) >= 0.005) parts.push(moveText("x", a.dx));
  if (Math.abs(a.dy) >= 0.005) parts.push(moveText("y", a.dy));
  if (Math.abs(a.scale - 1) >= 0.00005) parts.push(scalePartText(scaleLabel(a.scale)));
  return parts;
}

/** Çalışma durumunu özetleyen kısa metin: "sağa 12 px · aşağı 3 px · %104". Değişiklik yoksa "değişiklik yok". */
export function adjustSummary(a: VariantAdjust): string {
  const parts = adjustParts(a);
  return parts.length ? parts.join(" · ") : noChangeText();
}

/** Görüntü modundaki varyasyonda yazı şablona basılıdır; düzeltilemez (sunucu 422 verir). */
export function canAdjust(variant: { kind: string }): boolean {
  return variant.kind !== "image-on-template";
}
