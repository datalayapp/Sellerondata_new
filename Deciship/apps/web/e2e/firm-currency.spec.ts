import { expect, test, type Page } from './base';
import path from 'node:path';
import { APP, REAL_STACK, mockSession, samples } from './helpers';

/** Mock firma `o1`: para birimi ayarı ve test kancaları tarayıcı deposundan okunur. */
const USD_FIRM = { 'sod_mock_ds_settings:o1': JSON.stringify({ currency: 'USD' }) };

async function openUploadStep(page: Page) {
  await page.goto(`${APP}/invoices/upload`);
  await page.getByRole('radio', { name: /FedEx/ }).click();
}

async function reachMetaStep(page: Page) {
  await openUploadStep(page);
  await page.setInputFiles('[data-testid=invoice-file]', path.join(samples, 'invoices/fedex-9-482-11735.csv'));
  await expect(page.locator('#map-trackingNo')).toHaveValue('Tracking ID');
  await page.getByRole('button', { name: 'Devam' }).click();
  await expect(page.locator('#icur')).toBeVisible();
}

test.describe('firma para birimi', () => {
  test.skip(REAL_STACK, 'mock oturumu gerektirir');

  test('USD firmada para birimi sütunu olmayan fatura USD açılır', async ({ page }) => {
    await mockSession(page, 'owner', { ...USD_FIRM, sod_mock_guess_currency: 'none' });
    await reachMetaStep(page);
    await expect(page.locator('#icur')).toHaveValue('USD');
  });

  test('dosyadaki para birimi firmanınkinden önce gelir ve değiştirilebilir', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_guess_currency: 'USD' });
    await reachMetaStep(page);
    await expect(page.locator('#icur')).toHaveValue('USD');
    await page.locator('#icur').selectOption('TRY');
    await expect(page.locator('#icur')).toHaveValue('TRY');
  });

  test('USD firmada yeni tarife USD açılır, kullanıcı değiştirince simge de değişir', async ({ page }) => {
    await mockSession(page, 'owner', USD_FIRM);
    await page.goto(`${APP}/tariffs/new?elle=1`);
    await expect(page.locator('#t-cur')).toHaveValue('USD');
    await expect(page.getByText('$ tarife fiyatı')).toBeVisible();
    await page.locator('#t-cur').selectOption('EUR');
    await expect(page.getByText('€ tarife fiyatı')).toBeVisible();
  });

  test('USD firmada TRY tarife kendi para birimi ve simgesiyle açılır', async ({ page }) => {
    await mockSession(page, 'owner', USD_FIRM);
    await page.goto(`${APP}/tariffs`);
    await page.locator('tbody tr').first().click();
    await expect(page.locator('#t-cur')).toHaveValue('TRY');
    await expect(page.getByText('₺ tarife fiyatı')).toBeVisible();
  });

  test('ayarlarda tutar toleransı firmanın simgesiyle yazılır', async ({ page }) => {
    await mockSession(page, 'owner', USD_FIRM);
    await page.goto(`${APP}/settings`);
    const unit = page.locator('.set-unit', { has: page.locator('#s-amt') });
    await expect(unit).toContainText('$');
    await expect(unit).not.toContainText('₺');
  });

  test('TRY firmada tolerans ₺ kalır', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/settings`);
    await expect(page.locator('.set-unit', { has: page.locator('#s-amt') })).toContainText('₺');
  });
});

test.describe('kurulum: para birimi Merkez\'den yönetilir', () => {
  test.skip(REAL_STACK, 'mock oturumu gerektirir');

  test("firma adımı yok: bilgi Merkez'den okunur, şeritte gösterilir, ayar yazılmaz", async ({ page }) => {
    await mockSession(page, 'fresh');
    const patches: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && new URL(r.url()).pathname === '/api/deciship/settings') patches.push(r.postData() ?? '');
    });
    await page.goto(`${APP}/setup`);
    await expect(page.locator('#ob-step-title')).toContainText('Taşıyıcılar');
    await expect(page.locator('#ob-cur')).toHaveCount(0);
    const strip = page.locator('.ob-hub-strip');
    await expect(strip).toContainText("Firma bilgileri Merkez'de tamamlandı:");
    await expect(strip).toContainText('Yeni Atölye');
    await expect(strip).toContainText('TRY');
    await expect(strip.getByRole('link', { name: /Merkez'de değiştir/ })).toHaveAttribute('href', '/account/company');
    expect(patches).toEqual([]);
  });

  test("Merkez'de onaylanmamış firmada yalnız \"Önce firma bilgileri\" ve tek düğme", async ({ page }) => {
    await mockSession(page, 'fresh', { sod_mock_company_unconfirmed: '1' });
    await page.goto(`${APP}/setup?adim=tarifeler`);
    await expect(page.locator('#ob-step-title')).toHaveText('Önce firma bilgileri');
    await expect(page.getByText('(onay bekliyor)').first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Merkez'de onayla/ })).toHaveAttribute('href', '/account/company?next=%2Fdeciship%2Fsetup%3Fadim%3Dtarifeler');
    await expect(page.getByText('Onaylayınca buraya geri dönersiniz.')).toBeVisible();
    const steps = page.getByRole('navigation', { name: 'Kurulum adımları' });
    await expect(steps).toContainText("Merkez'de bekliyor");
    await expect(steps.getByRole('button', { name: /Taşıyıcılar/ })).toBeDisabled();
    await expect(page.getByText('Henüz veriniz yok mu?')).toHaveCount(0);
  });
});

test.describe('fatura yükleme: yapay zekâ metni', () => {
  test.skip(REAL_STACK, 'mock oturumu gerektirir');

  test('anahtar varken PDF okunur denir', async ({ page }) => {
    await mockSession(page, 'owner');
    await openUploadStep(page);
    await expect(page.getByText('PDF faturalar yapay zekâ ile okunur')).toBeVisible();
  });

  test('anahtar yokken denmez', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_no_ai: '1' });
    await openUploadStep(page);
    await expect(page.getByText('CSV ya da XLSX · en fazla')).toBeVisible();
    await expect(page.getByText('yapay zekâ ile okunur')).toHaveCount(0);
  });
});
