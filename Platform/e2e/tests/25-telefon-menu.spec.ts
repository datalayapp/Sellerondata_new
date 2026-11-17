import type { Page } from '@playwright/test';
import { test, expect } from '../lib/fixtures.ts';
import { registerOwner } from '../lib/api.ts';

/**
 * 390 px: bandın sağ kümesindeki menüler içeriğin önünde olmalı, dokununca seçim gerçekten çalışmalı.
 * Merkez ve DeciShip aynı kabuğu (D09) kullanır: telefonda çekmece yok, firma seçici ve avatar bantta durur; dil avatar menüsünde.
 */
const PHONE = { width: 390, height: 844 };
const TEXT = {
  'tr-TR': { org: /^Firma:/, lang: /^Dil$/, user: /^Kullanıcı menüsü/, other: 'English', otherLang: 'en', profile: 'Hesabım' },
  'en-GB': { org: /^Company:/, lang: /^Language$/, user: /^User menu/, other: 'Türkçe', otherLang: 'tr', profile: 'My account' },
} as const;

async function onTop(page: Page) {
  const pop = page.locator('.sod-pop').first();
  await expect(pop).toBeVisible();
  const covered = await pop.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const pts = [[r.right - 6, r.top + 6], [r.right - 6, r.bottom - 6], [r.left + r.width / 2, r.top + r.height / 2]];
    return pts.filter(([x, y]) => !el.contains(document.elementFromPoint(x!, y!))).length;
  });
  expect(covered).toBe(0);
}

test.describe('Telefon: firma, dil ve kullanıcı menüsü', () => {
  for (const [locale, L] of Object.entries(TEXT)) {
    for (const path of ['/home', '/deciship/']) {
      test(`${locale} ${path}: firma ve kullanıcı menüsü içeriğin önünde, dil seçimi çalışır, Hesabım açılır`, async ({ openAs }) => {
        const owner = await registerOwner({ orgName: 'Telefon Menü', locale: locale.slice(0, 2) as 'tr' | 'en' });
        // İkinci firma: yeni firma etkin olur, seçiciden ilkine dönülür.
        await owner.api.post('/api/account/orgs', { name: 'Telefon İkinci', country: 'TR' });
        const page = await openAs(owner.api, locale, PHONE);
        await page.goto(path);
        await expect(page.locator('.sod-firm-n')).toHaveText('Telefon İkinci');

        await page.getByRole('button', { name: L.org }).click();
        await onTop(page);
        await page.getByRole('menuitemradio', { name: /Telefon Menü/ }).click();
        await expect(page.locator('.sod-firm-n')).toHaveText('Telefon Menü');

        await page.goto(path);
        await page.getByRole('button', { name: L.user }).click();
        await onTop(page);
        await page.getByRole('menuitem', { name: L.profile }).click();
        await expect(page).toHaveURL(/\/account\/profile/);
        await expect(page.locator('.sod-band').getByRole('heading', { name: 'Selin Sahip', level: 1 })).toBeVisible();

        await page.goto(path);
        await page.getByRole('button', { name: L.user }).click();
        await onTop(page);
        await page.locator('.sod-pop-lang').click();
        await page.getByRole('group', { name: L.lang }).getByRole('menuitemradio', { name: L.other }).click();
        await expect(page.locator('html')).toHaveAttribute('lang', L.otherLang);
      });
    }
  }
});
