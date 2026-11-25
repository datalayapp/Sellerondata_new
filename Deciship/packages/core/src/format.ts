import { CURRENCY_SYMBOL, dateShort, EMPTY, money, num } from '@sellerondata/format';
import { round2 } from './calc';
import { DEFAULT_LOCALE, type Locale } from './i18n/index';

// Bu dosyadaki `fmtNumber`, `fmtMoney`, `fmtMoneyEn`, `fmtPct` hesap motorunun KAYDETTİĞİ ve dışa verdiği metinleri yazar
// (karşılaştırma notları, itiraz metni, rapor hücreleri). Basamakları `@sellerondata/format` yazar; çıktı bilerek eski
// biçimde sabittir: ASCII eksi (`sign: 'ascii'`), düz boşluk, önce `round2` ile gürültü temizliği. Eski kayıtların
// çevirisi (`localizeText`) bu biçime bağlıdır: değiştirmeyin (rapor Y72-8). Ekran biçimi için paketi doğrudan kullanın.

export function currencySymbol(currency = 'TRY'): string {
  const c = currency.toUpperCase();
  return CURRENCY_SYMBOL[c] ?? c;
}

function groupThousands(intPart: string, sep: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

/** Binlik ve ondalık ayırıcı: tr-TR "1.234,5", en-US "1,234.5". Yuvarlama dilden bağımsızdır (Intl kullanılmaz). */
function separators(locale: Locale): { group: string; decimal: string } {
  return locale === 'en' ? { group: ',', decimal: '.' } : { group: '.', decimal: ',' };
}

/** Türkçe sayı biçimi: 1234.5 → "1.234,50" (decimals sabit). en: "1,234.50". Eksi ASCII. */
export function fmtNumber(n: number, decimals = 2, locale: Locale = DEFAULT_LOCALE): string {
  const v = decimals === 2 ? round2(n) : Number(n.toFixed(decimals));
  // Sonlu olmayan değerde çıktı eski sürümden farklıdır, bilerek (Mesaj 12 R4): eskiden "NaN,undefined" ve
  // "Infinity,undefined" yazılıyordu, şimdi `String(v)` ("NaN", "Infinity", "-Infinity"). 1e21 ve üstü de artık üslü
  // değil düz basamakla yazılır. Bu değerler gerçek veride oluşmaz; kayıtlı not çevirisi (`localizeText`) etkilenmez.
  if (!Number.isFinite(v)) return String(v);
  return num(v, locale, { min: decimals, max: decimals, sign: 'ascii' });
}

/** "1.184,00 ₺"; en: "₺1,184.00", "-€12.50", sembolü olmayan para biriminde "CHF 12.50". Eksi ASCII. */
export function fmtMoney(n: number, currency = 'TRY', locale: Locale = DEFAULT_LOCALE): string {
  // Paket boş/boşluklu kodu TRY sayar; eski yazım kodu olduğu gibi yazıyordu. O kenar durumlar ve sonlu olmayan değer
  // eski yoldan (gövde `fmtNumber`'dan: "NaN ₺").
  if (Number.isFinite(n) && currency !== '' && currency === currency.trim()) return money(round2(n), currency, locale, { sign: 'ascii' });
  const body = fmtNumber(n, 2, locale);
  if (locale !== 'en') return `${body} ${currencySymbol(currency)}`;
  const sym = currencySymbol(currency);
  const [sign, abs] = body.startsWith('-') ? ['-', body.slice(1)] : ['', body];
  return sym === currency.toUpperCase() ? `${sign}${sym} ${abs}` : `${sign}${sym}${abs}`;
}

/** İngilizce para biçimi: "1,184.00 TRY" (itiraz metni EN için). Eksi ASCII. */
export function fmtMoneyEn(n: number, currency = 'TRY'): string {
  // Sonlu olmayan değerde "NaN TRY" (eskiden "NaN.undefined TRY"); bkz. `fmtNumber`.
  return `${fmtNumber(n, 2, 'en')} ${currency.toUpperCase()}`;
}

/** En az 1, en çok 3 ondalık: 4.02 → "4,02", 6 → "6,0", 4.025 → "4,025". */
export function fmtWeightNumber(n: number, locale: Locale = DEFAULT_LOCALE): string {
  const v = Math.round(n * 1000) / 1000;
  let s = Math.abs(v).toFixed(3).replace(/0+$/, '');
  if (s.endsWith('.')) s += '0';
  const [i, f] = s.split('.');
  const { group, decimal } = separators(locale);
  return (v < 0 ? '-' : '') + groupThousands(i!, group) + decimal + f;
}

/** "4,02 kg" */
export function fmtKg(n: number, locale: Locale = DEFAULT_LOCALE): string {
  return `${fmtWeightNumber(n, locale)} kg`;
}

/** "12 desi" (yurt içi ücretli ağırlık; sayı `fmtKg` ile aynı biçimde). */
export function fmtDesi(n: number, locale: Locale = DEFAULT_LOCALE): string {
  return `${fmtWeightNumber(n, locale)} desi`;
}

/** "40×30×25" (ondalıklar virgülle). */
export function fmtDims(d: { l: number; w: number; h: number }, locale: Locale = DEFAULT_LOCALE): string {
  const one = (x: number) => {
    const v = Math.round(x * 10) / 10;
    return Number.isInteger(v) ? String(v) : String(v).replace('.', separators(locale).decimal);
  };
  return `${one(d.l)}×${one(d.w)}×${one(d.h)}`;
}

/** "%38" / "%27,5"; en: "38%" / "27.5%". Kayıtlı not biçimi: en çok 2 ondalık, binlik yok, TR'de eksi `%`'den sonra ("%-5"). */
export function fmtPct(n: number, locale: Locale = DEFAULT_LOCALE): string {
  const r = round2(n);
  // Sonlu olmayan değer eski yazımıyla ("%NaN", "Infinity%"); 1e21 ve üstü artık üslü değil düz basamakla.
  if (!Number.isFinite(r)) return locale === 'en' ? `${r}%` : `%${r}`;
  const v = (r < 0 ? '-' : '') + num(Math.abs(r), locale, { max: 2, group: false });
  return locale === 'en' ? `${v}%` : `%${v}`;
}

/**
 * "2026-10-27" → "27.10.2026"; en: "27 Oct 2026" (panelle aynı yazım, `@sellerondata/format` `dateShort`; Y102: "10/05/2026"
 * 5 Ekim mi 10 Mayıs mı karışıyordu). Türkçe biçim KAYITLI NOT BİÇİMİDİR; DEĞİŞMEZ (rapor Y72-8). İngilizce yalnız
 * gösterimde (rapor, saklanan notun çevirisi) yazılır, kaydedilmez.
 */
export function fmtDate(iso: string, locale: Locale = DEFAULT_LOCALE): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  if (locale !== 'en') return `${m[3]}.${m[2]}.${m[1]}`;
  const out = dateShort(`${m[1]}-${m[2]}-${m[3]}`, 'en');
  return out === EMPTY ? iso : out;
}

/** "2026-10-05" → "5 Ekim 2026"; en: "5 October 2026". Gün ve ay karışmasın diye ay adıyla (tarih sırası sorusu). */
export function fmtLongDay(iso: string, locale: Locale = DEFAULT_LOCALE): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'tr-TR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)),
  );
}

/** Düzenlenecek alan için sayı: binlik yok ("4,5" / "4.5"). Aynı dilde `parseTrNumber` ile aynı sayıya döner. */
export function fmtNumberInput(n: number, maxDigits = 3, locale: Locale = DEFAULT_LOCALE): string {
  return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'tr-TR', { maximumFractionDigits: maxDigits, useGrouping: false }).format(n);
}

const SIMPLE_INT = /^-?\d+$/;
const SIMPLE_COMMA_DEC = /^-?\d+,\d+$/;

/**
 * Türkçe/İngilizce sayı okuma: "1.234,56" | "1234.56" | "4,0" | "1,234.56" | "-12,5" | "(12,50)" | "1.234,56 ₺".
 * Tek virgül her zaman ondalık; tek nokta ardından tam 3 hane geliyorsa (ve tam kısım 0 değilse) binlik ayırıcı sayılır.
 *
 * `locale` yalnız arayüz girdisi içindir: 'en' iken tek virgül ardından tam 3 hane binlik ("1,234" → 1234), tek nokta her
 * zaman ondalıktır ("1.234" → 1,234). İki ayırıcı birlikteyse son ayırıcı ondalıktır, iki dilde aynı. Dosya, fatura,
 * tarife ve PDF okuyan kod bu parametreyi geçmez: veri arayüz diline bağlı okunmaz.
 */
export function parseTrNumber(s: string | number | null | undefined, locale: Locale = DEFAULT_LOCALE): number | null {
  if (s == null) return null;
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  let t = String(s).trim();
  if (!t) return null;
  // sık yol (aşağıdaki genel kurallarla aynı sonuç): "123", "-123", "12,5", "-1234,56"
  if (SIMPLE_INT.test(t) || (locale !== 'en' && SIMPLE_COMMA_DEC.test(t))) {
    const v = Number(t.replace(',', '.'));
    return Number.isFinite(v) ? v : null;
  }
  let neg = false;
  if (/^\(.*\)$/.test(t)) {
    neg = true;
    t = t.slice(1, -1);
  }
  t = t.replace(/[\s\u00a0\u202f']/g, '').replace(/(TRY|TL|EUR|USD|GBP|CHF|SEK|NOK|DKK|PLN|CZK|HUF|RON|AED|CAD|AUD|JPY|CNY|KG|DESI|₺|€|\$|£|¥|%)/gi, '');
  if (t.endsWith('-')) {
    neg = !neg;
    t = t.slice(0, -1);
  }
  if (t.startsWith('-')) {
    neg = !neg;
    t = t.slice(1);
  } else if (t.startsWith('+')) {
    t = t.slice(1);
  }
  if (!/^[\d.,]+$/.test(t) || !/\d/.test(t)) return null;

  const lastDot = t.lastIndexOf('.');
  const lastComma = t.lastIndexOf(',');
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const decSep = lastDot > lastComma ? '.' : ',';
    const thouSep = decSep === '.' ? ',' : '.';
    const [intPart, ...rest] = t.split(decSep);
    if (rest.length !== 1) return null;
    if (!validGrouping(intPart!, thouSep)) return null;
    normalized = intPart!.split(thouSep).join('') + '.' + rest[0];
  } else if (lastComma >= 0) {
    const parts = t.split(',');
    if (parts.length === 2) normalized = locale === 'en' && parts[1]!.length === 3 && /^[1-9]\d{0,2}$/.test(parts[0]!) ? parts.join('') : parts[0] + '.' + parts[1];
    else if (validGrouping(t, ',')) normalized = parts.join('');
    else return null;
  } else if (lastDot >= 0) {
    const parts = t.split('.');
    if (parts.length > 2) {
      if (!validGrouping(t, '.')) return null;
      normalized = parts.join('');
    } else if (locale !== 'en' && parts[1]!.length === 3 && /^[1-9]\d{0,2}$/.test(parts[0]!)) {
      normalized = parts.join('');
    } else {
      normalized = parts[0] + '.' + parts[1];
    }
  } else {
    normalized = t;
  }
  if (normalized.startsWith('.')) normalized = '0' + normalized;
  if (normalized.endsWith('.')) normalized = normalized.slice(0, -1);
  const v = Number(normalized);
  if (!Number.isFinite(v)) return null;
  return neg ? -v : v;
}

function validGrouping(intPart: string, sep: string): boolean {
  if (!intPart.includes(sep)) return /^\d*$/.test(intPart);
  const groups = intPart.split(sep);
  if (!/^\d{1,3}$/.test(groups[0]!)) return false;
  return groups.slice(1).every((g) => /^\d{3}$/.test(g));
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Excel seri tarihini (1900 sistemi) YYYY-MM-DD'ye çevirir. */
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1) return null;
  const ms = Math.round((Math.floor(serial) - 25569) * 86400000);
  const dt = new Date(ms);
  if (Number.isNaN(dt.getTime())) return null;
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

export function dateToIso(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

const MONTHS: Record<string, number> = {
  jan: 1, ocak: 1, oca: 1, feb: 2, subat: 2, sub: 2, mar: 3, mart: 3, apr: 4, nisan: 4, nis: 4,
  may: 5, mayis: 5, jun: 6, haziran: 6, haz: 6, jul: 7, temmuz: 7, tem: 7, aug: 8, agustos: 8, agu: 8,
  sep: 9, eylul: 9, eyl: 9, oct: 10, ekim: 10, eki: 10, nov: 11, kasim: 11, kas: 11, dec: 12, aralik: 12, ara: 12,
};

/**
 * Tarih okuma → "YYYY-MM-DD" | null.
 * "27.10.2026", "27/10/2026", "2026-10-27", "2026-10-27T10:00", "10/27/2026" (gün > 12 ise ay/gün anlaşılır),
 * "27 Ekim 2026", Excel seri sayısı (ör. 46322), Date nesnesi. Belirsiz "05/06/2026" Türkçe kabulüyle gün/ay okunur.
 */
export function parseTrDate(v: string | number | Date | null | undefined): string | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : dateToIso(v);
  if (typeof v === 'number') return v > 20000 && v < 80000 ? excelSerialToIso(v) : null;
  const s = v.trim();
  if (!s) return null;

  let m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return isoDate(+m[1]!, +m[2]!, +m[3]!);

  m = /^(\d{1,2})([./-])(\d{1,2})\2(\d{2}|\d{4})(?:[T\s,].*)?$/.exec(s);
  if (m) {
    const a = +m[1]!;
    const b = +m[3]!;
    const y = +m[4]!;
    if (a > 12 && b <= 12) return isoDate(y, b, a);
    if (b > 12 && a <= 12) return isoDate(y, a, b);
    return isoDate(y, b, a);
  }

  m = /^(\d{8})$/.exec(s);
  if (m) return isoDate(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8));

  if (/^\d{5}([.,]\d+)?$/.test(s)) {
    const n = Number(s.replace(',', '.'));
    if (n > 20000 && n < 80000) return excelSerialToIso(n);
  }

  const folded = s
    .toLowerCase()
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  m = /^(\d{1,2})[\s.-]+([a-z]+)\.?[\s.,-]+(\d{4})/.exec(folded);
  if (m) {
    const mon = MONTHS[m[2]!] ?? MONTHS[m[2]!.slice(0, 3)];
    if (mon) return isoDate(+m[3]!, mon, +m[1]!);
  }
  m = /^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(folded);
  if (m) {
    const mon = MONTHS[m[1]!] ?? MONTHS[m[1]!.slice(0, 3)];
    if (mon) return isoDate(+m[3]!, mon, +m[2]!);
  }
  return null;
}
