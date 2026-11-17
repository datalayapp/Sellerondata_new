import {
  desi as coreDesi,
  fmtDims as coreFmtDims,
  fmtNumberInput,
  intlLocale,
  normalizeLocale,
  parseMeasureNumber,
  parseTrNumber as coreParseTrNumber,
  round2,
  volumetricWeight,
  type Locale,
} from '@deciship/core';
import * as F from '@sellerondata/format';
import { addMonths, zonedDay } from '@sellerondata/format/zoned';
// Kabuğun ana girişi değil: biçimleme testleri bu dosyayı düz Node ile yükler.
import { shellTimeZone } from '@sellerondata/shell/time-zone';
// Kabuğun başlattığı i18next örneği. `../i18n` yüklenmez: biçimleme kabuksuz (core testleri) da çalışır.
import i18n from 'i18next';

/** İstemcide biçimleme dili (tek nokta). Çekirdekte küresel durum yok; dil buradan her çağrıya parametre olarak geçer. */
let formatLocale: Locale = normalizeLocale(i18n.language);

export function setFormatLocale(locale: string): void {
  formatLocale = normalizeLocale(locale);
}

export function getFormatLocale(): Locale {
  return formatLocale;
}

i18n.on('languageChanged', setFormatLocale);

type Maybe = number | null | undefined;
const missing = (n: Maybe): n is null | undefined => n === null || n === undefined || Number.isNaN(n);

// Ekran biçimi `@sellerondata/format`'tan (rapor Y72): eksi `−`, sıfıra yuvarlanan değerde işaret yok, tutar ile simge
// arası bölünmez boşluk, değer yoksa "—". Basamaklar önce hesap motorunun yuvarlamasından geçer (`round2`; 2 dışı
// basamakta `toFixed`): ekrandaki tutar motorun kaydettiği notla ve raporla aynı kuruşu gösterir (1,005 → 1,01).
// Dışa giden metin (CSV, pano, itiraz) bu işlevlerle yazılmaz; sunucu ve hesap motoru ASCII biçimde yazar.
const engineRound = (n: number, digits: number) => (digits === 2 ? round2(n) : Number(n.toFixed(digits)));

/** Number in the active language with min..max decimals ("1.234,5" / "1,234.5"). */
export function fmtNum(n: Maybe, min = 0, max = 2): string {
  if (missing(n)) return '—';
  return F.num(engineRound(n, max), formatLocale, { min, max });
}

/** "1.184,00 ₺" / "₺1,184.00" */
export function fmtMoney(n: Maybe, currency?: string | null): string {
  return missing(n) ? '—' : F.money(round2(n), currency, formatLocale);
}

/**
 * Büyük tutar için parçalar (biçimlenmiş metin ayrıştırılmaz; `moneyParts`): birim küçük yazılır.
 * TR "765,90" + küçük "₺" (arada boşluk yok, bugünkü görünüm); EN bilinmeyen kod küçük "CHF" + " 1,234.50";
 * EN simge ("₺765.90") küçültülmez. Değer yoksa "—".
 */
export function fmtMoneySplit(n: Maybe, currency?: string | null): { before: string; small: string; after: string } {
  const p = missing(n) ? null : F.moneyParts(round2(n), currency, formatLocale);
  if (!p) return { before: '—', small: '', after: '' };
  if (!p.unitFirst) return { before: p.sign + p.amount, small: p.unit, after: '' };
  if (!p.gap) return { before: p.sign + p.unit + p.amount, small: '', after: '' };
  return { before: p.sign, small: p.unit, after: p.gap + p.amount };
}

/** Signed money, e.g. "+458,50 ₺" / "+₺458.50"; sıfıra yuvarlanan tutar işaretsiz. */
export function fmtMoneySigned(n: Maybe, currency?: string | null): string {
  return missing(n) ? '—' : F.money(round2(n), currency, formatLocale, { plus: true });
}

/** "4,02 kg" / "4.02 kg": en az 1, en çok 3 ondalık (hesap motoru `fmtKg` ile aynı basamaklar, ekran işareti). */
export function fmtKg(n: Maybe): string {
  return missing(n) ? '—' : `${F.num(Math.round(n * 1000) / 1000, formatLocale, { min: 1, max: 3 })} kg`;
}

export function fmtDims(l?: number | null, w?: number | null, h?: number | null): string {
  if (l == null || w == null || h == null) return '—';
  return coreFmtDims({ l, w, h }, formatLocale);
}

/** "%38" / "%27,5" / "%12,35": en çok 2 ondalık, binlik yok (tarife, yakıt, indirim yüzdeleri bugünkü gibi; rapor Y72-7). */
export function fmtPct(n: Maybe): string {
  return missing(n) ? '—' : F.percent(round2(n), formatLocale, { max: 2, group: false });
}

export const parseTrNumber = (s: string | number | null | undefined): number | null => coreParseTrNumber(s, formatLocale);

/** Ölçü/ağırlık girişi (cm, kg): binlik yok, nokta da virgül de ondalık ("2.500" kg = 2,5); mobil ile aynı. Para, bölen, yüzde: parseTrNumber. */
export const parseMeasure = (s: string | null | undefined): number | null => parseMeasureNumber(s);

/**
 * Desi with the company divisor: displayed desi rounds each edge up to a whole cm, then divides (2 decimals) — same as API/core.
 * The invoice comparison uses the tariff's divisor and edge-rounding rule instead.
 */
export function desiOf(l: number, w: number, h: number, divisor = 3000): number {
  return coreDesi({ l, w, h }, divisor);
}

/** Volumetric kg (edges rounded up to whole cm). */
export function volumetric(l: number, w: number, h: number, divisor: number): number {
  return volumetricWeight({ l, w, h }, divisor);
}

// Tarih ve "bugün" firma saat diliminde (rapor Y132): kabuk `/me` gelince `activeOrg.timeZone`'u atar (`shellTimeZone`);
// sunucu panoyu, ölçüm "bugün"ünü ve süzgeçleri aynı saat dilimiyle sayar. Atanmamışsa tarayıcının saati (bugünkü davranış).
// Yalnız gün olan değer ("2026-10-27": fatura tarihi, gönderim günü) takvim günüdür, hiçbir saat dilimi onu kaydırmaz.
// İtiraz süreleri bilerek sabit Türkiye günüyle kalır (`lib/disputes.ts` `turkeyDate`; sunucuyla aynı, para etkili).

/** "27 Eki 2026" / "27 Oct 2026" (Merkez ile aynı); geçersizse "—". */
export function fmtDate(v: string | Date | null | undefined): string {
  return F.dateShort(v, formatLocale, { timeZone: shellTimeZone() });
}

/** "27 Eki 2026 14:12" / "27 Oct 2026, 14:12"; geçersizse "—". */
export function fmtDateTime(v: string | Date | null | undefined): string {
  return F.dateTime(v, formatLocale, { timeZone: shellTimeZone() });
}

/** Anın firma saat dilimindeki günü, YYYY-MM-DD (saat dilimi bilinmiyorsa tarayıcı saati). */
export function isoDate(d: Date = new Date()): string {
  return zonedDay(d, shellTimeZone());
}

/** Anın firma saat dilimindeki ayı, YYYY-MM. */
export function monthKey(d: Date = new Date()): string {
  return isoDate(d).slice(0, 7);
}

/** Bu ay (firma saat diliminde) ve önceki `n - 1` ay, yeniden eskiye: ["2026-11", "2026-10", …]. */
export function recentMonthKeys(n: number, now: Date = new Date()): string[] {
  const current = monthKey(now);
  return Array.from({ length: Math.max(0, n) }, (_, i) => addMonths(current, -i));
}

export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, (m || 1) - 1, 1);
  if (!/^\d{4}-\d{2}$/.test(key) || Number.isNaN(d.getTime())) return F.EMPTY;
  const s = d.toLocaleDateString(intlLocale(formatLocale), { month: 'long', year: 'numeric' });
  return s.charAt(0).toLocaleUpperCase(intlLocale(formatLocale)) + s.slice(1);
}

/** Number → editable string in the active language ("4,5" / "4.5"); parses back to the same number. */
export function numToInput(n: number | null | undefined, maxDigits = 3): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  return fmtNumberInput(n, maxDigits, formatLocale);
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p.charAt(0).toLocaleUpperCase(intlLocale(formatLocale)))
    .join('');
}
