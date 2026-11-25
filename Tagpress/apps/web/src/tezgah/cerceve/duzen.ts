import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { RouteId, ScreenKind } from "../../lib/route.ts";

/**
 * Ekranın yerleşimi (ARAYUZ-PLANI "Yerleşim"): tür (`lib/route.ts` `screenKind`) ve rota kimliği. Rotayı çizen
 * `TezgahApp` verir; `AppFrame` (sütun ya da geniş), `Workspace` (tablette çekmece) ve `WorkRow` (panel düğmeleri)
 * okur. Sağlayıcı yoksa (tek bileşen testleri) `null`: bugünkü geniş düzen, çekmece yok.
 */
export interface ScreenLayout {
  kind: ScreenKind;
  routeId: RouteId;
}

export const ScreenLayoutContext = createContext<ScreenLayout | null>(null);

export function useScreenLayout(): ScreenLayout | null {
  return useContext(ScreenLayoutContext);
}

/** Telefon kırılımı: kabukla aynı (≤ 760 px). Tablet 761–1023 px, kurallar CSS'te. */
export const PHONE_QUERY = "(max-width: 760px)";

const matches = (query: string) => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;

/** Ortam sorgusu (pencere daralıp genişleyince yeniden çizer). `matchMedia` yoksa `false`. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (on: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
      const m = window.matchMedia(query);
      m.addEventListener("change", on);
      return () => m.removeEventListener("change", on);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => matches(query),
    () => false,
  );
}

// ---------------------------------------------------------------- tablet çekmeceleri

export type DrawerSide = "left" | "right";

export interface DrawerState {
  /** Açık çekmece (aynı anda en çok bir). */
  open: DrawerSide | null;
  /** Ekranda kaç çalışma alanının sol / sağ paneli var (iş satırındaki düğmeler buna göre çıkar). */
  left: number;
  right: number;
}

let drawers: DrawerState = { open: null, left: 0, right: 0 };
const listeners = new Set<() => void>();

function setDrawers(next: DrawerState) {
  drawers = next;
  for (const l of listeners) l();
}

/**
 * Çalışma alanı panellerini bildirir; dönen işlev geri alır. Paneli kalmayan yanın çekmecesi kapanır (ekran
 * değişince açık çekmece yeni ekrana taşınmaz).
 */
export function registerPanels(left: boolean, right: boolean): () => void {
  setDrawers({ ...drawers, left: drawers.left + (left ? 1 : 0), right: drawers.right + (right ? 1 : 0) });
  return () => {
    const l = drawers.left - (left ? 1 : 0);
    const r = drawers.right - (right ? 1 : 0);
    const open = (drawers.open === "left" && l === 0) || (drawers.open === "right" && r === 0) ? null : drawers.open;
    setDrawers({ open, left: l, right: r });
  };
}

export function toggleDrawer(side: DrawerSide): void {
  setDrawers({ ...drawers, open: drawers.open === side ? null : side });
}

const subscribeDrawers = (on: () => void) => {
  listeners.add(on);
  return () => {
    listeners.delete(on);
  };
};

export function useDrawers(): DrawerState {
  return useSyncExternalStore(
    subscribeDrawers,
    () => drawers,
    () => drawers,
  );
}
