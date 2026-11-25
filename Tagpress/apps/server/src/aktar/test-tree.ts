import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";

/** Klasör ağacının tam izi (yol → boy, değişme zamanı, içerik özeti): kaynağın "önce = sonra" denetimi için. */
export function treeState(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) out.set(r, "bağlantı");
      else if (st.isDirectory()) {
        out.set(`${r}/`, `klasör ${st.mtimeMs}`);
        walk(full, r);
      } else out.set(r, `${st.size} ${st.mtimeMs} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  };
  if (existsSync(root)) walk(root, "");
  return out;
}

/** Dosya ağacı (göreli yol → sha256; klasörler yok). */
export function fileHashes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of treeState(root)) if (!k.endsWith("/")) out[k] = v.split(" ").pop()!;
  return out;
}

export const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

/** Klasöre bağlantı: Windows'ta junction (yönetici hakkı istemez), Linux/macOS'ta sembolik bağ ("junction" türü orada yok sayılır). */
export function makeDirLink(target: string, link: string): void {
  symlinkSync(target, link, "junction");
}

/**
 * Bağlantıyı (yalnız onu, hedefini değil) kaldırır. `unlink` her iki platformda doğrudur: Linux'ta sembolik bağ dosya gibi
 * silinir (`rmdir` ENOTDIR verir, CI 44976845035), Windows'ta libuv junction'ı da kaldırır. Bağlantı değilse dokunmaz, hata verir.
 */
export function removeDirLink(link: string): void {
  if (!lstatSync(link).isSymbolicLink()) throw new Error(`Bağlantı değil, silinmedi: ${link}`);
  unlinkSync(link);
}
