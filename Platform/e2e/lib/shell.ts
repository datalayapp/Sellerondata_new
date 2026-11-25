// D09 renk bandı kabuğu (packages/shell AppShell): ray ve yan menü yok.
// Üst bant: logo kilidi + yatay ürün menüsü (`<ad> menüsü`) + sağ küme [⊞ Uygulamalar] [Firma: …] [Kullanıcı menüsü: …].
import { expect, type Locator, type Page } from '@playwright/test';

/** Bandın yatay menüsü: "Merkez menüsü", "<araç adı> menüsü" (EN: "Hub menu", "DeciShip menu"). Araç adı kayıttaki `name`. */
export const bandNav = (page: Page, name: string) => page.getByRole('navigation', { name: name === 'Hub' ? 'Hub menu' : `${name} menüsü` });

/** ⊞ uygulama seçicisini açar; Merkez ve araçlar bu menüdedir. */
export async function openApps(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: /^(Uygulamalar|Apps)$/ }).click();
  const menu = page.getByRole('menu', { name: /^SellerOnData (uygulamaları|apps)$/ });
  await expect(menu).toBeVisible();
  return menu;
}

/** Avatar menüsünü açar, "Dil" satırını açıp seçenek grubunu döner (dil seçimi kabukta yalnız burada; satır tek, seçenekler tıklayınca açılır). */
export async function openLanguage(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: /^(Kullanıcı menüsü|User menu)/ }).click();
  await page.locator('.sod-pop-lang').click();
  const group = page.getByRole('group', { name: /^(Dil|Language)$/ });
  await expect(group).toBeVisible();
  return group;
}
