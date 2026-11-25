// İtiraz penceresinin saf yardımcıları: e-posta bağlantısı, uzunluk sınırı, dil değişiminde onay, hatırlanan adres anahtarı.

/** Kodlanmış `mailto` adresinin bu uzunluğu aşması durumunda bazı e-posta uygulamaları bağlantıyı kesiyor ya da hiç açmıyor. */
export const MAILTO_MAX = 1800;

export function mailtoHref(email: string, subject: string, body: string): string {
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** Kodlanmış adres 1.800 karakteri aşarsa metin e-posta bağlantısı için uzun sayılır. */
export function isTooLong(href: string): boolean {
  return href.length > MAILTO_MAX;
}

/** Tam metinle bağlantı uzunsa gövde kısa girişe düşer; `long` pencerede uyarıyı ve "Kopyala"yı öne çıkarır. */
export function mailPlan(email: string, subject: string, body: string, shortBody: string): { href: string; long: boolean } {
  const full = mailtoHref(email, subject, body);
  if (!isTooLong(full)) return { href: full, long: false };
  return { href: mailtoHref(email, subject, shortBody), long: true };
}

/** Konu ya da metin sunucudan yüklenenden farklıysa dil değişimi düzenlemeyi silecektir. */
export function needsLangConfirm(
  loaded: { subject: string; body: string } | undefined,
  current: { subject: string; body: string },
): boolean {
  if (!loaded) return false;
  return loaded.subject !== current.subject || loaded.body !== current.body;
}

export function disputeEmailKey(companyId: string, carrierId: string): string {
  return `deciship.disputeEmail.${companyId}.${carrierId}`;
}

/**
 * KALANLAR 1.12: itiraz imzasına gönderenin e-postası ve telefonu. DeciShip kişinin iletişim bilgisini bilmez; pencere Merkez
 * hesabındakini (`person.email`, `person.phone`) metin ve ZIP isteğine başlıkla ekler (adreste değil: istek günlüğüne girmez).
 * Boş alan gönderilmez; e-posta yalnız doğrulanmışsa (`emailVerified`; bağımsız inceleme: doğrulanmamış adres kargoya
 * yazılmaz). Sunucu biçimi bozuk değeri yazmaz (`services/evidence.ts` `signatureContact`).
 */
export function signatureHeaders(
  person: { email?: string | null; emailVerified?: boolean; phone?: string | null } | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  const email = person?.emailVerified === true ? person.email?.trim() : undefined;
  const phone = person?.phone?.trim();
  if (email) out["X-Signature-Email"] = encodeURIComponent(email);
  if (phone) out["X-Signature-Phone"] = encodeURIComponent(phone);
  return out;
}
