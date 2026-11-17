/**
 * Başarım katmanı (Aşama 0.4; `npm run test:perf`, kapı değil): PDF ön denetiminin (Y59) büyük girdilerde süresi.
 * Doğruluk (geçer mi, "complex" mi, "time" mı) kapıda: `pdfGuard.test.ts`. Ayrıştırma tavanlarının süre sınırı makineye
 * göre ölçeklenir (`test/timing.ts`): taban, aynı boyda zararsız belgenin taranma süresidir; hızlı makinede sınır 100 ms.
 */
import { describe, expect, it } from 'vitest';
import { checkPdfInflatedSize } from '../src/workers/pdfGuard.ts';
import { manyStreams, MB, parseCeilingCases } from './pdfBytes.ts';
import { timeAsync, timeBudget } from './timing.ts';

describe('Y59 süre', () => {
  it('yüz binlerce "stream" sözcüğü zlib açmadan 10 sn altında geçer', async () => {
    const many = manyStreams();
    const r = await timeAsync(() => checkPdfInflatedSize(many, 2 * MB));
    console.info(`[süre] 300 bin "stream": ${Math.round(r.ms)} ms`);
    expect(r.value.ok).toBe(true);
    expect(r.ms).toBeLessThan(10_000);
  });

  it('dev /Filter dizisi ve dev sözlük zararsız eşlerinin süresi içinde "complex" olur', async () => {
    const c = parseCeilingCases();
    const timed = (pdf: Buffer) => timeAsync(() => checkPdfInflatedSize(pdf, 300 * MB));
    const arrayBase = await timed(c.arrayBase);
    expect(arrayBase.value.ok).toBe(true);
    const array = await timed(c.array);
    console.info(`[süre] dev dizi: ${Math.round(array.ms)} ms (taban ${Math.round(arrayBase.ms)} ms)`);
    expect(array.value).toMatchObject({ ok: false, reason: 'complex' });
    expect(array.ms).toBeLessThan(timeBudget(arrayBase.ms));
    const dictBase = await timed(c.dictBase);
    expect(dictBase.value.ok).toBe(true);
    const dict = await timed(c.dict);
    console.info(`[süre] dev sözlük: ${Math.round(dict.ms)} ms (taban ${Math.round(dictBase.ms)} ms)`);
    expect(dict.value).toMatchObject({ ok: false, reason: 'complex' });
    expect(dict.ms).toBeLessThan(timeBudget(dictBase.ms));
  });
});
