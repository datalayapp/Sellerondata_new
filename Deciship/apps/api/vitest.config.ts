import { configDefaults, defineConfig } from 'vitest/config';
import { BASE_TEST_ENV, TEST_DB_URL, testStorageDir } from './test/testEnv.ts';
import { PERF_TEST_GLOB, UNIT_TEST_FILES } from './test/unitFiles.ts';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // 15-B5: veritabanısız dosyalar hızlı grupta koşar (vitest.unit.config.ts); burada iki kez koşmaz.
    // Aşama 0.4: süre eşikli dosyalar (*.perf.test.ts) kapı dışında, vitest.perf.config.ts'te.
    exclude: [...configDefaults.exclude, ...UNIT_TEST_FILES, PERF_TEST_GLOB],
    globalSetup: ['test/globalSetup.ts'],
    // Windows + Node 24.15 (libuv 1.51) keepalive çökmesi (0xC0000409): açıklama dosyanın içinde.
    // Y9: testler gerçek kur servisine (TCMB) gitmez; giden istek ağa çıkmadan düşer ve dosyayı kırar (test/noRealFx.ts).
    setupFiles: ['test/winKeepAliveGuard.ts', 'test/noRealFx.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Ortak değişkenler ve açıklamaları test/testEnv.ts `BASE_TEST_ENV`'de.
    env: {
      ...BASE_TEST_ENV,
      DATABASE_URL: TEST_DB_URL,
      STORAGE_DIR: testStorageDir(),
    },
  },
});
