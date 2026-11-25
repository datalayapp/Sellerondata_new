import pg from "pg";
import { dataPaths } from "../config.ts";
import { SqliteTenantDb, type TenantDbLike } from "../org/tenant-db.ts";
import type { Tenancy } from "../org/tenancy.ts";
import { openDatabase } from "./database.ts";
import { type BridgeOptions, SyncPgBridge } from "./pg/bridge.ts";
import { PgTenantDb } from "./pg/pg-tenant-db.ts";

/**
 * Veritabanı kurulumunun girdisi. `databaseUrl` doluysa Postgres (platform kipi: senkron köprü + async havuz), boşsa
 * veri klasöründeki SQLite (`studio.db`, yerel kip). Karışık kip yok (plan §2.6).
 */
export interface DatabaseConfig {
  dataDir: string;
  /** Postgres adresi (`DATABASE_URL`, uygulama rolü `sod_tagpress`). */
  databaseUrl?: string | null;
}

export interface DatabaseOptions {
  tenancy: Tenancy;
  /** Postgres köprüsünün ince ayarı (testler; varsayılanlar plan §2.2). */
  bridge?: Omit<BridgeOptions, "connectionString">;
  /** Async havuzun en çok bağlantısı. Varsayılan 5. */
  poolMax?: number;
}

export interface Database {
  /** Servislerin tek yolu (S5). */
  tdb: TenantDbLike;
  /**
   * Async yol (yalnız Postgres; SQLite'ta null): product-kit kimlik izdüşümü, olaylar, kalıcı silme, Merkez uçları.
   * İşlemleri kısa tutulur (senkron köprü kilit beklerken `lock_timeout` ile düşer).
   */
  pool: pg.Pool | null;
  /** Önce köprü/SQLite, sonra havuz kapanır. Tekrar çağrılabilir. */
  close(): Promise<void>;
}

/** int8 ve numeric havuzda da `number` (köprüyle aynı); güvenli aralık dışı int8 metin kalır. */
const poolTypes = {
  getTypeParser(oid: number, format?: string): (v: string) => unknown {
    if (oid === 20) return (v) => (Number.isSafeInteger(Number(v)) ? Number(v) : v);
    if (oid === 1700) return (v) => Number(v);
    return pg.types.getTypeParser(oid as never, format as never) as (v: string) => unknown;
  },
};

/** S5: `createDatabase(cfg)` → `{ tdb, pool, close }`. Postgres'e bağlanamazsa (adres, parola) burada hata verir. */
export function createDatabase(cfg: DatabaseConfig, opts: DatabaseOptions): Database {
  const url = cfg.databaseUrl?.trim();
  if (!url) {
    const paths = dataPaths(cfg.dataDir);
    // Bekleyen göç varsa önce yedek (`yedek/db-<tarih>-goc-<n>-oncesi/`), sonra göç.
    const raw = openDatabase(paths.db, { backupDir: paths.backups });
    let closed = false;
    return {
      tdb: new SqliteTenantDb(raw, opts.tenancy),
      pool: null,
      close: async () => {
        if (closed) return;
        closed = true;
        raw.close();
      },
    };
  }
  const bridge = new SyncPgBridge({ connectionString: url, applicationName: "tagpress-sync", ...opts.bridge });
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.poolMax ?? 5,
    application_name: "tagpress-async",
    types: poolTypes as never,
    // Async işlemler de kilitte sonsuza dek beklemesin.
    options: `-c lock_timeout=${opts.bridge?.lockTimeoutMs ?? 5000} -c statement_timeout=${opts.bridge?.statementTimeoutMs ?? 30000}`,
  });
  // Boştaki bağlantının kopması süreci düşürmesin (havuz bağlantıyı atar, sonraki istek yenisini açar).
  pool.on("error", () => undefined);
  let closing: Promise<void> | null = null;
  return {
    tdb: new PgTenantDb(bridge, opts.tenancy),
    pool,
    close: () => {
      closing ??= (async () => {
        try {
          await bridge.close();
        } finally {
          await pool.end();
        }
      })();
      return closing;
    },
  };
}
