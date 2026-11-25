import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { uuidv7 } from "../util/ids.ts";
import { MIGRATIONS, type Migration, type MigrationEnv } from "./migrations/index.ts";

export type Db = DatabaseSync;
export type Row = Record<string, SQLInputValue>;

export interface OpenOptions {
  /** Bekleyen göçten önceki yedeğin kök klasörü (varsayılan: veritabanının yanındaki `yedek/`); null: yedek yok. */
  backupDir?: string | null;
  /** Göç ortamı (testte sabit zaman/kimlik). */
  env?: Partial<MigrationEnv>;
}

/**
 * Veritabanını açar: WAL, meşgulken bekleme, yabancı anahtarlar ve sürümlü göçler. Uygulanmış (boş olmayan)
 * veritabanında bekleyen göç varsa önce yedek alınır (`backupBeforeMigrate`). `":memory:"` testler için.
 */
export function openDatabase(file: string, opts: OpenOptions = {}): Db {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    const from = userVersion(db);
    const backupDir = opts.backupDir === undefined ? path.join(path.dirname(file), "yedek") : opts.backupDir;
    if (file !== ":memory:" && backupDir && from > 0 && from < MIGRATIONS.length) backupBeforeMigrate(db, file, backupDir, from);
    migrate(db, { env: opts.env });
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

export function userVersion(db: Db): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

const defaultEnv: MigrationEnv = { now: () => new Date().toISOString(), newId: () => uuidv7() };

/** Tek göçü uygular (işlem açmaz; çalıştırıcı açar). */
export function applyMigration(db: Db, m: Migration, env: Partial<MigrationEnv> = {}): void {
  if (typeof m === "string") db.exec(m);
  else m(db, { ...defaultEnv, ...env });
}

/**
 * Bekleyen göçleri sırayla, her birini kendi işleminde uygular (yarıda kalan göç bütünüyle geri alınır, sürüm
 * artmaz). `to`: bu sürümde durur (göç testleri). Dönen değer ulaşılan sürüm.
 */
export function migrate(db: Db, opts: { to?: number; env?: Partial<MigrationEnv> } = {}): number {
  const to = Math.min(opts.to ?? MIGRATIONS.length, MIGRATIONS.length);
  for (let v = userVersion(db); v < to; v++) {
    tx(db, () => {
      applyMigration(db, MIGRATIONS[v]!, opts.env);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return Math.max(to, userVersion(db));
}

/**
 * Göçten önce yedek: önce WAL veritabanına boşaltılır (`wal_checkpoint(TRUNCATE)`), sonra tutarlı tek dosya kopya
 * `VACUUM INTO` ile `<yedek>/db-<YYYY-MM-DD>-goc-<ilk bekleyen>-oncesi/studio.db` olarak yazılır (klasör varsa `-2`,
 * `-3` …). Kopya `verifyBackup` ile doğrulanır (bütünlük, sürüm, her tablonun satır sayısı); yedek alınamaz ya da
 * doğrulanamazsa göç başlamaz (açılış durur). Dönen değer yedek klasörü.
 */
export function backupBeforeMigrate(db: Db, file: string, backupRoot: string, from: number): string {
  const busy = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number } | undefined;
  if (busy?.busy) throw new Error("Göç öncesi yedek alınamadı: veritabanı başka bir bağlantıda açık (WAL boşaltılamadı).");
  const counts = tableCounts(db);
  // Başarısız açılış tekrarlanınca her denemede yeni tam kopya yazılmasın: aynı sürümden, aynı kaynak içerikten
  // (dosya özeti) alınmış ve hâlâ doğrulanan yedek yeniden kullanılır.
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
  const prefix = `goc-${from + 1}-oncesi`;
  if (existsSync(backupRoot)) {
    for (const name of readdirSync(backupRoot).sort().reverse()) {
      if (!name.startsWith("db-") || !name.includes(prefix)) continue;
      const dir = path.join(backupRoot, name);
      const stamp = path.join(dir, DIGEST_FILE);
      if (!existsSync(stamp) || readFileSync(stamp, "utf8").trim() !== digest) continue;
      try {
        verifyBackup(path.join(dir, path.basename(file)), from, counts);
        return dir;
      } catch {
        // Bozulmuş eski yedek: yenisi alınır.
      }
    }
  }
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const base = path.join(backupRoot, `db-${day}-${prefix}`);
  let dir = base;
  for (let i = 2; existsSync(dir); i++) dir = `${base}-${i}`;
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, path.basename(file));
  db.prepare("VACUUM INTO ?").run(target);
  verifyBackup(target, from, counts);
  writeFileSync(path.join(dir, DIGEST_FILE), `${digest}\n`);
  return dir;
}

/** Yedeğin alındığı kaynak dosyanın özeti (aynı içerikten ikinci yedek alınmaz). */
const DIGEST_FILE = "kaynak.sha256";

/** Her tablonun satır sayısı (`sqlite_` iç tabloları hariç). */
export function tableCounts(db: Db): Record<string, number> {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  return Object.fromEntries(names.map((n) => [n, Number((db.prepare(`SELECT COUNT(*) AS n FROM "${n.replaceAll('"', '""')}"`).get() as { n: number }).n)]));
}

/** Yedeği salt okunur açar: `quick_check` = ok, sürüm ve satır sayıları beklenenle aynı; değilse hata. */
export function verifyBackup(file: string, version: number, counts: Record<string, number>): void {
  const invalid = (why: string) => new Error(`Göç öncesi yedek doğrulanamadı (${why}): ${file}`);
  let check: DatabaseSync;
  try {
    check = new DatabaseSync(file, { readOnly: true });
  } catch (err) {
    throw invalid(err instanceof Error ? err.message : String(err));
  }
  try {
    let quick: string;
    try {
      quick = String(Object.values(check.prepare("PRAGMA quick_check").get() ?? {})[0]);
    } catch (err) {
      throw invalid(err instanceof Error ? err.message : String(err));
    }
    if (quick !== "ok") throw invalid(`quick_check: ${quick}`);
    const v = userVersion(check);
    if (v !== version) throw invalid(`sürüm ${v}, beklenen ${version}`);
    const got = tableCounts(check);
    for (const [t, n] of Object.entries(counts)) if (got[t] !== n) throw invalid(`${t} satır sayısı ${got[t] ?? "-"}, beklenen ${n}`);
  } finally {
    check.close();
  }
}

/**
 * İşlem (iç içe çağrılarda dıştaki işlem kullanılır). Yalnızca eşzamanlı (await'siz) işlevler. Açık işlem
 * bağlantının kendisinden okunur: ham `db`, denetimli `db` ve `TenantDb` aynı işlemi paylaşır.
 */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

/** JSON sütununu okur; bozuk/boşsa varsayılan. */
export function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** `?, ?, ?` yer tutucuları. */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}
