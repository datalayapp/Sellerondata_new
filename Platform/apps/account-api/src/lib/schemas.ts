import { z } from 'zod';
import { isLinkLikeName, NAME_MAX_LENGTH } from '@sellerondata/contracts';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './crypto.ts';
import { normalizeEmail } from './identity.ts';

/**
 * Ad e-postaya, denetim izine, Merkez ekranına girer.
 * Kontrol (başlık enjeksiyonu), biçim (bidi ve sıfır genişlik: başka ad gibi görünme) ve eşlenmemiş vekil karakter yok.
 */
export const displayName = z
  .string()
  .trim()
  .min(1)
  .max(NAME_MAX_LENGTH)
  .regex(/^[^\p{Cc}\p{Cf}\p{Cs}]+$/u)
  // Ad posta gövdesine girer: bağlantı biçimli ad oltalama aracı olur. Tam genişlik yazım (U+FF57 ile "www") ve ideografik nokta katlanarak
  // denetlenir (Y36). "firma.com" serbest kalır: gerçek firma adlarında sık; davet postasında `defangLinkText` ile etkisizleşir.
  .refine((v) => !isLinkLikeName(v), { message: 'name_no_links' });

/** Doğrulamadan önce normalleştirir: `ALİ@x.com` reddedilmez, `ali@x.com` olur. */
export const emailField = z.preprocess((v) => (typeof v === 'string' ? normalizeEmail(v) : v), z.email().max(254));

/** Tek başına veya sonuna rakam ve noktalama eklenince tahmin edilebilen kelimeler. Türkçe harfler sadeleştirilmiş yazılır. */
const COMMON_WORDS = new Set([
  'password', 'passw0rd', 'parola', 'sifre', 'sifrem', 'gizli', 'admin', 'administrator', 'welcome', 'hosgeldin', 'letmein', 'iloveyou', 'seviyorum',
  'galatasaray', 'gs', 'fenerbahce', 'fb', 'besiktas', 'bjk', 'trabzonspor', 'ts', 'turkiye', 'turkey', 'istanbul', 'ankara', 'izmir', 'sellerondata', 'deciship',
]);
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1q2w3e4r5t6y7u8i9o0p', '1qaz2wsx3edc4rfv5tgb', 'qazwsxedcrfv'];
const TURKISH_FOLD: Record<string, string> = { ç: 'c', ğ: 'g', ı: 'i', i̇: 'i', ö: 'o', ş: 's', ü: 'u' };

function isSequential(text: string): boolean {
  if (text.length < 3) return false;
  const codes = [...text].map((c) => c.charCodeAt(0));
  const step = codes[1] - codes[0];
  return Math.abs(step) === 1 && codes.every((c, i) => i === 0 || c - codes[i - 1] === step);
}

function isPeriodic(text: string): boolean {
  for (let n = 1; n <= text.length / 2; n++) {
    const unit = text.slice(0, n);
    if ([...text].every((c, i) => c === unit[i % n])) return true;
  }
  return false;
}

/** Kapsamlı değil, bilinçli: sözlük saldırısının ilk denediği örüntüler. Eşleşen şifre reddedilir. */
export function isWeakPassword(password: string): boolean {
  const lower = password.toLocaleLowerCase('tr').replace(/[çğıöşü]|i̇/g, (c) => TURKISH_FOLD[c] ?? c);
  if (new Set(lower).size < 4) return true;
  if (/^\d+$/.test(lower) && lower.length <= 14) return true;
  if (isPeriodic(lower)) return true;
  // Sondaki noktalama ve rakam atılır: `Password123!`, `Fenerbahce1907`, `asdfghjkl;`.
  const trimmed = lower.replace(/[^a-z0-9]+$/, '');
  const base = trimmed.replace(/\d+$/, '');
  const digits = trimmed.slice(base.length);
  if (COMMON_WORDS.has(base)) return true;
  if (base.length >= 4 && KEYBOARD_ROWS.some((row) => row.includes(base))) return true;
  if (KEYBOARD_ROWS.some((row) => row.startsWith(trimmed) && trimmed.length >= 6)) return true;
  if (isSequential(base) && (digits === '' || isSequential(digits))) return true;
  return false;
}

export const newPassword = z
  .string()
  .min(PASSWORD_MIN_LENGTH)
  .max(PASSWORD_MAX_LENGTH)
  .refine((p) => !isWeakPassword(p), { message: 'weak_password' });
export const existingPassword = z.string().min(1).max(PASSWORD_MAX_LENGTH);
export const clientKind = z.enum(['web', 'mobile']).default('web');
export const countryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/);
