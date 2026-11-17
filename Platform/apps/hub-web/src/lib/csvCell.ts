/**
 * Elektronik tablo formülü olarak çalışmasın (=, +, -, @ ve tam genişlikli karşılıkları). Excel baştaki boşluk ve
 * satır sonlarını yutabilir: formül karakteri onların arkasında da aranır. Eksi sayılar sayı kalır.
 * API ile aynı kural (Deciship/apps/api/src/services/hub/csv.ts neutralize); biri değişirse öteki de.
 */
export function neutralizeFormula(s: string): string {
  return /^[\t\r\n]|^\s*[=+\-@＝＋－＠]/.test(s) ? `'${s}` : s;
}

export function safeCell(v: string | number | null | undefined, comma = false): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return comma ? String(v).replace('.', ',') : String(v);
  return neutralizeFormula(v);
}
