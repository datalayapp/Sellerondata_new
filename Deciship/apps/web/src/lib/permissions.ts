import type { MeResponse, Permission } from '@sellerondata/contracts';

/**
 * Görünürlük tek yerde (ARCHITECTURE §1, §5). Kod ürün rolü adına bakmaz; `me.products[].permissions` ve aboneliğe bakar.
 * Sunucu her isteği yine denetler: burası yalnız arayüzü sadeleştirir.
 */
const WRITE_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'deciship.settings.manage',
  'deciship.tariffs.edit',
  'deciship.invoices.upload',
  'deciship.lines.decide',
  'deciship.disputes.manage',
  'deciship.measurements.capture',
  'deciship.measurements.manage',
]);

export const productOf = (me: MeResponse | null) => me?.products.find((p) => p.key === 'deciship');

/** Abonelik etkin değilse (salt okunur, iptal) durum değiştiren izinler arayüzde kapalı sayılır (§5, 403 READ_ONLY). */
export function subscriptionWritable(me: MeResponse | null): boolean {
  return productOf(me)?.subscription?.status === 'ACTIVE';
}

/** Rolün verdiği izin, abonelikten bağımsız. Sayfa ve menü görünürlüğü: salt okunur abonelikte kayıtlar açık kalır. */
export function holdsPermission(me: MeResponse | null, permission: Permission): boolean {
  return !!productOf(me)?.permissions.includes(permission);
}

/** Bu işlem şu an yapılabilir mi: izin var ve (yazma ise) abonelik etkin. Düğme ve form görünürlüğü. */
export function hasPermission(me: MeResponse | null, permission: Permission): boolean {
  if (!holdsPermission(me, permission)) return false;
  return !WRITE_PERMISSIONS.has(permission) || subscriptionWritable(me);
}

export const hasWebAccess = (me: MeResponse | null) => holdsPermission(me, 'deciship.web.access');

/** Firma adı ve ekip Merkez'de: yönetim sayfası yalnız firma sahibi ve yöneticisine açıktır (§8). */
export function isOrgAdmin(me: MeResponse | null): boolean {
  const role = me?.activeOrg?.orgRole;
  return role === 'OWNER' || role === 'ADMIN';
}
