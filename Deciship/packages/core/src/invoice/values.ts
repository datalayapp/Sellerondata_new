import { parseTrDate, parseTrNumber } from '../format';

/**
 * Sayı biçimi: `tr` = "1.234,56" (nokta binlik, virgül ondalık), `en` = "1,234.56" (virgül binlik, nokta ondalık),
 * `auto` = kanıt yok ya da karışık → parseTrNumber'ın genel kuralları.
 */
export type NumberFormat = 'tr' | 'en' | 'auto';

const EN_BOTH = /^[-+(]?\d{1,3}(,\d{3})+\.\d+\)?-?$/;
const TR_BOTH = /^[-+(]?\d{1,3}(\.\d{3})+,\d+\)?-?$/;
const EN_DOT = /^[-+(]?\d+\.(\d{1,2}|\d{4,})\)?-?$/;
const TR_COMMA = /^[-+(]?\d+,(\d{1,2}|\d{4,})\)?-?$/;
const SIMPLE_EN = /^-?\d+(\.\d+)?$/;

function clean(v: string): string {
  return v.replace(/[\s\u00a0']/g, '').replace(/(TRY|TL|EUR|USD|GBP|CHF|SEK|NOK|DKK|PLN|CZK|HUF|RON|AED|CAD|AUD|JPY|CNY|KG|LBS|LB|DESI|₺|€|\$|£|¥|%)/gi, '');
}

/** Sütun değerlerinden sayı biçimini tahmin eder. Yalnız tek yönde kanıt varsa `tr`/`en` döner. */
export function detectNumberFormat(values: Iterable<string>): NumberFormat {
  let en = 0;
  let tr = 0;
  for (const raw of values) {
    const v = clean(String(raw ?? '').trim());
    if (!v) continue;
    if (EN_BOTH.test(v) || EN_DOT.test(v)) en++;
    else if (TR_BOTH.test(v) || TR_COMMA.test(v)) tr++;
  }
  if (en > 0 && tr === 0) return 'en';
  if (tr > 0 && en === 0) return 'tr';
  return 'auto';
}

/** Belirlenen biçimle sayı okur. `en`: "1,639.15" → 1639.15, "2.500" → 2.5, "1,010" → 1010. */
export function parseNumberAs(v: string | null | undefined, fmt: NumberFormat): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (fmt !== 'en') return parseTrNumber(s);
  // sık yol (genel yolla aynı sonuç): "123", "-1234.56"
  if (SIMPLE_EN.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const c = clean(s);
  const body = c.replace(/^[-+(]+|[)-]+$/g, '');
  const [intPart] = body.split('.');
  if (body.split('.').length > 2) return null;
  if (intPart!.includes(',') && !/^\d{1,3}(,\d{3})+$/.test(intPart!)) return parseTrNumber(s);
  return parseTrNumber(c.replace(/,/g, '').replace('.', ','));
}

/** Tarih sırası: `dmy` (Türkçe varsayılan) ya da `mdy` (ABD, ör. FedEx EN "10/27/2026"). */
export type DateOrder = 'dmy' | 'mdy';

/** Sırası değerden anlaşılamayan tarih: iki okuması da kullanıcıya gösterilir (ISO). */
export type DateAmbiguity = { sample: string; dmy: string; mdy: string };

export type DateOrderReading = {
  order: DateOrder;
  /** Sıra değerlerden tek yönde anlaşıldı: kayıtlı seçimin önüne geçer. */
  evident: boolean;
  ambiguous: DateAmbiguity | null;
};

/**
 * Değerlerden tarih sırası. "a/b/yyyy" biçiminde ikinci sayı 12'den büyükse ve hiçbir değerde ilk sayı 12'den büyük değilse `mdy`.
 * Kanıt yoksa ya da çelişiyorsa sıra `dmy` kalır; `/` ve `-` ayraçlı, iki türlü okunabilen ilk değer `ambiguous` olarak döner.
 * Noktalı biçim sayılmaz: "05.10.2026" ABD'de kullanılmaz, her Türkçe dosyada soru sormak yanlış olur.
 */
export function readDateOrder(values: Iterable<string>): DateOrderReading {
  let mdy = 0;
  let dmy = 0;
  let sample: string | null = null;
  for (const raw of values) {
    const s = String(raw ?? '').trim();
    const m = /^(\d{1,2})([./-])(\d{1,2})\2(\d{2}|\d{4})\b/.exec(s);
    if (!m) continue;
    const a = +m[1]!;
    const b = +m[3]!;
    if (a > 12 && b <= 12) dmy++;
    else if (b > 12 && a <= 12) mdy++;
    else if (!sample && m[2] !== '.' && a !== b && a >= 1 && b >= 1 && a <= 12 && b <= 12) sample = s;
  }
  if (mdy > 0 && dmy === 0) return { order: 'mdy', evident: true, ambiguous: null };
  if (dmy > 0 && mdy === 0) return { order: 'dmy', evident: true, ambiguous: null };
  const asDmy = sample && parseDateAs(sample, 'dmy');
  const asMdy = sample && parseDateAs(sample, 'mdy');
  return { order: 'dmy', evident: false, ambiguous: sample && asDmy && asMdy ? { sample, dmy: asDmy, mdy: asMdy } : null };
}

export function detectDateOrder(values: Iterable<string>): DateOrder {
  return readDateOrder(values).order;
}

/** Tarih okur; `mdy` sırasında belirsiz "05/06/2026" değerleri ay/gün olarak okunur. */
export function parseDateAs(v: string, order: DateOrder): string | null {
  const s = String(v ?? '').trim();
  if (order === 'mdy') {
    const m = /^(\d{1,2})([./-])(\d{1,2})\2(\d{2}|\d{4})((?:[T\s,].*)?)$/.exec(s);
    if (m) return parseTrDate(`${m[3]}${m[2]}${m[1]}${m[2]}${m[4]}${m[5] ?? ''}`);
  }
  return parseTrDate(s);
}

export const INCH_TO_CM = 2.54;
export const LB_TO_KG = 0.45359237;

/** Ölçü birimi hücresi → cm çarpanı (C/CM → 1, I/IN/INCH/İNÇ → 2,54). Boş ya da bilinmeyen → 1. */
export function lengthFactor(unit: string | undefined): number {
  const u = String(unit ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-zçı]/g, '');
  return /^(i|in|inch|inches|inc|inç|ınç)$/.test(u) ? INCH_TO_CM : 1;
}

/** Ağırlık birimi hücresi → kg çarpanı (K/KG → 1, L/LB/LBS → 0,45359237). Boş ya da bilinmeyen → 1. */
export function weightFactor(unit: string | undefined): number {
  const u = String(unit ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  return /^(l|lb|lbs|pound|pounds)$/.test(u) ? LB_TO_KG : 1;
}
