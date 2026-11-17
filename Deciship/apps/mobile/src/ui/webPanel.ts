import { PRODUCTS, type MeResponse, type ProductKey } from '@sellerondata/contracts';
import { toolAccess } from '../tools/registry';

/*
 * Üst bantta "Yönetim paneli ↗" düğmesi (tasarım 3-A): aracın web yönetim panelini telefonun tarayıcısında açar.
 * Saf kurallar burada; düğme `components.tsx` `Header` içinde.
 */

/**
 * Düğmeyi kim görür: aracı kullanabilen (firma, abonelik, rol; salt okunur abonelik dahil) ve web giriş izni olan kişi.
 * Kod rol adına bakmaz, kayıttaki web giriş iznine bakar (`PRODUCTS[key].webAccess`); DeciShip'te Yönetici, Muhasebe,
 * Denetleyici. Ölçüm rolünde bu izin yok, düğmeyi görmez. Web uygulaması olmayan araçta düğme yok.
 */
export function canOpenWebPanel(me: MeResponse | null | undefined, key: ProductKey = 'deciship'): boolean {
  const def = PRODUCTS[key];
  if (!def.webAccess || !def.deploy?.web) return false;
  const access = toolAccess(me, key);
  return access.canUse && access.has(def.webAccess);
}

/** Panelin adresi: web kökü + aracın yolu (`/deciship/`; web kabuğunun `productHref` biçimi). */
export function webPanelUrl(origin: string, key: ProductKey = 'deciship'): string {
  return `${origin.replace(/\/+$/, '')}${PRODUCTS[key].basePath}/`;
}

/**
 * Düğme yazılı mı sığar? Bant satırında logo kilidi kalan boşluğu alır (`flex: 1`); düğme yazılıyken kilidin
 * kendi genişliği (`brandNeed`) kadar yer kalmalı, yoksa düğme yalnız simgeye iner.
 * `brand`: kilidin şimdiki genişliği, `button`: düğmenin şimdiki genişliği, `label`: yazılı düğmenin genişliği.
 * Hesap düğmenin şimdiki biçiminden bağımsızdır; biçim değişince karar gidip gelmez.
 */
export function webPanelLabelFits(m: { brand: number; button: number; label: number; brandNeed: number }): boolean {
  return m.brand + m.button - m.label >= m.brandNeed;
}
