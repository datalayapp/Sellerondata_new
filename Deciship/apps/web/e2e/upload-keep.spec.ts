import { expect, test, type Page } from './base';
import path from 'node:path';
import { APP, REAL_STACK, mockSession, samples } from './helpers';

// Mesaj 5 (10-B5, 10-B8, 10-B9): yükleme sihirbazı kullanıcının yaptığını sessizce kaybetmez.
// "Yeniden oku" düşerse eski okuma ve düzeltmeler kalır; "Geri" önizlemeyi silmez; yapay zekâ eşlemesi beklenirken
// eşleme seçenekleri kapalıdır. Önizleme dosyası yalnız gerçekten vazgeçilince silinir.
test.skip(REAL_STACK, 'Mock test kancaları kullanılır');

const SAMPLE = path.join(samples, 'invoices/fedex-9-482-11735.csv');
const PDF = { name: 'fatura-e2e.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') };
const NET1 = '1. satır Net tutar';

/** PDF okuma istekleri (`POST /invoices/preview`): `fresh` gidip gitmediği. */
function watchReads(page: Page) {
  const fresh: boolean[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/deciship\/invoices\/preview\?/.test(r.url())) fresh.push(new URL(r.url()).searchParams.has('fresh'));
  });
  return fresh;
}

/** Önizleme dosyası silme çağrıları (`DELETE /invoices/preview/:fileId`), sırasıyla. */
function watchDiscards(page: Page) {
  const seen: string[] = [];
  page.on('request', (r) => {
    const m = /\/api\/deciship\/invoices\/preview\/([^/?]+)$/.exec(r.url());
    if (r.method() === 'DELETE' && m) seen.push(decodeURIComponent(m[1]!));
  });
  return seen;
}

async function pdfStep(page: Page) {
  await page.goto(`${APP}/invoices/upload`);
  await page.getByRole('radio', { name: /FedEx/ }).click();
  await page.setInputFiles('[data-testid=invoice-file]', PDF);
  await expect(page.getByLabel(NET1)).toBeVisible();
}

async function csvStep(page: Page) {
  await page.goto(`${APP}/invoices/upload`);
  await page.getByRole('radio', { name: /FedEx/ }).click();
  await page.setInputFiles('[data-testid=invoice-file]', SAMPLE);
  await expect(page.locator('#map-trackingNo')).toHaveValue('Tracking ID');
}

const next = (page: Page) => page.getByRole('button', { name: 'Devam', exact: true });
const back = (page: Page) => page.getByRole('button', { name: 'Geri', exact: true });

test.describe('yükleme sihirbazı emeği korur', () => {
  test('10-B5: "Yeniden oku" hak dolduğu için düşerse düzeltmeler ve eski okuma kalır, bağlantı gizlenir', async ({ page }) => {
    await mockSession(page, 'owner');
    const discards = watchDiscards(page);
    await pdfStep(page);
    await page.getByLabel(NET1).fill('999,00');
    // Hak bu arada doldu; sayfa açılırken alınan bilgi bunu bilmiyor (bağlantı görünür).
    await page.evaluate(() => localStorage.setItem('sod_mock_ai_quota', '1'));
    await page.getByTestId('pdf-reread').click();
    await page.getByTestId('pdf-reread-go').click();
    await expect(page.getByRole('alert').filter({ hasText: 'Dosya okunamadı.' })).toContainText('hakkınız doldu');
    expect(discards).toEqual([]);
    await next(page).click();
    await expect(page.getByLabel(NET1)).toHaveValue('999,00');
    // Okumadan sonra hak bilgisi yenilendi: "Yeniden oku" artık çıkmaz.
    await expect(page.getByTestId('pdf-reread')).toHaveCount(0);
  });

  test('10-B5: yeniden okuma işi düşerse eski okuma kalır; başarılı okumada eski dosya yenisi gelince silinir', async ({ page }) => {
    await mockSession(page, 'owner');
    const discards = watchDiscards(page);
    const reads = watchReads(page);
    await pdfStep(page);
    await page.getByLabel(NET1).fill('999,00');
    await page.evaluate(() => localStorage.setItem('sod_mock_job_fail', '1'));
    await page.getByTestId('pdf-reread').click();
    await page.getByTestId('pdf-reread-go').click();
    await expect(page.getByRole('alert').filter({ hasText: 'Dosya okunamadı.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tekrar dene' })).toBeVisible();
    expect(discards).toEqual([]);
    await next(page).click();
    await expect(page.getByLabel(NET1)).toHaveValue('999,00');

    // Bu kez okuma başarılı: yeni satırlar gelir, eski önizleme dosyası (f1) ancak şimdi silinir; hak bilgisi yenilenir.
    await page.evaluate(() => localStorage.removeItem('sod_mock_job_fail'));
    let meReads = 0;
    page.on('request', (r) => {
      if (r.method() === 'GET' && /\/api\/deciship\/me(\?|$)/.test(r.url())) meReads += 1;
    });
    await page.getByTestId('pdf-reread').click();
    await page.getByTestId('pdf-reread-go').click();
    await expect(page.getByLabel(NET1)).not.toHaveValue('999,00');
    await expect.poll(() => discards).toEqual(['f1']);
    await expect.poll(() => meReads).toBeGreaterThan(0);
    // İlk okuma, düşen "Yeniden oku" (fresh, işi başladı), ikinci "Yeniden oku": ilk işin ücretlediği parçalar önbellekte,
    // `fresh` gitmez (çift ücret yok). Sonuç uygulandıktan sonraki "Yeniden oku" yine baştan okur.
    expect(reads).toEqual([false, true, false]);
    await page.getByTestId('pdf-reread').click();
    await page.getByTestId('pdf-reread-go').click();
    await expect.poll(() => reads).toEqual([false, true, false, true]);
  });

  test('PDF önizlemesinde taşıyıcı değişince yeniden okunmaz, sorulmaz; hak dolu olsa da devam edilir', async ({ page }) => {
    await mockSession(page, 'owner');
    const reads = watchReads(page);
    await pdfStep(page);
    await page.getByLabel(NET1).fill('999,00');
    await page.evaluate(() => localStorage.setItem('sod_mock_ai_quota', '1'));
    await back(page).click();
    await page.getByRole('radio', { name: /Aras/ }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await next(page).click();
    await expect(page.getByLabel(NET1)).toHaveValue('999,00');
    await expect(page.locator('.wiz-file')).toContainText('Aras Kargo');
    expect(reads).toEqual([false]);
  });

  test('okuma sürerken açılan "yeniden okunsun mu?" sorusu, okuma bitince kapanır (eski plana göre okuma başlamaz)', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_third_carrier: '1', sod_mock_preview_delay: JSON.stringify({ ca: 3000 }) });
    await csvStep(page);
    await page.getByLabel('Tutarlar KDV dahil').check();
    await back(page).click();
    await page.getByRole('radio', { name: /Aras/ }).click();
    await page.getByRole('dialog', { name: 'Dosya yeniden okunsun mu?' }).getByRole('button', { name: 'Yeniden oku' }).click();
    await expect(page.getByRole('button', { name: 'Okumayı durdur' })).toBeVisible();
    // Okuma sürerken üçüncü taşıyıcı: düzeltme var, sorulur; Aras'ın sonucu gelince soru kapanır, ekran tutarlı (Aras).
    await page.getByRole('radio', { name: /Yurtiçi/ }).click();
    await expect(page.getByRole('dialog', { name: 'Dosya yeniden okunsun mu?' })).toBeVisible();
    await expect(page.locator('#map-trackingNo')).toHaveValue('Tracking ID');
    await expect(page.getByRole('dialog', { name: 'Dosya yeniden okunsun mu?' })).toHaveCount(0);
    await expect(page.locator('.wiz-file')).toContainText('Aras Kargo');
    await page.locator('.wizbar button').last().click();
    await expect(page.locator('#ino')).toHaveValue('MOCK-ca');
  });

  test('10-B9: PDF satırlarında "Geri" düzeltmeleri silmez; 1. adımda "Devam" var; çıkınca dosya silinir', async ({ page }) => {
    await mockSession(page, 'owner');
    const discards = watchDiscards(page);
    await pdfStep(page);
    await page.getByLabel(NET1).fill('999,00');
    await back(page).click();
    await expect(page.locator('.drop-name')).toHaveText(PDF.name);
    // aynı taşıyıcıya tıklamak hiçbir şeyi değiştirmez
    await page.getByRole('radio', { name: /FedEx/ }).click();
    await next(page).click();
    await expect(page.getByLabel(NET1)).toHaveValue('999,00');
    expect(discards).toEqual([]);

    // 1. adımdayken sayfadan çıkış da sorulur; çıkılırsa önizleme dosyası silinir.
    await back(page).click();
    await page.getByRole('link', { name: 'Tarifeler' }).click();
    const dlg = page.getByRole('dialog', { name: 'Değişiklikler kaydedilmedi' });
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Kaydetmeden çık' }).click();
    await expect(page).toHaveURL(/\/tariffs/);
    await expect.poll(() => discards).toEqual(['f1']);
  });

  test('10-B9: CSV eşlemesinde "Geri" seçimleri korur; taşıyıcı değişince düzeltme varsa önce sorulur', async ({ page }) => {
    await mockSession(page, 'owner');
    await csvStep(page);
    const vat = page.getByLabel('Tutarlar KDV dahil');
    await vat.check();
    await back(page).click();
    await next(page).click();
    await expect(vat).toBeChecked();

    await back(page).click();
    await page.getByRole('radio', { name: /Aras/ }).click();
    const ask = page.getByRole('dialog', { name: 'Dosya yeniden okunsun mu?' });
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Vazgeç' }).click();
    await expect(page.getByRole('radio', { name: /FedEx/ })).toHaveAttribute('aria-checked', 'true');
    await next(page).click();
    await expect(vat).toBeChecked();

    await back(page).click();
    await page.getByRole('radio', { name: /Aras/ }).click();
    await page.getByRole('dialog', { name: 'Dosya yeniden okunsun mu?' }).getByRole('button', { name: 'Yeniden oku' }).click();
    await expect(page.locator('#map-trackingNo')).toHaveValue('Tracking ID');
    await expect(vat).not.toBeChecked();
  });

  test('10-B9: düzeltme yokken taşıyıcı değişince sormadan yeniden okunur', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_preview_delay: JSON.stringify({ ca: 0 }) });
    await csvStep(page);
    await back(page).click();
    await page.getByRole('radio', { name: /Aras/ }).click();
    await expect(page.locator('#map-trackingNo')).toHaveValue('Tracking ID');
    await page.locator('.wizbar button').last().click();
    await expect(page.locator('#ino')).toHaveValue('MOCK-ca');
  });

  test('10-B8: yapay zekâ eşlemesi beklenirken KDV, ek ücret ve desi seçenekleri kapalı', async ({ page }) => {
    await mockSession(page, 'owner');
    await csvStep(page);
    await page.evaluate(() => localStorage.setItem('sod_mock_ai_hold', '1'));
    await page.getByRole('button', { name: 'Yapay zekâ ile eşle' }).click();
    await expect(page.getByRole('button', { name: 'Yapay zekâ eşliyor…' })).toBeVisible();
    await expect(page.getByLabel('Tutarlar KDV dahil')).toBeDisabled();
    await expect(page.getByLabel('“Desi” sütunu ücretli ağırlık yerine kullanılsın (yurt içi)')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Ek ücret sütunu ekle' })).toBeDisabled();
    await page.evaluate(() => localStorage.removeItem('sod_mock_ai_hold'));
    await expect(page.getByLabel('Tutarlar KDV dahil')).toBeEnabled();
    await expect(page.locator('#map-netAmount')).toHaveValue('Net Charge Amount');
  });

  test('PDF metninde bulunamayan ağırlık: kg hücreleri işaretli', async ({ page }) => {
    await mockSession(page, 'owner');
    await pdfStep(page);
    for (const col of ['Gerçek kg', 'Ücretli kg']) {
      await expect(page.getByLabel(`2. satır ${col}`)).toHaveClass(/invalid/);
      await expect(page.getByLabel(`1. satır ${col}`)).not.toHaveClass(/invalid/);
    }
  });
});
