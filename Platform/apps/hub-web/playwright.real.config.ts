import { defineConfig, devices } from '@playwright/test';

/** Gerçek Hesap servisine karşı. Sunucuyu e2e/real-api.spec.ts başındaki komutla kendiniz açın. */
export default defineConfig({
  testDir: './e2e',
  testMatch: /real-api\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [['list']],
  use: { baseURL: process.env.E2E_REAL_URL ?? 'http://localhost:5180', locale: 'tr-TR', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
