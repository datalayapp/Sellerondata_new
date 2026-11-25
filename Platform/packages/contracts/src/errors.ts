import type { Locale, LocalizedText } from './catalog.ts';
import { baseLocale, DEFAULT_LOCALE } from './locale.ts';

/**
 * Tüm servislerde hata gövdesi. `message`, Accept-Language'a göre yerelleşir; istemci mantığı yalnız `code`'a bakar.
 * `NO_PRODUCT_ACCESS` `details.refreshable: true` taşır: rol az önce verilmiş olabilir, istemci bir kez sessizce yeniler ve yeniden dener.
 * Yine aynı hatayı alırsa kullanıcıya gösterir, bir daha yenilemez.
 */
export type ApiErrorBody = { error: { code: string; message: string; details?: unknown } };

/** Platform genelinde sabit kodlar. */
export const ERROR_CODES = [
  'UNAUTHORIZED',
  'TOKEN_EXPIRED',
  'TOKEN_STALE',
  'FORBIDDEN',
  'CSRF_FAILED',
  'ORG_REQUIRED',
  'NO_PRODUCT_ACCESS',
  'READ_ONLY',
  'INVALID_CREDENTIALS',
  'TOO_MANY_ATTEMPTS',
  'REGISTRATION_CLOSED',
  'EMAIL_TAKEN',
  'PHONE_TAKEN',
  'ALREADY_MEMBER',
  'INVITE_INVALID',
  'LAST_OWNER',
  'CANNOT_MANAGE_SELF',
  'CANNOT_MANAGE_OWNER',
  'RESET_CODE_NOT_ALLOWED',
  'PAYMENT_NOT_AVAILABLE',
  'NOT_FOUND',
  'VALIDATION',
] as const;
export type PlatformErrorCode = (typeof ERROR_CODES)[number];

/**
 * Hesap ve auth-kit'in ek kodları. `ERROR_CODES` kırılmasın diye ayrı liste; `ApiErrorCode` ikisini birleştirir.
 * İstemci bilmediği kodda `message` alanını gösterir.
 */
export const EXTRA_ERROR_CODES = [
  'AI_KEY_REJECTED',
  'AI_PROVIDER_UNREACHABLE',
  'AUTH_UNAVAILABLE',
  'BAD_REQUEST',
  'CONFIRM_NAME_MISMATCH',
  'CONFLICT',
  'DB_UNAVAILABLE',
  'EMAIL_NOT_VERIFIED',
  'INTERNAL',
  'INVALID_EVENT',
  'INVALID_PRODUCT_ROLE',
  'INVALID_ROLE_PERMISSIONS',
  'INVITE_ATTEMPTS_EXHAUSTED',
  'INVITE_WRONG_ACCOUNT',
  'LOGIN_REQUIRED',
  'ORG_CLOSED',
  'ORG_MISMATCH',
  'ORG_NOT_FOUND',
  'ORG_PURGED',
  'OWNER_REQUIRES_EMAIL',
  'PASSWORD_CONFIRM_REQUIRED',
  'PASSWORD_REQUIRED',
  'PERSON_SUSPENDED',
  'PHONE_CHANGE_NOT_ALLOWED',
  'PRODUCT_NOT_AVAILABLE',
  'ROLE_FORBIDDEN',
  'ROLE_IN_USE',
  'ROLE_LIMIT',
  'ROLE_LOCKED',
  'ROLE_NAME_TAKEN',
  'ROLE_VERSION',
  'SIGNUP_INVITE_INVALID',
  'SIGNUP_INVITE_REQUIRED',
  'STEP_UP_REQUIRED',
  'TOKEN_INVALID',
  'UNKNOWN_EVENT_TYPE',
  'UPGRADE_REQUIRED',
  'USE_OWNERSHIP_TRANSFER',
] as const;
export type ExtraErrorCode = (typeof EXTRA_ERROR_CODES)[number];
export type ApiErrorCode = PlatformErrorCode | ExtraErrorCode;

/** Tüm servislerin ortak hata metinleri. Servis kendi ayrıntı metinlerini ayrıca tutabilir. */
export const ERROR_MESSAGES: Record<ApiErrorCode, LocalizedText> = {
  UNAUTHORIZED: { tr: 'Oturum geçersiz, lütfen tekrar giriş yapın.', en: 'Your session is not valid. Please sign in again.' },
  TOKEN_EXPIRED: { tr: 'Oturumunuzun süresi doldu.', en: 'Your session has expired.' },
  TOKEN_STALE: { tr: 'Yetkileriniz değişti, oturum yenileniyor.', en: 'Your permissions have changed. Refreshing your session.' },
  FORBIDDEN: { tr: 'Bu işlem için yetkiniz yok.', en: 'You do not have permission to do this.' },
  CSRF_FAILED: { tr: 'İstek doğrulanamadı. Sayfayı yenileyip yeniden deneyin.', en: 'The request could not be verified. Reload the page and try again.' },
  ORG_REQUIRED: { tr: 'Devam etmek için bir firma seçin.', en: 'Select a company to continue.' },
  NO_PRODUCT_ACCESS: { tr: 'Bu araca erişiminiz yok. Firma yöneticinize başvurun.', en: 'You do not have access to this tool. Contact your company admin.' },
  READ_ONLY: { tr: 'Abonelik salt okunur durumda. Değişiklik yapılamaz.', en: 'The subscription is read only. Changes are not allowed.' },
  INVALID_CREDENTIALS: { tr: 'Giriş bilgileri hatalı.', en: 'The sign-in details are incorrect.' },
  TOO_MANY_ATTEMPTS: { tr: 'Çok fazla istek yapıldı. Biraz sonra yeniden deneyin.', en: 'Too many requests. Try again later.' },
  REGISTRATION_CLOSED: { tr: 'Yeni kayıtlar şu anda kapalı.', en: 'New registrations are closed at the moment.' },
  EMAIL_TAKEN: { tr: 'Bu e-posta adresi kullanılıyor.', en: 'This email address is already in use.' },
  PHONE_TAKEN: { tr: 'Bu telefon numarası kullanılıyor.', en: 'This phone number is already in use.' },
  ALREADY_MEMBER: { tr: 'Bu kişi zaten firmanın üyesi.', en: 'This person is already a member of the company.' },
  INVITE_INVALID: { tr: 'Davet veya kod geçersiz ya da süresi dolmuş. Yöneticinizden yeni bir davet isteyin.', en: 'The invitation or code is not valid or has expired. Ask your admin for a new one.' },
  LAST_OWNER: { tr: 'Firmanın tek sahibi çıkarılamaz, askıya alınamaz, rolü düşürülemez. Önce sahipliği devredin.', en: 'The only owner of a company cannot be removed, suspended or demoted. Transfer ownership first.' },
  CANNOT_MANAGE_SELF: { tr: 'Kendi üyeliğinizi bu yolla değiştiremezsiniz.', en: 'You cannot change your own membership this way.' },
  CANNOT_MANAGE_OWNER: { tr: 'Firma sahibinin üyeliğini değiştiremezsiniz.', en: "You cannot change the company owner's membership." },
  RESET_CODE_NOT_ALLOWED: { tr: 'Bu kişi için şifre kodu üretilemez.', en: 'A password code cannot be created for this person.' },
  PAYMENT_NOT_AVAILABLE: { tr: 'Ödeme henüz açık değil.', en: 'Payments are not available yet.' },
  NOT_FOUND: { tr: 'Kayıt bulunamadı.', en: 'Record not found.' },
  VALIDATION: { tr: 'Girilen bilgiler geçersiz. Alanları kontrol edin.', en: 'The details you entered are not valid. Check the fields.' },
  AUTH_UNAVAILABLE: { tr: 'Oturum şu anda doğrulanamıyor. Birkaç saniye sonra yeniden deneyin.', en: 'Your session cannot be verified right now. Try again in a few seconds.' },
  BAD_REQUEST: { tr: 'İstek işlenemedi.', en: 'The request could not be processed.' },
  CONFLICT: { tr: 'Aynı anda başka bir değişiklik yapıldı. Yeniden deneyin.', en: 'Another change happened at the same time. Try again.' },
  DB_UNAVAILABLE: { tr: 'Sunucu meşgul. Birkaç saniye sonra yeniden deneyin.', en: 'The server is busy. Try again in a few seconds.' },
  EMAIL_NOT_VERIFIED: { tr: 'E-posta adresiniz doğrulanmamış. Size yeni bir doğrulama bağlantısı gönderdik.', en: 'Your email address is not verified. We have sent you a new verification link.' },
  INTERNAL: { tr: 'Beklenmeyen bir hata oluştu. Biraz sonra yeniden deneyin.', en: 'Something went wrong. Try again later.' },
  UNKNOWN_EVENT_TYPE: { tr: 'Olay türü bu sürümde tanınmıyor. Ürün güncellenince yeniden gönderilir.', en: 'This event type is not recognised by this version. It will be resent after the product is updated.' },
  INVALID_EVENT: { tr: 'Olay doğrulanamadı.', en: 'The event could not be verified.' },
  INVALID_PRODUCT_ROLE: { tr: 'Bu rol bu araç için geçerli değil.', en: 'This role is not valid for this tool.' },
  INVITE_ATTEMPTS_EXHAUSTED: { tr: 'Bu kodun hatalı giriş hakkı bitti. Daveti iptal edip yeniden davet edin.', en: 'This code has no attempts left. Revoke the invitation and invite again.' },
  ORG_MISMATCH: { tr: 'Bu sekme başka bir firmayı gösteriyor. Değişiklik yapılmadı, sayfayı yenileyin.', en: 'This tab shows a different company. Nothing was changed. Reload the page.' },
  ORG_NOT_FOUND: { tr: 'Firma bulunamadı.', en: 'Company not found.' },
  OWNER_REQUIRES_EMAIL: { tr: 'Firma sahibinin e-posta adresi olmalı: şifresini kurtarabilecek başka kimse yok.', en: 'A company owner must have an email address: nobody else can recover their password.' },
  PHONE_CHANGE_NOT_ALLOWED: { tr: 'Telefon numarası yalnız firma davetiyle hesaba bağlanır.', en: 'A phone number can only be linked to your account through a company invitation.' },
  INVITE_WRONG_ACCOUNT: { tr: 'Bu davet başka bir hesap için. Doğru hesapla giriş yapın.', en: 'This invitation is for another account. Sign in with the correct account.' },
  LOGIN_REQUIRED: { tr: 'Bu daveti kabul etmek için önce giriş yapın.', en: 'Sign in first to accept this invitation.' },
  ORG_CLOSED: { tr: 'Bu firma kapatıldı. Firmada işlem yapılamaz.', en: 'This company has been closed. No changes can be made in it.' },
  // Firmayı kapatma: yanlış onay adı ve saklama süresi dolmuş (kalıcı silinmiş) firma.
  CONFIRM_NAME_MISMATCH: { tr: 'Yazdığınız ad firma adıyla aynı değil.', en: 'The name you typed does not match the company name.' },
  ORG_PURGED: { tr: 'Bu firmanın saklama süresi doldu, veriler kalıcı olarak silindi. Firma geri açılamaz.', en: 'The retention period for this company has ended and its data was permanently deleted. It cannot be reopened.' },
  PERSON_SUSPENDED: { tr: 'Bu kişinin hesabı destek tarafından askıya alındı. Üyelik burada etkinleştirilemez, destek ekibine başvurun.', en: 'This person\'s account was suspended by support. The membership cannot be reactivated here. Contact support.' },
  PASSWORD_CONFIRM_REQUIRED: { tr: 'Bu işlem için şifrenizi girin.', en: 'Enter your password to do this.' },
  PASSWORD_REQUIRED: { tr: 'Hesabınızı doğrulamak için şifrenizi girin.', en: 'Enter your password to verify your account.' },
  PRODUCT_NOT_AVAILABLE: { tr: 'Bu araç henüz kullanıma açık değil.', en: 'This tool is not available yet.' },
  SIGNUP_INVITE_REQUIRED: { tr: 'Şu an yalnız davetle hesap açılıyor. Davet için destek ekibine yazın.', en: 'Accounts are invitation-only right now. Write to support to ask for an invitation.' },
  SIGNUP_INVITE_INVALID: { tr: 'Davet bağlantısı geçersiz, kullanılmış ya da süresi dolmuş; ya da başka bir e-posta adresi için. Davetteki adresi yazın ya da yeni davet isteyin.', en: 'The invitation link is not valid, already used or expired, or it is for another email address. Use the address the invitation was sent to, or ask for a new one.' },
  TOKEN_INVALID: { tr: 'Bağlantı geçersiz veya süresi dolmuş. Yeni bir bağlantı isteyin.', en: 'The link is not valid or has expired. Request a new one.' },
  USE_OWNERSHIP_TRANSFER: { tr: 'Sahiplik yalnız devir işlemiyle değişir.', en: 'Ownership can only change through a transfer.' },
  UPGRADE_REQUIRED: { tr: 'Uygulamanın bu sürümü artık desteklenmiyor. Lütfen güncelleyin.', en: 'This version of the app is no longer supported. Please update.' },
  // Özel roller. Ayrıntı biçimleri `roles.ts`: INVALID_ROLE_PERMISSIONS `{ missing, unknown }`, ROLE_IN_USE `{ members, invites }`,
  // ROLE_FORBIDDEN `{ reason, permissions? }` (nedene göre metin `ROLE_FORBIDDEN_REASONS`).
  INVALID_ROLE_PERMISSIONS: { tr: 'Seçilen izinlerden bazıları başka izinleri de gerektiriyor. İşaretli izinleri ekleyin.', en: 'Some of the selected permissions need other permissions too. Add the marked permissions.' },
  ROLE_FORBIDDEN: { tr: 'Bu rolü bu şekilde değiştirme yetkiniz yok.', en: 'You do not have permission to change this role this way.' },
  ROLE_IN_USE: { tr: 'Bu rol kullanılıyor. Silmeden önce kişilere başka bir rol seçin.', en: 'This role is in use. Choose another role for these people before deleting it.' },
  ROLE_LIMIT: { tr: 'Bu araç için en fazla sayıda rol oluşturuldu. Kullanılmayan bir rolü silin.', en: 'This tool already has the maximum number of roles. Delete a role you do not use.' },
  ROLE_LOCKED: { tr: 'Bu rol silinemez ve izinleri değiştirilemez; yalnız adı değişebilir.', en: 'This role cannot be deleted and its permissions cannot be changed. Only its name can.' },
  ROLE_NAME_TAKEN: { tr: 'Bu adda bir rol zaten var. Başka bir ad seçin.', en: 'A role with this name already exists. Choose another name.' },
  ROLE_VERSION: { tr: 'Bu rol siz düzenlerken başka biri tarafından değiştirildi. Sayfayı yenileyip yeniden deneyin.', en: 'Someone else changed this role while you were editing it. Reload the page and try again.' },
  // Yapay zekâ geçidi, platform yöneticisi uçları (`aiSpend.ts`). Adım artırma: `POST /api/account/operator/step-up` (`tokens.ts`).
  STEP_UP_REQUIRED: { tr: 'Bu işlem için şifrenizi yeniden girin.', en: 'Enter your password again to do this.' },
  AI_KEY_REJECTED: { tr: 'Sağlayıcı bu anahtarı kabul etmedi. Anahtarı kontrol edip yeniden girin.', en: 'The provider did not accept this key. Check the key and enter it again.' },
  AI_PROVIDER_UNREACHABLE: { tr: 'Yapay zekâ sağlayıcısına şu anda ulaşılamıyor. Biraz sonra yeniden deneyin.', en: 'The AI provider cannot be reached right now. Try again later.' },
};

/** `Accept-Language` başlığından desteklenen dili seçer. Desteklenen dil yoksa `DEFAULT_LOCALE` (İngilizce, karar 2026-11-12). */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale {
  return acceptLanguageLocale(header) ?? DEFAULT_LOCALE;
}

/**
 * Sunucuda isteğin dili, tek kural (karar 2026-11-12): `Accept-Language`'taki desteklenen dil, yoksa oturumun (jetonun) dili,
 * o da yoksa `DEFAULT_LOCALE` (İngilizce).
 */
export function requestLocaleOf(header: string | null | undefined, sessionLocale?: string | null): Locale {
  return acceptLanguageLocale(header) ?? baseLocale(sessionLocale) ?? DEFAULT_LOCALE;
}

/** `Accept-Language` başlığındaki ilk desteklenen dil (ağırlık sırasıyla); yoksa null. Çağıran kendi sonraki kaynağına düşer. */
export function acceptLanguageLocale(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const q = qParam ? Number(qParam.slice(2)) : 1;
      return { lang: tag.trim().toLowerCase().split('-')[0] ?? '', q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((x) => x.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { lang } of ranked) {
    if (lang === 'tr' || lang === 'en') return lang;
  }
  return null;
}

export function errorMessage(code: ApiErrorCode, locale: Locale): string {
  return ERROR_MESSAGES[code][locale];
}

/** Geliştirme parolası (`*_dev`) üretimde kabul edilmez. Servisler açılışta `DATABASE_URL` için çağırır. */
export function hasDevPassword(databaseUrl: string): boolean {
  try {
    return /_dev$/.test(decodeURIComponent(new URL(databaseUrl).password));
  } catch {
    return false;
  }
}
