import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { SUPER_URL, TEST_DB_NAME, TEST_MIGRATE_URL } from './testEnv.ts';

const API_ROOT = path.resolve(import.meta.dirname, '..');
const INIT_SQL = path.resolve(API_ROOT, '../../infra/postgres/init.sql');

/** init.sql'in veritabanı başına bölümü. Test, üretimle aynı rol ve GRANT'leri kullanır: kopya tutulmaz. */
function dbSetupSection(): string {
  const text = fs.readFileSync(INIT_SQL, 'utf8');
  const start = text.indexOf('-- @db-setup-begin');
  const end = text.indexOf('-- @db-setup-end');
  if (start < 0 || end < 0) throw new Error('init.sql içinde @db-setup işaretleri yok');
  return text.slice(start, end);
}

export default async function setup() {
  const admin = new pg.Client({ connectionString: SUPER_URL });
  await admin.connect();
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [TEST_DB_NAME]);
  await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}"`);
  await admin.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
  await admin.end();

  const dbUrl = new URL(SUPER_URL);
  dbUrl.pathname = `/${TEST_DB_NAME}`;
  const db = new pg.Client({ connectionString: dbUrl.toString() });
  await db.connect();
  await db.query(dbSetupSection());
  await db.end();

  execSync('npx prisma migrate deploy', {
    cwd: API_ROOT,
    env: { ...process.env, MIGRATE_DATABASE_URL: TEST_MIGRATE_URL, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    stdio: 'pipe',
  });

  return async () => {
    const su = new pg.Client({ connectionString: SUPER_URL });
    await su.connect();
    await su.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [TEST_DB_NAME]);
    await su.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}"`);
    await su.end();
  };
}
