import { defineConfig, devices } from '@playwright/test';

/**
 * Varsayılan: mock modu. Tek köken: `/deciship/*` DeciShip, geri kalanı Merkez (vite vekili). Portlar ortamdan seçilir.
 * Gerçek sistem: `E2E_BASE_URL=http://localhost:8088` (ağ geçidi); yalnız `*.real` olmayan akış testleri koşar.
 */
const webPort = process.env.DECISHIP_WEB_PORT ?? '5173';
const hubPort = process.env.HUB_WEB_PORT ?? '5180';
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${webPort}`;

export default defineConfig({
  testDir: './e2e',
  testIgnore: /[\\/]visual[\\/]/, // görsel karşılaştırma ayrı yapılandırmada (playwright.visual.config.ts)
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          command: 'npm run dev:mock',
          url: `${baseURL}/deciship/`,
          reuseExistingServer: true,
          timeout: 60_000,
          env: { DECISHIP_WEB_PORT: webPort, HUB_PROXY_TARGET: `http://localhost:${hubPort}` },
        },
        // Merkez ↔ DeciShip gezintisi için Merkez'in kendi mock sunucusu. Yalnız platform-nav.spec.ts kullanır.
        {
          command: `npm --prefix ../../../Platform/apps/hub-web run dev:mock -- --port ${hubPort}`,
          url: `http://localhost:${hubPort}/`,
          reuseExistingServer: true,
          timeout: 60_000,
        },
      ],
});
