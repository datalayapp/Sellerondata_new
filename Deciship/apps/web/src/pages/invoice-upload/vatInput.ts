import { parseTrNumber } from "../../lib/format";

/**
 * Eşlemedeki KDV oranı kutusu (10-B19): yazarken metin olduğu gibi kalır (her tuşta yeniden biçimlenince "7," → "7" olur,
 * "7,5" 75 okunurdu); kutudan çıkınca sayıya çevrilir. Okunamayan ya da 0-100 dışı metin önceki orana döner (sunucu
 * `mappingSchema` aynı aralık); boşluk sessizce 0 yapılmaz. Arayüz dilinde okunur: TR "7,5", EN "7.5".
 */
export function commitVatPct(text: string, prev: number): number {
  const v = parseTrNumber(text);
  return v !== null && v >= 0 && v <= 100 ? v : prev;
}
