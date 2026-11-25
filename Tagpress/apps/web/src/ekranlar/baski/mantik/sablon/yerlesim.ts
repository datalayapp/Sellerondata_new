import { type PrintGridSpecInput, type PrintSlot, slotsInReadingOrder } from "@tagpress/domain";
import type { Rect } from "../../../../tezgah/tuval/canvas-math.ts";
import { generateGrid, type GridResult } from "../grid.ts";
import { r2, slotBounds } from "../slot-geometry.ts";

/**
 * Sayfa şablonunun yerleşimi (diziliş) ve kâğıda ortalama — SAF, birim mm.
 *
 * Düzenleyicinin "Temel" sekmesi yuvaları bir dizilişle anlatır: etiket şekli ve ölçüsü, sütun × satır, yatay ve
 * dikey aralık (kenardan kenara), "Kâğıda ortalı tut" ve (Gelişmiş'te) kaydırmalı dizilim. Diziliş değişince yuvalar
 * ızgara üreteciyle (`generateGrid`, sunucuyla aynı) yeniden dizilir. Ortalı tutulmuyorsa yerleşimin sol üst köşesi
 * yerinde kalır. Kâğıt değişince ortalı yerleşim yeni kâğıda ortalanır; ortalı değilse yuvalar olduğu yerde kalır.
 */

/** Yuvanın kâğıttaki dizilişi (ızgara üretecinin aralıklı biçimi). Dairede `wMm` = `hMm` = çap. */
export interface Layout {
  columns: number;
  rows: number;
  shape: PrintSlot["shape"];
  wMm: number;
  hMm: number;
  cornerRadiusMm: number;
  /** Yuvalar arası boşluk, kenardan kenara (mm). */
  gapXMm: number;
  gapYMm: number;
  /** Kâğıda ortalı tut: diziliş ve kâğıt değişince yerleşim ortada kalır. */
  center: boolean;
  stagger: { enabled: boolean; offsetXMm?: number; dropLast: boolean };
}

type Paper = { wMm: number; hMm: number };

/** Boş şablonda ve aralığı okunamayan yerleşimde varsayılan boşluk (mm). */
export const DEFAULT_GAP_MM = 6;
/** Yerleşim bu kadar içindeyse (mm) kâğıda ortalı sayılır. */
export const CENTER_TOL_MM = 0.1;
/** İki yerleşim karşılaştırmasında konum payı (mm). */
const MATCH_TOL_MM = 0.05;
/** Aynı satır sayılan merkez farkı (mm; okuma sırasıyla aynı). */
const ROW_TOL = 2;

/** Yuvaların ortak sınır kutusu; boşsa null. */
export function slotsBounds(slots: readonly PrintSlot[]): Rect | null {
  if (!slots.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of slots) {
    const b = slotBounds(s);
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Kenar payları: yerleşimin kâğıt kenarlarına uzaklığı (mm, 0,01'e yuvarlı; taşan yerleşimde eksi). Yuva yoksa null. */
export function layoutMargins(slots: readonly PrintSlot[], paper: Paper): { left: number; right: number; top: number; bottom: number } | null {
  const b = slotsBounds(slots);
  if (!b) return null;
  return { left: r2(b.x), right: r2(paper.wMm - b.x - b.w), top: r2(b.y), bottom: r2(paper.hMm - b.y - b.h) };
}

/** Yerleşim kâğıda ortalı mı (iki eksende de)? Yuva yoksa evet. */
export function isCentered(slots: readonly PrintSlot[], paper: Paper, tol = CENTER_TOL_MM): boolean {
  const b = slotsBounds(slots);
  if (!b) return true;
  return Math.abs(b.x + b.w / 2 - paper.wMm / 2) <= tol && Math.abs(b.y + b.h / 2 - paper.hMm / 2) <= tol;
}

export type CenterAxes = "x" | "y" | "xy";

/**
 * Kâğıda ortala: seçim boşsa (ya da `ids` null) bütün yerleşim, değilse seçili yuvalar BİR GRUP olarak (aralar
 * korunur). Yer değişmezse aynı dizi döner.
 */
export function centerOnPaper(slots: readonly PrintSlot[], ids: ReadonlySet<string> | null, paper: Paper, axes: CenterAxes): PrintSlot[] {
  const all = !ids || ids.size === 0;
  const group = all ? slots : slots.filter((s) => ids.has(s.id));
  const b = slotsBounds(group);
  if (!b) return slots as PrintSlot[];
  const dx = axes === "y" ? 0 : paper.wMm / 2 - (b.x + b.w / 2);
  const dy = axes === "x" ? 0 : paper.hMm / 2 - (b.y + b.h / 2);
  if (Math.abs(dx) < 0.005 && Math.abs(dy) < 0.005) return slots as PrintSlot[];
  return slots.map((s) => (all || ids.has(s.id) ? { ...s, cx: r2(s.cx + dx), cy: r2(s.cy + dy) } : s));
}

/** Bütün yerleşimi kaydırır (Gelişmiş › kenar payı: sol ya da üst payı verilen değere getirir). */
export function moveLayoutTo(slots: readonly PrintSlot[], edge: "left" | "top", mm: number): PrintSlot[] {
  const b = slotsBounds(slots);
  if (!b) return slots as PrintSlot[];
  const d = edge === "left" ? mm - b.x : mm - b.y;
  if (Math.abs(d) < 0.005) return slots as PrintSlot[];
  return slots.map((s) => (edge === "left" ? { ...s, cx: r2(s.cx + d) } : { ...s, cy: r2(s.cy + d) }));
}

/**
 * Kâğıt değişince yuvalar: ortalı tutuluyorsa yerleşim yeni kâğıda ortalanır (aralar korunur), değilse olduğu yerde
 * kalır.
 */
export function slotsForPaper(slots: readonly PrintSlot[], paper: Paper, keepCentered: boolean): PrintSlot[] {
  return keepCentered ? centerOnPaper(slots, null, paper, "xy") : (slots as PrintSlot[]);
}

const median = (xs: number[]): number | undefined => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function rowsOf(slots: readonly PrintSlot[]): PrintSlot[][] {
  const rows: PrintSlot[][] = [];
  for (const s of [...slots].sort((a, b) => a.cy - b.cy)) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0]!.cy - s.cy) < ROW_TOL) row.push(s);
    else rows.push([s]);
  }
  return rows.map((r) => r.sort((a, b) => a.cx - b.cx));
}

/**
 * Var olan yuvalardan diziliş: satırlar merkez yüksekliğiyle (okuma sırası payıyla) gruplanır; sütun en kalabalık satır,
 * aralık ardışık merkez farklarının ortancası eksi yuva ölçüsü. İkinci satır yana kaymışsa kaydırmalı dizilim. Yuva
 * yoksa varsayılan: 4 × 6, `fallback` ölçüsünde daire, 6 mm aralık, ortalı.
 */
export function layoutOf(paper: Paper, slots: readonly PrintSlot[], fallback: { w: number; h: number }): Layout {
  if (!slots.length) {
    return { columns: 4, rows: 6, shape: "circle", wMm: fallback.w, hMm: fallback.w, cornerRadiusMm: 0, gapXMm: DEFAULT_GAP_MM, gapYMm: DEFAULT_GAP_MM, center: true, stagger: { enabled: false, dropLast: false } };
  }
  const first = slotsInReadingOrder(slots)[0]!;
  const rows = rowsOf(slots);
  const dxs = rows.flatMap((r) => r.slice(1).map((s, i) => s.cx - r[i]!.cx));
  const rowY = rows.map((r) => r.reduce((a, s) => a + s.cy, 0) / r.length);
  const dys = rowY.slice(1).map((y, i) => y - rowY[i]!);
  const px = median(dxs);
  const py = median(dys);
  let gx = px === undefined ? undefined : Math.max(0, r2(px - first.w));
  let gy = py === undefined ? undefined : Math.max(0, r2(py - first.h));
  gx ??= gy ?? DEFAULT_GAP_MM;
  gy ??= gx;
  const shift = rows.length > 1 ? r2(rows[1]![0]!.cx - rows[0]![0]!.cx) : 0;
  const staggered = Math.abs(shift) > MATCH_TOL_MM && rows.length > 1;
  const dropLast = staggered && rows[1]!.length === rows[0]!.length - 1;
  return {
    columns: Math.max(1, Math.min(200, staggered ? rows[0]!.length : Math.max(...rows.map((r) => r.length)))),
    rows: Math.max(1, Math.min(200, rows.length)),
    shape: first.shape,
    wMm: first.w,
    hMm: first.shape === "circle" ? first.w : first.h,
    cornerRadiusMm: first.shape === "rect" ? (first.cornerRadius ?? 0) : 0,
    gapXMm: gx,
    gapYMm: gy,
    center: isCentered(slots, paper),
    stagger: staggered ? { enabled: true, offsetXMm: shift, dropLast } : { enabled: false, dropLast: false },
  };
}

/**
 * Izgara üretecinin girdisi. Ortalı değilse yerleşimin sol üst köşesi `anchor`'da kalır (yuva yoksa ortalanır).
 */
export function layoutSpec(l: Layout, paper: Paper, anchor: readonly PrintSlot[] = []): PrintGridSpecInput {
  const b = l.center ? null : slotsBounds(anchor);
  return {
    paper,
    columns: l.columns,
    rows: l.rows,
    shape: l.shape,
    ...(l.shape === "circle" ? { diameterMm: l.wMm } : { wMm: l.wMm, hMm: l.hMm }),
    cornerRadiusMm: l.shape === "rect" ? l.cornerRadiusMm : 0,
    gapXMm: l.gapXMm,
    gapYMm: l.gapYMm,
    center: !b,
    ...(b ? { marginLeftMm: Math.max(0, r2(b.x)), marginTopMm: Math.max(0, r2(b.y)) } : {}),
    stagger: l.stagger.enabled ? { enabled: true, offsetXMm: l.stagger.offsetXMm, dropLast: l.stagger.dropLast } : { enabled: false, dropLast: false },
  };
}

/** Dizilişin yuvaları (yeniden diz). Ortalı değilse yerleşimin sol üst köşesi `current` yuvalarınkinde kalır. */
export function layoutSlots(l: Layout, paper: Paper, current: readonly PrintSlot[] = []): GridResult {
  return generateGrid(layoutSpec(l, paper, current));
}

/**
 * Yuvalar bu dizilişe uyuyor mu (yer değiştirmeden bağımsız: bütün yerleşimi taşımak bozmaz)? Uymuyorsa yuvalar elle
 * taşınmış, eklenmiş ya da silinmiştir; yeniden dizmeden önce sorulur. Yuva yoksa uyar.
 */
export function layoutMatches(l: Layout, paper: Paper, slots: readonly PrintSlot[]): boolean {
  if (!slots.length) return true;
  const gen = layoutSlots(l, paper, slots);
  if (gen.error || gen.slots.length !== slots.length) return false;
  const a = slotsInReadingOrder(slots);
  const b = gen.slots;
  const dx = a[0]!.cx - b[0]!.cx;
  const dy = a[0]!.cy - b[0]!.cy;
  return a.every((s, i) => {
    const g = b[i]!;
    return (
      s.shape === g.shape &&
      !(s.rotation ?? 0) &&
      Math.abs(s.w - g.w) < 0.01 &&
      Math.abs(s.h - g.h) < 0.01 &&
      Math.abs(s.cx - g.cx - dx) < MATCH_TOL_MM &&
      Math.abs(s.cy - g.cy - dy) < MATCH_TOL_MM
    );
  });
}

/** Yuva sayısı (kaydırmalı dizilimde son yuvası atılan satırlar eksik). */
export function layoutCount(l: Pick<Layout, "columns" | "rows" | "stagger">): number {
  if (!l.stagger.enabled || !l.stagger.dropLast) return l.columns * l.rows;
  return l.columns * l.rows - Math.floor(l.rows / 2);
}

/**
 * Kâğıda eşit dağıt: kenar payları ile yuva aralıkları eşit olacak boşluklar (ızgara üretecinin "eşit dağıt" kipi).
 * Sığmıyorsa null.
 */
export function evenLayout(l: Layout, paper: Paper): Layout | null {
  const spec = layoutSpec({ ...l, center: true }, paper);
  const r = generateGrid({ ...spec, gapXMm: undefined, gapYMm: undefined });
  if (r.error || r.gapX < 0 || r.gapY < 0) return null;
  return { ...l, center: true, gapXMm: l.columns > 1 ? r.gapX : l.gapXMm, gapYMm: l.rows > 1 ? r.gapY : l.gapYMm };
}

/** Adım (merkezden merkeze) → aralık (kenardan kenara). */
export function gapFromPitch(pitch: number, size: number): number {
  return Math.max(0, r2(pitch - size));
}
