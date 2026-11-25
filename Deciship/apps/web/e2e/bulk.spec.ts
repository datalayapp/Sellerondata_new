import { expect, test, type Page } from './base';
import { APP, REAL_STACK, mockSession } from './helpers';

// Mesaj 14 (Parça D): fatura ayrıntısında satır seçimi, seçim çubuğu ve toplu karar. Sahte sunucuda (i1: kararı bekleyen fark satırları var).
test.skip(REAL_STACK, 'mock kişileri gerektirir');

const watchErrors = (page: Page) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
};

async function open(page: Page, width = 1440, height = 900) {
  await page.setViewportSize({ width, height });
  await mockSession(page, 'owner');
  await page.goto(`${APP}/invoices/i1`);
  await expect(page.locator('.lines-dt tbody tr').first()).toBeVisible();
}

const head = (page: Page) => page.getByRole('checkbox', { name: 'Bu sayfadaki satırları seç' });
const rowBoxes = (page: Page) => page.locator('.lines-dt tbody input[type="checkbox"]');
const bar = (page: Page) => page.getByRole('region', { name: /satır seçildi/ });

test.describe('satır seçimi ve seçim çubuğu', () => {
  test('Fark var sekmesinde kutular çizilir; başlık kutusu hepsini seçer, çubuk çıkar, seçimi kaldır çubuğu kapatır', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    await expect(head(page)).toBeVisible();
    await expect(bar(page)).toHaveCount(0);

    await head(page).check();
    await expect(bar(page)).toBeVisible();
    await expect(bar(page).getByRole('status')).toHaveText(/^\d+ satır seçildi$/);
    await expect(bar(page).getByRole('button', { name: 'İtiraz listesine ekle' })).toBeVisible();
    await expect(bar(page).getByRole('button', { name: 'Uyumlu say' })).toBeVisible();

    await bar(page).getByRole('button', { name: 'Seçimi kaldır' }).click();
    await expect(bar(page)).toHaveCount(0);
    await expect(head(page)).not.toBeChecked();
    expect(errors).toEqual([]);
  });

  test('"İtiraz" düğmesi seçim varken ikincil olur', async ({ page }) => {
    await open(page);
    await rowBoxes(page).first().check();
    await expect(page.locator('.inv-dispute')).toHaveClass(/btn-secondary/);
    await bar(page).getByRole('button', { name: 'Seçimi kaldır' }).click();
  });

  test('kutuya basmak paneli açmaz; satıra basmak açar ve kutular kaybolur, seçim çubuğu gizlenir', async ({ page }) => {
    await open(page);
    await rowBoxes(page).first().check();
    await expect(page).not.toHaveURL(/line=/);
    await rowBoxes(page).first().focus();
    await page.keyboard.press('Space'); // işareti kaldırır, satırı açmaz
    await expect(page).not.toHaveURL(/line=/);
    await expect(rowBoxes(page).first()).not.toBeChecked();

    await rowBoxes(page).first().check();
    await page.locator('.lines-dt tbody tr.clickable').first().click();
    await expect(page).toHaveURL(/line=/);
    await expect(rowBoxes(page)).toHaveCount(0);
    await expect(bar(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Kapat' }).first().click();
    await expect(rowBoxes(page).first()).toBeChecked(); // seçim panel kapanınca geri gelir
  });

  test('sekme ya da süzgeç değişince seçim sıfırlanır', async ({ page }) => {
    await open(page);
    await head(page).check();
    await expect(bar(page)).toBeVisible();
    await page.getByRole('tab', { name: /^Tümü/ }).click();
    await expect(bar(page)).toHaveCount(0);

    await head(page).check();
    await expect(bar(page)).toBeVisible();
    await page.getByPlaceholder(/takip/i).fill('9');
    await expect(bar(page)).toHaveCount(0);
  });

  test('uygun olmayan satırın kutusu kapalı ve nedeni ipucunda (Tümü sekmesi)', async ({ page }) => {
    await open(page);
    await page.getByRole('tab', { name: /^Tümü/ }).click();
    const off = page.locator('.lines-dt tbody label.ln-sel.off').first();
    await expect(off).toHaveAttribute('title', 'Bu satırın kararı burada değiştirilemez');
    await expect(off.locator('input')).toBeDisabled();
  });

  test('Uyumlu say gerekçe ister; başlıkta satır sayısı yazar; kaydedince bildirim çıkar', async ({ page }) => {
    await open(page);
    await rowBoxes(page).first().check();
    await bar(page).getByRole('button', { name: 'Uyumlu say' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByRole('heading', { name: /^1 satırı uyumlu say$/ })).toBeVisible();
    await dlg.getByRole('button', { name: 'Uyumlu say' }).click();
    await expect(dlg.getByText('Gerekçe yazın (en az 3 karakter).')).toBeVisible();
    await dlg.getByRole('textbox').fill('Sözleşmede ek ücret var');
    await dlg.getByRole('button', { name: 'Uyumlu say' }).click();
    await expect(dlg).toHaveCount(0);
    await expect(page.locator('.toast', { hasText: '1 satır uyumlu sayıldı' })).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
  });

  test('İtiraz listesine ekle: bildirim, "Geri al" kararı geri alır', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    const before = await rowBoxes(page).count();
    await rowBoxes(page).first().check();
    await bar(page).getByRole('button', { name: 'İtiraz listesine ekle' }).click();
    const toast = page.locator('.toast', { hasText: '1 satır itiraz listesine eklendi' });
    await expect(toast).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
    // karar verilen satırın kutusu kapanır (uygun değil)
    await expect(page.locator('.lines-dt tbody input[type="checkbox"]:enabled')).toHaveCount(before - 1);

    await toast.getByRole('button', { name: 'Geri al' }).click();
    await expect(page.locator('.toast', { hasText: 'Geri alındı' })).toBeVisible();
    await expect(page.locator('.lines-dt tbody input[type="checkbox"]:enabled')).toHaveCount(before);
    expect(errors).toEqual([]);
  });

  test('sunucu "seçim değişti" derse liste yenilenir, bildirim çıkar, seçim bırakılır', async ({ page }) => {
    await open(page);
    // sahte sunucu servis çalışanında: yanıtı `page.route` değil kanca belirler (bir sonraki toplu karar 409 SELECTION_CHANGED)
    await page.evaluate(() => localStorage.setItem('sod_mock_bulk_changed', '1'));
    const before = await page.locator('.lines-dt tbody input[type="checkbox"]:enabled').count();
    await rowBoxes(page).first().check();
    await bar(page).getByRole('button', { name: 'İtiraz listesine ekle' }).click();
    await expect(page.locator('.toast', { hasText: 'Seçim değişti, liste yenilendi. Yeniden deneyin.' })).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
    // hiçbir karar yazılmadı: bütün kutular yine açık ve boş
    await expect(page.locator('.lines-dt tbody input[type="checkbox"]:enabled')).toHaveCount(before);
    await expect(page.locator('.lines-dt tbody input[type="checkbox"]:checked')).toHaveCount(0);
  });

  test('telefonda çubuk alta yapışır, sayfa yana kaymaz, kutu kartın köşesinde ve dokunması kolay', async ({ page }) => {
    await open(page, 390, 844);
    const box = page.locator('.lines-dt tbody tr').first().locator('label.ln-sel');
    const hit = (await box.boundingBox())!;
    expect(hit.width).toBeGreaterThanOrEqual(40);
    await box.locator('input').check();
    const b = (await bar(page).boundingBox())!;
    // Telefonda alttaki uygulama çubuğu (kabuk `.sod-dock`, 2026-11-13) varken seçim çubuğu onun hemen üstüne yapışır.
    const dock = await page.locator('.sod-dock').boundingBox();
    const floor = dock ? dock.y : 844;
    expect(Math.abs(b.y + b.height - floor)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    // kart başlığı kutunun altına girmez
    const title = (await page.locator('.lines-dt tbody tr').first().locator('td.card-title').boundingBox())!;
    expect(hit.x).toBeGreaterThanOrEqual(title.x);
  });

  test('telefonda rozetler alt satırda, geniş ekranda başlıkta (tek kez çizilir)', async ({ page }) => {
    await open(page, 1280);
    await expect(page.locator('.ptitle .inv-pills')).toHaveCount(1);
    await expect(page.locator('.psub .inv-pills')).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.ptitle .inv-pills')).toHaveCount(0);
    await expect(page.locator('.psub .inv-pills')).toHaveCount(1);
  });
});

test.describe('izin', () => {
  test('Muhasebe rolü karar veremez: kutu ve başlık kutusu çizilmez', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockSession(page, 'accounting');
    await page.goto(`${APP}/invoices/i1`);
    await expect(page.locator('.lines-dt tbody tr').first()).toBeVisible();
    await expect(rowBoxes(page)).toHaveCount(0);
    await expect(head(page)).toHaveCount(0);
  });
});
