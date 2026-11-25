/**
 * Tuval seçimi — SAF. Figma'daki gibi: tık tek seçer, Shift/Ctrl+tık ekler/çıkarır, boşluğa tık temizler;
 * kutu seçimi değiştirir, Shift/Ctrl ile mevcut seçime ekler.
 */

export interface Mods {
  shift?: boolean;
  ctrl?: boolean;
}

/** Tıklama: `id` null = boşluk. Değiştirici yoksa yalnızca o öğe; Shift/Ctrl ile aç/kapa. */
export function clickSelect(current: readonly string[], id: string | null, mods: Mods = {}): string[] {
  const additive = mods.shift || mods.ctrl;
  if (id === null) return additive ? [...current] : [];
  if (!additive) return [id];
  return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
}

/**
 * Basılı tutup sürüklemeye başlarken seçim: seçili öğeye basılırsa seçim korunur (hepsi birlikte taşınır);
 * seçili olmayana basılırsa (değiştiricisiz) yalnızca o seçilir.
 */
export function pressSelect(current: readonly string[], id: string, mods: Mods = {}): string[] {
  if (current.includes(id) && !(mods.shift || mods.ctrl)) return [...current];
  if (mods.shift || mods.ctrl) return current.includes(id) ? [...current] : [...current, id];
  return [id];
}

/** Kutu seçimi sonucu: değiştiricisiz kutudakiler; Shift/Ctrl ile birleşim. Sıra korunur. */
export function boxSelect(current: readonly string[], hits: readonly string[], mods: Mods = {}): string[] {
  if (!(mods.shift || mods.ctrl)) return [...hits];
  const out = [...current];
  for (const h of hits) if (!out.includes(h)) out.push(h);
  return out;
}

/** Var olmayan kimlikleri seçimden düşürür (silme, geri alma sonrası). Değişmediyse aynı dizi döner. */
export function pruneSelection(current: readonly string[], exists: (id: string) => boolean): readonly string[] {
  const next = current.filter(exists);
  return next.length === current.length ? current : next;
}

export function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
