/** Ortak biçimleyiciler. Para her yerde buradan: Türkçe ondalık virgül, "$" öneki. */

export interface UsdOptions {
  /** Tahmini tutarlarda "~" öneki. */
  approx?: boolean;
}

/**
 * Dolar tutarı: 0 → "$0,00"; 1'in altı üç hane ("$0,125"), 0,01'in altı üç ila dört hane ("$0,006", "$0,0042"); 1 ve üstü iki hane ("$1,25").
 * Değer yoksa (null/undefined/NaN) "—".
 */
export function formatUsd(n: number | null | undefined, opts: UsdOptions = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const [min, max] = n === 0 ? [2, 2] : n < 0.01 ? [3, 4] : n < 1 ? [3, 3] : [2, 2];
  const text = `$${n.toLocaleString("tr-TR", { minimumFractionDigits: min, maximumFractionDigits: max })}`;
  return opts.approx ? `~${text}` : text;
}
