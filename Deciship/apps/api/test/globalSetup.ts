import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { SUPER_URL, TEST_DB_AUTO, TEST_DB_NAME, TEST_MIGRATE_URL, testStorageDir, testSuperDbUrl } from './testEnv.ts';

const API_ROOT = path.resolve(import.meta.dirname, '..');
const INIT_SQL = path.resolve(API_ROOT, '../../../Platform/infra/postgres/init.sql');

/** init.sql'in veritabanı başına bölümü. Test, üretimle aynı rol ve GRANT'leri kullanır: kopya tutulmaz. */
export function dbSetupSection(): string {
  const text = fs.readFileSync(INIT_SQL, 'utf8');
  const start = text.indexOf('-- @db-setup-begin');
  const end = text.indexOf('-- @db-setup-end');
  if (start < 0 || end < 0) throw new Error('init.sql içinde @db-setup işaretleri yok');
  return text.slice(start, end);
}

/** Bu koşunun veritabanını (bağlantılarını keserek) siler. */
async function dropTestDb() {
  const su = new pg.Client({ connectionString: SUPER_URL });
  await su.connect();
  try {
    await su.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [TEST_DB_NAME]);
    await su.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}"`);
  } finally {
    await su.end();
  }
}

/** 15-B10: koşunun kendi ürettiği ad (testEnv.ts) bitişte veritabanı ve dosya klasörüyle silinir. */
async function cleanupAuto() {
  await dropTestDb();
  fs.rmSync(testStorageDir(), { recursive: true, force: true });
}

async function createTestDb() {
  // önceki koşudan kalan dosyalar (yalnız bu test DB'sinin klasörü)
  fs.rmSync(testStorageDir(), { recursive: true, force: true });

  await dropTestDb();
  const admin = new pg.Client({ connectionString: SUPER_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
  await admin.end();

  const db = new pg.Client({ connectionString: testSuperDbUrl() });
  await db.connect();
  await db.query(dbSetupSection());
  await db.end();

  execSync('npx prisma migrate deploy', {
    cwd: API_ROOT,
    env: { ...process.env, MIGRATE_DATABASE_URL: TEST_MIGRATE_URL, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    stdio: 'pipe',
  });
}

export default async function setup() {
  // Dışarıdan verilen ad (TEST_DB_NAME) koşudan sonra incelemek için kalır; sonraki koşu zaten baştan kurar.
  if (!TEST_DB_AUTO) return createTestDb();
  try {
    await createTestDb();
  } catch (e) {
    // kurulum yarıda kaldıysa rastgele adlı veritabanı geride kalmasın
    await cleanupAuto().catch(() => {});
    throw e;
  }
  return cleanupAuto;
}
