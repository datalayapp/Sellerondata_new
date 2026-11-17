import { expect, test } from './base';
import { APP, REAL_STACK, mockSession } from './helpers';

/** Mock firma `o1`: tek fatura 9-482-11735 (FedEx). Mesaj 14 Parça E: liste araması, durum süzgeci, Tarih düğmesi. */
test.describe('fatura listesi: arama ve durum', () => {
  test.skip(REAL_STACK, 'mock verisine dayanır');

  test('fatura numarasıyla arama adrese yazılır; sonuç yoksa arama boş durumu çıkar', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices`);
    await expect(page.getByRole('row', { name: /9-482-11735/ })).toBeVisible();

    await page.getByRole('searchbox', { name: 'Ara' }).fill('11735');
    await expect(page).toHaveURL(/[?&]q=11735/);
    await expect(page.getByRole('row', { name: /9-482-11735/ })).toBeVisible();

    await page.getByRole('searchbox', { name: 'Ara' }).fill('yok-boyle-bir-fatura');
    await expect(page).toHaveURL(/[?&]q=yok-boyle-bir-fatura/);
    await expect(page.getByText('Bu aramayla fatura yok')).toBeVisible();

    await page.getByRole('button', { name: 'Filtreleri temizle' }).first().click();
    await expect(page).not.toHaveURL(/[?&]q=/);
    await expect(page.getByRole('row', { name: /9-482-11735/ })).toBeVisible();
  });

  test('durum açılır listesi adreste status olur', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices`);
    await page.getByLabel('Durum').selectOption('DIFF');
    await expect(page).toHaveURL(/[?&]status=DIFF/);
    await expect(page.getByRole('row', { name: /9-482-11735/ })).toBeVisible();
  });

  test('tarih alanları "Tarih" düğmesinin arkasındadır; tarih seçiliyse açık durur', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/invoices`);
    await expect(page.locator('#ifrom')).toHaveCount(0);
    await page.getByRole('button', { name: 'Tarih' }).click();
    await expect(page.locator('#ifrom')).toBeVisible();

    await page.goto(`${APP}/invoices?from=2026-10-01`);
    await expect(page.locator('#ifrom')).toHaveValue('2026-10-01');
    await expect(page.getByRole('button', { name: 'Tarih' })).toHaveCount(0);
  });
});
