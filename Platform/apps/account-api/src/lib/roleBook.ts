/**
 * Firmanın rol defteri ve rol çözücü. Jeton (`perms`), `/me`, olay (`member.upserted.permissions`),
 * bildirim alıcıları, üye listesi ve atama doğrulaması rolü buradan çözer: hiçbiri katalog sabitine doğrudan bakmaz.
 *
 * Kurallar:
 * - Hazır rol (katalog anahtarı, `MEASURE`): firmada gölge satır yoksa katalog. Gölge satır ad/açıklama/izin yazabilir; boş alan
 *   katalogdan gelir. Gizli (`hidden`) hazır rol atanamaz ve izin vermez. Kilitli rolün (sahip rolü) izinleri her zaman katalogdur.
 * - Özel rol (`custom:<uuid>`): firmanın o üründeki satırı; yoksa (başka firma, başka ürün, silinmiş) rol yok sayılır.
 * - İzinler her zaman katalogla kesişir ve katalog sırasındadır (`orderPermissions`): katalogdan kalkan izin kendiliğinden düşer.
 *
 * Bu dosya `members.ts`'e bağlı değildir (döngü olmasın); yazma işleri `roles.ts`'tedir.
 */

import {
  PRODUCTS,
  customRoleIdOf,
  isCustomRoleKey,
  isProductKey,
  isRolePermissionsLocked,
  orderPermissions,
  productRole,
  type Locale,
  type LocalizedText,
  type Permission,
  type ProductKey,
  type RoleKind,
} from '@sellerondata/contracts';
import { Prisma, type PrismaClient, type Tx } from '../db.ts';

type Db = PrismaClient | Tx;

export type RoleRow = {
  id: string;
  orgId: string;
  product: string;
  name: string | null;
  description: string | null;
  permissions: string[];
  inheritPermissions: boolean;
  basedOn: string | null;
  builtinKey: string | null;
  hidden: boolean;
  version: number;
  createdAt: Date;
};

export const ROLE_ROW_SELECT = {
  id: true,
  orgId: true,
  product: true,
  name: true,
  description: true,
  permissions: true,
  inheritPermissions: true,
  basedOn: true,
  builtinKey: true,
  hidden: true,
  version: true,
  createdAt: true,
} as const;

/** Bir firmanın bütün rol satırları, hızlı arama için. */
export type RoleBook = {
  /** `ProductRole.id` → özel rol satırı. */
  custom: ReadonlyMap<string, RoleRow>;
  /** `ürün\0anahtar` → hazır rolün gölge satırı. */
  shadows: ReadonlyMap<string, RoleRow>;
};

export const EMPTY_ROLE_BOOK: RoleBook = { custom: new Map(), shadows: new Map() };

const shadowKey = (product: string, key: string) => `${product}\u0000${key}`;

export function roleBookOf(rows: readonly RoleRow[]): RoleBook {
  const custom = new Map<string, RoleRow>();
  const shadows = new Map<string, RoleRow>();
  for (const r of rows) {
    if (r.builtinKey === null) custom.set(r.id, r);
    else shadows.set(shadowKey(r.product, r.builtinKey), r);
  }
  return { custom, shadows };
}

export async function loadRoleBook(db: Db, orgId: string): Promise<RoleBook> {
  const rows = await db.productRole.findMany({ where: { orgId }, select: ROLE_ROW_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return roleBookOf(rows);
}

export type ResolvedRole = {
  product: ProductKey;
  /** Hazır rolde katalog anahtarı, özel rolde `custom:<uuid>`. */
  key: string;
  kind: RoleKind;
  /** Katalog sırasıyla, katalogla kesişmiş. */
  permissions: Permission[];
  /** Firmanın yazdığı ad iki dilde aynıdır; hazır rolde (adı değişmediyse) katalog adı. */
  label: LocalizedText;
  description: LocalizedText | null;
  /** Hazır rol firmada düzenlenmiş mi. Özel rolde false. */
  edited: boolean;
  /** Hazır rol firmada gizli (silinmiş) mi. `resolveFromBook` gizli rolü döndürmez. */
  hidden: boolean;
  basedOn: string | null;
  /** Düzenlenmemiş hazır rolde 0. */
  version: number;
  row: RoleRow | null;
};

const textOf = (s: string): LocalizedText => ({ tr: s, en: s });

/** Hazır rolün firmadaki hali; gizli olsa da döner (yönetim ekranı ve geri getirme için). Katalogda yoksa null. */
export function resolveBuiltin(book: RoleBook, product: ProductKey, key: string): ResolvedRole | null {
  const def = productRole(product, key);
  if (!def) return null;
  const shadow = book.shadows.get(shadowKey(product, key)) ?? null;
  const locked = isRolePermissionsLocked(product, key);
  const permissions = shadow && !shadow.inheritPermissions && !locked ? orderPermissions(product, shadow.permissions) : [...def.permissions];
  return {
    product,
    key,
    kind: 'builtin',
    permissions,
    label: shadow?.name ? textOf(shadow.name) : def.label,
    description: shadow?.description != null ? textOf(shadow.description) : def.description,
    edited: !!shadow && (shadow.name !== null || shadow.description !== null || !shadow.inheritPermissions),
    hidden: !!shadow?.hidden,
    basedOn: null,
    version: shadow?.version ?? 0,
    row: shadow,
  };
}

/** Özel rolün satırı bu üründe varsa. */
export function resolveCustom(book: RoleBook, product: ProductKey, key: string): ResolvedRole | null {
  const id = customRoleIdOf(key);
  const row = id ? book.custom.get(id) : undefined;
  if (!row || row.product !== product || row.name === null) return null;
  return {
    product,
    key,
    kind: 'custom',
    permissions: orderPermissions(product, row.permissions),
    label: textOf(row.name),
    description: row.description !== null ? textOf(row.description) : null,
    edited: false,
    hidden: false,
    basedOn: row.basedOn,
    version: row.version,
    row,
  };
}

/**
 * Geçerli (atanabilir, izin veren) rol: hazır rol gizli değilse, özel rol firmanın o ürününde varsa. Aksi null ("rol yok").
 * Abonelik ve ürün durumu burada değil, `productAccessFor`'da.
 */
export function resolveFromBook(book: RoleBook, product: string, role: string | null | undefined): ResolvedRole | null {
  if (!role || !isProductKey(product)) return null;
  if (isCustomRoleKey(role)) return resolveCustom(book, product, role);
  const builtin = resolveBuiltin(book, product, role);
  return builtin && !builtin.hidden ? builtin : null;
}

/** Plan imzası: `resolveRole(orgId, product, role)`. Tek rol için defteri okur; çok rol çözülecekse `loadRoleBook` + `resolveFromBook`. */
export async function resolveRole(db: Db, orgId: string, product: string, role: string | null | undefined): Promise<ResolvedRole | null> {
  if (!role || !isProductKey(product)) return null;
  const id = customRoleIdOf(role);
  const rows = await db.productRole.findMany({
    where: id ? { orgId, id } : { orgId, product, builtinKey: role },
    select: ROLE_ROW_SELECT,
  });
  return resolveFromBook(roleBookOf(rows), product, role);
}

export function roleLabelOf(role: ResolvedRole, locale: Locale): string {
  return role.label[locale];
}

/** Firmada görünen roller, gösterim sırasıyla: önce görünen hazır roller (katalog sırası), sonra özel roller (oluşturulma sırası). */
export function visibleRoles(book: RoleBook, product: ProductKey): ResolvedRole[] {
  const out: ResolvedRole[] = [];
  for (const def of PRODUCTS[product].roles) {
    const r = resolveBuiltin(book, product, def.key);
    if (r && !r.hidden) out.push(r);
  }
  const customs = [...book.custom.values()].filter((r) => r.product === product);
  customs.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
  for (const row of customs) {
    const r = resolveCustom(book, product, `custom:${row.id}`);
    if (r) out.push(r);
  }
  return out;
}

/**
 * Atama ve rol yazımının ortak kilidi (firma + ürün başına danışma kilidi): rol yazımı (oluşturma, düzenleme, silme, varsayılana
 * dönüş) özel, atama (üye rolü, davet, davet kabulü) paylaşımlı alır. Böylece rol düzenlenirken yeni sahip eklenemez, sahip listesi
 * ve sayım (sınır, ad) kilit altında doğrudur. Kilit sırası: bu kilit, rol satırı, kişi, üyelik, davet (ARCHITECTURE §5'e ek).
 */
export async function lockRoleProducts(tx: Tx, orgId: string, products: Iterable<string>, mode: 'share' | 'exclusive') {
  await lockRoleKeys(tx, [...products].map((p) => `product-role:${orgId}:${p}`), mode);
}

async function lockRoleKeys(tx: Tx, keys: string[], mode: 'share' | 'exclusive') {
  for (const key of [...new Set(keys)].sort()) {
    if (mode === 'exclusive') await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    else await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`;
  }
}

/**
 * Davet kabulünün ilk kilidi (kişi ve davet satırından ÖNCE): kilitsiz okunan bekleyen davetlerin rol verdiği her (firma, ürün)
 * için paylaşımlı ürün rol kilidi. Rol silme (`deleteRole`) önce bu kilidi özel alıp sonra davetleri yazar; kabul davet satırını
 * kilitleyip bu kilidi sonra isteseydi ikisi birbirini beklerdi (40P01). Firmalar arası sıra anahtar sırasıdır.
 */
export async function lockInvitationRoleProducts(tx: Tx, invitations: readonly { orgId: string; productRoles: Prisma.JsonValue }[]) {
  const keys: string[] = [];
  for (const i of invitations) {
    for (const [product, role] of Object.entries((i.productRoles ?? {}) as Record<string, unknown>)) {
      if (typeof role === 'string') keys.push(`product-role:${i.orgId}:${product}`);
    }
  }
  await lockRoleKeys(tx, keys, 'share');
}

/**
 * Atanan rollerin satırlarını paylaşımlı kilitler (plan: "atama rol satırını FOR SHARE kilitler"): önce ürün kilidi, sonra özel rol
 * ve gölge satırları kimlik sırasıyla. Satırı olmayan hazır rol yalnız ürün kilidiyle korunur.
 */
export async function lockAssignedRoles(tx: Tx, orgId: string, roles: Record<string, string | null>) {
  const granted = Object.entries(roles).filter((e): e is [string, string] => e[1] !== null);
  if (!granted.length) return;
  await lockRoleProducts(tx, orgId, granted.map(([p]) => p), 'share');
  const customIds = granted.map(([, r]) => customRoleIdOf(r)).filter((id): id is string => !!id);
  const builtins = granted.filter(([, r]) => !isCustomRoleKey(r));
  const or: Prisma.Sql[] = [];
  if (customIds.length) or.push(Prisma.sql`"id" IN (${Prisma.join(customIds)})`);
  for (const [p, r] of builtins) or.push(Prisma.sql`("product" = ${p} AND "builtinKey" = ${r})`);
  await tx.$queryRaw`SELECT 1 FROM "platform"."ProductRole" WHERE "orgId" = ${orgId} AND (${Prisma.join(or, ' OR ')}) ORDER BY "id" FOR SHARE`;
}
