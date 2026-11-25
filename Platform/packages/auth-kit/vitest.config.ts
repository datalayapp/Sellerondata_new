import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // auth-kit `definition` dikişi yalnız NODE_ENV=test iken açıktır: kabuktaki değer ne olursa olsun testte sabit.
    env: { NODE_ENV: 'test' },
    // `CREATE DATABASE` ve yarış turları yüklü makinede saniyeler sürebilir.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
