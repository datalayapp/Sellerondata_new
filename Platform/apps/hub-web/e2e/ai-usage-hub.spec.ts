import { test, expect, type Page } from './base.ts';
import { login, reset, USERS } from './helpers.ts';

/*
 * Abonelik → Yapay zekâ kullanımı (ayrıntılı döküm). Sahte API: src/mocks/deciship.ts (`aiUsage`, `aiCalls`).
 * Örnek firma 6 ay önce açıldı (seçilebilir 7 ay); 5 ay önce hiç kullanım yok. Bu ayın en yeni satırlarında yarıda kalan
 * (tahmini), okunamayan, başarısız ve kişisi silinmiş işlem hep var. Ay sınırı örnek firmanın saat diliminde (İstanbul).
 */

const TZ_SHIFT = 3 * 3_600_000;
/** Bugünden `offset` ay kaydırılmış dönem ('YYYY-MM'), İstanbul takvimiyle. */
const periodAt = (offset: number) => {
  const now = new Date(Date.now() + TZ_SHIFT);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString().slice(0, 7);
};
const monthName = (p: string) => new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${p}-01T00:00:00Z`));

const title = (page: Page) => page.getByRole('heading', { level: 1, name: 'Yapay zekâ kullanımı' });
const rows = (page: Page) => page.locator('.aiu-table tbody tr');
const kindCells = (page: Page) => page.locator('.aiu-table tbody tr td:nth-child(3)');
const personCells = (page: Page) => page.locator('.aiu-table tbody tr td:nth-child(2)');
const totalText = (page: Page) => page.locator('.aiu-total');

async function openPage(page: Page, period?: string) {
  await page.goto(`/account/billing/ai/deciship${period ? `?period=${period}` : ''}`);
  await expect(title(page)).toBeVisible();
}

test.describe('yapay zekâ kullanımı: ayrıntılı döküm', () => {
  test('Abonelik kartından açılır; rakamlar, dağılım ve işlemler görünür', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/billing');
    await page.getByRole('link', { name: 'Ayrıntılı döküm' }).click();
    const current = periodAt(0);
    await expect(page).toHaveURL(new RegExp(`/account/billing/ai/deciship\\?period=${current}$`));
    await expect(title(page)).toBeVisible();
    await expect(page.locator('.psub')).toContainText(`DeciShip · ${monthName(current)} · 1`);
    // Kırıntı Abonelik'e döner.
    await expect(page.locator('.crumb').getByRole('link', { name: 'Abonelik' })).toHaveAttribute('href', '/account/billing');

    await expect(page.locator('[data-kpi="cost"]')).toContainText('Toplam maliyet');
    await expect(page.locator('[data-kpi="cost"]')).toContainText('₺');
    await expect(page.locator('[data-kpi="cost"]')).toContainText('KDV hariç');
    await expect(page.locator('[data-kpi="tokens"]')).toContainText(/giren · .* çıkan/);
    await expect(page.locator('[data-kpi="calls"]')).toContainText('başarılı');
    await expect(page.locator('[data-kpi="calls"]')).toContainText('yarıda kaldı');
    await expect(page.locator('[data-kpi="allowance"]')).toContainText('%');
    await expect(page.locator('[data-kpi="allowance"] [role="progressbar"]')).toBeVisible();
    await expect(page.getByRole('region', { name: 'İşlem türüne göre' })).toContainText('PDF fatura okuma');
    await expect(page.getByRole('region', { name: 'Kişiye göre' })).toContainText('Kişi bilinmiyor');

    await expect(rows(page).first()).toBeVisible();
    await expect(totalText(page)).toHaveText(/^\d[\d.]* işlem$/);
    await expect(page.getByRole('columnheader', { name: 'Maliyet' })).toBeVisible();
    // Kayıt bağlantısı DeciShip panelindeki kayda gider.
    const link = page.locator('.aiu-table .aiu-rec').first();
    await expect(link).toHaveAttribute('href', /^\/deciship\/(invoices\/[^/?]+\?tab=ALL|tariffs\/[^/?]+)$/);
    // Haktan düşmeyen satır işaretli.
    await expect(page.locator('.aiu-table tbody tr', { hasText: 'Başarısız' }).first()).toContainText('haktan düşmedi');
  });

  test('türe ve kişiye göre süzer; "Daha fazla göster" sonraki sayfayı ekler', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    // Geçen ay tam bir ay: sayfa boyundan (50) çok işlem var.
    const last = periodAt(-1);
    await openPage(page, last);
    await expect(rows(page)).toHaveCount(50);
    const all = Number((await totalText(page).innerText()).replace(/\D/g, ''));
    expect(all).toBeGreaterThan(50);

    await page.getByRole('button', { name: 'Daha fazla göster' }).click();
    await expect(rows(page)).toHaveCount(Math.min(100, all));

    await page.getByLabel('İşlem türü', { exact: true }).selectOption({ label: 'Tartı okuma' });
    await expect(page).toHaveURL(/kind=SCALE_READ/);
    await expect(kindCells(page).filter({ hasNotText: 'Tartı okuma' })).toHaveCount(0);
    await expect(rows(page).first()).toBeVisible();
    const scale = Number((await totalText(page).innerText()).replace(/\D/g, ''));
    expect(scale).toBeLessThan(all);
    for (const text of await kindCells(page).allInnerTexts()) expect(text).toBe('Tartı okuma');

    await page.getByLabel('İşlem türü', { exact: true }).selectOption({ label: 'Tümü' });
    await page.getByLabel('Kişi', { exact: true }).selectOption({ label: 'Kişi bilinmiyor' });
    await expect(page).toHaveURL(/member=none/);
    await expect(page).not.toHaveURL(/kind=/);
    await expect(rows(page).first()).toBeVisible();
    await expect(personCells(page).filter({ hasNotText: 'Kişi bilinmiyor' })).toHaveCount(0);
    await expect(rows(page).first()).toBeVisible();

    // Süzgeç adreste: yenileyince korunur.
    await page.reload();
    await expect(page.getByLabel('Kişi', { exact: true })).toHaveValue('none');
    await expect(rows(page).first()).toBeVisible();
  });

  test('satıra tıklayınca ayrıntı paneli açılır, Esc kapatır', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await openPage(page);
    const row = page.locator('.aiu-table tbody tr', { hasText: 'Yarıda kaldı · tahmini' }).first();
    // Kayıt hücresindeki bağlantı kayda gider; satırın başka yerine tıklanır.
    await row.locator('td').first().click();
    const drawer = page.getByRole('dialog', { name: 'PDF fatura okuma' });
    await expect(drawer).toBeVisible();
    for (const text of [
      'Yarıda kaldı · tahmini',
      'Giren token',
      'Çıkan token',
      'Önbellekten okunan',
      'Önbelleğe yazılan',
      'Toplam token',
      'İstenen model',
      'Yanıt veren model',
      'claude-sonnet-5-5',
      'Fiyat tablosu',
      '1 $ = ',
      'Maliyet',
      'gerçek değer bundan az değildir',
      'aylık haktan düşmedi',
    ]) {
      await expect(drawer).toContainText(text);
    }
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    // Klavyeyle de açılır (Enter).
    await rows(page).first().focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('ay seçici: oklar sınırda kapalı, liste ekranda, seçilen ay adreste ve veride', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await openPage(page);
    const current = periodAt(0);
    const prev = page.getByRole('button', { name: 'Önceki ay' });
    const next = page.getByRole('button', { name: 'Sonraki ay' });
    await expect(next).toBeDisabled();
    await expect(prev).toBeEnabled();

    await prev.click();
    await expect(page).toHaveURL(new RegExp(`period=${periodAt(-1)}`));
    await expect(page.locator('.psub')).toContainText(monthName(periodAt(-1)));
    await expect(next).toBeEnabled();
    await page.goBack();
    await expect(page.locator('.psub')).toContainText(monthName(current));

    // Liste: seçilebilir 7 ay (yeniden eskiye), kullanımsız ay işaretli.
    const trigger = page.getByRole('button', { name: monthName(current) });
    const width = (await trigger.boundingBox())!.width;
    await trigger.click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveCount(7);
    await expect(menu.getByRole('menuitem').first()).toContainText(monthName(current));
    await expect(menu.getByRole('menuitem').first()).toContainText('Seçili');
    await expect(menu.getByRole('menuitem', { name: new RegExp(monthName(periodAt(-5))) })).toContainText('Kullanım yok');
    // Klavye: ↓ gezinir, Esc kapatır ve odağı düğmeye döndürür.
    const focused = () => page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].indexOf(document.activeElement as Element));
    await page.keyboard.press('ArrowDown');
    const at = await focused();
    expect(at).toBeGreaterThanOrEqual(0);
    await page.keyboard.press('ArrowDown');
    expect(await focused()).toBe(at + 1);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();

    // En eski ay: sol ok kapalı; düğme aynı genişlikte.
    await trigger.click();
    await page.getByRole('menuitem', { name: new RegExp(monthName(periodAt(-6))) }).click();
    await expect(page).toHaveURL(new RegExp(`period=${periodAt(-6)}`));
    await expect(prev).toBeDisabled();
    await expect(next).toBeEnabled();
    const oldTrigger = page.getByRole('button', { name: monthName(periodAt(-6)) });
    expect(Math.round((await oldTrigger.boundingBox())!.width)).toBe(Math.round(width));
    await expect(rows(page).first()).toBeVisible();

    // Telefonda da liste ekranın içinde.
    await page.setViewportSize({ width: 390, height: 844 });
    await oldTrigger.click();
    const box = (await page.getByRole('menu').boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    await page.keyboard.press('Escape');
    // Telefonda Excel düğmesi ikon olarak bantta kalır, sayfa yana taşmaz.
    await expect(page.getByRole('button', { name: "Excel'e indir" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test('geçersiz ay bu aya döner; kullanımsız ayda boş durum', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await openPage(page, '2026-13');
    await expect(page).not.toHaveURL(/period=/);
    await expect(page.locator('.psub')).toContainText(monthName(periodAt(0)));

    await openPage(page, periodAt(-5));
    await expect(page.getByText('Bu dönemde yapay zekâ kullanılmadı')).toBeVisible();
    await expect(page.locator('[data-kpi="calls"]')).toContainText('0');
    await expect(page.getByRole('button', { name: "Excel'e indir" })).toBeDisabled();
  });

  test('işlem listesi gelmezse hata ve yeniden dene', async ({ page }) => {
    await reset(page, { fail: ['deciship.ai-calls'] });
    await login(page, USERS.owner);
    await openPage(page);
    // Özet gelir, liste hata verir.
    await expect(page.locator('[data-kpi="calls"]')).toBeVisible();
    const alert = page.locator('.aiu-calls [role="alert"]');
    await expect(alert).toBeVisible();
    await page.evaluate(() => localStorage.removeItem('sod_mock_fail'));
    await alert.getByRole('button', { name: 'Tekrar dene' }).click();
    await expect(rows(page).first()).toBeVisible();
    await expect(alert).toBeHidden();
  });

  test('ayar izni olmayan yönetici: kısa "görünmüyor" durumu', async ({ page }) => {
    await reset(page);
    // Firma yöneticisi, DeciShip'te Denetleyici (ayar izni yok): uç 403.
    await login(page, USERS.admin);
    await page.goto('/account/billing/ai/deciship');
    await expect(page.getByText('Yapay zekâ kullanımı burada görünmüyor')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Aboneliğe dön' })).toHaveAttribute('href', '/account/billing');
    // Bilinmeyen araç da aynı durum.
    await page.goto('/account/billing/ai/yokboyle');
    await expect(page.getByText('Yapay zekâ kullanımı burada görünmüyor')).toBeVisible();
  });

  test("Excel'e indir: dosya adı ayı ve dili taşır", async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    const last = periodAt(-1);
    await openPage(page, last);
    await expect(rows(page).first()).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: "Excel'e indir" }).click()]);
    expect(download.suggestedFilename()).toBe(`deciship-yapay-zeka-${last}.xlsx`);
  });
});
