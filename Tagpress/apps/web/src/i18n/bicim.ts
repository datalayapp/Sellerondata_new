import { currentLocale } from "./index.ts";

/**
 * Sayı ve para biçimi, etkin arayüz diline göre (TR "1,25", EN "1.25"). TR çıktısı `lib/format.ts` ile aynıdır
 * (`sunucu.test.ts` denetler).
 */
const INTL: Record<"tr" | "en", string> = { tr: "tr-TR", en: "en-US" };

export function intlLocale(): string {
  return INTL[currentLocale()];
}

/** Sayı: `Intl.NumberFormat` seçenekleriyle (ör. `{ maximumFractionDigits: 1 }`). Değer yoksa "—". */
export function formatNumber(n: number | null | undefined, opts: Intl.NumberFormatOptions = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString(intlLocale(), opts);
}

/** Dolar tutarı; basamak kuralı `lib/format.ts` `formatUsd` ile aynı, ondalık ayırıcı dile göre. */
export function formatUsd(n: number | null | undefined, opts: { approx?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const [min, max] = n === 0 ? [2, 2] : n < 0.01 ? [3, 4] : n < 1 ? [3, 3] : [2, 2];
  const text = `$${n.toLocaleString(intlLocale(), { minimumFractionDigits: min, maximumFractionDigits: max })}`;
  return opts.approx ? `~${text}` : text;
}

/**
 * Tutarların toplamı. Bilinmeyen tutar (`null`: fiyatı yok ya da kişi tutarları göremez; platformda yalnız TagPress
 * Yöneticisi görür) toplama girmez; hiçbiri bilinmiyorsa sonuç `null` ("—"), "$0" değil. Boş liste 0.
 */
export function sumUsd(values: ReadonlyArray<number | null | undefined>): number | null {
  let sum = 0;
  let known = values.length === 0;
  for (const v of values) {
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    sum += v;
    known = true;
  }
  return known ? sum : null;
}

/** Milimetre ölçüsü ("38 mm", "3,8 cm" gibi birim metni çağıranda; burada yalnız sayı). */
export function formatMm(n: number, digits = 1): string {
  return formatNumber(n, { maximumFractionDigits: digits });
}
