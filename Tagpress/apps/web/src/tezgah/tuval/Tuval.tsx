import { createContext, type CSSProperties, memo, type ReactNode, useCallback, useContext, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../../i18n/bicim.ts";
import { cx } from "../cx.ts";
import { Button, IconButton } from "../dugme/Button.tsx";
import { useCommand, useCommands } from "../kisayol/kayit.ts";
import { type Rect, rectsIntersect, rulerStep, rulerTicks, worldViewport } from "./canvas-math.ts";
import { type CanvasView, useViewState } from "./useCanvasView.ts";
import { type ViewApi, zoomPercent } from "./useViewport.ts";
import "./tuval.css";

/** Cetvel kalınlığı (px); `--tz-ruler` ile aynı. */
const RULER = 22;
/** 5 mm ızgara; hücre ekranda bundan küçükse çizilmez. */
const GRID_MM = 5;
const GRID_MIN_PX = 6;
/** Görünür alanın dışında bu kadar ekran px'e kadar olan `Artboard`'lar da çizilir (kaydırırken boşluk görünmesin). */
const CULL_MARGIN_PX = 240;

/**
 * Ölçüm sayaçları (testler ve geliştirme için): kaydırma/yakınlaştırma sırasında hangi katmanın kaç kez çizildiği.
 * Beklenen: `viewport` hareket boyunca neredeyse sabit, `rulers` karede bir, dünya içeriği hiç.
 */
export const canvasStats = { viewport: 0, rulers: 0, zoomLabel: 0 };

const CanvasContext = createContext<CanvasView | null>(null);

type Highlight = { x?: [number, number]; y?: [number, number] };

const mod = (a: number, n: number) => ((a % n) + n) % n;

function RulerAxis({ axis, from, to, offset, zoom, hi }: { axis: "t" | "l"; from: number; to: number; offset: number; zoom: number; hi?: [number, number] }) {
  const step = rulerStep(zoom);
  const sub = String(step).startsWith("2") ? step / 4 : step / 5;
  const maj = step * zoom;
  const { major } = rulerTicks(from - step, to, step);
  const pos = (v: number) => v * zoom + offset - RULER;
  const style = {
    "--tz-rl-maj": `${maj}px`,
    "--tz-rl-min": `${sub * zoom}px`,
    "--tz-rl-o": `${mod(offset - RULER, maj) - maj}px`,
  } as React.CSSProperties;
  const along = axis === "t" ? "left" : "top";
  const size = axis === "t" ? "width" : "height";
  const labels = major.map((v) => formatNumber(v));
  // Sol cetvel makette yatay; 22 px'e sığmayan (3 karakterden uzun) sayı görünürse hepsi dikey yazılır.
  const vertical = axis === "l" && labels.some((s) => s.length > 3);
  return (
    <div className={cx("tz-rl", `tz-rl--${axis}`, vertical && "tz-rl--v")} style={style} aria-hidden="true">
      {hi && <span className="tz-rl-hi" style={{ [along]: pos(hi[0]), [size]: Math.max(1, (hi[1] - hi[0]) * zoom) }} />}
      {major.map((v, i) => (
        <span key={v} className="tz-rl-j" style={{ [along]: pos(v) }}>
          {labels[i]}
        </span>
      ))}
    </div>
  );
}

/** Cetveller: kendi aboneliğiyle karede bir çizilir; ekranı ve dünya katmanını yeniden çizdirmez. */
const Rulers = memo(
  function Rulers({ cv, highlight }: { cv: CanvasView; highlight?: Highlight }) {
    canvasStats.rulers++;
    const { view, w, h } = useViewState(cv, 0);
    const { zoom, x, y } = view;
    return (
      <>
        <div className="tz-rl-c" aria-hidden="true" />
        <RulerAxis axis="t" from={(RULER - x) / zoom} to={(w - x) / zoom} offset={x} zoom={zoom} hi={highlight?.x} />
        <RulerAxis axis="l" from={(RULER - y) / zoom} to={(h - y) / zoom} offset={y} zoom={zoom} hi={highlight?.y} />
      </>
    );
  },
  (a, b) => a.cv === b.cv && a.highlight?.x?.[0] === b.highlight?.x?.[0] && a.highlight?.x?.[1] === b.highlight?.x?.[1] && a.highlight?.y?.[0] === b.highlight?.y?.[0] && a.highlight?.y?.[1] === b.highlight?.y?.[1],
);

export interface CanvasViewportProps {
  api: ViewApi;
  rulers?: boolean;
  /** 5 mm ızgara. */
  grid?: boolean;
  /** Cetvelde vurgulanan aralık (mm), genellikle seçimin kenarları. */
  highlight?: Highlight;
  /** Dünyaya bağlı olmayan katman (yüzen kutu, ipucu). Üzerindeki düz tekerlek kutunun kendi kaydırmasıdır. */
  overlay?: ReactNode;
  /** Boş zemine basılınca (seçimi kaldırmak gibi). */
  onBackground?(e: PointerEvent): void;
  /** Dünya katmanı: içinde 1 birim = 1 mm (`--tz-mm: 1px`; konumlar px yazılır, mm okunur). */
  children: ReactNode;
}

/**
 * Tuval: zemin, ızgara, cetvel, dünya katmanı. Görünüm değişince React çizimi olmaz: dünya katmanının dönüşümü,
 * `--tz-zoom` ve ızgara doğrudan yazılır; cetvel kendi aboneliğiyle çizilir.
 */
export function CanvasViewport({ api, rulers, grid = true, highlight, overlay, onBackground, children }: CanvasViewportProps) {
  canvasStats.viewport++;
  const { t } = useTranslation("frame");
  const cv = api.canvas;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const bindBox = api.bind.ref;
  const boxCallback = useCallback(
    (el: HTMLDivElement | null) => {
      boxRef.current = el;
      bindBox(el);
    },
    [bindBox],
  );

  // Izgara: hücre boyu ve konumu doğrudan stile (her görünüm değişikliğinde, React'sız).
  useLayoutEffect(() => {
    const paint = () => {
      const el = boxRef.current;
      if (!el) return;
      const v = cv.get();
      const cell = GRID_MM * v.zoom;
      el.style.setProperty("--tz-grid-px", `${cell}px`);
      el.style.backgroundPosition = `${v.x}px ${v.y}px`;
      el.toggleAttribute("data-grid", grid && cell >= GRID_MIN_PX);
    };
    paint();
    return cv.subscribe(paint);
  }, [cv, grid]);

  return (
    <CanvasContext.Provider value={cv}>
      <div
        ref={boxCallback}
        className={cx("tz-cv", rulers && "has-rulers", cv.panning && "is-pan")}
        role="region"
        aria-label={t("canvas.label")}
        onPointerDown={(e) => {
          const el = e.target as HTMLElement;
          if (el === e.currentTarget || el.classList.contains("tz-cv-world")) onBackground?.(e.nativeEvent);
        }}
      >
        <div ref={cv.bindWorld} className="tz-cv-world">
          {children}
        </div>
        {rulers && <Rulers cv={cv} highlight={highlight} />}
        {overlay && (
          <div className="tz-cv-ov" data-tz-overlay="">
            {overlay}
          </div>
        )}
      </div>
    </CanvasContext.Provider>
  );
}

/** Yakınlaştırma yüzdesi: karede bir, yalnız kendisi çizilir. */
function ZoomValue({ cv }: { cv: CanvasView }) {
  canvasStats.zoomLabel++;
  const { t } = useTranslation("frame");
  const { view } = useViewState(cv, 0);
  return <b className="tz-zm-v tz-mono">{t("zoom.percent", { n: zoomPercent(view.zoom) })}</b>;
}

/**
 * Yakınlaştırma (durum satırının sağ ucu). Bağlıyken tuval kısayollarını da (Ctrl − / =, Shift 1, 1 / Shift 0,
 * Shift 2) `tuval` kapsamında etkinleştirir.
 */
export function ZoomControl({
  api,
  presets,
  onSelection,
  labels,
}: {
  api: ViewApi;
  presets: ("fit" | "actual" | "selection")[];
  onSelection?(): void;
  /**
   * Kısa düğme metinleri (maket: Düzelt "Sığdır · %100 · Seçime", Baskı "Hepsini sığdır · Gerçek boyut"). Verilmezse
   * "Sığdır", "Gerçek boyut", "Seçime" (adı "Seçime yakınlaştır"); ipucu yine komuttan. Düğmelerde ikon yok.
   */
  labels?: { fit?: string; actual?: string; selection?: string };
}) {
  const { t } = useTranslation("frame");
  const selection = useCommand("canvas.selection");
  useCommands("tuval", {
    "canvas.zoomIn": () => api.zoomIn(),
    "canvas.zoomOut": () => api.zoomOut(),
    "canvas.fit": () => api.fit(),
    "canvas.actual": () => api.actual(),
    ...(onSelection ? { "canvas.selection": () => onSelection() } : {}),
  });
  return (
    // aria-live="off": durum satırı canlı bölgedir; yüzde karede bir değişir, okunmasın.
    <div className="tz-zm" role="group" aria-label={t("zoom.label")} aria-live="off">
      <IconButton icon="minus" size={26} command="canvas.zoomOut" onClick={api.zoomOut} />
      <ZoomValue cv={api.canvas} />
      <IconButton icon="plus" size={26} command="canvas.zoomIn" onClick={api.zoomIn} />
      {presets.includes("fit") && (
        <Button size="mini" variant="quiet" command="canvas.fit" kbd={false} onClick={() => api.fit()}>
          {labels?.fit}
        </Button>
      )}
      {presets.includes("actual") && (
        <Button size="mini" variant="quiet" command="canvas.actual" kbd={false} onClick={api.actual}>
          {labels?.actual}
        </Button>
      )}
      {presets.includes("selection") && onSelection && (
        <Button size="mini" variant="quiet" command="canvas.selection" kbd={false} onClick={onSelection} aria-label={labels?.selection ? undefined : selection.label}>
          {labels?.selection ?? t("zoom.selection")}
        </Button>
      )}
    </div>
  );
}

export interface ArtboardProps {
  /** Dünya konumu (mm). */
  x: number;
  y: number;
  /**
   * Boyut (mm), isteğe bağlı. Verilirse kutu bu boyda çizilir ve görünür alanın dışındayken içeriği hiç çizilmez
   * (onlarca sayfalı masada başarım için); görünüme girince kendiliğinden çizilir.
   */
  w?: number;
  h?: number;
  /**
   * Üstteki ad ("V2 Alt alta"); yakınlaştırmadan bağımsız boyda yazılır. `w` verilirse ad satırı kutunun ekrandaki
   * genişliğini aşmaz (maket Baskı `.pgh`): ad üç noktayla kısalır, `tag` sağa yaslanır; yan yana kutuların adları
   * birbirine binmez.
   */
  name: ReactNode;
  tag?: ReactNode;
  selected?: boolean;
  /** Altında (öneri düğmeleri gibi); yakınlaştırmadan bağımsız boyda. */
  below?: ReactNode;
  children: ReactNode;
}

const noSubscribe = () => () => {};

/** Dikdörtgen görünür alanda (pay dahil) mı? Yalnız sonuç değişince yeniden çizdirir. */
function useInView(x: number, y: number, w?: number, h?: number): boolean {
  const cv = useContext(CanvasContext);
  const get = () => {
    if (!cv || w === undefined || h === undefined) return true;
    const s = cv.size();
    if (!s.w || !s.h) return true; // boyut henüz bilinmiyor
    const v = cv.get();
    const vp = worldViewport(v, s.w, s.h);
    const m = CULL_MARGIN_PX / v.zoom;
    return rectsIntersect({ x, y, w, h }, { x: vp.x - m, y: vp.y - m, w: vp.w + 2 * m, h: vp.h + 2 * m });
  };
  return useSyncExternalStore(cv?.subscribe ?? noSubscribe, get, get);
}

export function Artboard({ x, y, w, h, name, tag, selected, below, children }: ArtboardProps) {
  const visible = useInView(x, y, w, h);
  const box = { left: x, top: y, width: w, height: h };
  if (!visible) return <div className="tz-ab is-culled" style={box} data-tz-artboard="" />;
  return (
    <div className={cx("tz-ab", selected && "is-sel", w !== undefined && "has-w")} style={box} data-tz-artboard="">
      <div className="tz-ab-nm">
        <span className="tz-ab-n">{name}</span>
        {tag && <span className="tz-ab-tg">{tag}</span>}
      </div>
      {children}
      {below && <div className="tz-ab-below">{below}</div>}
    </div>
  );
}

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

/**
 * Dünya katmanında kayan ya da kesirli mm'de duran kutunun (`.tz-wrect`) stili: konum ve boyut CSS değişkeniyle.
 * Chrome dünya katmanındaki (`scale(zoom)`) bir kutunun `left/top/width/height`'ını boyamadan önce 1 dünya birimine
 * (1 mm = zoom kadar ekran pikseli) yuvarlar: yazı akarken çerçeve mm mm sıçrar, genişliği 1 mm büyüyüp küçülür.
 * `.tz-wrect` kutuyu ekran pikselinde çizer (konum `translate`, boyut × zoom, sonra `scale(1 / zoom)`); yuvarlama
 * ekran pikseline iner. İçindeki çizgi ve tutamaklar düz ekran pikseliyle yazılır.
 */
export function worldRectStyle(rect: Rect): CSSProperties {
  return { "--tz-x": rect.x, "--tz-y": rect.y, "--tz-w": rect.w, "--tz-h": rect.h } as CSSProperties;
}

/**
 * Seçim çerçevesi (dünya birimi); isteğe bağlı 8 tutamak ve altta ölçü ("38 × 38 mm"). Çerçeve tıklamayı geçirir;
 * tutamaklar yakalar: ekran `e.target.closest("[data-tz-handle]")?.dataset.tzHandle` ile hangi köşe olduğunu okur.
 * Ekran pikselli kutuda çizilir (`worldRectStyle`): sürüklerken yazıyla birlikte, yuvarlanmadan kayar.
 */
export function SelectionBox({ rect, handles, sizeLabel }: { rect: Rect; handles?: boolean; sizeLabel?: string }) {
  return (
    <div className="tz-selbox tz-wrect" style={worldRectStyle(rect)} aria-hidden="true">
      {handles && HANDLES.map((p) => <span key={p} className={`tz-hdl tz-hdl--${p}`} data-tz-handle={p} />)}
      {sizeLabel && <em className="tz-szb tz-mono">{sizeLabel}</em>}
    </div>
  );
}

/** Kesim çizgisi (pembe; yalnız baskı önizlemesinde gösterilir). `d`: `rect`'in sol üstüne göre mm. */
export function CutPath({ shape, d, rect }: { shape: "circle" | "rect" | "path"; d?: string; rect: Rect }) {
  return (
    <svg className="tz-cut" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} viewBox={`0 0 ${rect.w} ${rect.h}`} aria-hidden="true">
      {shape === "circle" && <ellipse cx={rect.w / 2} cy={rect.h / 2} rx={rect.w / 2} ry={rect.h / 2} />}
      {shape === "rect" && <rect x={0} y={0} width={rect.w} height={rect.h} />}
      {shape === "path" && d && <path d={d} />}
    </svg>
  );
}

/** Kesim işaretleri: köşelerde, kenardan 2 mm açıkta 5 mm çizgi. */
export function CropMarks({ rect }: { rect: Rect }) {
  const g = 2;
  const l = 5;
  const { w, h } = rect;
  const d = [
    `M${-g - l} 0h${l}M0 ${-g - l}v${l}`,
    `M${w + g} 0h${l}M${w} ${-g - l}v${l}`,
    `M${-g - l} ${h}h${l}M0 ${h + g}v${l}`,
    `M${w + g} ${h}h${l}M${w} ${h + g}v${l}`,
  ].join("");
  return (
    <svg className="tz-crop" style={{ left: rect.x - g - l, top: rect.y - g - l, width: w + 2 * (g + l), height: h + 2 * (g + l) }} viewBox={`${-g - l} ${-g - l} ${w + 2 * (g + l)} ${h + 2 * (g + l)}`} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** Tuvalin altında yüzen kutu ("Şunu değiştir"); `CanvasViewport`'un `overlay`'ine verilir. */
export function CanvasDock({ children }: { children: ReactNode }) {
  return <div className="tz-dock">{children}</div>;
}
