// Yalnız hafif alt yol: kök '@deciship/core' mobilde kullanılmaz (exceljs vb. ağır modüller).
import { normalizeLocale, type Locale } from '@deciship/core/i18n';
import * as F from '@sellerondata/format';
import { isTimeZone, zonedDay } from '@sellerondata/format/zoned';
import { i18n } from '../i18n';

/** İstemcide biçimleme dili (tek nokta); i18next dil değiştirince güncellenir. */
let formatLocale: Locale = normalizeLocale(i18n.language);

export function setFormatLocale(locale: string): void {
  formatLocale = normalizeLocale(locale);
}

export function getFormatLocale(): Locale {
  return formatLocale;
}

i18n.on('languageChanged', setFormatLocale);

const isEn = () => formatLocale === 'en';

/** Ekran sayısı: `decimals` sabit ya da (trimZeros) en çok; eksi Unicode `−`. Değer yoksa kısa çizgi "–" (bugünkü yazım). */
export function fmtNum(n: number | null | undefined, decimals = 1, trimZeros = false): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  return F.num(n, formatLocale, { min: trimZeros ? 0 : decimals, max: decimals });
}

/** Tuş takımı / giriş alanı metni: her zaman virgüllü ve binliksiz (NumPad ve parseNum bu biçimi bekler). */
export function fmtInput(n: number | null | undefined, decimals = 3): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  const s = n.toFixed(decimals);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '').replace('.', ',') : s;
}

/** Giriş metnindeki ondalık virgülü yalnız GÖSTERİMDE etkin dile uydurur (EN'de nokta). */
export function showDecimal(s: string): string {
  return isEn() ? s.replace(',', '.') : s;
}

export function fmtKg(n: number | null | undefined): string {
  return `${fmtNum(n, 2)} kg`;
}

export function fmtDims(l: number, w: number, h: number): string {
  return `${fmtNum(l, 1, true)}×${fmtNum(w, 1, true)}×${fmtNum(h, 1, true)} cm`;
}

export { parseNum } from './parseNum';

// Ölçüm zamanları an (timestamp) olarak okunur: `new Date(iso)`; `isToday` ve `dayKey` ile aynı yorum.
//
// Saat dilimi (11-B7): "bugün", gün grubu ve gösterilen saat firmanın saat dilimiyle (`me.activeOrg.timeZone`; oturum
// `setFormatTimeZone` ile verir). Firma saat dilimi bilinmiyorsa (eski sunucu, profil gelmeden) telefonun saati: bugünkü
// davranış. Hermes: yalnız temel `Intl.DateTimeFormat` + `timeZone` (ortak paketin kuralı); cihaz bu adı tanımazsa
// `isTimeZone` false döner ve telefonun saatine düşülür.

/** Firma saat dilimi (IANA adı) ya da telefonun saati için undefined. */
let orgTimeZone: string | undefined;

/** Geçerli IANA adı firma saat dilimi olur; boş, null ya da tanınmayan ad telefonun saatine döndürür. */
export function setFormatTimeZone(timeZone: string | null | undefined): void {
  orgTimeZone = isTimeZone(timeZone) ? timeZone.trim() : undefined;
}

export function getFormatTimeZone(): string | undefined {
  return orgTimeZone;
}

type Ymd = { y: number; m: number; d: number };

/** Anın takvim günü: saat dilimi verilmişse orada, yoksa telefonun yerel saatinde. Geçersiz an null. */
function ymdOf(at: Date, timeZone: string | undefined): Ymd | null {
  if (Number.isNaN(at.getTime())) return null;
  if (!timeZone) return { y: at.getFullYear(), m: at.getMonth() + 1, d: at.getDate() };
  const day = zonedDay(at, timeZone);
  if (!day) return null;
  const [y, m, d] = day.split('-').map(Number);
  return { y: y!, m: m!, d: d! };
}

const ymdKey = (x: Ymd) => `${x.y}-${String(x.m).padStart(2, '0')}-${String(x.d).padStart(2, '0')}`;
/** Takvim gününün sıra numarası (gün farkı için); saat dilimi ve yaz saati etkilemez. */
const ymdOrdinal = (x: Ymd) => Date.UTC(x.y, x.m - 1, x.d) / 86_400_000;
/** Haftanın günü (0 = Pazar). */
const ymdWeekday = (x: Ymd) => new Date(Date.UTC(x.y, x.m - 1, x.d)).getUTCDay();

/** "14:12" (iki dilde 24 saat); geçersizse "—". */
export function fmtTime(iso: string): string {
  return F.time(new Date(iso), formatLocale, { timeZone: orgTimeZone });
}

const list = (key: string): string[] => i18n.t(key, { ns: 'measure', returnObjects: true }) as unknown as string[];
const DAYS = () => list('format.days');
const MONTHS = () => list('format.months');

function dayMonthText(x: Ymd): string {
  return i18n.t('format.dayMonth', { ns: 'measure', day: DAYS()[ymdWeekday(x)], date: x.d, month: MONTHS()[x.m - 1] });
}

export function fmtToday(d = new Date()): string {
  const x = ymdOf(d, orgTimeZone);
  return x ? dayMonthText(x) : F.EMPTY;
}

/** Saat diliminde gün başı (gece yarısı) anı; aynı gün için bir kez hesaplanır. */
const zonedStartCache = new Map<string, number>();

function zonedStartOfDay(now: Date, timeZone: string): Date {
  const day = zonedDay(now, timeZone);
  // Cihazın biçimleyicisi günü okunur vermedi: arama 30 saat öncesine kayardı ("bugün" dünü de kapsardı). Telefonun gece yarısı.
  if (!day) return localMidnight(now);
  const key = `${timeZone}|${day}`;
  const hit = zonedStartCache.get(key);
  if (hit !== undefined) return new Date(hit);
  // Gece yarısı, günü `day` olan en erken an. Saat dilimi farkı ve yaz saati 26 saati aşmaz: `lo` kesin önceki gün.
  // `zonedDay` dışında Intl özelliği gerekmez (Hermes'te `formatToParts` yok); ~28 adımda milisaniyesine kadar bulunur.
  let lo = now.getTime() - 30 * 3_600_000;
  let hi = now.getTime();
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (zonedDay(mid, timeZone) < day) lo = mid;
    else hi = mid;
  }
  if (zonedStartCache.size > 32) zonedStartCache.clear();
  zonedStartCache.set(key, hi);
  return new Date(hi);
}

/** Bugünün başı: firma saat diliminde (verilmişse ya da ayarlıysa), yoksa telefonun yerel gece yarısı. */
export function startOfToday(timeZone: string | undefined = orgTimeZone): Date {
  const now = new Date();
  // Ayarlı saat dilimi zaten denetlendi; liste süzgecinde her satırda yeniden biçimleyici kurulmasın.
  if (timeZone && (timeZone === orgTimeZone || isTimeZone(timeZone))) return zonedStartOfDay(now, timeZone);
  return localMidnight(now);
}

function localMidnight(at: Date): Date {
  const d = new Date(at.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

export function isToday(iso: string): boolean {
  return new Date(iso).getTime() >= startOfToday().getTime();
}

/** Sunucu enum değeri değişmez; yalnız görünen ad dile göre. */
export function dimMethodLabel(m: string): string {
  const known = ['LIDAR', 'AR', 'REFERENCE', 'MANUAL', 'PRESET'];
  return known.includes(m) ? i18n.t(`format.dimMethod.${m}`, { ns: 'measure' }) : m;
}

export function kindLabel(k: string): string {
  const known = ['PHOTO_BOX', 'PHOTO_SCALE', 'PHOTO_LABEL', 'PHOTO_OTHER'];
  return known.includes(k) ? i18n.t(`format.kind.${k}`, { ns: 'measure' }) : k;
}

/** Bugünse "14:12", değilse "22 Eki 14:12" / "22 Oct, 14:12"; geçersizse "—". */
export function fmtWhen(iso: string): string {
  if (isToday(iso)) return fmtTime(iso);
  return F.dateTime(new Date(iso), formatLocale, { year: false, timeZone: orgTimeZone });
}

/** "1 Kas 2026 14:12" / "1 Nov 2026, 14:12"; geçersizse "—". */
export function fmtDateTime(iso: string): string {
  return F.dateTime(new Date(iso), formatLocale, { timeZone: orgTimeZone });
}

/** Gün anahtarı (gruplama için; firma saat diliminde, yoksa telefonun): "2026-11-01"; geçersizse "—". */
export function dayKey(iso: string): string {
  const x = ymdOf(new Date(iso), orgTimeZone);
  return x ? ymdKey(x) : F.EMPTY;
}

/** Gün başlığı: "Bugün", "Dün", "Cuma, 30 Ekim" (başka yıl ise yıl da); geçersizse "—". */
export function fmtDayTitle(iso: string): string {
  const x = ymdOf(new Date(iso), orgTimeZone);
  const today = ymdOf(new Date(), orgTimeZone);
  if (!x || !today) return F.EMPTY;
  const diff = ymdOrdinal(today) - ymdOrdinal(x);
  if (diff === 0) return i18n.t('format.today', { ns: 'measure' });
  if (diff === 1) return i18n.t('format.yesterday', { ns: 'measure' });
  const base = dayMonthText(x);
  return x.y === today.y ? base : `${base} ${x.y}`;
}
