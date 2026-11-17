import crypto from 'node:crypto';
import argon2 from 'argon2';
import { env } from '../env.ts';

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// ---------- Crockford base32 kod ----------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const JOIN_CODE_LENGTH = 8;

/** 8 karakter = 40 bit. Eşit dağılım için `randomInt`. */
export function generateJoinCode(): string {
  let out = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) out += CROCKFORD[crypto.randomInt(32)];
  return out;
}

/** Kullanıcı girişini kanonik biçime çevirir: boşluk ve tire atılır, O→0, I/L→1, büyük harf. Geçersizse null. */
export function normalizeJoinCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[ILİ]/g, '1');
  if (cleaned.length !== JOIN_CODE_LENGTH) return null;
  for (const ch of cleaned) if (!CROCKFORD.includes(ch)) return null;
  return cleaned;
}

/**
 * Yalnız özet saklanır. Kod 40 bit olduğundan düz özet, sızan tablodan kırılabilirdi: biber veritabanında durmaz.
 * Telefon karıştırılır: aynı kod farklı numarada farklı özet verir. Biber değişirse bekleyen kodlar düşer.
 */
export function hashJoinCode(phone: string, code: string): string {
  return hmacWith(env.codePepper, phone, code);
}

/** Biber dönüşü: yeni biber yazar, önceki biber de doğrular. Özet önekteki kimlikle hangi biberin olduğu bilinir. */
function pepperId(pepper: string): string {
  return sha256(pepper).slice(0, 8);
}

function hmacWith(pepper: string, phone: string, code: string): string {
  return `${pepperId(pepper)}:${crypto.createHmac('sha256', pepper).update(`${phone}:${code}`).digest('hex')}`;
}

export function joinCodeCandidates(phone: string, code: string): string[] {
  const previous = env.codePepperPrevious;
  return [hmacWith(env.codePepper, phone, code), ...(previous ? [hmacWith(previous, phone, code)] : [])];
}

/** Özet şu an bilinen bir biberle mi yazıldı? Bilinmiyorsa kod doğrulanamaz, yanlış sayılmaz. */
export function isKnownPepper(tokenHash: string): boolean {
  const id = tokenHash.split(':', 1)[0];
  const previous = env.codePepperPrevious;
  return id === pepperId(env.codePepper) || (!!previous && id === pepperId(previous));
}

// ---------- Şifre ----------

/** OWASP asgarisinin üstünde; 2 çekirdekli sunucuda girişi tıkamaz. */
const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 32_768, timeCost: 3, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

let dummyHash: Promise<string> | undefined;

/**
 * Kişi yoksa da aynı süre harcanır: yanıt süresi kimliğin varlığını ele vermesin.
 * `hash` null ise sabit özete karşı doğrular ve false döner.
 */
export async function verifyPassword(hash: string | null | undefined, password: string): Promise<boolean> {
  try {
    if (!hash) {
      dummyHash ??= hashPassword(randomToken(16));
      await argon2.verify(await dummyHash, password);
      return false;
    }
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function passwordNeedsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

export { PASSWORD_MIN_LENGTH } from '@sellerondata/contracts';
/** Üst sınır argon2'ye dev girdi verilmesin diye. */
export const PASSWORD_MAX_LENGTH = 256;
