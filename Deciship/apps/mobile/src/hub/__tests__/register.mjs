// Testler `node --test` ile çalışır. Uygulama kodu Metro için uzantısız içe aktarır; burada `.ts` eklenir.
// Testler `.mts`: uygulamanın tsc kapsamına girmez, Node tiplerini uygulamaya sızdırmaz.
// Çalıştırma (apps/mobile içinde): node --import ./src/hub/__tests__/register.mjs --test "src/hub/__tests__/*.test.mts"
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$|\.json$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
