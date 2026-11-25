import { zonedDate } from "@sellerondata/product-kit/pure";

/**
 * Firmanın gününe göre an aralıkları. TagPress zamanları ISO metin (`toISOString()`, UTC) saklar; gün sınırı JS'de hesaplanır,
 * SQL yalnız metin karşılaştırır (SQLite ve Postgres'te aynı sonuç, saat dilimi işlevi gerekmez). Hesap DeciShip
 * `apps/api/src/lib/time.ts` `zonedDayStart`/`zonedRange` ile aynıdır (product-kit/pure'da yok).
 */

const DAY_MS = 86_400_000;
const fieldFormatters = new Map<string, Intl.DateTimeFormat>();

function fields(at: Date, timeZone: string): Record<string, string> {
  let f = fieldFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fieldFormatters.set(timeZone, f);
  }
  const out: Record<string, string> = {};
  for (const p of f.formatToParts(at)) out[p.type] = p.value;
  return out;
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

/** Kapalı gün aralığı `from..to`, firmanın gününe göre `[gte, lt)` ISO metin (SQL'de metin karşılaştırması). */
export function zonedIsoRange(from: string, to: string, timeZone: string): { gte: string; lt: string } {
  const next = new Date(Date.parse(`${to}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10);
  return { gte: zonedDayStart(from, timeZone).toISOString(), lt: zonedDayStart(next, timeZone).toISOString() };
}

/** ISO anın firmadaki günü; çözülemeyen metin null (sayılmaz). */
export function dayOf(iso: unknown, timeZone: string): string | null {
  if (typeof iso !== "string" || !iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : zonedDate(new Date(t), timeZone);
}

/** Günlere göre sayım: `bucketize`'ın `value(gün)` işlevi için. */
export function countByDay(isos: readonly unknown[], timeZone: string, weights?: readonly number[]): Map<string, number> {
  const out = new Map<string, number>();
  isos.forEach((iso, i) => {
    const day = dayOf(iso, timeZone);
    if (day) out.set(day, (out.get(day) ?? 0) + (weights?.[i] ?? 1));
  });
  return out;
}
