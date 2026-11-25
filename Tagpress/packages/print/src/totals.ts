import type { PlannedPage } from "./types.ts";

export interface PrintedTotal {
  jobId: string;
  variantId: string;
  /** Planın toplam baskısı (öğe sayısı × sayfa kopyası). */
  printed: number;
}

/** Plandaki her iş/varyasyon için toplam basılan adet (eklentideki `totals.printed`). */
export function printedTotals(pages: readonly PlannedPage[]): PrintedTotal[] {
  const map = new Map<string, PrintedTotal>();
  for (const p of pages) {
    for (const it of p.items) {
      const key = `${it.jobId}\u0000${it.variantId}`;
      const t = map.get(key) ?? { jobId: it.jobId, variantId: it.variantId, printed: 0 };
      t.printed += p.copies;
      map.set(key, t);
    }
  }
  return [...map.values()];
}
