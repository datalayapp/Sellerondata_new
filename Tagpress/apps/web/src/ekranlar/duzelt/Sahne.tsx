import { adjustedInk, type Shape, type VariantAdjust } from "@tagpress/domain";
import { type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatMm } from "../../i18n/bicim.ts";
import { applyLineAttrs } from "./mantik/adjust-layer.ts";
import { layerStyle, SNAP_SCREEN_PX } from "./mantik/adjust-math.ts";
import { dragSelection, hitLine, marqueeSel, rectFromPoints, type Sel, selectionBox, snapSelection } from "./mantik/adjust-select.ts";
import { marqueeEnd, pressPlan } from "./mantik/adjust-session.ts";
import { CanvasViewport, CropMarks, Icon, SelectionBox, type View, type ViewApi } from "../../tezgah/index.ts";
import { worldRectStyle } from "../../tezgah/tuval/Tuval.tsx";
import { dragHandle, type Handle, isHandle } from "./konum.ts";
import { boxToMm, mmToPx, screenPerPx } from "./olcu.ts";
import type { Duzelt } from "./useDuzelt.ts";

/** Araç rayının kipleri. */
export type Tool = "select" | "marquee" | "pan" | "text" | "zoom";

type Pt = { x: number; y: number };
type Drag =
  | { mode: "move"; x: number; y: number; start: VariantAdjust; sel: Sel; moved: boolean }
  | { mode: "scale"; start: VariantAdjust; sel: Sel; handle: Handle }
  | { mode: "pan"; x: number; y: number; start: View }
  | { mode: "marquee"; from: Pt; to: Pt; add: boolean; base: Sel; moved: boolean };

/**
 * Düzelt tuvali (dünya birimi mm). Tasarım karesi (`framePx`) mm'ye ölçeklenmiş bir kapta çizilir: şablon görseli,
 * kesim çizgisi ve sunucunun yazı katmanı (glif yolları; satır grupları kendi dönüşümünü alır), böylece ekrandaki
 * yazı baskıdakiyle aynıdır. Seçim çerçevesi, kılavuzlar ve seçim kutusu dünya katmanında (mm); kesirli mm'de durdukları
 * ya da kaydıkları için ekran pikselli kutuyla çizilir (`worldRectStyle`, `.tz-wrect`): Chrome dünya katmanındaki kutuyu
 * 1 mm'ye yuvarlar, çerçeve yazıdan ayrı sıçrar ve büyüyüp küçülürdü.
 *
 * Fare: satıra bas seç (Ctrl/Shift ekler/çıkarır), sürükle taşı (Alt yapışmayı kapatır), tutamakla orantılı ölçekle,
 * boşluktan sürükle kutuyla seç, çift tık metni düzenle. Boşluk + sürükle ya da orta tuş kaydırır (temel tuval).
 *
 * `compact` (sağ paneldeki küçük tezgâh): cetvel, kesim işareti ve ölçü rozeti yok; düz tekerlek tuvali kaydırmaz,
 * paneli kaydırır (Ctrl + tekerlek yine yakınlaştırır).
 */
export function Sahne({
  d,
  api,
  k,
  frameMm,
  tool,
  aligned,
  stageRef,
  onEdit,
  onStageFocus,
  compact = false,
  label,
}: {
  d: Duzelt;
  api: ViewApi;
  /** mm / tasarım pikseli. */
  k: number;
  frameMm: number;
  tool: Tool;
  /** Seçimin merkezi hedefe oturmuş mu (kılavuz çizgileri). */
  aligned: { x: boolean; y: boolean };
  stageRef: RefObject<HTMLDivElement | null>;
  /** Satırın metnini düzenlemeye başla (sağ paneldeki alana odaklanır). */
  onEdit(i: number): void;
  onStageFocus(v: boolean): void;
  compact?: boolean;
  /** Tuvalin erişilebilir adı (verilmezse büyük tuvalin tarifi). */
  label?: string;
}) {
  const { t } = useTranslation("adjust");
  const { model, layout, cur, sel, selBox, goal, inner } = d;
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState<Drag["mode"] | null>(null);
  const [marquee, setMarquee] = useState<{ from: Pt; to: Pt } | null>(null);
  const cv = api.canvas;
  const framePx = model.framePx;
  const lineCount = layout.lines.length;

  // Satır dönüşümleri ve kalınlık gömülü SVG'nin satır gruplarına yazılır.
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (svg && inner) applyLineAttrs(svg, layout, cur);
  }, [inner, cur, layout]);

  // Küçük tuvalde düz tekerlek tuvale ulaşmaz (yakalama evresinde durur): sayfa / panel kayar.
  useEffect(() => {
    const el = stageRef.current;
    if (!compact || !el) return;
    const stop = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
    };
    el.addEventListener("wheel", stop, { capture: true });
    return () => el.removeEventListener("wheel", stop, { capture: true });
  }, [compact, stageRef]);

  const K = () => screenPerPx(cv.get().zoom, k);
  const toPx = (e: { clientX: number; clientY: number }) => mmToPx(cv.clientToWorld(e.clientX, e.clientY), k);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = e.target as Element;
    e.currentTarget.focus({ preventScroll: true });
    if (d.editing) {
      void d.commitEdit();
      return;
    }
    const capture = () => e.currentTarget.setPointerCapture?.(e.pointerId);
    const handle = el.closest<HTMLElement>("[data-tz-handle]")?.dataset.tzHandle;
    if (isHandle(handle) && inner) {
      capture();
      drag.current = { mode: "scale", start: cur, sel, handle };
      setDragging("scale");
      return;
    }
    if (tool === "pan") {
      capture();
      drag.current = { mode: "pan", x: e.clientX, y: e.clientY, start: cv.get() };
      setDragging("pan");
      return;
    }
    if (tool === "zoom") {
      // Tıklanan nokta ortaya gelir ve bir adım yakınlaşır (Alt ile uzaklaşır).
      const s = cv.size();
      const v = cv.get();
      const p = cv.clientToWorld(e.clientX, e.clientY);
      cv.set({ zoom: v.zoom, x: s.w / 2 - p.x * v.zoom, y: s.h / 2 - p.y * v.zoom });
      if (e.altKey) api.zoomOut();
      else api.zoomIn();
      return;
    }
    const p = toPx(e);
    const add = e.ctrlKey || e.metaKey || e.shiftKey;
    // Satırlar gömülemediyse yalnız bütün yazı (ve satır listesi).
    const hit = inner ? hitLine(layout, cur, p, 5 / K()) : null;
    if (tool === "text") {
      if (hit !== null) onEdit(hit);
      return;
    }
    if (tool === "marquee") {
      capture();
      drag.current = { mode: "marquee", from: p, to: p, add, base: sel, moved: false };
      setDragging("marquee");
      return;
    }
    const block = adjustedInk(layout, cur, { strokeAlign: layout.strokeAlign });
    const inBlock = p.x >= block.x && p.x <= block.x + block.w && p.y >= block.y && p.y <= block.y + block.h;
    const inSel = !!sel && p.x >= selBox.x && p.x <= selBox.x + selBox.w && p.y >= selBox.y && p.y <= selBox.y + selBox.h;
    const plan = pressPlan({ hit, add, sel, lineCount, inBlock, inSel });
    if (hit !== null || plan.sel !== sel) d.setSel(plan.sel);
    if (!plan.drag) return;
    capture();
    if (plan.drag === "marquee") {
      drag.current = { mode: "marquee", from: p, to: p, add, base: sel, moved: false };
      setDragging("marquee");
      return;
    }
    drag.current = { mode: "move", x: e.clientX, y: e.clientY, start: cur, sel: plan.sel, moved: false };
    setDragging("move");
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g) return;
    if (g.mode === "pan") {
      cv.set({ zoom: g.start.zoom, x: g.start.x + e.clientX - g.x, y: g.start.y + e.clientY - g.y });
      return;
    }
    if (g.mode === "scale") {
      d.setLive(dragHandle(layout, g.start, g.sel, g.handle, toPx(e)));
      return;
    }
    if (g.mode === "marquee") {
      g.to = toPx(e);
      if (!g.moved && Math.hypot(g.to.x - g.from.x, g.to.y - g.from.y) * K() < 3) return;
      g.moved = true;
      setMarquee({ from: g.from, to: g.to });
      d.setSel(marqueeSel(layout, cur, rectFromPoints(g.from, g.to), g.base, g.add));
      return;
    }
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.moved && Math.abs(dx) + Math.abs(dy) < 3) return; // tıklama, sürükleme sayılmaz
    g.moved = true;
    let next = dragSelection(g.start, g.sel, dx, dy, K());
    if (!e.altKey) next = snapSelection(layout, next, g.sel, goal, SNAP_SCREEN_PX / K());
    d.setLive(next);
  };

  const endDrag = () => {
    const g = drag.current;
    if (!g) return;
    drag.current = null;
    setDragging(null);
    if (g.mode === "pan") return;
    if (g.mode === "marquee") {
      setMarquee(null);
      const s = marqueeEnd({ moved: g.moved, add: g.add, sel });
      if (s !== sel) d.setSel(s);
      return;
    }
    d.settle(g.mode === "move" && !g.moved ? null : d.cur);
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!inner || tool !== "select") return;
    const hit = hitLine(layout, cur, toPx(e), 5 / K());
    if (hit !== null) onEdit(hit);
  };

  const selMm = boxToMm(selBox, k);
  const cutRect = boxToMm(shapeBox(model.cut), k);
  const tb = model.templateBox;

  return (
    <div
      ref={stageRef}
      className={compact ? "dz-stage dz-stage--compact" : "dz-stage"}
      data-tool={tool}
      data-drag={dragging ?? undefined}
      tabIndex={0}
      role="application"
      aria-label={label ?? t("canvas.label")}
      onFocus={(e) => e.target === e.currentTarget && onStageFocus(true)}
      onBlur={(e) => e.target === e.currentTarget && onStageFocus(false)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
    >
      <CanvasViewport api={api} rulers={!compact} highlight={{ x: [selMm.x, selMm.x + selMm.w], y: [selMm.y, selMm.y + selMm.h] }}>
        <div className="dz-frame" style={{ width: framePx, height: framePx, transform: `scale(${k})`, "--dz-k": k } as React.CSSProperties} aria-hidden="true">
          {/* Kâğıt etiketin kesim şeklinde (maket: yuvarlak etiketin arkasında kare kâğıt yok). */}
          <svg className="dz-paper" width={framePx} height={framePx} viewBox={`0 0 ${framePx} ${framePx}`}>
            <CutShape shape={model.cut} />
          </svg>
          {model.templateImageUrl && <img className="dz-tpl" src={model.templateImageUrl} alt="" draggable={false} style={{ left: tb.x, top: tb.y, width: tb.w, height: tb.h }} />}
          <svg className="dz-cut" width={framePx} height={framePx} viewBox={`0 0 ${framePx} ${framePx}`}>
            <CutShape shape={model.cut} />
          </svg>
          {/* Yazı katmanı: blok dönüşümü kapta, satır dönüşümleri satır gruplarında */}
          {inner ? (
            <div className="dz-layer" style={{ width: framePx, height: framePx, ...layerStyle(model.origin, cur, 1) }}>
              <svg ref={svgRef} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${framePx} ${framePx}`} width={framePx} height={framePx} dangerouslySetInnerHTML={{ __html: inner }} />
            </div>
          ) : (
            inner === null &&
            model.textLayerUrl && <img className="dz-layer" src={model.textLayerUrl} alt="" draggable={false} style={{ width: framePx, height: framePx, ...layerStyle(model.origin, cur, 1) }} />
          )}
        </div>
        {/* Kesim işaretleri: kesim şeklinin köşelerinde (maket Düzelt) */}
        {!compact && <CropMarks rect={cutRect} />}
        {/* Hizalanınca beliren kılavuzlar ve hedef merkez */}
        {aligned.x && <div className="dz-guide dz-guide--v tz-wrect" style={worldRectStyle({ x: goal.x * k, y: 0, w: 0, h: frameMm })} aria-hidden="true" />}
        {aligned.y && <div className="dz-guide dz-guide--h tz-wrect" style={worldRectStyle({ x: 0, y: goal.y * k, w: frameMm, h: 0 })} aria-hidden="true" />}
        <span className="dz-goal" style={worldRectStyle({ x: goal.x * k, y: goal.y * k, w: 0, h: 0 })} aria-hidden="true">
          <Icon name="cross" size={15} />
        </span>
        {/* Çoklu seçimde her satırın ince çerçevesi */}
        {sel &&
          sel.length > 1 &&
          sel.map((i) => {
            const b = boxToMm(selectionBox(layout, cur, [i]), k);
            return <div key={i} className="dz-linebox tz-wrect" style={worldRectStyle(b)} aria-hidden="true" />;
          })}
        <SelectionBox rect={selMm} handles={!!inner} sizeLabel={compact ? undefined : t("canvas.size", { w: formatMm(selMm.w), h: formatMm(selMm.h) })} />
        {marquee &&
          (() => {
            const r = boxToMm(rectFromPoints(marquee.from, marquee.to), k);
            return <div className="dz-marquee tz-wrect" style={worldRectStyle(r)} aria-hidden="true" />;
          })()}
      </CanvasViewport>
    </div>
  );
}

/** Kesim şeklinin sınır kutusu (tasarım pikseli). */
function shapeBox(shape: Shape): { x: number; y: number; w: number; h: number } {
  switch (shape.kind) {
    case "circle":
      return { x: shape.cx - shape.r, y: shape.cy - shape.r, w: shape.r * 2, h: shape.r * 2 };
    case "ellipse":
      return { x: shape.cx - shape.rx, y: shape.cy - shape.ry, w: shape.rx * 2, h: shape.ry * 2 };
    case "rect":
      return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
    case "polygon": {
      const xs = shape.points.map((p) => p.x);
      const ys = shape.points.map((p) => p.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
  }
}

/** Kesim çizgisi (tasarım pikseli; kalınlık ekranda sabit). */
function CutShape({ shape }: { shape: Shape }) {
  switch (shape.kind) {
    case "circle":
      return <circle cx={shape.cx} cy={shape.cy} r={shape.r} />;
    case "ellipse":
      return <ellipse cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} />;
    case "rect":
      return <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} rx={shape.radius} />;
    case "polygon":
      return <polygon points={shape.points.map((p) => `${p.x},${p.y}`).join(" ")} />;
  }
}
