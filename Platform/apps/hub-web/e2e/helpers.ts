import { expect, type Page } from '@playwright/test';

export const PASSWORD = 'Test12345!';
export const USERS = {
  owner: 'sahip@ornek.test',
  admin: 'yonetici@ornek.test',
  auditor: 'denetci@ornek.test',
  accounting: 'muhasebe@ornek.test',
  measure: '0532 000 00 04',
  noRole: 'erisimsiz@ornek.test',
  fresh: 'yeni@ornek.test',
  noOrg: 'firmasiz@ornek.test',
  noRecovery: '0532 000 00 07',
} as const;

/** Her test temiz örnek veriyle başlar. Mock durumu tarayıcı deposundadır. */
export async function reset(page: Page, opts: { lang?: 'tr' | 'en'; fail?: string[]; fast?: boolean } = {}) {
  await page.goto('/login');
  // Vite ilk yüklemede bağımlılık için sayfayı yenileyebilir: form görünene kadar bekle.
  await page
    .locator('#id, .sod-shell')
    .first()
    .waitFor({ timeout: 20_000 })
    // Yoğun makinede servis işçisi ilk açılışta takılabilir: bir kez yenile.
    .catch(async () => {
      await page.reload();
      await page.locator('#id, .sod-shell').first().waitFor();
    });
  await page.evaluate(
    ({ lang, fail, fast }) => {
      localStorage.clear();
      sessionStorage.clear();
      document.cookie = `sod_lang=${lang}; Path=/`;
      if (fail?.length) localStorage.setItem('sod_mock_fail', JSON.stringify(fail));
      if (fast) localStorage.setItem('sod_mock_fast', '1');
    },
    { lang: opts.lang ?? 'tr', fail: opts.fail, fast: opts.fast ?? true },
  );
}

export async function login(page: Page, identifier: string, password = PASSWORD) {
  await page.goto('/login');
  await page.fill('#id', identifier);
  await page.fill('#pw', password);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/home/);
}
