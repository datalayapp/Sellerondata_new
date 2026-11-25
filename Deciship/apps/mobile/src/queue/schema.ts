/** Yerel veritabanı şeması ve göçü. Saf: `expo-sqlite` almaz, testte gerçek SQLite ile çalışır. */
export type SchemaDb = {
  execAsync(sql: string): Promise<unknown>;
  getFirstAsync<T>(sql: string): Promise<T | null>;
  getAllAsync<T>(sql: string): Promise<T[]>;
};

export const SCHEMA_VERSION = 1;

export async function migrate(db: SchemaDb): Promise<void> {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS queue (
      clientId TEXT PRIMARY KEY NOT NULL,
      userId TEXT NOT NULL,
      data TEXT NOT NULL,
      photos TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      nextAttemptAt INTEGER NOT NULL DEFAULT 0,
      lastError TEXT,
      serverId TEXT,
      createdAt INTEGER NOT NULL,
      sentAt INTEGER
    );
    CREATE INDEX IF NOT EXISTS queue_status ON queue(status);
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);
  const version = (await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0;
  if (version < 1) {
    // Sütun kontrolü: göç yarıda kesildiyse yeniden çalışabilsin.
    // Eski satırlarda personId/orgId NULL kalır: sahibi bilinemez, kimseye gönderilmez, silinmez.
    const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(queue)');
    const has = (name: string) => columns.some((c) => c.name === name);
    if (!has('personId')) await db.execAsync('ALTER TABLE queue ADD COLUMN personId TEXT');
    if (!has('orgId')) await db.execAsync('ALTER TABLE queue ADD COLUMN orgId TEXT');
    // Eski kapsamsız önbellek: başka firmanın ayarı veya kolisi görünmesin.
    await db.execAsync(`DELETE FROM kv WHERE key IN ('me', 'presets')`);
    await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  await db.execAsync('CREATE INDEX IF NOT EXISTS queue_scope ON queue(personId, orgId, status)');
}
