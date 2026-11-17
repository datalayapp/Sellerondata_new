import { test as base, expect } from '@playwright/test';

/**
 * Bütün uçtan uca testlerin ortak `test`i: her test bitince ekranda kabuğun hata sınırı (`[data-sod-boundary]`,
 * "Bir şeyler ters gitti") olmamalı. Sınır çöken bölümü yakalayıp sayfayı ayakta tutar; bu denetim olmadan bir çökme,
 * bölümün başlığına bakmayan testte görünmeden geçerdi.
 * Hata sınırını bilerek gösteren test, başında `test.info().annotations.push({ type: 'hata-siniri-beklenir' })` yazar.
 */
export const test = base.extend<{ noErrorBoundary: void }>({
  noErrorBoundary: [
    async ({ page }, use, testInfo) => {
      await use();
      if (testInfo.status !== testInfo.expectedStatus) return; // test zaten düştü: asıl hata görünsün
      if (testInfo.annotations.some((a) => a.type === 'hata-siniri-beklenir')) return;
      if (page.isClosed()) return;
      await expect(page.locator('[data-sod-boundary]'), 'ekranda hata sınırı var (bir bölüm çöktü)').toHaveCount(0, { timeout: 1000 });
    },
    { auto: true },
  ],
});

export { expect };
export type { Locator, Page } from '@playwright/test';
