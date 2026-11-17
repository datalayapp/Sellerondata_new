import { isIPv6 } from 'node:net';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

/** E.164'e çevirir, varsayılan ülke TR. Geçersizse null. */
export function normalizePhone(input: string, defaultCountry: 'TR' = 'TR'): string | null {
  const parsed = parsePhoneNumberFromString(input.trim(), defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}

/** E.164 numaranın ülkesi. Bilinmiyorsa null. */
export function countryOfPhone(phone: string | null): string | null {
  return phone ? (parsePhoneNumberFromString(phone)?.country ?? null) : null;
}

/** Türkçe klavyede büyük `İ` JS'te birleşik karakterli `i̇` olur: ayrı kimlik gibi görünür. */
export function normalizeEmail(input: string): string {
  return input.trim().normalize('NFC').replace(/İ/g, 'I').toLowerCase().replace(/i\u0307/g, 'i');
}

/** Hız sınırı anahtarı. IPv6'da kişi bütün bir /64'e sahiptir: adres değiştirerek sınır atlatılmasın. */
export function ipBucket(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!isIPv6(ip)) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('%')[0].split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export type LoginIdentifier = { kind: 'email'; email: string } | { kind: 'phone'; phone: string } | { kind: 'invalid' };

/** `@` varsa e-posta, yoksa telefon. Geçersiz kimlik de aynı yanıtı almalı: çağıran `invalid`i bilinmeyen kişi gibi işler. */
export function parseIdentifier(input: string): LoginIdentifier {
  if (input.includes('@')) return { kind: 'email', email: normalizeEmail(input) };
  const phone = normalizePhone(input);
  return phone ? { kind: 'phone', phone } : { kind: 'invalid' };
}
