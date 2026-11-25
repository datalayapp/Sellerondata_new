import { defineConfig } from 'tsup';

export default defineConfig({
  // Destek komutları imajda `node dist/<ad>.js` ile çalışır (tsx imajda yok).
  // Kural: komut girişi `scripts/` altında ince bir dosyadır, hiçbir modül onu içe aktarmaz ve "ana dosya mı" denetimi yapmaz.
  // Bölmede (splitting) başka girişin de içe aktardığı modülün gövdesi ortak parçaya taşınır: giriş dosyası yalnız dışa aktarım
  // yapar, `import.meta.url` parçayı gösterir ve komut hiçbir şey yapmadan 0 ile biter. Denetim: test/cli-entries.test.mjs.
  entry: {
    main: 'src/main.ts',
    seed: 'scripts/seed.ts',
    'outbox-requeue': 'scripts/outbox-requeue.ts',
    'org-announce': 'scripts/org-announce.ts',
    'phone-release': 'scripts/phone-release.ts',
    'phone-restore': 'scripts/phone-restore.ts',
    'org-list': 'scripts/org-list.ts',
    'subscription-set': 'scripts/subscription-set.ts',
    'product-launch': 'scripts/product-launch.ts',
    'org-close': 'scripts/org-close.ts',
    'org-reopen': 'scripts/org-reopen.ts',
    'members-announce': 'scripts/members-announce.ts',
    'signup-purge': 'scripts/signup-purge.ts',
    'signup-invite': 'scripts/signup-invite.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: true,
  // contracts TS kaynak olarak file: ile bağlı; pakete gömülür. Diğerleri node_modules'ta kalır.
  noExternal: [/^@sellerondata\//],
});
