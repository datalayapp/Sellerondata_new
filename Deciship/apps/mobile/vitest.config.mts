import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __DEV__: 'false' },
  // Yerli modül Node'da açılmaz; testler Node kriptosuyla aynı işlevleri alır (`tests/stubs/expo-crypto.ts`).
  resolve: { alias: { 'expo-crypto': fileURLToPath(new URL('./tests/stubs/expo-crypto.ts', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
