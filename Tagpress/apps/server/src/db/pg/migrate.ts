import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Postgres göç çalıştırıcısı (platform kipi; plan §S4). SQLite göçlerinden ayrıdır: SQLite'ta `db/migrations/*.ts` (yerel kip),
 * Postgres'te bu klasördeki `NNNN-<ad>.sql` dosyaları. İkisini şema eşliği testi bağlar (`schema.pg.test.ts`).
 * - Göç rolüyle (`sod_tagpress_admin`, `MIGRATE_DATABASE_URL`) çalışır; şema ve roller kayıttan üretilen init.sql'den gelir.
 * - Geçmiş `tagpress."_tagpress_migrations"`: ad + içerik özeti (sha256, satır sonları LF'e çevrilerek) + an. Uygulama rolü
 *   (`sod_tagpress`) bu tabloyu hiç göremez (init.sql'in varsayılan hakkı her koşuda geri alınır).
 * - Her göç kendi işleminde: düşerse bütünüyle geri alınır, geçmişe yazılmaz (geri dönüş = işlem). Koşu başında işlem dışı
 *   danışma kilidi: iki göç servisi aynı anda çalışmaz.
 * - Uygulanmış göçün dosyası değiştiyse ya da silindiyse durur (uygulanmış göç asla değiştirilmez; yeni göç yeni dosya).
 * - Ad biçimi `NNNN-<küçük harf ve tire>.sql`; sıra numarası 1'den boşluksuz artar.
 */

export const PG_SCHEMA = "tagpress";
export const PG_APP_ROLE = "sod_tagpress";
export const PG_ADMIN_ROLE = "sod_tagpress_admin";
export const PG_HISTORY_TABLE = "_tagpress_migrations";
/** Varsayılan göç klasörü (kaynak ağacında bu dosyanın yanındaki `migrations/`). */
export const PG_MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

const NAME_RE = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/;
const LOCK_KEY = "tagpress:pg-migrate";

export interface PgMigration {
  name: string;
  sql: string;
  checksum: string;
}

export interface PgMigrateResult {
  applied: string[];
  skipped: string[];
}

/** İçerik özeti: satır sonu farkı (Windows'ta CRLF çıkışı) özeti değiştirmez. */
export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

/** Klasördeki göçler, sırayla. Biçimsiz ad, eksik ya da tekrarlanan numara hata. */
export function readPgMigrations(dir = PG_MIGRATIONS_DIR): PgMigration[] {
  const names = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return names.map((name, i) => {
    const m = NAME_RE.exec(name);
    if (!m) throw new Error(`Postgres göç adı geçersiz: ${name} (NNNN-ad.sql)`);
    if (Number(m[1]) !== i + 1) throw new Error(`Postgres göç sırası bozuk: ${name} (beklenen ${String(i + 1).padStart(4, "0")}-…)`);
    const sql = readFileSync(path.join(dir, name), "utf8");
    return { name, sql, checksum: migrationChecksum(sql) };
  });
}

const HISTORY = `"${PG_SCHEMA}"."${PG_HISTORY_TABLE}"`;

/**
 * Bekleyen göçleri uygular. `client` göç rolüyle bağlı olmalı (şemanın sahibi). Dönen değer uygulanan ve zaten uygulanmış
 * göçlerin adları.
 */
export async function migratePg(client: pg.ClientBase, opts: { dir?: string; log?: (msg: string) => void } = {}): Promise<PgMigrateResult> {
  const migrations = readPgMigrations(opts.dir);
  const log = opts.log ?? (() => {});
  await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [LOCK_KEY]);
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${HISTORY} ("name" text PRIMARY KEY, "checksum" text NOT NULL, "applied_at" timestamptz NOT NULL DEFAULT now())`,
    );
    // init.sql'in varsayılan hakkı (uygulama rolüne tam veri hakkı) her koşuda geri alınır: geçmiş uygulamaya kapalı.
    await client.query(`REVOKE ALL ON TABLE ${HISTORY} FROM "${PG_APP_ROLE}"`);
    await client.query(`REVOKE ALL ON TABLE ${HISTORY} FROM PUBLIC`);
    const done = new Map(
      (await client.query<{ name: string; checksum: string }>(`SELECT "name", "checksum" FROM ${HISTORY}`)).rows.map((r) => [r.name, r.checksum]),
    );
    const known = new Set(migrations.map((m) => m.name));
    const gone = [...done.keys()].filter((n) => !known.has(n));
    if (gone.length) throw new Error(`Uygulanmış Postgres göçü klasörde yok: ${gone.join(", ")}`);
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const m of migrations) {
      const prev = done.get(m.name);
      if (prev !== undefined) {
        if (prev !== m.checksum) throw new Error(`Uygulanmış Postgres göçü değişmiş: ${m.name} (uygulanmış göç değiştirilmez; yeni göç dosyası yazın)`);
        skipped.push(m.name);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query(`INSERT INTO ${HISTORY} ("name", "checksum") VALUES ($1, $2)`, [m.name, m.checksum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`Postgres göçü ${m.name} uygulanamadı, geri alındı: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      applied.push(m.name);
      log(`göç uygulandı: ${m.name}`);
    }
    return { applied, skipped };
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [LOCK_KEY]).catch(() => undefined);
  }
}

/** Bağlantı adresiyle: açar, uygular, kapatır. */
export async function migratePgUrl(url: string, opts: { dir?: string; log?: (msg: string) => void } = {}): Promise<PgMigrateResult> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await migratePg(client, opts);
  } finally {
    await client.end();
  }
}
