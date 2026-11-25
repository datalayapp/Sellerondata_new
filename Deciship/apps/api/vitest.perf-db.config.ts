import { configDefaults, defineConfig } from 'vitest/config';
import base from './vitest.config.ts';
import { PERF_DB_TEST_GLOB } from './test/unitFiles.ts';

/**
 * KALANLAR 6.14: veritabanlı başarım katmanı (`npm run test:perf:db`; kökte kapı olmayan `perf` grubunda `api-perf-db`).
 * Büyük firma verisini kendisi üretir (`test/perfData.ts`), uçların süresini ölçer; eşikler gevşek, kapı değil. Postgres
 * ister: veritabanlı yapılandırmanın aynısı (globalSetup, rastgele adlı veritabanı, ortam), yalnız dosya listesi ve süreler
 * farklı (veri üretimi birkaç dakika sürebilir).
 */
export default defineConfig({
  test: {
    ...base.test,
    include: [PERF_DB_TEST_GLOB],
    exclude: [...configDefaults.exclude],
    fileParallelism: false,
    testTimeout: 15 * 60_000,
    hookTimeout: 20 * 60_000,
  },
});
