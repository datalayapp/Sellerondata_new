import type pg from 'pg';

/**
 * Paketin veritabanından beklediği en küçük yüzey. `pgDb(pool)` hazır bağdaştırıcıdır; Prisma kullanan araç
 * `$queryRawUnsafe` ve etkileşimli `$transaction` ile kendi bağdaştırıcısını yazar.
 * İşlem içindeki `transaction` yeni işlem açmaz, aynı işlemde çalışır (iç içe işlem yok).
 */
export type SqlDb = {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(work: (tx: SqlDb) => Promise<T>): Promise<T>;
};

function clientDb(client: pg.PoolClient): SqlDb {
  const self: SqlDb = {
    query: async <T>(sql: string, params?: unknown[]) => (await client.query(sql, params as unknown[] | undefined)).rows as T[],
    transaction: (work) => work(self),
  };
  return self;
}

/** `pg.Pool` bağdaştırıcısı. Hata olursa işlem geri alınır, bağlantı havuza döner. */
export function pgDb(pool: pg.Pool): SqlDb {
  return {
    query: async <T>(sql: string, params?: unknown[]) => (await pool.query(sql, params as unknown[] | undefined)).rows as T[],
    async transaction<T>(work: (tx: SqlDb) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(clientDb(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

/** RLS ayarı adları. `memberProjectionSql` ilkeleri bunlara bakar. */
export const ORG_SETTING = 'app.org_id';
export const SCOPE_SETTING = 'app.scope';
/** Bakım kapsamı (`app.scope = 'maintenance'`): firma bağlamı olmadan yalnız bitmemiş silme kayıtları okunur. */
export const MAINTENANCE_SCOPE = 'maintenance';

/**
 * Firma bağlamında işlem: `BEGIN; SET LOCAL app.org_id = <orgId>`. Firma tablolarının (FORCE RLS) tek okuma ve yazma yolu.
 * Bağlam işlemle biter; bağlantı havuza döndüğünde kalmaz. Bağlamsız sorgu firma satırı görmez (boş sonuç, sızıntı yok).
 */
export function withOrg<T>(db: SqlDb, orgId: string, work: (tx: SqlDb) => Promise<T>): Promise<T> {
  if (typeof orgId !== 'string' || !orgId) return Promise.reject(new Error('withOrg: orgId boş'));
  return db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('${ORG_SETTING}', $1, true)`, [orgId]);
    return work(tx);
  });
}

/**
 * Olay alıcısının kapısı: `app.scope = 'events'`. Bu kapsamda yalnız `ProcessedEvent` görünür; firma tabloları için olay
 * çözülünce `setTxOrg` gerekir.
 */
export function withEventScope<T>(db: SqlDb, work: (tx: SqlDb) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('${SCOPE_SETTING}', 'events', true)`);
    return work(tx);
  });
}

/**
 * Bakımın dar kapısı: `app.scope = 'maintenance'`. Paketin tablolarından yalnız bitmemiş `CompanyPurge` kayıtları görünür (okuma);
 * silmenin kendisi firma bağlamında (`withOrg`). Araç kendi bakım ilkelerini aynı kapsama bağlayabilir.
 */
export function withMaintenanceScope<T>(db: SqlDb, work: (tx: SqlDb) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('${SCOPE_SETTING}', '${MAINTENANCE_SCOPE}', true)`);
    return work(tx);
  });
}

/** Açık işlemin firma bağlamını işlemin sonuna kadar belirler. */
export async function setTxOrg(tx: SqlDb, orgId: string): Promise<void> {
  await tx.query(`SELECT set_config('${ORG_SETTING}', $1, true)`, [orgId]);
}

const IDENT_RE = /^[a-z][a-z0-9_]{0,62}$/;
const TABLE_RE = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;

/** SQL tanımlayıcısı (şema, rol). Metne gömüldüğü için yalnız küçük harf, rakam ve alt çizgi. */
export function sqlIdent(name: string, what: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`${what} geçersiz SQL adı: "${name}" (/^[a-z][a-z0-9_]{0,62}$/)`);
  return `"${name}"`;
}

/** Tablo ya da sütun adı (aracın tabloları, ör. `"Order"`). Metne gömüldüğü için yalnız harf, rakam ve alt çizgi; büyük harf olabilir. */
export function sqlTableIdent(name: string, what: string): string {
  if (!TABLE_RE.test(name)) throw new Error(`${what} geçersiz SQL adı: "${name}" (/^[A-Za-z][A-Za-z0-9_]{0,62}$/)`);
  return `"${name}"`;
}
