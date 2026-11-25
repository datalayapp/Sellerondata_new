import { DEFAULT_ORG_TIME_ZONE, aiNextPeriod, aiPeriodOf } from '@sellerondata/contracts';

/**
 * Tavanların dönemleri.
 * - Platform günü ve ayı: UTC (defterin günlük özeti `AiSpendDaily` de UTC günüdür) [V].
 * - Firmanın aylık hakkı ve firma × araç tavanı: firmanın saat diliminde takvim ayı (`Org.timeZone`, yoksa ya da geçersizse
 *   `DEFAULT_ORG_TIME_ZONE`). Satır dönemine `startedAt` ile girer: ay dönümünü aşan çağrı açıldığı aya sayılır.
 */

export type Window = { start: Date; end: Date };
export type MonthWindow = Window & { period: string };

const DAY_MS = 86_400_000;

export function utcDay(at: Date): Window {
  const start = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  return { start: new Date(start), end: new Date(start + DAY_MS) };
}

export function utcMonth(at: Date): MonthWindow {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  return { period: aiPeriodOf(at, 'UTC'), start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
}

/** Saat diliminin o andaki farkı (ms; yerel = UTC + fark). */
function offsetMs(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return local - Math.floor(at / 1000) * 1000;
}

/** `YYYY-MM` döneminin ilk anı, verilen saat diliminde (UTC an olarak). */
export function zonedPeriodStart(period: string, timeZone: string): Date {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, 1);
  let utc = wall - offsetMs(wall, timeZone);
  const again = wall - offsetMs(utc, timeZone);
  if (again !== utc) utc = again;
  return new Date(utc);
}

/** Geçerli IANA adı değilse varsayılan. */
export function safeTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return DEFAULT_ORG_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return DEFAULT_ORG_TIME_ZONE;
  }
}

/** Firmanın o anki ayı: dönem, [başı, sonu). */
export function orgMonth(at: Date, timeZone: string | null | undefined): MonthWindow {
  const tz = safeTimeZone(timeZone);
  const period = aiPeriodOf(at, tz);
  return { period, start: zonedPeriodStart(period, tz), end: zonedPeriodStart(aiNextPeriod(period), tz) };
}
