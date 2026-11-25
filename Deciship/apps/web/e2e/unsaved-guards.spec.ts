import { expect, test, type Page } from './base';
import path from 'node:path';
import { APP, REAL_STACK, mockSession, samples } from './helpers';

test.skip(REAL_STACK, 'Mock test kancaları kullanılır');

const SAMPLE = path.join(samples, 'invoices/fedex-9-482-11735.csv');
// Mock taşıyıcı kimlikleri (`src/mocks/browser.ts` carriersDb): FedEx = cf, Aras Kargo = ca
const FEDEX = 'cf';
const ARAS = 'ca';

async function reachStepTwo(page: Page) {
  await page.goto(`${APP}/invoices/upload`);
  await page.getByRole('radio', { name: /FedEx/ }).click();
  await page.setInputFiles('[data-testid=invoice-file]', SAMPLE);
  await expect(page.locator('#map-trackingNo')).toHaveValue('Tracking ID');
}

test.describe('kaydedilmemiş değişiklik uyarıları', () => {
  test('Ayarlar: tolerans değişir, menüden çıkarken sorulur', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/settings`);
    await page.locator('#s-edge').fill('0.7');
    await page.getByRole('link', { name: 'Faturalar' }).click();
    const dlg = page.getByRole('dialog', { name: 'Değişiklikler kaydedilmedi' });
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Sayfada kal' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.locator('#s-edge')).toHaveValue('0.7');
    await page.getByRole('link', { name: 'Faturalar' }).click();
    await page.getByRole('dialog', { name: 'Değişiklikler kaydedilmedi' }).getByRole('button', { name: 'Kaydetmeden çık' }).click();
    await expect(page).toHaveURL(/\/invoices$/);
  });

  test('Fatura yükleme: adım 2 iken menüden çıkarken sorulur', async ({ page }) => {
    await mockSession(page, 'owner');
    await reachStepTwo(page);
    await page.getByRole('link', { name: 'Tarifeler' }).click();
    const dlg = page.getByRole('dialog', { name: 'Değişiklikler kaydedilmedi' });
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('fatura yükleme baştan başlar');
    await dlg.getByRole('button', { name: 'Sayfada kal' }).click();
    await expect(page).toHaveURL(/invoices\/upload/);
  });

  test('Fatura yükleme: kayıttan sonra fatura ayrıntısına uyarısız geçilir', async ({ page }) => {
    await mockSession(page, 'owner');
    await reachStepTwo(page);
    await page.locator('.wizbar button').last().click();
    await expect(page.locator('#icur')).toBeVisible();
    await page.locator('#ino').fill('E2E-GUARD-1');
    await page.getByRole('button', { name: 'İçe aktar ve karşılaştır' }).click();
    await expect(page).toHaveURL(/invoices\/(?!upload)[^/]+$/);
    await expect(page.getByRole('dialog', { name: 'Değişiklikler kaydedilmedi' })).toHaveCount(0);
  });

  test('Taşıyıcı okuma sürerken değişirse eski okuma yeniyi ezmez', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_preview_delay: JSON.stringify({ [FEDEX]: 2000, [ARAS]: 200 }) });
    await page.goto(`${APP}/invoices/upload`);
    await page.getByRole('radio', { name: /FedEx/ }).click();
    await page.setInputFiles('[data-testid=invoice-file]', SAMPLE);
    await expect(page.getByRole('button', { name: 'Okumayı durdur' })).toBeVisible();
    await page.getByRole('radio', { name: /Aras/ }).click();
    await expect(page.locator('#map-trackingNo')).toHaveValue('Tracking ID');
    await page.locator('.wizbar button').last().click();
    await expect(page.locator('#ino')).toHaveValue(`MOCK-${ARAS}`);
    // eski (yavaş) okuma bitse de sonuç değişmez
    await page.waitForTimeout(2300);
    await expect(page.locator('#ino')).toHaveValue(`MOCK-${ARAS}`);
  });

  test('Fatura düzenle penceresi: yazı varken Esc sorar, Düzenlemeye dön yazıyı korur', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices`);
    // listede satırın kendisi tıklanır (bağlantı yok); fatura başlığındaki ⋯ menüsü "Diğer"
    await page.locator('.inv-list td.card-title', { hasText: '9-482-11735' }).first().click();
    await page.locator('.inv-more').getByRole('button', { name: 'Diğer' }).click();
    await page.getByRole('menuitem', { name: 'Düzenle' }).click();
    const edit = page.getByRole('dialog', { name: 'Fatura bilgilerini düzenle' });
    await edit.locator('#e-ino').fill('YENI-NO-1');
    await page.keyboard.press('Escape');
    // soru ayrı pencere değil, aynı pencerenin altında sarı şerit (role=alert)
    const ask = edit.getByRole('alert').filter({ hasText: 'Yazdıklarınız silinsin mi?' });
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Düzenlemeye dön' }).click();
    await expect(ask).toHaveCount(0);
    await expect(edit.locator('#e-ino')).toHaveValue('YENI-NO-1');
    await page.keyboard.press('Escape');
    await edit.getByRole('alert').filter({ hasText: 'Yazdıklarınız silinsin mi?' }).getByRole('button', { name: 'Sil ve kapat' }).click();
    await expect(page.getByRole('dialog', { name: 'Fatura bilgilerini düzenle' })).toHaveCount(0);
  });
});
