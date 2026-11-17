import { test, expect } from './base.ts';
import { login, reset, USERS } from './helpers.ts';

const down = (page: import('@playwright/test').Page) => page.evaluate(() => localStorage.setItem('sod_mock_account_down', '1'));
const up = (page: import('@playwright/test').Page) => page.evaluate(() => localStorage.removeItem('sod_mock_account_down'));

test.describe('Hata olunca kullanıcı ortada kalmasın (Merkez)', () => {
  test('hesap kapalıyken çıkış: "Çıkış yapılamadı." görünür, sayfada kalır; kanca kalkınca çıkış girişe gider', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();
    await down(page);
    await page.getByRole('button', { name: /Kullanıcı menüsü/ }).click();
    await page.getByRole('menuitem', { name: 'Çıkış yap' }).click();
    await expect(page.getByText('Çıkış yapılamadı.')).toBeVisible();
    await expect(page).toHaveURL(/\/home$/);

    await up(page);
    await page.getByRole('button', { name: /Kullanıcı menüsü/ }).click();
    await page.getByRole('menuitem', { name: 'Çıkış yap' }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test('hesap kapalıyken firma değiştirme: "Firma değiştirilemedi." görünür', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();
    await down(page);
    await page.getByRole('button', { name: /^Firma:/ }).click();
    await page.getByRole('menuitemradio', { name: /Örnek İhracat/ }).click();
    await expect(page.getByText('Firma değiştirilemedi.')).toBeVisible();
    await expect(page.locator('.sod-firm-n')).toHaveText('Örnek Firma');
  });

  test('abonelik hesap kapalıyken: hata kutusu var, "Açık değil" yok', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();
    await down(page);
    await page.goto('/account/billing');
    await expect(page.locator('.notif.err').first()).toBeVisible();
    await expect(page.getByText('Açık değil')).toHaveCount(0);
  });
});
