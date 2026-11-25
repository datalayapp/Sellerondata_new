/**
 * Türkçe sayı ve yüzde yazımı (ek uyumu dahil). Saf işlevler. İngilizce karşılığı `en.ts` (aynı işlev adları).
 */

const ONES = ["ı", "i", "si", "ü", "ü", "i", "sı", "si", "i", "u"]; // i18n-ok: Türkçe ek uyumu (0..9; 0 ayrıca ele alınır)
const TENS: Record<number, string> = { 1: "u", 2: "si", 3: "u", 4: "ı", 5: "si", 6: "ı", 7: "i", 8: "i", 9: "ı" }; // i18n-ok: Türkçe ek uyumu

/** 0,973 → "97,3"; 0,97 → "97". En çok bir ondalık. */
export function pctText(ratio: number): string {
  const v = Math.round(ratio * 1000) / 10;
  return v.toLocaleString("tr-TR", { maximumFractionDigits: 1 });
}

/** Yüzde, baştan işaretli: 0,97 → "%97". */
export function pct(ratio: number): string {
  return `%${pctText(ratio)}`;
}

/** İyelik ekiyle yüzde: 0,97 → "%97'si", 0,73 → "%73'ü", 0,11 → "%11'i", 0,29 → "%29'u". */
export function pctOwn(ratio: number): string {
  const v = Math.round(ratio * 1000) / 10;
  return `%${pctText(ratio)}'${possessiveSuffix(v)}`;
}

function possessiveSuffix(v: number): string {
  if (!Number.isInteger(v)) {
    const last = Math.round(Math.abs(v) * 10) % 10;
    return last === 0 ? "ı" : (ONES[last] ?? "i"); // i18n-ok: Türkçe ek uyumu
  }
  const n = Math.abs(v);
  const d = n % 10;
  if (d !== 0) return ONES[d] ?? "i";
  if (n === 0) return "ı"; // i18n-ok: Türkçe ek uyumu
  if (n % 100 === 0) return "ü"; // i18n-ok: Türkçe ek uyumu (yüz)
  return TENS[Math.floor((n % 100) / 10)] ?? "i";
}

/** Sayı, Türkçe biçimde (ondalık virgül). */
export function num(n: number, max = 2): string {
  return n.toLocaleString("tr-TR", { maximumFractionDigits: max });
}

/** Listeyi "a, b ve c" biçiminde birleştirir. */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ve ${items[items.length - 1]}`;
}
