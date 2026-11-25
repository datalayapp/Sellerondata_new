/**
 * Ürün, rol ve izin kataloğu. Kaynak `products.ts` kaydıdır; buradaki her şey ondan türer (elle ürün yazılmaz).
 * Kod rol adına bakmaz, `can(role, permission)` veya jetondan türetilen izin listesine bakar.
 */

import {
  LOCALES,
  PRODUCT_REGISTRY,
  checkRolePermissions,
  closeEntryPermissions,
  requiredEntryPermissions,
  rolePermissions,
  type Locale,
  type LocalizedText,
  type ProductEntry,
  type ProductLaunch,
  type ProductPermissionGroup,
  type RolePermissionsCheck,
} from './products.ts';

export { LOCALES, type Locale, type LocalizedText };

type Registry = typeof PRODUCT_REGISTRY;
type RegistryEntry = Registry[number];

export type ProductKey = RegistryEntry['key'];

/** Kayıt sırasıyla anahtarlar (demet türü: `[0]` tanımlı, `z.enum` ile kullanılabilir). */
type KeysOf<T extends readonly unknown[]> = { readonly [I in keyof T]: T[I] extends { key: infer K } ? K : never };
export const PRODUCT_KEYS = Object.freeze(PRODUCT_REGISTRY.map((e) => e.key)) as unknown as KeysOf<Registry>;

/** Her girdinin izin anahtarlarının birleşimi (dağılımlı: izinsiz araç birleşime bir şey katmaz). */
type PermissionsOf<E> = E extends { permissions: infer R } ? Extract<keyof R, string> : never;
export type Permission = PermissionsOf<RegistryEntry>;

export type OrgRole = 'OWNER' | 'ADMIN' | 'MEMBER';
export const ORG_ROLES: readonly OrgRole[] = ['OWNER', 'ADMIN', 'MEMBER'];
export const ORG_ROLE_LABEL: Record<OrgRole, LocalizedText> = {
  OWNER: { tr: 'Firma sahibi', en: 'Company owner' },
  ADMIN: { tr: 'Firma yöneticisi', en: 'Company admin' },
  MEMBER: { tr: 'Çalışan', en: 'Employee' },
};

export type SubscriptionStatus = 'ACTIVE' | 'READ_ONLY' | 'CANCELED';

/** Deneme planı bilinçli olarak yoktur (kullanıcı kararı, 2026-11-06). */
export const PLAN_EARLY_ACCESS = 'early_access';

export type ProductRoleDef = {
  key: string;
  label: LocalizedText;
  description: LocalizedText;
  permissions: readonly Permission[];
};

/** Kayıt girdisi + türetilen alanlar. Alanların anlamı `products.ts` `ProductEntry`'dedir. */
export type ProductDef = {
  key: ProductKey;
  name: string;
  tagline: LocalizedText;
  /** Ray ve başlıkta kullanılan yol: `/<key>`. */
  basePath: string;
  /** İşaret ve etkin araç belirteci rengi. Düğmeler her üründe aynı mavidir. */
  color: string;
  /** Kayıttaki varsayılan durum. Çalışırken geçerli durum Hesap servisindedir (`PRODUCT_LAUNCH`); istemci `me.products[]`'ten okur. */
  launch: ProductLaunch;
  roles: readonly ProductRoleDef[];
  /** Yeni firmanın sahibine verilen rol. */
  ownerRole: string | null;
  /** Merkez'deki davet formunun varsayılan rolü. */
  inviteRole: string | null;
  /** İzin anahtarı → etiket (yalnız bu ürünün izinleri). */
  permissions: Readonly<Partial<Record<Permission, LocalizedText>>>;
  /** Web uygulamasına giriş izni; web'i olmayan araçta yok. */
  webAccess?: Permission;
  /** `Platform/brand/<dosya>.svg`; yoksa tek harfli işaret. */
  mark?: string;
  /** Merkez'de Analiz, Veriler ve CSV'yi hangi izin açar. Merkez ürüne özel izin adı bilmez. `headline`: Genel Bakış'ın baş rakamlarının KPI kimlikleri, önem sırasıyla. */
  hub?: { analytics: Permission; data: Permission; export: Permission; headline?: string[] };
  /** İzin → doğrudan gereksinimleri. Geçişli hal: `closePermissions`, `requiredPermissionsOf`. */
  permissionRequires?: Readonly<Partial<Record<Permission, readonly Permission[]>>>;
  /** Rol düzenleyicideki izin kümeleri, gösterim sırasıyla. */
  permissionGroups?: readonly ProductPermissionGroup<Permission>[];
  /** İzinleri kilitli hazır roller. Sahip rolü her zaman kilitlidir: `isRolePermissionsLocked`. */
  lockedRoles?: readonly string[];
  /** Yalnız firma sahibinin role koyabildiği, atayabildiği ve davetle verebildiği izinler. */
  ownerOnlyPermissions?: readonly Permission[];
  deploy?: ProductEntry['deploy'];
  site?: ProductEntry['site'];
  mobile?: ProductEntry['mobile'];
  /** Yapay zekâ geçidi girdisi (amaçlar, izinli modeller, varsayılan tavan); yoksa araç geçidi kullanmaz. */
  ai?: ProductEntry['ai'];
};

function toDef(e: ProductEntry): ProductDef {
  const { hub, ...rest } = e;
  const def = {
    ...rest,
    key: e.key as ProductKey,
    basePath: `/${e.key}`,
    roles: e.roles as readonly ProductRoleDef[],
    permissions: e.permissions as ProductDef['permissions'],
    webAccess: e.webAccess as Permission | undefined,
  } as ProductDef;
  if (def.webAccess === undefined) delete def.webAccess;
  if (hub) {
    def.hub = { analytics: hub.analytics as Permission, data: hub.data as Permission, export: hub.export as Permission };
    if (hub.headline) def.hub.headline = [...hub.headline];
  }
  return def;
}

export const PRODUCTS: Record<ProductKey, ProductDef> = Object.fromEntries(
  (PRODUCT_REGISTRY as readonly ProductEntry[]).map((e) => [e.key, toDef(e)]),
) as Record<ProductKey, ProductDef>;

// İzin dizileri tüm istekler arasında paylaşılır: bir yerde değişmesi herkesin yetkisini değiştirir.
for (const def of Object.values(PRODUCTS)) {
  for (const r of def.roles) Object.freeze(r.permissions);
  if (def.permissionRequires) {
    for (const list of Object.values(def.permissionRequires)) if (list) Object.freeze(list);
    Object.freeze(def.permissionRequires);
  }
  for (const g of def.permissionGroups ?? []) Object.freeze(g.permissions);
  if (def.permissionGroups) Object.freeze(def.permissionGroups);
  if (def.lockedRoles) Object.freeze(def.lockedRoles);
  if (def.ownerOnlyPermissions) Object.freeze(def.ownerOnlyPermissions);
  if (def.ai) {
    Object.freeze(def.ai.models);
    Object.freeze(def.ai.purposes);
    Object.freeze(def.ai);
  }
}

// ---------- Yapay zekâ geçidi ----------

/** Geçidi kullanan araçlar (kayıtta `ai` girdisi olanlar), kayıt sırası. */
export function aiProductKeys(): ProductKey[] {
  return PRODUCT_KEYS.filter((k) => PRODUCTS[k].ai !== undefined);
}

/** Amaç bu aracın kayıtlı amacı mı (`<ürün>.<amaç>`; başka aracın amacı false). Geçit `sod_purpose_unknown` kararını buna dayandırır. */
export function isAiPurposeOf(product: ProductKey, purpose: string): boolean {
  const purposes = PRODUCTS[product].ai?.purposes as Readonly<Record<string, LocalizedText>> | undefined;
  return !!purposes && Object.hasOwn(purposes, purpose);
}

/** Model bu aracın izin listesinde mi (`sod_model_not_allowed`). Tarih ekli ad (`…-20261001`) kök adla eşleşir. */
export function isAiModelAllowed(product: ProductKey, model: string): boolean {
  const models = PRODUCTS[product].ai?.models ?? [];
  const name = model.trim();
  return models.includes(name) || models.includes(name.replace(/-\d{8}$/, ''));
}

/** Amacın etiketi (isteğin dilinde); bilinmeyen amaçta amaç anahtarının kendisi. */
export function aiPurposeLabel(purpose: string, locale: Locale): string {
  for (const def of Object.values(PRODUCTS)) {
    const purposes = def.ai?.purposes as Readonly<Record<string, LocalizedText>> | undefined;
    if (purposes && Object.hasOwn(purposes, purpose)) return purposes[purpose]![locale];
  }
  return purpose;
}

/** Kayıttaki ürün anahtarı mı (adres, sorgu ya da ortam değişkeninden gelen metin için). */
export function isProductKey(value: unknown): value is ProductKey {
  return typeof value === 'string' && Object.hasOwn(PRODUCTS, value);
}

/** Web dağıtımı olan araçlar (gateway web blokları, kabuk bağlantısı). Kayıt sırası. */
export function webProductKeys(): ProductKey[] {
  return PRODUCT_KEYS.filter((k) => PRODUCTS[k].deploy?.web !== undefined);
}

/** Web dağıtımı olmayan araçlar: `/<key>` yolları Merkez'indir ("Yakında" ya da Merkez'de o araç). `webProductKeys`'in tümleyeni. */
export function hubOwnedProductKeys(): ProductKey[] {
  return PRODUCT_KEYS.filter((k) => PRODUCTS[k].deploy?.web === undefined);
}

export function productRole(product: ProductKey, role: string | null | undefined): ProductRoleDef | undefined {
  if (!role) return undefined;
  return PRODUCTS[product].roles.find((r) => r.key === role);
}

export function isValidProductRole(product: ProductKey, role: string): boolean {
  return productRole(product, role) !== undefined;
}

export function permissionsOf(product: ProductKey, role: string | null | undefined): readonly Permission[] {
  return rolePermissions(PRODUCTS[product], role);
}

export function can(product: ProductKey, role: string | null | undefined, permission: Permission): boolean {
  return permissionsOf(product, role).includes(permission);
}

// ---------- Özel roller: izin bağımlılıkları ve kilitler ----------

/** Bağımlılıkla kapanmış set: bilinen izinler + geçişli gereksinimleri, katalog sırasıyla, tekil. Bilinmeyen anahtar düşer. */
export function closePermissions(product: ProductKey, perms: Iterable<string>): Permission[] {
  return closeEntryPermissions(PRODUCTS[product], perms) as Permission[];
}

/** İznin geçişli gereksinimleri (kendisi hariç), katalog sırasıyla. `OrgRolesResponse` `requires` alanı budur. */
export function requiredPermissionsOf(product: ProductKey, perm: string): Permission[] {
  return requiredEntryPermissions(PRODUCTS[product], perm) as Permission[];
}

/**
 * Role yazılacak izin setini denetler; bir şey eklemez. Eksik bağımlılık ya da bilinmeyen izin → `400 INVALID_ROLE_PERMISSIONS`
 * (`details` = `{ missing, unknown }`). Boş set geçerlidir (anlamlı mı, çağıran karar verir).
 */
export function validateRolePermissions(product: ProductKey, perms: readonly string[]): RolePermissionsCheck {
  return checkRolePermissions(PRODUCTS[product], perms);
}

/** Setteki izinleri katalog sırasına dizer, tekilleştirir, bilinmeyeni atar (kayıt ve `added`/`removed` karşılaştırması için). */
export function orderPermissions(product: ProductKey, perms: Iterable<string>): Permission[] {
  const set = new Set(perms);
  return (Object.keys(PRODUCTS[product].permissions) as Permission[]).filter((p) => set.has(p));
}

/** Hazır rolün izinleri firma içinde değiştirilemez mi: sahip rolü ya da `lockedRoles`. Özel rol (`custom:`) hiç kilitli değildir. */
export function isRolePermissionsLocked(product: ProductKey, role: string): boolean {
  const def = PRODUCTS[product];
  return role === def.ownerRole || (def.lockedRoles ?? []).includes(role);
}

/** Rol firmada silinebilir mi (yetki kuralları ayrı): ürünün sahip rolü hiç silinemez (`403 ROLE_LOCKED`); diğer hazır roller gizlenir. */
export function isRoleDeletable(product: ProductKey, role: string): boolean {
  return role !== '' && role !== PRODUCTS[product].ownerRole;
}

/**
 * Davet formunun önseçili rolü. `available`: firmada görünen roller, gösterim sırasıyla (`OrgRolesResponse.roles[].key`).
 * Katalogdaki `inviteRole` görünüyorsa o, gizlenmişse (silinmişse) kalan ilk rol, hiç rol yoksa null.
 */
export function pickInviteRole(product: ProductKey, available: readonly string[]): string | null {
  const preferred = PRODUCTS[product].inviteRole;
  if (preferred !== null && available.includes(preferred)) return preferred;
  return available[0] ?? null;
}

/** Setteki sahibe özel izinler (yalnız OWNER koyar, atar, davetle verir). Boşsa set firma yöneticisine de açıktır. */
export function ownerOnlyPermissionsIn(product: ProductKey, perms: Iterable<string>): Permission[] {
  const only = PRODUCTS[product].ownerOnlyPermissions ?? [];
  const set = new Set(perms);
  return only.filter((p) => set.has(p));
}

/** İznin rol düzenleyicideki kümesi; kümesi yoksa `undefined`. */
export function permissionGroupOf(product: ProductKey, perm: string): string | undefined {
  return PRODUCTS[product].permissionGroups?.find((g) => (g.permissions as readonly string[]).includes(perm))?.key;
}

/** İzin açıklamaları. Merkez'deki rol matrisi ve `GET /catalog` kullanır. */
export const PERMISSION_LABEL: Record<Permission, LocalizedText> = Object.assign(
  {},
  ...(PRODUCT_REGISTRY as readonly ProductEntry[]).map((e) => e.permissions),
) as Record<Permission, LocalizedText>;

/** @deprecated Mesaj 11 Tur 1'de kalkar (okuyan yok). Yerine `Object.keys(PRODUCTS.deciship.permissions)` ya da `PERMISSION_LABEL`. */
export const DECISHIP_PERMISSIONS: readonly Permission[] = Object.freeze(Object.keys(PRODUCTS.deciship.permissions) as Permission[]);

/** Yeni firma kaydının kipi: `open` herkes, `invite` yalnız kayıt davetiyle. */
export type SignupMode = 'open' | 'invite';
export const SIGNUP_MODES: readonly SignupMode[] = ['open', 'invite'];

/** `GET /api/account/catalog` yanıtı: metinler isteğin diline göre çözülmüş gelir. */
export type CatalogResponse = {
  locale: Locale;
  /** REGISTRATION_ENABLED. Kapalıysa kayıt ve `POST /orgs` `REGISTRATION_CLOSED` döner. */
  registrationEnabled?: boolean;
  /**
   * SIGNUP_MODE (kullanıcı kararı 2026-11-12). `invite`: yeni firma kaydı yalnız destek komutuyla üretilen kayıt davetiyle
   * (`signup:invite`); davetsiz kayıt `SIGNUP_INVITE_REQUIRED`, `POST /orgs` de kapalı. Firmaya ekip daveti etkilenmez.
   */
  signupMode?: SignupMode;
  /** Posta gönderiliyor mu. "Şifremi unuttum" ekranı buna göre davranır. */
  mailEnabled?: boolean;
  products: {
    key: ProductKey;
    name: string;
    tagline: string;
    basePath: string;
    color: string;
    /** Çalışırken geçerli durum `public` mi (Mesaj 11'den sonra; öncesinde "ürün hazır"). */
    available: boolean;
    /** Çalışırken geçerli durum (`PRODUCT_LAUNCH ?? kayıt`). */
    launch: ProductLaunch;
    roles: { key: string; label: string; description: string; permissions: readonly Permission[] }[];
  }[];
  orgRoles: { key: OrgRole; label: string }[];
  permissions: { key: Permission; label: string }[];
};
