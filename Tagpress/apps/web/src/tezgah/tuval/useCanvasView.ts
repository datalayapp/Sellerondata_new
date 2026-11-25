import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { actualSize, fitRect, panBy, type Pt, type Rect, toWorld, type View, wheelPan, wheelZoomFactor, ZOOM_STEP, zoomAt } from "./canvas-math.ts";

/**
 * Sonsuz tuval görünümü: kaydırma/yakınlaştırma React yeniden çizimi OLMADAN, dünya katmanının (`worldRef`) tek
 * dönüşümüyle uygulanır (SVG `<g>`: `transform` özniteliği; HTML: `style.transform` ve `--tz-zoom`). Görünüme bağlı
 * çizenler (cetvel, görünür sayfa seçimi, ayrıntı düzeyi) `useViewState` ile abone olur: cetvel her karede, ağır
 * olanlar hareket durunca ya da seyrek (`useSettledView`).
 *
 * - Ctrl/⌘ + tekerlek: imlece doğru yakınlaştırma; tekerlek: kaydırma (Shift ile yatay).
 * - Boşluk basılıyken sürükle ya da orta tuşla sürükle: kaydırma.
 * - Hareket sürerken kaba `data-moving` yazılır (CSS dünya katmanını o sürede ayrı katmanda tutar; durunca keskin
 *   yeniden çizim).
 */
export interface CanvasView {
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Tuval kabının `ref`'i (sonradan bağlanan kap için dinleyiciler o an kurulur). */
  bindContainer: (el: HTMLDivElement | null) => void;
  worldRef: React.RefObject<SVGGElement | HTMLElement | null>;
  /** Dünya katmanının `ref`'i (SVG `<g>` ya da HTML öğesi): bağlanır bağlanmaz dönüşüm yazılır. */
  bindWorld: (el: SVGGElement | HTMLElement | null) => void;
  get: () => View;
  set: (v: View) => void;
  size: () => { w: number; h: number };
  subscribe: (fn: () => void) => () => void;
  fit: (r: Rect | null, pad?: number) => void;
  actual: () => void;
  zoomBy: (f: number) => void;
  /** İstemci (clientX/Y) → dünya (mm). */
  clientToWorld: (x: number, y: number) => Pt;
  /** Kaydırma kipinde mi (boşluk basılı)? İmleç için. */
  panning: boolean;
}

/** Hareket bitti sayılmadan önceki bekleme (ms). */
const MOVING_IDLE = 160;

/** Boşluk tuşunu kendi işine kullanan odak: yazı alanı, düğme, bağlantı. */
function ownsSpace(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.tagName === "BUTTON" || el.tagName === "A" || el.isContentEditable);
}

/**
 * Açık pencere ya da açılır katman varken tuval tuşları çalışmaz; tuvalin kendisi o katmanın içindeyse (ör. büyük
 * düzenleme penceresi) çalışır. Tuvali içermeyen bir katman (üstteki onay penceresi, alttaki ekranın tuvali) engeller.
 */
function layerOpen(container: HTMLElement | null): boolean {
  const layers = document.querySelectorAll("dialog[open], [aria-modal='true'], [data-tz-layer]");
  return Array.from(layers).some((l) => !container || !l.contains(container));
}

const isSvg = (el: Element) => el.namespaceURI === "http://www.w3.org/2000/svg";

export function useCanvasView(opts: { initial?: View; onFirstSize?: (w: number, h: number) => void } = {}): CanvasView {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const bindContainer = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    setContainerEl(el);
  }, []);
  const worldRef = useRef<SVGGElement | HTMLElement | null>(null);
  const view = useRef<View>(opts.initial ?? { zoom: 1, x: 0, y: 0 });
  const sizeRef = useRef({ w: 0, h: 0 });
  const listeners = useRef(new Set<() => void>());
  const firstSize = useRef(opts.onFirstSize);
  firstSize.current = opts.onFirstSize;
  const [space, setSpace] = useState(false);
  const spaceRef = useRef(false);
  const movingTimer = useRef<number | undefined>(undefined);

  const writeTransform = useCallback(() => {
    const v = view.current;
    const el = worldRef.current;
    if (!el) return;
    if (isSvg(el)) el.setAttribute("transform", `translate(${v.x} ${v.y}) scale(${v.zoom})`);
    else {
      const s = (el as HTMLElement).style;
      s.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
      s.setProperty("--tz-zoom", String(v.zoom));
    }
  }, []);

  const markMoving = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (movingTimer.current === undefined) el.setAttribute("data-moving", "");
    else window.clearTimeout(movingTimer.current);
    movingTimer.current = window.setTimeout(() => {
      movingTimer.current = undefined;
      containerRef.current?.removeAttribute("data-moving");
    }, MOVING_IDLE);
  }, []);

  useEffect(() => () => window.clearTimeout(movingTimer.current), []);

  const apply = useCallback(() => {
    writeTransform();
    for (const l of listeners.current) l();
  }, [writeTransform]);

  const set = useCallback(
    (v: View) => {
      if (!Number.isFinite(v.zoom) || !Number.isFinite(v.x) || !Number.isFinite(v.y)) return;
      const p = view.current;
      if (p.zoom === v.zoom && p.x === v.x && p.y === v.y) return;
      view.current = v;
      markMoving();
      apply();
    },
    [apply, markMoving],
  );

  // Dünya katmanı (yeniden) bağlanınca dönüşümü yaz (dinleyicilere haber vermeden: döngü olmasın).
  useLayoutEffect(() => {
    writeTransform();
  });

  // Boyut (ResizeObserver'ın ölçüsü; zorunlu düzen hesabı yok).
  useEffect(() => {
    const el = containerEl;
    if (!el || typeof ResizeObserver === "undefined") return;
    let first = true;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[entries.length - 1]?.contentRect;
      const r = cr && (cr.width || cr.height) ? cr : el.getBoundingClientRect();
      if (r.width === sizeRef.current.w && r.height === sizeRef.current.h) return;
      sizeRef.current = { w: r.width, h: r.height };
      if (first && r.width > 0 && r.height > 0) {
        first = false;
        firstSize.current?.(r.width, r.height);
      }
      for (const l of listeners.current) l();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerEl]);

  const local = useCallback((clientX: number, clientY: number): Pt => {
    const r = containerRef.current?.getBoundingClientRect();
    return { x: clientX - (r?.left ?? 0), y: clientY - (r?.top ?? 0) };
  }, []);

  // Tekerlek (pasif olmayan dinleyici: tarayıcı yakınlaştırmasını engellemek için). Tuval üstündeki yüzen kutularda
  // (`[data-tz-overlay]`) düz tekerlek kutunun kendi kaydırmasına kalır.
  useEffect(() => {
    const el = containerEl;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const zoom = e.ctrlKey || e.metaKey;
      if (!zoom && (e.target as Element | null)?.closest?.("[data-tz-overlay]")) return;
      e.preventDefault();
      if (zoom) set(zoomAt(view.current, view.current.zoom * wheelZoomFactor(e.deltaY, e.deltaMode), local(e.clientX, e.clientY)));
      else {
        const d = wheelPan(e);
        set(panBy(view.current, d.dx, d.dy));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [containerEl, local, set]);

  // Boşluk tuşu: kaydırma kipi.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || ownsSpace(e.target) || layerOpen(containerEl)) return;
      e.preventDefault();
      if (!spaceRef.current) {
        spaceRef.current = true;
        setSpace(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !spaceRef.current) return;
      spaceRef.current = false;
      setSpace(false);
    };
    const blur = () => {
      if (!spaceRef.current) return;
      spaceRef.current = false;
      setSpace(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [containerEl]);

  // Kaydırma sürüklemesi (yakalama evresinde: tuvalin kendi işleyicilerinden önce).
  useEffect(() => {
    const el = containerEl;
    if (!el) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.button === 1 || (e.button === 0 && spaceRef.current))) return;
      e.preventDefault();
      e.stopPropagation();
      let lx = e.clientX;
      let ly = e.clientY;
      el.setPointerCapture?.(e.pointerId);
      el.setAttribute("data-dragging", "");
      const move = (m: PointerEvent) => {
        set(panBy(view.current, m.clientX - lx, m.clientY - ly));
        lx = m.clientX;
        ly = m.clientY;
      };
      const up = () => {
        el.removeAttribute("data-dragging");
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    };
    el.addEventListener("pointerdown", onDown, true);
    return () => el.removeEventListener("pointerdown", onDown, true);
  }, [containerEl, set]);

  return useMemo<CanvasView>(
    () => ({
      containerRef,
      bindContainer,
      worldRef,
      bindWorld: (el) => {
        worldRef.current = el;
        writeTransform();
      },
      get: () => view.current,
      set,
      size: () => sizeRef.current,
      subscribe: (fn) => {
        listeners.current.add(fn);
        return () => {
          listeners.current.delete(fn);
        };
      },
      fit: (r, pad) => {
        const { w, h } = sizeRef.current;
        if (r && w > 0 && h > 0) set(fitRect(r, w, h, pad));
      },
      actual: () => {
        const { w, h } = sizeRef.current;
        set(actualSize(view.current, w, h));
      },
      zoomBy: (f) => {
        const { w, h } = sizeRef.current;
        set(zoomAt(view.current, view.current.zoom * f, { x: w / 2, y: h / 2 }));
      },
      clientToWorld: (x, y) => toWorld(local(x, y), view.current),
      panning: space,
    }),
    [set, local, space, writeTransform, bindContainer],
  );
}

export interface ViewState {
  view: View;
  w: number;
  h: number;
}

/**
 * Görünüme abone ol. `idleMs` = 0: her değişiklikte (karede bir); > 0: hareket bu kadar durunca (ağır çizimler için).
 */
export function useViewState(cv: CanvasView, idleMs = 0): ViewState {
  const [state, setState] = useState<ViewState>(() => ({ view: cv.get(), ...cv.size() }));
  useEffect(() => {
    let raf = 0;
    let t: number | undefined;
    const take = () => setState({ view: cv.get(), ...cv.size() });
    const on = () => {
      if (idleMs > 0) {
        window.clearTimeout(t);
        t = window.setTimeout(take, idleMs);
      } else if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          take();
        });
      }
    };
    const off = cv.subscribe(on);
    take();
    return () => {
      off();
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [cv, idleMs]);
  return state;
}

/**
 * Seyrek görünüm: ilk değişiklik hemen (düğme, kısayol, tek tekerlek adımı gecikmesiz görünür), süren harekette en
 * çok `everyMs`'de bir, hareket bitince son hâl. Ekranın kendisi bununla yeniden çizilir; dünya katmanı ve cetvel
 * her karede ayrıca güncellenir.
 */
export function useSettledView(cv: CanvasView, everyMs = 120): ViewState {
  const [state, setState] = useState<ViewState>(() => ({ view: cv.get(), ...cv.size() }));
  useEffect(() => {
    let last = 0;
    let t: number | undefined;
    const take = () => {
      t = undefined;
      last = Date.now();
      setState((s) => {
        const v = cv.get();
        const z = cv.size();
        return s.view === v && s.w === z.w && s.h === z.h ? s : { view: v, ...z };
      });
    };
    const on = () => {
      if (t !== undefined) return;
      const wait = last + everyMs - Date.now();
      if (wait <= 0) take();
      else t = window.setTimeout(take, wait);
    };
    const off = cv.subscribe(on);
    take();
    return () => {
      off();
      window.clearTimeout(t);
    };
  }, [cv, everyMs]);
  return state;
}

export { ZOOM_STEP };
