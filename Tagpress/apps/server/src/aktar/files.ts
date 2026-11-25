import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import path from "node:path";
import { ORG_FILE_LAYOUT } from "../org/roots.ts";
import { DEFAULT_CONTENT_DIR, readFontManifest, readTemplateManifest } from "../org/seed.ts";
import { orgPurgeDir } from "../platform/identity.ts";
import { isSafeRelative, safeJoin } from "../util/safe-path.ts";

/**
 * Aktarımın dosya adımı (plan §S12). Firmanın dosyaları (kayıtlardaki göreli yollar firma köküne göredir) kaynak firma
 * kökünden hedef firma köküne (`<TAGPRESS_DATA_DIR>/firmalar/<hedef>`) aynı göreli yollarla kopyalanır.
 * - Yalnız firma klasörleri (`ORG_DIRS`) aktarılır. Kökteki geri kalan her şey (kurulum düzeyi: `studio.db*`, `yedek/` içindeki
 *   veritabanı yedekleri ve anahtar dosyaları, `ortak/` yedek fontları, ana anahtar dosyası, başka firmaların `firmalar/`
 *   klasörü) aktarılmaz ve raporda sayılır.
 * - Simgesel bağ / bağlantı noktası (junction) ve sıradan olmayan dosya aktarımı durdurur (veritabanı adımından önce).
 *   Noktayla başlayan (gizli/geçici) adlar atlanır ve raporda listelenir; uygulamanın kabul etmeyeceği başka ad durdurur.
 * - Her hedef yol `safeJoin` ile hedef kökün içinde kalmalı (yol taşması yok). Kopya önce geçici ada yazılır, özeti kaynağın
 *   özetiyle karşılaştırılır, sonra adına taşınır; var olan hedef dosyanın üzerine asla yazılmaz.
 */

/** Firma kökündeki aktarılan klasörler (`config.ts` `orgDataPaths`). `yedek/` yalnız şablon yedekleri (düzen 1'de kurulum yedekleri de oradadır). */
export const ORG_DIRS = ["aktarim", "baski", "diller", "onizleme", "referanslar", "tasarim-oturumlari", "yedek/sablonlar"] as const;

export interface FileEntry {
  /** Firma köküne göre yol (`/` ayraçlı). */
  rel: string;
  size: number;
  sha256: string;
  mtimeMs: number;
}

export interface FileManifest {
  root: string;
  files: FileEntry[];
  bytes: number;
  /** Bütün listenin özeti (yol + boy + içerik özeti). */
  digest: string;
  /** Aktarılmayan kök girdileri (dosya sayısıyla). */
  notCopied: { name: string; files: number }[];
  /** Atlanan gizli/geçici dosyalar. */
  hidden: string[];
}

export const fileSha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Kaynak firmanın dosya kökü: `OrgRoots.rootOf` ile aynı kural (düzen 1'de sahibin kökü veri klasörünün kendisi). */
export function sourceOrgRoot(dataDir: string, s: { orgId: string; layout: number; legacyOwner: string | null }): string {
  if (s.layout < ORG_FILE_LAYOUT && s.legacyOwner && s.legacyOwner.toLowerCase() === s.orgId.toLowerCase()) return path.resolve(dataDir);
  return orgFilesDir(dataDir, s.orgId);
}

/** `<veri>/firmalar/<firma>` (düzen 2; `OrgRoots` ve kalıcı silmeyle aynı ad kuralı). Kimlik klasör adı olamıyorsa hata. */
export function orgFilesDir(dataDir: string, orgId: string): string {
  const dir = orgPurgeDir(dataDir, orgId);
  if (!dir) throw new Error(`Firma kimliği klasör adı olamaz: ${JSON.stringify(orgId).slice(0, 80)}`);
  return dir;
}

function countFiles(dir: string): number {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = lstatSync(full);
    n += st.isDirectory() && !st.isSymbolicLink() ? countFiles(full) : 1;
  }
  return n;
}

const digestOf = (files: readonly FileEntry[]) => {
  const h = createHash("sha256");
  for (const f of files) h.update(`${f.rel}\0${f.size}\0${f.sha256}\n`);
  return h.digest("hex");
};

/** Firma kökünün aktarılacak dosyaları (yalnız okur). */
export function collectFiles(root: string): FileManifest {
  const files: FileEntry[] = [];
  const hidden: string[] = [];
  const notCopied: { name: string; files: number }[] = [];
  const keep = new Set<string>(ORG_DIRS);
  const prefixes = new Set<string>(ORG_DIRS.flatMap((d) => d.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));

  const walk = (dir: string, rel: string, inside: boolean) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(full);
      if (!inside && !keep.has(r) && !prefixes.has(r)) {
        notCopied.push({ name: r, files: st.isDirectory() && !st.isSymbolicLink() ? countFiles(full) : 1 });
        continue;
      }
      const into = inside || keep.has(r);
      if (st.isSymbolicLink()) throw new Error(`Kaynakta bağlantı (sembolik bağ / junction) var: ${r}. Aktarım durdu; bağlantıyı kaldırıp gerçek klasörle yeniden deneyin.`);
      if (name.startsWith(".")) {
        hidden.push(r);
        continue;
      }
      if (st.isDirectory()) {
        walk(full, r, into);
        continue;
      }
      if (!st.isFile()) throw new Error(`Kaynakta sıradan olmayan dosya var: ${r}. Aktarım durdu.`);
      if (!into) continue;
      if (!isSafeRelative(r)) throw new Error(`Kaynakta uygulamanın kabul etmediği dosya adı var: ${JSON.stringify(r)}. Aktarım durdu.`);
      files.push({ rel: r, size: st.size, sha256: fileSha256(full), mtimeMs: st.mtimeMs });
    }
  };
  if (existsSync(root)) walk(root, "", false);
  return { root, files, bytes: files.reduce((s, f) => s + f.size, 0), digest: digestOf(files), notCopied, hidden };
}

/** Hedef kökteki dosyalar (göreli yol → tam yol; klasörler sayılmaz). Bağlantı durdurur. */
export function listTargetFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new Error(`Hedef firma klasöründe bağlantı (sembolik bağ / junction) var: ${r}. Aktarım durdu.`);
      if (st.isDirectory()) walk(full, r);
      else out.push(r);
    }
  };
  if (existsSync(root)) {
    if (lstatSync(root).isSymbolicLink()) throw new Error(`Hedef firma klasörü bir bağlantı: ${root}. Aktarım durdu.`);
    walk(root, "");
  }
  return out;
}

export interface CopyPlan {
  /** Kopyalanacaklar. */
  copy: FileEntry[];
  /** Hedefte aynı içerikle zaten olanlar (yeniden deneme). */
  existing: FileEntry[];
}

const targetPath = (targetRoot: string, rel: string): string => {
  const p = safeJoin(targetRoot, rel);
  if (!p) throw new Error(`Hedef yol firma klasörünün dışına çıkıyor: ${JSON.stringify(rel)}. Aktarım durdu.`);
  return p;
};

/** Kopya planı: hedefte aynı yolda farklı içerik varsa durur (üzerine yazılmaz). */
export function planCopy(manifest: FileManifest, targetRoot: string): CopyPlan {
  const copy: FileEntry[] = [];
  const existing: FileEntry[] = [];
  const conflicts: string[] = [];
  for (const f of manifest.files) {
    const dest = targetPath(targetRoot, f.rel);
    if (!existsSync(dest)) copy.push(f);
    else if (lstatSync(dest).isFile() && fileSha256(dest) === f.sha256) existing.push(f);
    else conflicts.push(f.rel);
  }
  if (conflicts.length) {
    throw new Error(`Hedefte aynı yolda farklı dosya var (${conflicts.length}; üzerine yazılmaz): ${conflicts.slice(0, 5).join(", ")}${conflicts.length > 5 ? " …" : ""}`);
  }
  return { copy, existing };
}

/** Planı uygular: geçici ada kopya → özet denetimi → ada taşıma. */
export function executeCopy(plan: CopyPlan, sourceRoot: string, targetRoot: string, onProgress?: (done: number, total: number) => void): void {
  const tmpTag = `.aktar-${process.pid}.tmp`;
  plan.copy.forEach((f, i) => {
    const src = path.join(sourceRoot, ...f.rel.split("/"));
    const dest = targetPath(targetRoot, f.rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}${tmpTag}`;
    rmSync(tmp, { force: true });
    copyFileSync(src, tmp, constants.COPYFILE_EXCL);
    try {
      const got = fileSha256(tmp);
      if (got !== f.sha256) throw new Error(`Kopyanın özeti kaynakla aynı değil (kaynak aktarım sırasında değişti mi?): ${f.rel}`);
      if (existsSync(dest)) throw new Error(`Hedef dosya kopyalama sırasında belirdi (üzerine yazılmaz): ${f.rel}`);
      renameSync(tmp, dest);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    const at = new Date(f.mtimeMs);
    utimesSync(dest, at, at);
    if (onProgress && ((i + 1) % 100 === 0 || i + 1 === plan.copy.length)) onProgress(i + 1, plan.copy.length);
  });
}

/**
 * İlk açılışın varsayılan dil klasörüne (`diller/<dil>/`) ürünle gelen dosyalar: göreli yol → SHA-256 (`seedDefaultContent`
 * fontları ve lisanslarını `fontlar/`, şablon PNG'lerini `sablonlar/` altına aynı adla kopyalar).
 */
export function defaultLanguageFiles(contentDir = DEFAULT_CONTENT_DIR): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readFontManifest(contentDir).fontlar) {
    for (const rel of [f.file, f.licenseFile]) out.set(`fontlar/${path.basename(rel)}`, fileSha256(path.join(contentDir, "fontlar", rel)));
  }
  for (const t of readTemplateManifest(contentDir).sablonlar) out.set(`sablonlar/${t.file}`, fileSha256(path.join(contentDir, "sablonlar", t.file)));
  return out;
}

/** Varsayılan dil klasöründe ürünle gelmeyen ya da içeriği farklı dosyalar (klasör yoksa boş). Bağlantı durdurur. */
export function nonDefaultLanguageFiles(dir: string, contentDir = DEFAULT_CONTENT_DIR): string[] {
  const present = listTargetFiles(dir);
  if (!present.length) return [];
  const expected = defaultLanguageFiles(contentDir);
  return present.filter((rel) => expected.get(rel) !== fileSha256(path.join(dir, ...rel.split("/"))));
}

/** Son doğrulama: listedeki her dosya hedefte, boyu ve özeti aynı. Dönen değer doğrulanan dosya sayısı. */
export function verifyCopy(manifest: FileManifest, targetRoot: string): number {
  const bad: string[] = [];
  for (const f of manifest.files) {
    const dest = targetPath(targetRoot, f.rel);
    if (!existsSync(dest) || !statSync(dest).isFile() || statSync(dest).size !== f.size || fileSha256(dest) !== f.sha256) bad.push(f.rel);
  }
  if (bad.length) throw new Error(`Dosya doğrulaması geçmedi (${bad.length}): ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? " …" : ""}`);
  return manifest.files.length;
}
