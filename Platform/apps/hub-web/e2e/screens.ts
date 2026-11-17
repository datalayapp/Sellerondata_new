import { test, expect, type Page } from './base.ts';
import path from 'node:path';
import { login, reset, USERS } from './helpers.ts';

/*
 * Ekran görüntüsü üreticisi. `npm run screens`. Dosyalar: screenshots/<ad>-<genişlik>.png (EN: -en son eki).
 * Hazır beklemesi: yükleme iskeleti kalmayana kadar.
 */
const OUT = path.resolve(import.meta.dirname, '../screenshots');
const WIDTHS = [1440, 1024, 390];

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.skel')).toHaveCount(0, { timeout: 8000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
}

async function shoot(page: Page, name: string, fullPage = true, widths = WIDTHS) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await settle(page);
    await page.screenshot({ path: path.join(OUT, `${name}-${width}.png`), fullPage });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

const PAGES: [string, string][] = [
  ['home', '/home'],
  ['analytics', '/analytics/deciship'],
  ['data', '/data/deciship/invoice-lines'],
  ['activity', '/activity'],
  ['team', '/account/team'],
  ['company', '/account/company'],
  ['billing', '/account/billing'],
  ['profile', '/account/profile'],
  ['security', '/account/security'],
  ['firms', '/account/firms'],
];

test('sahip: tüm sayfalar TR', async ({ page }) => {
  await reset(page);
  await login(page, USERS.owner);
  for (const [name, url] of PAGES) {
    await page.goto(url);
    await shoot(page, name);
  }
  await page.goto('/orderloom');
  await shoot(page, 'orderloom-soon', false);
  // Analiz ilk ekranı (tam sayfa değil): yapışkan bölüm çubuğu dahil
  await page.goto('/analytics/deciship');
  await shoot(page, 'analytics-first-screen', false);
});

test('sahip: ana sayfalar EN', async ({ page }) => {
  await reset(page);
  await login(page, USERS.owner);
  await page.evaluate(async () => {
    await fetch('/api/account/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-SOD-CSRF': '1' }, body: JSON.stringify({ locale: 'en' }) });
    document.cookie = 'sod_lang=en; Path=/';
    sessionStorage.clear();
  });
  for (const [name, url] of PAGES) {
    await page.goto(url);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await shoot(page, `${name}-en`);
  }
});

test('yetki ve ilk gün EN', async ({ page }) => {
  const toEnglish = async () => {
    await page.evaluate(async () => {
      await fetch('/api/account/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-SOD-CSRF': '1' }, body: JSON.stringify({ locale: 'en' }) });
    });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  };
  await reset(page, { lang: 'en' });
  await login(page, USERS.fresh);
  await toEnglish();
  await expect(page.locator('.hub-start-list').first()).toBeVisible();
  await shoot(page, 'start-en', false);
  await page.goto('/analytics/deciship');
  await shoot(page, 'start-analytics-en', false);

  await reset(page, { lang: 'en' });
  await login(page, USERS.owner);
  await toEnglish();
  await page.goto('/account/team');
  await page.getByLabel('Zeynep Arslan DeciShip role').selectOption('');
  await expect(page.getByRole('dialog')).toBeVisible();
  await shoot(page, 'team-confirm-en', false, [1440, 1024]);
});

test('ölçüm rolü, kurulum, hata ve davet durumları', async ({ page }) => {
  await reset(page);
  await login(page, USERS.measure);
  await shoot(page, 'measure-home', false);
  await page.goto('/account/tool-access/deciship');
  await shoot(page, 'measure-tool', false);

  await reset(page);
  await login(page, USERS.fresh);
  await shoot(page, 'home-setup', false);

  await reset(page);
  await login(page, USERS.noOrg);
  await shoot(page, 'no-company', false);

  await reset(page);
  await login(page, USERS.measure);
  await page.goto('/account/firms');
  await shoot(page, 'firms-leave-noemail');

  // Kalabalık ekip
  await reset(page);
  await login(page, USERS.owner);
  await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('sod_mock_db')!);
    for (let i = 8; i < 56; i += 1) {
      db.persons.push({ id: `px${i}`, name: `Çalışan Uzunsoyadlıoğlu ${i}`, email: i % 2 ? `calisan.uzun.${i}@ornek.test` : null, phone: i % 2 ? null : `+9053200010${i}`, locale: 'tr', emailVerified: !!(i % 2), password: 'Test12345!', otherOrgs: 0 });
      db.memberships.push({ id: `mx${i}`, personId: `px${i}`, orgId: 'o1', orgRole: 'MEMBER', status: i % 7 === 0 ? 'SUSPENDED' : 'ACTIVE', lastActiveAt: new Date(Date.now() - i * 3600000).toISOString(), productRoles: { deciship: ['ADMIN', 'AUDITOR', 'ACCOUNTING', 'MEASURE', null][i % 5] } });
    }
    localStorage.setItem('sod_mock_db', JSON.stringify(db));
  });
  await page.goto('/account/team');
  await shoot(page, 'team-many', false);

  // Yetki onayı ve geri al
  await reset(page);
  await login(page, USERS.owner);
  await page.goto('/account/team');
  await page.getByLabel('Can Yıldız DeciShip rolü').selectOption('AUDITOR');
  await expect(page.locator('.toast').first()).toBeVisible();
  await shoot(page, 'team-undo', false);
  await page.getByLabel('Zeynep Arslan DeciShip rolü').selectOption('');
  await expect(page.getByRole('dialog')).toBeVisible();
  // Genişlik değişince tablo karta döner ve açık onay kapanır: telefonda onay testte sınanır.
  await shoot(page, 'team-confirm', false, [1440, 1024]);

  // İlk gün
  await reset(page);
  await login(page, USERS.fresh);
  await expect(page.locator('.hub-start-list').first()).toBeVisible();
  await shoot(page, 'start', false);
  await page.goto('/analytics/deciship');
  await shoot(page, 'start-analytics', false);

  // Hazır koli veri seti
  await reset(page);
  await login(page, USERS.owner);
  await page.goto('/data/deciship/box-presets');
  await expect(page.locator('.hub-table tbody tr').first()).toBeVisible();
  await shoot(page, 'data-box-presets', true, [1440, 1024]);
  // Telefon görüntüsü doğrudan açılışla: genişlik küçültmek etkin sekmeyi kaydırmaz, gerçek açılış böyle görünür.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/data/deciship/box-presets');
  await expect(page.locator('.hub-table tbody tr').first()).toBeVisible();
  await shoot(page, 'data-box-presets', true, [390]);

  // Telefon: ray menüsü panelin önünde
  await reset(page);
  await login(page, USERS.owner);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /^Firma:/ }).click();
  await expect(page.locator('.sod-pop').first()).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'mobile-org-menu-390.png') });
  await page.keyboard.press('Escape');
  // Dil artık kullanıcı menüsünde tek satır; menüyü açıp satırı genişletir.
  await page.getByRole('button', { name: /^Kullanıcı menüsü/ }).click();
  await page.locator('.sod-pop-lang').click();
  await expect(page.locator('.sod-pop').first()).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'mobile-lang-menu-390.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Kullanıcı menüsü/ }).click();
  await expect(page.locator('.sod-pop').first()).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'mobile-user-menu-390.png') });
  await page.setViewportSize({ width: 1440, height: 900 });

  // Oturum uyarıları: bağlantı yok, firma başka sekmede değişti
  await reset(page);
  await login(page, USERS.owner);
  await page.goto('/account/company');
  await page.fill('#org-name', 'Yazılı ad duruyor');
  await page.evaluate(() => localStorage.setItem('sod_mock_offline', '1'));
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.locator('.sod-status')).toBeVisible();
  await shoot(page, 'session-offline', false);
  await page.evaluate(() => localStorage.removeItem('sod_mock_offline'));

  await reset(page);
  await login(page, USERS.owner);
  await page.goto('/account/company');
  await page.fill('#org-name', 'Yazılı ad duruyor');
  const other = await page.context().newPage();
  await other.goto('/home');
  await other.getByRole('button', { name: /^Firma:/ }).click();
  await other.getByRole('menuitemradio', { name: /Örnek İhracat/ }).click();
  await expect(page.locator('.sod-status')).toBeVisible();
  await other.close();
  await shoot(page, 'session-org', false);

  await reset(page, { fail: ['deciship.overview'] });
  await login(page, USERS.owner);
  await shoot(page, 'home-section-error', false);

  await reset(page);
  await login(page, USERS.owner);
  await page.goto('/account/team');
  await settle(page);
  await page.getByRole('button', { name: 'Kişi davet et' }).click();
  await shoot(page, 'team-invite', false);
  await page.fill('#inv-name', 'Örnek Çalışan');
  await page.fill('#inv-contact', '0532 000 00 21');
  await page.getByRole('button', { name: 'Kod üret', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Bu kod bir daha gösterilmez');
  await shoot(page, 'team-code', false);
});

test('giriş sayfaları', async ({ page }) => {
  await reset(page);
  for (const [name, url] of [
    ['login', '/login'],
    ['register', '/register'],
    ['join', '/join'],
    ['forgot', '/forgot-password'],
    ['invite', '/invite/ornek-davet'],
  ] as const) {
    await page.goto(url);
    await shoot(page, name, false);
  }
});
