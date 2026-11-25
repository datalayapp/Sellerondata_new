import { localeFromAcceptLanguage, type Locale, type LocalizedText } from '@sellerondata/contracts';
import type { FastifyRequest } from 'fastify';

/** Servise özel metinler. Ortak hata metinleri `contracts/errors.ts` içindedir. */

export const VALIDATION_MESSAGES: Record<string, LocalizedText> = {
  required: { tr: 'Bu alan zorunlu.', en: 'This field is required.' },
  too_small: { tr: 'Değer çok kısa.', en: 'The value is too short.' },
  too_big: { tr: 'Değer çok uzun.', en: 'The value is too long.' },
  invalid_format: { tr: 'Biçim geçersiz.', en: 'The format is not valid.' },
  invalid_value: { tr: 'Değer geçersiz.', en: 'The value is not valid.' },
  invalid_phone: { tr: 'Telefon numarası geçersiz.', en: 'The phone number is not valid.' },
  invalid_email: { tr: 'E-posta adresi geçersiz.', en: 'The email address is not valid.' },
  weak_password: { tr: 'Şifre en az 10 karakter olmalı ve yaygın kullanılan bir şifre olmamalı.', en: 'The password must be at least 10 characters and must not be a commonly used one.' },
  name_no_links: { tr: 'Ad bağlantı içeremez (http, www, ://).', en: 'The name cannot contain a link (http, www, ://).' },
  name_required: { tr: 'Ad zorunlu.', en: 'Name is required.' },
  contact_required: {
    tr: 'Giriş için telefon ya da doğrulanmış e-posta gerekli. Telefonu kaldırmadan önce e-postanızı doğrulayın.',
    en: 'You need a phone number or a verified email address to sign in. Verify your email before removing your phone.',
  },
  current_password_required: {
    tr: 'E-posta veya telefon değişikliği için mevcut şifrenizi girin.',
    en: 'Enter your current password to change your email address or phone number.',
  },
};

const FIELD_LABELS: Record<string, LocalizedText> = {
  orgName: { tr: 'Firma adı', en: 'Company name' },
  name: { tr: 'Ad', en: 'Name' },
  email: { tr: 'E-posta', en: 'Email' },
  phone: { tr: 'Telefon', en: 'Phone' },
  password: { tr: 'Şifre', en: 'Password' },
  newPassword: { tr: 'Yeni şifre', en: 'New password' },
  currentPassword: { tr: 'Mevcut şifre', en: 'Current password' },
  identifier: { tr: 'E-posta veya telefon', en: 'Email or phone' },
  code: { tr: 'Kod', en: 'Code' },
  country: { tr: 'Ülke', en: 'Country' },
  description: { tr: 'Açıklama', en: 'Description' },
};

/** Uzunluk hatası alanı ve sınırı söyler. Bilinmeyen alanda genel metin. */
export function lengthMessage(field: string, bound: 'min' | 'max', limit: number, locale: Locale): string | null {
  const label = FIELD_LABELS[field]?.[locale];
  if (!label) return null;
  if (bound === 'min' && limit <= 1) return locale === 'tr' ? `${label} boş olamaz.` : `${label} cannot be empty.`;
  if (bound === 'max') return locale === 'tr' ? `${label} en fazla ${limit} karakter olabilir.` : `${label} can be at most ${limit} characters.`;
  return locale === 'tr' ? `${label} en az ${limit} karakter olmalı.` : `${label} must be at least ${limit} characters.`;
}

/**
 * Şifre kodu reddinin nedeni. `SELF_RESET` iki durumu birden kapsar (e-postası var ya da başka firmada da üye, 04-B10): yönetici,
 * çalışanın başka firmada çalıştığını bu metinden öğrenmesin. Kişinin kendi ekranı nedenini söyler (`passwordRecovery`).
 */
export const RESET_CODE_REASONS: Record<'SELF_RESET' | 'NOT_ACTIVE', LocalizedText> = {
  SELF_RESET: {
    tr: 'Bu kişi için buradan kod üretilemiyor; şifresini kendisi yenilemeli.',
    en: "A code can't be created for this person here; they need to reset their password themselves.",
  },
  NOT_ACTIVE: {
    tr: 'Bu kişinin üyeliği askıda. Önce askıyı kaldırın.',
    en: "This person's membership is suspended. Resume it first.",
  },
};

/** Sahiplik devri reddinin ayrıntılı metni (`OWNER_REQUIRES_EMAIL` + `details.reason`). */
export const OWNER_EMAIL_REASONS: Record<'EMAIL_NOT_VERIFIED', LocalizedText> = {
  EMAIL_NOT_VERIFIED: {
    tr: 'Bu kişi e-posta adresini henüz doğrulamadı. Sahiplik yalnız doğrulanmış adrese devredilir.',
    en: 'This person has not verified their email address yet. Ownership can only go to a verified address.',
  },
};

/** Yetki reddinin ayrıntılı metni (`FORBIDDEN` + `details.reason`). Firma yönetimi yazması mobil ya da Bearer oturumla gelirse. */
export const FORBIDDEN_REASONS: Record<'WEB_SESSION_REQUIRED', LocalizedText> = {
  WEB_SESSION_REQUIRED: {
    tr: "Bu işlem yalnız web'de, Merkez'den yapılabilir.",
    en: 'This can only be done on the web, in the Hub.',
  },
};

export function localeOf(req: FastifyRequest): Locale {
  return localeFromAcceptLanguage(req.headers['accept-language']);
}

export function validationMessage(key: string, locale: Locale): string {
  return (VALIDATION_MESSAGES[key] ?? VALIDATION_MESSAGES.invalid_value)[locale];
}
