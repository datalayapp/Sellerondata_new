export type ErrorContext = 'login' | 'joinCode' | 'joinAccept' | 'org';

/** Telefon ve e-posta ayrımı sunucuda. Burada yalnız eski kullanıcı adı alışkanlığı yakalanır. */
export function looksLikeIdentifier(input: string): boolean {
  const v = input.trim();
  if (v.includes('@')) return v.length >= 3;
  return v.replace(/\D/g, '').length >= 7;
}

export function looksLikePhone(input: string): boolean {
  const v = input.trim();
  return !v.includes('@') && v.replace(/\D/g, '').length >= 7;
}

/** Sunucu I/L/O karışıklığını düzeltir; burada yalnız uzunluk denetlenir. */
export const JOIN_CODE_LENGTH = 8;
export function joinCodeComplete(input: string): boolean {
  return input.replace(/[\s-]/g, '').length === JOIN_CODE_LENGTH;
}

/**
 * Türkçe klavye: küçük i "İ"ye, büyük I "ı"ya dönüşür. Sunucu yalnız ASCII I/O/L düzeltmesi yapar.
 * Kodda I, 1 demektir; "İ" ve "ı" de aynı harf sayılır, yoksa geçerli kod reddedilir.
 */
export function normalizeJoinCodeInput(input: string): string {
  return input.trim().replace(/[İıi]/g, 'I'); // i18n-ok: harf düzeltme regex'i
}

/** E-postada Türkçe harf olmaz: klavyenin ürettiği "İ"/"ı" ASCII'ye döner. Telefona dokunmaz. */
export function normalizeIdentifierInput(input: string): string {
  const v = input.trim();
  return v.includes('@') ? v.replace(/[İı]/g, 'i') : v; // i18n-ok: harf düzeltme regex'i
}

/** Hesap servisindeki `PASSWORD_MIN_LENGTH`. Kısa şifre sunucuya gitmeden söylenir. */
export const PASSWORD_MIN_LENGTH = 10;

function validationKey(details: unknown): string {
  const first = Array.isArray(details) ? (details[0] as { path?: unknown; code?: unknown } | undefined) : undefined;
  if (first?.code === 'invalid_phone' || first?.path === 'phone') return 'auth:errors.INVALID_PHONE';
  if (first?.code === 'weak_password' || first?.path === 'password') return 'auth:errors.WEAK_PASSWORD';
  if (first?.code === 'name_required' || first?.path === 'name') return 'auth:errors.NAME_REQUIRED';
  return 'auth:errors.VALIDATION';
}

/**
 * Hata kodu → `auth.json` anahtarı. `null`: bilinmeyen kod, istemci sunucunun yerelleşmiş `message` alanını gösterir
 * (`contracts/errors.ts` sözleşmesi).
 */
export function authErrorKey(e: { status: number; code: string; details?: unknown }, context: ErrorContext): string | null {
  switch (e.code) {
    case 'NETWORK':
    case 'TIMEOUT':
    case 'TOO_MANY_ATTEMPTS':
    case 'INVITE_INVALID':
    case 'ALREADY_MEMBER':
    case 'EMAIL_NOT_VERIFIED':
    case 'AUTH_UNAVAILABLE':
    case 'DB_UNAVAILABLE':
      return `auth:errors.${e.code}`;
    case 'INVALID_CREDENTIALS':
      return context === 'joinAccept' ? 'auth:errors.WRONG_CURRENT_PASSWORD' : 'auth:errors.INVALID_CREDENTIALS';
    case 'NOT_FOUND':
      return context === 'org' ? 'auth:errors.ORG_NOT_FOUND' : null;
    case 'VALIDATION':
      return validationKey(e.details);
    default:
      return e.status >= 500 ? 'auth:errors.SERVER' : null;
  }
}
