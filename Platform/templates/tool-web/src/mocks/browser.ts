// Yalnız `npm run dev:mock` (VITE_MOCK=1). Sahte API tarayıcıda servis çalışanıyla yanıt verir; üretim derlemesine girmez.
// Kural: sahte API'ye iş kuralı kopyalanmaz. Yanıt şekli gerçek API'nin kaydından gelir (DeciShip: apps/api/test/contract.test.ts).
// Karşılığı: Deciship/apps/web/src/mocks/browser.ts (aracın uçları) ve mocks/account.ts (Hesap uçları ve ürün denetim sırası).
import { setupWorker } from 'msw/browser';
import { delay, http, HttpResponse, passthrough } from 'msw';
import { loadMockDb } from '@sellerondata/shell/mock-seed';

const API = '/api/ornekarac';

const handlers = [
  // Hesap uçları (`/api/account/*`: me, refresh, switch-org, logout): bugün yalnız DeciShip panelinde. Ortak pakete alınana kadar
  // Deciship/apps/web/src/mocks/account.ts `accountHandlers` buraya kopyalanır (README "Ortak pakete alınacaklar").
  http.get(`${API}/health`, async () => {
    await delay(80);
    return HttpResponse.json({ ok: true });
  }),
  // belge önyükleme ve varlıklar: mock'lanmaz, uyarı da üretmez
  http.all('*', () => passthrough()),
];

export async function startMocks() {
  const worker = setupWorker(...handlers);
  // Tohum ve depo Merkez'le ortak: tek kökende ikisi aynı oturumu ve veriyi görür.
  loadMockDb();
  await worker.start({
    quiet: true,
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js`, options: { scope: import.meta.env.BASE_URL } },
  });
}
