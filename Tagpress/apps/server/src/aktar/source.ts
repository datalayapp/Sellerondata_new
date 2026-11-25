import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, userVersion } from "../db/database.ts";
import { MIGRATIONS } from "../db/migrations/index.ts";
import { INSTALL_KEYS, TENANT_TABLES, type TenantTable } from "../org/tables.ts";

/**
 * Aktarımın kaynağı (plan §S12): yerel kipin veri klasöründeki SQLite veritabanı. Kaynak HİÇBİR adımda değişmez:
 * - Kaynak veritabanı SQLite ile hiç açılmaz (salt okunur açış bile WAL'ın `-shm` dosyasına yazar). Dosyaları (`studio.db`,
 *   varsa `-wal` ve `-journal`) yalnız okunarak geçici çalışma klasörüne kopyalanır; kopyalama sırasında kaynak değiştiyse
 *   (TagPress açık ve yazıyorsa) iş durur. Kapta kaynak klasör salt okunur bağlıdır (`/kaynak:ro`).
 * - Çalışma kopyası açılır (WAL kurtarması kopyada), bütünlük denetlenir, `VACUUM INTO` ile tek dosyalık anlık kopya alınır ve
 *   göçler (14'e kadar) YALNIZ bu anlık kopyaya uygulanır (`openDatabase`, uygulamanın kendi yolu; yedek yok).
 * - Kaynak firma: kurulumun sahibi (`install.ownerOrgId`, yoksa `install.defaultOrgId`), yoksa tek firma; `--kaynak-firma` ile
 *   açıkça seçilebilir. Göç 9'dan eski kaynakta firma kimliğini anlık kopyanın göçü üretir (her koşuda yenidir; hedefte
 *   kullanılmaz, yalnız raporda).
 */

export const SOURCE_DB = "studio.db";
/** Veritabanıyla birlikte kopyalanan yan dosyalar (`-shm` WAL'ın bellek dizinidir, kopyada yeniden kurulur). */
const SIDE_SUFFIXES = ["-wal", "-journal"] as const;

export interface SourceOrg {
  id: string;
  name: string;
}

export interface SourceSnapshot {
  /** Kaynak veri klasörü (mutlak). */
  dir: string;
  /** Anlık kopyanın açık bağlantısı (göç 14'te). */
  db: DatabaseSync;
  /** Kaynağın göç sürümü ve anlık kopyanın ulaştığı sürüm. */
  version: { from: number; to: number };
  /** Kopyalanan ham dosyaların özeti (sha256; dosya adı + içerik). */
  rawDigest: string;
  org: SourceOrg;
  /** Kaynaktaki (silinmemiş) firma sayısı. */
  orgCount: number;
  /** Dosya düzeni (`files.layout`; yoksa 1) ve eski kökün sahibi (düzen 1'de sahibin dosyaları veri klasörünün kökünde). */
  layout: number;
  legacyOwner: string | null;
  /** Kurulum ayarlarının anahtarları (`settings`; aktarılmaz, raporda). */
  installKeys: string[];
  /** Bağlantıyı kapatır, çalışma klasörünü siler. */
  close(): void;
}

export interface SnapshotOptions {
  /** Kaynak firma (verilmezse sahip ya da tek firma). */
  orgId?: string | null;
  /** Çalışma klasörünün üst klasörü (varsayılan işletim sisteminin geçici klasörü). */
  tmpRoot?: string;
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** Kaynak dosyalarının içeriği (yalnız okuma). */
function readSourceFiles(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const name of [SOURCE_DB, ...SIDE_SUFFIXES.map((s) => SOURCE_DB + s)]) {
    const file = path.join(dir, name);
    if (existsSync(file) && statSync(file).isFile()) out.set(name, readFileSync(file));
  }
  return out;
}

const digestOf = (files: Map<string, Buffer>) => {
  const h = createHash("sha256");
  for (const [name, buf] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) h.update(`${name}\0${sha256(buf)}\n`);
  return h.digest("hex");
};

/** Kaynak veritabanının anlık kopyası (göç 14'e getirilmiş). Hata durumunda çalışma klasörü silinir. */
export function openSourceSnapshot(sourceDir: string, opts: SnapshotOptions = {}): SourceSnapshot {
  const dir = path.resolve(sourceDir);
  if (!existsSync(path.join(dir, SOURCE_DB))) throw new Error(`Kaynakta ${SOURCE_DB} yok: ${dir}`);
  const work = mkdtempSync(path.join(opts.tmpRoot ?? os.tmpdir(), "tagpress-aktar-"));
  let db: DatabaseSync | null = null;
  try {
    // 1) Ham kopya: önce oku, kopyala, sonra yeniden oku; arada değiştiyse dur (tutarsız kopya alınmaz).
    const before = readSourceFiles(dir);
    const rawDir = path.join(work, "ham");
    mkdirSync(rawDir);
    for (const [name, buf] of before) writeFileSync(path.join(rawDir, name), buf);
    const after = readSourceFiles(dir);
    const rawDigest = digestOf(before);
    if (digestOf(after) !== rawDigest) throw new Error("Kaynak veritabanı kopyalanırken değişti (yerel TagPress açık mı?). Yerel TagPress'i kapatıp yeniden deneyin.");

    // 2) Çalışma kopyası: bütünlük + tek dosyalık anlık kopya.
    const snapshotFile = path.join(work, SOURCE_DB);
    const raw = new DatabaseSync(path.join(rawDir, SOURCE_DB));
    try {
      const quick = String(Object.values(raw.prepare("PRAGMA quick_check").get() ?? {})[0]);
      if (quick !== "ok") throw new Error(`Kaynak veritabanı bütünlük denetiminden geçmedi (quick_check: ${quick.slice(0, 200)})`);
      raw.prepare("VACUUM INTO ?").run(snapshotFile);
    } finally {
      raw.close();
    }
    rmSync(rawDir, { recursive: true, force: true });

    // 3) Göçler yalnız anlık kopyada.
    const probe = new DatabaseSync(snapshotFile, { readOnly: true });
    const from = userVersion(probe);
    probe.close();
    if (from > MIGRATIONS.length) throw new Error(`Kaynak veritabanı bu aracın bildiğinden yeni (sürüm ${from}, bilinen ${MIGRATIONS.length}); aracı güncelleyin.`);
    db = openDatabase(snapshotFile, { backupDir: null });
    const to = userVersion(db);

    const install = (key: string): string | null => {
      const row = db!.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
      if (!row) return null;
      try {
        const v = JSON.parse(row.value) as unknown;
        return v === null || v === undefined ? null : String(v);
      } catch {
        return null;
      }
    };
    const orgs = db.prepare("SELECT id, name FROM orgs WHERE purged_at IS NULL ORDER BY created_at, id").all() as unknown as SourceOrg[];
    const owner = install(INSTALL_KEYS.ownerOrgId) ?? install(INSTALL_KEYS.defaultOrgId);
    const wanted = opts.orgId?.trim() || owner || (orgs.length === 1 ? orgs[0]!.id : null);
    if (!wanted) throw new Error(`Kaynakta ${orgs.length} firma var ve sahip belli değil; --kaynak-firma ile seçin (${orgs.map((o) => o.id).join(", ")}).`);
    const org = orgs.find((o) => o.id === wanted);
    if (!org) throw new Error(`Kaynak firma bulunamadı: ${wanted}${orgs.length ? ` (kaynaktakiler: ${orgs.map((o) => o.id).join(", ")})` : " (kaynakta firma yok: veri boş mu?)"}`);

    // Firmasız ya da bilinmeyen firmalı satır kalmamalı (göç 10'dan sonra olmaz; olursa sessizce düşmesin).
    const known = new Set(orgs.map((o) => o.id));
    for (const table of TENANT_TABLES) {
      const stray = db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE org_id IS NULL OR org_id NOT IN (SELECT id FROM orgs WHERE purged_at IS NULL)`).get() as { n: number };
      if (Number(stray.n) > 0) throw new Error(`Kaynakta firmasız ya da silinmiş firmaya ait satır var: ${table} (${stray.n}). Aktarım durdu.`);
    }
    const layoutRaw = install(INSTALL_KEYS.fileLayout);
    const layout = layoutRaw === null ? 1 : Number(layoutRaw);
    const installKeys = (db.prepare("SELECT key FROM settings ORDER BY key").all() as { key: string }[]).map((r) => r.key);
    const opened = db;
    return {
      dir,
      db: opened,
      version: { from, to },
      rawDigest,
      org,
      orgCount: known.size,
      layout: Number.isFinite(layout) ? layout : 1,
      legacyOwner: owner,
      installKeys,
      close: () => {
        try {
          opened.close();
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      },
    };
  } catch (err) {
    try {
      db?.close();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    throw err;
  }
}

export interface SourceTable {
  table: TenantTable;
  columns: string[];
  /** Satırlar ekleme sırasıyla (`rowid`); tamsayılar `bigint` (hassasiyet kaybı yok). */
  rows: unknown[][];
}

/** Kaynak firmanın bir tablodaki satırları. */
export function readSourceTable(snap: SourceSnapshot, table: TenantTable): SourceTable {
  const columns = (snap.db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
  if (!columns.length) throw new Error(`Kaynakta tablo yok: ${table}`);
  const list = columns.map((c) => `"${c}"`).join(", ");
  const stmt = snap.db.prepare(`SELECT ${list} FROM "${table}" WHERE org_id = ? ORDER BY rowid`);
  stmt.setReadBigInts(true);
  const rows = (stmt.all(snap.org.id) as Record<string, unknown>[]).map((r) => columns.map((c) => r[c]));
  return { table, columns, rows };
}
