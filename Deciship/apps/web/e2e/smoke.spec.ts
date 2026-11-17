import { expect, test } from './base';
import path from 'node:path';
import { registerCompany, samples } from './helpers';

test('kayıt → tarife → fatura yükle → farkları gör → Excel indir', async ({ page }) => {
  // 1. Register a fresh company (own X-Forwarded-For: the API allows 5 registrations per IP per hour)
  await registerCompany(page);

  // 2. Carrier + tariff (general settings typed, rate grid imported from the Excel template)
  await page.getByRole('link', { name: 'Tarifeler' }).click();
  await page.getByRole('button', { name: 'Taşıyıcı ekle' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('FedEx tarifeleri')).toBeVisible();
  await page.getByRole('link', { name: 'Yeni tarife' }).click();
  // the new-tariff page opens on "Dosyadan oluştur"; the manual form is one click away
  await page.getByRole('button', { name: 'veya elle oluştur' }).click();
  await page.fill('#t-name', 'FedEx International Economy 2026');
  await page.fill('#t-disc', '38');
  await page.fill('#t-fuel', '25');
  await page.getByLabel('1. satır ağırlık').fill('0,5');
  await page.getByLabel('0,5 kg A fiyatı', { exact: true }).fill('100');
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page).toHaveURL(/\/tariffs\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Tarife kaydedildi')).toBeVisible();
  // the URL changes before the router's transition commits: wait for the saved tariff's import box,
  // otherwise the file can land in the outgoing "Dosyadan oluştur" box and its upload is aborted on unmount
  await expect(page.getByRole('heading', { name: 'Dosyadan içe aktar' })).toBeVisible();

  await page.getByTestId('tariff-file').setInputFiles(path.join(samples, 'tariff-template-example.xlsx'));
  const importDialog = page.getByRole('dialog', { name: 'Tarifeyi içe aktar' });
  await expect(importDialog).toBeVisible();
  // the template has no blocking errors; AI review runs only on demand, code warnings need the acknowledgement box
  const ack = importDialog.locator('.iw-ack input');
  if (await ack.count()) await ack.check();
  await importDialog.getByRole('button', { name: 'Uygula', exact: true }).click();
  await expect(page.getByText('Tarife içe aktarıldı')).toBeVisible();
  await expect(page.getByLabel('6 kg A fiyatı', { exact: true })).toHaveValue('1527,75');

  // quote box: wiki example #5305 → 1.184,00 ₺
  await page.fill('#q-c', 'FR');
  await page.getByRole('button', { name: 'Hesapla' }).click();
  await expect(page.locator('.quote-res .quote-total')).toHaveText('1.184,00 ₺');

  // 3. Measurement for #5305 (40×30×25, 4,0 kg)
  await page.getByRole('link', { name: 'Ölçümler' }).click();
  await page.getByRole('button', { name: 'Elle ölçüm ekle' }).first().click();
  await page.fill('#m-trk', '794812345305');
  await page.fill('#m-l', '40');
  await page.fill('#m-w', '30');
  await page.fill('#m-h', '25');
  await page.fill('#m-kg', '4');
  await page.getByRole('dialog').getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('cell', { name: '794812345305' })).toBeVisible();

  // 4. Upload the FedEx sample invoice
  await page.getByRole('link', { name: 'Faturalar' }).click();
  await page.getByRole('link', { name: 'Fatura yükle' }).first().click();
  await page.getByRole('radio', { name: /FedEx/ }).click();
  await page.setInputFiles('[data-testid=invoice-file]', path.join(samples, 'invoices/fedex-9-482-11735.csv'));
  await expect(page.locator('#map-trackingNo')).toHaveValue('Tracking ID');
  await expect(page.locator('#map-netAmount')).toHaveValue('Net Charge Amount');
  await page.getByRole('button', { name: 'Devam' }).click();
  await expect(page.locator('#ino')).toHaveValue('9-482-11735');
  await page.getByRole('button', { name: 'İçe aktar ve karşılaştır' }).click();

  // 5. Comparison: the #5305 dimension diff (+458,50 ₺) is on the default "Fark var" tab
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}/);
  await expect(page.getByRole('tab', { name: /Fark var/ })).toHaveAttribute('aria-selected', 'true');
  const row = page.locator('tr', { hasText: '794812345305' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Ölçü farkı');
  await expect(row).toContainText('+458,50 ₺');
  await row.click();
  await expect(page.locator('.panel')).toContainText('1.184,00 ₺');
  await page.getByRole('button', { name: 'İtiraz listesine ekle' }).click();
  await expect(page.getByText('İtiraz listesine eklendi')).toBeVisible();

  // 5b. Invoice header is editable (SPEC §10.4): change the number, then put it back
  for (const no of ['9-482-11735-E2E', '9-482-11735']) {
    await page.getByRole('button', { name: 'Diğer' }).click();
    await page.getByRole('menuitem', { name: 'Düzenle', exact: true }).click();
    await page.fill('#e-ino', no);
    await page.getByRole('dialog').getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.locator('.ptitle .mono')).toHaveText(no);
  }

  // 6. Excel report download
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Diğer' }).click();
  await page.getByRole('menuitem', { name: 'Excel indir' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.xlsx$/);
  const saved = path.join(test.info().outputDir, file.suggestedFilename());
  await file.saveAs(saved);
  const { size } = await import('node:fs').then((fs) => fs.statSync(saved));
  expect(size).toBeGreaterThan(2000);
});
