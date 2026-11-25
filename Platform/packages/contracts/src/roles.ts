import type { LocalizedText, ProductKey } from './catalog.ts';

/**
 * Özel roller (uygulama başına, firma içinde). Kurallar KARARLAR.md'de.
 * Hazır rol anahtarı katalogdaki gibidir (`MEASURE`); firmada düzenlenmiş hazır rol aynı anahtarı korur. Özel rol anahtarı
 * `custom:<uuid>`'dir (Hesap servisi `ProductRole.id`); üyelik, davet ve jeton bu anahtarı taşır.
 * İzin bağımlılığı ve kilit yardımcıları `catalog.ts`'tedir (`closePermissions`, `validateRolePermissions`, `isRolePermissionsLocked`).
 */

export const CUSTOM_ROLE_PREFIX = 'custom:';

const CUSTOM_ROLE_RE = /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `custom:` + küçük harfli uuid mi. Hazır rol anahtarı (`/^[A-Z][A-Z_]{1,19}$/`) bununla çakışmaz. */
export function isCustomRoleKey(key: unknown): key is `custom:${string}` {
  return typeof key === 'string' && CUSTOM_ROLE_RE.test(key);
}

/** `ProductRole.id` → rol anahtarı. */
export function customRoleKey(id: string): `custom:${string}` {
  return `${CUSTOM_ROLE_PREFIX}${id}`;
}

/** Rol anahtarından `ProductRole.id`; özel rol değilse null. */
export function customRoleIdOf(key: string | null | undefined): string | null {
  return isCustomRoleKey(key) ? key.slice(CUSTOM_ROLE_PREFIX.length) : null;
}

/** Firma başına, ürün başına en çok özel rol (`ROLE_LIMIT`). Hazır rollerin düzenlenmiş hali sayılmaz. Yayından önce gözden geçir. */
export const CUSTOM_ROLE_LIMIT = 20;
/** Rol adı uzunluğu (kırpılmış). Ad firma ve ürün içinde büyük/küçük harf duyarsız tekildir (`ROLE_NAME_TAKEN`). */
export const ROLE_NAME_MIN_LENGTH = 1;
export const ROLE_NAME_MAX_LENGTH = 40;
export const ROLE_DESCRIPTION_MAX_LENGTH = 200;

export type RoleKind = 'builtin' | 'custom';

/** `GET /org/roles` rol öğesi. Metinler (ad, açıklama) isteğin dilinde ya da firmanın yazdığı haliyle gelir. */
export type OrgProductRole = {
  /** Hazır rolde katalog anahtarı (`MEASURE`), özel rolde `custom:<uuid>`. */
  key: string;
  kind: RoleKind;
  name: string;
  description?: string;
  /** Katalog sırasıyla. */
  permissions: string[];
  /** Bu rolü taşıyan etkin ve askıdaki üyelik sayısı. */
  memberCount: number;
  /** Bu rolü veren bekleyen davet sayısı. */
  inviteCount: number;
  /** İsteği yapan bu rolü düzenleyebilir/silebilir mi (sahibe özel izin, yönetilemeyen sahip, yetki yükseltme kuralları dahil). */
  editable: boolean;
  /** İzinler kilitli (sahip rolü ya da `lockedRoles`); ad yine değişebilir. */
  permissionsLocked: boolean;
  /**
   * İsteği yapan bu rolü silebilir mi. Ürünün sahip rolü hiç silinemez (`isRoleDeletable`); diğerlerinde `editable` ile aynı kurallar.
   * Hazır rol silinince firmada gizlenir (`hiddenBuiltins`), özel rol satırıyla silinir.
   */
  deletable: boolean;
  /** Hazır rol firmada düzenlenmiş mi ("Varsayılana dön" görünür). Özel rolde false. */
  edited: boolean;
  /** Özel rol hangi hazır rolden başladı (bilgi). */
  basedOn?: string;
  /**
   * İyimser kilit. Firmada hiç dokunulmamış hazır rolde 0; ilk düzenleme gölge satırı 1 ile açar. Sürüm hiç geri gitmez: varsayılana
   * dönüş ve silme de artırır (dönüşten sonra `edited: false` ama `version` > 0 olabilir). `PatchRoleBody.version` bunu gönderir.
   */
  version: number;
};

/** `GET /org/roles` izin öğesi. */
export type OrgRolePermission = {
  key: string;
  label: LocalizedText;
  /** `groups[].key`. */
  group: string;
  /** Geçişli gereksinimler (kendisi hariç), katalog sırasıyla (`requiredPermissionsOf`). */
  requires: string[];
  /** Yalnız firma sahibi bu izni role koyabilir (`ownerOnlyPermissions`). */
  ownerOnly: boolean;
};

/** `GET /api/account/org/roles` yanıtı: etkin firmada açık ve rolü olan her ürün, kayıt sırasıyla. */
export type OrgRolesResponse = {
  products: {
    key: ProductKey;
    /** İzin kümeleri, gösterim sırasıyla. */
    groups: { key: string; label: LocalizedText }[];
    /** Katalog sırasıyla. */
    permissions: OrgRolePermission[];
    /** Önce görünen hazır roller (katalog sırası), sonra özel roller (oluşturulma sırası). Gizlenmiş hazır roller burada yok. */
    roles: OrgProductRole[];
    /**
     * Firmada silinmiş (gizlenmiş) hazır roller, katalog sırasıyla: "Silinen hazır rolleri geri getir"
     * (`POST /org/roles/builtin/:product/:key/reset`). `name` katalog adıdır, isteğin dilinde.
     */
    hiddenBuiltins: { key: string; name: string }[];
    /** Özel rol üst sınırı (`CUSTOM_ROLE_LIMIT`). */
    customRoleLimit: number;
  }[];
};

/** `POST /org/roles` gövdesi. Yanıt `RoleResponse` (201). */
export type CreateRoleBody = {
  product: ProductKey;
  name: string;
  description?: string;
  permissions: string[];
  /** Şablon olarak seçilen hazır rol anahtarı (bilgi; izinler `permissions`'tan okunur). */
  basedOn?: string;
};

/**
 * Rol düzenleme gövdesi. Özel rol: `PATCH /org/roles/:id`; hazır rol: `PATCH /org/roles/builtin/:product/:key`.
 * `description: null` açıklamayı siler. Kilitli rolde `permissions` → `403 ROLE_LOCKED`. Eski `version` → `409 ROLE_VERSION`.
 */
export type PatchRoleBody = {
  name?: string;
  description?: string | null;
  permissions?: string[];
  version: number;
};

/**
 * `POST /org/roles`, `PATCH /org/roles…` ve `POST /org/roles/builtin/:product/:key/reset` yanıtı: rolün son hali.
 * Reset hazır rolü katalogdaki ad ve izinlere döndürür ve gizlenmişse geri getirir (`edited` false; `version` artar, sıfırlanmaz:
 * eski sürümle bekleyen düzenleme `ROLE_VERSION` alsın).
 */
export type RoleResponse = { role: OrgProductRole };

/**
 * Silme yanıtı. Özel rol: `DELETE /org/roles/:id?reassignTo=<rol anahtarı>` (satır silinir).
 * Hazır rol: `DELETE /org/roles/builtin/:product/:key?reassignTo=<rol anahtarı>` (firmada gizlenir: gölge satır `hidden = true`).
 * Kullanımdaki rol `reassignTo` olmadan `409 ROLE_IN_USE`; sahip rolü `403 ROLE_LOCKED`. `reassignTo` görünen, başka bir rol olmalı.
 * Gizli hazır rol atanamaz ve davetle verilemez (`INVALID_PRODUCT_ROLE`).
 */
export type DeleteRoleResponse = { ok: true; reassigned: { members: number; invites: number } };

/** `409 ROLE_IN_USE` ayrıntısı. */
export type RoleInUseDetails = { members: number; invites: number };

/** `400 INVALID_ROLE_PERMISSIONS` ayrıntısı (`validateRolePermissions` sonucunun `ok: false` hali). */
export type InvalidRolePermissionsDetails = { missing: { perm: string; requires: string[] }[]; unknown: string[] };

/**
 * `403 ROLE_FORBIDDEN` nedeni.
 * - `escalation`: firma yöneticisi kendinde olmayan izni role koymak istedi (`permissions` o izinler).
 * - `owner_only`: sahibe özel izin (`ownerOnlyPermissions`) yalnız OWNER'ca konur, atanır, davetle verilir.
 * - `unmanageable_holder`: rolü taşıyan biri isteği yapanın yönetemediği kişi (kendisi, OWNER ya da ADMIN).
 * - `pending_admin_invites`: sahip, sahibe özel izni role ekleyemez (ya da silerken davetleri böyle role taşıyamaz), çünkü rolde firma
 *   yöneticisinin açtığı süresi geçmemiş bekleyen davet var; kabulde ölürlerdi. `invitations` engel olan davetler; sahip onları iptal
 *   eder ya da kendisi yeniden gönderir.
 */
export type RoleForbiddenReason = 'escalation' | 'owner_only' | 'unmanageable_holder' | 'pending_admin_invites';
/** Engel olan davet: kimlik, davetteki ad ve iletişim (e-posta ya da telefon). Firma sahibi bunları davet listesinde de görür. */
export type RoleBlockingInvitation = { id: string; name: string | null; contact: string | null };
export type RoleForbiddenDetails = { reason: RoleForbiddenReason; permissions?: string[]; invitations?: RoleBlockingInvitation[] };

/** `ROLE_FORBIDDEN` için nedene göre metin (servis `message` alanında bunu verir; yoksa `ERROR_MESSAGES.ROLE_FORBIDDEN`). */
export const ROLE_FORBIDDEN_REASONS: Record<RoleForbiddenReason, LocalizedText> = {
  escalation: { tr: 'Kendinizde olmayan bir izni role ekleyemezsiniz.', en: 'You cannot add a permission you do not have yourself.' },
  owner_only: { tr: 'Bu izni yalnız firma sahibi verebilir.', en: 'Only the company owner can give this permission.' },
  unmanageable_holder: {
    tr: 'Bu rolü yönetemediğiniz biri kullanıyor (siz, firma sahibi ya da bir firma yöneticisi).',
    en: 'Someone you cannot manage uses this role (you, the company owner or a company admin).',
  },
  pending_admin_invites: {
    tr: 'Bu rolde bir firma yöneticisinin açtığı bekleyen davetler var. Önce o davetleri iptal edin ya da kendiniz yeniden gönderin.',
    en: 'This role has pending invitations sent by a company admin. Cancel those invitations or resend them yourself first.',
  },
};
