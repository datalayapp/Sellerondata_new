import { test, expect, type Page } from './base.ts';
import { login, reset, USERS } from './helpers.ts';

/*
 * Ekip ve yetkiler · Roller sekmesi (sahte API, `src/mocks/roles.ts`): yeni rol (şablon → yetkiler), düzenleme, kullanımdaki rolü
 * taşıyarak silme, hazır rolü silip geri getirme, firma yöneticisinin kilitleri ve ⋯ menüsünün ekran içinde kalması.
 * Roller araç başına ayrı tabloda (DeciShip, pilot TagPress); iki araçta da "Yönetici" var: satır ve ⋯ menüsü DeciShip tablosunda aranır.
 */

const rolesTab = async (page: Page) => {
  await page.goto('/account/team?tab=roles');
  await expect(page.getByRole('tab', { name: /^Roller/ })).toHaveAttribute('aria-selected', 'true');
  return decishipRoles(page);
};
const decishipRoles = (page: Page) => page.getByRole('table', { name: /^DeciShip · / });
const roleRow = (page: Page, name: string) => decishipRoles(page).locator('tbody tr').filter({ has: page.locator('.d9-role-name b', { hasText: new RegExp(`^${name}$`) }) });
const openMenu = async (page: Page, name: string) => {
  await decishipRoles(page).getByRole('button', { name: `${name} rolü için işlemler` }).click();
  return page.getByRole('menu', { name: `${name} rolü için işlemler` });
};

test.describe('roller', () => {
  test('yeni rol: şablon, kendiliğinden eklenen yetki, oluştur; Kişiler seçicisinde hemen var; düzenle; taşıyarak sil', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    const table = await rolesTab(page);
    await expect(table.locator('tbody tr')).toHaveCount(4);
    // TagPress'in iki hazır rolü ayrı tabloda (pilot, firmada aboneliği var).
    await expect(page.getByRole('table', { name: /^TagPress · / }).locator('.d9-role-name b')).toHaveText(['Yönetici', 'Kullanıcı']);
    await expect(roleRow(page, 'Yönetici')).toContainText('yetkiler kilitli');
    await expect(roleRow(page, 'Ölçüm')).toContainText('Hazır');

    // 1. adım: şablon. Davet varsayılanı (Ölçüm) seçili gelir.
    await page.getByRole('button', { name: 'Yeni rol' }).click();
    const drawer = page.getByRole('dialog', { name: 'Nereden başlayalım?' });
    await expect(drawer).toContainText('Yeni DeciShip rolü · 1 / 2');
    await expect(drawer.getByRole('radio', { name: /Ölçüm/ })).toBeChecked();
    await expect(drawer.getByText('Boş rol')).toBeVisible();
    await drawer.getByRole('button', { name: 'Devam' }).click();

    // 2. adım: yetkiler. "Ölçümleri yönetme" seçilince "Tüm ölçümleri görme" kendiliğinden işaretlenir, kaldırılamaz.
    const review = page.getByRole('dialog', { name: 'Yetkileri gözden geçirin' });
    await expect(review).toContainText('Ölçüm şablonundan');
    await expect(review.getByText('1 yetki seçili')).toBeVisible();
    await review.getByRole('checkbox', { name: /^Ölçümleri yönetme/ }).check();
    const viewAll = review.getByRole('checkbox', { name: /^Tüm ölçümleri görme/ });
    await expect(viewAll).toBeChecked();
    await expect(viewAll).toBeDisabled();
    await expect(review.getByText('Ölçümleri yönetme için gerekli')).toBeVisible();
    await expect(review.getByText('3 yetki seçili')).toBeVisible();
    // Firma sahibi ayar yetkisini verebilir.
    await expect(review.getByRole('checkbox', { name: /^Ayarları yönetme/ })).toBeEnabled();
    // Ad boşken oluşturulmaz, alan söyler; var olan adla da çakışmaz.
    await review.getByRole('button', { name: 'Rolü oluştur' }).click();
    await expect(review.getByText('Rol adını yazın.')).toBeVisible();
    await review.getByLabel('Rol adı').fill('muhasebe');
    await expect(review.getByText('Bu adda bir rol zaten var.')).toBeVisible();
    await review.getByLabel('Rol adı').fill('Depo şefi');
    await review.getByLabel('Kısa açıklama (isteğe bağlı)').fill('Ölçer, tüm ölçümleri görür ve düzeltir.');
    await review.getByRole('button', { name: 'Rolü oluştur' }).click();
    await expect(review).toBeHidden();
    await expect(page.locator('.toast').filter({ hasText: 'Depo şefi rolü oluşturuldu.' })).toBeVisible();
    const row = roleRow(page, 'Depo şefi');
    await expect(row).toContainText('Özel');
    await expect(row).toContainText('Kimsede yok');
    await expect(row).toContainText('Ölçüm yapma');

    // Kişiler sekmesindeki DeciShip seçicisinde hemen seçilebilir.
    await page.getByRole('tab', { name: /^Kişiler/ }).click();
    const mehmet = page.getByLabel('Mehmet Demir DeciShip rolü');
    await mehmet.selectOption({ label: 'Depo şefi' });
    await expect(page.getByText('Hemen geçerli oldu.').first()).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Mehmet Demir DeciShip rolü').locator('option:checked')).toHaveText('Depo şefi');

    // Düzenle: ad değişir; seçicide yeni ad.
    await page.getByRole('tab', { name: /^Roller/ }).click();
    await (await openMenu(page, 'Depo şefi')).getByRole('menuitem', { name: /^Düzenle/ }).click();
    const edit = page.getByRole('dialog', { name: 'Rolü düzenle' });
    await expect(edit.getByRole('checkbox', { name: /^Ölçümleri yönetme/ })).toBeChecked();
    await edit.getByLabel('Rol adı').fill('Depo sorumlusu');
    await edit.getByRole('button', { name: 'Kaydet' }).click();
    await expect(edit).toBeHidden();
    await expect(roleRow(page, 'Depo sorumlusu')).toContainText('1 kişi');

    // "Bu roldekileri gör": Kişiler o rolle süzülür.
    await (await openMenu(page, 'Depo sorumlusu')).getByRole('menuitem', { name: 'Bu roldekileri gör' }).click();
    await expect(page.getByRole('tab', { name: /^Kişiler/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.d9-matrix tbody tr')).toHaveCount(1);
    await expect(page.locator('.d9-matrix tbody tr')).toContainText('Mehmet Demir');

    // Kullanımdaki rolü sil: yeni rol sorulur, kişi taşınır.
    await page.getByRole('tab', { name: /^Roller/ }).click();
    await (await openMenu(page, 'Depo sorumlusu')).getByRole('menuitem', { name: 'Sil' }).click();
    const del = page.getByRole('dialog', { name: '“Depo sorumlusu” rolü silinsin mi?' });
    await expect(del).toContainText('Bu rol 1 kişide kayıtlı');
    await expect(del).toContainText('birkaç saniye içinde');
    await expect(del.getByLabel('Yeni rol')).toHaveValue('MEASURE');
    await del.getByRole('button', { name: 'Rolü taşı ve sil' }).click();
    await expect(del).toBeHidden();
    await expect(roleRow(page, 'Depo sorumlusu')).toHaveCount(0);
    // Süzgeç hâlâ silinen rolde: temizlenince kişi yeni rolüyle görünür.
    await page.getByRole('tab', { name: /^Kişiler/ }).click();
    await page.getByRole('button', { name: 'Filtreleri temizle', exact: true }).click();
    await expect(page.getByLabel('Mehmet Demir DeciShip rolü')).toHaveValue('MEASURE');
  });

  test('hazır rol: düzenlenince "Düzenlendi", varsayılana döner; silinir ve geri getirilir; sahip rolü silinmez', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await rolesTab(page);
    // Sahip rolünde "Sil" yok; düzenlemede yetkiler kilitli.
    const adminMenu = await openMenu(page, 'Yönetici');
    await expect(adminMenu.getByRole('menuitem', { name: 'Sil' })).toHaveCount(0);
    await adminMenu.getByRole('menuitem', { name: /^Düzenle/ }).click();
    const locked = page.getByRole('dialog', { name: 'Rolü düzenle' });
    await expect(locked).toContainText('yetkileri kilitli');
    await expect(locked.getByRole('checkbox', { name: /^Fiyatları görme/ })).toBeDisabled();
    await locked.getByRole('button', { name: 'Vazgeç' }).click();

    // Denetleyici: ad değişir → Düzenlendi → Varsayılana dön.
    await (await openMenu(page, 'Denetleyici')).getByRole('menuitem', { name: /^Düzenle/ }).click();
    const edit = page.getByRole('dialog', { name: 'Rolü düzenle' });
    await edit.getByLabel('Rol adı').fill('Kontrolcü');
    await edit.getByRole('button', { name: 'Kaydet' }).click();
    await expect(roleRow(page, 'Kontrolcü')).toContainText('Düzenlendi');
    await (await openMenu(page, 'Kontrolcü')).getByRole('menuitem', { name: 'Varsayılana dön' }).click();
    await page.getByRole('dialog', { name: '“Kontrolcü” varsayılana dönsün mü?' }).getByRole('button', { name: 'Varsayılana dön' }).click();
    await expect(roleRow(page, 'Denetleyici')).toContainText('Hazır');

    // Muhasebe 1 kişide ve 1 davette: taşıyarak silinir, gizlenir, geri getirilir.
    await (await openMenu(page, 'Muhasebe')).getByRole('menuitem', { name: 'Sil' }).click();
    const del = page.getByRole('dialog', { name: '“Muhasebe” rolü silinsin mi?' });
    await expect(del).toContainText('Bu rol 1 kişide ve 1 bekleyen davette kayıtlı');
    await expect(del).toContainText('Silinen hazır rolleri geri getir');
    await del.getByLabel('Yeni rol').selectOption('AUDITOR');
    await del.getByRole('button', { name: 'Rolü taşı ve sil' }).click();
    await expect(roleRow(page, 'Muhasebe')).toHaveCount(0);
    await page.getByRole('button', { name: 'Silinen hazır rolleri geri getir (1)' }).click();
    const restore = page.getByRole('dialog', { name: 'Silinen hazır roller' });
    await restore.getByRole('button', { name: 'Geri getir' }).click();
    await expect(restore).toBeHidden();
    await expect(roleRow(page, 'Muhasebe')).toContainText('Kimsede yok');
  });

  test('firma yöneticisi: sahibe özel yetki kilitli ve nedeni yazar; kendi rolünü düzenleyemez; davette Yönetici rolü kapalı', async ({ page }) => {
    await reset(page);
    await login(page, USERS.admin);
    await rolesTab(page);
    const own = await openMenu(page, 'Denetleyici');
    await expect(own.getByRole('menuitem', { name: /^Düzenle/ })).toBeDisabled();
    await expect(own.getByRole('menuitem', { name: /^Düzenle/ })).toContainText('yönetemediğiniz');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Yeni rol' }).click();
    await page.getByRole('dialog', { name: 'Nereden başlayalım?' }).getByRole('radio', { name: /Boş rol/ }).check();
    await page.getByRole('button', { name: 'Devam' }).click();
    const review = page.getByRole('dialog', { name: 'Yetkileri gözden geçirin' });
    await expect(review.getByRole('checkbox', { name: /^Ayarları yönetme/ })).toBeDisabled();
    await expect(review.getByText('Bu yetkiyi yalnız firma sahibi verebilir.')).toBeVisible();
    await expect(review.getByRole('checkbox', { name: /^İtiraz gönderme/ })).toBeDisabled();
    await expect(review.getByText('Sizde olmayan bir yetkiyi role ekleyemezsiniz.')).toBeVisible();
    await expect(review.getByText('0 yetki seçili')).toBeVisible();
    await review.getByRole('button', { name: 'Geri' }).click();
    await page.getByRole('dialog', { name: 'Nereden başlayalım?' }).getByRole('button', { name: 'Vazgeç' }).click();

    await page.getByRole('button', { name: 'Kişi davet et' }).click();
    const invite = page.locator('#inv-deciship');
    await expect(invite).toHaveValue('MEASURE');
    await expect(invite.locator('option', { hasText: 'Yönetici' })).toBeDisabled();
  });

  test('⋯ menüsü ekran dışına taşmaz: son satırda yukarı açılır', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await rolesTab(page);
    const trigger = page.getByRole('button', { name: 'Ölçüm rolü için işlemler' });
    // Pencereyi son satırın ⋯ düğmesi alt kenarda kalacak boya indir: altta menüye yer yok.
    const at = (await trigger.boundingBox())!;
    const height = Math.ceil(at.y + at.height + 12);
    await page.setViewportSize({ width: 1280, height });
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'Ölçüm rolü için işlemler' });
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('Ölçüm · hazır rol');
    const box = (await menu.boundingBox())!;
    const btn = (await trigger.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    expect(box.x + box.width).toBeLessThanOrEqual(1280);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(btn.y);
  });
});
