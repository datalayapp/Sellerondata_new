import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { BASE_TEST_ENV } from './test/testEnv.ts';
import { UNIT_TEST_FILES } from './test/unitFiles.ts';

/**
 * 15-B5: veritabanısız API testleri (`npm run test:unit`, hızlı grup `api-unit`). globalSetup yok, Postgres istemez.
 * Veritabanı adresi ulaşılamayan bir adrestir ve `test/noDbGuard.ts` bağlanma denemesini yakalar.
 */
export default defineConfig({
  test: {
    include: UNIT_TEST_FILES,
    // Windows + Node 24.15 keepalive çökmesi (test/winKeepAliveGuard.ts); gerçek kur servisine gidilmez (test/noRealFx.ts).
    setupFiles: ['test/winKeepAliveGuard.ts', 'test/noRealFx.ts', 'test/noDbGuard.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: {
      ...BASE_TEST_ENV,
      DATABASE_URL: 'postgresql://unit:unit@127.0.0.1:1/no_database_in_unit_tests',
      // dosyaya yazan test olmamalı; yazarsa veritabanlı koşuların klasörüne karışmaz
      STORAGE_DIR: path.join(os.tmpdir(), `deciship-unit-storage-${process.pid}`),
    },
  },
});
