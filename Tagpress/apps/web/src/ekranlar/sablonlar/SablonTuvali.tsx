import type { Point, Shape } from "@tagpress/domain";
import { type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { doubleClick, drawPreview, type EditorCtx, type Hit, pointerDown, pointerMove, pointerUp, type Step } from "./mantik/editor.ts";
import type { TemplateScale } from "./mantik/olcu.ts";
import { type HandleId, handlesOf, ratioToPx, ribbonLimitY, shapeToPath, vertexIndex } from "./mantik/shapeMath.ts";
import { CanvasViewport, CropMarks, Icon, type View, type ViewApi } from "../../tezgah/index.ts";

/** Tuval katmanları (bugünkü düzenleyiciyle aynı altı katman). */
export interface Layers {
  area: boolean;
  decoration: boolean;
  ribbon: boolean;
  target: boolean;
  cut: boolean;
  /** Sunucunun kesin hesabı (kayıtlı hâl). */
  server: boolean;
}

export const LAYER_IDS: (keyof Layers)[] = ["area", "decoration", "ribbon", "target", "cut", "server"];

/** Rayın kipleri: dört alan aracı ve kaydırma. */
export type RailTool = EditorCtx["tool"] | "pan";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Şablon tuvali (dünya birimi mm). Tasarım karesi (`framePx`) mm'ye ölçeklenmiş bir kapta çizilir: şablon görseli
 * (ya da sunucu bindirmesi), kurdele bandı, dekor taraması, yazı alanı, öneri, kesim çizgisi. Şablon pikseline
 * dokunulmaz; bütün katmanlar görselin üstüne çizilir. Tutamaklar ve hedef merkez dünya katmanında, ekranda sabit boyda.
 *
 * Etkileşim kuralları `mantik/editor.ts`'te; burada yalnız işaretçi → oran dönüşümü ve çizim.
 */
export function SablonTuvali({
  api,
  scale,
  ctx,
  tool,
  apply,
  layers,
  imageUrl,
  overlayUrl,
  ghost,
  ribbonTop,
  target,
  targetFallback,
  decor,
  overlay,
  highlight,
}: {
  api: ViewApi;
  scale: TemplateScale;
  ctx: EditorCtx;
  tool: RailTool;
  /** Durum makinesi adımını uygula; `gesture`: aynı sürüklemenin adımları (geri al'da tek adım). */
  apply(step: Step, gesture: string | null): void;
  layers: Layers;
  imageUrl: string | null;
  /** Sunucu bindirmesi yüklendiyse adresi (katman açık ve görsel hazır). */
  overlayUrl: string | null;
  ghost: Shape | null;
  ribbonTop: number;
  target: Point | null;
  targetFallback: Point;
  decor: { tint: string | null; knock: string | null } | null;
  overlay?: ReactNode;
  highlight?: { x?: [number, number]; y?: [number, number] };
}) {
  const { t } = useTranslation("templates");
  const { framePx: F, mmPerPx: k, frameMm, cutPx, imageBox } = scale;
  const cv = api.canvas;
  const id = useId().replace(/:/g, "");
  const gesture = useRef(0);
  const pan = useRef<{ x: number; y: number; start: View } | null>(null);
  const [dragging, setDragging] = useState(false);
  const { manual, area, it, selVertex } = ctx;

  const toRatio = (e: { clientX: number; clientY: number }): Point => {
    const w = cv.clientToWorld(e.clientX, e.clientY);
    return { x: clamp01(w.x / frameMm), y: clamp01(w.y / frameMm) };
  };
  const hitOf = (el: Element): Hit => {
    const r = el.closest<HTMLElement | SVGElement>("[data-role]");
    const role = r?.dataset.role;
    if (role === "target") return { role: "target" };
    if (role === "handle" && r?.dataset.handle) return { role: "handle", id: r.dataset.handle as HandleId };
    if (role === "shape") return { role: "shape" };
    return null;
  };
  const key = () => `g${gesture.current}`;

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || cv.panning) return;
    e.currentTarget.focus({ preventScroll: true });
    const capture = () => e.currentTarget.setPointerCapture?.(e.pointerId);
    if (tool === "pan") {
      capture();
      pan.current = { x: e.clientX, y: e.clientY, start: cv.get() };
      setDragging(true);
      return;
    }
    gesture.current++;
    const step = pointerDown(ctx, hitOf(e.target as Element), toRatio(e), { shift: e.shiftKey, detail: e.detail });
    if (!step) return;
    if (step.capture) {
      capture();
      setDragging(true);
    }
    apply(step, key());
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    if (p) {
      cv.set({ zoom: p.start.zoom, x: p.start.x + e.clientX - p.x, y: p.start.y + e.clientY - p.y });
      return;
    }
    const step = pointerMove(it, toRatio(e), e.shiftKey);
    if (step) apply(step, key());
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    setDragging(false);
    if (pan.current) {
      pan.current = null;
      return;
    }
    const step = pointerUp(it, toRatio(e), e.shiftKey);
    if (step) apply(step, key());
  };
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Kenara yakınlık: ekranda 12 px.
    const tol = 12 / (Math.max(cv.get().zoom, 1e-6) * frameMm);
    gesture.current++;
    const step = doubleClick(ctx, toRatio(e), tol);
    if (step) apply(step, key());
  };

  // ---- çizim verisi (tasarım pikseli)
  const areaPx = area ? ratioToPx(area, F) : null;
  const ghostPx = ghost ? ratioToPx(ghost, F) : null;
  const ribbonY = ribbonLimitY(cutPx, ribbonTop);
  const hasRibbon = ribbonTop > 0.0001;
  const preview = drawPreview(it);
  const polyPts = it?.type === "poly" ? [...it.points, ...(it.hover ? [it.hover] : [])] : null;
  const shownTarget = target ?? targetFallback;
  const editable = manual && tool === "select" && layers.area && area !== null;
  const useOverlay = layers.server && overlayUrl;

  return (
    <div
      className="sb-stage"
      data-tool={tool}
      data-manual={manual || undefined}
      data-drag={dragging || undefined}
      tabIndex={0}
      role="application"
      aria-label={t("canvas.label")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        pan.current = null;
        setDragging(false);
        apply({ it: null }, null);
      }}
      onDoubleClick={onDoubleClick}
    >
      <CanvasViewport api={api} rulers highlight={highlight} overlay={overlay}>
        <CropMarks rect={{ x: 0, y: 0, w: frameMm, h: frameMm }} />
        <div className="sb-frame" style={{ width: F, height: F, transform: `scale(${k})`, "--sb-k": k } as CSSProperties}>
          <svg className="sb-svg" width={F} height={F} viewBox={`0 0 ${F} ${F}`} aria-hidden="true">
            <defs>
              <clipPath id={`cut-${id}`}>
                <path d={shapeToPath(cutPx)} />
              </clipPath>
              {/* dekor taraması: 45° kılcal çizgiler, dekor maskesiyle kesilir */}
              <pattern id={`hatch-${id}`} width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line className="sb-hatch" x1={0} y1={0} x2={0} y2={5} strokeWidth={1.4} />
              </pattern>
              {decor?.tint && (
                <mask id={`decor-${id}`} maskUnits="userSpaceOnUse" x={0} y={0} width={F} height={F}>
                  <image href={decor.tint} x={0} y={0} width={F} height={F} preserveAspectRatio="none" />
                </mask>
              )}
              {decor?.knock && (
                <mask id={`ribbon-${id}`} maskUnits="userSpaceOnUse" x={0} y={0} width={F} height={F}>
                  <rect className="sb-mask-on" x={0} y={0} width={F} height={F} />
                  {layers.decoration && <image href={decor.knock} x={0} y={0} width={F} height={F} preserveAspectRatio="none" />}
                </mask>
              )}
            </defs>

            {/* şablon görseli (ya da sunucunun kesin bindirmesi): yalnız gösterilir, pikseline dokunulmaz */}
            {useOverlay ? (
              <image href={overlayUrl} x={0} y={0} width={F} height={F} preserveAspectRatio="none" />
            ) : (
              imageUrl && <image href={imageUrl} x={imageBox.x} y={imageBox.y} width={imageBox.w} height={imageBox.h} preserveAspectRatio="none" />
            )}

            {layers.ribbon && hasRibbon && (
              <g clipPath={`url(#cut-${id})`}>
                <rect className="sb-ribbon" x={0} y={0} width={F} height={ribbonY} mask={decor?.knock ? `url(#ribbon-${id})` : undefined} />
                <line className="sb-ln sb-ribbon-ln" x1={0} x2={F} y1={ribbonY} y2={ribbonY} />
              </g>
            )}

            {layers.decoration && decor?.tint && (
              <g clipPath={`url(#cut-${id})`}>
                <rect x={0} y={0} width={F} height={F} fill={`url(#hatch-${id})`} mask={`url(#decor-${id})`} />
              </g>
            )}

            {layers.area && areaPx && <path className={`sb-ln sb-area${editable ? " is-edit" : ""}`} d={shapeToPath(areaPx)} data-role={manual ? "shape" : undefined} />}
            {ghostPx && <path className="sb-ln sb-ghost" d={shapeToPath(ghostPx)} />}
            {layers.cut && <path className="sb-ln sb-cutline" d={shapeToPath(cutPx)} />}
            {preview && <path className="sb-ln sb-draft" d={shapeToPath(ratioToPx(preview, F))} />}
            {polyPts && <polyline className="sb-ln sb-draft" points={polyPts.map((q) => `${q.x * F},${q.y * F}`).join(" ")} />}
          </svg>
        </div>

        {/* çokgen çizim noktaları ve tutamaklar: dünya katmanında, ekranda sabit boyda */}
        {it?.type === "poly" &&
          it.points.map((q, i) => <span key={i} className={`tz-hdl sb-hdl${i === 0 ? " is-first" : ""}`} style={{ left: q.x * frameMm, top: q.y * frameMm }} aria-hidden="true" />)}
        {editable &&
          handlesOf(area).map((h) => (
            <span
              key={h.id}
              className={`tz-hdl sb-hdl${vertexIndex(h.id) !== null && vertexIndex(h.id) === selVertex ? " is-sel" : ""}`}
              style={{ left: h.x * frameMm, top: h.y * frameMm, cursor: h.cursor }}
              data-role="handle"
              data-handle={h.id}
              aria-hidden="true"
            />
          ))}
        {layers.target && (
          <span className={`sb-target${target ? "" : " is-fallback"}`} style={{ left: shownTarget.x * frameMm, top: shownTarget.y * frameMm }} data-role="target" aria-hidden="true">
            <Icon name="cross" />
          </span>
        )}
      </CanvasViewport>
    </div>
  );
}
