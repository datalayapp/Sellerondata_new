import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

/** Görsel uzantıları (bugün kayıtlarda yalnız PNG var). */
export const PNG = [".png"] as const;

/**
 * Yalnız sözdizimi denetimi (diske bakmaz): `safeJoin`'in kabul edeceği göreli yol mu? Kayıt yazılırken kullanılır.
 * Reddedilen: boş yol, mutlak yol (`/x`, `C:\x`, `C:x`, `\\sunucu`), ters eğik çizgi, NUL ve denetim karakterleri,
 * boş / `.` / `..` / noktayla başlayan (gizli, ör. `.ana-anahtar.json.tmp`) bölüm, Windows'ta geçersiz karakter,
 * izin verilmeyen uzantı. Ayraç yalnız `/`.
 */
export function isSafeRelative(rel: unknown, opts: { ext?: readonly string[] } = {}): rel is string {
  if (typeof rel !== "string" || !rel || rel.length > 1024) return false;
  // eslint-disable-next-line no-control-regex -- denetim karakterleri bilerek reddedilir
  if (/[\\\u0000-\u001f]/.test(rel) || /^[a-zA-Z]:/.test(rel) || path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) return false;
  const parts = rel.split("/");
  if (parts.some((p) => !p || p.startsWith(".") || /[<>:"|?*]/.test(p) || p !== p.trim())) return false;
  return !opts.ext || opts.ext.includes(path.extname(parts[parts.length - 1]!).toLowerCase());
}

/**
 * Bir kökün altındaki göreli yolu güvenle birleştirir; kaçış varsa null. Dosya sunan ve kayıttaki yolu diske çeviren
 * HER yer bunu kullanır (istemciden ya da kayıttan gelen yol asla doğrudan `path.join` edilmez).
 * Sözdizimi (`isSafeRelative`) ve ayrıca simgesel bağ ya da bağlantı noktasıyla kökün dışına çıkan gerçek yol
 * (var olan en yakın ata `realpath` ile) denetlenir.
 */
export function safeJoin(root: string, rel: unknown, opts: { ext?: readonly string[] } = {}): string | null {
  if (!isSafeRelative(rel, opts)) return null;
  const base = path.resolve(root);
  const file = path.resolve(base, ...rel.split("/"));
  if (!within(base, file)) return null;
  const realBase = existsSync(base) ? realpathSync.native(base) : base;
  let probe = file;
  while (!existsSync(probe) && within(base, probe)) probe = path.dirname(probe);
  if (existsSync(probe)) {
    const real = realpathSync.native(probe);
    if (real !== realBase && !within(realBase, real)) return null;
  }
  return file;
}

function within(base: string, p: string): boolean {
  const r = path.relative(base, p);
  return !!r && !r.startsWith("..") && !path.isAbsolute(r);
}
