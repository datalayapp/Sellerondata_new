import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 (RFC 9562): ilk 48 bit milisaniye zaman damgası, sonra sürüm 7, değişke 10 ve rastgele bitler. Defter satırının kimliği ve
 * yanıttaki `x-sod-ai-call-id` budur; zamana göre sıralı olduğu için dizin sonuna eklenir.
 * Aynı milisaniyede üretilenler arasında sıra garanti edilmez (gerekmiyor: sıralama `startedAt` ile).
 */
export function uuidv7(now: number = Date.now()): string {
  const b = randomBytes(16);
  const ms = BigInt(Math.max(0, Math.floor(now)));
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
