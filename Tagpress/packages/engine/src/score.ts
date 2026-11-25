import type { Box, LayoutScore, Point } from "@tagpress/domain";

/**
 * score: az sayıda açıklanabilir bileşen (0..100). Ağırlıkların tek yeri burası.
 *  - doluluk:   hedeflenen boyuta ulaşıldı mı (çarpışma küçültmesi düşürür)
 *  - denge:     bloğun mürekkep merkezi hedef merkeze ne kadar yakın (alan boyutuna göre)
 *  - nefes:     nefes payına (serbest alan dışına) taşan mürekkep oranı
 *  - okunurluk: en küçük satır okunurluk sınırına göre
 */
export const SCORE_WEIGHTS = { fill: 0.3, balance: 0.3, breathing: 0.2, legibility: 0.2 } as const;

export interface ScoreInput {
  /** Uygulanan ve hedeflenen ana punto. */
  basePx: number;
  expectedPx: number;
  ink: Box;
  target: Point;
  area: Box;
  inkPx: number;
  outsideFreePx: number;
  smallestPx: number;
  readablePx: number;
}

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

export function scoreLayout(s: ScoreInput): LayoutScore {
  const fill = clamp(100 * Math.min(1, s.basePx / Math.max(1e-6, s.expectedPx)));
  const cx = (s.ink.x + s.ink.x + s.ink.w) / 2;
  const cy = (s.ink.y + s.ink.y + s.ink.h) / 2;
  const off = Math.hypot((cx - s.target.x) / Math.max(1, s.area.w), (cy - s.target.y) / Math.max(1, s.area.h));
  const balance = clamp(100 - 300 * Math.max(0, off - 0.02));
  const breathing = clamp(s.inkPx ? 100 - 2000 * (s.outsideFreePx / s.inkPx) : 100);
  const legibility = clamp(s.smallestPx >= s.readablePx ? 100 : 100 - 300 * (1 - s.smallestPx / s.readablePx));
  const parts = { fill, balance, breathing, legibility };
  const total = clamp(
    SCORE_WEIGHTS.fill * fill + SCORE_WEIGHTS.balance * balance + SCORE_WEIGHTS.breathing * breathing + SCORE_WEIGHTS.legibility * legibility,
  );
  return { total, parts };
}
