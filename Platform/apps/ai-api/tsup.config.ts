import { defineConfig } from 'tsup';

export default defineConfig({
  // Komut girişleri imajda `node dist/<ad>.js` ile çalışır (tsx imajda yok). Giriş dosyası ince: hiçbir modül onu içe aktarmaz
  // (bölmede gövde ortak parçaya taşınırsa komut boş geçerdi; Hesap servisi test/cli-entries.test.mjs ile aynı kural).
  entry: {
    main: 'src/main.ts',
    'ai-key': 'src/ai-key.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: true,
  // contracts ve auth-kit TS kaynak olarak file: ile bağlı; pakete gömülür. Diğerleri node_modules'ta kalır.
  noExternal: [/^@sellerondata\//],
});
