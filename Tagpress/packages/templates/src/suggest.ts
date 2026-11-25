import type { Point, Shape } from "@tagpress/domain";
import type { Grid } from "./raster.ts";

/**
 * Serbest maskeye sığan, çekim noktasına yakın en büyük eksen hizalı elips ya da dikdörtgen.
 * Birim: maske pikseli. Puan = alan × (1 − 0,6·(d/R)²); d = şekil merkezinin çekim noktasına uzaklığı.
 */
export interface FoundShape {
  kind: "ellipse" | "rect";
  cx: number;
  cy: number;
  /** Yarı genişlik / yarı yükseklik. */
  hw: number;
  hh: number;
  score: number;
}

const RATIOS = [0.5, 0.65, 0.8, 1, 1.25, 1.55, 1.9, 2.4, 3];

export function findLargestShape(free: Uint8Array, g: Grid, attract: Point, radius: number): FoundShape | null {
  // Satır başına engel öneki: blocked(y, x0, x1) = P[y][x1] − P[y][x0].
  const W1 = g.w + 1;
  const pre = new Int32Array(g.h * W1);
  for (let y = 0; y < g.h; y++) {
    let s = 0;
    for (let x = 0; x < g.w; x++) {
      s += free[y * g.w + x] ? 0 : 1;
      pre[y * W1 + x + 1] = s;
    }
  }
  const blockedRow = (y: number, x0: number, x1: number): boolean => {
    if (y < 0 || y >= g.h) return true;
    const a = Math.max(0, Math.floor(x0)), b = Math.min(g.w, Math.ceil(x1));
    if (x0 < 0 || x1 > g.w) return true;
    if (b <= a) return false;
    return pre[y * W1 + b]! - pre[y * W1 + a]! > 0;
  };
  const fits = (kind: "ellipse" | "rect", cx: number, cy: number, hw: number, hh: number): boolean => {
    const y0 = Math.floor(cy - hh), y1 = Math.ceil(cy + hh);
    for (let y = y0; y < y1; y++) {
      let half = hw;
      if (kind === "ellipse") {
        const dy = (y + 0.5 - cy) / hh;
        if (Math.abs(dy) > 1) continue;
        half = hw * Math.sqrt(1 - dy * dy);
      }
      if (blockedRow(y, cx - half, cx + half)) return false;
    }
    return true;
  };
  const weight = (cx: number, cy: number) => {
    const d = Math.hypot(cx - attract.x, cy - attract.y) / radius;
    return Math.max(0, 1 - 0.6 * d * d);
  };
  // Merkezden geçen yatay/dikey serbest koşu: şeklin üst sınırı (budama için).
  const run = (cx: number, cy: number) => {
    const x = Math.round(cx), y = Math.round(cy);
    if (x < 0 || y < 0 || x >= g.w || y >= g.h || !free[y * g.w + x]) return null;
    let l = x, r = x, u = y, d = y;
    while (l > 0 && free[y * g.w + l - 1]) l--;
    while (r < g.w - 1 && free[y * g.w + r + 1]) r++;
    while (u > 0 && free[(u - 1) * g.w + x]) u--;
    while (d < g.h - 1 && free[(d + 1) * g.w + x]) d++;
    return { hw: Math.min(x - l, r - x) + 0.5, hh: Math.min(y - u, d - y) + 0.5 };
  };

  let best: FoundShape | null = null;
  const tryAt = (cx: number, cy: number) => {
    const w = weight(cx, cy);
    if (w <= 0) return;
    const lim = run(cx, cy);
    if (!lim) return;
    for (const kind of ["ellipse", "rect"] as const) {
      const areaK = kind === "ellipse" ? Math.PI : 4;
      // Üst sınır budaması: elipste köşegen yönünde biraz daha geniş olabilir, kabaca 1.0 yeter.
      if (best && areaK * lim.hw * lim.hh * w <= best.score) continue;
      for (const ratio of RATIOS) {
        // hh'yi ikili arama ile büyüt; hw = ratio × hh.
        let lo = 0, hi = Math.min(lim.hh, lim.hw / ratio);
        if (best && areaK * ratio * hi * hi * w <= best.score) continue;
        if (hi < 1) continue;
        if (fits(kind, cx, cy, ratio * hi, hi)) lo = hi;
        else {
          for (let it = 0; it < 12 && hi - lo > 0.5; it++) {
            const mid = (lo + hi) / 2;
            if (fits(kind, cx, cy, ratio * mid, mid)) lo = mid;
            else hi = mid;
          }
        }
        if (lo < 1) continue;
        const score = areaK * ratio * lo * lo * w;
        if (!best || score > best.score) best = { kind, cx, cy, hw: ratio * lo, hh: lo, score };
      }
    }
  };

  // Kaba tarama, sonra en iyinin çevresinde ince tarama.
  const coarse = Math.max(2, Math.round(radius / 18));
  for (let cy = attract.y - radius; cy <= attract.y + radius; cy += coarse) {
    for (let cx = attract.x - radius; cx <= attract.x + radius; cx += coarse) tryAt(cx, cy);
  }
  if (!best) return null;
  const b0 = best as FoundShape;
  const fine = Math.max(1, Math.round(coarse / 4));
  for (let cy = b0.cy - coarse; cy <= b0.cy + coarse; cy += fine) {
    for (let cx = b0.cx - coarse; cx <= b0.cx + coarse; cx += fine) tryAt(cx, cy);
  }
  return best;
}

/** Bulunan şekli oran birimine çevirir (`k` = maske pikseli / oran birimi, yani framePx × ölçek). */
export function toRatioShape(s: FoundShape, k: number): Shape {
  const r = (v: number) => Math.round((v / k) * 10000) / 10000;
  if (s.kind === "ellipse") return { kind: "ellipse", cx: r(s.cx), cy: r(s.cy), rx: r(s.hw), ry: r(s.hh) };
  return { kind: "rect", x: r(s.cx - s.hw), y: r(s.cy - s.hh), w: r(2 * s.hw), h: r(2 * s.hh), radius: 0 };
}
