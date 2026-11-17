import { DEFAULT_ORG_TIME_ZONE } from '@sellerondata/contracts';

/**
 * Firmanın saat dilimi `org.updated` ile gelir (yerel `Company.timeZone`); kayıtta yoksa bu varsayılan (contracts
 * `DEFAULT_ORG_TIME_ZONE`). "Hangi gün" sorusu firmanın gününe göre yanıtlanır. DeciShip `apps/api/src/lib/time.ts`'in Merkez'in
 * kullandığı kısmı.
 */
export const DEFAULT_TIME_ZONE: string = DEFAULT_ORG_TIME_ZONE;

const formatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Yalnız IANA adı. Intl `+03:00` da kabul eder ama Postgres aynı metni ters işaretli (POSIX) okur: gün sınırı kayardı. */
const IANA_NAME = /^(UTC|[A-Z][A-Za-z_]+(\/[A-Za-z0-9_+-]+)+)$/;

export function isTimeZone(value: string): boolean {
  if (!IANA_NAME.test(value)) return false;
  try {
    dayFormatter(value);
    return true;
  } catch {
    return false;
  }
}

/** O anda firmada hangi gün: `YYYY-MM-DD`. */
export function zonedDate(at: Date, timeZone: string): string {
  const parts: Record<string, string> = {};
  for (const p of dayFormatter(timeZone).formatToParts(at)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}
