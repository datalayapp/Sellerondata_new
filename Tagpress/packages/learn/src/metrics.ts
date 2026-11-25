import type { ReplayMetrics } from "@tagpress/engine";
import type { RefDiff } from "./diff.ts";
import { median, round } from "./stats.ts";

/**
 * Değerlendirme ölçüleri (AI'sız tekrar sonuçlarından). Arayüz anahtarları okur: `sizeError` ve `positionError`
 * bilinen etiketlerle gösterilir; diğerleri adından.
 */
export interface EvalMetrics {
  /** Tekrar edilen etiket sayısı. */
  n: number;
  /** Yerleşmeyen. */
  failed: number;
  /** En büyük satır boyutu ±%10 içinde olan etiket sayısı. */
  within10: number;
  /** Aynısı, oran (0..1). */
  sizeWithin10: number;
  /** |motor/kullanıcı − 1| medyanı. */
  sizeError: number;
  /** motor/kullanıcı medyanı. */
  sizeRatio: number;
  /** |blok yüksekliği oranı − 1| medyanı. */
  heightError: number;
  /** Blok merkezi uzaklığı medyanı (px). */
  positionError: number;
  dx: number;
  dy: number;
  /** |motor − kullanıcı| görünen boşluk farkı medyanı, türüne göre (yaklaşık satırlar hariç). */
  gapNormal: number | null;
  gapBeforeLast: number | null;
  gapConnector: number | null;
}

/** Referans → yaklaşık (gerçek ölçüm olmayan) boşluk dizinleri (tekrar düzeneğinin `gaps[k]` ↔ dizin k+1). */
export function approxGapIndex(diffs: readonly RefDiff[]): Map<string, Set<number>> {
  return new Map(diffs.map((d) => [d.id, new Set(d.user.gaps.filter((g) => g.approx).map((g) => g.index))]));
}

const fin = (x: number) => (Number.isFinite(x) ? round(x, 4) : NaN);

export function computeMetrics(list: readonly ReplayMetrics[], approx: ReadonlyMap<string, Set<number>> = new Map()): EvalMetrics {
  const placed = list.filter((m) => Number.isFinite(m.sizeRatio));
  const gapErr = (kind: "normal" | "beforeLast" | "connector") => {
    const xs = placed.flatMap((m) => m.gaps.flatMap((g, k) => (g.kind === kind && !approx.get(m.id)?.has(k + 1) ? [Math.abs(g.engine - g.user)] : [])));
    return xs.length ? fin(median(xs)) : null;
  };
  const within10 = placed.filter((m) => m.within10).length;
  return {
    n: list.length,
    failed: list.length - placed.length,
    within10,
    sizeWithin10: list.length ? round(within10 / list.length, 4) : 0,
    sizeError: fin(median(placed.map((m) => Math.abs(m.sizeRatio - 1)))),
    sizeRatio: fin(median(placed.map((m) => m.sizeRatio))),
    heightError: fin(median(placed.map((m) => Math.abs(m.heightRatio - 1)))),
    positionError: fin(median(placed.map((m) => Math.hypot(m.dx, m.dy)))),
    dx: fin(median(placed.map((m) => m.dx))),
    dy: fin(median(placed.map((m) => m.dy))),
    gapNormal: gapErr("normal"),
    gapBeforeLast: gapErr("beforeLast"),
    gapConnector: gapErr("connector"),
  };
}
