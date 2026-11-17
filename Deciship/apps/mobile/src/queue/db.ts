import * as SQLite from 'expo-sqlite';
import { migrate } from './schema';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/**
 * Tek bağlantı. Açılış ya da göç hata verirse (ör. depolama dolu) söz saklanmaz: bir sonraki çağrı yeniden dener, uygulamayı
 * yeniden başlatmak gerekmez (11-B11). Göç hatasında açılan bağlantı kapatılır.
 */
export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    const attempt = (async () => {
      const db = await SQLite.openDatabaseAsync('deciship.db');
      try {
        await migrate(db);
      } catch (e) {
        await db.closeAsync?.().catch(() => undefined);
        throw e;
      }
      return db;
    })();
    dbPromise = attempt;
    attempt.catch(() => {
      if (dbPromise === attempt) dbPromise = null;
    });
  }
  return dbPromise;
}

export async function kvGet<T>(key: string): Promise<T | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', key);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await getDb();
  await db.runAsync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, JSON.stringify(value));
}

export async function kvDelete(key: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM kv WHERE key = ?', key);
}
