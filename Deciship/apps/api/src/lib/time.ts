/**
 * Firmanın saat dilimi. Ölçüm anı gerçek bir andır: "hangi gün" sorusu firmanın gününe göre yanıtlanır.
 * Faturanın gün alanları (fatura tarihi, sevk tarihi) ise zaten gündür, UTC gece yarısı saklanır, burada kaydırılmaz.
 */
export const DEFAULT_TIME_ZONE = 'Europe/Istanbul';

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(timeZone, f);
  }
  return f;
}

/**
 * Yalnız IANA adı. Intl `+03:00` da kabul eder ama Postgres aynı metni ters işaretli (POSIX) okur: gün sınırı kayardı.
 */
const IANA_NAME = /^(UTC|[A-Z][A-Za-z_]+(\/[A-Za-z0-9_+-]+)+)$/;

export function isTimeZone(value: string): boolean {
  if (!IANA_NAME.test(value)) return false;
  try {
    partsFormatter(value);
    return true;
  } catch {
    return false;
  }
}

function fields(at: Date, timeZone: string) {
  const out: Record<string, string> = {};
  for (const p of partsFormatter(timeZone).formatToParts(at)) out[p.type] = p.value;
  return out as { year: string; month: string; day: string; hour: string; minute: string; second: string };
}

/**
 * Firmanın saat diliminde "YYYY-MM-DD HH:mm" (itiraz metni, kanıt ZIP'i, rapor). Burada durur (eskiden `services/evidence.ts`):
 * rapor dosya çalışanında (çocuk süreç) üretilir, veritabanı ve ortam içe aktaran modüle bağlanmamalı (Mesaj 6, 19-B1).
 */
export function zonedDateTimeText(at: Date, timeZone: string): string {
  const f = fields(at, timeZone);
  return `${f.year}-${f.month}-${f.day} ${f.hour}:${f.minute}`;
}

/** O anda firmada hangi gün: `YYYY-MM-DD`. */
export function zonedDate(at: Date, timeZone: string): string {
  const f = fields(at, timeZone);
  return `${f.year}-${f.month}-${f.day}`;
}

/** Saat diliminin o andaki UTC farkı, milisaniye. */
function offsetMs(at: Date, timeZone: string): number {
  const f = fields(at, timeZone);
  const asUtc = Date.UTC(Number(f.year), Number(f.month) - 1, Number(f.day), Number(f.hour), Number(f.minute), Number(f.second));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Firmanın o gününün başladığı an. Yaz saati geçişinde fark gün içinde değişir: ikinci hesap bunu düzeltir. */
export function zonedDayStart(day: string, timeZone: string): Date {
  const utc = Date.parse(`${day}T00:00:00.000Z`);
  const first = utc - offsetMs(new Date(utc), timeZone);
  return new Date(utc - offsetMs(new Date(first), timeZone));
}

/** Kapalı gün aralığı `from..to`, firmanın gününe göre `[gte, lt)`. */
export function zonedRange(from: string, to: string, timeZone: string): { gte: Date; lt: Date } {
  const next = new Date(Date.parse(`${to}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10);
  return { gte: zonedDayStart(from, timeZone), lt: zonedDayStart(next, timeZone) };
}
