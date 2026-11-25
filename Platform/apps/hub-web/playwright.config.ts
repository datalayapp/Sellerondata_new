import { defineConfig, devices } from '@playwright/test';

const port = process.env.HUB_WEB_PORT ?? '5180';
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: './e2e',
  testIgnore: /[\\/]visual[\\/]/, // görsel karşılaştırma ayrı yapılandırmada (playwright.visual.config.ts)
  // Sahte API sözleşmesi tarayıcısız: test/deciship-contract.test.mjs (`npm test`). `hata-hub.spec.ts` de bu kalıba uyar.
  testMatch: /hub\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: process.env.E2E_BASE_URL ? undefined : { command: `npm run dev:mock -- --port ${port}`, url: baseURL, reuseExistingServer: true, timeout: 60_000 },
});
