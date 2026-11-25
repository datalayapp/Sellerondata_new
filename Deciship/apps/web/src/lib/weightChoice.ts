import { ambiguousWeightText, fmtNumberInput, parseMeasureNumber, parseTrNumber, uiAmbiguousSeparator, type Locale, type WeightReadings } from '@deciship/core';
import { fmtNum, getFormatLocale, numToInput } from './format';

export type { WeightReadings };
export type WeightPick = 'decimal' | 'thousands';

/**
 * K36 (kullanıcı kararı 2026-11-14): tarife ve fatura ağırlığında arayüz dilinin binlik ayırıcısı ve tam üç hane iki türlü
 * okunur: Türkçede "1.500" (Türkçe binlik 1500 mı, İngilizce ondalık 1,5 mi), İngilizcede "1,500" (İngilizce binlik 1500 mü,
 * Türkçe ondalık 1,5 mi). Sessizce seçilmez: alanın altında sorulur, seçilene dek kayıt/içe aktarma kapalıdır. Dilin ondalık
 * ayırıcısıyla yazılan ("1,500" Türkçede, "1.500" ve düzenleyicinin kendi yazdığı "1.125" İngilizcede) sorulmaz.
 * Koli ölçümünde (ölçüm formu, mobil) hiç sorulmaz: `parseMeasure` her iki dilde ondalık okur.
 */
export function weightChoice(text: string | null | undefined): WeightReadings | null {
  return ambiguousWeightText(text, uiAmbiguousSeparator(getFormatLocale()));
}

/**
 * Arayüz dili değişince ekranda duran (kaydedilmemiş) sayı metni anlamını korusun: `from` dilinde okunur, `to` dilinde
 * binliksiz yazılır (Türkçe "1.500" TL → İngilizce "1500"; Türkçe "1,5" → "1.5"). Okunamayan metin olduğu gibi kalır.
 */
export function relocalizeNumberText(v: string, from: Locale, to: Locale): string {
  if (from === to || !v.trim()) return v;
  const n = parseTrNumber(v.trim(), from);
  return n === null ? v : fmtNumberInput(n, 6, to);
}

/**
 * Ağırlık metni için aynısı. `from` dilinde iki türlü okunan ve henüz seçilmemiş yazım ("1.500" Türkçe) `to` dilinin aynı
 * iki okumalı yazımına çevrilir ("1,500" İngilizce): soru sessizce kaybolmaz. `measure`: koli ölçüsü gibi binliksiz okunan
 * alan (PDF adımı kg ve kenarları; `parseMeasure`).
 */
/** Binliksiz okunan (ölçü, `parseMeasure`) metin: anlamı dilden bağımsızdır, yeni dilde yazılır ("0,5" → "0.5"). */
export function relocalizeMeasureText(v: string, from: Locale, to: Locale): string {
  if (from === to || !v.trim()) return v;
  const n = parseMeasureNumber(v);
  return n === null ? v : fmtNumberInput(n, 6, to);
}

export function relocalizeWeightText(v: string, from: Locale, to: Locale, measure = false): string {
  if (from === to || !v.trim()) return v;
  const sepFrom = uiAmbiguousSeparator(from);
  if (ambiguousWeightText(v, sepFrom)) return v.trim().replace(sepFrom, uiAmbiguousSeparator(to));
  if (!measure) return relocalizeNumberText(v, from, to);
  const n = parseMeasureNumber(v);
  return n === null ? v : fmtNumberInput(n, 6, to);
}

/** Seçilen okumanın alana yazılacak, iki türlü okunmayan metni ("1,5" / "1500"). */
export const weightChoiceText = (r: WeightReadings, pick: WeightPick): string => numToInput(r[pick]);

/** Seçenek etiketi: "1,5 kg" / "1.500 kg". */
export const weightChoiceLabel = (r: WeightReadings, pick: WeightPick): string => weightChoiceLabelOf(r[pick]);
export const weightChoiceLabelOf = (kg: number): string => `${fmtNum(kg, 0, 3)} kg`;
