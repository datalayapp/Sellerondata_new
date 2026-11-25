/** Deneme sonuçlarının ölçüleri: satır bölmesi aynı mı, boyut farkı yüzde kaç. Saf işlevler. */

export interface SideLines {
  lines: string[];
  /** Satır puntoları (tasarım alanı px). */
  sizesPx: number[];
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLocaleLowerCase("tr");

export function sameBreaks(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((l, i) => norm(l) === norm(b[i] ?? ""));
}

/** Ortalama göreli boyut farkı (0..1). Satır sayıları farklıysa en büyük satırlar kıyaslanır. */
export function sizeDiff(a: number[], b: number[]): number | null {
  if (a.length === 0 || b.length === 0) return null;
  if (a.length === b.length) {
    const diffs = a.map((x, i) => {
      const y = b[i] ?? x;
      return y === 0 ? 0 : Math.abs(x - y) / y;
    });
    return diffs.reduce((s, d) => s + d, 0) / diffs.length;
  }
  const ma = Math.max(...a);
  const mb = Math.max(...b);
  return mb === 0 ? null : Math.abs(ma - mb) / mb;
}

export interface Comparison {
  sameBreaks: boolean;
  sizeDiff: number | null;
}

export function compareSides(a: SideLines | null | undefined, b: SideLines | null | undefined): Comparison | null {
  if (!a || !b) return null;
  return { sameBreaks: sameBreaks(a.lines, b.lines), sizeDiff: sizeDiff(a.sizesPx, b.sizesPx) };
}
