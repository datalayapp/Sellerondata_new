import { defineConfig, devices } from '@playwright/test';

/** Üretim paketleri, tek köken: Merkez ↔ DeciShip görünüm geçişi. Önce `npm run build:prod-gateway`. */
const port = process.env.PROD_GATEWAY_PORT ?? '5393';
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: './e2e-prod',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL, locale: 'tr-TR', timezoneId: 'Europe/Istanbul', viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: { command: 'node scripts/prod-gateway.mjs', url: `${baseURL}/deciship/`, reuseExistingServer: true, timeout: 20_000, env: { PROD_GATEWAY_PORT: port } },
});
