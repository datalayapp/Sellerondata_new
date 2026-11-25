// Takvim günü, saat diliminde (rapor Y132). Bir anın hangi güne düştüğü saat dilimine bağlıdır: Türkiye'de 01:30 olan an
// UTC'de bir önceki gündür. Ekranlar "bugün", gün grubu ve hazır aralıkları firmanın saat dilimiyle buradan hesaplar.
//
// Giriş: `@sellerondata/format/zoned`. Ana girişe (`index.ts`) bilerek eklenmedi: ana giriş tek dosya kalır, uzantılı göreli
// içe aktarım (`./zoned.ts`) `allowImportingTsExtensions` açık olmayan tüketicide (hesap motoru) tip denetimini bozar.
// Hermes kuralı (index.ts başı): `formatToParts` yok; `en-US` sayısal çıktı ("11/01/2026") ayrıştırılır.
// Saat dilimi verilmezse cihazın saati kullanılır (Intl varsayılanı): firma saat dilimi henüz bilinmiyorken bugünkü davranış.

/** Saat dilimi geçerli bir IANA adı mı ("Europe/Istanbul", "UTC"). Boş, sayı ya da bilinmeyen ad false. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? '';
  let f = dayFormatters.get(key);
  if (!f) {
    const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit' };
    if (timeZone) options.timeZone = timeZone;
    f = new Intl.DateTimeFormat('en-US', options);
    dayFormatters.set(key, f);
  }
  return f;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Anın saat dilimindeki takvim günü: "YYYY-AA-GG". `timeZone` yoksa cihazın saat dilimi.
 * "2026-10-27" gibi yalnız gün olan metin zaten takvim günüdür, olduğu gibi döner.
 * Geçersiz an "" döner; geçersiz saat dilimi `RangeError` fırlatır (önce `isTimeZone` ile denetle).
 */
export function zonedDay(at: Date | number | string, timeZone?: string): string {
  if (typeof at === 'string' && DAY_ONLY.test(at.trim())) return at.trim();
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(dayFormatter(timeZone).format(d));
  if (!m) return '';
  return `${m[3]!.padStart(4, '0')}-${pad2(Number(m[1]))}-${pad2(Number(m[2]))}`;
}

/** Takvim gününe gün ekler ("2026-03-28", 1 → "2026-03-29"); saat dilimi ve yaz saati etkilemez. Geçersiz gün "". */
export function addDays(day: string, days: number): string {
  if (!DAY_ONLY.test(day) || !Number.isFinite(days)) return '';
  const [y, mo, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y!, mo! - 1, d!));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo! - 1 || t.getUTCDate() !== d) return '';
  t.setUTCDate(t.getUTCDate() + Math.trunc(days));
  return t.toISOString().slice(0, 10);
}

/** Takvim ayına ay ekler ("2026-01", −1 → "2025-12"). Geçersiz ay "". */
export function addMonths(month: string, months: number): string {
  if (!/^\d{4}-\d{2}$/.test(month) || !Number.isFinite(months)) return '';
  const [y, mo] = month.split('-').map(Number);
  if (mo! < 1 || mo! > 12) return '';
  const t = new Date(Date.UTC(y!, mo! - 1 + Math.trunc(months), 1));
  return t.toISOString().slice(0, 7);
}
