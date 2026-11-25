import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

/**
 * Aşama 0.4: başarım katmanı (`npm run test:perf`; kökte kapı olmayan `perf` grubu). Süre eşikli denetimler
 * (`test/*.perf.test.ts`); süreye bağlı olmayan eşleri kapıda. Postgres ister: ana yapılandırmanın aynısı (globalSetup,
 * ortam), yalnız dosya listesi farklı.
 */
export default defineConfig({
  test: {
    ...base.test,
    include: ['test/**/*.perf.test.ts'],
    exclude: [],
  },
});
