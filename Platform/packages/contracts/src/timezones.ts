/**
 * Firma saat dilimi (Mesaj 15 §4.1). `Organization.timeZone` bu listeden biridir; Hesap > Şirket'te seçilir.
 * Günlük sayılar, son günler, hatırlatma saati ve dışa aktarmalar buna göre hesaplanır; faturanın hesap dayanağına girmez.
 */
export const TIME_ZONES = [
  'Europe/Istanbul',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Amsterdam',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Athens',
  'Europe/Bucharest',
  'Asia/Dubai',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Asia/Tokyo',
  'UTC',
] as const;
export type OrgTimeZone = (typeof TIME_ZONES)[number];

/** Şema varsayılanı (`@default("Europe/Istanbul")`) ve tanınmayan ülke. */
export const DEFAULT_ORG_TIME_ZONE: OrgTimeZone = 'Europe/Istanbul';

export function isOrgTimeZone(value: unknown): value is OrgTimeZone {
  return typeof value === 'string' && (TIME_ZONES as readonly string[]).includes(value);
}

/** Firma açılışında ülkeden gelen saat dilimi: TR, GB, DE, FR, NL, US; diğerleri `Europe/Istanbul`. */
export function defaultTimeZone(country: string): OrgTimeZone {
  switch (country.toUpperCase()) {
    case 'GB':
      return 'Europe/London';
    case 'DE':
      return 'Europe/Berlin';
    case 'FR':
      return 'Europe/Paris';
    case 'NL':
      return 'Europe/Amsterdam';
    case 'US':
      return 'America/New_York';
    default:
      return DEFAULT_ORG_TIME_ZONE;
  }
}
