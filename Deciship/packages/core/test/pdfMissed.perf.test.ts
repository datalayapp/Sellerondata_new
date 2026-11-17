/**
 * Başarım katmanı (Aşama 0.4; `npm run test:perf`, kapı değil): `pdfMissedTrackings` maliyeti doğrusal.
 * Doğruluk kapıda: `pdfMissed.test.ts` › "pdfMissedTrackings: büyük metin".
 */
import { describe, expect, it } from 'vitest';
import { pdfMissedTrackings } from '../src/index';

describe('pdfMissedTrackings: maliyet doğrusal', () => {
  it('5.000 satırlık metin (1 atlanmış) 3 sn altında biter', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => `${7948_0000_0000 + i} 20.10.2026 DE 1,0 ${(i % 900) + 10},50 Ref ${1000000 + i}`);
    const reads = rows.map((r) => ({ trackingNo: r.split(' ')[0]! })).filter((_, i) => i !== 2500);
    const t0 = performance.now();
    const r = pdfMissedTrackings([rows.join('\n')], reads, {});
    const ms = performance.now() - t0;
    console.info(`pdfMissedTrackings 5.000 satır: ${Math.round(ms)} ms`);
    expect(r.trackings).toEqual([String(7948_0000_0000 + 2500)]);
    expect(ms).toBeLessThan(3000);
  });
});
