/**
 * Başarım katmanı (Aşama 0.4; `npm run test:perf`, kapı değil): fotoğraf üst verisi temizliğinin (Y24) büyük, kötü
 * niyetli girdilerde süre sınırı (B1). Doğruluk (hangi girdinin hangi sonucu verdiği) kapıda: `imageMeta.test.ts`.
 * Süre sınırı makineye göre ölçeklenir (`test/timing.ts`): taban, aynı boyda zararsız girdinin süresidir; hızlı makinede
 * sınır 100 ms kalır. Doğrusal olmayan (patlayan) tarama tabanın 5 katını aşar.
 */
import { describe, expect, it } from 'vitest';
import { stripImageMetadata } from '../src/lib/imageMeta.ts';
import { b1Jpeg, b1Png, b1Webp } from './imageBytes.ts';
import { timeBudget, timeSync } from './timing.ts';

describe('B1 süre: 8 MB girdi zararsız eşinin süresi içinde biter', () => {
  it('JPEG: RST, doldurma, küçük kesim ya da taramada RST dolu dosya', () => {
    const { plain, cases } = b1Jpeg();
    const base = timeSync(() => stripImageMetadata(plain));
    expect(base.value.outcome).toBe('clean');
    const limit = timeBudget(base.ms);
    for (const [name, b, outcome] of cases) {
      const r = timeSync(() => stripImageMetadata(b));
      console.info(`[süre] JPEG ${name}: ${Math.round(r.ms)} ms (sınır ${Math.round(limit)} ms)`);
      expect(r.value.outcome, name).toBe(outcome);
      expect(r.ms, name).toBeLessThan(limit);
    }
  });

  it('PNG: küçük parçalı dosya (parça sınırı)', () => {
    const { input, plain } = b1Png();
    const base = timeSync(() => stripImageMetadata(plain));
    expect(base.value.outcome).toBe('stripped');
    const r = timeSync(() => stripImageMetadata(input));
    console.info(`[süre] PNG: ${Math.round(r.ms)} ms (taban ${Math.round(base.ms)} ms)`);
    expect(r.value.outcome).toBe('unparsed');
    expect(r.ms).toBeLessThan(timeBudget(base.ms));
  });

  it('WebP: küçük parçalı dosya (parça sınırı)', () => {
    const { input, plain } = b1Webp();
    const base = timeSync(() => stripImageMetadata(plain));
    expect(base.value.outcome).toBe('stripped');
    const r = timeSync(() => stripImageMetadata(input));
    console.info(`[süre] WebP: ${Math.round(r.ms)} ms (taban ${Math.round(base.ms)} ms)`);
    expect(r.value.outcome).toBe('unparsed');
    expect(r.ms).toBeLessThan(timeBudget(base.ms));
  });
});
