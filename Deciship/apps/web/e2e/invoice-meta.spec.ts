import { expect, test, type Page } from './base';
import path from 'node:path';
import { APP, REAL_STACK, mockSession, samples } from './helpers';

test.skip(REAL_STACK, 'Mock test kancaları kullanılır');

async function reachMetaStep(page: Page) {
  await page.goto(`${APP}/invoices/upload`);
  await page.getByRole('radio', { name: /FedEx/ }).click();
  await page.setInputFiles('[data-testid=invoice-file]', path.join(samples, 'invoices/fedex-9-482-11735.csv'));
  await expect(page.locator('#map-trackingNo')).toHaveValue('Tracking ID');
  await page.locator('.wizbar button').last().click();
  await expect(page.locator('#icur')).toBeVisible();
}

/** Fatura detayı (`/invoices/upload` değil). */
const DETAIL = /invoices\/(?!upload)[^/]+$/;
const today = () => new Date().toISOString().slice(0, 10);

test.describe('dosyada bulunamayan fatura tarihi', () => {
  test('alan boş kalır, ekran bulunamadığını söyler, seçilmeden içe aktarılmaz', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_no_invoice_date: '1' });
    await reachMetaStep(page);

    await expect(page.locator('#idate')).toHaveValue('');
    await expect(page.locator('#idate')).not.toHaveValue(today());
    await expect(page.getByTestId('meta-date-missing')).toHaveText('Dosyada fatura tarihi bulunamadı. Faturanın üzerindeki tarihi seçin.');
    // Fatura no bulundu, tarih bulunamadı: "tahmin edilen değerler dolduruldu" denmez.
    await expect(page.getByText('Dosyadan tahmin edilen değerler dolduruldu; kontrol edin.')).toHaveCount(0);
    await expect(page.getByText('Dosyada bulunan değerler dolduruldu. Boş kalanları faturaya bakarak girin.')).toBeVisible();
    await expect(page.locator('.wizbar-msg')).toContainText('İçe aktarmak için doldurun: Fatura tarihi');

    let posted = false;
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/api/deciship/invoices')) posted = true;
    });
    await page.getByRole('button', { name: 'İçe aktar ve karşılaştır' }).click();
    await expect(page.getByText('Fatura tarihi gerekli.')).toBeVisible();
    await expect(page).toHaveURL(/invoices\/upload/);
    expect(posted).toBe(false);

    await page.locator('#ino').fill('E2E-TARIHSIZ-1');
    await page.locator('#idate').fill('2026-10-30');
    await expect(page.getByTestId('meta-date-missing')).toHaveCount(0);
    await page.getByRole('button', { name: 'İçe aktar ve karşılaştır' }).click();
    await expect(page).toHaveURL(DETAIL);
    await expect(page.getByText('30 Eki 2026').first()).toBeVisible();
  });

  test('İngilizce arayüzde de aynı açıklama', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_no_invoice_date: '1', sod_mock_locale: 'en' });
    await reachMetaStep(page);
    await expect(page.locator('#idate')).toHaveValue('');
    await expect(page.getByTestId('meta-date-missing')).toHaveText('No invoice date was found in the file. Select the date shown on the invoice.');
    await expect(page.getByText('Values found in the file are filled in. Enter the empty ones from the invoice.')).toBeVisible();
    await expect(page.locator('.wizbar-msg')).toContainText('To import, fill in: Invoice date');
  });

  test('tarih dosyada varsa dolu gelir, eksik uyarısı çıkmaz', async ({ page }) => {
    await mockSession(page, 'owner');
    await reachMetaStep(page);
    await expect(page.locator('#idate')).toHaveValue('2026-10-27');
    await expect(page.getByTestId('meta-date-missing')).toHaveCount(0);
    await expect(page.getByText('Dosyadan tahmin edilen değerler dolduruldu; kontrol edin.')).toBeVisible();
  });
});

test.describe('tarih sırası belli olmayan dosya', () => {
  async function reachMapping(page: Page) {
    await page.goto(`${APP}/invoices/upload`);
    await page.getByRole('radio', { name: /FedEx/ }).click();
    await page.setInputFiles('[data-testid=invoice-file]', path.join(samples, 'invoices/fedex-9-482-11735.csv'));
    await expect(page.getByTestId('date-order')).toBeVisible();
  }

  test('tahmin edilmez: ekran sorar, seçim fatura tarihini ve gönderilen eşlemeyi değiştirir', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_ambiguous_dates: '1' });
    await reachMapping(page);

    const box = page.getByTestId('date-order');
    await expect(box).toContainText('10/05/2026 nasıl okunmalı?');
    const dmy = box.getByRole('radio', { name: 'Gün/ay/yıl: 10 Mayıs 2026' });
    const mdy = box.getByRole('radio', { name: 'Ay/gün/yıl: 5 Ekim 2026' });
    await expect(dmy).not.toBeChecked();
    await expect(mdy).not.toBeChecked();
    await expect(page.getByText(/Tarih sırası belli değil/).first()).toBeVisible();

    await mdy.check();
    await expect(page.getByText(/Tarih sırası belli değil/)).toHaveCount(0);
    await expect(mdy).toBeChecked();

    await page.locator('.wizbar button').last().click();
    await expect(page.locator('#idate')).toHaveValue('2026-10-05');

    // Elle yazılan tarih yeni okumayla ezilmez.
    await page.locator('#idate').fill('2026-10-09');
    await page.locator('.wizbar button').first().click();
    await box.getByRole('radio', { name: 'Gün/ay/yıl: 10 Mayıs 2026' }).check();
    await expect(page.getByTestId('date-order').getByRole('radio', { name: 'Gün/ay/yıl: 10 Mayıs 2026' })).toBeChecked();
    await page.locator('.wizbar button').last().click();
    await expect(page.locator('#idate')).toHaveValue('2026-10-09');

    // Hangi sıra seçildiyse sunucuya o gider.
    await page.locator('#ino').fill('E2E-SIRA-1');
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/api/deciship/invoices')),
      page.getByRole('button', { name: 'İçe aktar ve karşılaştır' }).click(),
    ]);
    expect(req.postDataJSON().mapping.dateOrder).toBe('dmy');
  });

  test('kontrol dönmeden Devam: tarih yine güncellenir, sonuç gelmeden içe aktarılmaz, onay penceresi eski sorunu söylemez', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_ambiguous_dates: '1', sod_mock_verify_delay: '1500' });
    await reachMapping(page);
    await page.getByTestId('date-order').getByRole('radio', { name: 'Ay/gün/yıl: 5 Ekim 2026' }).check();
    await page.locator('.wizbar button').last().click();
    await expect(page.locator('#icur')).toBeVisible();
    const importBtn = page.getByRole('button', { name: 'İçe aktar ve karşılaştır' });
    await expect(importBtn).toBeDisabled();
    await expect(page.locator('#idate')).toHaveValue('2026-10-05');
    await expect(importBtn).toBeEnabled();
    await page.locator('#ino').fill('E2E-SIRA-3');
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/api/deciship/invoices')),
      importBtn.click(),
    ]);
    expect(req.postDataJSON()).toMatchObject({ invoiceDate: '2026-10-05', mapping: { dateOrder: 'mdy' } });
  });

  test('seçilmeden içe aktarılırsa onay penceresi sorunu söyler', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_ambiguous_dates: '1' });
    await reachMapping(page);
    await page.locator('.wizbar button').last().click();
    await expect(page.locator('#idate')).toHaveValue('2026-05-10');
    await page.locator('#ino').fill('E2E-SIRA-2');
    await page.getByRole('button', { name: 'İçe aktar ve karşılaştır' }).click();
    await expect(page.getByRole('dialog')).toContainText('10/05/2026, 10 Mayıs 2026 de olabilir 5 Ekim 2026 de');
  });

  test('İngilizce arayüzde de sorar', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_ambiguous_dates: '1', sod_mock_locale: 'en' });
    await reachMapping(page);
    await expect(page.getByTestId('date-order').getByRole('radio', { name: 'Month/day/year: 5 October 2026' })).toBeVisible();
    await expect(page.getByTestId('date-order').getByRole('radio', { name: 'Day/month/year: 10 May 2026' })).toBeVisible();
  });

  test('dar ekranda seçenekler taşmaz', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockSession(page, 'owner', { sod_mock_ambiguous_dates: '1' });
    await reachMapping(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('karşılaştırma beklemesi', () => {
  test('bekleme uzarsa neden sürdüğü ve sayfayı yenileyince ne olacağı anlatılır', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_invoice_delay: '5000' });
    await reachMetaStep(page);
    await expect(page.getByTestId('import-wait')).toHaveCount(0);
    await page.locator('#ino').fill('E2E-BEKLEME-1');
    await page.getByRole('button', { name: 'İçe aktar ve karşılaştır' }).click();
    await expect(page.getByRole('button', { name: 'Karşılaştırılıyor…' })).toBeVisible();
    const wait = page.getByTestId('import-wait');
    await expect(wait).toBeVisible({ timeout: 4_500 });
    await expect(wait).toHaveAttribute('role', 'status');
    await expect(wait).toContainText('TCMB');
    await expect(wait).toContainText('bir dakikayı');
    await expect(wait).toContainText('Yeniden karşılaştır');
    await expect(page).toHaveURL(DETAIL, { timeout: 10_000 });
  });

  test('İngilizce arayüzde de anlatılır', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_invoice_delay: '5000', sod_mock_locale: 'en' });
    await reachMetaStep(page);
    await page.getByRole('button', { name: 'Import and compare' }).click();
    const wait = page.getByTestId('import-wait');
    await expect(wait).toBeVisible({ timeout: 4_500 });
    await expect(wait).toContainText('up to a minute');
    await expect(wait).toContainText('Recompare');
  });

  test('hızlı içe aktarmada açıklama hiç görünmez', async ({ page }) => {
    await mockSession(page, 'owner');
    await reachMetaStep(page);
    await page.locator('#ino').fill('E2E-HIZLI-1');
    await page.getByRole('button', { name: 'İçe aktar ve karşılaştır' }).click();
    await expect(page).toHaveURL(DETAIL);
    await expect(page.getByTestId('import-wait')).toHaveCount(0);
  });
});

test.describe('yükleme korumaları', () => {
  test('aynı gönderiler başka faturada: tek uyarı, iptal ya da yine de yükle', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_overlap: '1' });
    await reachMetaStep(page);
    await page.locator('#ino').fill('E2E-COPY-1');
    let posts = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/api/deciship/invoices')) posts++;
    });
    const importBtn = page.getByRole('button', { name: 'İçe aktar ve karşılaştır' });
    await importBtn.click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText('Bu dosyadaki 18 gönderinin 18 tanesi zaten MNG-2026-77120 faturasında var.');
    expect(posts).toBe(0);
    await dlg.getByTestId('overlap-cancel').click();
    await expect(page.getByRole('radio', { name: /FedEx/ })).toBeVisible();
    expect(posts).toBe(0);

    await reachMetaStep(page);
    await page.locator('#ino').fill('E2E-COPY-2');
    await importBtn.click();
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/api/deciship/invoices')),
      page.getByTestId('overlap-go').click(),
    ]);
    expect(req.postDataJSON().invoiceNo).toBe('E2E-COPY-2');
  });

  test('okuma kontrolü düşerse hata ve yeniden deneme gösterilir; eski sonuç kalmaz', async ({ page }) => {
    await mockSession(page, 'owner', { sod_mock_ambiguous_dates: '1', sod_mock_verify_fail: '1' });
    await page.goto(`${APP}/invoices/upload`);
    await page.getByRole('radio', { name: /FedEx/ }).click();
    await page.setInputFiles('[data-testid=invoice-file]', path.join(samples, 'invoices/fedex-9-482-11735.csv'));
    await page.getByTestId('date-order').getByRole('radio', { name: 'Ay/gün/yıl: 5 Ekim 2026' }).check();
    await expect(page.getByTestId('verify-failed')).toContainText('Okuma kontrolü yapılamadı');
    await page.locator('.wizbar button').last().click();
    await expect(page.getByRole('button', { name: 'İçe aktar ve karşılaştır' })).toBeDisabled();
    await page.getByTestId('verify-failed').getByRole('button', { name: 'Yeniden dene' }).click();
    await expect(page.getByTestId('verify-failed')).toHaveCount(0);
    await expect(page.locator('#idate')).toHaveValue('2026-10-05');
    await expect(page.getByRole('button', { name: 'İçe aktar ve karşılaştır' })).toBeEnabled();
  });
});
