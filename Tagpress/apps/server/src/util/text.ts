/** Karşılaştırma için katlama: küçük harf (Türkçe), aksansız, ı→i. */
export function fold(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .trim();
}

/** Alan adı karşılaştırması: yalnızca harf ve rakam ("Sipariş No" → "siparisno"). */
export function normalizeKey(key: string): string {
  return fold(key).replace(/[^a-z0-9]/g, "");
}

/** Addan kimlik: "Gökçe'nin Dili" → "gokcenin-dili". */
export function slugify(name: string): string {
  const s = fold(name)
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "dil";
}

/** İki metin arasındaki düzenleme uzaklığı (şablon önerileri için). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** "data:image/png;base64,..." önekini atıp Buffer'a çevirir. */
export function fromBase64(data: string): Buffer {
  return Buffer.from(data.replace(/^data:[^,]*,/, ""), "base64");
}
