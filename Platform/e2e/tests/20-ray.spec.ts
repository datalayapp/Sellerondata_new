import { test, expect } from '../lib/fixtures.ts';
import { registerOwner } from '../lib/api.ts';
import { APP, recordMetric } from '../lib/sys.ts';
import { bandNav, openApps } from '../lib/shell.ts';
import { OFF_PRODUCTS, PUBLIC_PRODUCTS } from '../lib/products.ts';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test.describe('Ray: araçlar arası geçiş', () => {
  // D09: ray yok; araçlar bandın ⊞ uygulama seçicisinde, etkin araç logo kilidinde ve menüde belli.
  // Araç listesi kayıttan (`lib/products.ts`): açık araç bağlantı, kapalı araç "Yakında". Yeni araç açılınca kendiliğinden girer.
  test('Merkez ↔ açık araçlar yeniden giriş istemez, etkin araç belli, kapalı araçlar tıklanmaz', async ({ openAs }) => {
    const owner = await registerOwner();
    const page = await openAs(owner.api);
    await page.goto('/home');
    await expect(bandNav(page, 'Merkez')).toBeVisible();
    // Logo kilidi: MERKEZ (metin "Merkez", CSS büyük harf), altında SellerOnData
    await expect(page.locator('.sod-brand-n')).toHaveText('Merkez');
    await expect(page.locator('.sod-brand-sub')).toHaveText('SellerOnData');
    let apps = await openApps(page);

    const hub = apps.getByRole('menuitem', { name: /Merkez/ });
    await expect(hub).toHaveAttribute('aria-current', 'page');

    // Etkin olmayan açık araç bağlantıları
    for (const p of PUBLIC_PRODUCTS) {
      const item = apps.getByRole('menuitem', { name: new RegExp(esc(p.name)) });
      await expect(item).toHaveAttribute('href', `/${p.key}/`);
      await expect(item).not.toHaveAttribute('aria-current', 'page');
    }

    // Kapalı araçlar: bağlantı değil, tıklanmaz
    for (const { name } of OFF_PRODUCTS) {
      if (!(await apps.isVisible())) apps = await openApps(page);
      const item = apps.locator('.sod-pop-item', { hasText: name });
      await expect(item).toHaveAttribute('aria-disabled', 'true');
      await expect(item).not.toHaveAttribute('href', /.*/);
      await expect(item).toContainText('Yakında');
      await item.click({ force: true });
      await expect(page).toHaveURL(`${APP}/home`);
    }

    // Geçiş her açık araca: tam sayfa, oturum aynı; sonra Merkez'e geri
    for (const p of PUBLIC_PRODUCTS) {
      if (!(await apps.isVisible())) apps = await openApps(page);
      await apps.getByRole('menuitem', { name: new RegExp(esc(p.name)) }).click();
      await expect(page).toHaveURL(new RegExp(`${APP}/${p.key}/`));
      await expect(page).not.toHaveURL(/login/);
      await expect(bandNav(page, p.name)).toBeVisible();
      await expect(page.locator('.sod-brand-n')).toHaveText(p.name);
      const apps2 = await openApps(page);
      await expect(apps2.getByRole('menuitem', { name: new RegExp(esc(p.name)) })).toHaveAttribute('aria-current', 'page');
      await expect(apps2.getByRole('menuitem', { name: /Merkez/ })).not.toHaveAttribute('aria-current', 'page');

      await apps2.getByRole('menuitem', { name: /Merkez/ }).click();
      await expect(page).toHaveURL(`${APP}/home`);
      await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();
    }
  });

  test('üretimde gateway üzerinden: görünüm geçişi ve önceden yükleme çalışır, CSP ihlali yok', async ({ openAs }) => {
    const owner = await registerOwner();
    const page = await openAs(owner.api);
    await page.goto('/home');
    await expect(bandNav(page, 'Merkez')).toBeVisible();

    // Speculation Rules bloğu yerleşmiş ve CSP tarafından engellenmemiş
    const spec = await page.evaluate(() => ({
      supported: HTMLScriptElement.supports?.('speculationrules') ?? false,
      blocks: document.querySelectorAll('script[type=speculationrules]').length,
      prefetch: Array.from(document.querySelectorAll('link[rel=prefetch]')).map((l) => l.getAttribute('href')),
      viewTransitionRule: Array.from(document.styleSheets).some((s) => {
        try {
          return Array.from(s.cssRules).some((r) => r.cssText.includes('@view-transition'));
        } catch {
          return false;
        }
      }),
    }));
    expect(spec.supported).toBe(true);
    expect(spec.blocks).toBeGreaterThan(0);
    expect(spec.prefetch).toContain('/deciship/');
    expect(spec.viewTransitionRule, '@view-transition kuralı Merkez CSS paketinde').toBe(true);

    // Belgeler arası görünüm geçişi gerçekten başlıyor mu: yeni belgede pagereveal.viewTransition dolu olmalı.
    await page.addInitScript(() => {
      window.addEventListener('pagereveal', (e) => {
        (window as unknown as { __vt: boolean }).__vt = Boolean((e as unknown as { viewTransition?: unknown }).viewTransition);
      });
    });
    const started = Date.now();
    await (await openApps(page)).getByRole('menuitem', { name: /DeciShip/ }).click();
    await page.waitForURL(/\/deciship\//);
    await expect(bandNav(page, 'DeciShip')).toBeVisible();
    recordMetric('gecis_merkez_deciship_ms', Date.now() - started);
    const vt = await page.evaluate(() => (window as unknown as { __vt?: boolean }).__vt);
    expect(vt, 'pagereveal.viewTransition').toBe(true);
  });
});
