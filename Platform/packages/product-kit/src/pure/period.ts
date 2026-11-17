/**
 * Merkez dönemi, saf (veritabanı, Fastify ve hata metni yok). DeciShip `apps/api/src/services/hub/period.ts` ile aynı kurallar;
 * hata metnini çağıran yazar (`resolvePeriod` sorunun adını döner): product-kit `hub/period.ts` `KitError`, DeciShip kendi
 * `hubError`'ı. `test/pure.test.ts` DeciShip'in örnekleriyle aynı çıktıyı sınar.
 */

export const MAX_RANGE_DAYS = 732;
const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_YEAR = 2000;
const MAX_YEAR = 2999;

/** Kapalı gün aralığı `from..to`. Veritabanında `[start, end)`: UTC gece yarıları. */
export type Period = { from: string; to: string; start: Date; end: Date; days: number };

export function makePeriod(from: string, to: string): Period {
  const start = new Date(`${from}T00:00:00.000Z`);
  const last = new Date(`${to}T00:00:00.000Z`);
  return { from, to, start, end: new Date(last.getTime() + DAY_MS), days: Math.round((last.getTime() - start.getTime()) / DAY_MS) + 1 };
}

/** Geçerli takvim günü mü (2026-02-30 kabul edilmez)? Yıl 2000–2999: önceki dönem ve grafik aralığı taşmasın. */
export function validDay(s: unknown): s is string {
  if (typeof s !== 'string' || !DAY_RE.test(s)) return false;
  const year = Number(s.slice(0, 4));
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isoShift(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** `resolvePeriod`'un reddi: `dateFormat` (gün değil), `dateOrder` (`from` > `to`), `dateRange` (`MAX_RANGE_DAYS`'ten uzun). */
export type PeriodIssue = 'dateFormat' | 'dateOrder' | 'dateRange';

/**
 * Sorgudan dönem (`from`, `to`). Verilmezse `today`'e göre son 30 gün (`today`: firmanın günü, `zonedDate`). Sınamalar
 * DeciShip'teki sırayla: önce `to`, sonra `from` biçimi, sonra sıra, sonra uzunluk.
 */
export function resolvePeriod(query: unknown, today: string): { period: Period } | { issue: PeriodIssue } {
  const q = (query ?? {}) as Record<string, unknown>;
  if (q.to && !validDay(q.to)) return { issue: 'dateFormat' };
  const to = q.to ? (q.to as string) : today;
  if (q.from && !validDay(q.from)) return { issue: 'dateFormat' };
  const from = q.from ? (q.from as string) : isoShift(to, -29);
  if (from > to) return { issue: 'dateOrder' };
  const period = makePeriod(from, to);
  if (period.days > MAX_RANGE_DAYS) return { issue: 'dateRange' };
  return { period };
}

/** Dönemden hemen önceki, aynı uzunlukta dönem. */
export function previousPeriod(p: Period): Period {
  return makePeriod(isoShift(p.from, -p.days), isoShift(p.from, -1));
}

/** Grafik aralığı: 62 güne kadar günlük, 200 güne kadar haftalık, üstü 30 günlük. Önceki dönemle aynı sayıda nokta verir. */
export function bucketSize(days: number): number {
  return days <= 62 ? 1 : days <= 200 ? 7 : 30;
}

/** Her gün için `value(gün)` toplanıp aralıklara dökülür. `today`'den sonraki aralıklar `null`: çizgi geleceğe uzamaz. */
export function bucketize(
  p: Period,
  value: (iso: string) => number,
  opts: { cumulative?: boolean; today?: string; round?: (n: number) => number } = {},
): { x: string; y: number | null }[] {
  const size = bucketSize(p.days);
  const round = opts.round ?? ((n: number) => n);
  const points: { x: string; y: number | null }[] = [];
  let running = 0;
  for (let i = 0; i < p.days; i += size) {
    const x = isoShift(p.from, i);
    if (opts.today && x > opts.today) {
      points.push({ x, y: null });
      continue;
    }
    let total = 0;
    for (let d = 0; d < size && i + d < p.days; d++) total += value(isoShift(p.from, i + d));
    running += total;
    points.push({ x, y: round(opts.cumulative ? running : total) });
  }
  return points;
}
