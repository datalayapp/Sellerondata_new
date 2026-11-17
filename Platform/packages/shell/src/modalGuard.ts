// Pencere koruması: kapatma isteğinin (Esc, örtü, X) ne olacağına karar verir. Saf modül; DOM'a ve React'e bağlı değil
// (DeciShip `web/test/modal-guard.test.ts` bunu `node --test` ile doğrudan yükler).
export type CloseSource = 'esc' | 'backdrop' | 'x';
export type CloseDecision = 'ignore' | 'ask' | 'close' | 'keep';

/** busy → ignore; soru açıkken esc → keep (soruyu kapat, düzenlemeye dön); dirty → ask; yoksa close. */
export function closeDecision(s: { busy: boolean; dirty: boolean; asking: boolean; source: CloseSource }): CloseDecision {
  if (s.busy) return 'ignore';
  if (s.asking && s.source === 'esc') return 'keep';
  if (s.dirty) return 'ask';
  return 'close';
}

/** Pencere içindeki hangi alan "yazı" sayılır: INPUT (hidden hariç; checkbox/radio DAHİL), TEXTAREA, SELECT;
 *  `[data-modal-ignore]`, `.search`, `[role="search"]` içindekiler sayılmaz. */
export function isTrackedField(el: Pick<Element, 'tagName' | 'closest'> & { type?: string }): boolean {
  const tag = el.tagName.toUpperCase();
  if (tag === 'INPUT') {
    if ((el.type ?? '').toLowerCase() === 'hidden') return false;
  } else if (tag !== 'TEXTAREA' && tag !== 'SELECT') {
    return false;
  }
  return !el.closest('[data-modal-ignore], .search, [role="search"]');
}
