import { expect, test, type Page } from './base';

/**
 * İlk açılış dili (kullanıcı kararı 2026-11-12): kayıtlı tercih (`?lang=`, `sod_lang` çerezi) → tarayıcı dilleri
 * (ilk desteklenen, bölgeli kod ana dile iner) → İngilizce. Yapılandırmanın `tr-TR`'si burada her blokta bilerek değişir.
 */
async function openLogin(page: Page, url = '/login') {
  await page.goto(url);
  // Vite ilk yüklemede bağımlılık için sayfayı yenileyebilir: form görünene kadar bekle.
  await page
    .locator('#id')
    .waitFor({ timeout: 20_000 })
    .catch(async () => {
      await page.reload();
      await page.locator('#id').waitFor();
    });
}

const cases: [string, 'tr' | 'en'][] = [
  ['tr-TR', 'tr'],
  ['en-GB', 'en'],
  ['de-DE', 'en'],
  ['fr-FR', 'en'],
];

for (const [locale, want] of cases) {
  test.describe(`tarayıcı ${locale}`, () => {
    test.use({ locale });
    test(`çerez yoksa giriş ekranı ${want}`, async ({ page }) => {
      await openLogin(page);
      await expect(page.locator('html')).toHaveAttribute('lang', want);
    });
  });
}

test.describe('kayıtlı tercih tarayıcıdan önce', () => {
  test.use({ locale: 'en-US' });

  test('sod_lang=tr çerezi', async ({ page }) => {
    await openLogin(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.evaluate(() => (document.cookie = 'sod_lang=tr; Path=/'));
    await openLogin(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
  });

  test('siteden gelen ?lang=tr çerezden de önce', async ({ page }) => {
    await openLogin(page);
    await page.evaluate(() => (document.cookie = 'sod_lang=en; Path=/'));
    await openLogin(page, '/login?lang=tr');
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
  });
});
