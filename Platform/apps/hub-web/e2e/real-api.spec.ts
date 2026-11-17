import { test, expect } from './base.ts';

/*
 * Gerçek Hesap servisiyle uçtan uca (mock yok). Çalıştırma:
 *   npx vite --port 5180 --strictPort     (mocksuz; 5180 Hesap'ın izinli köken listesinde)
 *   E2E_REAL_URL=http://localhost:5180 npx playwright test --config playwright.real.config.ts
 * DeciShip `platform/*` uçları henüz yok: bölüm hatası da burada doğrulanır.
 */
const stamp = Date.now().toString(36);
const email = `hub-e2e-${stamp}@example.test`;
const password = 'HubE2eSifre123!';

test('kayıt, firma, ekip, telefon daveti ve katılım gerçek API ile', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, locale: 'tr-TR', viewport: { width: 1440, height: 900 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await ctx.newPage();

  // Kayıt
  await page.goto('/register');
  await page.fill('#org', `Hub E2E ${stamp}`);
  await page.fill('#name', 'Hub Sahip');
  await page.fill('#email', email);
  await page.fill('#pw', password);
  await page.getByRole('button', { name: 'Hesap aç' }).click();
  await expect(page).toHaveURL(/\/home/);
  await expect(page.locator('.sod-top-org')).toHaveText(`Hub E2E ${stamp}`);

  // DeciShip uçları yok: yalnız o bölüm hata gösterir, sayfa ayakta
  await expect(page.getByRole('alert').first()).toContainText('DeciShip verisi alınamadı');
  await expect(page.getByRole('heading', { name: 'Araçlar' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Ekip\s*1 kişi/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /DeciShip planı\s*Erken erişim/ })).toBeVisible();

  // Ekip: telefon daveti, kod bir kez
  await page.goto('/account/team');
  await page.getByRole('button', { name: 'Kişi davet et' }).click();
  await page.fill('#inv-name', 'Hub Çalışan');
  const phoneDigits = String(Date.now()).slice(-7);
  const phone = `0532${phoneDigits}`;
  await page.fill('#inv-contact', phone);
  await page.getByRole('button', { name: 'Kod üret', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Bu kod bir daha gösterilmez');
  const code = await dialog.locator('output').innerText();
  expect(code).toMatch(/^[0-9A-Z]{8}$/);
  await dialog.getByRole('button', { name: 'Kapat', exact: true }).first().click();
  await expect(page.getByText('Hub Çalışan')).toBeVisible();

  // Kendi araç rolü sahipte düzenlenebilir, firma sahibi firma rolü statik
  await expect(page.getByLabel('Hub Sahip DeciShip rolü')).toBeEnabled();

  // Firma adı
  await page.goto('/account/company');
  await page.fill('#org-name', `Hub E2E ${stamp} Yeni`);
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.locator('.sod-top-org')).toHaveText(`Hub E2E ${stamp} Yeni`);

  // Oturumlar, abonelik
  await page.goto('/account/security');
  await expect(page.getByText('Bu cihaz')).toBeVisible();
  await page.goto('/account/billing');
  await expect(page.getByText('Erken erişim')).toBeVisible();

  // Etkinlik: hesap denetim izi metne çevrilir
  await page.goto('/activity');
  await expect(page.getByText('davet oluşturdu').first()).toBeVisible();

  // Yanlış mevcut şifre oturumu düşürmez
  await page.goto('/account/security');
  await page.getByRole('button', { name: 'Değiştir', exact: true }).click();
  await page.fill('#pw-c', 'yanlis-sifre-123');
  await page.fill('#pw-n', 'BaskaSifre1234!');
  await page.fill('#pw-r', 'BaskaSifre1234!');
  await page.getByRole('button', { name: 'Şifreyi değiştir' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(/\/account\/security/);

  // Çıkış
  await page.getByRole('button', { name: /Kullanıcı menüsü/ }).click();
  await page.getByRole('menuitem', { name: 'Çıkış yap' }).click();
  await expect(page).toHaveURL(/\/login/);

  // Çalışan kodla katılır: yeni bağlam
  const worker = await browser.newContext({ baseURL, locale: 'tr-TR', viewport: { width: 1440, height: 900 } });
  const w = await worker.newPage();
  await w.goto('/join');
  await w.fill('#phone', phone);
  await w.fill('#code', code);
  await w.getByRole('button', { name: 'Devam et' }).click();
  await expect(w.getByRole('heading', { name: /firmasına katılın/ })).toBeVisible();
  await w.fill('#pw', 'CalisanSifre123!');
  await w.getByRole('button', { name: 'Katıl' }).click();
  await expect(w).toHaveURL(/\/home/);
  await expect(w.getByRole('heading', { name: 'Bu rol mobil uygulamada çalışır' })).toBeVisible();
  // Rayda DeciShip → mobil sayfası
  await w.locator('.sod-rail a[data-sod-tool=deciship]').click();
  await expect(w).toHaveURL(/\/account\/tool-access\/deciship/);
  await worker.close();

  // Sahip yeniden girer, çalışan listede, rol değiştirir
  await page.fill('#id', email);
  await page.fill('#pw', password);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/home/);
  await page.goto('/account/team');
  const role = page.getByLabel('Hub Çalışan DeciShip rolü');
  await expect(role).toHaveValue('MEASURE');
  await role.selectOption('ACCOUNTING');
  await expect(page.getByText('Hemen geçerli oldu.').first()).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Hub Çalışan DeciShip rolü')).toHaveValue('ACCOUNTING');
  // Yeni kod: tek firmalı, e-postasız kişi için çalışır
  await page.getByRole('button', { name: 'Hub Çalışan için işlemler' }).click();
  await page.getByRole('menuitem', { name: 'Yeni kod üret' }).click();
  await expect(page.getByRole('dialog')).toContainText('Bu kod bir daha gösterilmez');
  await page.getByRole('dialog').getByRole('button', { name: 'Kapat', exact: true }).first().click();

  // Sahip profilde neden ayrılamadığını görür
  await page.goto('/account/firms');
  await expect(page.getByText('Önce sahipliği başka birine devredin')).toBeVisible();

  // Firma seçiciden yeni firma: gerçek POST /orgs (kap yeni imajda olmalı)
  await page.getByRole('button', { name: /^Firma:/ }).click();
  await page.getByRole('menuitem', { name: 'Yeni firma' }).click();
  await page.fill('#new-org', `Hub E2E ${stamp} İkinci`);
  await page.getByRole('button', { name: 'Firmayı aç' }).click();
  await expect(page.locator('.sod-top-org')).toHaveText(`Hub E2E ${stamp} İkinci`);
  // Etkin firma yeni firma: X-SOD-Org ile yazma kabul edilir
  await page.goto('/account/company');
  await page.fill('#org-name', `Hub E2E ${stamp} Üçüncü`);
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.locator('.sod-top-org')).toHaveText(`Hub E2E ${stamp} Üçüncü`);
  await ctx.close();

  // E-postasız çalışan: telefon salt okunur, uyarı, parola onayıyla ayrılır, firma açmak için e-posta ister
  const again = await browser.newContext({ baseURL, locale: 'tr-TR', viewport: { width: 1440, height: 900 } });
  const a = await again.newPage();
  await a.goto('/login');
  await a.fill('#id', phone);
  await a.fill('#pw', 'CalisanSifre123!');
  await a.click('button[type=submit]');
  await expect(a).toHaveURL(/\/home/);
  await a.goto('/account/profile');
  // Telefon salt okunur: e-postasız kişide düzenle/kaldır düğmesi yok.
  await expect(a.locator('.acc-row').filter({ has: a.locator('.acc-lab', { hasText: /^Telefon$/ }) }).getByRole('button')).toHaveCount(0);
  await a.goto('/account/firms');
  await a.getByRole('button', { name: 'Firmadan ayrıl' }).click();
  const leave = a.getByRole('dialog');
  await expect(leave.getByText('Hesabınızda e-posta yok')).toBeVisible();
  await leave.locator('#leave-pw').fill('yanlis-sifre-123');
  await leave.getByRole('button', { name: 'Firmadan ayrıl' }).click();
  await expect(leave.getByRole('alert')).toBeVisible();
  await expect(a).toHaveURL(/\/account\/firms/);
  await leave.locator('#leave-pw').fill('CalisanSifre123!');
  await leave.getByRole('button', { name: 'Firmadan ayrıl' }).click();
  await expect(a.getByRole('heading', { name: 'Firma oluşturun' })).toBeVisible();
  await expect(a.getByText('Firma açmak için önce hesabınıza e-posta ekleyin')).toBeVisible();
  await again.close();
});
