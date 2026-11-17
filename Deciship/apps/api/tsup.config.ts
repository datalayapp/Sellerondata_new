import { defineConfig } from 'tsup';

export default defineConfig({
  // Komut girişleri src/bin altında ince dosyalardır (kural src/bin/runCli.ts; denetim test/cli-entries.test.mjs).
  // Çıktı adları belgelerdeki komutlarla aynı kalır: dist/seed.js, dist/aiUsage.js, dist/cli/reminders.js ...
  entry: {
    main: 'src/main.ts',
    // Ayrı iş çalıştırıcı kabı (KALANLAR 6.17): HTTP dinlemez, yalnız arka plan işleri. Sağlık dosyası, kapanış: src/worker.ts.
    worker: 'src/worker.ts',
    fileWorker: 'src/workers/fileWorker.ts',
    seed: 'src/bin/seed.ts',
    seedDemoDisputes: 'src/bin/seedDemoDisputes.ts',
    aiUsage: 'src/bin/aiUsage.ts',
    'cli/reminders': 'src/bin/reminders.ts',
    'cli/storageOrphans': 'src/bin/storageOrphans.ts',
    'cli/purgePreview': 'src/bin/purgePreview.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: true,
  // core, contracts ve auth-kit TS kaynak olarak file: ile bağlı: pakete gömülür. Diğerleri node_modules'ta kalır.
  noExternal: [/^@deciship\/core/, /^@sellerondata\//],
});
