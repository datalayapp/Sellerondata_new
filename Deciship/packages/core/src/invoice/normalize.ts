/** Başlık normalleştirme: küçük harf, Türkçe karakter ve aksan katlama, noktalama → boşluk. */
export function normalizeHeader(h: string): string {
  return String(h ?? '')
    .replace(/İ/g, 'i')
    .replace(/I/g, 'ı')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
