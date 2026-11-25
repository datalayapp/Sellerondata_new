import type { Rect } from "../../../../tezgah/tuval/canvas-math.ts";
import { r2 } from "../slot-geometry.ts";

/**
 * Sürüklerken akıllı kılavuz ve yapışma — SAF, birim mm (kâğıt koordinatı).
 *
 * Taşınan seçimin sınır kutusunun sol, orta ve sağ (üst, orta, alt) çizgisi şunlara yapışır: kâğıdın kenarları ve
 * ortası; öbür yuvaların kenarları ve merkezleri; aynı satırdaki (sütundaki) yuvalarla kâğıtta zaten kullanılan aralık
 * ("6 mm aralık") ve iki komşunun tam ortası ("eşit aralık"). Eşik ekranda sabit piksel (`SNAP_PX`), mm'ye çevrilip
 * verilir. Yapışma kapalıyken (anahtar ya da Alt basılı) kayma olduğu gibi kalır; ölçüler (komşuya ya da kâğıt
 * kenarına uzaklık) yine hesaplanır.
 */

/** Yapışma eşiği (ekran pikseli). */
export const SNAP_PX = 6;

export type GuideLabel = { kind: "paperCenter" } | { kind: "paperEdge" } | { kind: "slot"; ref: string } | { kind: "gap"; mm: number } | { kind: "equal" };

/** Kılavuz çizgisi: `axis` "x" ise dikey çizgi (x = `at`, y `from`…`to`), "y" ise yatay. */
export interface Guide {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
  label: GuideLabel;
}

/** Ölçü çizgisi: taşınan kutu ile komşusu (ya da kâğıt kenarı) arası; `axis` "x" ise yatay ölçü (y = `at`). */
export interface Measure {
  axis: "x" | "y";
  from: number;
  to: number;
  at: number;
  mm: number;
  /** Komşu yok: kâğıt kenarına uzaklık. */
  edge: boolean;
}

export interface SnapItem {
  id: string;
  r: Rect;
}

export interface SnapInput {
  /** Taşınan seçimin sürükleme başındaki sınır kutusu. */
  moving: Rect;
  /** Yerinde duran yuvalar (`id` kılavuz etiketinde görünür; okuma sırası numarası verilebilir). */
  others: readonly SnapItem[];
  paper: { wMm: number; hMm: number };
  /** İmlecin kaydırması (mm). */
  dx: number;
  dy: number;
  /** Eşik (mm). */
  tol: number;
  snap: boolean;
  /** Shift ile tek eksende sürüklerken öbür eksen yapışmaz. */
  axes?: { x: boolean; y: boolean };
  /** Kâğıtta kullanılan aralıklar (`commonGaps`); verilmezse burada hesaplanır. */
  gaps?: { x: number[]; y: number[] };
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
  measures: Measure[];
}

type Axis = "x" | "y";
const lo = (r: Rect, a: Axis) => (a === "x" ? r.x : r.y);
const len = (r: Rect, a: Axis) => (a === "x" ? r.w : r.h);
const hi = (r: Rect, a: Axis) => lo(r, a) + len(r, a);
const other = (a: Axis): Axis => (a === "x" ? "y" : "x");
/** İki kutu öbür eksende örtüşüyor mu (aynı satırda / sütunda)? */
const overlaps = (a: Rect, b: Rect, axis: Axis) => lo(a, other(axis)) < hi(b, other(axis)) - 0.01 && lo(b, other(axis)) < hi(a, other(axis)) - 0.01;
const EPS = 0.01;

/**
 * Kâğıtta kullanılan aralıklar (mm): her yuvadan aynı satırdaki (sütundaki) en yakın komşuya boşluk; en sık üç değer.
 * Sürükleme başında bir kez hesaplanır.
 */
export function commonGaps(items: readonly SnapItem[], axis: Axis, max = 3): number[] {
  const count = new Map<number, number>();
  for (const a of items) {
    let best = Infinity;
    for (const b of items) {
      if (a === b || !overlaps(a.r, b.r, axis)) continue;
      const g = lo(b.r, axis) - hi(a.r, axis);
      if (g > 0.05 && g < best) best = g;
    }
    if (best < 100) {
      const g = r2(best);
      count.set(g, (count.get(g) ?? 0) + 1);
    }
  }
  return [...count.entries()]
    .sort((p, q) => q[1] - p[1] || p[0] - q[0])
    .slice(0, max)
    .map(([g]) => g);
}

interface Hit {
  /** Kutunun yeni alt kenarı (`lo`) için düzeltme. */
  delta: number;
  dist: number;
  at: number;
  label: GuideLabel;
  /** Kılavuzun öbür eksendeki uzanımı (kâğıt boyu ya da hedef yuva). */
  span: [number, number] | null;
}

function snapAxis(box: Rect, axis: Axis, inp: SnapInput, gaps: number[]): Hit | null {
  const size = len(box, axis);
  const start = lo(box, axis);
  const edges = [start, start + size / 2, start + size];
  const paperLen = axis === "x" ? inp.paper.wMm : inp.paper.hMm;
  const paperSpan: [number, number] = [0, axis === "x" ? inp.paper.hMm : inp.paper.wMm];
  let best: Hit | null = null;
  const consider = (edgeIdx: number, target: number, label: GuideLabel, span: [number, number] | null) => {
    const d = target - edges[edgeIdx]!;
    const dist = Math.abs(d);
    if (dist > inp.tol) return;
    if (best && dist >= best.dist - 1e-9) return;
    best = { delta: d, dist, at: target, label, span };
  };
  // Kâğıt: önce ortası (eşit uzaklıkta ortası kazanır), sonra kenarları.
  consider(1, paperLen / 2, { kind: "paperCenter" }, paperSpan);
  for (const e of [0, 2]) {
    consider(e, 0, { kind: "paperEdge" }, paperSpan);
    consider(e, paperLen, { kind: "paperEdge" }, paperSpan);
  }
  for (const o of inp.others) {
    const t = [lo(o.r, axis), lo(o.r, axis) + len(o.r, axis) / 2, hi(o.r, axis)];
    const span: [number, number] = [lo(o.r, other(axis)), hi(o.r, other(axis))];
    consider(1, t[1]!, { kind: "slot", ref: o.id }, span);
    for (const e of [0, 2]) for (const v of [t[0]!, t[2]!]) consider(e, v, { kind: "slot", ref: o.id }, span);
  }
  // Aralık: aynı satırdaki (sütundaki) komşudan kâğıtta kullanılan boşluk kadar uzakta; iki komşunun tam ortasında.
  const band = inp.others.filter((o) => overlaps(box, o.r, axis));
  let before: SnapItem | null = null;
  let after: SnapItem | null = null;
  const mid = start + size / 2;
  for (const o of band) {
    if (hi(o.r, axis) <= mid && (!before || hi(o.r, axis) > hi(before.r, axis))) before = o;
    if (lo(o.r, axis) >= mid && (!after || lo(o.r, axis) < lo(after.r, axis))) after = o;
  }
  for (const g of gaps) {
    if (before) consider(0, hi(before.r, axis) + g, { kind: "gap", mm: g }, null);
    if (after) consider(2, lo(after.r, axis) - g, { kind: "gap", mm: g }, null);
  }
  const b = before as SnapItem | null;
  const a = after as SnapItem | null;
  if (b && a && lo(a.r, axis) - hi(b.r, axis) >= size) consider(0, (hi(b.r, axis) + lo(a.r, axis) - size) / 2, { kind: "equal" }, null);
  return best;
}

function measuresOf(box: Rect, inp: SnapInput): Measure[] {
  const out: Measure[] = [];
  for (const axis of ["x", "y"] as const) {
    const band = inp.others.filter((o) => overlaps(box, o.r, axis));
    let before: number | null = null;
    let after: number | null = null;
    for (const o of band) {
      if (hi(o.r, axis) <= lo(box, axis) + EPS && (before === null || hi(o.r, axis) > before)) before = hi(o.r, axis);
      if (lo(o.r, axis) >= hi(box, axis) - EPS && (after === null || lo(o.r, axis) < after)) after = lo(o.r, axis);
    }
    const at = lo(box, other(axis)) + len(box, other(axis)) / 2;
    const paperLen = axis === "x" ? inp.paper.wMm : inp.paper.hMm;
    const a0 = before ?? 0;
    const b1 = after ?? paperLen;
    const l = lo(box, axis) - a0;
    const r = b1 - hi(box, axis);
    if (l > 0.05) out.push({ axis, from: a0, to: lo(box, axis), at, mm: r2(l), edge: before === null });
    if (r > 0.05) out.push({ axis, from: hi(box, axis), to: b1, at, mm: r2(r), edge: after === null });
  }
  return out;
}

/** Sürükleme kaymasını yapıştırır; kılavuzlar ve ölçülerle döner. Yapışan eksende kayma tam hedefe (0,01 mm'ye yuvarlı). */
export function snapMove(inp: SnapInput): SnapResult {
  const axes = inp.axes ?? { x: true, y: true };
  let dx = inp.dx;
  let dy = inp.dy;
  const guides: Guide[] = [];
  const gaps = inp.gaps ?? { x: commonGaps(inp.others, "x"), y: commonGaps(inp.others, "y") };
  if (inp.snap) {
    // Satır/sütun bandı yapışmadan önceki yere göre; önce iki eksen ayrı ayrı, sonra kılavuz uzanımı son yere göre.
    const box0 = { ...inp.moving, x: inp.moving.x + dx, y: inp.moving.y + dy };
    const hx = axes.x ? snapAxis(box0, "x", inp, gaps.x) : null;
    const hy = axes.y ? snapAxis(box0, "y", inp, gaps.y) : null;
    if (hx) dx = r2(dx + hx.delta);
    if (hy) dy = r2(dy + hy.delta);
    const fin = { ...inp.moving, x: inp.moving.x + dx, y: inp.moving.y + dy };
    for (const [axis, h] of [["x", hx], ["y", hy]] as const) {
      if (!h || !h.span) continue;
      const own: [number, number] = [lo(fin, other(axis)), hi(fin, other(axis))];
      guides.push({ axis, at: h.at, from: Math.min(h.span[0], own[0]), to: Math.max(h.span[1], own[1]), label: h.label });
    }
    for (const [axis, h] of [["x", hx], ["y", hy]] as const) {
      if (h && !h.span) guides.push({ axis, at: h.at, from: lo(fin, other(axis)), to: hi(fin, other(axis)), label: h.label });
    }
  }
  const fin = { ...inp.moving, x: inp.moving.x + dx, y: inp.moving.y + dy };
  return { dx, dy, guides, measures: measuresOf(fin, inp) };
}
