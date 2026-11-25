import type { VariantAdjust } from "@tagpress/domain";
import { formatNumber } from "../../i18n/bicim.ts";
import { type Corner, handleScale, lineAdjustOf, scaleSelectionAbout, type Sel, selectionBox, selectionScale, selIndices, shiftSelection } from "./mantik/adjust-select.ts";

/**
 * Konum alanları ve seçim tutamakları (saf). Birim tasarım pikseli.
 * Konum: seçimin ekranda görünen kaydırması. Bütün yazıda blok kaydırması; satırda satır kaydırması × blok ölçeği
 * (satır kaydırması blok ölçeğinden önce uygulanır); birkaç satırda ilk satırınki, yeni değer hepsine aynı farkla.
 */

type Layout = Parameters<typeof selectionBox>[0];

export function offsetOf(a: VariantAdjust, sel: Sel): { x: number; y: number } {
  if (sel === null || !sel.length) return { x: a.dx, y: a.dy };
  const la = lineAdjustOf(a, sel[0]!);
  const S = a.scale || 1;
  return { x: Math.round(la.dx * S * 100) / 100, y: Math.round(la.dy * S * 100) / 100 };
}

/** Seçimin konumunu bir eksende `value` yapar (fark kadar kaydırır). */
export function withOffset(a: VariantAdjust, sel: Sel, axis: "x" | "y", value: number): VariantAdjust {
  const d = value - offsetOf(a, sel)[axis];
  if (Math.abs(d) < 0.005) return a;
  return shiftSelection(a, sel, axis === "x" ? d : 0, axis === "y" ? d : 0);
}

/** Alana yazılan sayı: virgül ya da nokta ondalık, "−" eksi; boşluklar yok sayılır. Geçersizse null. */
export function parseOffset(text: string): number | null {
  const s = text.replace(/\s+/g, "").replace(/[−–]/g, "-").replace(",", ".");
  if (!s || s === "-" || s === ".") return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

/** Alanda gösterilen sayı (işaretli, en çok iki ondalık, etkin dilde). */
export function formatOffset(v: number): string {
  const r = Math.round(v * 100) / 100 || 0;
  return formatNumber(r, { maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------- tutamaklar

/** Tuvaldeki seçim çerçevesinin sekiz tutamağı (`SelectionBox`). */
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const CORNER_SET = new Set<string>(["nw", "ne", "se", "sw"]);

export const isHandle = (v: string | undefined): v is Handle => !!v && /^(nw|n|ne|e|se|s|sw|w)$/.test(v);

/**
 * Tutamakla orantılı ölçek. Köşe: karşı köşe sabit (bugünkü `handleScale`). Kenar: karşı kenarın ortası sabit; oran,
 * imlecin o kenara dik uzaklığının başlangıçtakine oranıdır. Yazı her zaman orantılı büyür (en/boy oranı korunur).
 */
export function dragHandle(layout: Layout, start: VariantAdjust, sel: Sel, h: Handle, pointer: { x: number; y: number }): VariantAdjust {
  if (CORNER_SET.has(h)) return handleScale(layout, start, sel, h as Corner, pointer);
  const b = selectionBox(layout, start, sel);
  const mid = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const axis = h === "n" || h === "s" ? "y" : "x";
  const edge = h === "n" ? b.y : h === "s" ? b.y + b.h : h === "w" ? b.x : b.x + b.w;
  const anchorV = h === "n" ? b.y + b.h : h === "s" ? b.y : h === "w" ? b.x + b.w : b.x;
  const len = edge - anchorV;
  if (Math.abs(len) < 1e-6) return start;
  const f = Math.max(0.05, (pointer[axis] - anchorV) / len);
  const anchor = axis === "y" ? { x: mid.x, y: anchorV } : { x: anchorV, y: mid.y };
  return scaleSelectionAbout(layout, start, sel, selectionScale(start, selIndices(sel, layout.lines.length)) * f, anchor);
}
