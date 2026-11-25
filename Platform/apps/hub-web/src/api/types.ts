import type { OrgRole, ProductKey, SubscriptionStatus } from '@sellerondata/contracts';

/*
 * Hesap API yanıt şekilleri (ARCHITECTURE §6). `contracts` içinde tanımı olmayanlar burada.
 * Kaynak: apps/account-api/src/routes/{org,me,join}.ts.
 */

export type ProductRoles = Partial<Record<ProductKey, string | null>>;

export type OrgMember = {
  /** Membership.id */
  id: string;
  personId: string;
  name: string;
  email: string | null;
  phone: string | null;
  orgRole: OrgRole;
  status: 'ACTIVE' | 'SUSPENDED';
  lastActiveAt: string | null;
  productRoles: ProductRoles;
  /** E-posta doğrulanmış mı. Sahiplik yalnız doğrulanmış adrese devredilir. */
  emailVerified?: boolean;
  /** Sunucu kuralı: aktif, e-postasız ve yalnız bu firmada. */
  resetCodeAllowed?: boolean;
};

export type OrgInvitation = {
  id: string;
  /** PHONE_RESET: yöneticinin ürettiği şifre kodu. */
  kind: 'EMAIL' | 'PHONE_CODE' | 'PHONE_RESET';
  email: string | null;
  phone: string | null;
  name: string | null;
  orgRole: OrgRole;
  productRoles: ProductRoles | null;
  expiresAt: string;
  expired?: boolean;
  attempts?: number;
  createdAt: string;
};

export type InviteBody = {
  kind: 'EMAIL' | 'PHONE_CODE';
  email?: string;
  phone?: string;
  name: string;
  orgRole: OrgRole;
  productRoles: ProductRoles;
};

/** Kod veya bağlantı yalnız bu yanıtta gelir; sonradan okunamaz, `resend` yenisini üretir. */
export type InviteResult = { invitation?: OrgInvitation; code?: string; link?: string; /** false: e-posta gitmedi (gönderim hatası veya alıcı sınırı), bağlantıyı yönetici iletir. */ mailSent?: boolean };
export type ResetCodeResult = { invitation?: OrgInvitation; code: string };

/** `GET /org/audit` öğesi: `action` kod, `target` kimlik. Metne arayüz çevirir. */
export type AuditItem = { id: string; at: string; actor: string | null; action: string; target: string | null; label?: string; targetName?: string | null; details?: Record<string, unknown> | null; meta?: Record<string, unknown> | null };
export type AuditPage = { items: AuditItem[]; page: number; pageSize: number; total: number };

/** `companyConfirmedAt`: Merkez kurulumunun firma onayı (ISO); `null` onay bekliyor, alan yoksa (eski sunucu) onaylı sayılır (`isCompanyConfirmed`). */
export type OrgInfo = { id: string; name: string; country: string; currency: string; locale?: string; timeZone?: string; createdAt?: string; companyConfirmedAt?: string | null };

export type OrgSubscription = {
  product: ProductKey;
  status: SubscriptionStatus;
  plan: string;
  currentPeriodEnd?: string | null;
  /** İptalde okunabilir kalınan son gün (UTC ISO); iptal değilse yok. */
  deleteAfter?: string | null;
};

export type PersonSession = {
  id: string;
  client: 'web' | 'mobile';
  userAgent: string | null;
  ip: string | null;
  lastUsedAt: string;
  createdAt?: string;
  current?: boolean;
};

export type InvitePreview = {
  orgName: string;
  email: string | null;
  name: string | null;
  orgRole: OrgRole;
  personExists: boolean;
  expiresAt?: string;
};

/** Sunucu dizi ya da `{ items }` dönebilir; arayüz tek şekil görür. */
export function asList<T>(x: unknown, key = 'items'): T[] {
  if (Array.isArray(x)) return x as T[];
  if (x && typeof x === 'object') {
    const obj = x as Record<string, unknown>;
    if (Array.isArray(obj[key])) return obj[key] as T[];
    const firstArray = Object.values(obj).find(Array.isArray);
    if (firstArray) return firstArray as T[];
  }
  return [];
}
