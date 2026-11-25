import { expect, test, type Page } from '@playwright/test';
import { permissionsOf } from '@sellerondata/contracts';

// Gerçek tarayıcı, gerçek üretim paketleri, tek köken: Merkez ↔ DeciShip (ARCHITECTURE §8). API yanıtları sözleşme şeklindedir.
const me = {
  person: { id: 'p1', name: 'Selin Aydın', email: 'sahip@ornek.test', phone: null, locale: 'tr', emailVerified: true },
  orgs: [{ id: 'o1', name: 'Örnek Firma', orgRole: 'OWNER', status: 'ACTIVE' }],
  activeOrg: { id: 'o1', name: 'Örnek Firma', country: 'TR', currency: 'TRY', orgRole: 'OWNER', membershipId: 'm1' },
  products: [
    { key: 'deciship', available: true, subscription: { status: 'ACTIVE', plan: 'early_access' }, role: 'ADMIN', permissions: [...permissionsOf('deciship', 'ADMIN')] },
    { key: 'orderloom', available: false, subscription: null, role: null, permissions: [] },
    { key: 'tagpress', available: false, subscription: null, role: null, permissions: [] },
  ],
};

async function stubApi(page: Page) {
  await page.route('**/api/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/account/me') return route.fulfill({ json: me });
    if (p === '/api/deciship/me') return route.fulfill({ json: { member: { id: 'm1', name: 'Selin Aydın' }, company: { id: 'o1', name: 'Örnek Firma', settings: { desiDivisor: 3000, currency: 'TRY' } }, onboarding: { completed: true, required: false, showBanner: false } } });
    return route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: 'yok' } } });
  });
}

const rail = (page: Page) => page.getByRole('navigation', { name: 'Araçlar' });

type Reveal = { viewTransition: boolean; finished: boolean; rail: boolean; side: boolean; user: boolean; hadShellCss: boolean };

/** Yeni belge ilk karesini çizerken ne vardı: geçiş nesnesi, ray, menü, kullanıcı. */
async function recordReveal(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __reveal: Reveal };
    addEventListener('pagereveal', (e) => {
      const vt = (e as unknown as { viewTransition: { finished: Promise<void> } | null }).viewTransition;
      w.__reveal = {
        viewTransition: !!vt,
        finished: false,
        rail: !!document.querySelector('.sod-rail a[aria-current="page"]'),
        side: !!document.querySelector('.sod-side-nav a'),
        user: !!document.querySelector('.sod-rail-user')?.textContent,
        hadShellCss: getComputedStyle(document.documentElement).getPropertyValue('--sod-rail-w').trim() !== '',
      };
      void vt?.finished.then(() => (w.__reveal.finished = true)).catch(() => undefined);
    });
  });
}
const reveal = (page: Page) => page.evaluate(() => (window as unknown as { __reveal?: Reveal }).__reveal);

test('Merkez → DeciShip → Merkez: görünüm geçişi çalışır, ilk karede ray, menü ve kullanıcı hazır', async ({ page }) => {
  await stubApi(page);
  await recordReveal(page);
  await page.goto('/home');
  await expect(rail(page).locator('a[aria-current="page"]')).toContainText('Merkez');

  await page.evaluate(() => ((window as unknown as { __same: boolean }).__same = true));
  await rail(page).getByRole('link', { name: 'DeciShip' }).click();
  await expect(page).toHaveURL(/\/deciship\/$/);
  await expect(page.getByRole('heading', { name: 'Pano', level: 1 })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __same?: boolean }).__same)).toBeUndefined(); // gerçekten yeni belge
  await expect.poll(() => reveal(page)).toMatchObject({ viewTransition: true, rail: true, side: true, user: true, hadShellCss: true });
  await expect.poll(() => reveal(page).then((r) => r?.finished)).toBe(true);
  await expect(rail(page).locator('a[aria-current="page"]')).toContainText('DeciShip');
  await expect(page.locator('.sod-top-name')).toHaveText('DeciShip');
  await expect(page).toHaveTitle('Pano · DeciShip');

  await rail(page).getByRole('link', { name: 'Merkez' }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect.poll(() => reveal(page)).toMatchObject({ viewTransition: true, rail: true, user: true });
  await expect(rail(page).locator('a[aria-current="page"]')).toContainText('Merkez');
});

test('geçiş sırasında ray yerinde kalır: araç işaretleri aynı konumda', async ({ page }) => {
  await stubApi(page);
  await page.goto('/home');
  const pos = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.sod-rail .sod-rail-mark')].map((el) => {
        const r = el.getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.top)];
      }),
    );
  await expect(rail(page).locator('a[aria-current="page"]')).toBeVisible();
  const hub = await pos();
  await rail(page).getByRole('link', { name: 'DeciShip' }).click();
  await expect(page.getByRole('heading', { name: 'Pano', level: 1 })).toBeVisible();
  expect(await pos()).toEqual(hub);
});

test('hareket azaltma açıkken görünüm geçişi yapılmaz', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', baseURL, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await stubApi(page);
  await recordReveal(page);
  await page.goto('/home');
  await expect(rail(page).locator('a[aria-current="page"]')).toBeVisible();
  await rail(page).getByRole('link', { name: 'DeciShip' }).click();
  await expect(page.getByRole('heading', { name: 'Pano', level: 1 })).toBeVisible();
  expect((await reveal(page))?.viewTransition).toBe(false);
  await ctx.close();
});

test('oturum düşmüşken Merkez → DeciShip: girişe gidilir, atlanan geçiş konsola hata düşürmez', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${page.url()} ${e.name}: ${e.message}`));
  await stubApi(page);
  await page.goto('/home');
  await expect(rail(page).locator('a[aria-current="page"]')).toContainText('Merkez');

  await page.route('**/api/**', (route) => route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED', message: 'yok' } } }));
  await rail(page).getByRole('link', { name: 'DeciShip' }).click();
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.waitForTimeout(300);
  expect(errors).toEqual([]);
});

test('üretim paketi: giriş betiği çizimi bekletir, mock kodu yok', async ({ request }) => {
  const html = await (await request.get('/deciship/')).text();
  expect(html).toMatch(/<script type="module" blocking="render"[^>]*src="\/deciship\/assets\//);
  const js = html.match(/\/deciship\/assets\/[^"]+\.js/)?.[0];
  expect(js).toBeTruthy();
  const code = await (await request.get(js!)).text();
  expect(code).not.toContain('sod_mock');
  expect(code).not.toContain('mockServiceWorker');
  expect(code).not.toMatch(/accessToken|deciship\.refreshToken/);
});
