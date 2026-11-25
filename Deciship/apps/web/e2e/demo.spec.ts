import { expect, test } from './base';
import { APP, REAL_STACK, mockSession } from './helpers';

// Mesaj 14 Parça G: örnek veriyle deneme turu (kurulum kartı, deneme bandı, bitirme onayı) ve Ayarlar'daki hatırlatma anahtarı.
test.skip(REAL_STACK, 'mock kişileri ve test kancaları gerektirir');

test.describe('deneme turu', () => {
  test('boş firmada kart çıkar; deneme Pano\'yu açar, bant görünür; bitirme onayla örnek veriyi siler ve kuruluma döner', async ({ page }) => {
    await mockSession(page, 'fresh');
    await page.goto(`${APP}/setup`);
    await expect(page.getByRole('heading', { name: 'İlk kurulum' })).toBeVisible();
    await expect(page.getByText('Henüz veriniz yok mu?')).toBeVisible();
    await page.getByRole('button', { name: 'Önce örnek veriyle deneyin' }).click();

    await expect(page.getByRole('heading', { name: 'Pano', level: 1 })).toBeVisible();
    await expect(page.getByText('Örnek verilerle deniyorsunuz.')).toBeVisible();

    // bant bütün sayfalarda durur
    await page.goto(`${APP}/invoices`);
    await expect(page.getByText('Örnek verilerle deniyorsunuz.')).toBeVisible();

    await page.getByRole('button', { name: 'Denemeyi bitir' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Örnek veriler silinsin mi?')).toBeVisible();
    await expect(dialog.getByText('Çalışanlarınızın bu arada kaydettiği ölçümler kalır.')).toBeVisible();
    // vazgeçince hiçbir şey silinmez
    await dialog.getByRole('button', { name: 'Vazgeç' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Örnek verilerle deniyorsunuz.')).toBeVisible();

    await page.getByRole('button', { name: 'Denemeyi bitir' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Sil ve kuruluma başla' }).click();
    await expect(page.getByRole('heading', { name: 'İlk kurulum' })).toBeVisible();
    await expect(page.getByText('Örnek verilerle deniyorsunuz.')).toHaveCount(0);
    // veri gittiği için kart yeniden çıkar
    await expect(page.getByText('Henüz veriniz yok mu?')).toBeVisible();
  });

  test('veri olan firmada kart çıkmaz', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/setup`);
    await expect(page.getByRole('heading', { name: 'İlk kurulum' })).toBeVisible();
    await expect(page.getByText('Henüz veriniz yok mu?')).toHaveCount(0);
  });

  test('sunucuda deneme kapalıysa (sod_mock_no_demo) kart çıkmaz', async ({ page }) => {
    await mockSession(page, 'fresh', { sod_mock_no_demo: '1' });
    await page.goto(`${APP}/setup`);
    await expect(page.getByRole('heading', { name: 'İlk kurulum' })).toBeVisible();
    await expect(page.getByText('Henüz veriniz yok mu?')).toHaveCount(0);
  });
});

test.describe('Ayarlar: itiraz süresi hatırlatması', () => {
  test('Türkiye firmasında anahtar görünür ve kaydedilir', async ({ page }) => {
    await mockSession(page, 'owner');
    await page.goto(`${APP}/settings`);
    const box = page.getByRole('checkbox', { name: /E-posta ile hatırlat/ });
    await expect(box).toBeVisible();
    await expect(box).toBeChecked(); // varsayılan açık
    await expect(page.getByText('son güne 3 gün ve 1 gün kala')).toBeVisible();
    await box.uncheck();
    await page.getByRole('region', { name: 'Kaydet' }).getByRole('button', { name: 'Ayarları kaydet' }).click();
    await expect(page.getByText('Ayarlar kaydedildi')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('checkbox', { name: /E-posta ile hatırlat/ })).not.toBeChecked();
  });
});
