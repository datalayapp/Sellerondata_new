import { test, expect } from '../lib/fixtures.ts';
import { PASSWORD } from '../lib/api.ts';
import { PUBLIC_PRODUCTS } from '../lib/products.ts';
import { APP, SITE, uniq } from '../lib/sys.ts';

const TRIAL = /deneme s[üu]resi|deneme\b|ücretsiz deneme|free trial|\btrial\b/i;

async function expectNoTrial(page: import('@playwright/test').Page, where: string) {
  const text = await page.locator('body').innerText();
  expect(TRIAL.exec(text)?.[0] ?? null, `${where}: "deneme/trial" görünmemeli`).toBeNull();
}

test.describe('Tanıtım sitesi ve kayıt', () => {
  test('site "Giriş" uygulamanın giriş sayfasına gider', async ({ page }) => {
    await page.goto(SITE + '/');
    await page.getByRole('link', { name: 'Giriş', exact: true }).first().click();
    // Mesaj 15: site her uygulama bağlantısına kendi dilini koyar (TR sitede ?lang=tr).
    await expect(page).toHaveURL(`${APP}/login?lang=tr`);
    await expect(page.getByRole('heading', { name: 'Giriş yapın' })).toBeVisible();
  });

  test('EN: site "Sign in" uygulamanın giriş sayfasına gider', async ({ page }) => {
    await page.goto(SITE + '/en/');
    await page.getByRole('link', { name: 'Sign in', exact: true }).first().click();
    // Dil siteden taşınır (bilinçli değişiklik): EN siteden giriş ?lang=en ile açılır.
    await expect(page).toHaveURL(`${APP}/login?lang=en`);
  });

  test('siteden "Hesap aç" ile kayıt, /home Merkez kurulumu, firma onayı, DeciShip Erken erişim, hiçbir yerde deneme yok', async ({ page }) => {
    await page.goto(SITE + '/');
    await expectNoTrial(page, 'site');
    await page.getByRole('link', { name: 'Hesap aç', exact: true }).first().click();
    await expect(page).toHaveURL(`${APP}/register?lang=tr`);
    await expect(page.getByRole('heading', { name: 'Hesap açın' })).toBeVisible();
    await expectNoTrial(page, 'kayıt');

    const orgName = `Kayıt Lojistik ${uniq('')}`;
    await page.getByLabel('Firma adı').fill(orgName);
    await page.getByLabel('Ad soyad').fill('Ayşe Yılmaz');
    await page.getByLabel('E-posta').fill(`${uniq('ayse')}@e2e.sellerondata.test`);
    await page.getByLabel('Şifre', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Hesap aç' }).click();

    await expect(page).toHaveURL(`${APP}/home`);
    await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();
    // Yeni firma onaysız başlar: Genel Bakış yerine başlangıç sayfası (KARARLAR "Merkez kurulumu ve araç kurulumu").
    const hubSetup = page.getByRole('region', { name: 'Merkez kurulumu' });
    await expect(hubSetup.locator('.hub-start-count')).toHaveText('0/1');
    const companyRow = hubSetup.locator('li', { hasText: 'Firma bilgilerini onaylayın' });
    await expect(companyRow).toBeVisible();
    await expect(page.getByRole('region', { name: 'Araç kurulumları' }).locator('li', { hasText: 'DeciShip' })).toContainText('Sıradaki:');
    await expectNoTrial(page, '/home');

    // Merkez kurulumu: Firma sayfasında açık onay, sonra Genel Bakış'a dönüş (`next=/home`).
    await companyRow.getByRole('link', { name: 'Başla' }).click();
    await expect(page).toHaveURL(`${APP}/account/company?next=/home`);
    await expect(page.getByText('Onaylayınca kaldığınız yere dönersiniz.')).toBeVisible();
    await expect(page.getByLabel('Firma adı')).toHaveValue(orgName);
    await page.getByRole('button', { name: 'Onayla', exact: true }).click();
    await expect(page.getByText('Firma bilgileri onaylandı')).toBeVisible();
    await expect(page).toHaveURL(`${APP}/home`);
    await expect(hubSetup.locator('.hub-start-count')).toHaveText('1/1');
    await expect(companyRow.getByRole('link', { name: 'Gözden geçir' })).toBeVisible();

    await page.goto('/account/billing');
    await expect(page.getByRole('heading', { name: 'Abonelik' })).toBeVisible();
    await expect(page.getByText('Erken erişim').first()).toBeVisible();
    await expectNoTrial(page, 'abonelik');

    // Onaylı firmada DeciShip sihirbazı açık: firma bilgileri Merkez'den gelir, ilk adım taşıyıcılar.
    await page.goto('/deciship/setup');
    await expect(page.getByRole('heading', { name: 'İlk kurulum' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Kurulum adımları' })).toContainText(/Firma bilgileri\s*Merkez'de tamamlandı/);
    await expect(page.locator('#ob-step-title')).toContainText('Taşıyıcılar');
    await expectNoTrial(page, 'DeciShip kurulum');
  });

  test('EN: site "Create account" ile kayıt, /home Hub setup ve Early access', async ({ page }) => {
    await page.goto(SITE + '/en/');
    await page.getByRole('link', { name: 'Create account', exact: true }).first().click();
    // Dil siteden taşınır: tarayıcı Türkçe olsa da kayıt sayfası EN açılır.
    await expect(page).toHaveURL(`${APP}/register?lang=en`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
    await page.getByLabel('Company name').fill(`Register Logistics ${uniq('')}`);
    await page.getByLabel('Full name').fill('Jane Doe');
    await page.getByLabel('Email').fill(`${uniq('jane')}@e2e.sellerondata.test`);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(`${APP}/home`);
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
    // Yeni firma: başlangıç sayfası EN.
    const hubSetup = page.getByRole('region', { name: 'Hub setup' });
    await expect(hubSetup.locator('.hub-start-count')).toHaveText('0/1');
    await expect(hubSetup).toContainText('Confirm your company details');
    await expect(page.getByRole('region', { name: 'Tool setup' }).locator('li', { hasText: 'DeciShip' })).toContainText('Next:');
    await expectNoTrial(page, 'EN /home');

    // Plan başlangıç sayfasında değil, Abonelik'te: Early access.
    await page.goto('/account/billing');
    await expect(page.getByRole('heading', { name: 'Subscription and tools' })).toBeVisible();
    await expect(page.getByText('Early access').first()).toBeVisible();
    await expectNoTrial(page, 'EN abonelik');
  });

  test('BASLAT demo hesapları: e-postayla ve telefonla giriş', async ({ freshPage }) => {
    const page = await freshPage();
    await page.goto('/');
    await expect(page).toHaveURL(/login/);
    await page.getByLabel('E-posta veya telefon').fill('sahip@demo.sellerondata.com');
    await page.getByLabel('Şifre', { exact: true }).fill('Demo12345!');
    await page.getByRole('button', { name: 'Giriş yap' }).click();
    await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Firma: Demo Lojistik' })).toBeVisible();

    const worker = await freshPage();
    await worker.goto('/login');
    await worker.getByLabel('E-posta veya telefon').fill('0555 000 00 05');
    await worker.getByLabel('Şifre', { exact: true }).fill('Demo12345!');
    await worker.getByRole('button', { name: 'Giriş yap' }).click();
    await expect(worker.getByText('Bu rol mobil uygulamada çalışır').first()).toBeVisible();
  });

  test('KURULUM.md demo hesap tablosu doğru: her hesap girer, araç başına rol ve firma sayısı tutar', async () => {
    const { MobileApi } = await import('../lib/api.ts');
    // Araç başına demo rolü (KALANLAR 6.26): hesabın her açık araçtaki rolü (null: erişim yok). Kayıtta açık olup burada
    // yazılmayan araç testi düşürür: demo tohumu (account-api `src/seed.ts`) ve KURULUM.md tablosu o araç için de rol vermeli.
    const rows: [string, Record<string, string | null>, number][] = [
      ['sahip@demo.sellerondata.com', { deciship: 'ADMIN' }, 1],
      ['yonetici@demo.sellerondata.com', { deciship: 'ADMIN' }, 1],
      ['denetleyici@demo.sellerondata.com', { deciship: 'AUDITOR' }, 1],
      ['muhasebe@demo.sellerondata.com', { deciship: 'ACCOUNTING' }, 1],
      ['+905550000005', { deciship: 'MEASURE' }, 1],
      ['erisimyok@demo.sellerondata.com', { deciship: null }, 1],
      ['cokfirma@demo.sellerondata.com', { deciship: 'ACCOUNTING' }, 2],
    ];
    for (const [id, roles, orgs] of rows) {
      const m = await MobileApi.login(id, 'Demo12345!');
      const me = (await m.get('/api/account/me')).body as { orgs: unknown[]; products: { key: string; role: string | null }[] };
      expect(me.orgs.length, id).toBe(orgs);
      for (const p of PUBLIC_PRODUCTS) {
        expect(Object.hasOwn(roles, p.key), `demo tablosunda ${p.name} rolü yazılı değil (${id})`).toBe(true);
        expect(me.products.find((x) => x.key === p.key)?.role ?? null, `${id} ${p.name}`).toBe(roles[p.key]);
      }
      await m.dispose();
    }
  });

  test('kısa şifre ve var olan e-posta anlaşılır hata verir, form silinmez', async ({ page }) => {
    await page.goto('/register');
    await page.getByLabel('Firma adı').fill('Hata Lojistik');
    await page.getByLabel('Ad soyad').fill('Ali Veli');
    const email = `${uniq('ali')}@e2e.sellerondata.test`;
    await page.getByLabel('E-posta').fill(email);
    await page.getByLabel('Şifre', { exact: true }).fill('kisa');
    await expect(page.getByText(/en az \d+ karakter olmalı/)).toBeVisible();
    await page.getByLabel('Şifre', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Hesap aç' }).click();
    await expect(page).toHaveURL(`${APP}/home`);

    // Çıkış, aynı e-postayla yeniden kayıt
    await page.getByRole('button', { name: /Kullanıcı menüsü/ }).click();
    await page.getByRole('menuitem', { name: 'Çıkış yap' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/register');
    await page.getByLabel('Firma adı').fill('Hata Lojistik 2');
    await page.getByLabel('Ad soyad').fill('Ali Veli');
    await page.getByLabel('E-posta').fill(email);
    await page.getByLabel('Şifre', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Hesap aç' }).click();
    await expect(page.getByText('Bu e-posta adresi kullanılıyor.')).toBeVisible();
    await expect(page.getByLabel('Firma adı')).toHaveValue('Hata Lojistik 2');
    await expect(page).toHaveURL(`${APP}/register`);
  });
});
