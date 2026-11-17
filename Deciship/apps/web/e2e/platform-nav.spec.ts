import { expect, test, type Page } from './base';
import { APP, PASSWORD, REAL_STACK, mockSession } from './helpers';

// Merkez ↔ DeciShip: ayrı uygulamalar, aynı köken, tam sayfa gezinti (ARCHITECTURE §8).
// Mock modunda DeciShip dev sunucusu Merkez'i vekil eder; Merkez'in kendi mock'u aynı `sod_mock_*` oturumunu okur.
test.skip(REAL_STACK, 'mock oturumu gerektirir');

/** Etkin alan kabuğun kökünde yazılı (D09: bant rengi ve logo kilidi buna göre). */
const shellOf = (page: Page) => page.locator('.sod-shell');
/** Uygulama geçişi bandın sağındaki ⊞ menüsünden. */
async function openApp(page: Page, name: string) {
  await page.getByRole('button', { name: 'Uygulamalar' }).click();
  await page.getByRole('menuitem', { name }).click();
}

test('Merkez → DeciShip → Merkez: tam sayfa geçiş, oturum ve bant aynı (görünüm geçişi: e2e-prod)', async ({ page }) => {
  await mockSession(page, 'owner');
  await page.goto('/home');
  await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();
  await expect(shellOf(page)).toHaveAttribute('data-sod-product', 'hub');

  await page.evaluate(() => ((window as unknown as { __same: boolean }).__same = true));
  await openApp(page, 'DeciShip');
  await expect(page).toHaveURL(/\/deciship\/$/);
  await expect(page.getByRole('heading', { name: 'Pano', level: 1 })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __same?: boolean }).__same)).toBeUndefined(); // gerçekten yeni belge
  await expect(shellOf(page)).toHaveAttribute('data-sod-product', 'deciship');
  await expect(page.locator('.sod-brand-n')).toHaveText('DeciShip');
  await expect(page.locator('.sod-firm-n')).toHaveText('Örnek Firma');

  // logo kilidi iki satır: DeciShip, altında SellerOnData; Merkez'e dönüş uygulama menüsünden
  await expect(page.locator('.sod-brand-sub')).toHaveText('SellerOnData');
  await openApp(page, 'Merkez');
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();
  await expect(shellOf(page)).toHaveAttribute('data-sod-product', 'hub');
});

test('girişten sonra kalınan DeciShip sayfasına döner', async ({ page }) => {
  await mockSession(page, null);
  await page.goto(`${APP}/settings`);
  await expect(page).toHaveURL(/\/login\?next=%2Fdeciship%2Fsettings$/);
  await page.fill('#id', 'sahip@ornek.test');
  await page.fill('#pw', PASSWORD);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/deciship\/settings$/);
  await expect(page.getByRole('heading', { name: 'Ayarlar', level: 1 })).toBeVisible();
});

test('kurulum özeti ve ayarlar bağlantıları Merkez\'e tam sayfa gider', async ({ page }) => {
  await mockSession(page, 'owner');
  await page.goto(`${APP}/settings`);
  await page.getByRole('link', { name: /Merkez'de değiştir/ }).click();
  await expect(page).toHaveURL(/\/account\/company$/);
  await expect(shellOf(page)).toHaveAttribute('data-sod-product', 'hub');
});

test('Ölçüm rolü DeciShip\'e tıklayınca Merkez\'in sayfasına, adresi yazınca DeciShip\'in sayfasına gelir; ikisi de Merkez\'e döner', async ({ page }) => {
  await mockSession(page, 'measure');
  await page.goto(`${APP}/`);
  await expect(page.getByRole('heading', { name: 'Bu rol mobil uygulamada çalışır' })).toBeVisible();
  await page.getByRole('link', { name: "Merkez'e dön" }).click();
  await expect(page).toHaveURL(/\/home$/);
  await openApp(page, 'DeciShip');
  await expect(page).toHaveURL(/\/account\/tool-access\/deciship$/);
  // Merkez'in araç erişimi sayfası: bantta ürün adı, gövdede mobil rol açıklaması
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('DeciShip');
  await expect(page.locator('#sod-main')).toContainText('mobil');
});
