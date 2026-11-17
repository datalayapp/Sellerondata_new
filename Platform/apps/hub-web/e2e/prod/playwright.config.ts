import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.SOD_PROD_PORT ?? 5181);

export default defineConfig({
  testDir: '.',
  testMatch: /transition\.spec\.ts/,
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${port}`, locale: 'tr-TR', viewport: { width: 1440, height: 900 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: { command: 'node server.mjs', cwd: import.meta.dirname, env: { PORT: String(port) }, url: `http://localhost:${port}/login`, reuseExistingServer: false, timeout: 20_000 },
});
