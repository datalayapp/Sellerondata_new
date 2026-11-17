import { isAmbiguousNumberText, parseTrNumber as coreParse } from '@deciship/core';

type PasteLike = {
  target: unknown;
  clipboardData?: { getData: (type: string) => string } | null;
  preventDefault: () => void;
};
type InputLike = { tagName?: string; dataset?: Record<string, string | undefined>; getAttribute?: (name: string) => string | null };

export type NumberPasteQuestion = { target: unknown; text: string; asTr: number; asEn: number };

/**
 * Sayı alanına tek değer yapıştırma: "1.234" kaynağa göre 1234 ya da 1,234 olabilir ve tek değerde bunu ele verecek kanıt
 * yoktur. Tahmin edilmez: yapıştırma durdurulur, kullanıcıya sorulur. Fiyat tablosu hücreleri (`data-cell`) kendi akışındadır.
 * Koli ölçüsü alanları (`data-measure`: ölçüm formu, hazır koli, tarife deneme hesabı) sorulmaz: binlik okunmaz, "1.500" kg
 * = 1,5 kg (K36, kullanıcı kararı 2026-11-14; `parseMeasure`).
 */
export function handleNumberPaste(e: PasteLike, ask: (q: NumberPasteQuestion) => void): boolean {
  const el = e.target as InputLike | null;
  if (el?.tagName !== 'INPUT' || el.dataset?.cell !== undefined || el.dataset?.measure !== undefined) return false;
  const mode = el.getAttribute?.('inputmode');
  if (mode !== 'decimal' && mode !== 'numeric') return false;
  const text = (e.clipboardData?.getData('text/plain') ?? '').trim();
  if (!isAmbiguousNumberText(text)) return false;
  e.preventDefault();
  ask({ target: el, text, asTr: coreParse(text, 'tr')!, asEn: coreParse(text, 'en')! });
  return true;
}

/** Yapıştırma gibi: seçili metnin yerine geçer; seçim bilinmiyorsa sona ekler. */
export function spliceValue(value: string, start: number | null, end: number | null, text: string): string {
  const a = start ?? value.length;
  const b = end ?? a;
  return value.slice(0, a) + text + value.slice(b);
}

/** Kontrollü (React) alana değer yazar: `onChange` gerçek kullanıcı girdisi gibi çalışır. */
export function writeInputValue(el: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
