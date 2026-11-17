import { defineConfig, devices } from '@playwright/test';

const port = process.env.HUB_WEB_PORT ?? '5180';
const baseURL = `http://localhost:${port}`;

/** Ekran görüntüsü üretir (test değil): 1440, 1024, 390 genişlik, TR + EN. Çıktı: screenshots/. */
export default defineConfig({
  testDir: './e2e',
  testMatch: /screens\.ts/,
  timeout: 300_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL, locale: 'tr-TR', timezoneId: 'Europe/Istanbul' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: `npm run dev:mock -- --port ${port}`, url: baseURL, reuseExistingServer: true, timeout: 60_000 },
});
