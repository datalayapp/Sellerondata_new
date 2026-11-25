import type { LocalizedText, SubscriptionStatus } from './catalog.ts';

/**
 * Denetim izi eylem etiketleri. `GET /org/audit` öğesi: `action` kod, `label` dile göre metin, `details` ayrıntı.
 * Yeni eylem buraya yazılır: Hesap testi etiketsiz eylemi yakalar.
 */
export const AUDIT_ACTION_LABEL: Record<string, LocalizedText> = {
  'org.created': { tr: 'Firma açıldı', en: 'Company created' },
  'org.updated': { tr: 'Firma bilgileri güncellendi', en: 'Company details updated' },
  'org.ownership_transferred': { tr: 'Sahiplik devredildi', en: 'Ownership transferred' },
  'org.closed': { tr: 'Firma kapatıldı', en: 'Company closed' },
  'org.reopened': { tr: 'Firma geri açıldı', en: 'Company reopened' },
  'org.purged': { tr: 'Firma kalıcı olarak silindi', en: 'Company permanently deleted' },
  'member.joined': { tr: 'Üye katıldı', en: 'Member joined' },
  'member.left': { tr: 'Üye firmadan ayrıldı', en: 'Member left the company' },
  'member.removed': { tr: 'Üye çıkarıldı', en: 'Member removed' },
  'member.updated': { tr: 'Üyelik güncellendi', en: 'Membership updated' },
  'member.reset_code_issued': { tr: 'Şifre kodu üretildi', en: 'Password code created' },
  'invitation.created': { tr: 'Davet gönderildi', en: 'Invitation sent' },
  'invitation.resent': { tr: 'Davet yeniden gönderildi', en: 'Invitation resent' },
  'invitation.revoked': { tr: 'Davet iptal edildi', en: 'Invitation cancelled' },
  'person.password_changed': { tr: 'Şifre değiştirildi', en: 'Password changed' },
  'person.password_reset': { tr: 'Şifre sıfırlandı', en: 'Password reset' },
  'person.password_reset_by_code': { tr: 'Şifre kodla yenilendi', en: 'Password reset with a code' },
  'person.identity_changed': { tr: 'E-posta veya telefon değiştirildi', en: 'Email or phone changed' },
  'person.phone_linked': { tr: 'Telefon numarası hesaba bağlandı', en: 'Phone number linked to the account' },
  'session.revoked': { tr: 'Oturum kapatıldı', en: 'Session closed' },
  'operator.step_up': { tr: 'Platform yöneticisi şifresini yeniden girdi', en: 'Platform operator re-entered their password' },
  'session.reuse_detected': { tr: 'Şüpheli oturum kullanımı, oturum kapatıldı', en: 'Suspicious session use, session closed' },
  'session.retry_accepted': { tr: 'Yanıtı kaybolan oturum yenilemesi tekrarla tamamlandı', en: 'Interrupted session refresh completed on retry' },
  'support.phone_released': { tr: 'Destek numarayı hesaptan ayırdı', en: 'Support removed the phone number from the account' },
  'support.phone_restored': { tr: 'Destek hesabı geri açtı', en: 'Support restored the account' },
  'support.subscription_changed': { tr: 'Abonelik değişti', en: 'Subscription changed' },
  'support.org_closed': { tr: 'Destek firmayı kapattı', en: 'Support closed the company' },
  'support.org_reopened': { tr: 'Destek firmayı yeniden açtı', en: 'Support reopened the company' },
  'support.signup_purged': { tr: 'Destek kullanılmamış kaydı sildi', en: 'Support deleted an unused sign-up' },
  'support.signup_invite_created': { tr: 'Destek kayıt daveti üretti', en: 'Support created a sign-up invitation' },
  'support.signup_invite_revoked': { tr: 'Destek kayıt davetini iptal etti', en: 'Support cancelled a sign-up invitation' },
  'signup.invite_used': { tr: 'Hesap kayıt davetiyle açıldı', en: 'Account opened with a sign-up invitation' },
  'person.email_verified': { tr: 'E-posta doğrulandı', en: 'Email verified' },
  'person.email_change_requested': { tr: 'E-posta değişikliği istendi', en: 'Email change requested' },
  'session.created': { tr: 'Giriş yapıldı', en: 'Signed in' },
  'session.expired': { tr: 'Oturum üst süreye ulaştı, yeniden giriş istendi', en: 'Session reached its maximum age, sign-in required' },
  'login.locked': { tr: 'Çok fazla hatalı giriş denemesi', en: 'Too many failed sign-in attempts' },
  'outbox.dead_purged': { tr: 'Teslim edilemeyen olaylar silindi', en: 'Undeliverable events deleted' },
  'role.created': { tr: 'Rol oluşturuldu', en: 'Role created' },
  'role.updated': { tr: 'Rol güncellendi', en: 'Role updated' },
  'role.deleted': { tr: 'Rol silindi', en: 'Role deleted' },
  'role.reset': { tr: 'Rol varsayılana döndürüldü', en: 'Role reset to default' },
};

/**
 * `member.updated` ayrıntısı: neyin, neden neye değiştiği.
 * `productRole`: `from`/`to` rol anahtarıdır (`MEASURE` ya da `custom:<uuid>`); `fromLabel`/`toLabel` değişiklik anındaki rol adı
 * (özel rol sonradan silinse ya da adı değişse de iz okunur kalsın). Eski kayıtlarda yok: arayüz katalog adına düşer.
 */
export type AuditMemberChange =
  | { field: 'orgRole'; from: string; to: string }
  | { field: 'status'; from: string; to: string }
  | { field: 'productRole'; product: string; from: string | null; to: string | null; fromLabel?: string | null; toLabel?: string | null };

/**
 * `role.created|updated|deleted|reset` ayrıntısı. `role`: rol anahtarı; `name`: işlem sonrası ad (silmede silinen ad).
 * - `created`: `permissions` (katalog sırası), varsa `basedOn`.
 * - `updated`: değişen alanlar: `previousName` (ad değiştiyse), `added`/`removed` (izin farkı), `descriptionChanged`.
 * - `deleted`: `reassignTo` + `reassignToLabel` (kullanımdaysa), `members`/`invites` (taşınan sayı), `moved` (taşınan her üyelik
 *   ve davet, eski/yeni rol anahtarı ve adıyla). Hazır rolde `kind: 'builtin'` (rol firmada gizlendi, katalogdan silinmedi).
 * - `reset`: hazır role dönüş; `previousName` ve `added`/`removed` (gölge satırdan katalog haline fark), `unhidden` (gizliydi, geri geldi).
 */
export type AuditRoleChange = {
  product: string;
  role: string;
  kind: 'builtin' | 'custom';
  name: string;
  previousName?: string;
  permissions?: string[];
  basedOn?: string;
  added?: string[];
  removed?: string[];
  descriptionChanged?: boolean;
  unhidden?: boolean;
  reassignTo?: string | null;
  reassignToLabel?: string | null;
  members?: number;
  invites?: number;
  /** `deleted`: taşınanlar. `id` üyelikte `Membership.id`, davette `Invitation.id`. */
  moved?: { kind: 'member' | 'invitation'; id: string; from: string; to: string; fromLabel: string; toLabel: string }[];
};

/**
 * `support.subscription_changed` ayrıntısı. `via`: hangi komut (`subscription:set`, `product:launch`, `org:close`, `org:reopen`).
 * `from` null: ilk açılış (satır yoktu).
 */
export type AuditSubscriptionChange = {
  product: string;
  from: SubscriptionStatus | null;
  to: SubscriptionStatus;
  plan: string;
  via: 'set' | 'launch' | 'close' | 'reopen';
  operator: string;
  reason?: string;
};

/** `support.org_closed` ayrıntısı. `org:reopen` son kapanış kaydındaki listeyi geri yükler. */
export type AuditOrgClosed = {
  subscriptions: { product: string; from: Exclude<SubscriptionStatus, 'CANCELED'> }[];
  days: number;
  operator: string;
  reason?: string;
};

/**
 * Sahibin firmayı kapatması (`POST /org/close`). Destek komutunun `support.org_closed` kaydından ayrıdır.
 * - `org.closed`: `{ closedAt, purgeAfter, members }` (ISO anlar; `members` epoch'u artan üyelik sayısı).
 * - `org.reopened`: `{ closedAt, purgeAfter }` (geri açılan kapanışın anları).
 * - `org.purged`: firma silindiği için `orgId` boş yazılır, `target` silinen firmanın kimliğidir; `{ orgId, name, closedAt, purgeAfter,
 *   memberships, invitations }`. Firmanın önceki denetim kayıtları silinmez (kişi ve güvenlik izi).
 */
export type AuditOrgClosure = { closedAt: string; purgeAfter: string; members?: number };

/** `GET /org/audit` öğesi. */
export type AuditEntry = {
  id: string;
  at: string;
  actor: string | null;
  /** Kod. Arayüz etiketi `label`dan gösterir. */
  action: string;
  label: string;
  target: string | null;
  /** Hedef kişinin adı, biliniyorsa. */
  targetName: string | null;
  /** Eyleme göre ayrıntı. `member.updated`: `{ changes: AuditMemberChange[] }`. `role.*`: `AuditRoleChange`. */
  details: Record<string, unknown> | null;
  /** `details` ile aynı. Eski istemciler için. */
  meta: Record<string, unknown> | null;
};
