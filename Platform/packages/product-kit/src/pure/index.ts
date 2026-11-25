/**
 * `@sellerondata/product-kit/pure`: araçların Merkez uçlarında ortak, saf kısımlar. Fastify, pg ve paketin hata sınıfı yok;
 * yalnız `@sellerondata/contracts` (tip ve saat dilimi varsayılanı). DeciShip'teki kopyalarla (`apps/api/src/services/hub/
 * period.ts`, `csv.ts`, `limiter.ts`, `lib/time.ts`) aynı davranış: `test/pure.test.ts` DeciShip'in örnekleriyle sınar. DeciShip
 * kendi kopyalarını bu girişe geçirebilir (henüz geçmedi).
 */
export {
  bucketize,
  bucketSize,
  isoShift,
  makePeriod,
  MAX_RANGE_DAYS,
  previousPeriod,
  resolvePeriod,
  validDay,
  type Period,
  type PeriodIssue,
} from './period.ts';
export { CSV_BOM, csvHeader, csvRows, csvSeparator, neutralizeCsv } from './csv.ts';
export { DEFAULT_TIME_ZONE, isTimeZone, zonedDate } from './time.ts';
export { createSlotCounter, releaseWhenBoth, type SlotCounter } from './slots.ts';
