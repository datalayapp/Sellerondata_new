/**
 * Y9: testler gerçek kur servisine (TCMB) gitmez. Sahte kur servisi takılmamış bir test kur isterse varsayılan indirici
 * (`fx.ts` `defaultFetcher`, genel `fetch`) buraya düşer: istek ağa çıkmadan ağ hatası gibi düşer (satır "Kur alınamadı")
 * ve dosyanın sonunda test dosyası adresleriyle birlikte kırılır. Çare: `setFxService(new FxService({ fetcher, … }))`
 * ya da göreli tarihli testlerde `anyDayFx` (`test/fxFake.ts`).
 *
 * Bu dosya `vitest.config.ts` `setupFiles` ile her test dosyasından önce yüklenir.
 */
import { afterAll } from 'vitest';

const TCMB = /^https?:\/\/(?:www\.)?tcmb\.gov\.tr\//i;
const realFetch = globalThis.fetch;
const leaks: string[] = [];

const urlOf = (input: Parameters<typeof fetch>[0]) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = urlOf(input);
  if (TCMB.test(url)) {
    leaks.push(url);
    throw new TypeError(`Test ortamında gerçek kur servisine gidilmez: ${url}`); // i18n-ok: test korumasının iç hatası
  }
  return realFetch(input, init);
}) as typeof fetch;

afterAll(() => {
  if (leaks.length) {
    // i18n-ok: test korumasının iç hatası
    throw new Error(`Gerçek kur servisine (TCMB) istek gitti: ${[...new Set(leaks)].join(', ')}. Sahte kur servisi takın (setFxService / anyDayFx).`);
  }
});
