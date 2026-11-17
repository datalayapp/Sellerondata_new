/** `lineIds` boş dizi olarak gitmez (API 400 döner): boşsa alan hiç eklenmez. */
export function withLineIds<T extends { lineIds?: string[] }>(b: T): T {
  if (b.lineIds && b.lineIds.length > 0) return b;
  const { lineIds: _omit, ...rest } = b;
  return rest as T;
}
