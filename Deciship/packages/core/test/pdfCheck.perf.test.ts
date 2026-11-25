import { describe, expect, it } from 'vitest';
import { checkPdfLines } from '../src/index';
import { largePdfCheckInput } from './pdfCheckInput';

/**
 * Başarım katmanı (Aşama 0.4; `npm run test:perf`, kapı değil). R2: 16 MB metin + 5.000 satır makul sürede biter.
 * Eşik cömerttir; hedef 1-2 sn altı (CI 2026-11-12 yoğun makinede 16,3 sn ölçtü, bu yüzden kapı değil).
 * Doğruluk kapıda: `pdfCheckLarge.test.ts`.
 */
describe('checkPdfLines başarımı', () => {
  it('16 MB metin + 5.000 satır 6 sn altında biter', () => {
    const { n, text, lines } = largePdfCheckInput();
    const t0 = performance.now();
    const r = checkPdfLines([text], lines);
    const ms = performance.now() - t0;
    console.info(`checkPdfLines 16 MB × ${n} satır: ${Math.round(ms)} ms`);
    expect(r.checked).toBe(n);
    expect(ms).toBeLessThan(6000);
  }, 30_000);
});
