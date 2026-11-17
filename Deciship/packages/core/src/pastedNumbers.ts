import { fmtNumberInput, parseTrNumber } from './format';
import type { Locale } from './i18n/index';
import { detectNumberFormat, parseNumberAs } from './invoice/values';

/**
 * Arayüze dışarıdan yapıştırılan sayılar (Excel, belge). Kaynağın biçimi arayüz dilinden bağımsızdır: Türkçe Excel'deki
 * "1.234" İngilizce arayüzde de 1234'tür. Biçim bloktan okunur; kanıt yoksa tahmin edilmez, kullanıcıya sorulur.
 */

/** Metin iki dilin kuralıyla farklı sayı mı veriyor? ("1.234": 1234 / 1,234) */
export function isAmbiguousNumberText(text: string): boolean {
  const a = parseTrNumber(text, 'tr');
  const b = parseTrNumber(text, 'en');
  return a !== null && b !== null && a !== b;
}

const numeric = (s: string) => s.replace(/[^\d.,-]/g, '');

/** İki dilde aynı okunsa da ayırıcıyı ele veren yazımlar: "1.234.567" ve "0,500" Türkçe, "1,234,567" ve "1234.567" İngilizce. */
const TR_PROOF = /^-?(?:\d{1,3}(?:\.\d{3}){2,}|0,\d{3}|\d{4,},\d{3})$/;
const EN_PROOF = /^-?(?:\d{1,3}(?:,\d{3}){2,}|0\.\d{3}|\d{4,}\.\d{3})$/;

function cellVote(cell: string): 'tr' | 'en' | null {
  const f = detectNumberFormat([cell]);
  if (f !== 'auto') return f;
  const n = numeric(cell);
  return TR_PROOF.test(n) ? 'tr' : EN_PROOF.test(n) ? 'en' : null;
}

export type PastedNumbers = {
  /** Bloğun biçimi; kanıt yoksa ya da iki yönde kanıt varsa null. */
  format: 'tr' | 'en' | null;
  /** Biçim belli değilken iki dilde farklı okunan hücreler: boş değilse sorulmalı. */
  ambiguous: string[];
};

export function readPastedNumbers(cells: Iterable<string>): PastedNumbers {
  const list = [...cells].map((c) => c.trim()).filter(Boolean);
  const votes = new Set(list.map(cellVote).filter(Boolean));
  const format = votes.size === 1 ? ([...votes][0] as 'tr' | 'en') : null;
  return { format, ambiguous: format ? [] : list.filter(isAmbiguousNumberText) };
}

/** Hücreyi `from` biçiminde okuyup etkin dilde yazar. Biçim aynıysa ya da hücre sayı değilse metne dokunmaz. */
export function convertPastedNumber(cell: string, from: 'tr' | 'en', locale: Locale): string {
  if (from === locale) return cell;
  const v = parseNumberAs(cell, from);
  return v === null ? cell : fmtNumberInput(v, 6, locale);
}
