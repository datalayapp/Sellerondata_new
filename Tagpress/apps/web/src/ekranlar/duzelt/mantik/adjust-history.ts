/**
 * Düzelt penceresinin geri al / ileri al geçmişi (saf mantık, istemcide tutulur).
 * Sürükleme tek adımdır (bırakınca `push`); aynı anahtarlı art arda işlemler (ör. ok tuşu) kısa süre içinde tek adımda birleşir.
 */

export const HISTORY_LIMIT = 100;
export const MERGE_MS = 500;

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** Son push'un birleştirme anahtarı ve zamanı. */
  mergeKey: string | null;
  at: number;
}

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], mergeKey: null, at: 0 };
}

/**
 * Yeni durumu geçmişe yazar. `eq` eşitse hiçbir şey yapmaz. `key` verilmişse ve son işlemle aynıysa, `mergeMs` içinde
 * yeni adım açılmaz: şimdiki durum değişir (geri alınca bütün dizi birden döner). İleri alma listesi boşalır.
 */
export function push<T>(h: History<T>, next: T, opts: { now: number; key?: string | null; eq?: (a: T, b: T) => boolean; mergeMs?: number; limit?: number }): History<T> {
  const eq = opts.eq ?? ((a, b) => a === b);
  if (eq(h.present, next)) return h;
  const key = opts.key ?? null;
  const merge = key !== null && key === h.mergeKey && opts.now - h.at <= (opts.mergeMs ?? MERGE_MS) && h.past.length > 0;
  if (merge) return { ...h, present: next, future: [], at: opts.now };
  const past = [...h.past, h.present];
  const limit = opts.limit ?? HISTORY_LIMIT;
  if (past.length > limit) past.splice(0, past.length - limit);
  return { past, present: next, future: [], mergeKey: key, at: opts.now };
}

export const canUndo = (h: History<unknown>) => h.past.length > 0;
export const canRedo = (h: History<unknown>) => h.future.length > 0;

export function undo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h;
  const past = h.past.slice(0, -1);
  return { past, present: h.past[h.past.length - 1]!, future: [h.present, ...h.future], mergeKey: null, at: 0 };
}

export function redo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  const [next, ...future] = h.future;
  return { past: [...h.past, h.present], present: next!, future, mergeKey: null, at: 0 };
}
