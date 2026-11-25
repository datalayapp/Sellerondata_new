import { defineConfig, devices } from '@playwright/test';
import { APP } from './lib/sys.ts';

/** Gerçek sistem: sod-e2e yığını (run.mjs açar). Testler aynı veritabanını ve bazıları servis durdurmayı paylaşır: tek işçi, sıralı. */
export default defineConfig({
  testDir: './tests',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: '.stack/results.json' }], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: 'test-results',
  use: { baseURL: APP, locale: 'tr-TR', timezoneId: 'Europe/Istanbul', trace: 'retain-on-failure', screenshot: 'only-on-failure', actionTimeout: 15_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
