import type { HubValue } from '@sellerondata/contracts';
import * as F from '@sellerondata/format';
import { shellTimeZone } from './timeZone.ts';

/**
 * Etkin dile göre biçim (§9). İnce sarmalayıcı: sayı, para, yüzde ve tarihi `@sellerondata/format` yazar (rapor Y72).
 * Para: Türkçede "2.143,20 ₺" (DESIGN.md), İngilizcede "₺2,143.20"; tutar ile simge arası bölünmez boşluk.
 * Pakette olmayan biçimler (kısa sayı `compact`, gün birimi, göreli zaman, tarih aralığı, serbest tarih seçenekleri)
 * burada Intl ile kalır; onlarda da aynı kurallar uygulanır: eksi `−`, sıfıra yuvarlanan değerde işaret yok,
 * geçersiz değer ya da tarih "—".
 */
const NBSP = String.fromCharCode(0xa0);
const MINUS = String.fromCharCode(0x2212);
const tag = (locale: string) => (locale === 'en' ? 'en-GB' : 'tr-TR');
const loc = (locale: string) => F.fmtLocale(locale);

/** Intl'in yazdığı sayı metnine paketin işaret kuralı: ilk ASCII eksi `−` olur; hiç sıfırdan farklı rakam yoksa işaret atılır. */
function screenSign(text: string): string {
  if (!/[1-9]/.test(text)) return text.replace('-', '').replace(MINUS, '');
  return text.replace('-', MINUS);
}

const BASIC_NUMBER = new Set(['minimumFractionDigits', 'maximumFractionDigits', 'useGrouping']);

/**
 * Sayı. Yalnız basamak ve gruplama seçenekleri verilirse paket yazar (varsayılan en çok 2 ondalık);
 * başka Intl seçeneği (ör. `notation: 'compact'`) verilirse Intl yazar, işaret kuralı yine uygulanır.
 */
export function formatNumber(value: number, locale: string, opts?: Intl.NumberFormatOptions): string {
  const o = opts ?? {};
  const basic = Object.keys(o).every((k) => BASIC_NUMBER.has(k) || (k === 'notation' && o.notation === 'standard'));
  if (basic) {
    const min = o.minimumFractionDigits ?? 0;
    return F.num(value, loc(locale), { min, max: o.maximumFractionDigits ?? Math.max(2, min), group: o.useGrouping !== false });
  }
  if (!Number.isFinite(value)) return F.EMPTY;
  return screenSign(new Intl.NumberFormat(tag(locale), o).format(value));
}

/** Para. `compact`: kısa tutar ("1,2B ₺", "₺1.2K"; Intl). `signed`: pozitifte "+". */
export function formatMoney(value: number, currency: string | undefined, locale: string, opts?: { compact?: boolean; signed?: boolean }): string {
  if (!opts?.compact) return F.money(value, currency, loc(locale), { plus: opts?.signed });
  if (!Number.isFinite(value)) return F.EMPTY;
  const body = new Intl.NumberFormat(tag(locale), { notation: 'compact', maximumFractionDigits: 1, minimumFractionDigits: 0 })
    .formatToParts(Math.abs(value))
    .filter((p) => p.type !== 'literal')
    .map((p) => p.value)
    .join('');
  const sign = !/[1-9]/.test(body) ? '' : value < 0 ? MINUS : opts.signed && value > 0 ? '+' : '';
  const code = (currency ?? '').trim().toUpperCase() || 'TRY';
  const symbol = F.CURRENCY_SYMBOL[code];
  if (locale !== 'en') return `${sign}${body}${NBSP}${symbol ?? code}`;
  return symbol ? `${sign}${symbol}${body}` : `${sign}${code}${NBSP}${body}`;
}

/** `value` 0-100 arasıdır: 86.4 = %86,4. */
export function formatPercent(value: number, locale: string, maxFraction = 1): string {
  return F.percent(value, loc(locale), { max: maxFraction });
}

type DateOpts = Intl.DateTimeFormatOptions;
const sameOpts = (a: DateOpts, b: DateOpts) => {
  const ka = Object.keys(a) as (keyof DateOpts)[];
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};
const SHORT: DateOpts = { day: 'numeric', month: 'short', year: 'numeric' };
const DAY_MONTH: DateOpts = { day: 'numeric', month: 'short' };

/**
 * Saat dilimi (rapor Y132): an (saatli metin) firmanın saat diliminde (`shellTimeZone`, `/me`'den) yazılır; atanmamışsa
 * tarayıcının saatinde (bugünkü davranış). Yalnız gün olan değer ("2026-10-27") takvim günüdür: UTC gece yarısı olarak
 * okunur ve UTC'de yazılır, hiçbir saat dilimi günü kaydırmaz.
 */
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Geçersizse null. `day`: yalnız gün (UTC'de yazılır); on karakterli başka metin geçersizdir (eskisi gibi). */
function toDate(iso: string): { d: Date; day: boolean } | null {
  if (typeof iso !== 'string' || !iso.trim()) return null;
  const day = iso.length === 10;
  if (day && !DAY_ONLY.test(iso)) return null;
  const d = new Date(day ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? null : { d, day };
}

const zoneOpts = (x: { day: boolean }): { timeZone?: string } => {
  if (x.day) return { timeZone: 'UTC' };
  const tz = shellTimeZone();
  return tz ? { timeZone: tz } : {};
};

/** Kısa tarih "27 Eki 2026" / "27 Oct 2026" (paket). Başka seçenek verilirse Intl yazar. Geçersizse "—". */
export function formatDate(iso: string, locale: string, opts?: DateOpts): string {
  const tz = { timeZone: shellTimeZone() };
  if (!opts || sameOpts(opts, SHORT)) return F.dateShort(iso, loc(locale), tz);
  if (sameOpts(opts, DAY_MONTH)) return F.dayMonth(iso, loc(locale), tz);
  const x = toDate(iso);
  return x ? new Intl.DateTimeFormat(tag(locale), { ...opts, ...zoneOpts(x) }).format(x.d) : F.EMPTY;
}

/** "27 Eki 2026 14:32" / "27 Oct 2026, 14:32". */
export function formatDateTime(iso: string, locale: string): string {
  return F.dateTime(iso, loc(locale), { timeZone: shellTimeZone() });
}

/** Aralığın iki ucu da takvim günüdür (saatli metnin ilk on karakteri). */
export function formatDateRange(from: string, to: string, locale: string): string {
  const a = toDate(from.slice(0, 10));
  const b = toDate(to.slice(0, 10));
  if (!a || !b) return `${formatDate(from, locale)} – ${formatDate(to, locale)}`;
  return new Intl.DateTimeFormat(tag(locale), { ...SHORT, timeZone: 'UTC' }).formatRange(a.d, b.d);
}

export function formatDays(value: number, locale: string): string {
  if (!Number.isFinite(value)) return F.EMPTY;
  return screenSign(new Intl.NumberFormat(tag(locale), { style: 'unit', unit: 'day', unitDisplay: 'long', maximumFractionDigits: 1 }).format(value));
}

/** "3 saat önce" */
export function formatRelative(iso: string, locale: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return F.EMPTY;
  const sec = Math.round((t - now) / 1000);
  const f = new Intl.RelativeTimeFormat(tag(locale), { numeric: 'auto' });
  const abs = Math.abs(sec);
  if (abs < 60) return f.format(sec, 'second');
  if (abs < 3600) return f.format(Math.round(sec / 60), 'minute');
  if (abs < 86400) return f.format(Math.round(sec / 3600), 'hour');
  if (abs < 86400 * 30) return f.format(Math.round(sec / 86400), 'day');
  return formatDate(iso, locale);
}

/** Sözleşmedeki ham değer + `format` → metin. Değer yoksa uzun çizgi. */
export function formatHubValue(v: HubValue, locale: string): string {
  const { value, format, currency } = v;
  if (value === null || value === undefined || value === '') return F.EMPTY;
  switch (format) {
    case 'money':
      return typeof value === 'number' ? formatMoney(value, currency, locale) : String(value);
    case 'number':
      return typeof value === 'number' ? formatNumber(value, locale, { maximumFractionDigits: 2 }) : String(value);
    case 'percent':
      return typeof value === 'number' ? formatPercent(value, locale) : String(value);
    case 'duration_days':
      return typeof value === 'number' ? formatDays(value, locale) : String(value);
    case 'date':
      return formatDate(String(value), locale);
    case 'datetime':
      return formatDateTime(String(value), locale);
    default:
      return String(value);
  }
}

/** Ltd., Şti., A.Ş. gibi unvanlar kısaltmayı belirlemez: yoksa bütün limitedler "LŞ", son harf hep aynı olurdu. */
const LEGAL_WORDS = /^(ltd|lt|şti|sti|a\.?ş|as|a\.?s|inc|llc|gmbh|co|corp|tic|san|ticaret|sanayi|anonim|limited|şirketi|sirketi)\.?$/i;

/** Firma rozeti: adın ilk iki anlamlı sözcüğü. "Akis İhracat Tekstil Ltd. Şti." AI, "Akis Şanlıurfa Üretim A.Ş." AŞ. */
export function orgInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const meaningful = words.filter((w) => !LEGAL_WORDS.test(w));
  const use = meaningful.length ? meaningful : words;
  if (!use.length) return '?';
  return (use[0]!.charAt(0) + (use[1]?.charAt(0) ?? use[0]!.charAt(1) ?? '')).toLocaleUpperCase('tr-TR');
}

export function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  const first = p[0]!.charAt(0);
  const last = p.length > 1 ? p[p.length - 1]!.charAt(0) : '';
  return (first + last).toLocaleUpperCase('tr-TR');
}

/** Sunucudan gelen `href` yalnız aynı kökene gidebilir. */
export function safeHref(href: string | null | undefined, origin: string = typeof window === 'undefined' ? 'http://localhost' : window.location.origin): string | undefined {
  // eslint-disable-next-line no-control-regex
  if (!href || !href.startsWith('/') || href.startsWith('//') || /[\\\u0000-\u001f]/.test(href)) return undefined;
  try {
    return new URL(href, origin).origin === origin ? href : undefined;
  } catch {
    return undefined;
  }
}

/** "+905320000004" → "+90 532 000 00 04". Başka ülke olduğu gibi kalır. */
export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const m = phone.match(/^\+90(\d{3})(\d{3})(\d{2})(\d{2})$/);
  return m ? `+90 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : phone;
}
