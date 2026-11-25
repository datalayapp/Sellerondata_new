// @sellerondata/format: ortak biçimleme (Mesaj 12, plan §3.4; kararlar rapor Y72).
//
// Bütün yüzeyler (kabuk, Merkez, DeciShip paneli, mobil, hesap motoru) sayı, para, yüzde ve tarihi buradan yazar.
// Saf TypeScript, bağımlılık yok, React/RN yok, tek dosya (Metro, Vite ve düz Node aynı yolu çözsün).
//
// Hermes kuralı (telefonda her cihazda aynı çıktı):
// - Sayılarda Intl hiç kullanılmaz; basamaklar ondalık metin üzerinde yuvarlanır, gruplama elle.
// - Tarihte yalnız temel Intl.DateTimeFormat (day, month, year, hour, minute, timeZone).
// - Yasak: Intl.NumberFormat, formatToParts, formatRange, narrowSymbol, compact, unit, RelativeTimeFormat, toLocale*.
//   `test/hermes.test.ts` kaynağı tarar.
//
// Kurallar:
// - Yuvarlama hesap motorunun kuralıdır (`calc.ts` `cleanFloat` + `round2`), her basamak sayısında: sayı önce 12 anlamlı
//   basamağa temizlenir (580.5449999… → 580.545), sonra `max` basamakta yarım-yukarı, sıfırdan uzağa yuvarlanır:
//   1.005 → 1,01; 2.675 → 2,68; −1.005 → −1,01. Böylece ekran, motorun kaydettiği not ve rapor aynı kuruşu yazar.
//   1e9 ve üstünde temizlik 15 anlamlı basamakla yapılır (Y108): 12345678901,23 kuruşuyla yazılır; 1234567890,0049
//   1234567890,00 olur (daha az basamak çift yuvarlamaydı: …,005 → …,01). Bedeli: ~1e13 üstünde 15 basamak yetmez,
//   kuruş kısalır (motorla aynı sınır).
// - En çok 15 ondalık (daha fazlası kayan nokta artığıdır).
// - Yuvarlanmış değer sıfırsa işaret yazılmaz: "−0,00 ₺" olmaz, "0,00 ₺" olur (Y72-1).
// - İşaret kipi: ekranda Unicode eksi `−` (varsayılan); dışa aktarılan ya da kaydedilen metinde ASCII `-` (Y72-2).
// - Para ile simge/kod arası boşluklu, bilinmeyen kod da: "2,50 CHF", "CHF 2.50" (Y72-3). Ekran kipinde bölünmez boşluk
//   (U+00A0; dar hücrede tutar ile simge ayrı satıra düşmesin), ASCII kipinde düz boşluk (U+0020).
// - Değer yoksa ya da geçersizse (null, NaN, Infinity, geçersiz tarih) `EMPTY` ("—"); girdi geri yazılmaz (Y72-6).
// - Saat dilimindeki takvim günü ayrı girişte: `@sellerondata/format/zoned` (`src/zoned.ts`; Y132).

export type FmtLocale = 'tr' | 'en';

/** 'en', 'en-US', 'EN_gb' → 'en'; geri kalan her şey (null dahil) → 'tr'. */
export function fmtLocale(x?: string | null): FmtLocale {
  return typeof x === 'string' && x.trim().toLowerCase().startsWith('en') ? 'en' : 'tr';
}

/** Boş ya da geçersiz değerin yazımı (uzun çizgi). */
export const EMPTY = '—';

/** Simgesi bilinen para birimleri. Burada olmayan kod olduğu gibi (büyük harf) yazılır. */
export const CURRENCY_SYMBOL: Readonly<Record<string, string>> = Object.freeze({ TRY: '₺', USD: '$', EUR: '€', GBP: '£' });

/** Kod boşsa TRY; büyük harfe çevrilir, kenar boşlukları atılır. */
function currencyCode(code?: string | null): string {
  const c = (code ?? '').trim().toUpperCase();
  return c || 'TRY';
}

/** "TRY" → "₺"; bilinmeyen kod büyük harfle kendisi ("chf" → "CHF"); boş → "₺". */
export function currencySymbol(code?: string | null): string {
  const c = currencyCode(code);
  return CURRENCY_SYMBOL[c] ?? c;
}

/** Eksi işareti kipi: 'unicode' `−` (ekran), 'ascii' `-` (dışa aktarma, girdi alanı, kayıtlı not). */
export type Sign = 'ascii' | 'unicode';

const MINUS: Readonly<Record<Sign, string>> = { ascii: '-', unicode: String.fromCharCode(0x2212) };
/** Tutar ile simge/kod arası: ekranda bölünmez, dışa giden metinde düz boşluk. */
const MONEY_GAP: Readonly<Record<Sign, string>> = { ascii: ' ', unicode: String.fromCharCode(0xa0) };

export interface NumOpts {
  /** En az ondalık basamak (varsayılan 0). */
  min?: number;
  /** En çok ondalık basamak (varsayılan 2); 0–15. */
  max?: number;
  sign?: Sign;
  /** Pozitif değerde "+" (yuvarlanmış değer sıfırsa yazılmaz). */
  plus?: boolean;
  /** Binlik ayırıcı (varsayılan açık). */
  group?: boolean;
}

export interface MoneyOpts {
  sign?: Sign;
  plus?: boolean;
  /** Ondalık basamak (varsayılan 2); en az ve en çok aynıdır. */
  decimals?: number;
}

type Num = number | null | undefined;

const isNum = (n: Num): n is number => typeof n === 'number' && Number.isFinite(n);

function clampInt(x: number | undefined, lo: number, hi: number, dflt: number): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(x)));
}

const MAX_DECIMALS = 15;

/** Üslü yazımı ("1.5e-7", "1e+21") düz ondalık metne çevirir. Girdi işaretsiz ve sonludur. */
function plainDecimal(s: string): string {
  const e = s.indexOf('e');
  if (e < 0) return s;
  const mant = s.slice(0, e);
  const exp = Number(s.slice(e + 1));
  const dot = mant.indexOf('.');
  const ds = mant.replace('.', '');
  const point = (dot < 0 ? mant.length : dot) + exp; // ondalık noktanın `ds` içindeki yeri
  if (point <= 0) return `0.${'0'.repeat(-point)}${ds}`;
  if (point >= ds.length) return ds + '0'.repeat(point - ds.length);
  return `${ds.slice(0, point)}.${ds.slice(point)}`;
}

/** Bu büyüklükten itibaren 12 anlamlı basamak kuruşu siler; temizlik daha geniş yapılır (Y108, `calc.ts` ile aynı). */
const WIDE_FROM = 1e9;

/** 1e9 ve üstünde temizlik basamağı: double'ın güvenilir sınırı (`calc.ts` `WIDE_DIGITS` ile aynı). */
const WIDE_DIGITS = 15;

/** Rakam metnine 1 ekler ("199" → "200", "99" → "100"). */
function incDigits(d: string): string {
  const a = d.split('');
  let i = a.length - 1;
  while (i >= 0 && a[i] === '9') a[i--] = '0';
  if (i < 0) return `1${a.join('')}`;
  a[i] = String(Number(a[i]) + 1);
  return a.join('');
}

/**
 * Pozitif `abs` için tam ve ondalık basamaklar, `decimals` basamakta yuvarlanmış. Hesap motorunun kuralı:
 * 12 anlamlı basamağa temizle (`Number(x.toPrecision(12))`, `calc.ts` `cleanFloat` ile aynı sonuç), sonra ondalık
 * metin üzerinde yarım-yukarı. Metin üzerinde çalıştığı için her büyüklükte ve basamak sayısında kayan nokta artığı yok.
 * 1e9 ve üstünde temizlik 15 basamakla (`calc.ts` `roundWide` ile aynı adımlar; ikisi birlikte değişir).
 */
function digits(abs: number, decimals: number): [string, string] {
  const clean = Number(abs.toPrecision(abs < WIDE_FROM ? 12 : WIDE_DIGITS));
  const s = plainDecimal(String(clean));
  const dot = s.indexOf('.');
  let int = dot < 0 ? s : s.slice(0, dot);
  let frac = dot < 0 ? '' : s.slice(dot + 1);
  if (frac.length > decimals) {
    const up = frac.charCodeAt(decimals) >= 53; // '5'
    frac = frac.slice(0, decimals);
    if (up) {
      const bumped = incDigits(int + frac);
      int = bumped.slice(0, bumped.length - decimals) || '0';
      frac = bumped.slice(bumped.length - decimals);
    }
  }
  return [int.replace(/^0+(?=\d)/, ''), frac.padEnd(decimals, '0')];
}

function groupInt(int: string, sep: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

interface Parts {
  /** İşaretsiz gövde: "1.234,50". */
  body: string;
  /** Yuvarlanmış değer sıfır mı (işaret yazılmaz). */
  zero: boolean;
  neg: boolean;
}

function parts(n: number, locale: string, min: number, max: number, group: boolean): Parts {
  const en = locale === 'en';
  const [int, rawFrac] = digits(Math.abs(n), max);
  let frac = rawFrac;
  while (frac.length > min && frac.endsWith('0')) frac = frac.slice(0, -1);
  const zero = !/[1-9]/.test(int + rawFrac);
  const body = (group ? groupInt(int, en ? ',' : '.') : int) + (frac ? (en ? '.' : ',') + frac : '');
  return { body, zero, neg: n < 0 };
}

function signOf(p: Parts, sign: Sign | undefined, plus: boolean | undefined): string {
  if (p.zero) return '';
  if (p.neg) return MINUS[sign ?? 'unicode'];
  return plus ? '+' : '';
}

/** Sayı: TR "1.234,5", EN "1,234.5". `min`..`max` ondalık; değer yoksa `EMPTY`. */
export function num(n: Num, locale: FmtLocale, opts: NumOpts = {}): string {
  if (!isNum(n)) return EMPTY;
  const max = clampInt(opts.max, 0, MAX_DECIMALS, 2);
  const min = clampInt(opts.min, 0, max, 0);
  const p = parts(n, locale, min, max, opts.group !== false);
  return signOf(p, opts.sign, opts.plus) + p.body;
}

/** Para tutarının parçaları: metni ayrıştırmadan tutarı ve birimi ayrı yazmak (ör. birimi küçük göstermek) için. */
export interface MoneyParts {
  /** "", "−", "-" ya da "+": her zaman en önde. */
  sign: string;
  /** İşaretsiz tutar: "1.234,50" / "1,234.50". */
  amount: string;
  /** Simge ya da bilinmeyen kod: "₺", "CHF". */
  unit: string;
  /** Birim tutarın önünde mi (EN). */
  unitFirst: boolean;
  /** Birim ile tutar arası: ekranda bölünmez boşluk, ASCII kipinde düz boşluk; EN'de simge bitişikse "". */
  gap: string;
}

/** `money` ile aynı kurallar, parça parça. Değer yoksa `null`. Metin: sign + (unitFirst ? unit+gap+amount : amount+gap+unit). */
export function moneyParts(n: Num, currency: string | null | undefined, locale: FmtLocale, opts: MoneyOpts = {}): MoneyParts | null {
  if (!isNum(n)) return null;
  const d = clampInt(opts.decimals, 0, MAX_DECIMALS, 2);
  const p = parts(n, locale, d, d, true);
  const code = currencyCode(currency);
  const symbol = CURRENCY_SYMBOL[code];
  const gap = MONEY_GAP[opts.sign ?? 'unicode'];
  const unitFirst = locale === 'en';
  return { sign: signOf(p, opts.sign, opts.plus), amount: p.body, unit: symbol ?? code, unitFirst, gap: unitFirst && symbol ? '' : gap };
}

/**
 * Para: TR "1.234,50 ₺", EN "₺1,234.50". Bilinmeyen kod TR "1.234,50 CHF", EN "CHF 1,234.50".
 * İşaret tutarın en önünde: "−₺5.00", "−5,00 ₺". Değer yoksa `EMPTY`.
 */
export function money(n: Num, currency: string | null | undefined, locale: FmtLocale, opts: MoneyOpts = {}): string {
  const m = moneyParts(n, currency, locale, opts);
  if (!m) return EMPTY;
  return m.unitFirst ? `${m.sign}${m.unit}${m.gap}${m.amount}` : `${m.sign}${m.amount}${m.gap}${m.unit}`;
}

/** Yüzde; `value0to100` 0-100 arasıdır (86.4 → TR "%86,4", EN "86.4%"). Varsayılan en çok 1 ondalık. */
export function percent(value0to100: Num, locale: FmtLocale, opts: { max?: number; min?: number; sign?: Sign; group?: boolean } = {}): string {
  if (!isNum(value0to100)) return EMPTY;
  const max = clampInt(opts.max, 0, MAX_DECIMALS, 1);
  const min = clampInt(opts.min, 0, max, 0);
  const p = parts(value0to100, locale, min, max, opts.group !== false);
  const s = signOf(p, opts.sign, false);
  return locale === 'en' ? `${s}${p.body}%` : `${s}%${p.body}`;
}

// ---------------------------------------------------------------- tarih

export type DateInput = string | number | Date | null | undefined;

const DAY_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * "2026-10-27" takvim günüdür: UTC gece yarısı olarak okunur ve UTC'de yazılır, cihazın saat dilimi günü kaydırmaz.
 * Saatli ISO metni, sayı (ms) ve Date nesnesi o andır.
 */
function toDate(v: DateInput): { d: Date; day: boolean } | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : { d: v, day: false };
  if (typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : { d, day: false };
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  const m = DAY_ONLY.exec(s);
  if (m) {
    const y = +m[1]!;
    const mo = +m[2]! - 1;
    const day = +m[3]!;
    const d = new Date(Date.UTC(y, mo, day));
    if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo || d.getUTCDate() !== day) return null;
    return { d, day: true };
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : { d, day: false };
}

type DateParts = { day?: 'numeric'; month?: 'short' | 'long'; year?: 'numeric'; hour?: '2-digit'; minute?: '2-digit' };

const intlTag = (locale: string) => (locale === 'en' ? 'en-GB' : 'tr-TR');
const formatters = new Map<string, Intl.DateTimeFormat>();

function dtf(locale: string, o: DateParts, timeZone: string | undefined): Intl.DateTimeFormat {
  const key = `${intlTag(locale)}|${o.day ?? ''}|${o.month ?? ''}|${o.year ?? ''}|${o.hour ?? ''}|${o.minute ?? ''}|${timeZone ?? ''}`;
  let f = formatters.get(key);
  if (!f) {
    const options: Intl.DateTimeFormatOptions = { ...o };
    if (timeZone) options.timeZone = timeZone;
    f = new Intl.DateTimeFormat(intlTag(locale), options);
    formatters.set(key, f);
  }
  return f;
}

function write(v: DateInput, locale: string, o: DateParts, timeZone?: string): string {
  const x = toDate(v);
  if (!x) return EMPTY;
  return dtf(locale, o, x.day ? 'UTC' : timeZone).format(x.d);
}

/** Kısa tarih: TR "27 Eki 2026", EN "27 Oct 2026" (gün ay-kısa yıl; Y72-4). */
export function dateShort(v: DateInput, locale: FmtLocale, opts: { timeZone?: string } = {}): string {
  return write(v, locale, { day: 'numeric', month: 'short', year: 'numeric' }, opts.timeZone);
}

/** Saat, 24 saat: "14:32" (her iki dilde; Y72-5). */
export function time(v: DateInput, locale: FmtLocale, opts: { timeZone?: string } = {}): string {
  return write(v, locale, { hour: '2-digit', minute: '2-digit' }, opts.timeZone);
}

/**
 * Tarih-saat: TR "27 Eki 2026 14:32", EN "27 Oct 2026, 14:32" (yıl 4 hane, 24 saat; Y72-5).
 * `year: false` yılı atar ("27 Eki 14:32", "27 Oct, 14:32").
 */
export function dateTime(v: DateInput, locale: FmtLocale, opts: { timeZone?: string; year?: boolean } = {}): string {
  const x = toDate(v);
  if (!x) return EMPTY;
  const tz = x.day ? 'UTC' : opts.timeZone;
  const datePart = dtf(locale, opts.year === false ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }, tz).format(x.d);
  const timePart = dtf(locale, { hour: '2-digit', minute: '2-digit' }, tz).format(x.d);
  return `${datePart}${locale === 'en' ? ', ' : ' '}${timePart}`;
}

/** Gün ve ay: TR "27 Eki", EN "27 Oct". */
export function dayMonth(v: DateInput, locale: FmtLocale, opts: { timeZone?: string } = {}): string {
  return write(v, locale, { day: 'numeric', month: 'short' }, opts.timeZone);
}

/** Uzun tarih: TR "27 Ekim 2026", EN "27 October 2026" (çekirdek `fmtLongDay` ile aynı yazım). */
export function dateLong(v: DateInput, locale: FmtLocale, opts: { timeZone?: string } = {}): string {
  return write(v, locale, { day: 'numeric', month: 'long', year: 'numeric' }, opts.timeZone);
}
