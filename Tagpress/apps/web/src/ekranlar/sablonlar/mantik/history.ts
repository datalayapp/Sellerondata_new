/**
 * Geri al geçmişi (saf). Her değişiklikten ÖNCEKİ durum saklanır; aynı anahtarla gelen ardışık değişiklikler tek adım
 * sayılır (bir sürükleme, bir alana yazma, aynı adımlayıcıya art arda basma). Anahtarsız değişiklik her zaman ayrı adım.
 */
export interface History<T> {
  past: T[];
  /** Son kaydın birleştirme anahtarı. */
  key: string | null;
}

/** Geri alınabilecek en çok adım. */
export const HISTORY_LIMIT = 100;

export function emptyHistory<T>(): History<T> {
  return { past: [], key: null };
}

/** `before`: değişiklikten önceki durum. `key` öncekiyle aynıysa (null değilse) yeni adım açılmaz. */
export function record<T>(h: History<T>, before: T, key: string | null = null): History<T> {
  if (key !== null && key === h.key) return h;
  return { past: [...h.past, before].slice(-HISTORY_LIMIT), key };
}

/** Son adımı geri al: dönecek durum ve kısalan geçmiş; geçmiş boşsa null. */
export function undo<T>(h: History<T>): { history: History<T>; value: T } | null {
  if (!h.past.length) return null;
  return { history: { past: h.past.slice(0, -1), key: null }, value: h.past[h.past.length - 1]! };
}

export function canUndo<T>(h: History<T>): boolean {
  return h.past.length > 0;
}
