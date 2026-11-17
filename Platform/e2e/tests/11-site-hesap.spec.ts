// Tek hesap: tanıtım sitesi, Merkez, DeciShip ve mobil aynı hesabı kullanır; site bu hesaba bağlıdır (ARCHITECTURE §5 "Tek hesap").
// Site kimlik bilgisi almaz: kayıt ve giriş uygulamadadır. Site yalnız "kimim" yoklaması ve çıkış için uygulamaya gider.
import type { Page } from '@playwright/test';
import { test, expect } from '../lib/fixtures.ts';
import { MobileApi, PASSWORD, registerOwner, WebApi, type Owner } from '../lib/api.ts';
import { APP, SITE, uniq } from '../lib/sys.ts';

const SESSION_URL = `${APP}/api/account/auth/site-session`;

/** Sayfa açılışındaki yoklamanın yanıtını bekleyerek siteye gider. */
async function openSite(page: Page, path = '/') {
  const probed = page.waitForResponse((r) => r.url() === SESSION_URL && r.request().method() === 'GET');
  await page.goto(SITE + path);
  const res = await probed;
  expect(res.status()).toBe(200);
  return res;
}

/** Üst çubuğun kendi bağlantısı (profil panelinin içindekiler değil). */
const topLink = (page: Page, name: string) => page.locator('header.top .top-r > a').filter({ hasText: new RegExp(`^${name}$`) });
const acctSummary = (page: Page) => page.locator('details.acct > summary');
const panel = (page: Page) => page.locator('details.acct .acct-panel');
const L = {
  tr: { login: 'Giriş', register: 'Hesap aç', hub: "Merkez'e git" },
  en: { login: 'Sign in', register: 'Create account', hub: 'Go to Hub' },
};

async function expectSignedOut(page: Page, lang: 'tr' | 'en' = 'tr') {
  await expect(page.locator('body')).not.toHaveAttribute('data-session', 'in');
  await expect(topLink(page, L[lang].login)).toBeVisible();
  await expect(topLink(page, L[lang].register)).toBeVisible();
  await expect(topLink(page, L[lang].hub)).toBeHidden();
}

async function expectSignedIn(page: Page, lang: 'tr' | 'en' = 'tr') {
  await expect(page.locator('body')).toHaveAttribute('data-session', 'in');
  await expect(topLink(page, L[lang].hub)).toBeVisible();
  await expect(topLink(page, L[lang].login)).toBeHidden();
  await expect(topLink(page, L[lang].register)).toBeHidden();
}

/** Bu firmaya e-posta davetiyle MEMBER ekler (davet kabulü web oturumu açar). */
async function addMember(owner: Owner, name: string) {
  const email = `${uniq('uye')}@e2e.sellerondata.test`;
  const inv = await owner.api.post<{ link: string }>('/api/account/org/members/invite', { kind: 'EMAIL', email, name, orgRole: 'MEMBER', productRoles: { deciship: 'AUDITOR' } });
  const token = new URL(inv.link).pathname.split('/').pop()!;
  const api = await WebApi.create();
  await api.post(`/api/account/invites/${token}/accept`, { name, password: PASSWORD, client: 'web' });
  await api.me();
  return { api, email };
}

test.describe('Tek hesap: site, Merkez, araçlar', () => {
  test('site varsayılan olarak giriş yapılmamış; yoklama jeton ve çerez döndürmez', async ({ page }) => {
    const res = await openSite(page);
    expect(await res.json()).toEqual({ signedIn: false });
    expect(res.headers()['set-cookie']).toBeUndefined();
    expect(res.headers()['access-control-allow-origin']).toBe(SITE);
    await expectSignedOut(page);
    // Sitede kimlik bilgisi alanı yok.
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await acctSummary(page).click();
    await expect(panel(page).getByRole('link', { name: 'Hesap aç', exact: true })).toBeVisible();
    await expect(panel(page).getByRole('link', { name: 'Giriş yap', exact: true })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Çıkış yap' })).toBeHidden();
  });

  test('siteden kayıt -> /home; site "Merkez\'e git" ve ad + firma gösterir; aynı hesap DeciShip ve mobilde; siteden çıkış oturumu düşürür', async ({ page }) => {
    await openSite(page);
    await topLink(page, 'Hesap aç').click();
    // Mesaj 15: site her uygulama bağlantısına kendi dilini koyar (TR sitede ?lang=tr); DeciShip bağlantısı hariç.
    await expect(page).toHaveURL(`${APP}/register?lang=tr`);
    const orgName = `Tek Hesap Lojistik ${uniq('')}`;
    const email = `${uniq('tekhesap')}@e2e.sellerondata.test`;
    await page.getByLabel('Firma adı').fill(orgName);
    await page.getByLabel('Ad soyad').fill('Ayşe Yılmaz');
    await page.getByLabel('E-posta').fill(email);
    await page.getByLabel('Şifre', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Hesap aç' }).click();
    await expect(page).toHaveURL(`${APP}/home`);
    await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();

    // Siteye dönüş: giriş yapılmış hal.
    const res = await openSite(page);
    expect(await res.json()).toEqual({ signedIn: true, name: 'Ayşe Yılmaz', orgName, canManageOrg: true });
    await expectSignedIn(page);
    await expect(acctSummary(page).locator('.acct-ini')).toHaveText('AY');
    await acctSummary(page).click();
    await expect(panel(page).locator('[data-sod="name"]')).toHaveText('Ayşe Yılmaz');
    await expect(panel(page).locator('[data-sod="org"]')).toHaveText(orgName);
    await expect(panel(page).getByRole('link', { name: "Merkez'e git" })).toHaveAttribute('href', `${APP}/home?lang=tr`);
    await expect(panel(page).getByRole('link', { name: 'Hesabım' })).toHaveAttribute('href', `${APP}/account/profile?lang=tr`);
    await expect(panel(page).getByRole('link', { name: 'Güvenlik' })).toHaveAttribute('href', `${APP}/account/security?lang=tr`);
    await expect(panel(page).getByRole('link', { name: 'Firmalarım' })).toHaveAttribute('href', `${APP}/account/firms?lang=tr`);
    await expect(panel(page).getByRole('link', { name: 'Firma ve ekip' })).toHaveAttribute('href', `${APP}/account/team?lang=tr`);
    await expect(panel(page).getByRole('link', { name: 'Giriş yap', exact: true })).toBeHidden();
    // Giriş yapılmışken panelde "Dil" satırı var (çıkışın hemen üstünde). Giriş yapılmamış gövdenin de kendi (gizli) dil satırı
    // vardır: giriş yapılmış gövdeye (`.acct-me`) bakılır.
    const lang = panel(page).locator('.acct-me .acct-lang > summary');
    await expect(lang).toBeVisible();
    await expect(lang).toContainText('Dil');
    await expect(panel(page).locator('.acct-me .acct-lang + .acct-logout')).toBeVisible();

    // "Merkez'e git" Merkez'i açar, giriş istemez.
    await page.keyboard.press('Escape');
    await topLink(page, "Merkez'e git").click();
    await expect(page).toHaveURL(`${APP}/home?lang=tr`);
    await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();

    // Aynı hesap DeciShip web'de.
    await page.goto('/deciship/setup');
    await expect(page.getByRole('heading', { name: 'İlk kurulum' })).toBeVisible();

    // Aynı e-posta ve şifre mobilde.
    const mobile = await MobileApi.login(email, PASSWORD);
    const me = await mobile.get('/api/account/me');
    expect(me.status).toBe(200);
    expect(me.body.person.email).toBe(email);
    expect(me.body.activeOrg.name).toBe(orgName);
    expect((await mobile.get('/api/deciship/settings/onboarding')).status).toBe(200);

    // Siteden çıkış: site giriş yapılmamışa döner, uygulama oturumu gerçekten düşer.
    await openSite(page);
    await expectSignedIn(page);
    await acctSummary(page).click();
    const logout = page.waitForResponse((r) => r.url() === `${APP}/api/account/auth/logout` && r.request().method() === 'POST');
    await panel(page).getByRole('button', { name: 'Çıkış yap' }).click();
    expect((await logout).status()).toBe(200);
    await expectSignedOut(page);
    await expect(panel(page).getByRole('link', { name: 'Giriş yap', exact: true })).toBeVisible();
    await expect(panel(page).locator('[data-sod="logout-error"]')).toBeHidden();

    await page.goto('/home');
    await expect(page).toHaveURL(/\/login/);
    // Mobil oturum ayrı cihazdır, siteden çıkış onu düşürmez.
    expect((await mobile.get('/api/account/me')).status).toBe(200);
    await mobile.dispose();
  });

  test("Merkez'den çıkış: site sekmeye dönünce giriş yapılmamışa geçer", async ({ openAs }) => {
    const owner = await registerOwner({ name: 'Mert Kaya' });
    const site = await openAs(owner.api);
    await openSite(site);
    await expectSignedIn(site);
    await expect(acctSummary(site).locator('.acct-ini')).toHaveText('MK');

    const hub = await site.context().newPage();
    await hub.goto(APP + '/home');
    await expect(hub.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();
    await hub.getByRole('button', { name: /Kullanıcı menüsü/ }).click();
    await hub.getByRole('menuitem', { name: 'Çıkış yap' }).click();
    await expect(hub).toHaveURL(/\/login/);

    // Kullanıcı site sekmesine döner (görünürlük olayı): yoklama yinelenir.
    const probed = site.waitForResponse((r) => r.url() === SESSION_URL);
    await site.bringToFront();
    await site.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(await (await probed).json()).toEqual({ signedIn: false });
    await expectSignedOut(site);
  });

  test('başka cihazdan oturum kapatma (mobil, DELETE /me/sessions/:id): site giriş yapılmamışa döner', async ({ openAs }) => {
    const owner = await registerOwner();
    const site = await openAs(owner.api);
    await openSite(site);
    await expectSignedIn(site);

    const mobile = await MobileApi.login(owner.email, owner.password);
    const sessions = (await mobile.get('/api/account/me/sessions')).body as { sessions: { id: string; client: string; current: boolean }[] };
    const web = sessions.sessions.filter((s) => s.client === 'web');
    expect(web.length).toBe(1);
    expect((await mobile.del(`/api/account/me/sessions/${web[0]!.id}`)).status).toBe(200);
    await mobile.dispose();

    // Geri/ileri önbellekten dönüş gibi: pageshow (persisted) yeniden yoklar.
    const probed = site.waitForResponse((r) => r.url() === SESSION_URL);
    await site.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    expect(await (await probed).json()).toEqual({ signedIn: false });
    await expectSignedOut(site);
    // Sayfa yeniden açılınca da öyle.
    await openSite(site);
    await expectSignedOut(site);
  });

  test('EN sitede panel EN, uygulama bağlantıları ?lang=en', async ({ openAs }) => {
    const owner = await registerOwner({ name: 'Jane Doe', locale: 'en' });
    const site = await openAs(owner.api, 'en-US');
    await openSite(site, '/en/');
    await expectSignedIn(site, 'en');
    await expect(topLink(site, 'Go to Hub')).toHaveAttribute('href', `${APP}/home?lang=en`);
    await acctSummary(site).click();
    await expect(panel(site).locator('[data-sod="name"]')).toHaveText('Jane Doe');
    await expect(panel(site).getByRole('link', { name: 'Go to Hub' })).toHaveAttribute('href', `${APP}/home?lang=en`);
    await expect(panel(site).getByRole('link', { name: 'My account' })).toHaveAttribute('href', `${APP}/account/profile?lang=en`);
    await expect(panel(site).getByRole('link', { name: 'Security' })).toHaveAttribute('href', `${APP}/account/security?lang=en`);
    await expect(panel(site).getByRole('link', { name: 'My companies' })).toHaveAttribute('href', `${APP}/account/firms?lang=en`);
    await expect(panel(site).getByRole('link', { name: 'Company and team' })).toHaveAttribute('href', `${APP}/account/team?lang=en`);
    await expect(panel(site).getByRole('button', { name: 'Sign out' })).toBeVisible();
    const text = await panel(site).innerText();
    expect(text).not.toMatch(/Merkez|Hesabım|Güvenlik|Firmalarım|Firma ve ekip|Çıkış/);

    await panel(site).getByRole('link', { name: 'Go to Hub' }).click();
    await expect(site).toHaveURL(`${APP}/home?lang=en`);
    await expect(site.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  });

  test('MEMBER rolünde "Firma ve ekip" görünmez, firma adı görünür', async ({ openAs }) => {
    const owner = await registerOwner();
    const member = await addMember(owner, 'Deniz Üye');
    const site = await openAs(member.api);
    const res = await openSite(site);
    expect(await res.json()).toEqual({ signedIn: true, name: 'Deniz Üye', orgName: owner.orgName, canManageOrg: false });
    await expectSignedIn(site);
    await acctSummary(site).click();
    await expect(panel(site).locator('[data-sod="org"]')).toHaveText(owner.orgName);
    await expect(panel(site).getByRole('link', { name: 'Hesabım' })).toBeVisible();
    await expect(panel(site).getByRole('link', { name: 'Firma ve ekip' })).toBeHidden();
    await expect(panel(site).getByRole('button', { name: 'Çıkış yap' })).toBeVisible();
  });

  test('mobil menüde giriş yapılmışken "Merkez\'e git", değilken "Giriş yap" ve "Hesap aç"', async ({ openAs, freshPage }) => {
    const anon = await freshPage();
    await anon.setViewportSize({ width: 390, height: 844 });
    await openSite(anon);
    await anon.locator('details.burger > summary').click();
    const sheetOut = anon.locator('details.burger .sheet');
    await expect(sheetOut.getByRole('link', { name: 'Giriş yap', exact: true })).toBeVisible();
    await expect(sheetOut.getByRole('link', { name: 'Hesap aç', exact: true })).toBeVisible();
    await expect(sheetOut.getByRole('link', { name: "Merkez'e git", exact: true })).toBeHidden();

    const owner = await registerOwner();
    const site = await openAs(owner.api, 'tr-TR', { width: 390, height: 844 });
    await openSite(site);
    await expect(site.locator('body')).toHaveAttribute('data-session', 'in');
    await expect(acctSummary(site).locator('.acct-ini')).toBeVisible();
    await site.locator('details.burger > summary').click();
    const sheet = site.locator('details.burger .sheet');
    await expect(sheet.getByRole('link', { name: "Merkez'e git", exact: true })).toBeVisible();
    await expect(sheet.getByRole('link', { name: 'Giriş yap', exact: true })).toBeHidden();
    await expect(sheet.getByRole('link', { name: 'Hesap aç', exact: true })).toBeHidden();
  });

  test("DeciShip ürün sayfasında giriş yapılmışken DeciShip'i aç /deciship/ adresine gider, değilken kayıt", async ({ openAs, freshPage }) => {
    const anon = await freshPage();
    await openSite(anon, '/urunler/deciship/');
    await expect(anon.locator('main a[data-auth="out"]').first()).toHaveAttribute("href", `${APP}/register?lang=tr`);
    await expect(anon.getByRole('link', { name: "DeciShip'i aç" })).toHaveCount(0);

    const owner = await registerOwner();
    const site = await openAs(owner.api);
    await openSite(site, '/urunler/deciship/');
    await expectSignedIn(site);
    const open = site.locator('main').getByRole('link', { name: "DeciShip'i aç" }).first();
    await expect(open).toBeVisible();
    await expect(open).toHaveAttribute("href", `${APP}/deciship/`);
    await open.click();
    await expect(site).toHaveURL(new RegExp(`^${APP}/deciship/`));

    const en = await openAs(owner.api, 'en-US');
    await openSite(en, '/en/products/deciship/');
    await expect(en.locator('main').getByRole('link', { name: 'Open DeciShip' }).first()).toHaveAttribute("href", `${APP}/deciship/`);
  });
});
