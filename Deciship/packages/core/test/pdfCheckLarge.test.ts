import { describe, expect, it } from 'vitest';
import { checkPdfLines } from '../src/index';
import { largePdfCheckInput } from './pdfCheckInput';

/**
 * R2: bir istekle sunucu kilitlenmesin; 5.000 satır × 16 MB metin, satır başına bütün metni taramadan. Burada sonucun
 * doğruluğu; süre sınırı kapı dışında: `pdfCheck.perf.test.ts` (`npm run test:perf`).
 */
describe('checkPdfLines büyük girdi', () => {
  it('16 MB metin + 5.000 satır doğru sonuç verir', () => {
    const { n, target, text, lines } = largePdfCheckInput();
    expect(text.length).toBeGreaterThanOrEqual(target);
    const r = checkPdfLines([text], lines);
    expect(r.method).toBe('text');
    expect(r.checked).toBe(n);
    const flagged = new Map(r.rows.map((x) => [x.rowIndex, x.codes]));
    expect(flagged.get(3)).toEqual(['PDF_AMOUNT_UNVERIFIED']);
    expect(flagged.get(4)).toBeUndefined();
    expect(flagged.get(49)).toEqual(['PDF_TRACKING_UNVERIFIED']);
    // "5678" dolgu metninde bağımsız parça olarak var: bulunur; tutarı yakında değil
    expect(flagged.get(7)).toEqual(['PDF_AMOUNT_UNVERIFIED']);
    // 500 yanlış tutar + 100 bulunmayan takip no + 1 kısa takip no (kümeler ayrık)
    expect(r.rows.length).toBe(601);
  }, 30_000);
});
