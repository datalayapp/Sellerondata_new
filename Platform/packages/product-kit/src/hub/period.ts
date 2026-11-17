import type { Locale } from '@sellerondata/contracts';
import { KitError, kitMessage } from '../errors.ts';
import { resolvePeriod, MAX_RANGE_DAYS, type Period } from '../pure/period.ts';
import { zonedDate } from '../pure/time.ts';

/** Saf dönem hesabı `pure/period.ts`'te; burada yalnız paketin hata metni ve bağlam. */

/** `parsePeriod`'un okuduğu bağlam (HubCtx bunu karşılar). */
export type PeriodCtx = { now: Date; locale: Locale; timeZone: string };

/** Sorgudan dönem (`from`, `to`). Verilmezse firmanın gününe göre son 30 gün. En çok `MAX_RANGE_DAYS` gün. Hata 400 VALIDATION. */
export function parsePeriod(query: unknown, ctx: PeriodCtx): Period {
  const r = resolvePeriod(query, zonedDate(ctx.now, ctx.timeZone));
  if ('period' in r) return r.period;
  throw new KitError(400, 'VALIDATION', kitMessage(r.issue, ctx.locale, { days: MAX_RANGE_DAYS }));
}
