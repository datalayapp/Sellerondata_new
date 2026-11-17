import { expect, test, type Page } from '@playwright/test';
import { login, reset, USERS } from '../helpers.ts';

/*
 * Görsel karşılaştırma (Mesaj 12 §3.6). Yalnız `playwright.visual.config.ts` koşar; olağan `npm run test:e2e` bu klasörü atlar.
 * Görüntü adı: hub-tr-<genişlik>-<ekran>.png (taban klasörü VISUAL_DIR).
 *
 * Sabitlenenler: saat (page.clock.setFixedTime 2026-11-10T10:00+03:00; "son etkin" gibi göreli zamanlar bununla sabit),
 * animasyon (animations: 'disabled'), imleç (caret: 'hide'), mock gecikmesi (sod_mock_fast=1 → reset()), yazı tipi (document.fonts.ready),
 * yükleme iskeleti (.skel sıfır olana kadar beklenir).
 *
 * TOLERANS: toHaveScreenshot maxDiffPixels 40, threshold 0.2. Yuvarlak köşe kenar yumuşatması koşudan koşuya birkaç piksel oynuyor
 * (1-25 piksel gözlendi); gerçek stil farkı (dolgu, köşe, gölge, renk, yerleşim) yüzlerce piksel üretir. Stiller kapatılmaz.
 *
 * MASKELENENLER: şimdilik yok (köşe titremesi toleransla karşılanıyor). Kararsızlık denetimi (ikinci koşu) bir ekranı değiştirirse seçici aşağıdaki MASKS tablosuna
 * ekran adıyla eklenir ve neden yanına yazılır (ör. 'team-1440': ['.avatar'] // rastgele avatar rengi). Listeden çıkarılan ekran da buraya yorumlanır.
 */
const MASKS: Record<string, string[]> = {};

const FIXED_NOW = new Date('2026-11-10T10:00:00+03:00');
const SIZES = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.skel')).toHaveCount(0, { timeout: 8000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
}

async function snap(page: Page, key: string, name: string, fullPage = false) {
  // Kararlılık: geçişler ve bulanıklık kapatılır, imleç köşeye alınır (hover kalıntısı olmasın). Köşe, gölge ve renkler korunur.
  await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;scroll-behavior:auto!important}' });
  await page.mouse.move(0, 0);
  await settle(page);
  const mask = (MASKS[key] ?? []).map((s) => page.locator(s));
  await expect(page).toHaveScreenshot(`${name}.png`, { fullPage, animations: 'disabled', caret: 'hide', maxDiffPixels: 40, threshold: 0.2, mask });
}

/** `e2e/screens.ts` PAGES (10 sayfa), sahip girişiyle. */
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
];

const ANON: [string, string][] = [
  ['login', '/login'],
  ['register', '/register'],
  ['forgot-password', '/forgot-password'],
];

/** Dar ekranda (kart görünümü) rol seçicileri "Rolleri düzenle" düğmesinin arkasındadır: önce kişinin kartında açılır. */
async function openRoleEditor(page: Page, width: number, name: string) {
  if (width >= 768) return;
  await page.locator('li.d9-card', { hasText: name }).locator('button.d9-link').click();
}

for (const { width, height } of SIZES) {
  test.describe(`Merkez TR ${width}`, () => {
    test.use({ viewport: { width, height } });

    for (const [name, url] of PAGES) {
      test(`${name}`, async ({ page }) => {
        await page.clock.setFixedTime(FIXED_NOW);
        await reset(page);
        await login(page, USERS.owner);
        await page.goto(url);
        await snap(page, `${name}-${width}`, `hub-tr-${width}-${name}`, true);
      });
    }

    test('orderloom-yakinda', async ({ page }) => {
      await page.clock.setFixedTime(FIXED_NOW);
      await reset(page);
      await login(page, USERS.owner);
      await page.goto('/orderloom');
      await snap(page, `orderloom-yakinda-${width}`, `hub-tr-${width}-orderloom-yakinda`);
    });

    for (const [name, url] of ANON) {
      test(`${name}`, async ({ page }) => {
        await page.clock.setFixedTime(FIXED_NOW);
        await reset(page);
        await page.goto(url);
        await snap(page, `${name}-${width}`, `hub-tr-${width}-${name}`);
      });
    }

    test('ekip-davet-yan-panel-acik', async ({ page }) => {
      await page.clock.setFixedTime(FIXED_NOW);
      await reset(page);
      await login(page, USERS.owner);
      await page.goto('/account/team');
      await settle(page);
      await page.getByRole('button', { name: 'Kişi davet et' }).click();
      await snap(page, `ekip-davet-${width}`, `hub-tr-${width}-ekip-davet-yan-panel-acik`);
    });

    test('ekip-rol-onay-penceresi', async ({ page }) => {
      await page.clock.setFixedTime(FIXED_NOW);
      await reset(page);
      await login(page, USERS.owner);
      await page.goto('/account/team');
      await settle(page);
      await openRoleEditor(page, width, 'Zeynep Arslan');
      await page.getByLabel('Zeynep Arslan DeciShip rolü').selectOption('');
      await expect(page.getByRole('dialog')).toBeVisible();
      await snap(page, `ekip-rol-onay-${width}`, `hub-tr-${width}-ekip-rol-onay-penceresi`);
    });

    test('ekip-rol-bildirimi-geri-al', async ({ page }) => {
      await page.clock.setFixedTime(FIXED_NOW);
      await reset(page);
      await login(page, USERS.owner);
      await page.goto('/account/team');
      await settle(page);
      await openRoleEditor(page, width, 'Can Yıldız');
      await page.getByLabel('Can Yıldız DeciShip rolü').selectOption('AUDITOR');
      await expect(page.locator('.toast').first()).toBeVisible();
      // Seçici odakta kalırsa köşelerinde odak halkası 4-5 pikselde koşudan koşuya titrer: odak bırakılır.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await snap(page, `ekip-rol-bildirim-${width}`, `hub-tr-${width}-ekip-rol-bildirimi-geri-al`);
    });
  });
}
