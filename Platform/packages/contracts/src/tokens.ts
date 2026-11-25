import type { Locale, OrgRole, ProductKey, SubscriptionStatus } from './catalog.ts';
import type { ProductLaunch } from './products.ts';

export const TOKEN_ISSUER = 'sellerondata-account';
export const TOKEN_AUDIENCE = 'sellerondata';
export const EVENT_AUDIENCE = 'product-events';
export const TOKEN_ALG = 'EdDSA';

export const ACCESS_TTL_SECONDS = 10 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

export const COOKIE_ACCESS = 'sod_at';
export const COOKIE_REFRESH = 'sod_rt';
export const COOKIE_LANG = 'sod_lang';
export const CSRF_HEADER = 'x-sod-csrf';
/**
 * Tarayıcı istemcisi çerezli her yazma isteğinde ekranda gördüğü firmayı gönderir. Etkin firma çerezdedir ve sekmeler arasında ortaktır:
 * başka sekme firma değiştirdiyse eski sekmenin yazması yanlış firmaya gitmesin. Uyuşmazsa veya yoksa `409 ORG_MISMATCH`. Bearer hariç.
 */
export const ORG_HEADER = 'x-sod-org';
/** Ad ve firma adı için üst sınır. Arayüzler buradan okur. */
export const NAME_MAX_LENGTH = 120;
/** Yeni şifre için en kısa uzunluk. Arayüzler buradan okur. */
export const PASSWORD_MIN_LENGTH = 10;
/**
 * Telefon kodunun (katılım ve şifre kodu) hatalı deneme hakkı. Daveti `attempts` bu sayıya ulaşınca kod ölür, yeni kod üretilmez:
 * davet iptal edilip yeniden yapılır. Hesap servisi (`MAX_CODE_ATTEMPTS`) ve Merkez Ekip ekranı buradan okur.
 */
export const JOIN_CODE_MAX_ATTEMPTS = 20;

export type ProductClaim = {
  /** Kişinin bu üründeki rolü: hazır rol anahtarı (`MEASURE`) ya da `custom:<uuid>`. */
  role: string;
  /**
   * Rolün firmadaki geçerli izinleri (özel rol ya da düzenlenmiş hazır rol çözülmüş). Ürün katalogla kesişimini kullanır (auth-kit).
   * Yoksa eski jetondur: izinler `role`'den katalogla türetilir (geri dönüş sonra kalkar).
   */
  perms?: string[];
  /** Firmanın abonelik durumu. */
  status: SubscriptionStatus;
  plan: string;
  /** Kod "Pro mu?" diye sormaz, hak sorar. */
  limits?: Record<string, number | boolean>;
};

/** Erişim jetonu. Ürünler bunu Hesap'a sormadan doğrular. */
export type AccessClaims = {
  iss: typeof TOKEN_ISSUER;
  aud: typeof TOKEN_AUDIENCE;
  /** Person.id */
  sub: string;
  /** Session.id. Her yenilemede değişir (döndürme yeni satır açar). */
  sid: string;
  /**
   * Session.familyId: oturum ailesi. Yenilemede değişmez; çıkışta ve yeniden kullanım yakalanınca aile toptan düşer. Adım artırma
   * jetonunun bağı buna kurulur (`OperatorStepUpClaims.fid`). İsteğe bağlı: eski jetonda yoktur.
   */
  fid?: string;
  name: string;
  locale: Locale;
  /** Etkin firma. Üyeliği olmayan kişide null, ürünler reddeder. */
  org: string | null;
  orgName: string | null;
  /** Membership.id */
  mid: string | null;
  orgRole: OrgRole | null;
  /** Membership.epoch. Ürün `ep < Member.epoch` görürse 401 TOKEN_STALE döner. */
  ep: number;
  /** Yalnız kişinin rolü VE firmanın aboneliği olan ürünler. */
  prod: Partial<Record<ProductKey, ProductClaim>>;
  /**
   * Platform yöneticisi (`PLATFORM_OPERATORS` e-posta listesinde ve e-postası doğrulanmış kişi). Firmadan bağımsızdır, kişiye bağlıdır;
   * yalnız `true` iken yazılır (yoksa yönetici değil). Yapay zekâ geçidinin platform görünümü ve yönetici uçları buna bakar.
   */
  op?: true;
  iat: number;
  exp: number;
  jti: string;
};

/**
 * Adım artırma (yeniden şifre): `POST /api/account/operator/step-up` `OperatorStepUpBody` → `OperatorStepUpResponse`. Yalnız `op`
 * (yoksa `403 FORBIDDEN`); yanlış şifre `401 INVALID_CREDENTIALS` (şifre onayı kovası, dolunca `429 TOO_MANY_ATTEMPTS`).
 * Jeton tek amaçlıdır (`aud: OPERATOR_STEP_UP_AUDIENCE`), `OPERATOR_STEP_UP_TTL_SECONDS` geçerlidir, Hesap'ın aynı Ed25519 anahtarıyla
 * imzalanır (JWKS). İstemci onu geçidin değiştiren yönetici uçlarına `STEP_UP_HEADER` ile, erişim jetonuyla birlikte gönderir; geçit
 * `sub`'ın erişim jetonuyla aynı olduğunu ve jetonun aynı oturuma ait olduğunu da denetler: iki jetonda da `fid` varsa aile eşitliği
 * (oturum yenilemesi bağı koparmaz), yoksa `sid` eşitliği (eski jeton). Eksik, süresi dolmuş ya da uyuşmayan jeton `403 STEP_UP_REQUIRED`.
 * Jeton süresi içinde aynı oturumda tekrar kullanılabilir (tek amaçlı, tek kullanımlık değil).
 */
export const OPERATOR_STEP_UP_AUDIENCE = 'ai-admin';
export const OPERATOR_STEP_UP_TTL_SECONDS = 5 * 60;
export const STEP_UP_HEADER = 'x-sod-step-up';
export type OperatorStepUpBody = { password: string };
export type OperatorStepUpResponse = { token: string; expiresAt: string };
export type OperatorStepUpClaims = {
  iss: typeof TOKEN_ISSUER;
  aud: typeof OPERATOR_STEP_UP_AUDIENCE;
  /** Person.id */
  sub: string;
  /** Session.id (jetonun verildiği satır). */
  sid: string;
  /** Session.familyId (`AccessClaims.fid`). İsteğe bağlı: eski jetonda yoktur, geçit o zaman `sid`'e bakar. */
  fid?: string;
  op: true;
  iat: number;
  exp: number;
  jti: string;
};

/**
 * Adım artırma jetonu bu erişim jetonunun oturumuna mı ait: aynı kişi (`sub`) ve aynı oturum. İki jetonda da `fid` varsa aile eşitliği
 * (yenileme `sid`'i değiştirir, aileyi değiştirmez), biri yoksa `sid` eşitliği. Boş ya da metin olmayan değer hiçbir zaman eşleşmez.
 */
export function stepUpMatchesSession(
  stepUp: { sub?: unknown; sid?: unknown; fid?: unknown },
  access: { sub?: unknown; sid?: unknown; fid?: unknown },
): boolean {
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  if (!str(stepUp.sub) || stepUp.sub !== access.sub) return false;
  if (str(stepUp.fid) && str(access.fid)) return stepUp.fid === access.fid;
  return str(stepUp.sid) && stepUp.sid === access.sid;
}

/** Oturum yanıtı (mobil gövdede alır, web çerezde). */
export type TokenPair = { accessToken: string; refreshToken: string; expiresIn: number };

/** Olay jetonu ömrü. Dağıtıcı her denemede yeniden imzalar; eventId değişmez. */
export const EVENT_TOKEN_TTL_SECONDS = 5 * 60;

/**
 * Giriş, kayıt, katılım, yenileme, firma değiştirme yanıtı.
 * Web: jetonlar çerezdedir, gövdede `accessToken`/`refreshToken` yoktur. Mobil: gövdededir.
 * `refreshToken` yalnız dönen yanıtta bulunur; yoksa istemci elindekini korur.
 */
export type AuthResponse = {
  expiresIn: number;
  /** Bu yanıttan sonraki etkin firma. Mobil kuyruk firma kapsamını buradan denetler. */
  activeOrgId: string | null;
  me?: MeResponse;
  accessToken?: string;
  refreshToken?: string;
};

/** `POST /auth/join/preview` yanıtı. */
export type JoinPreview = {
  orgName: string;
  name: string | null;
  /** true ise `join/accept` içindeki `password` kişinin mevcut şifresidir. */
  personExists: boolean;
  /** `PASSWORD_RESET`: yöneticinin ürettiği şifre kodu, `password` yeni şifredir. */
  purpose: 'JOIN' | 'PASSWORD_RESET';
  /** Oturum açık ve hesapta telefon yok: kabul edilirse numara bu hesaba yazılır, `password` bu hesabın şifresidir. */
  linksCurrentAccount?: boolean;
};

/** `EMAIL_VERIFICATION_REQUIRED` açıkken kayıt ve davet kabulü: hesap açıldı, oturum e-posta doğrulanınca. HTTP 202. */
export type VerificationRequiredResponse = { verificationRequired: true };

/** `POST /auth/verify-email` yanıtı. */
export type VerifyEmailResponse = { ok: true; result: 'verified' | 'changed' | 'already' };

/** `POST /me/email/resend` yanıtı. */
export type EmailResendResponse = { ok: true; sentTo: 'pending' | 'current' | null };

export type MeResponse = {
  person: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    locale: Locale;
    emailVerified: boolean;
    /** Onay bekleyen yeni adres; eski adres onaya kadar geçerli. */
    pendingEmail?: string | null;
  };
  /**
   * Kişinin firmaları. `status` üyeliğin durumudur (askı); firmanın durumu `orgStatus`.
   * Kapalı firma (`orgStatus: 'CLOSED'`) yalnız o firmanın OWNER'ının listesinde görünür, diğer üyelerde hiç
   * yoktur. Kapalı firma `activeOrg` olamaz, firma değiştirmede `409 ORG_CLOSED`; Merkez onu "geri aç" ekranıyla gösterir.
   * `orgStatus`, `closedAt`, `purgeAfter` yalnız kapalı firmada gelir; yoksa firma açıktır (eski sunucu da göndermez).
   */
  orgs: {
    id: string;
    name: string;
    orgRole: OrgRole;
    status: 'ACTIVE' | 'SUSPENDED';
    orgStatus?: OrgStatus;
    /** Yalnız kapalı firmada: kapatıldığı an (ISO). */
    closedAt?: string;
    /** Yalnız kapalı firmada: bu andan sonra kalıcı silinir (ISO); o ana kadar sahip geri açabilir. */
    purgeAfter?: string;
    /**
     * Yalnız kapalı firmada: firmanın saat dilimi (`TIME_ZONES`). Kapalı firma etkin olamadığı için kabuğun saat dilimi başka firmanındır;
     * Merkez kapanış ve silme tarihlerini bununla yazar. Yoksa (eski sunucu) kabuğun saat dilimi.
     */
    timeZone?: string;
  }[];
  activeOrg: {
    id: string;
    name: string;
    country: string;
    currency: string;
    /** Firma saat dilimi (`TIME_ZONES`). İsteğe bağlı: Mesaj 15 L'den önceki sunucu ve kayıtlı fikstürler göndermez; yoksa `DEFAULT_ORG_TIME_ZONE`. */
    timeZone?: string;
    /** Firma dili (davet ve firma bildirimleri). Kişinin dili `person.locale`'dir. İsteğe bağlı, `timeZone` ile aynı nedenle. */
    locale?: Locale;
    /**
     * Merkez kurulumu: firma bilgileri (ad, ülke, para birimi, saat dilimi) Merkez'de onaylandı mı (`Organization.companyConfirmedAt`, ISO).
     * `null`: onay bekliyor (yeni firma). Alan yoksa eski sunucu ya da kayıtlı fikstürdür: onaylı sayılır (`isCompanyConfirmed`).
     * Onayı yalnız OWNER/ADMIN verir (`PATCH /api/account/org` gövdesinde `confirmCompany: true`). Araçlar aynı bilgiyi `org.updated`
     * olayındaki `companyConfirmed` alanından öğrenir (KARARLAR "Merkez kurulumu ve araç kurulumu").
     */
    companyConfirmedAt?: string | null;
    orgRole: OrgRole;
    membershipId: string;
  } | null;
  products: {
    key: ProductKey;
    /** Ürün bu firmada açık mı. Mesaj 11 Tur 1'den (A1) sonra: `public`, ya da `pilot` ve canlı abonelik. Öncesinde "ürün hazır". */
    available: boolean;
    /** Çalışırken geçerli durum (`PRODUCT_LAUNCH ?? kayıt`). İsteğe bağlı: eski sunucu ve kayıtlı fikstürler göndermez. */
    launch?: ProductLaunch;
    /** Firma aboneliği. Ürün hazır değilse null. */
    subscription: { status: SubscriptionStatus; plan: string } | null;
    /** Kişinin rolü, yoksa null ("Erişim yok"). Hazır rol anahtarı ya da `custom:<uuid>`. */
    role: string | null;
    /** Rolün gösterilecek adı (firmada düzenlenmiş ya da özel rolün adı, hazır rolde isteğin dilinde). Eski sunucuda yok: katalog adına düşülür. */
    roleLabel?: string;
    /** `role` hazır mı özel mi. Eski sunucuda yok. */
    roleKind?: 'builtin' | 'custom';
    permissions: string[];
  }[];
  /**
   * Kişi platform yöneticisi mi (`AccessClaims.op` ile aynı kural). Merkez "Platform" menüsünü yalnız `true` iken gösterir. İsteğe bağlı:
   * eski sunucu ve kayıtlı fikstürler göndermez; yoksa yönetici değil.
   */
  platformOperator?: boolean;
  /** Hesap durumu. `activeOrg` null ise arayüz bununla "firma oluştur" ekranını kurar. */
  account?: {
    /** `POST /orgs` kullanılabilir mi: kayıt açık ve kişinin e-postası var. */
    canCreateOrg: boolean;
    /** Firma açmak için önce e-posta eklemeli (OWNER'ın e-postası zorunlu). */
    createOrgRequiresEmail: boolean;
    /** Askıdaki üyelik sayısı (`orgs[].status`). `activeOrg` null ve bu sıfırdan büyükse kişi askıdadır, firması vardır: "firma oluştur" önerilmez. */
    suspendedOrgCount: number;
    /** Posta gönderiliyor mu. Geliştirmede `SMTP_URL` yoksa false, üretimde hep true (yoksa servis başlamaz). */
    mailEnabled: boolean;
    /** Posta gerçek adrese gidiyor mu (`SMTP_URL` var). false iken posta yalnız yerel deneme kutusuna yazılır (`POSTA.bat`); arayüz "gönderildi" demez. */
    mailDelivers?: boolean;
    /** `POST /org/leave`: etkin firma var ve kişi OWNER değil. OWNER önce devreder. */
    canLeaveActiveOrg: boolean;
    /** E-postasız kişi ayrılırken `password` gönderir. */
    leaveRequiresPassword: boolean;
    /**
     * Şifre unutulursa yol. `email`: şifremi unuttum. `org_admin`: firma yöneticisi kod üretir.
     * `none`: yol yok (e-postasız ve tek firmalı değil). Arayüz e-posta eklemeyi önerir, ayrılmadan önce uyarır.
     */
    passwordRecovery: 'email' | 'org_admin' | 'none';
    /** Firma formunda önerilen ülke. */
    defaultCountry: string;
  };
};

/**
 * Merkez kurulumunun zorunlu adımı ("Firma bilgilerini onaylayın") tamam mı. Tek tanım: Merkez Genel Bakış, Merkez firma sayfası ve
 * araçların sihirbazı bunu okur. `companyConfirmedAt` yoksa (eski sunucu, fikstür) onaylı sayılır: kimseye yeni uyarı çıkmasın.
 */
export function isCompanyConfirmed(org: { companyConfirmedAt?: string | null } | null | undefined): boolean {
  return !!org && org.companyConfirmedAt !== null;
}

/** `POST /api/account/orgs` gövdesi. Yanıt `AuthResponse`, yeni firma etkin olur. */
export type CreateOrgBody = { name: string; country?: string };

/** `POST /api/account/org/leave` gövdesi. `password` yalnız `account.leaveRequiresPassword` iken gerekir. Yanıt `AuthResponse`. */
export type LeaveOrgBody = { password?: string };

/** Firmanın durumu (`/me` `orgs[].orgStatus`). */
export type OrgStatus = 'ACTIVE' | 'CLOSED';

/** Kapalı firma mı (`orgStatus` yoksa eski sunucu: açık). */
export function isOrgClosedEntry(org: { orgStatus?: OrgStatus } | null | undefined): boolean {
  return org?.orgStatus === 'CLOSED';
}

/**
 * `POST /api/account/org/close` gövdesi: etkin firmayı kapatır, yalnız OWNER. `confirmName` firma adıyla aynı olmalı (baş/son boşluk
 * kırpılır, büyük/küçük harf ve Türkçe i/İ farkı yok: `confirmNameMatches`). Hatalar: yanlış ad `400 CONFIRM_NAME_MISMATCH`, yanlış şifre
 * `401 INVALID_CREDENTIALS` (şifre onayı kovası, dolunca `429 TOO_MANY_ATTEMPTS`), OWNER değil `403 FORBIDDEN`. Yanıt `CloseOrgResponse`.
 */
export type CloseOrgBody = { confirmName: string; password: string };

/** `POST /org/close` yanıtı: oturum yanıtı (etkin firma sahibin başka açık firmasına geçer ya da `null`) + kapanış anları (ISO). */
export type CloseOrgResponse = AuthResponse & { closedAt: string; purgeAfter: string };

/**
 * `POST /api/account/org/reopen` gövdesi: kapalı firmayı geri açar. Etkin firma gerekmez (kapalı firma etkin olamaz); yalnız o firmanın
 * OWNER'ı, saklama süresi içinde. Hatalar: yanlış şifre `401 INVALID_CREDENTIALS` (+ kova), OWNER değil ya da firma yok `404 ORG_NOT_FOUND`,
 * firma kapalı değil `409 CONFLICT`, süre dolmuş `410 ORG_PURGED`. Yanıt `AuthResponse`: geri açılan firma etkin olur.
 */
export type ReopenOrgBody = { orgId: string; password: string };

/** Onay adı firma adıyla aynı mı: baş/son boşluk kırpılır, Türkçe küçük harfe çevrilip karşılaştırılır. Sunucu ve arayüz aynı işlevi kullanır. */
export function confirmNameMatches(typed: string, orgName: string): boolean {
  const norm = (v: string) => v.normalize('NFC').trim().toLocaleLowerCase('tr');
  return norm(typed).length > 0 && norm(typed) === norm(orgName);
}

/** Kapalı firmanın saklama süresi (gün) varsayılanı. Hesap servisi `ORG_PURGE_DAYS` ile değiştirir; arayüz tarihi sunucudan (`purgeAfter`) okur. */
export const ORG_PURGE_DAYS_DEFAULT = 30;
