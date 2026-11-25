import { type RefObject, useLayoutEffect, useSyncExternalStore } from "react";

/**
 * Katmanların ortak parçaları: konumlama (saf), açık katman yığını, portal hedefi, girdi kipi (klavye mi fare mi).
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Placement {
  left: number;
  top: number;
  side: "top" | "bottom";
  /** Seçilen yönde sığan en büyük yükseklik (px). */
  maxHeight: number;
}

/**
 * Paneli tetikleyiciye göre yerleştirir (SAF): tercih edilen yönde sığmazsa ve öbür yönde daha çok yer varsa
 * çevrilir; yatayda tetikleyiciye hizalanır (`start` sol kenar, `end` sağ kenar, `center` orta) ve pencere
 * kenarına `margin`'den fazla yaklaşmaz.
 */
export function placePanel(
  anchor: Box,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  opts: { side?: "top" | "bottom"; align?: "start" | "end" | "center"; gap?: number; margin?: number } = {},
): Placement {
  const { side: prefer = "bottom", align = "start", gap = 4, margin = 8 } = opts;
  const below = viewport.height - (anchor.top + anchor.height) - gap - margin;
  const above = anchor.top - gap - margin;
  const fitsPreferred = panel.height <= (prefer === "bottom" ? below : above);
  const side: "top" | "bottom" = fitsPreferred ? prefer : prefer === "bottom" ? (above > below ? "top" : "bottom") : below > above ? "bottom" : "top";
  const room = Math.max(0, side === "bottom" ? below : above);
  const h = Math.min(panel.height, room);
  const top = side === "bottom" ? anchor.top + anchor.height + gap : Math.max(margin, anchor.top - gap - h);
  const raw = align === "end" ? anchor.left + anchor.width - panel.width : align === "center" ? anchor.left + anchor.width / 2 - panel.width / 2 : anchor.left;
  const maxLeft = viewport.width - panel.width - margin;
  const left = maxLeft < margin ? margin : Math.max(margin, Math.min(raw, maxLeft));
  return { left, top, side, maxHeight: room };
}

/**
 * Paneli açıkken tetikleyiciye bağlı tutar: ilk konum boyamadan önce, sonra pencere boyutu, kaydırma ve iki öğenin
 * boyut değişiminde. Konum doğrudan stile yazılır (React çizimi yok).
 */
export function useAnchoredPosition(
  open: boolean,
  anchorRef: RefObject<Element | null>,
  panelRef: RefObject<HTMLElement | null>,
  opts: { side?: "top" | "bottom"; align?: "start" | "end" | "center"; gap?: number; limitHeight?: boolean },
  ready: unknown = true,
) {
  const { side, align, gap, limitHeight = true } = opts;
  useLayoutEffect(() => {
    if (!open || !ready) return;
    const place = () => {
      const a = anchorRef.current;
      const p = panelRef.current;
      if (!a || !p) return;
      const r = a.getBoundingClientRect();
      if (limitHeight) p.style.maxHeight = "";
      const pos = placePanel(
        { left: r.left, top: r.top, width: r.width, height: r.height },
        { width: p.offsetWidth, height: p.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        { side, align, gap },
      );
      p.style.left = `${pos.left}px`;
      p.style.top = `${pos.top}px`;
      if (limitHeight && pos.maxHeight > 0) p.style.maxHeight = `${pos.maxHeight}px`;
      p.dataset.side = pos.side;
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (ro && panelRef.current) ro.observe(panelRef.current);
    if (ro && anchorRef.current) ro.observe(anchorRef.current);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      ro?.disconnect();
    };
  }, [open, ready, anchorRef, panelRef, side, align, gap, limitHeight]);
}

/**
 * Portal hedefi: tetikleyici açık bir modal pencerenin (`<dialog>`) içindeyse o pencere (üst katmanda kalsın,
 * pencerenin odak tuzağı ve tıklanabilirliği bozulmasın), değilse `document.body`.
 */
export function portalHost(from: Element | null | undefined): HTMLElement {
  return (from?.closest("dialog[open]") as HTMLElement | null) ?? document.body;
}

// ---------------------------------------------------------------- açık pencereler (bildirimler en üsttekinin içine)

const dialogs: HTMLElement[] = [];
const dialogListeners = new Set<() => void>();
const emitDialogs = () => {
  for (const l of dialogListeners) l();
};

/** Açık modal pencereyi yığına koyar; dönen işlev çıkarır. */
export function pushDialog(el: HTMLElement): () => void {
  dialogs.push(el);
  emitDialogs();
  return () => {
    const i = dialogs.indexOf(el);
    if (i >= 0) dialogs.splice(i, 1);
    emitDialogs();
  };
}

/** En üstteki açık modal pencere (yoksa null); değişince yeniden çizer. */
export function useTopDialog(): HTMLElement | null {
  return useSyncExternalStore(
    (fn) => {
      dialogListeners.add(fn);
      return () => {
        dialogListeners.delete(fn);
      };
    },
    () => dialogs[dialogs.length - 1] ?? null,
    () => null,
  );
}

// ---------------------------------------------------------------- açık katman yığını (açılır kutu, menü)

const stack: HTMLElement[] = [];

export function pushLayer(el: HTMLElement): () => void {
  stack.push(el);
  return () => {
    const i = stack.indexOf(el);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** En üstteki (en son açılan) katman mı? Esc yalnız onu kapatır. */
export function isTopLayer(el: HTMLElement | null): boolean {
  return !!el && stack[stack.length - 1] === el;
}

/** Hedef bu katmanın ya da ondan sonra açılan (iç içe) bir katmanın içinde mi? */
export function insideLayer(el: HTMLElement | null, target: Node | null): boolean {
  if (!el || !target) return false;
  const i = stack.indexOf(el);
  const own = i >= 0 ? stack.slice(i) : [el];
  return own.some((l) => l.contains(target));
}

// ---------------------------------------------------------------- odaklanabilir öğeler

const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1']), [contenteditable='true']";

/** Klavyeyle ulaşılan öğeler (gizli ve devre dışı olanlar hariç), belge sırasıyla. */
export function focusables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hidden && !el.closest("[hidden], [inert]") && el.getAttribute("aria-hidden") !== "true");
}

// ---------------------------------------------------------------- girdi kipi

let modality: "keyboard" | "pointer" | "other" = "other";
/** Odağı klavyeyle gezdiren tuşlar: yalnız bunlardan sonraki odakta ipucu açılır (kısayolla açılan pencerenin ilk odağında değil). */
const NAV_KEYS = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
let tracking = false;

/** Son girdi klavyeyle gezinme mi (Tab, oklar)? İpucu bu odakta görünür; fareyle ya da kodla gelen odakta görünmez. */
export function lastInputWasKeyboard(): boolean {
  return modality === "keyboard";
}

export function trackInputModality() {
  if (tracking || typeof window === "undefined") return;
  tracking = true;
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      modality = NAV_KEYS.has(e.key) ? "keyboard" : "other";
    },
    true,
  );
  window.addEventListener("pointerdown", () => (modality = "pointer"), true);
}
