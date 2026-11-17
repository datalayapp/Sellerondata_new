import { configDefaults, defineConfig } from 'vitest/config';
import { TEST_APP_URL, TEST_EVENT_URL, TEST_ORIGIN, TEST_SITE_ORIGIN, testSigningKey } from './test/testEnv.ts';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Aşama 0.4: süre eşikli dosyalar (*.perf.test.ts) kapı dışında; `npm run test:perf` (vitest.perf.config.ts).
    exclude: [...configDefaults.exclude, 'test/**/*.perf.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    setupFiles: ['test/winKeepAliveGuard.ts', 'test/setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_APP_URL,
      ACCOUNT_SIGNING_KEY: testSigningKey(),
      ACCOUNT_PREVIOUS_PUBLIC_KEYS: '',
      ALLOWED_ORIGINS: TEST_ORIGIN,
      SITE_ORIGINS: TEST_SITE_ORIGIN,
      APP_BASE_URL: TEST_ORIGIN,
      PRODUCT_EVENT_TARGETS: `deciship=${TEST_EVENT_URL}`,
      REGISTRATION_ENABLED: 'true',
      SIGNUP_MODE: 'open',
      EMAIL_VERIFICATION_REQUIRED: 'false',
      SMTP_URL: '',
      COOKIE_SECURE: '',
      COOKIE_LANG_DOMAIN: '',
      TRUST_PROXY_HOPS: '0',
      REFRESH_REUSE_GRACE_SECONDS: '10',
    },
  },
});
