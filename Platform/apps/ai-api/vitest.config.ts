import { defineConfig } from 'vitest/config';
import {
  TEST_ANTHROPIC_URL,
  TEST_APP_URL,
  TEST_DB_NAME,
  TEST_GEMINI_URL,
  TEST_JWKS_URL,
  TEST_KEY_MASTER,
  TEST_ORIGIN,
  TEST_TOOL_TOKENS,
} from './test/testEnv.ts';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    // Tek test veritabanı: dosyalar sırayla.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      SOD_ENV: 'development',
      AI_TEST_DB: TEST_DB_NAME,
      DATABASE_URL: TEST_APP_URL,
      ACCOUNT_JWKS_URL: TEST_JWKS_URL,
      ALLOWED_ORIGINS: TEST_ORIGIN,
      AI_GATEWAY_TOKENS: `deciship=${TEST_TOOL_TOKENS.deciship},tagpress=${TEST_TOOL_TOKENS.tagpress}`,
      AI_KEY_MASTER: TEST_KEY_MASTER,
      AI_KEY_MASTER_PREVIOUS: '',
      ANTHROPIC_BASE_URL: TEST_ANTHROPIC_URL,
      GEMINI_BASE_URL: TEST_GEMINI_URL,
      TRUST_PROXY_HOPS: '0',
    },
  },
});
