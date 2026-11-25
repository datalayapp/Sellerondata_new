import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { PX_PER_MM, type Rect, type View, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, zoomAt } from "./canvas-math.ts";
import { type CanvasView, useCanvasView, useSettledView } from "./useCanvasView.ts";

export type { Pt, Rect, View } from "./canvas-math.ts";

/**
 * Tuval görünümü (dünya birimi mm). Tekerlek, Ctrl + tekerlek, boşlukla ve orta tuşla kaydırma `useCanvasView`'den;
 * ilk boyutta `world` sığdırılır.
 *
 * Başarım: kaydırma ve yakınlaştırma React çizimi olmadan dünya katmanının tek dönüşümüyle uygulanır; cetvel ve
 * yakınlaştırma yüzdesi kendi aboneliğiyle karede bir çizilir. Bu kancayı kullanan ekran ise yalnız SEYREK yeniden
 * çizilir: `view`, `size`, `zoomLabel`, `toRect` ilk değişiklikte hemen, süren harekette en çok 120 ms'de bir ve
 * hareket bitince güncellenir (görünür alan seçimi, ayrıntı düzeyi için yeterli). Karede bir gereken özel çizim
 * `useViewState(api.canvas)` ile abone olur.
 */
export interface ViewApi {
  /** Şu anki görünüm: `zoom` = ekran px / mm, (`x`, `y`) = dünyanın (0,0) noktasının tuvaldeki yeri. */
  view: View;
  /** Tuval kabının boyutu (px). */
  size: { w: number; h: number };
  zoomIn(): void;
  zoomOut(): void;
  /** Dikdörtgeni (verilmezse `world`) sığdırır. */
  fit(r?: Rect | null): void;
  /** Gerçek boyut (%100). */
  actual(): void;
  /** Dünya dikdörtgeni (mm) → tuval kabındaki ekran dikdörtgeni (px). */
  toRect(r: Rect): Rect;
  /** Etkin dilde "%118" / "118%". */
  zoomLabel: string;
  /** Tuval kabına verilir: `<div {...api.bind}>` (CanvasViewport bunu yapar). */
  bind: { ref: (el: HTMLDivElement | null) => void };
  /** Alt düzey görünüm (sürükleme, istemci → dünya dönüşümü, karede bir abonelik). */
  canvas: CanvasView;
}

/** Yakınlaştırma yüzdesi (gerçek boyuta göre). */
export const zoomPercent = (zoom: number) => Math.round((zoom / PX_PER_MM) * 100);

export function useViewport({ world, pad = 40, min = ZOOM_MIN, max = ZOOM_MAX }: { world: Rect; pad?: number; min?: number; max?: number }): ViewApi {
  const { t } = useTranslation("frame");
  const worldRef = useRef(world);
  worldRef.current = world;
  const cvRef = useRef<CanvasView | null>(null);
  const cv = useCanvasView({ onFirstSize: () => cvRef.current?.fit(worldRef.current, pad) });
  cvRef.current = cv;
  const { view, w, h } = useSettledView(cv);

  return useMemo<ViewApi>(() => {
    const clamp = (z: number) => Math.max(min, Math.min(max, z));
    const zoomTo = (z: number) => {
      const s = cv.size();
      cv.set(zoomAt(cv.get(), clamp(z), { x: s.w / 2, y: s.h / 2 }));
    };
    return {
      view,
      size: { w, h },
      zoomIn: () => zoomTo(cv.get().zoom * ZOOM_STEP),
      zoomOut: () => zoomTo(cv.get().zoom / ZOOM_STEP),
      fit: (r) => cv.fit(r ?? worldRef.current, pad),
      actual: () => cv.actual(),
      toRect: (r) => ({ x: r.x * view.zoom + view.x, y: r.y * view.zoom + view.y, w: r.w * view.zoom, h: r.h * view.zoom }),
      zoomLabel: t("zoom.percent", { n: zoomPercent(view.zoom) }),
      bind: { ref: cv.bindContainer },
      canvas: cv,
    };
  }, [cv, view, w, h, pad, min, max, t]);
}
