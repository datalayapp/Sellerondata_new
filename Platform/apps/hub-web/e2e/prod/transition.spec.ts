import { test, expect, type Page } from '../base.ts';
import path from 'node:path';

/*
 * Üretim çıktısında, gateway CSP'si altında, iki belge arası gerçek gezinti.
 * Sahte API yerine Playwright yönlendirmesi: mock bu derlemede yoktur, olmamalıdır.
 */
const SHOTS = path.resolve(import.meta.dirname, '../../screenshots');

const me = {
  person: { id: 'p1', name: 'Selin Aydın', email: 'sahip@ornek.test', phone: null, locale: 'tr', emailVerified: true },
  orgs: [{ id: 'o1', name: 'Örnek Firma', orgRole: 'OWNER', status: 'ACTIVE' }],
  activeOrg: { id: 'o1', name: 'Örnek Firma', country: 'TR', currency: 'TRY', orgRole: 'OWNER', membershipId: 'm1' },
  products: [
    { key: 'deciship', available: true, subscription: { status: 'ACTIVE', plan: 'early_access' }, role: 'ADMIN', permissions: ['deciship.web.access', 'deciship.reports.view', 'deciship.invoices.view', 'deciship.data.export'] },
    { key: 'orderloom', available: false, subscription: null, role: null, permissions: [] },
    { key: 'tagpress', available: false, subscription: null, role: null, permissions: [] },
  ],
};

async function stubApi(page: Page) {
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/account/me') return route.fulfill({ json: me });
    if (url.pathname.endsWith('/overview')) {
      return route.fulfill({ json: { product: 'deciship', from: '2026-10-08', to: '2026-11-06', kpis: [{ id: 'k', label: 'Fazla faturalanan', value: 1000, format: 'money', currency: 'TRY' }], alerts: [] } });
    }
    return route.fulfill({ json: { items: [] } });
  });
}

/** Her yeni belgede `pagereveal` anını ve ilk karedeki kabuğu yazar. */
async function record(page: Page) {
  await page.addInitScript(() => {
    addEventListener('pagereveal', (e) => {
      const vt = (e as unknown as { viewTransition: { finished: Promise<void> } | null }).viewTransition;
      const log = {
        hadTransition: !!vt,
        railAtReveal: !!document.querySelector('.sod-rail a'),
        activeAtReveal: document.querySelector('.sod-rail-item.is-active')?.textContent ?? null,
        pseudos: [] as string[],
      };
      (window as unknown as { __vt: typeof log }).__vt = log;
      if (vt) requestAnimationFrame(() => (log.pseudos = document.getAnimations().map((a) => (a.effect as KeyframeEffect).pseudoElement ?? '')));
    });
  });
}

const readVt = (page: Page) => page.evaluate(() => (window as unknown as { __vt: { hadTransition: boolean; railAtReveal: boolean; activeAtReveal: string | null; pseudos: string[] } }).__vt);

test('Merkez ↔ DeciShip: görünüm geçişi var, ray ilk karede hazır ve sabit, CSP ihlali yok', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text()) && !/speculation/i.test(m.text())) violations.push(m.text());
  });
  page.on('pageerror', (e) => violations.push(`pageerror: ${e.message}`));
  await stubApi(page);
  await page.goto('/home');
  await expect(page.locator('.sod-rail-item.is-active')).toContainText('Merkez');
  await page.waitForLoadState('networkidle');
  await record(page);

  await page.locator('.sod-rail a[data-sod-tool=deciship]').click();
  await expect(page.getByTestId('deciship-stub')).toBeVisible();
  await page.waitForTimeout(80);
  const forward = await readVt(page);
  expect(forward.hadTransition, 'yeni belgede view transition').toBe(true);
  expect(forward.railAtReveal, 'React ilk kareden önce çizdi').toBe(true);
  expect(forward.activeAtReveal).toContain('DeciShip');
  expect(forward.pseudos.some((p) => p.includes('sod-main'))).toBe(true);
  expect(forward.pseudos.some((p) => p.includes('sod-rail-tab'))).toBe(true);
  expect(forward.pseudos.some((p) => p.includes('(sod-rail)'))).toBe(false);
  await expect(page).toHaveTitle('Pano · DeciShip');

  await page.waitForLoadState('networkidle');
  await page.locator('.sod-rail a[data-sod-tool=hub]').click();
  await expect(page).toHaveURL(/\/home/);
  await page.waitForTimeout(80);
  expect((await readVt(page)).hadTransition, 'geri dönüşte de').toBe(true);
  expect(violations).toEqual([]);
});

test('geçişin ortası: ray yerinde, etkin sekme kayıyor (kanıt görüntüsü)', async ({ page }) => {
  await stubApi(page);
  await page.goto('/home');
  await expect(page.locator('.sod-rail-item.is-active')).toContainText('Merkez');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: path.join(SHOTS, 'transition-0-merkez.png') });
  // Geçiş animasyonlarını 8 kat yavaşlat: yeni belge Animation domain'iyle yakalanır.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.1 });
  await page.locator('.sod-rail a[data-sod-tool=deciship]').click();
  await page.waitForURL(/deciship/);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SHOTS, 'transition-1-orta.png') });
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
  await expect(page.getByTestId('deciship-stub')).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, 'transition-2-deciship.png') });
});

test('hareket azaltma tercihinde görünüm geçişi yok', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', baseURL, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await stubApi(page);
  await page.goto('/home');
  await expect(page.locator('.sod-rail-item.is-active')).toContainText('Merkez');
  await record(page);
  await page.locator('.sod-rail a[data-sod-tool=deciship]').click();
  await expect(page.getByTestId('deciship-stub')).toBeVisible();
  expect((await readVt(page)).hadTransition).toBe(false);
  await ctx.close();
});

test('üretim çıktısı mock içermez, giriş betiği ilk kareyi bekletir', async ({ request }) => {
  const html = await (await request.get('/login')).text();
  expect(html).toContain('blocking="render"');
  const js = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  expect(js).toBeTruthy();
  const body = await (await request.get(js!)).text();
  expect(body).not.toContain('ornek.test');
  expect(body).not.toContain('sod_mock');
});
