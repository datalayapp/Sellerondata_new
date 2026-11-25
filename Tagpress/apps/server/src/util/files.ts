import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const sha256 = (buf: Buffer | Uint8Array) => createHash("sha256").update(buf).digest("hex");
/** Şablon dosya özeti: SHA-1 (templates paketi ve aktarım aynı özeti kullanır). */
export const sha1 = (buf: Buffer | Uint8Array) => createHash("sha1").update(buf).digest("hex");

export async function fileHash(file: string): Promise<string | null> {
  if (!existsSync(file)) return null;
  return sha1(await readFile(file));
}

/** Önce geçici dosyaya yazar, sonra yerine taşır (yarım dosya kalmaz). */
export async function writeAtomic(file: string, data: Buffer | string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/** Dosya adı güvenli mi (klasör dışına çıkmaz, gizli değil)? */
export function safeFileName(name: string): boolean {
  // eslint-disable-next-line no-control-regex -- Windows dosya adında geçersiz denetim karakterleri (U+0000–001F) bilerek reddedilir
  return !!name && name === path.basename(name) &&!name.startsWith(".") && !/[<>:"|?*\u0000-\u001f]/.test(name);
}

/** PNG imzası. */
export function isPng(buf: Buffer): boolean {
  return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

/** PNG başlığından genişlik/yükseklik (sharp'a gerek kalmadan). */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (!isPng(buf) || buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
