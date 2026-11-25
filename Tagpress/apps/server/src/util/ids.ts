import { randomBytes } from "node:crypto";

/**
 * UUIDv7 (RFC 9562): 48 bit milisaniye + 4 bit sürüm + 12 bit sayaç + 2 bit varyant + 62 bit rastgele.
 * Hesap servisindeki firma kimliğiyle aynı biçim (`Organization.id @default(uuid(7))`); bağımlılıksız.
 * Aynı süreçte üretilenler artan sıradadır: aynı milisaniyede 12 bitlik sayaç artar, taşarsa zaman bir ms ileri alınır;
 * saat geri giderse son zaman kullanılır (sıra bozulmaz).
 */
let lastMs = -1;
let counter = 0;

export function uuidv7(nowMs: number = Date.now()): string {
  let ms = Math.max(Math.floor(nowMs), lastMs);
  if (ms === lastMs) {
    counter++;
    if (counter > 0xfff) {
      ms++;
      counter = randomBytes(2).readUInt16BE(0) & 0x7ff;
    }
  } else {
    // Yeni milisaniye: sayaç rastgele başlar, üst biti boş kalır (aynı ms'de en az 2048 kimliğe yer).
    counter = randomBytes(2).readUInt16BE(0) & 0x7ff;
  }
  lastMs = ms;
  const b = randomBytes(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = 0x70 | ((counter >> 8) & 0x0f);
  b[7] = counter & 0xff;
  b[8] = 0x80 | (b[8]! & 0x3f);
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidv7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7.test(value);
}

/** UUIDv7'nin zaman damgası (ms). */
export function uuidv7Time(id: string): number {
  return Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
}

const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Herhangi sürümden UUID (büyük-küçük harf duyarsız). */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_ANY.test(value);
}

/**
 * Firma kimliğinin tek biçimi: UUID küçük harfle (Hesap servisindeki firma kimliği UUIDv7). Büyük harfli kopya aynı
 * kimliğe çevrilir (aynı dosya köküne düşen ikinci firma açılamaz); UUID olmayan kimlik hata.
 */
export function normalizeOrgId(id: string): string {
  if (!isUuid(id)) throw new Error(`Firma kimliği UUID olmalı: ${JSON.stringify(String(id)).slice(0, 80)}`);
  return id.toLowerCase();
}
