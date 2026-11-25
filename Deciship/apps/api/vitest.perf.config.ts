import { configDefaults, defineConfig } from 'vitest/config';
import unit from './vitest.unit.config.ts';
import { PERF_DB_TEST_GLOB, PERF_TEST_GLOB } from './test/unitFiles.ts';

/**
 * Aşama 0.4: başarım katmanı (`npm run test:perf`; kökte kapı olmayan `perf` grubu). Süre eşikli denetimler
 * (`test/*.perf.test.ts`) burada; doğrulukları kapıdaki eş dosyada (ör. `imageMeta.test.ts`). Veritabanı istemez:
 * veritabanısız yapılandırmanın aynısı (`noDbGuard` dahil), yalnız dosya listesi farklı. Dosyalar sırayla koşar: süre
 * ölçümleri birbirinin işlemcisini paylaşmasın.
 */
export default defineConfig({
  test: {
    ...unit.test,
    include: [PERF_TEST_GLOB],
    // veritabanlı başarım dosyaları kendi yapılandırmasında (vitest.perf-db.config.ts)
    exclude: [...(unit.test?.exclude ?? configDefaults.exclude), PERF_DB_TEST_GLOB],
    fileParallelism: false,
  },
});
