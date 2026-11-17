import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * Aşama 0.4: başarım katmanı (`npm run test:perf`; kökte kapı olmayan `perf` grubu). Süre eşikli denetimler
 * (`test/*.perf.test.ts`); doğrulukları kapıdaki eş dosyada. Dosyalar sırayla: süre ölçümleri işlemciyi paylaşmasın.
 */
export default defineConfig({
  test: {
    ...base.test,
    include: ['test/**/*.perf.test.ts'],
    exclude: [],
    fileParallelism: false,
  },
});
