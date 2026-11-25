import type { Box } from "./geometry.ts";
import type { LineRole } from "./intent.ts";
import type { Issue } from "./issues.ts";
import type { Tier } from "./profile.ts";

/** Motorun çıktısı. Birim: tasarım alanı px. Önizleme, baskı ve öğrenme bunu kullanır. */
export interface PlacedRun {
  text: string;
  fontId: string;
  /** Fontun aile/stil adı. */
  family: string;
  style: string;
  sizePx: number;
  /** Yukarı pozitif. */
  baselineShiftPx: number;
  /** Bu run yedek fonttan mı (müşteri karakteri fontta yoktu)? */
  fallback: boolean;
  /** Harf aralığı (em). */
  trackingEm: number;
}

export interface PlacedLine {
  text: string;
  role: LineRole;
  tier: Tier;
  /** Satırın ana puntosu (px). */
  sizePx: number;
  runs: PlacedRun[];
  /** Taban çizgisi (px, tasarım alanı). */
  baselineY: number;
  /** İlerleme kutusunun solu ve genişliği. */
  x: number;
  advance: number;
  /** Mürekkep kutusu (kontur dahil). */
  ink: Box;
  /**
   * Bu satırın etkin kontur genişliği (px). Yoksa `LayoutResult.strokePx` geçerlidir. Motor bunu doldurmaz;
   * hafif düzeltme (`applyAdjustToLayout`) satır başına kalınlık için doldurur. Okuyan herkes
   * `line.strokePx ?? layout.strokePx` kullanır.
   */
  strokePx?: number;
}

export interface LayoutScore {
  total: number;
  parts: Record<string, number>;
}

export interface LayoutResult {
  ok: boolean;
  lines: PlacedLine[];
  /** Ana satır puntosu (px). */
  basePx: number;
  /** Kontur genişliği (px), etiket başına temel değer. 0 = yok. Satırın kendi `strokePx`'i varsa o geçerlidir. */
  strokePx: number;
  color: string;
  /** Bütün yazının mürekkep kutusu. */
  ink: Box;
  /** Uygulanan doluluk (azami boyuta oran). */
  fill: number;
  score: LayoutScore;
  issues: Issue[];
  /** Motorun yaptığı açıklanabilir değişiklikler (ör. "asılı bağlaç ayrıldı"). */
  notes: string[];
  ms: number;
}
