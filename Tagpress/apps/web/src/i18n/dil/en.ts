/**
 * İngilizce sayı ve yüzde yazımı: `tr.ts` ile aynı işlev adları ("97%", "1,234.5", "a, b, and c"). Saf işlevler.
 * Dile göre seçim `ekranlar/tasarim-dili/dil.ts`'tedir.
 */

/** 0.973 → "97.3"; 0.97 → "97". En çok bir ondalık. */
export function pctText(ratio: number): string {
  const v = Math.round(ratio * 1000) / 10;
  return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

/** Yüzde: 0.97 → "97%". */
export function pct(ratio: number): string {
  return `${pctText(ratio)}%`;
}

/** İngilizcede iyelik eki yok: `pct` ile aynı ("97%"). */
export function pctOwn(ratio: number): string {
  return pct(ratio);
}

export function num(n: number, max = 2): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
}

/** Listeyi "a, b, and c" biçiminde birleştirir. */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(items);
}
