/**
 * Testler için sahte kur servisi (Y9): her geçmiş gün için aynı kurlarla bülten döner, `today.xml` için 404 (bülten
 * henüz yayımlanmamış sayılır, bir önceki güne düşülür). Göreli tarihli testler (`trDay(-3)` gibi) gerçek TCMB'ye gitmesin
 * diye. Belirli günlere bağlı sahteler testin kendi dosyasındadır (`fx.test.ts` `fakeTcmb`).
 */
import { FxService, type FxFetcher } from '../src/services/fx.ts';

/** Kod → TRY karşılığı (orta kur), ör. `{ USD: 40.05 }`. */
export type FakeRates = Record<string, number>;

export function anyDayFetcher(rates: FakeRates): FxFetcher & { calls: string[] } {
  const calls: string[] = [];
  const fetcher: FxFetcher = async (url) => {
    calls.push(url);
    const m = /\/(\d{2})(\d{2})(\d{4})\.xml$/.exec(url);
    if (!m) return { status: 404, text: '' };
    const cur = Object.entries(rates)
      .map(([code, mid]) => `<Currency CurrencyCode="${code}"><Unit>1</Unit><ForexBuying>${mid}</ForexBuying><ForexSelling>${mid}</ForexSelling></Currency>`)
      .join('');
    return { status: 200, text: `<Tarih_Date Tarih="${m[1]}.${m[2]}.${m[3]}">${cur}</Tarih_Date>` };
  };
  return Object.assign(fetcher, { calls });
}

/** Her gün aynı kurla yanıt veren, önbelleksiz sahte kur servisi. */
export function anyDayFx(rates: FakeRates): FxService {
  return new FxService({ fetcher: anyDayFetcher(rates), cacheDir: null });
}
