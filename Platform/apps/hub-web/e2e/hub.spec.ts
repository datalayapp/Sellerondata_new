import { test, expect, type Page } from './base.ts';
import { login, reset, USERS, PASSWORD } from './helpers.ts';

/** D09 kabuğu: uygulamalar ⊞ menüsü (Merkez + araçlar), bant menüsü, logo kilidi. */
const apps = async (page: Page) => {
  await page.getByRole('button', { name: 'Uygulamalar' }).click();
  return page.getByRole('menu', { name: 'SellerOnData uygulamaları' });
};
/**
 * Veriler araç çubuğu: nadir eylemler ⋯ menüsünde ("Diğer işlemler"). Menüyü açar, öğeyi döndürür.
 * Menü kaydırmada kapanır; yeni veri gelip tablo yeniden çizilince açılan menü kapanabilir. Önce veri durulur,
 * menü açık görünmezse yeniden açılır.
 */
const dataMenuItem = async (page: Page, name: 'CSV indir' | 'Sütunlar…') => {
  await page.waitForLoadState('networkidle');
  const item = page.getByRole('menuitem', { name });
  await expect(async () => {
    if (!(await item.isVisible())) await page.getByRole('button', { name: 'Diğer işlemler' }).click();
    await expect(item).toBeVisible({ timeout: 1000 });
  }).toPass();
  return item;
};
/** Veriler'de açıkta tek süzgeç durur; gerisi "Filtreler" düğmesinin arkasında. */
const openMoreFilters = (page: Page) => page.getByRole('button', { name: /^Filtreler( \(|$)/ }).click();

const hubNav = (page: Page) => page.getByRole('navigation', { name: 'Merkez menüsü' });

test.describe('oturum', () => {
  test('e-postayla giriş, yanlış şifrede hata, çıkış', async ({ page }) => {
    await reset(page);
    await page.goto('/login');
    await page.fill('#id', USERS.owner);
    await page.fill('#pw', 'yanlis');
    await page.click('button[type=submit]');
    await expect(page.getByRole('alert')).toContainText('Giriş bilgileri hatalı');

    await page.fill('#pw', PASSWORD);
    await page.click('button[type=submit]');
    await expect(page).toHaveURL(/\/home/);
    await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();

    await page.getByRole('button', { name: /Kullanıcı menüsü/ }).click();
    await page.getByRole('menuitem', { name: 'Çıkış yap' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/home');
    await expect(page).toHaveURL(/\/login\?next=%2Fhome/);
  });

  test('telefonla giriş', async ({ page }) => {
    await reset(page);
    await login(page, USERS.measure);
    await expect(page.getByRole('heading', { name: 'Bu rol mobil uygulamada çalışır' })).toBeVisible();
  });

  test('telefon + kodla katılım ve şifre belirleme', async ({ page }) => {
    await reset(page);
    await page.goto('/join');
    await page.fill('#phone', '0532 000 00 11');
    await page.fill('#code', 'k7m2qx9p');
    await page.getByRole('button', { name: 'Devam et' }).click();
    await expect(page.getByRole('heading', { name: 'Örnek Firma firmasına katılın' })).toBeVisible();
    await page.fill('#pw', 'YeniSifre123');
    await page.getByRole('button', { name: 'Katıl' }).click();
    await expect(page).toHaveURL(/\/home/);
    await expect(page.getByRole('heading', { name: 'Bu rol mobil uygulamada çalışır' })).toBeVisible();
  });

  test('TOKEN_EXPIRED: tek seferlik yenile ve tekrar dene, kullanıcı fark etmez', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => {
      localStorage.setItem('sod_mock_expire', 'TOKEN_STALE');
      localStorage.removeItem('sod_refreshed_at');
      localStorage.removeItem('sod_mock_refreshes');
    });
    await page.goto('/account/profile');
    await expect(page.locator('.acc-row').filter({ has: page.locator('.acc-lab', { hasText: /^Ad soyad$/ }) })).toContainText('Selin Aydın');
    // Ad önbellekten hemen gelir, yenileme ardından biter: bekle, sonra tam bir kez olduğunu doğrula.
    await expect.poll(() => page.evaluate(() => localStorage.getItem('sod_mock_refreshes'))).toBe('1');
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => localStorage.getItem('sod_mock_refreshes'))).toBe('1');
    await expect(page).toHaveURL(/\/account\/profile/);
  });
});

test('yanlış mevcut şifre (401 INVALID_CREDENTIALS) oturumu düşürmez, hata yerinde görünür', async ({ page }) => {
  await reset(page);
  await login(page, USERS.owner);
  await page.goto('/account/security');
  await page.getByRole('button', { name: 'Değiştir', exact: true }).click();
  await page.fill('#pw-c', 'yanlis-sifre');
  await page.fill('#pw-n', 'YeniSifre123');
  await page.fill('#pw-r', 'YeniSifre123');
  await page.getByRole('button', { name: 'Şifreyi değiştir' }).click();
  await expect(page.getByRole('alert')).toContainText('Giriş bilgileri hatalı');
  await expect(page).toHaveURL(/\/account\/security/);
});

test.describe('Hesabım bölümleri', () => {
  test('ayar menüsü üç bölümü gezdirir; bantta kişi adı ve "tüm firmalarınızda aynı" yazar', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account');
    await expect(page).toHaveURL(/\/account\/profile$/);
    const band = page.locator('.sod-band');
    await expect(band.getByRole('heading', { name: 'Selin Aydın', level: 1 })).toBeVisible();
    await expect(band).toContainText('Bu bilgiler tüm firmalarınızda aynıdır');
    await expect(page.locator('.phead-av')).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Hesabım' });
    await expect(nav.getByRole('link')).toHaveText(['Profil', 'Güvenlik', 'Firmalarım']);
    await expect(nav.getByRole('link', { name: 'Profil' })).toHaveAttribute('aria-current', 'page');
    await nav.getByRole('link', { name: 'Güvenlik' }).click();
    await expect(page).toHaveURL(/\/account\/security$/);
    await expect(page).toHaveTitle('Güvenlik · Merkez');
    await expect(nav.getByRole('link', { name: 'Güvenlik' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'Profil' })).not.toHaveAttribute('aria-current', 'page');
    await expect(band.getByRole('heading', { name: 'Selin Aydın', level: 1 })).toBeVisible();
    await nav.getByRole('link', { name: 'Firmalarım' }).click();
    await expect(page).toHaveURL(/\/account\/firms$/);
    await expect(page).toHaveTitle('Firmalarım · Merkez');
    await expect(nav.getByRole('link', { name: 'Firmalarım' })).toHaveAttribute('aria-current', 'page');
    await expect(band.getByRole('heading', { name: 'Selin Aydın', level: 1 })).toBeVisible();
  });

  test('Profil: Kişisel bilgiler ve Tercihler; Dil satırı "Değiştir" ile açılır ve dili değiştirir; güvenlik ve firma kartı yok', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/profile');
    await expect(page.getByRole('heading', { name: 'Kişisel bilgiler', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Tercihler', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Açık oturumlar' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Firmalarım', level: 2 })).toHaveCount(0);
    const lang = page.locator('.acc-row').filter({ has: page.locator('.acc-lab', { hasText: /^Dil$/ }) });
    const change = lang.getByRole('button', { name: 'Değiştir' });
    await expect(change).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('radiogroup', { name: 'Dil' })).toHaveCount(0);
    await change.click();
    await expect(change).toHaveAttribute('aria-expanded', 'true');
    const group = page.getByRole('radiogroup', { name: 'Dil' });
    await expect(group.getByRole('radio', { name: 'Türkçe' })).toHaveAttribute('aria-checked', 'true');
    await group.getByRole('radio', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('.acc-row').filter({ has: page.locator('.acc-lab', { hasText: /^Language$/ }) }).getByRole('button', { name: 'Change' })).toBeVisible();
  });

  test('Güvenlik: şifre formu "Değiştir" ile açılır; oturumlar doğrudan listelenir, tek tek ve toplu kapatılır', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/security');
    await expect(page.locator('#pw-c')).toHaveCount(0);
    await page.getByRole('button', { name: 'Değiştir', exact: true }).click();
    await expect(page.locator('#pw-c')).toBeVisible();
    await page.getByRole('button', { name: 'Vazgeç' }).click();
    await expect(page.locator('#pw-c')).toHaveCount(0);
    // Açık oturumlar: açma/kapama düğmesi yok, liste doğrudan görünür. Bu cihazda kapatma düğmesi yok.
    const list = page.locator('#acc-sessions');
    await expect(page.getByRole('button', { name: /^(Görüntüle|Gizle)$/ })).toHaveCount(0);
    await expect(list.locator('li')).toHaveCount(3);
    await expect(list.locator('.tag', { hasText: 'Bu cihaz' })).toHaveCount(1);
    await expect(list.getByRole('button', { name: 'Çıkış yap' })).toHaveCount(2);
    await list.getByRole('button', { name: 'Çıkış yap' }).first().click();
    await expect(list.locator('li')).toHaveCount(2);
    await expect(list.getByRole('button', { name: 'Çıkış yap' })).toHaveCount(1);
    await list.getByRole('button', { name: 'Diğer tüm oturumları kapat' }).click();
    await expect(page.getByText('Diğer oturumlar kapatıldı')).toBeVisible();
    await expect(list.locator('li')).toHaveCount(1);
    await expect(list.locator('.tag', { hasText: 'Bu cihaz' })).toHaveCount(1);
    await expect(list.getByRole('button', { name: 'Diğer tüm oturumları kapat' })).toHaveCount(0);
  });

  test('Firmalarım: her firma bir satır, etkin firma işaretli; başka firmadan ayrılmak o firmaya geçer ve Firmalarım\'da onay açar', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/firms');
    await expect(page.getByRole('heading', { name: 'Firmalarım', level: 2 })).toBeVisible();
    const own = page.locator('.acc-row').filter({ hasText: 'Örnek Firma' });
    await expect(own).toContainText('Firma sahibi');
    await expect(own).toContainText('Etkin firma');
    await expect(own.getByRole('link', { name: "Merkez'de aç" })).toBeVisible();
    await expect(own.getByRole('button', { name: 'Firmadan ayrıl' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Yeni firma oluştur' })).toHaveAttribute('href', '/account/company/new');
    const other = page.locator('.acc-row').filter({ hasText: 'Örnek İhracat Ltd.' });
    await expect(other).not.toContainText('Etkin firma');
    await expect(other.getByRole('button', { name: 'Firmadan ayrıl' })).toHaveClass(/danger/);
    await other.getByRole('button', { name: 'Firmadan ayrıl' }).click();
    await expect(page.locator('.sod-firm-n')).toHaveText('Örnek İhracat Ltd.');
    await expect(page).toHaveURL(/\/account\/firms$/);
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Firmadan ayrıl' })).toBeVisible();
  });
});

test.describe('araç geçişi', () => {
  test('Merkez → DeciShip tam sayfa gezinti; bant satırı yerinde, etkin araç üç yerde belli', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await expect(page).toHaveTitle('Genel Bakış · Merkez');
    // Logo kilidi: büyük satırda Merkez (CSS büyük harf), altında SellerOnData; erişilebilir ad "SellerOnData Merkez".
    await expect(page.locator('.sod-brand-n')).toHaveText('Merkez');
    await expect(page.locator('.sod-brand-sub')).toHaveText('SellerOnData');
    await expect(page.getByRole('link', { name: 'SellerOnData Merkez' })).toHaveAttribute('href', '/home');
    const before = await page.locator('.sod-top').boundingBox();
    let menu = await apps(page);
    await expect(menu.getByRole('menuitem', { name: /Merkez/ })).toHaveAttribute('aria-current', 'page');

    await page.evaluate(() => ((window as unknown as { __sameDoc: boolean }).__sameDoc = true));
    await menu.getByRole('menuitem', { name: /DeciShip/ }).click();
    await expect(page).toHaveURL(/\/deciship\/$/);
    await expect(page.getByTestId('deciship-stub')).toBeVisible();
    // Yeni belge: tam gezinti
    expect(await page.evaluate(() => (window as unknown as { __sameDoc?: boolean }).__sameDoc)).toBeUndefined();

    // Etkin araç: logo kilidi, uygulama menüsü, sekme başlığı
    await expect(page.locator('.sod-brand-n')).toHaveText('DeciShip');
    await expect(page).toHaveTitle('Pano · DeciShip');
    menu = await apps(page);
    await expect(menu.getByRole('menuitem', { name: /DeciShip/ })).toHaveAttribute('aria-current', 'page');
    await page.keyboard.press('Escape');
    // Bandın üst satırı piksel olarak aynı yerde: yalnız renk ve logo değişir.
    expect(await page.locator('.sod-top').boundingBox()).toEqual(before);
    // Yabancı menü düğümü bant menüsüne oturdu; react-router yok
    await expect(page.getByTestId('foreign-sidebar')).toBeVisible();

    // Üründe kilidin alt satırı SellerOnData; Merkez'e dönüş uygulama menüsünden (kilit ürünün ana sayfasına gider).
    await expect(page.locator('.sod-brand-sub')).toHaveText('SellerOnData');
    await expect(page.locator('.sod-brand a')).toHaveAttribute('href', '/deciship/');
    await (await apps(page)).getByRole('menuitem', { name: /Merkez/ }).click();
    await expect(page).toHaveURL(/\/home/);
    await expect(page).toHaveTitle('Genel Bakış · Merkez');
  });

  test('DeciShip önceden yüklenir', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await expect(page.locator('link[rel="prefetch"][href="/deciship/"]')).toHaveCount(1);
  });

  test('OrderLoom tıklanamaz, klavyeyle odaklanmaz; pilot TagPress aboneliği olan firmada açık', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    const menu = await apps(page);
    // TagPress `pilot`: sahte API'de her firmanın aboneliği var, sahip Yönetici; menüde bağlantı.
    await expect(menu.locator('a[data-sod-tool="tagpress"]')).toHaveAttribute('href', '/tagpress/');
    for (const name of ['OrderLoom']) {
      if (!(await menu.isVisible())) await page.getByRole('button', { name: 'Uygulamalar' }).click();
      const item = menu.locator('.sod-pop-item.is-soon', { hasText: name });
      await expect(item).toHaveAttribute('aria-disabled', 'true');
      await expect(item).toContainText('Yakında');
      expect(await item.evaluate((el) => el.tagName)).toBe('SPAN');
      expect(await item.getAttribute('tabindex')).toBeNull();
      await item.click({ force: true });
      await expect(page).toHaveURL(/\/home/);
    }
    // Menüde okla gezerken yalnız açık uygulamalar odak alır. "Yakında" öğesine tıklamak odağı menüden çıkarır (odak almaz), Escape
    // menüye ulaşmaz: açıksa menü düğmesiyle kapatılır, sonra yeniden açılır ve odak ilk öğede başlar.
    if (await menu.isVisible()) await page.getByRole('button', { name: 'Uygulamalar' }).click();
    await expect(menu).toBeHidden();
    await page.getByRole('button', { name: 'Uygulamalar' }).click();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    const focused: string[] = [];
    for (let i = 0; i < 6; i++) {
      focused.push(await page.evaluate(() => document.activeElement?.textContent ?? ''));
      await page.keyboard.press('ArrowDown');
    }
    expect(focused.join('|')).not.toContain('OrderLoom');
    expect(focused.join('|')).toContain('DeciShip');
    expect(focused.join('|')).toContain('TagPress');
  });
});

test.describe('ekip', () => {
  test('rol değiştirme kaydolur, kalıcıdır', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/team');
    const select = page.getByLabel('Can Yıldız DeciShip rolü');
    await expect(select).toHaveValue('ACCOUNTING');
    await select.selectOption('AUDITOR');
    await expect(page.getByText('Hemen geçerli oldu.').first()).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Can Yıldız DeciShip rolü')).toHaveValue('AUDITOR');
  });

  test('sunucu reddederse rol eski haline döner, neden satırda görünür', async ({ page }) => {
    await reset(page, { fail: ['team.patch'] });
    await login(page, USERS.owner);
    await page.goto('/account/team');
    const select = page.getByLabel('Can Yıldız DeciShip rolü');
    await select.selectOption('AUDITOR');
    await expect(page.getByRole('alert')).toContainText('Firma sahibinin üyeliğini değiştiremezsiniz');
    await expect(select).toHaveValue('ACCOUNTING');
  });

  test('telefon daveti: kod bir kez gösterilir, kopyalanır', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/team');
    await page.getByRole('button', { name: 'Kişi davet et' }).click();
    await page.fill('#inv-name', 'Örnek Çalışan');
    await page.fill('#inv-contact', '0532 000 00 21');
    await page.getByRole('button', { name: 'Kod üret', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Bu kod bir daha gösterilmez');
    const code = await dialog.locator('output').innerText();
    expect(code).toMatch(/^[0-9A-Z]{8}$/);
    await dialog.getByRole('button', { name: 'Kodu kopyala' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
    await dialog.getByRole('button', { name: 'Tamam' }).click();
    await expect(page.getByText('Örnek Çalışan')).toBeVisible();
    await expect(page.locator('output')).toHaveCount(0);
  });

  test('yeni kod kuralı: birden çok firmadaki kişide kod üretilmez, başka firmada çalıştığı söylenmez (04-B10)', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/team');
    await page.getByRole('button', { name: 'Murat Koç için işlemler' }).click();
    await page.getByRole('menuitem', { name: 'Yeni kod üret' }).click();
    await expect(page.getByRole('alert')).toContainText('şifresini kendisi yenilemeli');
    await expect(page.getByRole('alert')).not.toContainText('başka firma');
  });

  test('yönetici firma sahibini değiştiremez, yönetici atayamaz', async ({ page }) => {
    await reset(page);
    await login(page, USERS.admin);
    await page.goto('/account/team');
    await expect(page.getByLabel('Selin Aydın DeciShip rolü')).toBeDisabled();
    const org = page.getByLabel('Can Yıldız firma rolü');
    await expect(org.locator('option')).toHaveCount(1);
    await expect(org.locator('option')).toHaveText('Çalışan');
  });
});

test.describe('görünürlük', () => {
  test('sahip: Hesap yönetimi + Analiz + Veriler', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    const nav = hubNav(page);
    for (const name of ['Analiz', 'Veriler', 'Etkinlik', 'Ekip ve yetkiler', 'Abonelik']) {
      await expect(nav.getByRole('link', { name })).toBeVisible();
    }
    // Firma ayarları firma seçicide (GB-D09 menüsü): menüde tekrar edilmez.
    await expect(nav.getByRole('link', { name: 'Firma' })).toHaveCount(0);
    await page.getByRole('button', { name: /^Firma:/ }).click();
    await page.getByRole('menuitem', { name: 'Firma ayarları' }).click();
    await expect(page).toHaveURL(/\/account\/company$/);
  });

  test('muhasebe: Analiz ve Veriler var, Hesap yönetimi yok, adres yazsa da neden okur', async ({ page }) => {
    await reset(page);
    await login(page, USERS.accounting);
    const nav = hubNav(page);
    await expect(nav.getByRole('link', { name: 'Analiz' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Ekip ve yetkiler' })).toHaveCount(0);
    await page.goto('/account/team');
    await expect(page.getByText('Bu sayfayı göremezsiniz')).toBeVisible();
  });

  test('ölçüm: sade Merkez; DeciShip tıklanınca mobil sayfası, araç uygulama menüsünde etkin', async ({ page }) => {
    await reset(page);
    await login(page, USERS.measure);
    const nav = hubNav(page);
    await expect(nav.getByRole('link', { name: 'Genel Bakış' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Analiz' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Veriler' })).toHaveCount(0);
    await (await apps(page)).getByRole('menuitem', { name: /DeciShip/ }).click();
    await expect(page).toHaveURL(/\/account\/tool-access\/deciship/);
    await expect(page.getByRole('heading', { name: 'Bu rol mobil uygulamada çalışır' })).toBeVisible();
    await expect(page.locator('.sod-brand-n')).toHaveText('DeciShip');
    await expect((await apps(page)).getByRole('menuitem', { name: /DeciShip/ })).toHaveAttribute('aria-current', 'page');
  });

  test('bölüm bazlı hata: ürün yanıt vermezse sayfa ayakta kalır', async ({ page }) => {
    await reset(page, { fail: ['deciship.overview'] });
    await login(page, USERS.owner);
    await expect(page.getByRole('alert')).toContainText('DeciShip verisi alınamadı');
    // Veri gelmediyse "bekleyen yok" denmez
    await expect(page.getByText('Bekleyen iş yok')).toHaveCount(0);
    await expect(page.getByText('Bekleyen madde yok')).toHaveCount(0);
    await expect(page.getByText('bekleyenler bilinmiyor')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Araçlar' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Bekleyen davet/ })).toBeVisible();
  });
});

test.describe('dil', () => {
  test('dil değişimi kabuğu, sayfayı ve sunucu etiketlerini çevirir; kalıcıdır', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await expect(page.getByText('Yakalanan fazla ödeme', { exact: true })).toBeVisible();
    // Dil avatar menüsünde (D09 kabuğu).
    await page.getByRole('button', { name: /^Kullanıcı menüsü/ }).click();
    await page.locator('.sod-pop-lang').click();
    await page.getByRole('menuitemradio', { name: 'English' }).click();
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
    await expect(page.locator('.sod-brand-n')).toHaveText('Hub');
    await expect(page.getByRole('link', { name: 'SellerOnData Hub' })).toBeVisible();
    await expect(page.locator('.hub-figure .hub-lead-label').first()).not.toHaveText('Yakalanan fazla ödeme');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page).toHaveTitle('Overview · Hub');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  });
});

test.describe('analiz ve veriler', () => {
  test('tarih aralığı, karşılaştırma, süzgeç adrese yansır; tüm widget türleri çizilir', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/analytics');
    // Tümü adreste araç taşımaz; tek açık araçta DeciShip analizini gösterir. Araç seçilince adres /analytics/deciship olur.
    await expect(page).toHaveURL(/\/analytics$/);
    await page.getByRole('navigation', { name: 'Araca göre' }).getByRole('link', { name: 'DeciShip' }).click();
    await expect(page).toHaveURL(/\/analytics\/deciship/);
    await expect(page.getByRole('heading', { name: 'Fazla ödeme', exact: true, level: 2 })).toBeVisible();
    // Bölümler sekme: sayfada tek bölüm durur.
    await expect(page.locator('.hub-kpis')).toHaveCount(1);
    await expect(page.locator('.hub-section-tabs a[aria-current="page"]')).toHaveText('Fazla ödeme');
    await expect(page.locator('.hub-chart svg').first()).toBeVisible();
    await expect(page.locator('.hub-bars').first()).toBeVisible();
    await expect(page.locator('.hub-widget table').first()).toBeVisible();
    await page.getByRole('link', { name: 'Tarife sağlığı' }).click();
    await expect(page.getByRole('heading', { name: 'Tarife sağlığı', level: 2 })).toBeVisible();
    await expect(page).toHaveURL(/section=tariffs/);
    await page.getByRole('link', { name: 'Fazla ödeme' }).click();

    // Para birimi seçenekleri döneme göre gelir: 7 günde USD fatura olmayabilir, önce seçilir.
    await page.getByRole('button', { name: /^Filtre/ }).click();
    await page.getByLabel('Para birimi').selectOption('USD');
    await expect(page).toHaveURL(/filter\.currency=USD/);
    // Tarih aralığı bantta tek düğme (GB-D09): açılır, hazır aralık seçilir.
    await page.getByRole('button', { name: /^Tarih aralığı/ }).click();
    await page.getByRole('button', { name: 'Son 7 gün', exact: true }).click();
    await expect(page).toHaveURL(/range=7d/);
    await expect(page.getByRole('button', { name: 'Tarih aralığı: Son 7 gün' })).toBeVisible();
    await page.getByLabel('Önceki dönemle karşılaştır').uncheck();
    await expect(page).toHaveURL(/compare=0/);
    await page.getByLabel('Hizmet').selectOption({ index: 1 });
    await expect(page).toHaveURL(/filter\.service=/);
  });

  test('grafik klavyeyle okunur, tablo ikizi vardır', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/analytics/deciship');
    const chart = page.locator('.hub-chart svg').first();
    await chart.focus();
    await expect(page.locator('.hub-tip')).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.hub-tip')).toBeVisible();
    await page.getByRole('button', { name: 'Tablo' }).first().click();
    await expect(page.locator('.hub-twin table')).toBeVisible();
  });

  test('veriler: satırın herhangi bir hücresine tıklamak kaydı açar', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/data/deciship/invoices');
    const row = page.locator('tr.hub-row-link').first();
    await expect(row).toBeVisible();
    await row.locator('td').nth(3).click();
    await expect(page).toHaveURL(/\/data\/deciship\/invoices\/[^/?]+|\/deciship\//);
    await expect(page).not.toHaveURL(/\/data\/deciship\/invoices$/);
  });

  test('analiz CSV: TR ondalık virgül, kalem tablosunda para birimi sütunu', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/analytics/deciship');
    await page.waitForLoadState('networkidle');
    // Kart başı CSV düğmeleri yok; sayfa başında tek "Dışa aktar" menüsü, her tablo bir öğe.
    await expect(page.getByRole('button', { name: 'CSV', exact: true })).toHaveCount(0);
    const menu = page.getByRole('button', { name: 'Dışa aktar' });
    await expect(menu).toHaveCount(1);
    await menu.click();
    const n = await page.getByRole('menuitem').count();
    expect(n).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    let sawCurrency = false;
    for (let i = 0; i < n; i++) {
      await menu.click();
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem').nth(i).click()]);
      const text = (await import('node:fs')).readFileSync((await dl.path())!, 'utf8');
      const lines = text.replace(/^\ufeff/, '').split(/\r?\n/);
      if (lines[0] === 'Kalem;Değer;Para birimi') {
        sawCurrency = true;
        expect(lines[1]).toMatch(/;(TRY|USD|EUR)$/);
      } else if (lines[0].startsWith('Kalem;')) {
        expect(lines[0]).toBe('Kalem;Değer');
      }
      // ondalık nokta kalmaz: ";123.45" biçimi yok
      expect(text).not.toMatch(/;-?\d+\.\d+(;|\r|\n|$)/);
    }
    expect(sawCurrency).toBe(true);
  });

  test('veriler: arama, sıralama, süzme, sayfalama, CSV, derin bağlantı', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/data');
    await expect(page).toHaveURL(/\/data\/deciship\/invoices/);
    await page.getByRole('link', { name: 'Fatura satırları' }).click();
    await expect(page).toHaveURL(/invoice-lines/);
    await page.waitForLoadState('networkidle');
    const allTotal = await page.locator('.hub-total').innerText();

    // Açıkta yalnız ilk süzgeç (Taşıyıcı) durur; Durum "Filtreler"in arkasında.
    await expect(page.getByLabel('Durum', { exact: true })).toHaveCount(0);
    await openMoreFilters(page);
    await page.getByLabel('Durum', { exact: true }).selectOption('DIFF');
    await expect(page).toHaveURL(/filter\.status=DIFF/);
    await expect(page.locator('.hub-total')).not.toHaveText(allTotal);

    // Tümü'nde tutar sıralanmaz: para birimi seçilince açılır.
    await expect(page.getByRole('button', { name: 'Faturalanan', exact: true })).toHaveCount(0);
    await page.goto(`${page.url()}&filter.currency=TRY`);
    await page.getByRole('button', { name: 'Faturalanan', exact: true }).click();
    await expect(page).toHaveURL(/sort=net&dir=desc/);

    await page.getByLabel('Ara', { exact: true }).fill('zzz-yok');
    await expect(page.getByText('Aramayla eşleşen kayıt yok')).toBeVisible();
    await page.getByRole('button', { name: 'Aramayı ve filtreleri temizle' }).click();
    await expect(page.locator('.hub-total')).toHaveText(allTotal);

    await page.getByRole('button', { name: 'Sonraki sayfa' }).click();
    await expect(page).toHaveURL(/page=2/);

    const download = page.waitForEvent('download');
    await (await dataMenuItem(page, 'CSV indir')).click();
    expect((await download).suggestedFilename()).toMatch(/^deciship-invoice-lines-\d{4}-\d{2}-\d{2}\.csv$/);

    await page.locator('tbody .hub-row-main').first().click();
    await expect(page).toHaveURL(/\/deciship\/invoices\//);
    await expect(page.getByTestId('deciship-stub')).toBeVisible();
  });

  test('deneme ifadesi hiçbir yerde yok; DeciShip Erken erişim görünür', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/billing');
    await expect(page.getByText('Erken erişim')).toBeVisible();
    const body = (await page.locator('body').innerText()).toLocaleLowerCase('tr-TR');
    expect(body).not.toContain('deneme');
    expect(body).not.toContain('trial');
  });
});

/** Deneme (shell.css "SABİT ÜST SATIR", "A · BÖLMELİ SEKMELER"): geniş ekranda üst satır kaydırınca sabit, menü simgeli oluk. */
test.describe('sabit üst satır', () => {
  test('1440: 800 px kaydırınca üst satır ekranın üstünde, etkin sekme görünür, firma menüsü içeriğin önünde; bant boyu aynı', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();
    const band = page.locator('.sod-band');
    const top = page.locator('.sod-top');
    const bandBefore = (await band.boundingBox())!;
    const topBefore = (await top.boundingBox())!;
    expect(topBefore.height).toBe(72);
    // ⊞ logo kilidinin hemen sağında, menüden önce; sağ kümede firma ve avatar.
    const appsBox = (await page.getByRole('button', { name: 'Uygulamalar' }).boundingBox())!;
    const brandBox = (await page.locator('.sod-brand').boundingBox())!;
    const navBox = (await hubNav(page).boundingBox())!;
    expect(appsBox.x).toBeGreaterThanOrEqual(brandBox.x + brandBox.width);
    expect(appsBox.x + appsBox.width).toBeLessThan(navBox.x);
    await expect(page.locator('.sod-top-r .sod-apps')).toHaveCount(0);
    // Seçili sekme dolu zeminle ayrılır (yalnız renkle değil).
    const current = hubNav(page).getByRole('link', { name: 'Genel Bakış' });
    await expect(current).toHaveAttribute('aria-current', 'page');
    expect(await current.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
    expect(((await current.boundingBox())!).height).toBeGreaterThanOrEqual(36);

    await page.evaluate(() => window.scrollTo(0, 800));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(800);
    const stuck = (await top.boundingBox())!;
    expect(stuck.y).toBe(0);
    expect(stuck.height).toBe(72);
    await expect(top).toBeInViewport();
    await expect(current).toBeInViewport();
    // Satır akıştan çıkınca bant aynı boyda kalır (yer tutucu: `.sod-wrap` üst boşluğu).
    expect(Math.round((await band.boundingBox())!.height)).toBe(Math.round(bandBefore.height));
    // Sabit satırın arkasında içerik görünmez: satırın ortasındaki nokta satıra ait.
    expect(await page.evaluate(() => !!document.elementFromPoint(720, 4)?.closest('.sod-top'))).toBe(true);

    const firm = page.getByRole('button', { name: /^Firma/ });
    const firmBox = (await firm.boundingBox())!;
    await firm.click();
    const menu = page.getByRole('menu', { name: 'Firma' });
    await expect(menu).toBeVisible();
    await expect(menu).toBeInViewport();
    const box = (await menu.boundingBox())!;
    // sabit satırdaki düğmenin altından açılır
    expect(box.y).toBeGreaterThan(firmBox.y + firmBox.height);
    expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.sod-pop'), [box.x + box.width / 2, box.y + box.height / 2])).toBe(true);
    await page.keyboard.press('Escape');

    // Yazdırmada sabit değil (sayfaları kapatmaz).
    await page.emulateMedia({ media: 'print' });
    expect(await top.evaluate((el) => getComputedStyle(el).position)).not.toBe('fixed');
    await page.emulateMedia({ media: 'screen' });
    // Başa dönünce görünüm eskisi: satır yerinde.
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(async () => (await top.boundingBox())!.y).toBe(topBefore.y);
    expect(await top.evaluate((el) => getComputedStyle(el).position)).toBe('relative');
  });

  test('390: telefonda üst satır sekmelerle birlikte sabit; altta uygulama çubuğu', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await reset(page);
    await login(page, USERS.owner);
    await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 800));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const top = page.locator('.sod-top');
    expect(await top.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
    expect(Math.round((await top.boundingBox())!.y)).toBe(0);
    // Sekmeler (Genel Bakış, Analiz…) sabit kısmın içinde, görünür.
    await expect(hubNav(page).getByRole('link', { name: 'Genel Bakış' })).toBeInViewport();
    // Alt çubuk: Merkez etkin, DeciShip bağlantı.
    const dock = page.locator('.sod-dock');
    await expect(dock).toBeInViewport();
    await expect(dock.locator('[aria-current="page"]')).toContainText('Merkez');
    await expect(dock.getByRole('link', { name: /DeciShip/ })).toBeVisible();
  });

  test('390: Hesabım da Merkez kabuğunda: kişi adı bantta, üst satır sabit, altta uygulama çubuğu; site çerçevesi yok', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/profile');
    await expect(page.locator('.sod-band').getByRole('heading', { name: 'Selin Aydın', level: 1 })).toBeVisible();
    await expect(page).toHaveTitle('Profil · Merkez');
    // Baş harf dairesi telefonda gizli; ayar menüsü içeriğin üstünde yatay satır.
    await expect(page.locator('.phead-av')).toBeHidden();
    await expect(page.getByRole('navigation', { name: 'Hesabım' }).getByRole('link')).toHaveCount(3);
    // Eski kopya çerçeve (sarı baş harf, TR|EN, kendi menüsü, altbilgi, "Merkez'e dön") yok.
    await expect(page.locator('.acc-top, .acc-foot, .acc-menu')).toHaveCount(0);
    await expect(page.getByRole('link', { name: "Merkez'e dön" })).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, 800));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const top = page.locator('.sod-top');
    expect(await top.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
    expect(Math.round((await top.boundingBox())!.y)).toBe(0);
    await expect(page.getByRole('button', { name: /^Kullanıcı menüsü/ })).toBeInViewport();
    const dock = page.locator('.sod-dock');
    await expect(dock).toBeInViewport();
    await expect(dock.locator('[aria-current="page"]')).toContainText('Merkez');
    // Çıkış kabuğun kullanıcı menüsünde.
    await page.getByRole('button', { name: /^Kullanıcı menüsü/ }).click();
    await page.getByRole('menuitem', { name: 'Çıkış yap' }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('dar ekran', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('menü bantta üçüncü satır, yatay kayar, etkin öğe görünür; yatay taşma yok', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    // D09 telefon: çekmece yok. Menü ayrı satırda; ⊞ gizli. Logo kilidi iki satır (Merkez / SellerOnData) kalır.
    await expect(page.locator('.sod-brand-n')).toHaveText('Merkez');
    await expect(page.locator('.sod-brand-sub')).toBeVisible();
    await expect(page.locator('.sod-apps')).toBeHidden();
    const nav = hubNav(page);
    const top = (await page.locator('.sod-brand').boundingBox())!;
    const navBox = (await nav.boundingBox())!;
    expect(navBox.y).toBeGreaterThan(top.y + top.height);
    await expect(nav.getByRole('link', { name: 'Ekip ve yetkiler' })).toBeAttached();
    expect(await nav.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await page.goto('/activity');
    const active = (await nav.locator('a[aria-current="page"]').boundingBox())!;
    expect(active.x).toBeGreaterThanOrEqual(0);
    expect(active.x + active.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: 'screenshots/mobile-band-390.png' });
    for (const url of ['/home', '/analytics/deciship', '/data/deciship/invoice-lines', '/activity', '/account/team', '/account/profile', '/account/security', '/account/firms']) {
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, url).toBeLessThanOrEqual(0);
    }
  });
});

test.describe('gerçek uç sözleşmesi', () => {
  test('KPI ve bölüm bağlantısı /data süzgecini açılışta uygular; süzgeç adreste, etkin süzgeç görünür', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.locator('.hub-figure', { hasText: 'Karar bekleyen fark' }).locator('a').click();
    await expect(page).toHaveURL(/\/data\/deciship\/invoice-lines\?.*filter\.status=DIFF.*filter\.decision=OPEN.*filter\.from=/);
    await expect(page.getByLabel('Durum', { exact: true })).toHaveValue('DIFF');
    await expect(page.getByLabel('Karar', { exact: true })).toHaveValue('OPEN');
    // Dönem süzgeci de açık gelir
    await expect(page.locator('input[type=date]').first()).not.toHaveValue('');
    const count = Number((await page.locator('.hub-total').innerText()).replace(/\D/g, ''));
    await page.goBack();
    await expect(page.locator('.hub-figure', { hasText: 'Karar bekleyen fark' }).locator('.hub-figure-value')).toHaveText(new Intl.NumberFormat('tr-TR').format(count));
  });

  test('fotoğrafsız ölçüm bekleyeni kendi süzgeciyle açılır; yöntem süzgeci enum değerli', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/data/deciship/measurements?filter.photos=none');
    await expect(page.getByLabel('Fotoğraf', { exact: false }).first()).toHaveValue('none');
    await page.goto('/data/deciship/measurements?filter.method=LIDAR');
    await expect(page.getByLabel('Yöntem', { exact: true })).toHaveValue('LIDAR');
    await expect(page.locator('tbody tr').first()).toContainText('LiDAR');
    // Ölçen sütunu sıralanmaz
    await expect(page.getByRole('button', { name: 'Ölçen' })).toHaveCount(0);
  });

  test('100.000 satır aşımı anlaşılır hata gösterir', async ({ page }) => {
    await reset(page, { fail: ['deciship.export.toolarge'] });
    await login(page, USERS.owner);
    await page.goto('/data/deciship/invoices');
    await (await dataMenuItem(page, 'CSV indir')).click();
    await expect(page.locator('.toast')).toContainText('çok fazla satır');
    await expect(page.locator('.toast')).toContainText('100000');
  });

  test('karşılığı olmayan iade sayıları ekranda yok', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    for (const url of ['/home', '/analytics/deciship', '/data/deciship/invoice-lines', '/activity']) {
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      const body = await page.locator('body').innerText();
      // "Geri alınan" artık alacak dekontuna dayanır (itiraz takibi); eski uydurma iade adları yine yok.
      expect(body, url).not.toMatch(/geri alınmayan|İtirazla|İtiraz edildi|İtiraz sonuçları|iade edil/i);
    }
  });

  test('itiraz: Genel Bakış ve Analiz geri alınanı ve itirazda bekleyeni gösterir, DeciShip İtirazlar sayfasına gider', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/home?range=90d');
    const recovered = page.locator('.hub-ledger-row', { hasText: 'Geri alınan' });
    const pending = page.locator('.hub-ledger-row', { hasText: 'İtirazda bekleyen' });
    await expect(recovered).toBeVisible();
    await expect(pending).toBeVisible();
    await expect(recovered).toHaveAttribute('href', '/deciship/disputes');
    await expect(pending).toHaveAttribute('href', '/deciship/disputes?status=SENT');
    await page.goto('/analytics/deciship');
    await expect(page.locator('.hub-section').first()).toContainText('Geri alınan');
    await expect(page.locator('.hub-section').first()).toContainText('İtirazda bekleyen');
    await page.goto('/data/deciship/invoices');
    await expect(page.locator('th', { hasText: /^İtiraz$/ })).toBeVisible();
    await expect(page.locator('th', { hasText: /^Gönderim tarihi$/ })).toBeVisible();
  });

  test('muhasebe: dışa aktarma açık, ayarlar bölümü yok; ölçüm rolü platform uçlarına gitmez', async ({ page }) => {
    await reset(page);
    await login(page, USERS.accounting);
    await page.goto('/data/deciship/invoices');
    await expect(await dataMenuItem(page, 'CSV indir')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Denetim kayıtları' })).toBeVisible();
  });
});

test.describe('firma açma ve ayrılma', () => {
  test('firması olmayan kişi tam ekran firma oluşturur, yeni firma etkin olur', async ({ page }) => {
    await reset(page);
    await login(page, USERS.noOrg);
    await expect(page.getByRole('heading', { name: 'Firma oluşturun' })).toBeVisible();
    await expect(page.locator('.sod-band')).toHaveCount(0);
    await page.fill('#new-org', 'Örnek Yeni Atölye');
    await page.getByRole('button', { name: 'Firmayı aç' }).click();
    await expect(page.locator('.sod-firm-n')).toHaveText('Örnek Yeni Atölye');
    await expect(page).toHaveURL(/\/home/);
  });

  test(`firması olmayan kişi Hesabım'ı Merkez kabuğunda açar; firma seçici "Firma yok"; eski Üyelikler adresi Firmalarım'a gider`, async ({ page }) => {
    await reset(page);
    await login(page, USERS.noOrg);
    await expect(page.getByRole('heading', { name: 'Firma oluşturun' })).toBeVisible();
    await page.getByRole('link', { name: 'Hesabım' }).click();
    await expect(page).toHaveURL(/\/account\/profile$/);
    await expect(page.locator('.sod-band').getByRole('heading', { name: 'Firmasız Kişi', level: 1 })).toBeVisible();
    await expect(page).toHaveTitle('Profil · Merkez');
    await expect(page.getByRole('button', { name: 'Firma: Firma yok' })).toBeVisible();
    await expect(page.locator('.acc-row').filter({ has: page.locator('.acc-lab', { hasText: /^Ad soyad$/ }) })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Firma oluşturun' })).toHaveCount(0);
    await page.goto('/account/memberships');
    await expect(page).toHaveURL(/\/account\/firms$/);
    await expect(page.locator('.sod-band').getByRole('heading', { name: 'Firmasız Kişi', level: 1 })).toBeVisible();
    await expect(page).toHaveTitle('Firmalarım · Merkez');
    await expect(page.getByText('Henüz bir firmada değilsiniz.')).toBeVisible();
    await page.goto('/account/profile#firmalar');
    await expect(page).toHaveURL(/\/account\/firms$/);
    await page.goto('/account/security');
    await page.getByRole('button', { name: 'Değiştir', exact: true }).click();
    await expect(page.locator('#pw-n')).toBeVisible();
    await expect(page).toHaveTitle('Güvenlik · Merkez');
  });

  test('kayıt kapalıysa firma oluşturma yerine anlaşılır mesaj', async ({ page }) => {
    await reset(page);
    await page.evaluate(() => localStorage.setItem('sod_mock_register_closed', '1'));
    await login(page, USERS.noOrg);
    await expect(page.getByRole('heading', { name: 'Yeni firma açılamıyor' })).toBeVisible();
    await expect(page.locator('#new-org')).toHaveCount(0);
  });

  // Kapalı deneme (SIGNUP_MODE=invite, kullanıcı kararı 2026-11-12).
  test('kayıt yalnız davetle: davetsiz gelen açıklama ve destek bağlantısı görür, davetli form doldurur', async ({ page }) => {
    await reset(page);
    await page.evaluate(() => localStorage.setItem('sod_mock_signup_invite', '1'));
    await page.goto('/register');
    await expect(page.getByText('Şu an yalnız davetle hesap açılıyor')).toBeVisible();
    await expect(page.getByRole('link', { name: 'destek@sellerondata.com' })).toHaveAttribute('href', /^mailto:destek@sellerondata\.com\?subject=/);
    await expect(page.locator('#org')).toHaveCount(0);
    await page.screenshot({ path: 'screenshots/register-invite-only-1440.png' });

    await page.goto('/register?invite=deneme-jetonu');
    await page.fill('#org', 'Davetli Firma');
    await page.fill('#name', 'Davetli Kişi');
    await page.fill('#email', 'davetli@ornek.test');
    await page.fill('#pw', PASSWORD);
    const sent = page.waitForRequest((r) => r.url().includes('/auth/register'));
    await page.getByRole('button', { name: 'Hesap aç' }).click();
    expect((await sent).postDataJSON().signupInvite).toBe('deneme-jetonu');
    await expect(page).toHaveURL(/\/home/);
  });

  test('kayıt yalnız davetle: geçersiz davet anlaşılır hata, açık kipte davet gönderilmez', async ({ page }) => {
    await reset(page);
    await page.evaluate(() => localStorage.setItem('sod_mock_signup_invite', '1'));
    await page.goto('/register?invite=gecersiz');
    await page.fill('#org', 'Davetli Firma');
    await page.fill('#name', 'Davetli Kişi');
    await page.fill('#email', 'gecersiz@ornek.test');
    await page.fill('#pw', PASSWORD);
    await page.getByRole('button', { name: 'Hesap aç' }).click();
    await expect(page.getByText('Davet bağlantısı geçersiz')).toBeVisible();

    await reset(page);
    await page.goto('/register');
    await expect(page.locator('#org')).toBeVisible();
    await page.fill('#org', 'Açık Firma');
    await page.fill('#name', 'Açık Kişi');
    await page.fill('#email', 'acik-kayit@ornek.test');
    await page.fill('#pw', PASSWORD);
    const sent = page.waitForRequest((r) => r.url().includes('/auth/register'));
    await page.getByRole('button', { name: 'Hesap aç' }).click();
    expect((await sent).postDataJSON()).not.toHaveProperty('signupInvite');
  });

  test('kayıt yalnız davetle: giriş yapmış kişide "Yeni firma" kapalı', async ({ page }) => {
    await reset(page);
    await page.evaluate(() => localStorage.setItem('sod_mock_signup_invite', '1'));
    await login(page, USERS.noOrg);
    await expect(page.getByRole('heading', { name: 'Yeni firma açılamıyor' })).toBeVisible();
    await expect(page.locator('#new-org')).toHaveCount(0);
  });

  test('kayıt kapalıyken kayıt sayfası form göstermez', async ({ page }) => {
    await reset(page);
    await page.evaluate(() => localStorage.setItem('sod_mock_register_closed', '1'));
    await page.goto('/register');
    await expect(page.getByText('Yeni kayıtlar şu anda kapalı')).toBeVisible();
    await expect(page.locator('#org')).toHaveCount(0);
  });

  test('firma seçiciden yeni firma', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.getByRole('button', { name: /^Firma:/ }).click();
    await page.getByRole('menuitem', { name: 'Yeni firma' }).click();
    await expect(page).toHaveURL(/\/account\/company\/new/);
    await page.fill('#new-org', 'İkinci Örnek Firma');
    await page.getByRole('button', { name: 'Firmayı aç' }).click();
    await expect(page.locator('.sod-firm-n')).toHaveText('İkinci Örnek Firma');
    await page.getByRole('button', { name: /^Firma:/ }).click();
    await expect(page.getByRole('menuitemradio', { name: /^Örnek Firma/ })).toBeVisible();
  });

  test('sahip ayrılamaz: nedeni ve devir yolu yazılır', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/firms');
    await expect(page.getByText('Önce sahipliği başka birine devredin')).toBeVisible();
    // Sahibi olduğu etkin firmada ayrılma yok (öbür firmasında yönetici, orada var).
    await expect(page.locator('.acc-row').filter({ hasText: 'Örnek Firma' }).getByRole('button', { name: 'Firmadan ayrıl' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Sahipliği devretmeye git' }).click();
    await expect(page).toHaveURL(/\/account\/company/);
  });

  test('e-postalı kişi parolasız ayrılır; firma kalmadıysa firma oluştur ekranı', async ({ page }) => {
    await reset(page);
    await login(page, USERS.accounting);
    await page.goto('/account/firms');
    await expect(page.getByText('Hesabınızda e-posta yok')).toHaveCount(0);
    await page.getByRole('button', { name: 'Firmadan ayrıl' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('#leave-pw')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Firmadan ayrıl' }).click();
    await expect(page.getByRole('heading', { name: 'Firma oluşturun' })).toBeVisible();
  });

  test('e-postasız kişi uyarılır, parola ister; yanlış parola oturumu düşürmez', async ({ page }) => {
    await reset(page);
    await login(page, USERS.measure);
    await page.goto('/account/firms');
    await page.getByRole('button', { name: 'Firmadan ayrıl' }).click();
    const dialog = page.getByRole('dialog');
    // Uyarı onay penceresinde (Firmalarım ayrı ayrılma bölümü göstermiyor).
    await expect(dialog.getByText('Hesabınızda e-posta yok')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Firmadan ayrıl' })).toBeDisabled();
    await dialog.locator('#leave-pw').fill('yanlis-parola');
    await dialog.getByRole('button', { name: 'Firmadan ayrıl' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Giriş bilgileri hatalı');
    await expect(page).toHaveURL(/\/account\/firms/);
    await dialog.locator('#leave-pw').fill('Test12345!');
    await dialog.getByRole('button', { name: 'Firmadan ayrıl' }).click();
    await expect(page.getByRole('heading', { name: 'Firma oluşturun' })).toBeVisible();
  });

  test('birden çok firması olan yönetici ayrılınca sonraki firmaya geçer', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.getByRole('button', { name: /^Firma:/ }).click();
    await page.getByRole('menuitemradio', { name: /Örnek İhracat/ }).click();
    await expect(page.locator('.sod-firm-n')).toHaveText('Örnek İhracat Ltd.');
    await page.goto('/account/firms');
    await page.getByRole('button', { name: 'Firmadan ayrıl' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Firmadan ayrıl' }).click();
    await expect(page.locator('.sod-firm-n')).toHaveText('Örnek Firma');
  });
});

const loginWith = async (page: Page, identifier: string) => {
  await page.fill('#id', identifier);
  await page.fill('#pw', PASSWORD);
  await page.click('button[type=submit]');
};

test.describe('giriş sonrası dönüş', () => {
  test('Merkez dışı next adresine tam sayfa gidilir, Merkez 404 göstermez', async ({ page }) => {
    await reset(page);
    await page.goto('/login?next=%2Fdeciship%2Fsettings');
    await page.locator('#id').waitFor();
    await page.evaluate(() => ((window as unknown as { __same: boolean }).__same = true));
    await loginWith(page, USERS.owner);
    await expect(page).toHaveURL(/\/deciship\/settings$/);
    await expect(page.locator('.sod-brand-n')).toHaveText('DeciShip');
    expect(await page.evaluate(() => (window as unknown as { __same?: boolean }).__same)).toBeUndefined();
  });

  test('oturum açıkken de Merkez dışı next tam sayfa gider', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/login?next=%2Fdeciship%2Fsettings');
    await expect(page).toHaveURL(/\/deciship\/settings$/);
  });

  test('Merkez yolu router ile gider', async ({ page }) => {
    await reset(page);
    await page.goto('/login?next=%2Faccount%2Fteam%3Fa%3D1');
    await page.locator('#id').waitFor();
    await page.evaluate(() => ((window as unknown as { __same: boolean }).__same = true));
    await loginWith(page, USERS.owner);
    await expect(page).toHaveURL(/\/account\/team\?a=1$/);
    expect(await page.evaluate(() => (window as unknown as { __same?: boolean }).__same)).toBe(true);
  });

  for (const next of ['//evil.test/x', '/\\evil.test', '/..//evil.test', '/.//evil.test', 'https://evil.test', 'javascript:alert(1)', '/login', '/%09/evil.test/']) {
    test(`açık yönlendirme yok: ${next}`, async ({ page }) => {
      await reset(page);
      await page.goto(`/login?next=${encodeURIComponent(next)}`);
      await page.locator('#id').waitFor();
      await loginWith(page, USERS.owner);
      await page.waitForURL((u) => u.pathname !== '/login');
      const url = new URL(page.url());
      expect(url.origin).toBe(new URL(page.context().pages()[0]!.url()).origin);
      expect(url.hostname).toBe('localhost');
    });
  }
});

test.describe('kabuk', () => {
  test('sayfa adı yalnız h1de; bantta ürün, sekmede sayfa adı', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await expect(page.locator('.sod-brand-n')).toHaveText('Merkez');
    await expect(page.locator('.sod-band-crumb')).toHaveCount(0);
    // Kırıntı yokken de sağ küme (⊞, firma, avatar) içerik sütununun sağ kenarında: 1440'ta 1240 sütun, x=132..1308.
    const end = await page.locator('.sod-av').boundingBox();
    expect(end!.x + end!.width).toBeGreaterThan(1308 - 2);
    const firm = await page.locator('.sod-firm').boundingBox();
    expect(firm!.x).toBeLessThan(end!.x);
    await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();
    await expect(page).toHaveTitle(/Genel Bakış/);
  });

  test('telefonda kapalı menülerin öğeleri odak sırasına girmez; menü bağlantıları girer', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await reset(page);
    await login(page, USERS.owner);
    await expect(page.locator('.sod-pop')).toHaveCount(0);
    await expect(hubNav(page).getByRole('link', { name: 'Etkinlik' })).toBeAttached();
    // Kapalı açılır menülerin öğeleri DOM'da yok; bant menüsü bağlantılarının hepsi odak alır.
    const reached = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll<HTMLElement>('.sod-nav a'));
      return [links.length, links.filter((el) => { el.focus(); return document.activeElement === el; }).length];
    });
    expect(reached[0]).toBeGreaterThan(3);
    expect(reached[1]).toBe(reached[0]);
    await page.getByRole('button', { name: /^Kullanıcı menüsü/ }).click();
    const menu = page.locator('.sod-pop');
    await expect(menu).toBeVisible();
    // Telefonda ⊞ gizli; uygulamalar alttaki çubukta, avatar menüsünde liste yok.
    await expect(menu.getByRole('menuitem', { name: /DeciShip/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Kullanıcı menüsü/ })).toBeFocused();
  });
});

test.describe('oturum dayanıklılığı', () => {
  const expire = (page: Page, extra: Record<string, string>) =>
    page.evaluate((e) => {
      localStorage.removeItem('sod_refreshed_at');
      localStorage.setItem('sod_mock_expire', 'TOKEN_EXPIRED');
      for (const [k, v] of Object.entries(e)) localStorage.setItem(k, v);
    }, extra);
  const companyWithText = async (page: Page, text: string) => {
    await page.goto('/account/company');
    await page.fill('#org-name', text);
  };

  test('yenileme ucu 5xx: çıkış yok, uyarı var, yazı duruyor, yeniden dene çalışır', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await companyWithText(page, 'Yazılı Ad');
    await expire(page, { sod_mock_refresh_down: '1' });
    await page.getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.locator('.sod-status')).toContainText('Bağlantı yok');
    await expect(page.locator('form .notif.err')).toContainText('Sunucuya ulaşılamadı');
    await expect(page).toHaveURL(/\/account\/company$/);
    await expect(page.locator('#org-name')).toHaveValue('Yazılı Ad');
    await page.evaluate(() => localStorage.removeItem('sod_mock_refresh_down'));
    await page.locator('.sod-status').getByRole('button', { name: 'Tekrar dene' }).click();
    await expect(page.locator('.sod-status')).toHaveCount(0);
    await expect(page.locator('#org-name')).toHaveValue('Yazılı Ad');
    await page.getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.locator('.sod-firm-n')).toHaveText('Yazılı Ad');
  });

  test('ağ hatası: çıkış yok, yazı duruyor', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await companyWithText(page, 'Ağsız Ad');
    await page.evaluate(() => localStorage.setItem('sod_mock_offline', '1'));
    await page.getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.locator('.sod-status')).toContainText('Bağlantı yok');
    await expect(page).toHaveURL(/\/account\/company$/);
    await expect(page.locator('#org-name')).toHaveValue('Ağsız Ad');
    await page.evaluate(() => localStorage.removeItem('sod_mock_offline'));
    await page.locator('.sod-status').getByRole('button', { name: 'Tekrar dene' }).click();
    await expect(page.locator('.sod-status')).toHaveCount(0);
  });

  test('yenileme ucu kesin 401: girişe gider', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/company');
    await page.locator('#org-name').waitFor();
    await expire(page, { sod_mock_no_refresh: '1' });
    await page.goto('/account/team');
    await expect(page).toHaveURL(/\/login\?next=%2Faccount%2Fteam$/);
  });

  test('Hesap kesik (ağ geçidi 503): uyarı var, firma kutusu takılmaz, DeciShip verisi çalışır, dönünce kalkar', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await expect(page.locator('.hub-hero').first()).toBeVisible();
    await page.evaluate(() => localStorage.setItem('sod_mock_account_down', '1'));
    await page.reload();
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();
    await expect(page.locator('.sod-status')).toContainText('Bağlantı yok.');
    await expect(page.locator('.hub-hero').first()).toBeVisible();
    await expect(page.locator('.sod-firm-n')).toHaveText('Örnek Firma');
    await expect(page.locator('.hub-team-sum .skel')).toHaveCount(0);
    await expect(page.locator('.hub-team-sum b').first()).toHaveText('—');
    // DeciShip'in başarılı yanıtı uyarıyı söndürmez
    await page.getByRole('button', { name: /^Tarih aralığı/ }).click();
    await page.getByRole('button', { name: 'Son 7 gün', exact: true }).click();
    await expect(page.locator('.sod-status')).toContainText('Bağlantı yok.');

    await page.evaluate(() => localStorage.removeItem('sod_mock_account_down'));
    // Beklemedeki yeniden deneme de uyarıyı kaldırabilir: düğme o sırada gitmiş olabilir.
    await page.locator('.sod-status').getByRole('button', { name: 'Tekrar dene' }).click({ timeout: 3000 }).catch(() => undefined);
    await expect(page.locator('.sod-status')).toHaveCount(0);
    await expect(page.locator('.hub-team-sum .skel')).toHaveCount(0);
    await expect(page.locator('.hub-team-sum b').first()).toContainText('kişi');
  });

  test('Hesap kesik ve önbellek yok: iskelet kalmaz, uyarı ve tekrar dene', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.evaluate(() => {
      sessionStorage.clear();
      localStorage.setItem('sod_mock_account_down', '1');
    });
    await page.goto('/home');
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.locator('.sod-status')).toContainText('Bağlantı yok.');
    await expect(page.locator('.sod-main .skel')).toHaveCount(0);
    await page.evaluate(() => localStorage.removeItem('sod_mock_account_down'));
    await page.locator('.sod-status').getByRole('button', { name: 'Tekrar dene' }).click();
    await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();
  });

  test('Hesap kesik: yeniden yüklenen sayfada ürün yazması son bilinen firmayı taşır', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await expect(page.locator('.hub-hero').first()).toBeVisible();
    await page.evaluate(() => localStorage.setItem('sod_mock_account_down', '1'));
    await page.reload();
    await expect(page.locator('.sod-status')).toContainText('Bağlantı yok.');
    const req = page.waitForRequest((r) => r.url().includes('/api/account/org/members') || r.url().includes('/api/deciship/'));
    await page.getByRole('button', { name: /^Tarih aralığı/ }).click();
    await page.getByRole('button', { name: 'Son 30 gün', exact: true }).click();
    expect((await req).headers()['x-sod-org']).toBe('o1');
  });

  test('ilk yüklemede Hesap 5xx: girişe atmaz, yeniden dene ile açılır', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.evaluate(() => {
      sessionStorage.clear();
      localStorage.setItem('sod_mock_fail', JSON.stringify(['me']));
    });
    await page.goto('/home');
    await expect(page.getByRole('alert').first()).toBeVisible();
    await expect(page).toHaveURL(/\/home$/);
    await page.evaluate(() => localStorage.removeItem('sod_mock_fail'));
    await page.getByRole('button', { name: 'Tekrar dene' }).click();
    await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();
  });
});

test.describe('sekmeler arası firma', () => {
  test('çerezli istek X-SOD-Org taşır; oturum uçları taşımaz', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    const sent = new Map<string, string | undefined>();
    page.on('request', (r) => {
      if (r.url().includes('/api/')) sent.set(new URL(r.url()).pathname, r.headers()['x-sod-org']);
    });
    await page.goto('/home');
    await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();
    await page.goto('/account/company');
    await page.fill('#org-name', 'Başlıklı Ad');
    await page.getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.locator('.sod-firm-n')).toHaveText('Başlıklı Ad');
    expect(sent.get('/api/account/org')).toBe('o1');
    await page.getByRole('button', { name: /Kullanıcı menüsü/ }).click();
    await page.getByRole('menuitem', { name: 'Çıkış yap' }).click();
    await expect(page).toHaveURL(/\/login/);
    expect(sent.has('/api/account/auth/logout')).toBe(true);
    expect(sent.get('/api/account/auth/logout')).toBeUndefined();
  });

  test('başka sekmede firma değişince eski sekme duyar; yazı korunur, kayıt gitmez, devam edilebilir', async ({ page, context }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/company');
    await page.fill('#org-name', 'Eski Sekme Yazısı');

    const other = await context.newPage();
    await other.goto('/home');
    await expect(other.locator('.sod-firm-n')).toHaveText('Örnek Firma');
    await other.getByRole('button', { name: /^Firma:/ }).click();
    await other.getByRole('menuitemradio', { name: /Örnek İhracat/ }).click();
    await expect(other.locator('.sod-firm-n')).toHaveText('Örnek İhracat Ltd.');

    // Eski sekme kayıt denemeden haberdar
    const bar = page.locator('.sod-status');
    await expect(bar).toContainText('Örnek İhracat Ltd.');
    await expect(page.locator('#org-name')).toHaveValue('Eski Sekme Yazısı');

    // Okuma da gitmez: başka firmanın verisi bu sekmede o firma adıyla görünmez
    let reads = 0;
    const countReads = (r: { method: () => string; url: () => string }) => {
      if (r.method() === 'GET' && r.url().includes('/api/account/org/members')) reads += 1;
    };
    page.on('request', countReads);
    await page.evaluate(async () => {
      history.pushState(null, '', '/account/team');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByRole('alert').filter({ hasText: 'başka bir firmayı gösteriyor' }).first()).toBeVisible();
    expect(reads).toBe(0);
    page.off('request', countReads);
    await page.goBack();
    await page.fill('#org-name', 'Eski Sekme Yazısı');

    // Kayıt gitmez, sessizce tekrarlanmaz
    let tries = 0;
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && r.url().endsWith('/api/account/org')) tries += 1;
    });
    await page.getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.locator('form .notif.err')).toContainText('başka bir firmayı gösteriyor');
    expect(tries).toBe(1);
    await expect(page.locator('#org-name')).toHaveValue('Eski Sekme Yazısı');

    // Yenileme, yazı varsa önce sorar
    await bar.getByRole('button', { name: 'Sayfayı yenile' }).click();
    await expect(bar).toContainText('yazdıklarınız silinir');
    await expect(page.locator('#org-name')).toHaveValue('Eski Sekme Yazısı');

    // Bu sekmenin firmasıyla devam: yazı yerinde, kayıt gider, öbür sekme uyarılır
    await bar.getByRole('button', { name: 'Örnek Firma ile devam et' }).click();
    await expect(bar).toHaveCount(0);
    await page.getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.locator('.sod-firm-n')).toHaveText('Eski Sekme Yazısı');
    await expect(other.locator('.sod-status')).toContainText('Firma değişti');

    // Öbür sekme yenilenince güncel firmayı görür
    await other.locator('.sod-status').getByRole('button', { name: 'Sayfayı yenile' }).click();
    await expect(other.locator('.sod-firm-n')).toHaveText('Eski Sekme Yazısı');
    await expect(other.locator('.sod-status')).toHaveCount(0);
  });
});

test.describe('hesap güvenliği', () => {
  test('telefon salt okunur, not yazılı; e-posta değişimi şifre ister', async ({ page }) => {
    await reset(page);
    await login(page, USERS.measure);
    await page.goto('/account/profile');
    const phone = page.locator('.acc-row').filter({ has: page.locator('.acc-lab', { hasText: /^Telefon$/ }) });
    await expect(phone).toContainText(/532/);
    // Telefon düzenlenmez: e-postasız kişide kaldırma da yok.
    await expect(phone.getByRole('button')).toHaveCount(0);
    await expect(page.getByText('Telefon davet koduyla bağlanır.')).toBeVisible();
    await expect(page.locator('#p-pass')).toHaveCount(0);
    await page.getByRole('button', { name: 'Ekle' }).click();
    await page.fill('#p-email', 'mehmet@ornek.test');
    await expect(page.locator('#p-pass')).toBeVisible();
  });

  test("passwordRecovery 'none' uyarılır; e-posta yazılınca kalkar", async ({ page }) => {
    await reset(page);
    await login(page, USERS.noRecovery);
    await page.goto('/account/profile');
    await expect(page.getByText('Şifrenizi unutursanız kurtarma yolu yok')).toBeVisible();
    await page.getByRole('button', { name: 'Ekle' }).click();
    await page.fill('#p-email', 'murat@ornek.test');
    await expect(page.getByText('Şifrenizi unutursanız kurtarma yolu yok')).toHaveCount(0);
  });

  test("tek firmalı e-postasız kişide ('org_admin') bu uyarı çıkmaz", async ({ page }) => {
    await reset(page);
    await login(page, USERS.measure);
    await page.goto('/account/profile');
    await expect(page.getByRole('heading', { name: 'Kişisel bilgiler' })).toBeVisible();
    await expect(page.getByText('Şifrenizi unutursanız kurtarma yolu yok')).toHaveCount(0);
  });

  test('e-postasız kişiye devir: seçenek kapalı, sunucu reddi anlaşılır', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/company');
    await page.getByRole('button', { name: 'Firma için diğer işlemler' }).click();
    await page.getByRole('menuitem', { name: 'Sahipliği devret' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('option', { name: /Mehmet Demir \(e-posta yok\)/ })).toBeDisabled();
    await expect(dialog.getByText('Sahiplik yalnız e-postasını doğrulamış kişiye devredilir.')).toBeVisible();
    // Liste eskiyse sunucu reddeder
    await page.evaluate(() => localStorage.setItem('sod_mock_fail', JSON.stringify(['transfer.email'])));
    await dialog.locator('#tr-to').selectOption({ label: 'Elif Şahin' });
    await dialog.locator('#tr-pw').fill(PASSWORD);
    await dialog.getByRole('button', { name: /Devret|Onayla/ }).click();
    await expect(dialog.getByRole('alert')).toContainText('Kişiden önce e-posta eklemesini isteyin');
  });

  test('e-postasız kişi firma açmadan önce e-posta eklemeye yönlenir', async ({ page }) => {
    await reset(page);
    await login(page, USERS.measure);
    await page.goto('/account/company/new');
    await expect(page.getByText('Firma açmak için önce hesabınıza e-posta ekleyin')).toBeVisible();
    await expect(page.locator('#new-org')).toHaveCount(0);
    await page.getByRole('link', { name: 'E-posta ekle' }).click();
    await expect(page).toHaveURL(/\/account\/profile$/);
  });

  test('telefon yalnız kaldırılabilir: şifre ister, istek yalnız kaldırma gönderir', async ({ page }) => {
    await reset(page);
    await login(page, USERS.measure);
    await page.goto('/account/profile');
    // E-posta yoksa kaldırma yok: tek iletişim yolu
    const phone = page.locator('.acc-row').filter({ has: page.locator('.acc-lab', { hasText: /^Telefon$/ }) });
    await expect(phone.getByRole('button', { name: 'Kaldır' })).toHaveCount(0);
    // Önce e-posta kaydedilir (şifreyle), sonra telefon ayrı adımda kaldırılır.
    await page.getByRole('button', { name: 'Ekle' }).click();
    await page.fill('#p-email', 'mehmet@ornek.test');
    await page.fill('#p-pass', PASSWORD);
    await page.getByRole('button', { name: 'Kaydet' }).click();
    // Yeni adres bekleyene yazılır: doğrulanana kadar iletişim yolu sayılmaz, telefon kaldırılamaz.
    await expect(page.getByText('Doğrulama bekliyor: mehmet@ornek.test')).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Kaldır' })).toHaveCount(0);
    // Doğrulama bağlantısı açılır (e-posta değişikliği onayı şifre istemez).
    await page.goto('/verify-email/degisim');
    await expect(page.getByText('Yeni e-posta adresiniz kaydedildi.')).toBeVisible();
    await page.goto('/account/profile');
    await phone.getByRole('button', { name: 'Kaldır' }).click();
    await page.fill('#p-pass', PASSWORD);
    const patch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith('/api/account/me'));
    await page.getByRole('button', { name: 'Telefonu kaldır' }).click();
    const body = (await patch).postDataJSON();
    expect(body.phone).toBeNull();
    expect(Object.keys(body).sort()).toEqual(['currentPassword', 'phone']);
    await expect(phone).toContainText('Bağlı telefon yok');
    await expect(phone.getByRole('button', { name: 'Kaldır' })).toHaveCount(0);
  });

  test('sahip e-postasını silemez: anlaşılır hata', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    // Telefonu da olan sahip: tek iletişim yolu kuralı değil, sahip kuralı çalışsın
    await page.evaluate(() => {
      const db = JSON.parse(localStorage.getItem('sod_mock_db')!);
      db.persons.find((p: { id: string }) => p.id === 'p1').phone = '+905320000099';
      localStorage.setItem('sod_mock_db', JSON.stringify(db));
    });
    await page.goto('/account/profile');
    await expect(page.locator('.acc-row').filter({ has: page.locator('.acc-lab', { hasText: /^Telefon$/ }) })).toContainText(/532/);
    await page.locator('.acc-row').filter({ has: page.locator('.acc-lab', { hasText: /^E-posta$/ }) }).getByRole('button', { name: 'Düzenle' }).click();
    await page.fill('#p-email', '');
    await page.fill('#p-pass', PASSWORD);
    await page.getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.getByRole('alert')).toContainText('Firma sahibinin e-posta adresi olmalı');
  });

  test('şifre en az PASSWORD_MIN_LENGTH', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/security');
    await page.getByRole('button', { name: 'Değiştir', exact: true }).click();
    await page.fill('#pw-c', PASSWORD);
    await page.fill('#pw-n', '123456789');
    await expect(page.getByText(/en az 10/i).first()).toBeVisible();
  });

  // Ayrı test: açık oturumun üstünde reset, sayfanın kendi girişe yönlendirmesiyle goto'yu yarıştırıyordu.
  test('kayıtta da şifre en az PASSWORD_MIN_LENGTH', async ({ page }) => {
    await reset(page);
    await page.goto('/register');
    await page.fill('#pw', '123456789');
    await expect(page.getByText(/en az 10/i).first()).toBeVisible();
  });

  test('deneme hakkı biten kod: iptal ve yeniden davet, bilgiler hazır', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/team?tab=invites');
    await page.evaluate(() => localStorage.setItem('sod_mock_fail', JSON.stringify(['invite.exhausted'])));
    const row = page.locator('.d9-inv').filter({ hasText: 'Hakan Çelik' });
    await row.getByRole('button', { name: 'Hakan Çelik daveti için işlemler' }).click();
    await page.getByRole('menuitem', { name: 'Yeni kod üret' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Kodun hatalı giriş hakkı bitti');
    await page.evaluate(() => localStorage.removeItem('sod_mock_fail'));
    await dialog.getByRole('button', { name: 'İptal et ve yeniden davet et' }).click();
    await expect(page.locator('#inv-name')).toHaveValue('Hakan Çelik');
    await expect(page.locator('#inv-contact')).toHaveValue(/532/);
    await expect(page.locator('.d9-inv').filter({ hasText: 'Hakan Çelik' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Kod üret', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Bu kod bir daha gösterilmez');
  });

  test('e-posta gitmediyse bağlantıyı kopyalayın uyarısı', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/team');
    await page.evaluate(() => localStorage.setItem('sod_mock_mail_limited', '1'));
    await page.getByRole('button', { name: 'Kişi davet et' }).click();
    await page.getByRole('button', { name: /E-posta/ }).first().click();
    await page.fill('#inv-name', 'Sınırlı Kişi');
    await page.fill('#inv-contact', 'sinirli@ornek.test');
    await page.getByRole('button', { name: 'Davet oluştur' }).click();
    await expect(page.getByRole('dialog')).toContainText('Bağlantıyı kopyalayıp kişiye siz iletin');
  });

  test('oturum açık ve telefonsuz: kod numarayı hesaba bağlar, şifre mevcut şifredir', async ({ page }) => {
    await reset(page);
    await login(page, USERS.admin);
    await page.goto('/join');
    // Oturum açıkken /join kartı çıkar; hesaba bağlamak için ikincil düğme seçilir.
    await page.getByRole('button', { name: /^Kodu .* hesabına bağla$/ }).click();
    await page.fill('#phone', '0532 000 00 11');
    await page.fill('#code', 'K7M2QX9P');
    await page.getByRole('button', { name: 'Devam et' }).click();
    await expect(page.getByText('Bu numara açık olan hesabınıza bağlanır')).toBeVisible();
    await expect(page.getByLabel('Mevcut şifreniz', { exact: false })).toBeVisible();
    await expect(page.locator('#name')).toHaveCount(0);
    await page.fill('#pw', 'yanlis-sifre-1');
    await page.getByRole('button', { name: 'Katıl' }).click();
    await expect(page.getByRole('alert')).toContainText('hatalı');
    await page.fill('#pw', PASSWORD);
    await page.getByRole('button', { name: 'Katıl' }).click();
    await expect(page).toHaveURL(/\/home/);
    await page.goto('/account/profile');
    await expect(page.locator('.acc-row').filter({ has: page.locator('.acc-lab', { hasText: /^Telefon$/ }) })).toContainText(/532/);
  });

  test('e-posta doğrulaması gerekiyorsa kayıt doğrulama ekranına gider, girişte nedeni yazar', async ({ page }) => {
    await reset(page);
    await page.evaluate(() => localStorage.setItem('sod_mock_verify_required', '1'));
    await page.goto('/register');
    await page.fill('#org', 'Doğrulanacak Firma');
    await page.fill('#name', 'Doğrulanacak Kişi');
    await page.fill('#email', 'dogrula@ornek.test');
    await page.fill('#pw', PASSWORD);
    await page.getByRole('button', { name: 'Hesap aç' }).click();
    await expect(page.getByRole('heading', { name: 'E-postanızı doğrulayın' })).toBeVisible();
    await expect(page.getByText('dogrula@ornek.test')).toBeVisible();
    await page.getByRole('link', { name: 'Giriş yap' }).first().click();
    await page.fill('#id', 'dogrula@ornek.test');
    await page.fill('#pw', PASSWORD);
    await page.click('button[type=submit]');
    await expect(page.getByRole('alert')).toContainText('doğrulanmamış');
    await expect(page).toHaveURL(/\/login/);
  });

  test('yaygın şifre anlaşılır reddedilir: kayıt ve şifre değiştirme', async ({ page }) => {
    await reset(page);
    await page.goto('/register');
    await page.fill('#org', 'Şifre Firma');
    await page.fill('#name', 'Şifre Kişi');
    await page.fill('#email', 'sifre@ornek.test');
    await page.fill('#pw', '1234567890');
    await page.getByRole('button', { name: 'Hesap aç' }).click();
    // Hata alana bağlı, formda ikinci kez yazılmaz.
    await expect(page.locator('#pw').locator('xpath=ancestor::*[contains(@class,"fld")][1]')).toContainText('Bu şifre çok yaygın, başka bir şifre seçin');
    await expect(page.locator('.notif.err')).toHaveCount(0);
    await expect(page.locator('#org')).toHaveValue('Şifre Firma');
    await expect(page.locator('#org')).toHaveAttribute('maxlength', '120');

    await login(page, USERS.owner);
    await page.goto('/account/security');
    await page.getByRole('button', { name: 'Değiştir', exact: true }).click();
    await page.fill('#pw-c', PASSWORD);
    await page.fill('#pw-n', '1234567890');
    await page.fill('#pw-r', '1234567890');
    await page.getByRole('button', { name: 'Şifreyi değiştir' }).click();
    await expect(page.getByRole('alert')).toHaveText(/Bu şifre çok yaygın/);
    await expect(page).toHaveURL(/\/account\/security/);
  });

  test('davet sınırı: mesaj anlaşılır, süre yazılı, form silinmez', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/team');
    await page.evaluate(() => localStorage.setItem('sod_mock_fail', JSON.stringify(['invite.limit'])));
    await page.getByRole('button', { name: 'Kişi davet et' }).click();
    await page.fill('#inv-name', 'Sınır Kişi');
    await page.fill('#inv-contact', '0532 000 00 55');
    await page.getByRole('button', { name: 'Kod üret', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Yaklaşık 30 dakika sonra');
    await expect(page.locator('#inv-name')).toHaveValue('Sınır Kişi');
    await expect(page.locator('#inv-contact')).toHaveValue('0532 000 00 55');
  });

  test('davet kodu Türkçe harfe düşmeden büyür', async ({ page }) => {
    await reset(page);
    await page.goto('/join');
    await page.fill('#code', 'kim2ıq');
    await expect(page.locator('#code')).toHaveValue('KIM2IQ');
  });
});

const seedTeam = (page: Page, count: number) =>
  page.evaluate((n) => {
    const db = JSON.parse(localStorage.getItem('sod_mock_db')!);
    const roles = ['ADMIN', 'AUDITOR', 'ACCOUNTING', 'MEASURE', null];
    for (let i = db.memberships.filter((m: { orgId: string }) => m.orgId === 'o1').length; i < n; i += 1) {
      const id = `x${i}`;
      db.persons.push({ id: `p${id}`, name: `Çalışan Uzunsoyadlıoğlu ${i}`, email: i % 2 ? `calisan.uzun.${i}@ornek.test` : null, phone: i % 2 ? null : `+9053200010${String(i).padStart(2, '0')}`, locale: 'tr', emailVerified: !!(i % 2), password: 'Test12345!', otherOrgs: 0 });
      db.memberships.push({ id: `m${id}`, personId: `p${id}`, orgId: 'o1', orgRole: 'MEMBER', status: i % 7 === 0 ? 'SUSPENDED' : 'ACTIVE', lastActiveAt: new Date(Date.now() - i * 3_600_000).toISOString(), productRoles: { deciship: roles[i % 5] } });
    }
    localStorage.setItem('sod_mock_db', JSON.stringify(db));
  }, count);

test.describe('Genel Bakış ilk ekran', () => {
  // GB-D09: rakamlar banda binen panoda, Bekleyenler hemen altında (ilk ekran), En çok kaçıran ile Araçlar en altta yan yana.
  test('900 px içinde üç rakam ve Bekleyenler; En çok kaçıran altta Araçlar ile yan yana', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await expect(page.locator('.hub-figure')).toHaveCount(3);
    await expect(page.locator('.hub-figure').nth(0)).toContainText('Yakalanan fazla ödeme');
    await expect(page.locator('.hub-figure').nth(1)).toContainText('Karar bekleyen');
    await expect(page.locator('.hub-figure').nth(2)).toContainText('İtiraz süresi');
    const figures = (await page.locator('.hub-figures').boundingBox())!;
    const band = (await page.locator('.sod-band').boundingBox())!;
    const queue = (await page.locator('.hub-queue').boundingBox())!;
    const leaks = (await page.locator('.hub-topleak').boundingBox())!;
    const tools = (await page.locator('.hub-tools').boundingBox())!;
    expect(figures.y).toBeLessThan(band.y + band.height);
    expect(figures.y + figures.height).toBeLessThan(560);
    expect(queue.y).toBeLessThan(600);
    expect((await page.locator('.hub-queue-row').first().boundingBox())!.y).toBeLessThan(900);
    expect(leaks.y).toBeGreaterThanOrEqual(queue.y + queue.height - 1);
    expect(Math.abs(tools.y - leaks.y)).toBeLessThan(2);
    expect(leaks.x).toBeLessThan(tools.x);
    // Grup adı gerçek uçtaki gibi (`leader.*`, Mesaj 10: sahte API gerçeğe uyduruldu).
    await expect(page.locator('.hub-topleak h3')).toHaveText(['En çok fazla kesen taşıyıcı', 'En çok tutan fark türü']);
    for (const group of await page.locator('.hub-topleak-group').all()) expect(await group.locator('li').count()).toBeLessThanOrEqual(3);
    // Grafik ilk ekranın altında
    expect((await page.locator('.hub-chart').first().boundingBox())!.y).toBeGreaterThan(700);
  });

  test('parça şeridinde farklı satırlar kırmızı değil, ne olduğu yazılı', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await expect(page.locator('.hub-split-bar .part.bad')).toHaveCount(0);
    await expect(page.locator('.hub-split-bar .part.attn')).toHaveCount(1);
    // Açıklama gerçek uçtaki gibi parçanın kendi `note`u (Mesaj 10).
    await expect(page.locator('.hub-split-legend')).toContainText('Farklı satırların toplam tutarı');
  });

  test('Bekleyenler: tek araçta işaret yok, süre rozette, en yakın son gün üstte', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await expect(page.locator('.hub-queue .hub-tool')).toHaveCount(0);
    const first = page.locator('.hub-queue-row').first();
    await expect(first.locator('.tag')).toContainText(/gün kaldı|Son gün bugün/);
    // Süre tek yerde: rozet. Metin yalnız tarihi söyler.
    await expect(first.locator('.hub-queue-main')).not.toContainText(/gün kaldı/);
  });

  test('429: bölüm hatası yok, kendisi bir kez yeniler, yoğunluk metni görünür', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await expect(page.locator('.hub-hero')).toBeVisible();
    await page.evaluate(() => {
      sessionStorage.clear();
      localStorage.setItem('sod_mock_rate_once', '1');
    });
    await page.reload();
    await expect(page.locator('.sod-status.is-info')).toContainText('yoğun');
    await expect(page.locator('.hub-hero')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.sod-status')).toHaveCount(0);
    await expect(page.getByText('DeciShip verisi alınamadı')).toHaveCount(0);
  });
});

test.describe('oturum: önbellekteki firma', () => {
  test('/me geç dönse de sayfa açılır açılmaz yazma gider', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/team');
    await expect(page.getByLabel('Can Yıldız DeciShip rolü')).toBeVisible();
    await page.evaluate(() => localStorage.setItem('sod_mock_me_delay', '2500'));
    await page.reload();
    await page.getByLabel('Can Yıldız DeciShip rolü').selectOption('AUDITOR');
    await expect(page.locator('.toast').filter({ hasText: 'Can Yıldız' })).toBeVisible();
    await expect(page.locator('.sod-status')).toHaveCount(0);
  });

  test('yeniden yüklemede ilk istek önbellekteki firmayı taşır', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await expect(page.locator('.hub-hero')).toBeVisible();
    const first = page.waitForRequest((r) => r.url().includes('/api/account/me'));
    await page.reload();
    expect((await first).headers()['x-sod-org']).toBe('o1');
  });

  test('önbellek eskiyse uyarı yok, firma güncellenir', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await expect(page.locator('.hub-hero')).toBeVisible();
    await page.evaluate(() => localStorage.setItem('sod_mock_session', JSON.stringify({ personId: 'p1', orgId: 'o2' })));
    await page.reload();
    await expect(page.locator('.sod-firm-n')).toHaveText('Örnek İhracat Ltd.');
    await expect(page.locator('.sod-status')).toHaveCount(0);
  });
});

test.describe('Veriler tablosu', () => {
  test('ilk sütun yapışkan, ipucu var, kaydırma çalışır', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/data/deciship/invoices');
    await expect(page.locator('.hub-table tbody tr').first()).toBeVisible();
    const hint = page.getByRole('button', { name: 'Sağda daha çok sütun' });
    await expect(hint).toBeVisible();
    const cell = page.locator('.hub-table tbody td').first();
    const before = (await cell.boundingBox())!.x;
    await page.locator('.hub-table').evaluate((el) => (el.scrollLeft = 400));
    expect((await cell.boundingBox())!.x).toBe(before);
    await expect(page.locator('.hub-table-frame')).toHaveAttribute('data-left', 'true');
  });

  test('sütun seçici gizler, hatırlar, varsayılana döner', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/data/deciship/invoices');
    // API: `hiddenByDefault` ve para birimi hücresi ilk görünümde yok.
    await expect(page.locator('th', { hasText: 'Tarife yok' })).toHaveCount(0);
    await expect(page.locator('th', { hasText: 'Para birimi' })).toHaveCount(0);
    await expect(page.locator('th', { hasText: 'Eşleşmedi' })).toBeVisible();
    await (await dataMenuItem(page, 'Sütunlar…')).click();
    await page.getByRole('checkbox', { name: 'Tarife yok' }).check();
    await expect(page.locator('th', { hasText: 'Tarife yok' })).toBeVisible();
    await page.getByRole('checkbox', { name: 'Eşleşmedi' }).uncheck();
    await expect(page.locator('th', { hasText: 'Eşleşmedi' })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: 'Fatura', exact: true })).toBeDisabled();
    await page.reload();
    await expect(page.locator('.hub-table tbody tr').first()).toBeVisible();
    await expect(page.locator('th', { hasText: 'Tarife yok' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'Eşleşmedi' })).toHaveCount(0);
  });

  test('tutar daima iki ondalık ve para birimi satırda; Tümü\'nde tutar sıralaması kapalı', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/data/deciship/invoices');
    const header = page.locator('.hub-table th').filter({ hasText: 'Faturalanan' });
    await expect(header).toBeVisible();
    await expect(header.getByRole('button')).toHaveCount(0);
    await expect(page.getByText('Tutara göre sıralamak için önce para birimi seçin')).toBeVisible();
    const index = await page.locator('.hub-table th').evaluateAll((ths) => ths.findIndex((t) => t.textContent?.includes('Faturalanan')));
    const cells = await page.locator(`.hub-table tbody tr td:nth-child(${index + 1})`).allInnerTexts();
    for (const text of cells) expect(text).toMatch(/\d,\d{2}\s?[₺$€£]/);
    expect(cells.some((x) => x.includes('$'))).toBe(true);
    await openMoreFilters(page);
    await page.getByLabel('Para birimi').selectOption('USD');
    await expect(header.getByRole('button')).toHaveCount(1);
  });

  test('kayıt yoksa CSV kapalı', async ({ page }) => {
    await reset(page);
    await login(page, USERS.fresh);
    await page.goto('/data/deciship/invoices');
    await expect(await dataMenuItem(page, 'CSV indir')).toBeDisabled();
  });
});

test.describe('yetki değişikliği', () => {
  const open = async (page: Page) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/team');
  };

  test('her değişiklikte hemen geçerli bildirimi ve Geri al', async ({ page }) => {
    await open(page);
    await page.getByLabel('Can Yıldız DeciShip rolü').selectOption('AUDITOR');
    const toastBox = page.locator('.toast').filter({ hasText: 'Can Yıldız' });
    await expect(toastBox).toContainText('Hemen geçerli oldu.');
    await toastBox.getByRole('button', { name: 'Geri al' }).click();
    await expect(page.getByLabel('Can Yıldız DeciShip rolü')).toHaveValue('ACCOUNTING');
    await expect(page.locator('.toast').filter({ hasText: 'geri alındı' })).toBeVisible();
  });

  test('Erişim yok onay ister, vazgeçince değişmez', async ({ page }) => {
    await open(page);
    const select = page.getByLabel('Can Yıldız DeciShip rolü');
    await select.selectOption('');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Can Yıldız DeciShip içine giremez');
    await dialog.getByRole('button', { name: 'Vazgeç' }).click();
    await expect(select).toHaveValue('ACCOUNTING');
    await select.selectOption('');
    await page.getByRole('dialog').getByRole('button', { name: 'Erişimi kapat' }).click();
    await expect(select).toHaveValue('');
  });

  test('kendi rolünü düşürme, firma yöneticisi yapma ve askıya alma onay ister', async ({ page }) => {
    await open(page);
    await page.getByLabel('Selin Aydın DeciShip rolü').selectOption('AUDITOR');
    await expect(page.getByRole('dialog')).toContainText('Bazı yetkileriniz hemen kaldırılır');
    await page.getByRole('dialog').getByRole('button', { name: 'Vazgeç' }).click();

    await page.getByLabel('Can Yıldız firma rolü').selectOption('ADMIN');
    await expect(page.getByRole('dialog')).toContainText('firma yöneticisi olsun mu');
    await page.getByRole('dialog').getByRole('button', { name: 'Vazgeç' }).click();
    await expect(page.getByLabel('Can Yıldız firma rolü')).toHaveValue('MEMBER');

    await page.getByRole('button', { name: 'Can Yıldız için işlemler' }).click();
    await page.getByRole('menuitem', { name: 'Askıya al' }).click();
    await expect(page.getByRole('dialog')).toContainText('yeniden giriş yapamaz');
    await expect(page.getByRole('dialog')).toContainText('yeni kayıt ve değişiklikler hemen reddedilir');
    await expect(page.getByRole('dialog')).not.toContainText('hemen kapanır');
    await page.getByRole('dialog').getByRole('button', { name: 'Askıya al' }).click();
    await expect(page.locator('.toast').filter({ hasText: 'askıya alındı' })).toBeVisible();
  });
});

test.describe('kalabalık ekip', () => {
  test('56 kişi: arama, süzgeç, yapışkan başlık, davetler sekmede', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await seedTeam(page, 56);
    await page.goto('/account/team');
    await expect(page.locator('.d9-matrix tbody tr')).toHaveCount(56);
    await expect(page.getByRole('tab', { name: /Kişiler\s*56/ })).toBeVisible();

    await page.fill('#team-q', 'uzunsoyadlıoğlu 12');
    await expect(page.locator('.d9-matrix tbody tr')).toHaveCount(1);
    await page.fill('#team-q', '');
    await page.getByRole('button', { name: 'Süzgeçler' }).click();
    await page.getByLabel('Durum').selectOption('SUSPENDED');
    const suspended = await page.locator('.d9-matrix tbody tr').count();
    expect(suspended).toBeGreaterThan(1);
    expect(suspended).toBeLessThan(56);
    await expect(page.getByText(`56 kişiden ${suspended} tanesi`)).toBeVisible();
    await page.getByRole('button', { name: 'Temizle' }).first().click();
    // İki araç (DeciShip, pilot TagPress): tek "Araç rolü" süzgeci, seçenekler araç başına öbekli (`<araç>:<rol>`).
    const toolRole = page.getByLabel('Araç rolü', { exact: true });
    await expect(toolRole.locator('optgroup')).toHaveCount(2);
    expect(await toolRole.locator('optgroup').evaluateAll((gs) => gs.map((g) => (g as HTMLOptGroupElement).label))).toEqual(['DeciShip', 'TagPress']);
    await toolRole.selectOption('deciship:__none');
    await expect(page.locator('.d9-matrix tbody tr').first()).toBeVisible();
    await page.getByRole('button', { name: 'Temizle' }).first().click();

    await page.evaluate(() => window.scrollTo(0, 1500));
    const th = await page.locator('.d9-matrix thead th').first().boundingBox();
    expect(th!.y).toBeLessThanOrEqual(60);

    // Hücre düz metin: üstünde değilken çerçeve yok
    await page.mouse.move(0, 0);
    const border = await page.getByLabel('Can Yıldız DeciShip rolü').evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(border).toBe('rgba(0, 0, 0, 0)');

    await page.getByRole('tab', { name: /Davetler\s*2/ }).click();
    await expect(page).toHaveURL(/tab=invites/);
    await expect(page.locator('.d9-inv')).toHaveCount(2);
  });

  test('telefonda kişi kartı ve rol özeti, seçiciler altta', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await reset(page);
    await login(page, USERS.owner);
    await seedTeam(page, 56);
    await page.goto('/account/team');
    await expect(page.locator('.d9-card')).toHaveCount(56);
    const card = page.locator('.d9-card').filter({ hasText: 'Can Yıldız' });
    // Çalışanın iki araç rolü: DeciShip ve pilot TagPress (tohum: DeciShip web rolü olan çalışan TagPress'te Kullanıcı).
    await expect(card.locator('.summary')).toContainText('Çalışan · DeciShip: Muhasebe · TagPress: Kullanıcı');
    await expect(card.locator('select')).toHaveCount(0);
    await card.getByRole('button', { name: 'Rolleri değiştir' }).click();
    // Firma rolü + DeciShip + TagPress.
    await expect(card.locator('select')).toHaveCount(3);
    await expect(card.getByLabel('Can Yıldız TagPress rolü')).toHaveValue('USER');
    await card.getByLabel('Can Yıldız DeciShip rolü').selectOption('');
    await expect(page.getByRole('dialog')).toContainText('Can Yıldız DeciShip içine giremez');
    await page.getByRole('dialog').getByRole('button', { name: 'Vazgeç' }).click();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
  });
});

test.describe('ilk gün', () => {
  test('Başlangıç: Merkez kurulumu ve araç kurulumları ayrı, derin bağlantılar, boş rakam ve dönem seçici yok', async ({ page }) => {
    await reset(page);
    await login(page, USERS.fresh);
    await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();
    const hub = page.locator('section[aria-labelledby="hub-start-hub"]');
    await expect(page.getByRole('heading', { name: 'Merkez kurulumu', level: 2 })).toBeVisible();
    // Sayaç yalnız zorunlu adımı (firma onayı) sayar: isteğe bağlı ekip sayılmaz.
    await expect(hub.locator('.hub-start-count')).toHaveText('0/1');
    await expect(hub.locator('.hub-start-list li')).toHaveCount(2);
    await expect(hub.getByRole('heading', { name: 'İsteğe bağlı', level: 3 })).toBeVisible();
    await expect(hub.locator('.hub-start-list li').nth(0)).toContainText('Firma bilgilerini onaylayın');
    await expect(hub.locator('.hub-start-list li').nth(0).getByRole('link')).toHaveAttribute('href', '/account/company?next=/home');
    await expect(hub.locator('.hub-start-list li').nth(1)).toContainText('Ekibi davet edin');
    await expect(hub.locator('.hub-start-list li').nth(1).getByRole('link')).toHaveAttribute('href', '/account/team');
    // Araç kurulumları: adımlar aracın overview'ından; kart sıradaki adıma gider, yakında gelen araç soluk.
    await expect(page.getByRole('heading', { name: 'Araç kurulumları', level: 2 })).toBeVisible();
    const tool = page.locator('.hub-start-tools li').filter({ hasText: 'DeciShip' });
    await expect(tool).toContainText('0/5 adım · Sıradaki: Taşıyıcı ekleyin');
    await expect(tool.getByRole('link', { name: 'Kuruluma devam et' })).toHaveAttribute('href', '/deciship/setup?adim=tasiyicilar');
    await expect(page.locator('.hub-start-tools .hub-tool-row.is-soon').first()).toContainText('Yakında');
    // Tek birincil eylem: Merkez'in eksik zorunlu adımı.
    await expect(page.locator('.hub-start .btn-primary')).toHaveCount(1);
    await expect(hub.locator('.hub-start-list li').nth(0).locator('.btn-primary')).toHaveCount(1);
    await expect(page.getByText('Bekleyen iş yok')).toHaveCount(0);
    await expect(page.locator('.hub-period')).toHaveCount(0);
  });

  test('firma onayı: Onayla değişiklik olmadan etkin, Genel Bakışa ve araca geri döner', async ({ page }) => {
    await reset(page);
    await login(page, USERS.fresh);
    // Araç kurulumu bitmiş: başlangıç sayfasını yalnız firma onayı tutar.
    await page.evaluate(() => {
      sessionStorage.clear();
      localStorage.setItem('sod_mock_setup_flag_done', '1');
      localStorage.setItem('sod_mock_setup_done', 'carriers,tariffs,measure-rules,first-measurement,first-invoice');
    });
    await page.reload();
    const hub = page.locator('section[aria-labelledby="hub-start-hub"]');
    await expect(hub.locator('.hub-start-count')).toHaveText('0/1');
    await expect(page.locator('.hub-start-tools li').filter({ hasText: 'DeciShip' })).toContainText('Kurulum tamamlandı');
    await hub.locator('.hub-start-list li').nth(0).getByRole('link', { name: 'Başla' }).click();
    await expect(page).toHaveURL(/\/account\/company\?next=/);
    await expect(page.getByText('Onaylayınca kaldığınız yere dönersiniz.')).toBeVisible();
    const confirm = page.getByRole('button', { name: 'Onayla', exact: true });
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.locator('.hub-period')).toBeVisible();
    await expect(page.locator('.hub-start-tools')).toHaveCount(0);
    // Onaylı firmada sayfa yalnız düzenleme: değişiklik yoksa Kaydet kapalı.
    await page.goto('/account/company');
    await expect(page.getByRole('button', { name: 'Kaydet', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Onayla', exact: true })).toHaveCount(0);

    // Araçtan gelinen onay aracın sayfasına tam sayfa döner.
    await reset(page);
    await login(page, USERS.fresh);
    await page.goto(`/account/company?next=${encodeURIComponent('/deciship/setup?adim=tasiyicilar')}`);
    await page.getByRole('button', { name: 'Onayla', exact: true }).click();
    await expect(page).toHaveURL(/\/deciship\/setup\?adim=tasiyicilar$/);
  });

  test('ekip adımını Merkez hesaplar', async ({ page }) => {
    await reset(page);
    await login(page, USERS.fresh);
    await expect(page.locator('.hub-start-tools li').filter({ hasText: 'DeciShip' })).toContainText('0/5 adım');
    await page.evaluate(() => {
      const db = JSON.parse(localStorage.getItem('sod_mock_db')!);
      db.invitations.push({ id: 'ix', orgId: 'o3', kind: 'EMAIL', email: 'a@ornek.test', phone: null, name: 'A', orgRole: 'MEMBER', productRoles: {}, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 864e5).toISOString(), token: 'x' });
      localStorage.setItem('sod_mock_db', JSON.stringify(db));
      sessionStorage.clear();
      localStorage.setItem('sod_mock_setup_done', 'carriers');
    });
    await page.reload();
    await expect(page.locator('.hub-start-tools li').filter({ hasText: 'DeciShip' })).toContainText('1/5 adım');
    await expect(page.locator('.hub-start-list li').filter({ hasText: 'Ekibi davet edin' })).toHaveClass(/is-done/);
    // İsteğe bağlı ekip Merkez sayacına girmez.
    await expect(page.locator('section[aria-labelledby="hub-start-hub"] .hub-start-count')).toHaveText('0/1');
  });

  test('Analiz kurulum durumuna göre yönlendirir, dönem ve filtre gizli', async ({ page }) => {
    await reset(page);
    await login(page, USERS.fresh);
    await page.goto('/analytics/deciship');
    await expect(page.getByRole('heading', { name: 'Analiz için önce DeciShip kurulumunu tamamlayın' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Taşıyıcı ekleyin' })).toBeVisible();
    await expect(page.locator('.hub-period')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Filtre/ })).toHaveCount(0);
  });
});

test.describe('Analiz bölümleri', () => {
  test('etkin bölüm aria-current, Filtre sayacı, para birimi gerçeği söyler', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/analytics/deciship');
    await page.getByRole('link', { name: 'Ölçüm', exact: true }).click();
    await expect(page.locator('.hub-section-tabs a[aria-current="page"]')).toHaveText('Ölçüm');
    await expect(page.getByRole('heading', { name: 'Fazla ödeme', level: 2 })).toHaveCount(0);
    await page.getByRole('button', { name: 'Filtre' }).click();
    const currency = page.getByLabel('Para birimi');
    await expect(currency).toHaveValue('TRY');
    await expect(currency.getByRole('option', { name: 'Tümü' })).toHaveCount(0);
    await currency.selectOption('USD');
    await expect(page.getByRole('button', { name: 'Filtre (1)' })).toBeVisible();
    const country = page.getByLabel('Ülke kodu');
    await expect(country.getByRole('option', { name: 'Almanya' })).toHaveCount(1);
  });

  test('yapışkan çubuk kaydırınca üstte kalır; telefonda filtre alt sayfa', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/analytics/deciship');
    await expect(page.locator('.hub-kpis')).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 1200));
    // Sabit üst satır (kabuk "SABİT ÜST SATIR"): çubuk ekranın tepesine değil, sabit satırın hemen altına yapışır.
    await expect.poll(async () => Math.round((await page.locator('.hub-analytics-bar').boundingBox())!.y)).toBe(72);
    await expect(page.locator('.sod-top')).toBeInViewport();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole('button', { name: 'Filtre' }).click();
    const sheet = page.getByRole('dialog', { name: 'Filtreler' });
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    expect(box.y + box.height).toBeGreaterThanOrEqual(843);
    // Tek sütun: alanlar aynı hizada, tam genişlik, 14 px aralık, yukarıdan aşağı.
    const fields = await sheet.locator('.hub-filter-fields > *').evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })));
    expect(fields.length).toBeGreaterThan(2);
    const body = (await sheet.locator('.hub-sheet-dialog-body').boundingBox())!;
    for (const f of fields) {
      expect(f.x).toBe(fields[0]!.x);
      expect(f.w).toBe(body.width - 32);
    }
    expect(Math.round(fields[1]!.y - (fields[0]!.y + fields[0]!.h))).toBe(14);
    const box2 = (await sheet.locator('.hub-compare').boundingBox())!;
    expect(box2.x).toBe(fields[0]!.x);
    await sheet.getByRole('button', { name: 'Tamam' }).click();
    await expect(sheet).toBeHidden();
  });
});

test.describe('Etkinlik süzmesi', () => {
  test('kişi, işlem, arama', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/activity');
    const rows = page.locator('.hub-feed-row');
    await expect(rows.first()).toBeVisible();
    const total = await rows.count();
    // Arama açık; kişi, işlem ve tarih "Filtre" düğmesinin arkasında.
    await expect(page.locator('#act-person')).toHaveCount(0);
    await page.getByRole('button', { name: 'Filtre' }).click();
    await page.getByLabel('Kişi').selectOption('Elif Şahin');
    await expect(page.getByRole('button', { name: 'Filtre (1)' })).toBeVisible();
    await expect(rows.first()).toContainText('Elif Şahin');
    expect(await rows.count()).toBeLessThan(total);
    // Süzgeç adreste: yenileyince ve geri gelince korunur.
    await expect(page).toHaveURL(/[?&]person=Elif/);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Filtre (1)' })).toBeVisible();
    await expect(rows.first()).toContainText('Elif Şahin');
    // Yenileme süzgeci korur, paneli kapalı açar (Mesaj 15: süzgeçler "Filtre" düğmesinin arkasında); temizleme panelde.
    await expect(page.getByLabel('Kişi')).toHaveCount(0);
    await page.getByRole('button', { name: 'Filtre (1)' }).click();
    await expect(page.getByLabel('Kişi')).toHaveValue('Elif Şahin');
    await page.getByRole('button', { name: 'Filtreleri temizle' }).click();
    await expect(page).not.toHaveURL(/person=/);
    await expect(page.getByRole('button', { name: 'Filtre', exact: true })).toBeVisible();
    // Arama 300 ms sonra adrese geçer.
    await page.fill('#act-q', 'zzz-yok');
    await expect(page).toHaveURL(/[?&]q=zzz-yok/);
    await expect(page.getByText('Bu filtrelere uyan kayıt yok')).toBeVisible();
    await page.reload();
    await expect(page.locator('#act-q')).toHaveValue('zzz-yok');
    await expect(page.getByText('Bu filtrelere uyan kayıt yok')).toBeVisible();
  });

  test('geçersiz adres değeri yok sayılır; kaynak sekmesi adreste', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/activity?from=dün&source=yok');
    await expect(page.locator('.hub-feed-row').first()).toBeVisible();
    await page.getByRole('button', { name: 'DeciShip', exact: true }).click();
    await expect(page).toHaveURL(/[?&]source=deciship/);
  });
});

test.describe('küçükler', () => {
  test('404 başlığı h1; Ölçüm rolünde başlık menüyle aynı, uygulama durumu doğru söylenir', async ({ page }) => {
    await reset(page);
    await login(page, USERS.measure);
    await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();
    await expect(page.getByText('Uygulama henüz mağazada yok')).toBeVisible();
    await page.goto('/yok-boyle-sayfa');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  // D09: başlık bantta, kabuğun ortak PageHeader'ı (DeciShip paneli de aynısını kullanır). Genel Bakış büyük bant (56/600,
  // üstte 64 px); diğer sayfalar standart bant (36/600, üstte 28 px).
  test('sayfa başlığı bantta D09 ölçüsünde: Genel Bakış büyük, diğerleri standart', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    for (const [url, size, pad] of [
      ['/home', '56px', '64px'],
      ['/analytics/deciship', '36px', '28px'],
      ['/data/deciship/invoices', '36px', '28px'],
      ['/activity', '36px', '28px'],
    ] as const) {
      await page.goto(url);
      // Sayfa açılışı sırasında öğe yeniden kurulabilir (bağlantısız öğede stil boş döner): ölçüm kararlı olana dek yeniden okunur.
      await expect
        .poll(
          () =>
            page.locator('.sod-band .phead.is-band h1.ptitle').evaluate((el) => {
              const s = getComputedStyle(el);
              return [s.fontSize, s.fontWeight];
            }),
          { message: url },
        )
        .toEqual([size, '600']);
      await expect
        .poll(() => page.locator('.sod-band .phead.is-band').evaluate((el) => getComputedStyle(el).paddingTop), { message: url })
        .toBe(pad);
      await expect(page.locator('h1')).toHaveCount(1);
    }
  });
});

/**
 * Bant boyu: yalnız Genel Bakış büyük bant; diğer her sayfa (alt metin, eylem, sekme, kırıntı olsa da olmasa da) standart
 * yükseklikte. Mesaj 15'ten beri alt metin en çok iki satırdır ve ikinci satıra sarınca bant tam bir satır uzar (DESIGN.md
 * "Bant"; 1440'ta 24, telefonda 20 px; bant en az yüksekliğini korur, `min-height`). Ekip'in alt metni telefonda iki
 * satır ve eylem satırı var: 289 + 20 = 309 (örnek veride sabit). Abonelikte alt metin telefonda iki satır ama eylem yok: 289.
 * Analiz'in alt metni tarih aralığıdır, uzunluğu güne göre değişir: kural satır sayısından sınanır. Başlık bu sayfalarda
 * tek satır. DeciShip paneli de aynı değerleri kullanır.
 */
for (const [w, h, std, subLine, titleLine, fixed] of [
  [1440, 900, 240, 24, 44, {}],
  [390, 844, 289, 20, 34, { '/account/team': 309, '/account/billing': 289 }],
] as const) {
  test(`bant yüksekliği ${w} px: standart sayfalar ${std} px, Genel Bakış büyük`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await reset(page);
    await login(page, USERS.owner);
    const bandH = async () => {
      await expect(page.locator('.sod-band')).toHaveAttribute('data-size', /^(standard|hero|none)$/);
      return Math.round((await page.locator('.sod-band').boundingBox())!.height);
    };
    /** Bant başlığında bir öğenin satır sayısı (yoksa 0). */
    const lines = async (sel: string, lh: number) => {
      const box = page.locator(`.sod-band .phead.is-band ${sel}`);
      if (!(await box.count())) return 0;
      const height = (await box.boundingBox())!.height;
      expect(height % lh, sel).toBe(0);
      return height / lh;
    };
    await expect(page.locator('.sod-band')).toHaveAttribute('data-size', 'hero');
    const hero = await bandH();
    expect(hero).toBeGreaterThan(std);
    // Ekip: alt metin + iki eylem; Analiz: sekme + eylem; Veriler: sekme; Etkinlik: yalnız başlık; Abonelik ve Firma: binen kart;
    // 404 ve DeciShip taslağı (PageHeader yok).
    for (const url of ['/account/team', '/analytics/deciship', '/data/deciship/invoices', '/activity', '/account/billing', '/account/company', '/yok-boyle-sayfa', '/deciship/']) {
      await page.goto(url);
      if (url !== '/deciship/') await expect(page.locator('.sod-band')).toHaveAttribute('data-size', 'standard');
      await expect(page.locator('.sod-band h1, [data-testid=deciship-stub] h1').first()).toBeVisible();
      if (url !== '/deciship/') expect(await lines('.ptitle', titleLine), url).toBe(1);
      const sub = await lines('.psub', subLine);
      expect(sub, url).toBeLessThanOrEqual(2);
      const want = (fixed as Record<string, number>)[url];
      if (want) expect(sub, url).toBe(2);
      // Telefonda eylem satırı (12 + 48 px) yoksa ikinci alt metin satırı o boşluğa sığar: bant en az yükseklikte kalır.
      const roomy = w <= 760 && !(await page.locator('.sod-band .phead.is-band .pactions').isVisible());
      expect(await bandH(), url).toBe(want ?? (roomy ? std : std + Math.max(0, sub - 1) * subLine));
    }
    // Banda binen kart bandın içinden başlar, başlığın altında kalır.
    await page.goto('/account/billing');
    const band = (await page.locator('.sod-band').boundingBox())!;
    const lift = (await page.locator('.d9-lift').first().boundingBox())!;
    const head = (await page.locator('.sod-band .phead.is-band').boundingBox())!;
    expect(lift.y).toBeLessThan(band.y + band.height);
    expect(lift.y).toBeGreaterThanOrEqual(head.y + head.height);
  });
}

test('para birimi bilinmeyen tutarda ₺ uydurulmaz; currencyCell satırdaki birimi yazar', async ({ page }) => {
  await reset(page);
  await login(page, USERS.owner);
  await page.evaluate(() =>
    localStorage.setItem(
      'sod_mock_dataset_override',
      JSON.stringify({
        id: 'invoices',
        page: 1,
        pageSize: 25,
        total: 2,
        columns: [
          { id: 'no', label: 'Fatura', format: 'text' },
          { id: 'billed', label: 'Faturalanan', format: 'number', align: 'right', currencyCell: 'cur' },
        ],
        rows: [
          { id: 'a', cells: { no: 'A', billed: 10.5, cur: 'USD' } },
          { id: 'b', cells: { no: 'B', billed: 20, cur: null } },
        ],
      }),
    ),
  );
  await page.goto('/data/deciship/invoices');
  await expect(page.locator('.hub-table tbody tr').nth(0)).toContainText('10,50 $');
  const missing = page.locator('.hub-table tbody tr').nth(1).locator('td').nth(1);
  await expect(missing).toHaveText('20,00');
});

test('site dili taşınır: /register?lang=en İngilizce açılır, kayıt o dille gider', async ({ page }) => {
  await reset(page);
  await page.goto('/register?lang=en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('EN: tek kişi tekil yazılır; menüde bağlantılar menuitem; sekme adı ray ile aynı değil', async ({ page }) => {
  await reset(page);
  await login(page, USERS.fresh);
  await page.getByRole('button', { name: /^Firma:/ }).click();
  await expect(page.getByRole('menuitem', { name: 'Yeni firma' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.evaluate(() => fetch('/api/account/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-SOD-CSRF': '1' }, body: JSON.stringify({ locale: 'en' }) }));
  await page.goto('/account/team');
  await expect(page.locator('.d9-total')).toHaveText('1 person');
});

test.describe('tur 2', () => {
  test('Karar bekleyen rakamı Bekleyenler kuyruklarının toplamı, başlık para birimini söyler', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    const figure = await page.locator('.hub-figure', { hasText: 'Karar bekleyen' }).locator('.hub-figure-value').innerText();
    await page.locator('.hub-queue').getByRole('button', { name: /Tümünü göster/ }).click();
    const titles = await page.locator('.hub-queue-row b', { hasText: 'fark karar bekliyor' }).allInnerTexts();
    expect(titles.length).toBeGreaterThan(1);
    expect(titles.every((x) => /TRY|USD/.test(x))).toBe(true);
    expect(titles.reduce((sum, x) => sum + Number(x.match(/(\d+) fark/)![1]), 0)).toBe(Number(figure));
  });

  test('rakam hücresinin tamamı bağlantı, telefonda en az 44 px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await reset(page);
    await login(page, USERS.owner);
    const cell = page.locator('.hub-figure', { hasText: 'Karar bekleyen' });
    const box = (await cell.boundingBox())!;
    // Bağlantının kendisi hücre kadar: ölçülen kutu da, tıklama da.
    for (const name of ['Karar bekleyen', 'İtiraz süresi']) {
      const link = (await page.locator('.hub-figure', { hasText: name }).locator('a').first().boundingBox())!;
      const whole = (await page.locator('.hub-figure', { hasText: name }).boundingBox())!;
      expect(link.height).toBeGreaterThanOrEqual(44);
      expect(link.width).toBeGreaterThanOrEqual(whole.width - 1);
    }
    await page.mouse.click(box.x + box.width - 6, box.y + box.height - 6);
    await expect(page).toHaveURL(/\/data\/deciship\/invoice-lines/);
  });

  test('telefonda tutar ikinci sütun', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/data/deciship/invoices');
    await expect(page.locator('.hub-table thead th').nth(1)).toContainText('Fazla ödeme');
  });

  test('kendi erişimini kapatma ayrı metin söyler', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/team');
    await page.getByLabel('Selin Aydın DeciShip rolü').selectOption('');
    await expect(page.getByRole('dialog')).toContainText('Araca girişiniz tamamen kapanır');
    await page.getByRole('dialog').getByRole('button', { name: 'Vazgeç' }).click();
    await page.getByLabel('Selin Aydın DeciShip rolü').selectOption('AUDITOR');
    await expect(page.getByRole('dialog')).toContainText('Bazı yetkileriniz hemen kaldırılır');
  });

  test('Geri al bildirimi alt ortada, Kişi davet et örtülmez', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/team');
    await page.getByLabel('Can Yıldız DeciShip rolü').selectOption('AUDITOR');
    const toastBox = (await page.locator('.toast', { hasText: 'Can Yıldız' }).boundingBox())!;
    expect(toastBox.y).toBeGreaterThan(600);
    const inviteBox = (await page.getByRole('button', { name: 'Kişi davet et' }).boundingBox())!;
    expect(toastBox.y).toBeGreaterThan(inviteBox.y + inviteBox.height);
  });

  test('ekip hücresinde ok her zaman görünür', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/team');
    await page.mouse.move(0, 0);
    const image = await page.getByLabel('Can Yıldız DeciShip rolü').evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(image).not.toBe('none');
  });
});

test.describe('son küçükler', () => {
  test('telefonda Etkinlik filtreleri alt sayfada, ilk kayıt üstte', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/activity');
    const first = page.locator('.hub-feed-row').first();
    await expect(first).toBeVisible();
    // D09 bandı telefonda ~250 px: ilk kayıt ilk ekranda ve süzgeç çubuğunun hemen altında (arada süzgeç alanı yok).
    // Düzen (yazı tipi, bant) oturana dek ölçüm yeniden okunur; ölçüt aynı: kayıt ilk ekranda, süzgeç çubuğunun hemen altında.
    const gaps = () =>
      page.evaluate(() => {
        const f = document.querySelector('.hub-feed-row')!.getBoundingClientRect();
        const b = document.querySelector('.hub-activity-bar')!.getBoundingClientRect();
        return { bottom: f.bottom, gap: f.top - b.bottom };
      });
    await expect.poll(async () => (await gaps()).bottom).toBeLessThan(844);
    await expect.poll(async () => (await gaps()).gap).toBeLessThan(100);
    await expect(page.locator('#act-person')).toBeHidden();
    await page.getByRole('button', { name: 'Filtre' }).click();
    const sheet = page.getByRole('dialog', { name: 'Filtreler' });
    await sheet.getByLabel('Kişi').selectOption('Elif Şahin');
    await sheet.getByRole('button', { name: 'Tamam' }).click();
    await expect(page.getByRole('button', { name: 'Filtre (1)' })).toBeVisible();
    await expect(first).toContainText('Elif Şahin');
  });

  test('"Fark var" notu masaüstünde tek satır', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    // Her parçanın açıklaması var (gerçek uç gibi); burada "Fark var"ınki.
    const note = page.locator('.hub-split-legend small', { hasText: 'Farklı satırların' });
    await expect(note).toBeVisible();
    const lines = await note.evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return new Set(Array.from(r.getClientRects()).map((c) => Math.round(c.top))).size;
    });
    expect(lines).toBe(1);
  });

  test('Ekip süzgeç satırı (Süzgeçler açılınca) 1024 ve 1440te tek satır', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/account/team');
      await page.getByRole('button', { name: 'Süzgeçler' }).click();
      await expect(page.locator('#team-f-status')).toBeVisible();
      const tops = await page.locator('.d9-filters .sel').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().bottom)));
      expect(new Set(tops).size, String(width)).toBe(1);
    }
  });

  test('EN tarih "27 Oct" biçiminde', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.evaluate(async () => {
      await fetch('/api/account/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-SOD-CSRF': '1' }, body: JSON.stringify({ locale: 'en' }) });
    });
    await page.goto('/data/deciship/invoices');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    const months = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec';
    await expect(page.locator('.hub-table tbody td').filter({ hasText: new RegExp(`^\\d{1,2} (${months}) \\d{4}$`) }).first()).toBeVisible();
    await expect(page.locator('.hub-table tbody td').filter({ hasText: new RegExp(`^(${months}) \\d`) })).toHaveCount(0);
  });
});

test.describe('entegrasyon son', () => {
  const owned = async (page: Page) => {
    await reset(page);
    await login(page, USERS.owner);
    await expect(page.locator('.hub-hero')).toBeVisible();
  };
  const personLocale = (page: Page) =>
    page.evaluate(() => (JSON.parse(localStorage.getItem('sod_mock_db')!).persons as { id: string; locale: string }[]).find((p) => p.id === 'p1')!.locale);

  test('dil değiştirip hemen araç değiştirince dil geri dönmez, hesaba yazılır (Merkez ↔ DeciShip)', async ({ page }) => {
    await owned(page);
    await page.evaluate(() => localStorage.setItem('sod_mock_me_patch_delay', '1500'));
    await page.getByRole('button', { name: /^Kullanıcı menüsü/ }).click();
    await page.locator('.sod-pop-lang').click();
    await page.getByRole('menuitemradio', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    // PATCH bitmeden DeciShip'e tam sayfa geçiş
    await page.getByRole('button', { name: 'Apps' }).click();
    await page.locator('.sod-pop a[data-sod-tool=deciship]').click();
    await expect(page).toHaveURL(/\/deciship\//);
    await expect(page.locator('.sod-brand-n')).toHaveText('DeciShip');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    expect(await page.evaluate(() => localStorage.getItem('sod_mock_me_patch_delay'))).toBe('1500');
    // Eski /me dili ezmedi; geri dönüşte de İngilizce
    await page.getByRole('button', { name: 'Apps' }).click();
    await page.locator('.sod-pop a[data-sod-tool=hub]').click();
    await expect(page).toHaveURL(/\/home/);
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect.poll(() => personLocale(page), { timeout: 10_000 }).toBe('en');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('sod_locale_pending')), { timeout: 10_000 }).toBeNull();
  });

  test('kaydı beklenen dil eskiyse hesaptaki dil geçerli', async ({ page }) => {
    await owned(page);
    await page.evaluate(() => {
      sessionStorage.clear();
      localStorage.setItem('sod_locale_pending', JSON.stringify({ locale: 'en', at: Date.now() - 60_000 }));
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
    expect(await personLocale(page)).toBe('tr');
  });

  test('çıkışta bekleyen dil silinir', async ({ page }) => {
    await owned(page);
    await page.evaluate(() => localStorage.setItem('sod_locale_pending', JSON.stringify({ locale: 'en', at: Date.now() })));
    await page.getByRole('button', { name: /Kullanıcı menüsü|User menu/ }).click();
    await page.getByRole('menuitem', { name: /Çıkış yap|Sign out/ }).click();
    await expect(page).toHaveURL(/\/login/);
    expect(await page.evaluate(() => localStorage.getItem('sod_locale_pending'))).toBeNull();
  });

  test('completed true gelse de zorunlu adım eksikse Başlangıç görünür, boş rakam yok', async ({ page }) => {
    await reset(page);
    await login(page, USERS.fresh);
    await page.evaluate(() => {
      sessionStorage.clear();
      localStorage.setItem('sod_mock_company_confirmed', '1');
      localStorage.setItem('sod_mock_setup_flag_done', '1');
      localStorage.setItem('sod_mock_setup_done', 'carriers');
    });
    await page.reload();
    // Firma onaylı: başlangıç sayfasını aracın açık kurulumu tutar; Merkez paneli tamam görünür.
    await expect(page.getByRole('heading', { name: 'Araç kurulumları', level: 2 })).toBeVisible();
    await expect(page.locator('.hub-start-tools li').filter({ hasText: 'DeciShip' })).toContainText('1/5 adım · Sıradaki:');
    await expect(page.locator('section[aria-labelledby="hub-start-hub"] .hub-start-count')).toHaveText('1/1');
    // Merkez tamam: tek birincil eylem aracın kartında.
    await expect(page.locator('.hub-start .btn-primary')).toHaveCount(1);
    await expect(page.locator('.hub-start-tools .btn-primary')).toHaveCount(1);
    await expect(page.getByText('Bu dönemde veri yok')).toHaveCount(0);
    await page.goto('/analytics/deciship');
    await expect(page.getByRole('heading', { name: /Analiz için önce/ })).toBeVisible();
  });

  test('zorunlu adımlar bitince Başlangıç kalkar', async ({ page }) => {
    await reset(page);
    await login(page, USERS.fresh);
    await page.evaluate(() => {
      sessionStorage.clear();
      localStorage.setItem('sod_mock_company_confirmed', '1');
      localStorage.setItem('sod_mock_setup_flag_done', '1');
      localStorage.setItem('sod_mock_setup_done', 'carriers,tariffs,measure-rules,first-measurement,first-invoice');
    });
    await page.reload();
    await expect(page.locator('.hub-period')).toBeVisible();
    await expect(page.locator('.hub-start-list')).toHaveCount(0);
    await expect(page.locator('.hub-start-tools')).toHaveCount(0);
  });
});

test.describe('ürün değerlendirmesi', () => {
  test('erişim reddi (refreshable): bir kez sessiz yeniler, veri gelir', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await expect(page.locator('.hub-hero')).toBeVisible();
    await page.evaluate(() => {
      sessionStorage.clear();
      localStorage.removeItem('sod_mock_refreshes');
      localStorage.setItem('sod_mock_access_once', '1');
    });
    await page.reload();
    await expect(page.locator('.hub-hero')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('sod_mock_refreshes'))).toBe('1');
  });

  test('erişim gerçekten yoksa döngü yok: tek yenileme', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await expect(page.locator('.hub-hero')).toBeVisible();
    await page.evaluate(() => {
      sessionStorage.clear();
      localStorage.removeItem('sod_mock_refreshes');
      localStorage.setItem('sod_mock_fail', JSON.stringify(['deciship.overview.403']));
    });
    await page.reload();
    await expect(page.locator('.hub-queue')).toContainText('DeciShip');
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => localStorage.getItem('sod_mock_refreshes'))).toBe('1');
  });

  test('firma adı noktayla bitse de çift nokta yok', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.evaluate(async () => {
      const db = JSON.parse(localStorage.getItem('sod_mock_db')!);
      db.orgs.find((o: { id: string }) => o.id === 'o1').name = 'Akis Tekstil Ltd. Şti.';
      db.persons.find((p: { id: string }) => p.id === 'p1').locale = 'en';
      localStorage.setItem('sod_mock_db', JSON.stringify(db));
      sessionStorage.clear();
    });
    await page.goto('/account/firms');
    await expect(page.getByText('You own Akis Tekstil Ltd. Şti. The owner')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Şti..');
  });

  test('veri gelmediyse (403) "Bekleyen iş yok" denmez', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.evaluate(() => {
      sessionStorage.clear();
      localStorage.setItem('sod_mock_fail', JSON.stringify(['deciship.overview.403']));
    });
    await page.goto('/home');
    await expect(page.locator('.hub-queue')).toContainText('DeciShip');
    await expect(page.getByText('Bekleyen iş yok')).toHaveCount(0);
  });

  test('e-posta kapalıysa Şifremi unuttum vaat etmez, davet bağlantısı dürüst', async ({ page }) => {
    await reset(page);
    await page.evaluate(() => localStorage.setItem('sod_mock_mail_off', '1'));
    await page.goto('/forgot-password');
    await expect(page.getByText('Bu kurulumda şifre yenileme bağlantısı gönderilemez.')).toBeVisible();
    await expect(page.getByText('bu kurulumu yöneten kişiye başvurun')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('gönderelim');
    await expect(page.locator('form')).toHaveCount(0);

    await login(page, USERS.owner);
    await page.goto('/account/team');
    await page.getByRole('button', { name: 'Kişi davet et' }).click();
    await page.getByRole('button', { name: /E-posta/ }).first().click();
    await page.fill('#inv-name', 'Postasız Kişi');
    await page.fill('#inv-contact', 'postasiz@ornek.test');
    await page.getByRole('button', { name: 'Davet oluştur' }).click();
    await expect(page.getByRole('dialog')).toContainText('Bu kurulumda e-posta gönderimi kapalı');
    await expect(page.getByRole('dialog')).not.toContainText('Davet e-postası gönderildi');
  });

  test('e-posta açıksa Şifremi unuttum formu ve "gönderildi" metni', async ({ page }) => {
    await reset(page);
    await page.goto('/forgot-password');
    await expect(page.locator('form')).toBeVisible();
    await expect(page.getByText('E-posta gönderimi kapalı')).toHaveCount(0);
    await expect(page.getByText('gönderelim')).toBeVisible();
  });

  test('Ölçüm rolü ve Ekip uygulama gerçeğini söyler; davet mesajı uygulamadan bahseder', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await reset(page);
    await login(page, USERS.measure);
    await expect(page.getByText('Android uygulamasını yöneticiniz paylaşacak')).toBeVisible();
    await expect(page.getByText('Telefonunuzda SellerOnData uygulamasını açın')).toHaveCount(0);

    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/team');
    await expect(page.getByRole('heading', { name: 'Uygulamayı paylaş' })).toBeVisible();
    await page.getByRole('button', { name: 'Kişi davet et' }).click();
    await page.fill('#inv-name', 'Uygulama Kişi');
    await page.fill('#inv-contact', '0532 000 00 66');
    await page.getByRole('button', { name: 'Kod üret', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Mesajı kopyala/ }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Android uygulamasını yöneticiniz paylaşacak');
  });

  test('askıdaki üye firma oluşturma görmez', async ({ page }) => {
    await reset(page);
    await login(page, '0532 000 00 06');
    await expect(page.getByRole('heading', { name: 'Bu firmadaki üyeliğiniz askıda' })).toBeVisible();
    await expect(page.locator('#new-org')).toHaveCount(0);
  });

  test('firmadan çıkarılan kişi: sona erdi uyarısı, başka firmaya geçiş; devam et yok', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.getByRole('button', { name: /^Firma:/ }).click();
    await page.getByRole('menuitemradio', { name: /Örnek İhracat/ }).click();
    await expect(page.locator('.sod-firm-n')).toHaveText('Örnek İhracat Ltd.');
    await page.goto('/account/profile');
    await page.locator('.acc-row').filter({ has: page.locator('.acc-lab', { hasText: /^Ad soyad$/ }) }).getByRole('button', { name: 'Düzenle' }).click();
    await expect(page.locator('#p-name')).toBeVisible();
    // Yönetici çıkardı: jeton bayat, yenileme başka firmaya düşer.
    await page.evaluate(() => {
      const db = JSON.parse(localStorage.getItem('sod_mock_db')!);
      db.memberships = db.memberships.filter((m: { id: string }) => m.id !== 'm9');
      localStorage.setItem('sod_mock_db', JSON.stringify(db));
      localStorage.setItem('sod_mock_session', JSON.stringify({ personId: 'p1', orgId: 'o1' }));
      localStorage.removeItem('sod_refreshed_at');
      localStorage.setItem('sod_mock_expire', 'TOKEN_STALE');
    });
    await page.fill('#p-name', 'Selin Aydın Yeni');
    await page.getByRole('button', { name: 'Kaydet' }).click();
    const bar = page.locator('.sod-status');
    await expect(bar).toContainText('Bu firmadaki üyeliğiniz sona erdi.');
    await expect(bar.getByRole('button', { name: /ile devam et/ })).toHaveCount(0);
    await bar.getByRole('button', { name: 'Örnek Firma firmasına geç' }).click();
    await expect(page).toHaveURL(/\/home/);
    await expect(page.locator('.sod-firm-n')).toHaveText('Örnek Firma');
    await expect(page.locator('.sod-status')).toHaveCount(0);
  });

  test('Etkinlik: ham anahtar yok, üyelik değişikliği neyi söyler', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/activity');
    const feed = page.locator('.hub-feed');
    await expect(feed).toContainText('DeciShip rolünü Denetleyici yaptı');
    await expect(feed).toContainText('telefonunu hesabına bağladı');
    await expect(feed).toContainText('şifresini kodla yeniledi');
    await expect(feed).not.toContainText('person.');
    await expect(feed).not.toContainText('üyeliği değiştirdi');
  });

  test('Firma: para birimi metni gerçeği söyler', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/company');
    await expect(page.getByLabel('Para birimi')).toBeVisible();
    await expect(page.getByText('Mevcut kayıtların tutarı ve para birimi değişmez, kur çevrilmez.')).toBeVisible();
    await expect(page.getByText('Abonelik para birimi')).toHaveCount(0);
    await expect(page.getByText('DeciShip ayarlarından')).toHaveCount(0);
    await page.screenshot({ path: 'screenshots/company-currency-1440.png' });
  });

  // Ayrı test: açık oturumun üstünde reset, sayfanın girişe yönlendirmesiyle goto'yu yarıştırır.
  test('kayıt: para birimi notu Firma ekranını gösterir, EN', async ({ page }) => {
    await reset(page, { lang: 'en' });
    await page.goto('/register');
    await page.getByLabel('Country').selectOption('DE');
    await expect(page.getByText('You can change it on the Company screen in Hub.')).toBeVisible();
    await expect(page.getByText('company settings')).toHaveCount(0);
    await page.screenshot({ path: 'screenshots/register-currency-en-1440.png' });
  });

  test('kayıt: ad sınıra dayanınca nasıl girilirse girilsin söylenir, TR ve EN', async ({ page }) => {
    await reset(page);
    await page.goto('/register');
    await page.locator('#org').fill('A'.repeat(162));
    await expect(page.locator('#org')).toHaveValue('A'.repeat(120));
    await expect(page.locator('#org-limit')).toHaveText('En çok 120 karakter alınır, fazlası eklenmez. Metni kontrol edin.');
    await expect(page.locator('#org')).toHaveAttribute('aria-describedby', 'org-limit');
    await page.screenshot({ path: 'screenshots/register-limit-1440.png' });
    await page.locator('#name').fill('B'.repeat(162));
    await expect(page.locator('#name-limit')).toBeVisible();
    await page.locator('#org').fill('Kısa Firma');
    await expect(page.locator('#org-limit')).toHaveCount(0);
    await reset(page, { lang: 'en' });
    await page.goto('/register');
    await page.locator('#org').fill('A'.repeat(162));
    await expect(page.locator('#org-limit')).toHaveText('At most 120 characters; anything longer is left out. Please check the text.');
  });

  test('çalışan sayfası mağaza satırını söyler, TR ve EN', async ({ page }) => {
    await reset(page);
    await login(page, USERS.measure);
    await page.goto('/account/tool-access/deciship');
    await expect(page.getByText('Uygulama henüz mağazada yok, iOS sürümü de yok. Kurulum dosyasını yöneticinizden isteyin.')).toBeVisible();
    await page.screenshot({ path: 'screenshots/tool-access-measure-1440.png' });
    await page.evaluate(() => {
      document.cookie = 'sod_lang=en; Path=/';
      const db = JSON.parse(localStorage.getItem('sod_mock_db')!);
      db.persons.forEach((p: { locale?: string }) => (p.locale = 'en'));
      localStorage.setItem('sod_mock_db', JSON.stringify(db));
      sessionStorage.clear();
    });
    await page.goto('/account/tool-access/deciship');
    await expect(page.getByText('The app is not in the stores yet and there is no iOS version. Ask your admin for the install file.')).toBeVisible();
  });

  test('Ekip: pencereye dönünce katılan kişi görünür; yenileme düşerse liste kalır', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/team');
    await expect(page.locator('.d9-matrix-wrap')).toBeVisible();
    await expect(page.getByText('Yeni Katılan')).toHaveCount(0);
    await page.evaluate(() => {
      const db = JSON.parse(localStorage.getItem('sod_mock_db')!);
      const me = db.memberships[0];
      const person = db.persons.find((p: { id: string }) => p.id === me.personId);
      db.persons.push({ ...person, id: 'p-yeni', name: 'Yeni Katılan', email: 'yeni-katilan@ornek.test', phone: null });
      db.memberships.push({ ...me, id: 'm-yeni', personId: 'p-yeni', orgRole: 'MEMBER' });
      localStorage.setItem('sod_mock_db', JSON.stringify(db));
    });
    // Odak dönmeden kendiliğinden yenilenmez: zamanlayıcı yok.
    await page.waitForTimeout(500);
    await expect(page.getByText('Yeni Katılan')).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByText('Yeni Katılan').first()).toBeVisible();
    // Yenileme başarısızsa son liste ekranda kalır.
    await page.evaluate(() => localStorage.setItem('sod_mock_account_down', '1'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    // Sorgu bir kez yeniden dener: 1 sn beklemesi bitsin, hata durumu gerçekten oluşsun.
    await page.waitForTimeout(2500);
    await expect(page.getByText('Yeni Katılan').first()).toBeVisible();
    await page.evaluate(() => localStorage.removeItem('sod_mock_account_down'));
  });

  test('telefonda avatar menüsü açılıp kapanır, aria-expanded doğru; menü adı TR ve EN', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await reset(page);
    await login(page, USERS.owner);
    // D09: çekmece düğmesi yok. Menü bantta, adıyla okunur.
    await expect(page.locator('.sod-burger')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Merkez menüsü' })).toBeVisible();
    const av = page.locator('.sod-av');
    await expect(av).toHaveAttribute('aria-expanded', 'false');
    await av.click();
    await expect(page.locator('.sod-pop')).toBeVisible();
    await expect(av).toHaveAttribute('aria-expanded', 'true');
    await av.click();
    await expect(page.locator('.sod-pop')).toHaveCount(0);
    await expect(av).toHaveAttribute('aria-expanded', 'false');
    await page.evaluate(() => {
      const db = JSON.parse(localStorage.getItem('sod_mock_db')!);
      db.persons.forEach((p: { locale?: string }) => (p.locale = 'en'));
      localStorage.setItem('sod_mock_db', JSON.stringify(db));
      document.cookie = 'sod_lang=en; Path=/';
      sessionStorage.clear();
    });
    await page.goto('/home');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('navigation', { name: 'Hub menu' })).toBeVisible();
    await expect(av).toHaveAttribute('aria-label', /^User menu/);
    await av.click();
    await expect(page.getByRole('menu', { name: 'Account' })).toBeVisible();
  });

  test('bilinmeyen araç bulunamadı; oturum açıkken kayıt yönlendirir', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    // Tanınmayan anahtar ve açık olmayan (yakında) araç bulunamadı der.
    for (const url of ['/data/bilinmeyen', '/analytics/orderloom', '/data/orderloom']) {
      await page.goto(url);
      await expect(page.getByRole('heading', { level: 1 })).toContainText(/bulunamadı/i);
    }
    // TagPress `pilot` ve firmada aboneliği var: Veriler'i açılır.
    await page.goto('/data/tagpress');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Veriler');
    await page.goto('/register');
    await expect(page).toHaveURL(/\/home/);
  });

  // D09: firma seçici baş harf rozeti değil, adın kendisi (uzun ad kısalır, tamamı erişilebilir adda).
  test('firma seçici adı yazar, uzun ad taşmaz; seçicide araç rolü', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.evaluate(() => {
      const db = JSON.parse(localStorage.getItem('sod_mock_db')!);
      db.orgs.find((o: { id: string }) => o.id === 'o1').name = 'Akis İhracat Tekstil Ltd. Şti.';
      localStorage.setItem('sod_mock_db', JSON.stringify(db));
      sessionStorage.clear();
    });
    await page.reload();
    const button = page.getByRole('button', { name: 'Firma: Akis İhracat Tekstil Ltd. Şti.' });
    await expect(button.locator('.sod-firm-n')).toHaveText('Akis İhracat Tekstil Ltd. Şti.');
    const right = (await page.locator('.sod-av').boundingBox())!;
    const firm = (await button.boundingBox())!;
    expect(firm.x + firm.width).toBeLessThanOrEqual(right.x);
    await button.click();
    await expect(page.getByRole('menuitemradio', { name: /Akis İhracat/ })).toContainText('Firma sahibi · DeciShip: Yönetici');
  });

  test('Ekip sekmeleri ok tuşu, Home ve End ile gezilir; davet iptali önce sorar', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/team');
    const people = page.getByRole('tab', { name: /^Kişiler/ });
    const invites = page.getByRole('tab', { name: /^Davetler/ });
    await expect(people).toHaveAttribute('tabindex', '0');
    await expect(invites).toHaveAttribute('tabindex', '-1');
    await people.focus();
    await page.keyboard.press('ArrowRight');
    await expect(invites).toBeFocused();
    await expect(invites).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/tab=invites/);
    await page.keyboard.press('Home');
    await expect(people).toBeFocused();
    // Üçüncü sekme Roller (özel roller): End sona, oradan → başa döner.
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: /^Roller/ })).toBeFocused();
    await expect(page).toHaveURL(/tab=roles/);
    await page.keyboard.press('ArrowLeft');
    await expect(invites).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(people).toBeFocused();

    // Davet iptali: onay penceresi; Vazgeç daveti korur, onay iptal eder.
    await invites.click();
    const rows = page.locator('.d9-inv');
    await expect(rows.first()).toBeVisible();
    const before = await rows.count();
    await rows.first().getByRole('button', { name: /daveti için işlemler/ }).click();
    await page.getByRole('menuitem', { name: 'Daveti iptal et' }).click();
    const dialog = page.getByRole('dialog', { name: 'Davet iptal edilsin mi?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Vazgeç' }).click();
    await expect(dialog).toBeHidden();
    await expect(rows).toHaveCount(before);
    await rows.first().getByRole('button', { name: /daveti için işlemler/ }).click();
    await page.getByRole('menuitem', { name: 'Daveti iptal et' }).click();
    await dialog.getByRole('button', { name: 'Daveti iptal et' }).click();
    await expect(rows).toHaveCount(before - 1);
  });

  test('banda rağmen ikinci bildirim yok', async ({ page, context }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/account/team?tab=invites');
    await expect(page.locator('.d9-inv').first()).toBeVisible();
    const other = await context.newPage();
    await other.goto('/home');
    await other.getByRole('button', { name: /^Firma:/ }).click();
    await other.getByRole('menuitemradio', { name: /Örnek İhracat/ }).click();
    await expect(other.locator('.sod-firm-n')).toHaveText('Örnek İhracat Ltd.');
    await expect(page.locator('.sod-status')).toBeVisible();
    await page.locator('.d9-inv').first().getByRole('button', { name: /daveti için işlemler/ }).click();
    await page.getByRole('menuitem', { name: 'Daveti iptal et' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Daveti iptal et' }).click();
    await page.waitForTimeout(400);
    await expect(page.locator('.toast')).toHaveCount(0);
    await other.close();
  });
});

test.describe('kayıt: ülke', () => {
  const fill = async (page: Page, email: string) => {
    await page.fill('#org', 'Ülke Firma');
    await page.fill('#name', 'Ülke Kişi');
    await page.fill('#email', email);
    await page.fill('#pw', PASSWORD);
  };

  test('varsayılan Türkiye: firma TR, para birimi TRY, not yok', async ({ page }) => {
    await reset(page);
    await page.goto('/register');
    await expect(page.locator('#org-country')).toHaveValue('TR');
    await expect(page.getByText('Firma para birimi')).toHaveCount(0);
    await fill(page, 'ulke-tr@ornek.test');
    await page.getByRole('button', { name: 'Hesap aç' }).click();
    await expect(page).toHaveURL(/\/home/);
    await page.goto('/account/company');
    await expect(page.locator('#org-country')).toHaveValue('TR');
    await expect(page.locator('#org-currency')).toHaveValue('TRY');
  });

  // Ülke kuralı b6492dc: TR TRY, DE/NL/FR EUR, GB GBP, diğerleri USD. Not seçilen ülkenin para birimini söyler.
  for (const [code, currency] of [['DE', 'EUR'], ['US', 'USD']] as const) {
    test(`başka ülke (${code}): seçim gider, para birimi ${currency} ve söylenir`, async ({ page }) => {
      await reset(page);
      await page.goto('/register');
      await page.locator('#org-country').selectOption(code);
      await expect(page.getByText(`Firma para birimi ${currency} olur`)).toBeVisible();
      await fill(page, `ulke-${code.toLowerCase()}@ornek.test`);
      const sent = page.waitForRequest((r) => r.url().includes('/auth/register'));
      await page.getByRole('button', { name: 'Hesap aç' }).click();
      expect((await sent).postDataJSON().country).toBe(code);
      await expect(page).toHaveURL(/\/home/);
      await page.goto('/account/company');
      await expect(page.locator('#org-country')).toHaveValue(code);
      await expect(page.locator('#org-currency')).toHaveValue(currency);
    });
  }

  // Onaylı tasarım: "Firma bilgileri" grubunda
  // firma adı ve ülke alt alta, aynı hizada ve aynı genişlikte; yatay taşma yok.
  for (const width of [1440, 390]) {
    test(`firma adı ve ülke alt alta aynı hizada, ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await reset(page);
      await page.goto('/register');
      const group = page.getByRole('group', { name: 'Firma bilgileri' });
      await expect(group.locator('#org')).toBeVisible();
      await expect(group.locator('#org-country')).toBeVisible();
      const org = (await page.locator('#org').boundingBox())!;
      const country = (await page.locator('#org-country').boundingBox())!;
      expect(country.y).toBeGreaterThan(org.y + org.height);
      expect(Math.abs(country.x - org.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(country.width - org.width)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  }

  test('kayıt kapalıyken ülke görünmez; EN ülke adları', async ({ page }) => {
    await reset(page);
    await page.evaluate(() => localStorage.setItem('sod_mock_register_closed', '1'));
    await page.goto('/register');
    await expect(page.getByText('Yeni kayıtlar şu anda kapalı')).toBeVisible();
    await expect(page.locator('#org-country')).toHaveCount(0);

    await reset(page);
    await page.goto('/register?lang=en');
    await expect(page.locator('#org-country option:checked')).toHaveText('Türkiye');
    await expect(page.locator('#org-country').getByRole('option', { name: 'Germany' })).toHaveCount(1);
  });
});

test.describe('telefon: bant menüleri içeriğin önünde, dokununca çalışır', () => {
  for (const lang of ['tr', 'en'] as const) {
    const L = lang === 'tr' ? { org: /^Firma:/, user: /^Kullanıcı menüsü/, profile: 'Hesabım', other: 'English', otherLang: 'en', title: 'Selin Aydın' } : { org: /^Company:/, user: /^User menu/, profile: 'My account', other: 'Türkçe', otherLang: 'tr', title: 'Selin Aydın' };

    const opened = async (page: Page, path: string) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await reset(page, { lang });
      await login(page, USERS.owner);
      await page.evaluate((l) => {
        const db = JSON.parse(localStorage.getItem('sod_mock_db')!);
        db.persons.find((p: { id: string }) => p.id === 'p1').locale = l;
        localStorage.setItem('sod_mock_db', JSON.stringify(db));
        sessionStorage.clear();
      }, lang);
      await page.goto(path);
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      await expect(page.locator('.sod-band')).toBeVisible();
    };

    /** Menü kutusunun tamamı ekranda ve en üstte: banda binen kart örtmüyor. */
    const onTop = async (page: Page) => {
      const pop = page.locator('.sod-pop').first();
      await expect(pop).toBeVisible();
      const box = (await pop.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      const covered = await pop.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const pts = [[r.right - 6, r.top + 6], [r.right - 6, r.bottom - 6], [r.left + r.width / 2, r.top + r.height / 2]];
        return pts.filter(([x, y]) => !el.contains(document.elementFromPoint(x!, y!))).length;
      });
      expect(covered).toBe(0);
    };

    test(`${lang}: firma menüsü firmayı gerçekten değiştirir (Merkez)`, async ({ page }) => {
      await opened(page, '/home');
      await page.getByRole('button', { name: L.org }).click();
      await onTop(page);
      await page.getByRole('menuitemradio', { name: /Örnek İhracat/ }).click();
      await expect(page.locator('.sod-firm-n')).toHaveText('Örnek İhracat Ltd.');
    });

    test(`${lang}: dil (avatar menüsünde) dili gerçekten değiştirir (Merkez)`, async ({ page }) => {
      await opened(page, '/home');
      await page.getByRole('button', { name: L.user }).click();
      await onTop(page);
      await page.locator('.sod-pop-lang').click();
      await page.getByRole('menuitemradio', { name: L.other }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', L.otherLang);
    });

    test(`${lang}: kullanıcı menüsü Hesabım'a götürür (Merkez)`, async ({ page }) => {
      await opened(page, '/home');
      await page.getByRole('button', { name: L.user }).click();
      await onTop(page);
      await page.getByRole('menuitem', { name: L.profile }).click();
      await expect(page).toHaveURL(/\/account\/profile/);
      await expect(page.locator('.sod-band').getByRole('heading', { name: L.title, level: 1 })).toBeVisible();
      await expect(page.locator('.sod-dock')).toBeInViewport();
    });

    test(`${lang}: firma ve avatar menüsü DeciShip kabuğunda da önde`, async ({ page }) => {
      await opened(page, '/deciship/');
      for (const name of [L.org, L.user]) {
        await page.getByRole('button', { name }).click();
        await onTop(page);
        await page.keyboard.press('Escape');
        await expect(page.locator('.sod-pop')).toHaveCount(0);
      }
      await page.getByRole('button', { name: L.user }).click();
      await page.locator('.sod-pop-lang').click();
      await page.getByRole('menuitemradio', { name: L.other }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', L.otherLang);
    });
  }
});

test.describe('tur 2 küçükler', () => {
  test('kendi rolünü yükseltme "kaldırılır" demez', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.evaluate(() => {
      const db = JSON.parse(localStorage.getItem('sod_mock_db')!);
      db.memberships.find((m: { id: string }) => m.id === 'm1').productRoles.deciship = null;
      localStorage.setItem('sod_mock_db', JSON.stringify(db));
    });
    await page.goto('/account/team');
    await page.getByLabel('Selin Aydın DeciShip rolü').selectOption('ADMIN');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Yetkileriniz hemen genişler');
    await expect(dialog).not.toContainText('kaldırılır');
    await dialog.getByRole('button', { name: 'Vazgeç' }).click();
  });

  test('yapıştırılan firma adı kısaltılınca söylenir', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await reset(page);
    await page.goto('/register');
    await page.evaluate(() => navigator.clipboard.writeText('A'.repeat(137)));
    await page.locator('#org').focus();
    await page.keyboard.press('Control+V');
    await expect(page.locator('#org')).toHaveValue('A'.repeat(120));
    await expect(page.getByText('En çok 120 karakter')).toBeVisible();
    // Sığan metinde uyarı yok
    await page.locator('#org').fill('');
    await page.evaluate(() => navigator.clipboard.writeText('Kısa Firma'));
    await page.locator('#org').focus();
    await page.keyboard.press('Control+V');
    await expect(page.getByText('En çok 120 karakter')).toHaveCount(0);
  });
});

test('terim: Genel Bakış ve Analiz "İtiraz listesinde" der, DeciShip ile aynı', async ({ page }) => {
  await reset(page);
  await login(page, USERS.owner);
  await expect(page.locator('.hub-ledger-row', { hasText: 'İtiraz listesinde' })).toBeVisible();
  await expect(page.locator('.hub-ledger')).not.toContainText('Doğrulanan');
  await page.goto('/analytics/deciship?section=decisions');
  await expect(page.locator('.hub-section')).toContainText('İtiraz listesinde');
  await expect(page.locator('.hub-section')).not.toContainText('Doğrulan');
});

test.describe('Veriler: hazır koli seti', () => {
  test('sekme, sütunlar, CSV, boş arama; ilk görünümde sıra sütunu yok', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/data/deciship/box-presets');
    await expect(page.locator('.hub-datasets a[aria-current="page"]')).toHaveText('Hazır koliler');
    await expect(page.locator('.hub-table th')).toHaveText([/Hazır koli/, /Uzunluk/, /Genişlik/, /Yükseklik/, /Desi/, /Etkin/, /Kullanılan ölçüm/, /İşlemler/]);
    await expect(page.locator('.hub-table tbody tr').first()).toContainText('K1');
    await expect(await dataMenuItem(page, 'CSV indir')).toBeEnabled();
    await page.keyboard.press('Escape');
    await page.getByLabel('Durum').selectOption('no');
    await expect(page.locator('.hub-table tbody tr')).toHaveCount(1);
    await page.getByLabel('Durum').selectOption('');
    await page.fill('#hub-q', 'zzz-yok');
    await expect(page.getByText('Aramayla eşleşen kayıt yok')).toBeVisible();
    await expect(await dataMenuItem(page, 'CSV indir')).toBeDisabled();
  });

  test('yeni firmada boş durum', async ({ page }) => {
    await reset(page);
    await login(page, USERS.fresh);
    await page.goto('/data/deciship/box-presets');
    await expect(page.locator('.hub-datasets a[aria-current="page"]')).toHaveText('Hazır koliler');
    await expect(page.locator('.hub-table')).toHaveCount(0);
    await expect(await dataMenuItem(page, 'CSV indir')).toBeDisabled();
  });

  test('CSV dosyası ayraç, başlık ve satırlarla iner', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/data/deciship/box-presets');
    await expect(page.locator('.hub-table tbody tr').first()).toContainText('K1');
    const csv = await dataMenuItem(page, 'CSV indir');
    const [download] = await Promise.all([page.waitForEvent('download'), csv.click()]);
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    expect(text).toContain('K1');
    expect(text).toContain('Eski koli');
    expect(text.split(/\r?\n/).filter(Boolean).length).toBeGreaterThanOrEqual(5);
  });
});

test.describe('Veriler: etkin sekme telefonda görünür', () => {
  const VISIBLE_TAB = async (page: Page) =>
    page.locator('.hub-datasets').evaluate((bar) => {
      const tab = bar.querySelector('a[aria-current="page"]')!;
      const a = bar.getBoundingClientRect();
      const b = tab.getBoundingClientRect();
      return b.left >= a.left - 1 && b.right <= a.right + 1;
    });
  /** Şeridin scrollTo çağrılarını kaydeder: kaç kez ve hangi davranışla kaydırıldı. */
  const SPY = () => {
    const calls: string[] = [];
    (window as unknown as { __tabScroll: string[] }).__tabScroll = calls;
    const original = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function (this: Element, ...args: unknown[]) {
      if (this.classList.contains('hub-datasets')) calls.push(String((args[0] as ScrollToOptions).behavior));
      return (original as (...a: unknown[]) => void).apply(this, args);
    } as typeof Element.prototype.scrollTo;
  };
  const CALLS = (page: Page) => page.evaluate(() => (window as unknown as { __tabScroll: string[] }).__tabScroll);

  test('doğrudan adres: sekme görünür, sayfa dikey kaymaz, tek ve anında kayar', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(SPY);
    await reset(page);
    await login(page, USERS.owner);
    // Şerit ekranın altında kalsın: scrollIntoView sayfayı oynatsa burada yakalanır.
    await page.setViewportSize({ width: 390, height: 150 });
    await page.goto('/data/deciship/box-presets');
    await expect(page.locator('.hub-table tbody tr').first()).toContainText('K1');
    expect(await VISIBLE_TAB(page)).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await CALLS(page)).toEqual(['instant']);
    // Arama ve yeniden çizim şeridi yeniden kaydırmaz.
    await page.fill('#hub-q', 'K1');
    await expect(page.locator('.hub-table tbody tr')).toHaveCount(1);
    expect(await CALLS(page)).toEqual(['instant']);
  });

  test('sekme değişimi yumuşak kayar', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(SPY);
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/data/deciship/invoices');
    await expect(page.locator('.hub-table tbody tr').first()).toBeVisible();
    expect(await CALLS(page)).toEqual([]);
    await page.locator('.hub-datasets a').filter({ hasText: 'Tarifeler' }).click();
    await expect(page.locator('.hub-datasets a[aria-current="page"]')).toHaveText('Tarifeler');
    await expect.poll(() => VISIBLE_TAB(page)).toBe(true);
    expect(await CALLS(page)).toEqual(['smooth']);
  });

  test('azaltılmış harekette anında kayar', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(SPY);
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/data/deciship/invoices');
    await expect(page.locator('.hub-table tbody tr').first()).toBeVisible();
    await page.locator('.hub-datasets a').filter({ hasText: 'Tarifeler' }).click();
    await expect(page.locator('.hub-datasets a[aria-current="page"]')).toHaveText('Tarifeler');
    expect(await VISIBLE_TAB(page)).toBe(true);
    expect(await CALLS(page)).toEqual(['instant']);
  });
});

test.describe('araç seçici', () => {
  const picker = (page: Page) => page.getByRole('navigation', { name: 'Araca göre' });

  test('Genel Bakış: Tümü yok, ilk açık araç seçili; araç adreste, yenileme ve geri/ileri korur', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    // Kullanıcı kararı (13 Kasım): Genel Bakış'ta "Tümü" yok; seçim yoksa ilk açık araç.
    await expect(picker(page).getByRole('link', { name: 'Tümü' })).toHaveCount(0);
    await expect(picker(page).getByRole('link', { name: 'DeciShip' })).toHaveAttribute('aria-current', 'page');
    await picker(page).getByRole('link', { name: 'DeciShip' }).click();
    await expect(page).toHaveURL(/\/home\?tool=deciship$/);
    await expect(picker(page).getByRole('link', { name: 'DeciShip' })).toHaveAttribute('aria-current', 'page');
    // Araç listesi her zaman altta (eskiden yalnız Tümü'ndeydi; özellik kaybolmasın). Yönetim paneli bantta ikincil düğme.
    await expect(page.getByRole('heading', { name: 'Araçlar' })).toBeVisible();
    await expect(page.locator('.pactions .btn-primary')).toHaveCount(0);
    await expect(page.locator('.pactions').getByRole('link', { name: 'Yönetim panelini aç' })).toHaveClass(/\bbtn-secondary\b/);
    await page.reload();
    await expect(picker(page).getByRole('link', { name: 'DeciShip' })).toHaveAttribute('aria-current', 'page');
    await page.goBack();
    await expect(page).toHaveURL(/\/home$/);
    await expect(picker(page).getByRole('link', { name: 'DeciShip' })).toHaveAttribute('aria-current', 'page');
    await page.goForward();
    await expect(page).toHaveURL(/\/home\?tool=deciship$/);
  });

  test('yakında araçlar seçilemez; bilinmeyen ?tool ilk açık araç sayılır', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    for (const name of ['OrderLoom']) {
      const item = picker(page).locator('[aria-disabled="true"]', { hasText: name });
      await expect(item).toContainText('Yakında');
      await expect(item).not.toHaveAttribute('href');
    }
    // Bağlantılar açık araçlar: DeciShip ve pilot TagPress (sahte API'de abonelik var). Genel Bakış'ta Tümü yok.
    await expect(picker(page).getByRole('link', { name: 'TagPress' })).toHaveAttribute('href', '/home?tool=tagpress');
    expect(await picker(page).locator('a[href]').count()).toBe(2);
    await page.goto('/home?tool=orderloom');
    await expect(picker(page).getByRole('link', { name: 'DeciShip' })).toHaveAttribute('aria-current', 'page');
  });

  test('Yönetim panelini aç /deciship/ adresine gider', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    const open = page.locator('.pactions').getByRole('link', { name: 'Yönetim panelini aç' });
    await expect(open).toHaveAttribute('href', '/deciship/');
    await picker(page).getByRole('link', { name: 'DeciShip' }).click();
    await expect(page.locator('.pactions').getByRole('link', { name: 'Yönetim panelini aç' })).toHaveAttribute('href', '/deciship/');
  });

  test('Analiz: tek ayrı seçici, Tümü ve DeciShip adreste', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.goto('/analytics');
    await expect(page).toHaveURL(/\/analytics$/);
    await expect(page.getByRole('navigation', { name: 'Araca göre' })).toHaveCount(1);
    await expect(picker(page).getByRole('link', { name: 'Tümü' })).toHaveAttribute('aria-current', 'page');
    await picker(page).getByRole('link', { name: 'DeciShip' }).click();
    await expect(page).toHaveURL(/\/analytics\/deciship/);
    await expect(picker(page).getByRole('link', { name: 'DeciShip' })).toHaveAttribute('aria-current', 'page');
    // Yalnız OrderLoom yakında; pilot TagPress (firmada aboneliği var) seçilebilir.
    await expect(picker(page).locator('[aria-disabled="true"]')).toHaveCount(1);
    await expect(picker(page).locator('[aria-disabled="true"]')).toContainText('OrderLoom');
    await expect(picker(page).getByRole('link', { name: 'TagPress' })).toHaveAttribute('href', '/analytics/tagpress');
  });

  test("Analiz 403: Genel Bakış'a atmaz, kilit ekranı gösterir", async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.evaluate(() => localStorage.setItem('sod_mock_fail', JSON.stringify(['deciship.analytics.403'])));
    await page.goto('/analytics/deciship');
    await expect(page.getByText('Bu sayfayı göremezsiniz')).toBeVisible();
    await expect(page).toHaveURL(/\/analytics\/deciship/);
    await page.getByRole('link', { name: "Genel Bakış'a dön" }).click();
    await expect(page).toHaveURL(/\/home/);
  });

  test('English: seçici ve yönetim paneli metni', async ({ page }) => {
    await reset(page);
    await login(page, USERS.owner);
    await page.evaluate(() => {
      document.cookie = 'sod_lang=en; Path=/';
      const db = JSON.parse(localStorage.getItem('sod_mock_db')!);
      db.persons.forEach((p: { locale?: string }) => (p.locale = 'en'));
      localStorage.setItem('sod_mock_db', JSON.stringify(db));
      sessionStorage.clear();
    });
    await page.goto('/home');
    const byTool = page.getByRole('navigation', { name: 'By tool' });
    await expect(byTool.getByRole('link', { name: 'DeciShip' })).toHaveAttribute('aria-current', 'page');
    await expect(byTool.getByRole('link', { name: 'All' })).toHaveCount(0);
    await expect(page.locator('.pactions').getByRole('link', { name: 'Open admin panel' })).toHaveAttribute('href', '/deciship/');
  });

  test('390 px: yatay taşma yok, seçici kaydırılabilir', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await reset(page);
    await login(page, USERS.owner);
    for (const url of ['/home', '/home?tool=deciship', '/analytics', '/analytics/deciship']) {
      await page.goto(url);
      await expect(picker(page)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    }
  });
});
