import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Görsel karşılaştırma (Mesaj 12 §3.6). Olağan `npm run test:e2e` koşusuna girmez.
 * Taban klasörü depo dışında sabit: %LOCALAPPDATA%\SellerOnData\gorsel\hub (VISUAL_DIR ile değişir).
 * Taban:       npm run test:visual -- --update-snapshots --output <ayrı-klasör>
 * Karşılaştır: npm run test:visual -- --output <ayrı-klasör>
 * VISUAL_NO_SERVER=1: sunucu başlatılmaz, çalışan sunucuya bağlanılır.
 */
const visualDir = process.env.VISUAL_DIR ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'SellerOnData', 'gorsel', 'hub');

const port = process.env.HUB_WEB_PORT ?? '5281';
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: './e2e/visual',
  snapshotPathTemplate: `${visualDir}/{arg}{ext}`,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: process.env.VISUAL_REPORT ?? 'playwright-report-visual' }]],
  use: {
    baseURL,
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    viewport: { width: 1440, height: 900 },
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, launchOptions: { args: ['--disable-gpu', '--disable-lcd-text', '--font-render-hinting=none', '--force-color-profile=srgb', '--disable-skia-runtime-opts'] } } }],
  webServer: process.env.VISUAL_NO_SERVER ? undefined : { command: `npm run dev:mock -- --port ${port}`, url: baseURL, reuseExistingServer: true, timeout: 60_000 },
});
