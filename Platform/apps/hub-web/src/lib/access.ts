import { PRODUCTS, PRODUCT_KEYS, productRole, type Locale, type MeResponse, type ProductKey, type HubOverview } from '@sellerondata/contracts';

/** Görünürlük tek yerde. Kod rol adına bakmaz; `me.products[].permissions` ve `orgRole`'a bakar (§8). */
type MeProduct = MeResponse['products'][number];

export const isOrgAdmin = (me: MeResponse | null) => me?.activeOrg?.orgRole === 'OWNER' || me?.activeOrg?.orgRole === 'ADMIN';
export const isOwner = (me: MeResponse | null) => me?.activeOrg?.orgRole === 'OWNER';

/** Platform yöneticisi (`/me.platformOperator`, Hesap `PLATFORM_OPERATORS`): Merkez'de "Platform" menüsü yalnız ona. Alan yoksa değil. */
export const isPlatformOperator = (me: MeResponse | null) => me?.platformOperator === true;

/** Yapay zekâ harcaması (firma görünümü): etkin firmanın sahibi ya da yöneticisi, bütün araçlarıyla (`aiSpend.ts`). */
export const canSeeAiSpend = (me: MeResponse | null) => isOrgAdmin(me);

const has = (p: MeProduct | undefined, perm: string | undefined) => !!p && !!perm && p.permissions.includes(perm);

export const meProduct = (me: MeResponse | null, key: ProductKey) => me?.products.find((p) => p.key === key);
export const canAnalytics = (p: MeProduct) => has(p, PRODUCTS[p.key].hub?.analytics);
export const canData = (p: MeProduct) => has(p, PRODUCTS[p.key].hub?.data);
export const canExport = (p: MeProduct | undefined) => !!p && has(p, PRODUCTS[p.key].hub?.export);

/**
 * Kişinin araçtaki rolünün adı: Hesap'ın çözdüğü ad (`roleLabel`: özel rol, adı değişmiş hazır rol), yoksa katalog adı (eski sunucu),
 * yoksa anahtar. Rol yoksa undefined.
 */
export function roleLabelOf(p: Pick<MeProduct, 'key' | 'role' | 'roleLabel'> | undefined, locale: Locale): string | undefined {
  if (!p?.role) return undefined;
  return p.roleLabel ?? productRole(p.key, p.role)?.label[locale] ?? p.role;
}

/** Hazır rolün katalog açıklaması; özel rolde ya da bilinmeyen rolde yok (`/me` açıklama taşımaz). */
export function roleDescriptionOf(p: Pick<MeProduct, 'key' | 'role' | 'roleKind'> | undefined, locale: Locale): string | undefined {
  if (!p?.role || p.roleKind === 'custom') return undefined;
  return productRole(p.key, p.role)?.description[locale];
}

const open = (me: MeResponse | null) => (me?.products ?? []).filter((p) => p.available && p.subscription);

/** Ekip ekranının araçları: bu firmada açık, aboneliği olan ve rol tanımı olan araçlar (kayıt sırasıyla). */
export const teamProducts = (me: MeResponse | null): ProductKey[] =>
  PRODUCT_KEYS.filter((k) => {
    const p = meProduct(me, k);
    return !!p && p.available && !!p.subscription && PRODUCTS[k].roles.length > 0;
  });

/** Genel Bakış ve Etkinlik kapısı `reports.view`, Analiz ile aynı (Deciship routes/platform.ts). */
export const overviewProducts = (me: MeResponse | null) => open(me).filter(canAnalytics);
export const analyticsProducts = (me: MeResponse | null) => open(me).filter(canAnalytics);
export const dataProducts = (me: MeResponse | null) => open(me).filter(canData);

export const canSeeActivity = (me: MeResponse | null) => isOrgAdmin(me) || overviewProducts(me).length > 0;

/** Web'de iş yapacak aracı olmayan ve yönetici olmayan kişi: sade Merkez. */
export const isSimpleHub = (me: MeResponse | null) => !isOrgAdmin(me) && overviewProducts(me).length === 0;

/**
 * Kurulum açık mı? `completed` false ya da zorunlu bir adım eksik.
 * DeciShip `completed`i bant kuralından verir (`!showBanner`): sihirbazsız taşıyıcı eklenince true olur ama tarife ya da fatura hâlâ yoktur.
 */
export function isSetupOpen(overview: HubOverview | undefined): boolean {
  const setup = overview?.setup;
  if (!setup) return false;
  return !setup.completed || !!setup.steps?.some((s) => s.required && !s.done);
}
