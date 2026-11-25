import type { Point, TemplateGeometry } from "@tagpress/domain";
import type { Block } from "./compose.ts";

/**
 * fit: blok + geometri → konum. Tamamen analitik (raster yok): bloğun her piksel satırındaki mürekkep genişliği
 * (glif kutularından) geometrinin o satırdaki serbest aralıklarından birine sığmalı.
 * Konum araması hedef merkezden dışa doğru yapılır; yatay kayma dikeyin iki katı pahalıdır (dikey öncelik).
 */

type Interval = [number, number];

export interface FreeRows {
  /** Satır çözünürlüğü (satır / tasarım px). */
  S: number;
  /** Her satırın serbest aralıkları (tasarım px), soldan sağa. */
  rows: Interval[][];
  /** Her satırdaki en geniş aralık. */
  widest: Float64Array;
}

const rowsCache = new WeakMap<TemplateGeometry, FreeRows>();

/**
 * Geometrinin serbest satırları. `rows` doluysa o kullanılır (satır sayısından çözünürlük, aralıkların birimi
 * çerçeveyi aşıyorsa maske px kabul edilip çevrilir); boşsa `free` maskesinden çıkarılır.
 */
export function freeRows(g: TemplateGeometry): FreeRows {
  const hit = rowsCache.get(g);
  if (hit) return hit;
  let S: number;
  let rows: Interval[][];
  if (g.rows.length) {
    S = g.rows.length / g.framePx;
    let maxX = 0;
    for (const r of g.rows) for (const iv of r) if (iv[1] > maxX) maxX = iv[1];
    const unit = maxX > g.framePx * 1.05 ? 1 / S : 1;
    rows = g.rows.map((r) => r.map(([a, b]) => [a * unit, b * unit] as Interval).sort((p, q) => p[0] - q[0]));
  } else {
    const f = g.free;
    S = f.scale;
    rows = [];
    for (let y = 0; y < f.height; y++) {
      const row: Interval[] = [];
      let start = -1;
      for (let x = 0; x <= f.width; x++) {
        const on = x < f.width && f.data[y * f.width + x]! > 0;
        if (on && start < 0) start = x;
        else if (!on && start >= 0) {
          row.push([start / S, x / S]);
          start = -1;
        }
      }
      rows.push(row);
    }
  }
  const widest = new Float64Array(rows.length);
  rows.forEach((r, i) => {
    let w = 0;
    for (const [a, b] of r) if (b - a > w) w = b - a;
    widest[i] = w;
  });
  const out = { S, rows, widest };
  rowsCache.set(g, out);
  return out;
}

/** Bloğun satır profili: her satır için gereken [lo, hi] (blok x'ine göre). İlk taban çizgisi satırı = 0. */
export interface RowProfile {
  r0: number;
  lo: Float64Array;
  hi: Float64Array;
}

export function rowProfile(block: Block, S: number): RowProfile {
  const r0 = Math.floor(block.ink.y0 * S);
  const r1 = Math.ceil(block.ink.y1 * S);
  const n = Math.max(1, r1 - r0);
  const lo = new Float64Array(n).fill(Infinity);
  const hi = new Float64Array(n).fill(-Infinity);
  block.lines.forEach((line, i) => {
    const bx = block.xs[i]!;
    const by = block.baselines[i]!;
    for (const b of line.boxes) {
      const a = Math.floor((b.y0 + by) * S) - r0;
      const z = Math.ceil((b.y1 + by) * S) - r0;
      const x0 = b.x0 + bx, x1 = b.x1 + bx;
      for (let r = Math.max(0, a); r < Math.min(n, z); r++) {
        if (x0 < lo[r]!) lo[r] = x0;
        if (x1 > hi[r]!) hi[r] = x1;
      }
    }
  });
  return { r0, lo, hi };
}

function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i]![0], b[j]![0]);
    const hi = Math.min(a[i]![1], b[j]![1]);
    if (lo <= hi) out.push([lo, hi]);
    if (a[i]![1] < b[j]![1]) i++;
    else j++;
  }
  return out;
}

/** İlk taban çizgisi `Yrow` satırındayken bloğun konabileceği x aralıkları. */
function feasibleX(fr: FreeRows, prof: RowProfile, Yrow: number): Interval[] {
  let set: Interval[] = [[-Infinity, Infinity]];
  const n = prof.lo.length;
  // Önce uçlardaki satırlar (en sık onlar takılır), sonra ortası.
  for (let t = 0; t < n; t++) {
    const r = t % 2 === 0 ? t >> 1 : n - 1 - (t >> 1);
    const lo = prof.lo[r]!, hi = prof.hi[r]!;
    if (lo === Infinity) continue;
    const R = Yrow + prof.r0 + r;
    if (R < 0 || R >= fr.rows.length) return [];
    const need = hi - lo;
    if (fr.widest[R]! < need) return [];
    const allowed: Interval[] = [];
    for (const [a, b] of fr.rows[R]!) if (b - a >= need) allowed.push([a - lo, b - hi]);
    set = intersect(set, allowed);
    if (!set.length) return [];
  }
  return set;
}

export interface Placement {
  /** Blok referans x'i (tasarım px). */
  x: number;
  /** İlk satırın taban çizgisi (tasarım px). */
  y: number;
  /** Hedefe uzaklık maliyeti (px). */
  cost: number;
}

/**
 * Bloğu serbest alana sığan, mürekkep merkezi hedefe en yakın konuma koyar. `any`: ilk bulunan konumla dön
 * (yalnızca sığıyor mu sorusu için).
 */
export function placeBlock(fr: FreeRows, block: Block, target: Point, any = false): Placement | null {
  const S = fr.S;
  if ((block.ink.y1 - block.ink.y0) * S > fr.rows.length) return null;
  const prof = rowProfile(block, S);
  const idealX = target.x - (block.ink.x0 + block.ink.x1) / 2;
  const idealY = target.y - (block.ink.y0 + block.ink.y1) / 2;
  const idealRow = Math.round(idealY * S);
  let best: Placement | null = null;
  const maxD = fr.rows.length;
  for (let d = 0; d <= maxD; d++) {
    if (best && d / S > best.cost) break;
    for (const sign of d === 0 ? [0] : [-1, 1]) {
      const Yrow = idealRow + sign * d;
      const set = feasibleX(fr, prof, Yrow);
      if (!set.length) continue;
      let x = idealX;
      let dx = Infinity;
      for (const [a, b] of set) {
        const c = Math.min(b, Math.max(a, idealX));
        if (Math.abs(c - idealX) < dx) {
          dx = Math.abs(c - idealX);
          x = c;
        }
      }
      const y = Yrow / S;
      const cost = Math.abs(y - idealY) + 2 * dx;
      if (!best || cost < best.cost) best = { x, y, cost };
      if (any) return best;
    }
  }
  return best;
}

/** Bloğun sığdığı en büyük ana punto (ikili arama). Sığmıyorsa 0. */
export function maxScale(fits: (k: number) => boolean, lo: number, hi: number, precision = 0.2): number {
  if (!fits(lo)) return 0;
  if (fits(hi)) return hi;
  while (hi - lo > precision) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}
