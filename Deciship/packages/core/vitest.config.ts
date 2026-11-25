import { configDefaults, defineConfig } from 'vitest/config';

// XLSX fixtures can take several seconds when the machine is busy (emulator, Docker).
// Aşama 0.4: süre eşikli dosyalar (*.perf.test.ts) kapı dışında; `npm run test:perf` (vitest.perf.config.ts).
export default defineConfig({
  test: { testTimeout: 20_000, exclude: [...configDefaults.exclude, '**/*.perf.test.ts'] },
});
